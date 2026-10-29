import type { AnatomicalReference } from './anatomicalReference';
import { isBoneNasalOpening } from './anatomicalZones';
import { vertexNormals } from './simulation';

/**
 * Plano ilustrativo en el marco facial canónico (+Z anterior).
 * No compacta ni añade vértices: los UV y direcciones del atlas conservan sus índices.
 * La máscara nasal solo pertenece a la ilustración conocida, nunca a imágenes propias.
 * No lee canvas ni requiere DOM.
 */
export function buildReferenceGeometry(
  positions: Float32Array, indices: Uint32Array, reference: AnatomicalReference,
): { positions: Float32Array; indices: Uint32Array } {
  const count = positions.length / 3;
  if (!Number.isInteger(count) || count === 0 || reference.uvs.length !== count * 2
    || indices.length % 3 || !positions.every(Number.isFinite) || !reference.uvs.every(Number.isFinite)
    || indices.some(id => id >= count) || !Number.isFinite(reference.depth) || reference.depth < 0) {
    throw new Error('Geometría o UV de referencia inválidos.');
  }
  const result = positions.slice(), kept: number[] = [];
  const bone = reference.kind === 'bone' && Boolean(reference.zones);
  if (bone) {
    // Rebaja únicamente el relieve cartilaginoso copiado de la piel; respeta el puente alto.
    const rim: number[] = [];
    for (let i = 0; i < count; i++) {
      const u = reference.uvs[i * 2], v = reference.uvs[i * 2 + 1], x = Math.abs(u - 0.515);
      if (x >= 0.095 && x <= 0.19 && v >= 0.47 && v <= 0.67) rim.push(i);
    }
    for (let i = 0; i < count; i++) {
      const u = reference.uvs[i * 2], v = reference.uvs[i * 2 + 1];
      if (Math.abs(u - 0.515) >= 0.105 || v <= 0.46 || v >= 0.68 || !rim.length) continue;
      let sum = 0, weight = 0;
      for (const id of rim) {
        const w = 1 / (0.001 + (reference.uvs[id * 2] - u) ** 2 + (reference.uvs[id * 2 + 1] - v) ** 2);
        sum += positions[id * 3 + 2] * w; weight += w;
      }
      const t = Math.min(1, (v - 0.46) / 0.06, (0.68 - v) / 0.03);
      const blend = t * t * (3 - 2 * t);
      result[i * 3 + 2] -= Math.max(0, result[i * 3 + 2] - sum / weight) * blend;
    }
  }
  for (let t = 0; t < indices.length; t += 3) {
    const ids = [indices[t], indices[t + 1], indices[t + 2]];
    const uv = ids.map(id => [reference.uvs[id * 2], reference.uvs[id * 2 + 1]]);
    // Muestreo conservador: no deja triángulos con vértices interiores tapando el hueco.
    const samples = [...uv, [0, 1].map(axis => uv.reduce((sum, p) => sum + p[axis] / 3, 0)),
      ...uv.map((p, i) => p.map((v, axis) => (v + uv[(i + 1) % 3][axis]) / 2))];
    if (!bone || !samples.some(([u, v]) => isBoneNasalOpening(u, v))) kept.push(...ids);
  }
  const normals = vertexNormals(result, indices);
  let minX = Infinity, maxX = -Infinity;
  for (const id of indices) { minX = Math.min(minX, positions[id * 3]); maxX = Math.max(maxX, positions[id * 3]); }
  const width = indices.length ? maxX - minX : 0;
  for (let i = 0; i < result.length; i++) result[i] -= normals[i] * width * reference.depth;
  return { positions: result, indices: Uint32Array.from(kept) };
}
