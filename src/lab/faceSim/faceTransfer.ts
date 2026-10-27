/**
 * Direcciones anatómicas mesh468, independientes de UI/Three/DOM.
 * La dirección (no el XYZ derivado) es la fuente de verdad. No extrapola fuera
 * de la teselación ni rellena boca, ojos, orejas o geometría inferida.
 */
import atlasData from './genericFaceAtlas.json' with { type: 'json' };
import type { P2, PersonalSurface, Vec3 } from './engine';

export type { P2, PersonalSurface, Vec3 } from './engine';

export interface FaceAddress {
  /** Ordinal del triángulo (NO offset del índice); persistir junto con modelId/versión del atlas. */
  triangle: number;
  weights: [number, number, number];
}

export interface AtlasMesh {
  positions: number[];
  triangles: number[];
}

export interface GenericFaceAtlas extends AtlasMesh {
  modelId: string;
  /** Geometría ORIGINAL normalizada, para validar/situar marcas sobre el GLB, no dentro de su cuerda. */
  surface?: AtlasMesh;
  provenance?: {
    schemaVersion: number;
    glbSha256: string;
    [key: string]: unknown;
  };
}

export const genericFaceAtlas: GenericFaceAtlas = atlasData;

export interface CoverageOptions {
  /** Evidencia del llamador: false/ausente en la máscara => no observado. Sin máscara no se certifica visibilidad. */
  visibleTriangles?: readonly boolean[];
  /** Tolerancia baricéntrica adimensional; solo redondeo, no extrapolación anatómica. Por defecto 1e-8. */
  barycentricTolerance?: number;
  /** Área doble mínima (unidades del espacio de entrada al cuadrado). */
  minTriangleArea?: number;
}

export interface PhotoLocateOptions extends CoverageOptions {
  /** Corrige la métrica de degeneración en fotos no cuadradas. Por defecto 1. */
  aspect?: number;
}

export interface ModelLocateOptions extends CoverageOptions {
  /** Distancia máxima al GLB real, en unidades normalizadas maxDim=5. Por defecto 0.025. */
  maxDistance?: number;
  /** Normal saliente capturada en el raycast del visor; solicitarla al capturar el clic. */
  normal?: Vec3;
  /** Vector del punto hacia la cámara, NO dirección del rayo. */
  viewDirection?: Vec3;
  /** Producto escalar mínimo normal·dirección (normalizados). Por defecto 0.05. */
  minFacing?: number;
}

const finite2 = (p: P2 | undefined): p is P2 => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const finite3 = (p: Vec3 | undefined): p is Vec3 => finite2(p) && Number.isFinite(p.z);
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 =>
  ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (p: Vec3) => Math.hypot(p.x, p.y, p.z);
const aligned = (a: Vec3, b: Vec3, min: number) => finite3(a) && finite3(b)
  && length(a) > 0 && length(b) > 0 && dot(a, b) / (length(a) * length(b)) >= min;

function vertex(positions: ArrayLike<number>, index: number): Vec3 {
  return { x: positions[index * 3], y: positions[index * 3 + 1], z: positions[index * 3 + 2] };
}

function ids(atlas: AtlasMesh, triangle: number): [number, number, number] | null {
  if (!Number.isInteger(triangle) || triangle < 0 || triangle * 3 + 2 >= atlas.triangles.length) return null;
  const result = atlas.triangles.slice(triangle * 3, triangle * 3 + 3);
  return result.every(i => Number.isInteger(i) && i >= 0 && i < atlas.positions.length / 3)
    && new Set(result).size === 3 ? result as [number, number, number] : null;
}

function weights(values: number[], tolerance = 1e-8): [number, number, number] | null {
  if (values.length !== 3 || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.01
    || values.some(w => !Number.isFinite(w) || w < -tolerance || w > 1 + tolerance)
    || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > Math.max(1e-8, tolerance)) return null;
  const clamped = values.map(w => Math.max(0, Math.min(1, w)));
  const sum = clamped.reduce((a, b) => a + b, 0);
  return clamped.map(w => w / sum) as [number, number, number];
}

function barycentric(p: P2, a: P2, b: P2, c: P2, options: CoverageOptions): FaceAddress['weights'] | null {
  if (![p, a, b, c].every(finite2)) return null;
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const min = options.minTriangleArea ?? 1e-12;
  if (!Number.isFinite(min) || min < 0 || Math.abs(area) <= min) return null;
  const v = ((p.x - a.x) * (c.y - a.y) - (p.y - a.y) * (c.x - a.x)) / area;
  const w = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / area;
  return weights([1 - v - w, v, w], options.barycentricTolerance);
}

function resolve(address: FaceAddress, atlas: GenericFaceAtlas) {
  const indices = ids(atlas, address.triangle), w = weights(address.weights);
  return indices && indices.every(i => i < 468) && w ? { indices, w } : null;
}

