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
  const weights = candidates.map((candidate, s) => Float32Array.from({ length: vertexCount }, (_, id) => {
    const n = normals.subarray(id * 3, id * 3 + 3), length = Math.hypot(n[0], n[1], n[2]);
    const [u, v] = [candidate.uvs[id * 2], candidate.uvs[id * 2 + 1]];
    if (length < 1e-12 || !(u >= 0 && v >= 0 && u < 1 && v < 1)) return 0;
    if (candidate.source.mask[Math.floor(v * candidate.source.height) * candidate.source.width + Math.floor(u * candidate.source.width)] <= 0.6) return 0;
    const facing = (n[0] * candidate.source.projection.towardCamera[0] + n[1] * candidate.source.projection.towardCamera[1]
      + n[2] * candidate.source.projection.towardCamera[2]) / length;
    return facing > 0.15 ? (facing - 0.15) ** 2 * (s === 0 ? 2.5 : 1) : 0;
  }));
  for (let id = 0; id < vertexCount; id++) {
    let total = 0;
    candidates.forEach((candidate, s) => {
      total += weights[s][id];
      candidate.alpha[id] = total > 0 ? weights[s][id] / total : 0;
    });
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
