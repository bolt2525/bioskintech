export interface EstimatedHairSettings { enabled: boolean; relief: number }
export const DEFAULT_HAIR: EstimatedHairSettings = { enabled: false, relief: 0.3 };
export interface HairPhotoProjection { u: number[]; v: number[]; towardCamera: number[] }
export interface PhotoHairSource {
  label: string;
  width: number;
  height: number;
  mask: Float32Array;
  texture: HTMLCanvasElement;
  normal: HTMLCanvasElement;
  projection: HairPhotoProjection;
}
export interface PhotoHairPatch { source: PhotoHairSource; indices: Uint32Array; uvs: Float32Array }

/** Proyecta solo cabello segmentado y visible; no mueve ni añade volumen al cráneo. */
export function buildPhotoHairPatches(positions: ArrayLike<number>, indices: ArrayLike<number>, sources: readonly PhotoHairSource[]): PhotoHairPatch[] {
  const project = (id: number, row: number[]) => row[0] * positions[id * 3] + row[1] * positions[id * 3 + 1] + row[2] * positions[id * 3 + 2] + row[3];
  const candidates = sources.map(source => {
    if (source.mask.length !== source.width * source.height || !source.mask.every(Number.isFinite)) throw new Error('Máscara capilar inválida.');
    const uvs = Float32Array.from({ length: positions.length / 3 * 2 }, (_, i) =>
      project(Math.floor(i / 2), i % 2 ? source.projection.v : source.projection.u));
    return { source, uvs, indices: [] as number[] };
  });
  const sample = (source: PhotoHairSource, u: number, v: number) => u >= 0 && u <= 1 && v >= 0 && v <= 1
    ? source.mask[Math.min(source.height - 1, Math.floor(v * source.height)) * source.width + Math.min(source.width - 1, Math.floor(u * source.width))] : 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const [a, b, c] = ids.map(id => [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]]);
    const u = b.map((v, axis) => v - a[axis]), v = c.map((value, axis) => value - a[axis]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    if (length < 1e-12) continue;
    let best: typeof candidates[number] | undefined, score = 0;
    for (const candidate of candidates) {
      const facing = normal.reduce((sum, value, axis) => sum + value / length * candidate.source.projection.towardCamera[axis], 0);
      if (facing < 0.15) continue;
      const uv = ids.map(id => [candidate.uvs[id * 2], candidate.uvs[id * 2 + 1]]);
      const probes = [...uv, ...uv.map((p, j) => p.map((value, axis) => (value + uv[(j + 1) % 3][axis]) / 2)),
        [0, 1].map(axis => uv.reduce((sum, p) => sum + p[axis] / 3, 0))];
      const coverage = probes.reduce((sum, p) => sum + sample(candidate.source, p[0], p[1]), 0) / probes.length;
      const value = facing * coverage;
      if (coverage > 0.05 && value > score) { best = candidate; score = value; }
    }
    best?.indices.push(...ids);
  }
  return candidates.filter(candidate => candidate.indices.length).map(candidate => ({
    source: candidate.source, uvs: candidate.uvs, indices: Uint32Array.from(candidate.indices),
  }));
}