function mix(points: Vec3[], w: FaceAddress['weights']): Vec3 {
  return {
    x: points.reduce((s, p, i) => s + p.x * w[i], 0),
    y: points.reduce((s, p, i) => s + p.y * w[i], 0),
    z: points.reduce((s, p, i) => s + p.z * w[i], 0),
  };
}

/**
 * Intersección frontal exacta con las caras originales. El atlas se construye
 * con cámara ortográfica +Z: preservamos ese mismo chart XY al ir y volver.
 * No es una proyección al cráneo ni al vecino más cercano de un atlas disperso.
 */
function frontHit(p: P2, mesh: AtlasMesh): { point: Vec3; normal: Vec3 } | null {
  let best: { point: Vec3; normal: Vec3 } | null = null;
  const positions = mesh.positions;
  for (let offset = 0; offset + 2 < mesh.triangles.length; offset += 3) {
    const ia = mesh.triangles[offset], ib = mesh.triangles[offset + 1], ic = mesh.triangles[offset + 2];
    if (!Number.isInteger(ia) || !Number.isInteger(ib) || !Number.isInteger(ic)
      || ia < 0 || ib < 0 || ic < 0 || Math.max(ia, ib, ic) * 3 + 2 >= positions.length) continue;
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Igual que GLTF/FrontSide: nunca seleccionar el interior/nuca.
    if (!(area > 1e-12)) continue;
    const v = ((p.x - ax) * (cy - ay) - (p.y - ay) * (cx - ax)) / area;
    const w = ((bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax)) / area;
    if (v < -1e-8 || w < -1e-8 || v + w > 1 + 1e-8) continue;
    const blend = weights([1 - v - w, v, w]);
    if (!blend) continue;
    const points = [ia, ib, ic].map(i => vertex(positions, i));
    if (!points.every(finite3)) continue;
    const point = mix(points, blend);
    if (!best || point.z > best.point.z) {
      best = { point, normal: cross(sub(points[1], points[0]), sub(points[2], points[0])) };
    }
  }
  return best;
}

/** Posición sobre el GLB real; null si la dirección no intersecta su superficie. */
export function modelPoint(address: FaceAddress, atlas: GenericFaceAtlas = genericFaceAtlas): Vec3 | null {
  const found = resolve(address, atlas);
  if (!found) return null;
  const points = found.indices.map(i => vertex(atlas.positions, i));
  if (!points.every(finite3) || length(cross(sub(points[1], points[0]), sub(points[2], points[0]))) <= 1e-12) return null;
  const chord = mix(points, found.w);
  return atlas.surface ? frontHit(chord, atlas.surface)?.point ?? null : chord;
}

export function photoPoint(
  address: FaceAddress, landmarks: readonly P2[], atlas: GenericFaceAtlas = genericFaceAtlas,
): P2 | null {
  const found = resolve(address, atlas);
  if (!found) return null;
  const points = found.indices.map(i => landmarks[i]);
  if (!points.every(finite2)
    || !barycentric(points[0], points[0], points[1], points[2], {})) return null;
  return {
    x: points.reduce((s, p, i) => s + p.x * found.w[i], 0),
    y: points.reduce((s, p, i) => s + p.y * found.w[i], 0),
  };
}

/** Usa solo el prefijo observado mesh468, aunque surface incluya casquete/cierres inferidos. */
export function surfacePoint(
  address: FaceAddress, surface: PersonalSurface, atlas: GenericFaceAtlas = genericFaceAtlas,
): Vec3 | null {
  const found = resolve(address, atlas);
  if (!found || found.indices.some((id, i) => surface.indices[address.triangle * 3 + i] !== id)) return null;
  const points = found.indices.map(i => vertex(surface.positions, i));
  if (!points.every(finite3) || length(cross(sub(points[1], points[0]), sub(points[2], points[0]))) <= 1e-12) return null;
  return mix(points, found.w);
}

/** No elige arbitrariamente entre superficies solapadas en una foto de perfil. */
export function locatePhotoPoint(
  p: P2, landmarks: readonly P2[], atlas: GenericFaceAtlas = genericFaceAtlas, options: PhotoLocateOptions = {},
): FaceAddress | null {
  const aspect = options.aspect ?? 1;
  if (!finite2(p) || !Number.isFinite(aspect) || aspect <= 0 || landmarks.length < 468) return null;
  const metric = (q: P2): P2 => ({ x: q.x * aspect, y: q.y });
  let result: FaceAddress | null = null;
  for (let triangle = 0; triangle < atlas.triangles.length / 3; triangle++) {
    if (options.visibleTriangles && options.visibleTriangles[triangle] !== true) continue;
    const indices = ids(atlas, triangle);
    if (!indices || indices.some(i => i >= 468)) continue;
    const points = indices.map(i => landmarks[i]);
    if (!points.every(finite2)) continue;
    const w = barycentric(metric(p), metric(points[0]), metric(points[1]), metric(points[2]), options);
    if (!w) continue;
    const candidate: FaceAddress = { triangle, weights: w };
    if (result) {
      // Solo aceptamos duplicados de una misma arista/vértice topológico.
      const previous = resolve(result, atlas)!;
      const active = indices.filter((_, i) => w[i] > 1e-7);
      const priorActive = previous.indices.filter((_, i) => previous.w[i] > 1e-7);
      if (active.length !== priorActive.length || active.some(i => !priorActive.includes(i))) return null;
    } else result = candidate;
  }
  return result;
}

