import type { PersonalSurface } from './engine';
import type { HairPhotoProjection } from './estimatedHair';

export interface HeadPhotoSource {
  label: string;
  width: number;
  height: number;
  mask: Float32Array;
  /** Confianza de cabello (subconjunto de mask), si el segmentador la ofrece. */
  hair?: Float32Array;
  texture: HTMLCanvasElement;
  projection: HairPhotoProjection;
}
export interface PhotoSurfacePatch {
  source: HeadPhotoSource; indices: Uint32Array; uvs: Float32Array;
  /** Triángulos con aporte de esta vista y alfa por vértice para la mezcla ordenada. */
  blendIndices?: Uint32Array; alpha?: Float32Array;
}

const project = (p: ArrayLike<number>, row: number[]) => p[0] * row[0] + p[1] * row[1] + p[2] * row[2] + row[3];
function rowBounds(source: HeadPhotoSource): Float32Array {
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 2 || source.height < 2
    || source.mask.length !== source.width * source.height
    || !source.mask.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    || source.projection.u.length !== 4 || source.projection.v.length !== 4 || source.projection.towardCamera.length !== 3
    || ![...source.projection.u, ...source.projection.v, ...source.projection.towardCamera].every(Number.isFinite)) {
    throw new Error('Silueta o cámara multivista inválida.');
  }
  const rows = new Float32Array(source.height * 2).fill(-1);
  for (let y = 0; y < source.height; y++) {
    let left = source.width, right = -1;
    for (let x = 0; x < source.width; x++) if (source.mask[y * source.width + x] > 0.6) {
      left = Math.min(left, x); right = x;
    }
    if (right - left > 2) { rows[y * 2] = left / source.width; rows[y * 2 + 1] = (right + 1) / source.width; }
  }
  return rows;
}

/** Mediana del color de cabello visible en todas las vistas (o, sin canal de cabello, la cabeza sobre la frente). */
export function sampleScalpColor(sources: readonly HeadPhotoSource[], forehead: ArrayLike<number>): string | undefined {
  const channels: number[][] = [[], [], []];
  for (const source of sources) {
    const browV = project(forehead, source.projection.v);
    const ctx = source.texture.getContext?.('2d', { willReadFrequently: true });
    if (!ctx || !Number.isFinite(browV)) continue;
    const { width: tw, height: th } = source.texture, pixels = ctx.getImageData(0, 0, tw, th).data;
    const rows = source.hair ? source.height : Math.min(source.height, Math.floor((browV - 0.03) * source.height));
    for (let y = 0; y < rows; y += 2) {
      for (let x = 0; x < source.width; x += 2) {
        if ((source.hair ?? source.mask)[y * source.width + x] < 0.7) continue;
        const o = (Math.floor(y / source.height * th) * tw + Math.floor(x / source.width * tw)) * 4;
        for (let c = 0; c < 3; c++) channels[c].push(pixels[o + c]);
      }
    }
  }
  if (channels[0].length < 50) return undefined;
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
  return `#${channels.map(values => median(values).toString(16).padStart(2, '0')).join('')}`;
}

