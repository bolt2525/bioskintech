/**
 * Subdivisión interpolante de visualización. Conserva los vértices originales
 * (anclas clínicas) y redondea las aristas con tangentes compartidas, sin soldar UV.
 */
export function refineDisplaySurface(original: Float32Array, triangles: Uint32Array) {
  if (original.length % 3 || !original.length || !original.every(Number.isFinite)
    || triangles.length % 3 || !triangles.every(i => i < original.length / 3)) {
    throw new Error('Superficie inválida para refinar el mallado.');
  }
  const parents: [number, number][] = [];
  const rounds: Map<string, number>[] = [];
  const key = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  let positions = original.slice(), indices = triangles.slice();
  const split = (source: Uint32Array, edges: Map<string, number>) => {
    const out = new Uint32Array(source.length * 4);
    for (let i = 0; i < source.length; i += 3) {
      const a = source[i], b = source[i + 1], c = source[i + 2];
      const ab = edges.get(key(a, b)), bc = edges.get(key(b, c)), ca = edges.get(key(c, a));
      if (ab === undefined || bc === undefined || ca === undefined) throw new Error('Parche ajeno al mallado original.');
      out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], i * 4);
    }
    return out;
  };
  const levels = triangles.length <= 1200 * 3 ? 2 : 1;
  for (let round = 0; round < levels; round++) {
    const count = positions.length / 3, normals = new Float64Array(positions.length);
    const canonical = new Map<string, number>(), representatives: number[] = [];
    for (let i = 0; i < count; i++) {
      const k = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
      if (!canonical.has(k)) canonical.set(k, i);
      representatives[i] = canonical.get(k)!;
    }
    const topology = new Map<string, { a: number; b: number; count: number; limit: number }>();
    for (let i = 0; i < indices.length; i += 3) {
      const ids = [indices[i], indices[i + 1], indices[i + 2]];
      const [a, b, c] = ids.map(id => id * 3);
      const u = [0, 1, 2].map(k => positions[b + k] - positions[a + k]);
      const v = [0, 1, 2].map(k => positions[c + k] - positions[a + k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      ids.forEach((id, j) => {
        const a = representatives[id], b = representatives[ids[(j + 1) % 3]];
        for (let k = 0; k < 3; k++) normals[a * 3 + k] += n[k];
        const edge = topology.get(key(a, b));
        const length = Math.hypot(...[0, 1, 2].map(k => positions[a * 3 + k] - positions[b * 3 + k]));
        const limit = length ? Math.hypot(...n) / length * 0.125 : 0;
        if (edge) { edge.count++; edge.limit = Math.min(edge.limit, limit); }
        else topology.set(key(a, b), { a, b, count: 1, limit });
      });
    }
    for (const id of canonical.values()) {
      const length = Math.hypot(...normals.subarray(id * 3, id * 3 + 3));
      if (length) for (let k = 0; k < 3; k++) normals[id * 3 + k] /= length;
    }
    const boundary = new Map<number, number[]>();
    for (const { a, b, count } of topology.values()) if (count === 1) {
      boundary.set(a, [...(boundary.get(a) ?? []), b]);
      boundary.set(b, [...(boundary.get(b) ?? []), a]);
    }
    const edges = new Map<string, number>(), out = Array.from(positions);
    for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
      const a = indices[i + j], b = indices[i + (j + 1) % 3], k = key(a, b);
      if (edges.has(k)) continue;
      const ra = representatives[a], rb = representatives[b];
      const d = [0, 1, 2].map(k => positions[b * 3 + k] - positions[a * 3 + k]);
      const length = Math.hypot(...d);
      const na = normals.subarray(ra * 3, ra * 3 + 3), nb = normals.subarray(rb * 3, rb * 3 + 3);
      const da = d.reduce((s, v, k) => s + v * na[k], 0), db = d.reduce((s, v, k) => s + v * nb[k], 0);
      let offset = d.map((_, k) => (-da * na[k] + db * nb[k]) / 8);
      if (topology.get(key(ra, rb))?.count === 1 && boundary.get(ra)?.length === 2 && boundary.get(rb)?.length === 2) {
        const prev = boundary.get(ra)!.find(id => id !== rb)!;
        const next = boundary.get(rb)!.find(id => id !== ra)!;
        const ta = d.map((_, k) => positions[b * 3 + k] - positions[prev * 3 + k]);
        const tb = d.map((_, k) => positions[next * 3 + k] - positions[a * 3 + k]);
        const la = Math.hypot(...ta), lb = Math.hypot(...tb);
        if (la && lb) offset = ta.map((v, k) => length * (v / la - tb[k] / lb) / 8);
      }
      // También limita por la altura del triángulo: una arista larga puede pertenecer a una lámina muy estrecha.
      const limit = Math.min(length * 0.125, topology.get(key(ra, rb))!.limit);
      const magnitude = Math.hypot(...offset), scale = magnitude ? Math.min(1, limit / magnitude) : 1;
      edges.set(k, out.length / 3); parents.push([a, b]);
      for (let axis = 0; axis < 3; axis++) out.push((positions[a * 3 + axis] + positions[b * 3 + axis]) / 2 + offset[axis] * scale);
    }
    positions = Float32Array.from(out); indices = split(indices, edges); rounds.push(edges);
  }
  return {
    positions, indices, indexMultiplier: 4 ** levels,
    indicesFor: (subset: Uint32Array) => rounds.reduce((out, edges) => split(out, edges), subset),
    attribute(values: Float32Array, size: number) {
      if (!Number.isInteger(size) || size < 1 || values.length !== original.length / 3 * size || !values.every(Number.isFinite)) {
        throw new Error('Atributo incompatible con el mallado original.');
      }
      const out = new Float32Array(positions.length / 3 * size);
      out.set(values);
      parents.forEach(([a, b], i) => {
        for (let k = 0; k < size; k++) out[(original.length / 3 + i) * size + k] = (out[a * size + k] + out[b * size + k]) / 2;
      });
      return out;
    },
  };
}
