import type { PersonalSurface } from './engine';
import type { EstimatedHeadSurface } from './estimatedHead';
import type { HairPhotoProjection } from './estimatedHair';

export interface HeadPhotoSource {
  label: string;
  width: number;
  height: number;
  mask: Float32Array;
  texture: HTMLCanvasElement;
  projection: HairPhotoProjection;
}
export interface PhotoSurfacePatch { source: HeadPhotoSource; indices: Uint32Array; uvs: Float32Array }

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

/**
 * Intersección de siluetas (visual hull), NO profundidad obtenida de sombras.
 * Conserva la máscara facial y su chart; solo ajusta el cierre no observado.
 * El contorno por filas no reconstruye concavidades de orejas ni hebras.
 */
export function constrainHeadToPhotos(head: EstimatedHeadSurface, sources: readonly HeadPhotoSource[]): EstimatedHeadSurface {
  if (sources.length < 3) throw new Error('El ajuste de siluetas requiere frontal y dos laterales.');
  const bounds = sources.map(source => ({ source, rows: rowBounds(source) }));
  const inside = (p: number[]) => bounds.every(({ source, rows }) => {
    const u = project(p, source.projection.u), v = project(p, source.projection.v);
    if (v < 0 || v >= 1) return false;
    const row = Math.floor(v * source.height) * 2;
    return rows[row] >= 0 && u >= rows[row] && u <= rows[row + 1];
  });
  const positions = head.positions.slice(), count = head.observedVertexCount ?? 468;
  if (!Number.isInteger(count) || count < 468 || positions.length % 3 || count > positions.length / 3
    || !positions.every(Number.isFinite)) throw new Error('Superficie observada inválida.');
  let minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 468; i++) {
    minZ = Math.min(minZ, positions[i * 3 + 2]);
    maxZ = Math.max(maxZ, positions[i * 3 + 2]);
    minY = Math.min(minY, positions[i * 3 + 1]); maxY = Math.max(maxY, positions[i * 3 + 1]);
    minX = Math.min(minX, positions[i * 3]); maxX = Math.max(maxX, positions[i * 3]);
  }
  const height = maxY - minY, cx = (minX + maxX) / 2, cy = minY + height * 0.62;
  // Tres vistas oblicuas dejan una cuña posterior indeterminada. No añadir
  // otra profundidad craneal completa a la profundidad facial ya existente.
  const posteriorLimit = Math.min(minZ - height * 0.04, maxZ - Math.max((maxX - minX) * 1.35, height * 1.15));
  const inEnvelope = (p: number[]) => p[1] >= minY - height * 0.035 && p[1] <= maxY + height * 0.45
    && p[2] >= posteriorLimit && p[2] <= minZ - height * 0.015 && inside(p);
  // Buscar un punto interior compartido: evita proyectar desde la cara anterior
  // o aceptar una silueta que no concuerda con las cámaras faciales.
  const interior: number[][] = [];
  for (let step = 1; step <= 40; step++) {
    const p = [cx, cy, minZ + (posteriorLimit - minZ) * step / 41];
    if (inEnvelope(p)) interior.push(p);
  }
  if (interior.length < 3) throw new Error('Las siluetas no concuerdan con la alineación facial. Revisa encuadre y laterales.');
  const origin = interior[Math.floor(interior.length / 2)];
  for (let id = count; id < positions.length / 3; id++) {
    const direction = [0, 1, 2].map(axis => positions[id * 3 + axis] - origin[axis]);
    const point = (t: number) => origin.map((value, axis) => value + direction[axis] * t);
    const valid = (t: number) => {
      const p = point(t);
      return inEnvelope(p);
    };
    // Primer cruce continuo desde el interior: no saltar huecos de segmentación.
    let lo = 0, hi = 1.8;
    for (let step = 1; step <= 72; step++) {
      const t = step * 1.8 / 72;
      if (!valid(t)) { hi = t; break; }
      lo = t;
    }
    for (let iteration = 0; iteration < 16; iteration++) {
      const mid = (lo + hi) / 2;
      if (valid(mid)) lo = mid; else hi = mid;
    }
    // Acotar el rayo, no desplazar Z después: así el vértice sigue dentro
    // de todas las siluetas y detrás de la superficie fotografiada.
    const p = point(lo);
    if (!inside(p)) throw new Error('El contorno de cabeza no permite un cierre coherente con las tres vistas.');
    positions.set(p, id * 3);
  }
  if (!positions.every(Number.isFinite)) throw new Error('El ajuste multivista produjo coordenadas inválidas.');
  for (let offset = head.observedIndexCount; offset < head.indices.length; offset += 3) {
    const [a, b, c] = Array.from(head.indices.subarray(offset, offset + 3)).map(id => positions.subarray(id * 3, id * 3 + 3));
    const ab = Array.from(b, (v, i) => v - a[i]), ac = Array.from(c, (v, i) => v - a[i]);
    if (Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) < height * height * 1e-10) {
      throw new Error('La silueta produce triángulos colapsados. Usa laterales con el contorno completo.');
    }
  }
  return { ...head, positions };
}

/** Un triángulo, una vista: sin mezclar el ojo opuesto ni estirar la frontal al perfil. */
export function buildPhotoSurfacePatches(surface: PersonalSurface, sources: readonly HeadPhotoSource[]): PhotoSurfacePatch[] {
  const candidates = sources.map(source => {
    rowBounds(source);
    const uvs = new Float32Array(surface.positions.length / 3 * 2);
    for (let id = 0; id < surface.positions.length / 3; id++) {
      const p = surface.positions.subarray(id * 3, id * 3 + 3);
      uvs[id * 2] = project(p, source.projection.u); uvs[id * 2 + 1] = project(p, source.projection.v);
    }
    return { source, uvs, indices: [] as number[] };
  });
  for (let i = 0; i < surface.indices.length; i += 3) {
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
  return candidates.filter(candidate => candidate.indices.length).map(candidate => ({
    source: candidate.source, uvs: candidate.uvs, indices: Uint32Array.from(candidate.indices),
  }));
}