export function locateModelPoint(
  p: Vec3, atlas: GenericFaceAtlas = genericFaceAtlas, options: ModelLocateOptions = {},
): FaceAddress | null {
  const maxDistance = options.maxDistance ?? 0.025, minFacing = options.minFacing ?? 0.05;
  if (!finite3(p) || !Number.isFinite(maxDistance) || maxDistance < 0
    || !Number.isFinite(minFacing) || minFacing < 0 || minFacing > 1) return null;
  const landmarks = Array.from({ length: 468 }, (_, i) => vertex(atlas.positions, i));
  const address = locatePhotoPoint(p, landmarks, atlas, options);
  if (!address) return null;
  const hit = atlas.surface ? frontHit(p, atlas.surface) : null;
  const q = atlas.surface ? hit?.point : modelPoint(address, atlas);
  if (!q || length(sub(p, q)) > maxDistance) return null;
  const found = resolve(address, atlas)!;
  const [a, b, c] = found.indices.map(i => vertex(atlas.positions, i));
  const normal = atlas.surface ? hit?.normal : cross(sub(b, a), sub(c, a));
  if (!normal || (options.normal && !aligned(normal, options.normal, minFacing))
    || (options.viewDirection && !aligned(normal, options.viewDirection, minFacing))) return null;
  return address;
}

/** Inversa de surfacePoint; selecciona solo triángulos observados, nunca el casquete/cierres añadidos. */
export function locateSurfacePoint(
  p: Vec3, surface: PersonalSurface, atlas: GenericFaceAtlas = genericFaceAtlas, options: ModelLocateOptions = {},
): FaceAddress | null {
  const maxDistance = options.maxDistance ?? 0.025, minFacing = options.minFacing ?? 0.05;
  if (!finite3(p) || !Number.isFinite(maxDistance) || maxDistance < 0
    || !Number.isFinite(minFacing) || minFacing < 0 || minFacing > 1) return null;
  let best: FaceAddress | null = null, bestDistance = Infinity, ambiguous = false;
  for (let triangle = 0; triangle < atlas.triangles.length / 3; triangle++) {
    if (options.visibleTriangles && options.visibleTriangles[triangle] !== true) continue;
    const indices = ids(atlas, triangle);
    if (!indices || indices.some((id, i) => id >= 468 || surface.indices[triangle * 3 + i] !== id)) continue;
    const [a, b, c] = indices.map(i => vertex(surface.positions, i));
    if (![a, b, c].every(finite3)) continue;
    const u = sub(b, a), v = sub(c, a), n = cross(u, v), area = length(n);
    const minArea = options.minTriangleArea ?? 1e-12;
    if (!Number.isFinite(minArea) || minArea < 0 || area <= minArea
      || (options.normal && !aligned(n, options.normal, minFacing))
      || (options.viewDirection && !aligned(n, options.viewDirection, minFacing))) continue;
    const relative = sub(p, a), uu = dot(u, u), uv = dot(u, v), vv = dot(v, v);
    const denominator = uu * vv - uv * uv;
    if (!(denominator > 0)) continue;
    const w1 = (dot(relative, u) * vv - dot(relative, v) * uv) / denominator;
    const w2 = (dot(relative, v) * uu - dot(relative, u) * uv) / denominator;
    const w = weights([1 - w1 - w2, w1, w2], options.barycentricTolerance);
    if (!w) continue;
    const distance = length(sub(p, mix([a, b, c], w)));
    if (distance > maxDistance || distance > bestDistance + 1e-9) continue;
    if (best && Math.abs(distance - bestDistance) <= 1e-9) {
      const previous = resolve(best, atlas)!;
      const active = indices.filter((_, i) => w[i] > 1e-7);
      const priorActive = previous.indices.filter((_, i) => previous.w[i] > 1e-7);
      if (active.length !== priorActive.length || active.some(i => !priorActive.includes(i))) ambiguous = true;
    } else {
      best = { triangle, weights: w };
      bestDistance = distance;
      ambiguous = false;
    }
  }
  return ambiguous ? null : best;
}

/** Error geométrico medido, no garantía de exactitud anatómica/clínica. null si no hay correspondencia. */
export function roundTripDifference(from: P2 | Vec3, to: P2 | Vec3 | null): number | null {
  if (!to || !finite2(from) || !finite2(to)) return null;
  if ('z' in from || 'z' in to) return 'z' in from && 'z' in to && finite3(from) && finite3(to)
    ? length(sub(from, to)) : null;
  return Math.hypot(from.x - to.x, from.y - to.y);
}