/** Mediana RGB en ventanas 9×9 alrededor de puntos 3D proyectados en una vista (p. ej. piel de frente y pómulos). */
export function sampleColorAt(source: HeadPhotoSource | undefined, points: readonly ArrayLike<number>[]): string | undefined {
  const ctx = source?.texture.getContext?.('2d', { willReadFrequently: true });
  if (!source || !ctx) return undefined;
  const { width: tw, height: th } = source.texture, channels: number[][] = [[], [], []];
  for (const p of points) {
    const cx = Math.round(project(p, source.projection.u) * tw), cy = Math.round(project(p, source.projection.v) * th);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 4 || cy < 4 || cx > tw - 5 || cy > th - 5) continue;
    const pixels = ctx.getImageData(cx - 4, cy - 4, 9, 9).data;
    for (let o = 0; o < pixels.length; o += 4) for (let c = 0; c < 3; c++) channels[c].push(pixels[o + c]);
  }
  if (!channels[0].length) return undefined;
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
  return `#${channels.map(values => median(values).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `indices`: un triángulo, una vista (exportación GLB). `blendIndices` + `alpha`: mezcla suave por vértice
 * para el visor; dibujar los parches en orden con alfa «over» da la media ponderada Σwᵢcᵢ/Σwᵢ.
 * Los triángulos anteriores a `firstIndex` (cara observada) conservan la textura frontal propia.
 */
export function buildPhotoSurfacePatches(surface: PersonalSurface, sources: readonly HeadPhotoSource[], firstIndex = 0): PhotoSurfacePatch[] {
  const vertexCount = surface.positions.length / 3;
  const candidates = sources.map(source => {
    rowBounds(source);
    const uvs = new Float32Array(vertexCount * 2);
    for (let id = 0; id < vertexCount; id++) {
      const p = surface.positions.subarray(id * 3, id * 3 + 3);
      uvs[id * 2] = project(p, source.projection.u); uvs[id * 2 + 1] = project(p, source.projection.v);
    }
    return { source, uvs, indices: [] as number[], blend: [] as number[], alpha: new Float32Array(vertexCount) };
  });
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < surface.indices.length; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    const [a, b, c] = ids.map(id => Array.from(surface.positions.subarray(id * 3, id * 3 + 3)));
    const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (const id of ids) for (let k = 0; k < 3; k++) normals[id * 3 + k] += n[k];
  }
  // La frontal domina donde también es útil: la cara y la frente no se fragmentan con recortes laterales.
  // Borde de máscara suave: media en una ventana (~2 % del ancho) → la vista se desvanece hacia su silueta
  // en vez de cortarse en seco por un píxel (origen de los escalones tipo «lego»).
  const softMask = (source: HeadPhotoSource, u: number, v: number) => {
    const r = Math.max(1, Math.round(source.width * 0.02)), cx = Math.floor(u * source.width), cy = Math.floor(v * source.height);
    let sum = 0, n = 0;
    for (let dy = -r; dy <= r; dy += r) for (let dx = -r; dx <= r; dx += r) {
      const x = Math.min(source.width - 1, Math.max(0, cx + dx)), y = Math.min(source.height - 1, Math.max(0, cy + dy));
      sum += source.mask[y * source.width + x]; n++;
    }
    const t = Math.min(1, Math.max(0, (sum / n - 0.45) / 0.5));
    return t * t * (3 - 2 * t);
  };
  const weights = candidates.map((candidate, s) => Float32Array.from({ length: vertexCount }, (_, id) => {
    const n = normals.subarray(id * 3, id * 3 + 3), length = Math.hypot(n[0], n[1], n[2]);
    const [u, v] = [candidate.uvs[id * 2], candidate.uvs[id * 2 + 1]];
    if (length < 1e-12 || !(u >= 0 && v >= 0 && u < 1 && v < 1)) return 0;
    if (candidate.source.mask[Math.floor(v * candidate.source.height) * candidate.source.width + Math.floor(u * candidate.source.width)] <= 0.6) return 0;
    const facing = (n[0] * candidate.source.projection.towardCamera[0] + n[1] * candidate.source.projection.towardCamera[1]
      + n[2] * candidate.source.projection.towardCamera[2]) / length;
    return facing > 0.15 ? (facing - 0.15) ** 2 * (s === 0 ? 2.5 : 1) * Math.max(0.05, softMask(candidate.source, u, v)) : 0;
  }));
  for (let id = 0; id < vertexCount; id++) {
    let total = 0;
    candidates.forEach((candidate, s) => {
      total += weights[s][id];
      candidate.alpha[id] = total > 0 ? weights[s][id] / total : 0;
    });
  }
  // En la cara observada solo entran las laterales y solo donde la frontal es oblicua (mejillas, mandíbula):
  // la textura propia de la cara hace de base y se evitan estrías estiradas sin «fantasmas» en el centro.
  const faceVertices = new Set(Array.from(surface.indices.subarray(0, firstIndex)));
  for (const id of faceVertices) candidates.forEach((candidate, s) => {
    if (s > 0) candidate.alpha[id] = Math.min(1, Math.max(0, (candidate.alpha[id] - 0.2) / 0.6));
  });
  for (let i = 0; i < firstIndex; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    candidates.forEach((candidate, s) => { if (s > 0 && ids.some(id => candidate.alpha[id] > 0)) candidate.blend.push(...ids); });
  }
  for (let i = firstIndex; i < surface.indices.length; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    candidates.forEach((candidate, s) => { if (ids.some(id => weights[s][id] > 0)) candidate.blend.push(...ids); });
  }
  for (let i = firstIndex; i < surface.indices.length; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    const [a, b, c] = ids.map(id => Array.from(surface.positions.subarray(id * 3, id * 3 + 3)));
    const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...n);
    if (length < 1e-10) continue;
    let best: typeof candidates[number] | undefined, score = 0.2;
    for (const candidate of candidates) {
      const facing = n.reduce((sum, v, j) => sum + v / length * candidate.source.projection.towardCamera[j], 0);
      if (facing <= score) continue;
      const probes = ids.map(id => [candidate.uvs[id * 2], candidate.uvs[id * 2 + 1]]);
      probes.push([0, 1].map(axis => probes.slice(0, 3).reduce((sum, p) => sum + p[axis] / 3, 0)));
      const covered = probes.every(([u, v]) => u >= 0 && v >= 0 && u < 1 && v < 1
        && candidate.source.mask[Math.floor(v * candidate.source.height) * candidate.source.width + Math.floor(u * candidate.source.width)] > 0.6);
      if (covered) { best = candidate; score = facing; }
    }
    best?.indices.push(...ids);
  }
  return candidates.filter(candidate => candidate.indices.length || candidate.blend.length).map(candidate => ({
    source: candidate.source, uvs: candidate.uvs, indices: Uint32Array.from(candidate.indices),
    blendIndices: Uint32Array.from(candidate.blend), alpha: candidate.alpha,
  }));
}

/** Línea media visible en un perfil (sin labios internos ni mentón inferior, que no forman silueta). */
export const PROFILE_MIDLINE = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 164, 0, 17, 18, 200, 199, 175];

/**
 * Profundidad de la línea media desde la SILUETA de los perfiles (frente, dorso, punta nasal, labios, mentón):
 * MediaPipe infiere z con un prior estadístico; el borde de la máscara lateral sí es una medida.
 * Solo vistas casi de perfil (|U·adelante| > 0,8). La corrección se interpola por altura a lo largo de la
 * línea media y cae lateralmente; está acotada a ±8 % de la altura facial. Devuelve null si no aplica.
 */
export function refineProfileDepth(positions: Float32Array, sources: readonly HeadPhotoSource[]): { positions: Float32Array; points: number } | null {
  if (positions.length < 468 * 3) return null;
  const P = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const sub = (a: number[], b: number[]) => a.map((v, k) => v - b[k]);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a: number[]) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return a.map(v => v / n); };
  const faceH = Math.hypot(...sub(P(10), P(152)));
  if (!(faceH > 0)) return null;
  const up = unit(sub(P(10), P(152)));
  const cheeks = P(234).map((v, k) => (v + P(454)[k]) / 2);
  const rawFwd = sub(P(1), cheeks), fwd = unit(rawFwd.map((v, k) => v - up[k] * dot(rawFwd, up)));
  const right = [up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]];
  const sum = new Map<number, { s: number; w: number }>();
  for (const source of sources) {
    const U = source.projection.u.slice(0, 3), Vr = source.projection.v.slice(0, 3);
    const uf = dot(U, fwd), lateral = Math.abs(uf) / (Math.hypot(U[0], U[1], U[2]) || 1);
    if (lateral < 0.8) continue;
    const w = Math.min(1, (lateral - 0.8) / 0.15), dir = Math.sign(uf), { width: W, height: H, mask, hair } = source;
    const faceHpx = Math.abs(dot(Vr, sub(P(10), P(152)))) * H, limit = Math.max(2, Math.round(faceHpx * 0.12));
    const inside = (x: number, y: number) => x >= 0 && x < W && mask[y * W + x] > 0.5;
    for (const id of PROFILE_MIDLINE) {
      const p = P(id), u = project(p, source.projection.u), v = project(p, source.projection.v);
      const y0 = Math.floor(v * H), x0 = Math.round(u * W);
      if (!(y0 >= 1 && y0 < H - 1 && x0 >= 0 && x0 < W)) continue;
      const edges: number[] = [];
      for (const y of [y0 - 1, y0, y0 + 1]) {
        let x = x0, steps = 0;
        if (inside(x, y)) { while (steps < limit && inside(x + dir, y)) { x += dir; steps++; } }
        else { while (steps < limit && !inside(x, y)) { x -= dir; steps++; } }
        if (steps < limit && !(hair && hair[y * W + Math.max(0, Math.min(W - 1, x))] > 0.5)) edges.push(x + (dir > 0 ? 1 : 0));
      }
      if (edges.length < 2) continue;
      const edge = edges.sort((a, b) => a - b)[edges.length >> 1];
      const s = Math.max(-0.08 * faceH, Math.min(0.08 * faceH, (edge / W - u) / uf));
      const acc = sum.get(id) ?? { s: 0, w: 0 };
      acc.s += s * w; acc.w += w; sum.set(id, acc);
    }
  }
  const origin = P(168);
  const samples = [...sum].filter(([, a]) => a.w > 0).map(([id, a]) => ({ y: dot(sub(P(id), origin), up), s: a.s / a.w }))
    .sort((a, b) => a.y - b.y);
  if (samples.length < 5) return null;
  const at = (y: number) => {
    if (y < samples[0].y - faceH * 0.05 || y > samples[samples.length - 1].y + faceH * 0.05) return 0;
    const j = samples.findIndex(e => e.y >= y);
    if (j <= 0) return samples[j === 0 ? 0 : samples.length - 1].s;
    const a = samples[j - 1], b = samples[j], t = (y - a.y) / Math.max(1e-9, b.y - a.y);
    return a.s + (b.s - a.s) * t;
  };
  const out = Float32Array.from(positions);
  for (let i = 0; i < positions.length / 3; i++) {
    const d = sub(P(i), origin), x = dot(d, right) / (faceH * 0.16);
    const s = at(dot(d, up)) * Math.exp(-x * x) * 0.85;
    if (s) for (let k = 0; k < 3; k++) out[i * 3 + k] += fwd[k] * s;
  }
  return out.every(Number.isFinite) ? { positions: out, points: samples.length } : null;
}