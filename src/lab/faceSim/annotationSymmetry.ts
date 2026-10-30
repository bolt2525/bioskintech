import type { AnatomicalBinding } from './anatomicalAnnotations';
import type { FaceAddress, GenericFaceAtlas } from './faceTransfer';
import { locatePhotoPoint } from './faceTransfer.ts';

export function canonicalAnnotationPoint(address: FaceAddress, atlas: GenericFaceAtlas): { x: number; y: number } {
  const ids = atlas.triangles.slice(address.triangle * 3, address.triangle * 3 + 3);
  return {
    x: ids.reduce((sum, id, i) => sum + atlas.positions[id * 3] * address.weights[i], 0),
    y: ids.reduce((sum, id, i) => sum + atlas.positions[id * 3 + 1] * address.weights[i], 0),
  };
}

function mapAnnotation(
  binding: AnatomicalBinding, atlas: GenericFaceAtlas, project: (point: { x: number; y: number }) => { x: number; y: number },
  accepts: (address: FaceAddress) => boolean,
): AnatomicalBinding | null {
  const landmarks = Array.from({ length: 468 }, (_, i) => ({
    x: atlas.positions[i * 3], y: atlas.positions[i * 3 + 1],
  }));
  const map = (address: FaceAddress): FaceAddress | null => {
    if (atlas.triangles.slice(address.triangle * 3, address.triangle * 3 + 3).length !== 3) return null;
    const result = locatePhotoPoint(project(canonicalAnnotationPoint(address, atlas)), landmarks, atlas);
    return result && accepts(result) ? result : null;
  };
  const paths: FaceAddress[][] = [];
  for (const path of binding.paths) {
    if (!path.length) return null;
    const mapped: FaceAddress[] = [];
    for (const address of path) {
      const result = map(address);
      if (!result) return null;
      mapped.push(result);
    }
    paths.push(mapped);
  }
  if (!paths.length) return null;
  const center = binding.center ? map(binding.center) : undefined;
  if (binding.center && !center) return null;
  return { ...binding, paths, ...(center ? { center } : {}) };
}

/**
 * Espejo en el chart CANÓNICO, nunca en los píxeles de la foto ni en el plano
 * desplazado de una referencia. Conserva todos los segmentos y el centro.
 */
export function mirrorAnnotation(
  binding: AnatomicalBinding, atlas: GenericFaceAtlas,
  accepts: (address: FaceAddress) => boolean = () => true,
): AnatomicalBinding | null {
  return mapAnnotation(binding, atlas, ({ x, y }) => ({ x: -x, y }), accepts);
}

/** Traslado de todos los segmentos/centro en el chart anatómico, no en profundidad. */
export function translateAnnotation(
  binding: AnatomicalBinding, delta: { x: number; y: number }, atlas: GenericFaceAtlas,
  accepts: (address: FaceAddress) => boolean = () => true,
): AnatomicalBinding | null {
  return mapAnnotation(binding, atlas, ({ x, y }) => ({ x: x + delta.x, y: y + delta.y }), accepts);
}

/** Mueve una punta sin separar su registro de la rama ni desplazar la entrada. */
export function moveAnnotationTip(
  binding: AnatomicalBinding, tip: number, target: FaceAddress, atlas: GenericFaceAtlas,
  accepts: (address: FaceAddress) => boolean = () => true,
): AnatomicalBinding | null {
  const indices = binding.paths.flatMap((path, i) => path.length > 1 && (binding.kind !== 'arrow' || i === 0) ? [i] : []);
  const index = indices[tip], path = binding.paths[index];
  if (!Number.isInteger(tip) || !path || !accepts(target)) return null;
  const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: atlas.positions[i * 3], y: atlas.positions[i * 3 + 1] }));
  const end = canonicalAnnotationPoint(path[path.length - 1], atlas), to = canonicalAnnotationPoint(target, atlas);
  const mapped: FaceAddress[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = canonicalAnnotationPoint(path[i], atlas), t = i / (path.length - 1);
    const address = i === 0 ? path[i] : i === path.length - 1 ? target
      : locatePhotoPoint({ x: p.x + (to.x - end.x) * t, y: p.y + (to.y - end.y) * t }, landmarks, atlas);
    if (!address || !accepts(address)) return null;
    mapped.push(address);
  }
  const paths = binding.paths.map((points, i) => i === index ? mapped : points);
  if (binding.kind === 'arrow') {
    for (let i = 1; i < paths.length; i++) {
      const head = paths[i].map(address => {
        const p = canonicalAnnotationPoint(address, atlas);
        return locatePhotoPoint({ x: p.x + to.x - end.x, y: p.y + to.y - end.y }, landmarks, atlas);
      });
      if (head.some(address => !address || !accepts(address))) return null;
      paths[i] = head.filter((address): address is FaceAddress => address !== null);
    }
  }
  return { ...binding, paths };
}

/** Longitud de superficie relativa al ancho del atlas, nunca milímetros sin calibración. */
export function annotationProportion(binding: AnatomicalBinding, atlas: GenericFaceAtlas): number {
  const path = binding.paths[0] ?? [];
  const width = Math.abs(atlas.positions[454 * 3] - atlas.positions[234 * 3]);
  if (!width || path.length < 2) return 0;
  return path.slice(1).reduce((sum, address, i) => {
    const a = canonicalAnnotationPoint(path[i], atlas), b = canonicalAnnotationPoint(address, atlas);
    return sum + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0) / width * 100;
}

/** Escala y/o rota la figura completa alrededor de su centro anatómico (o centroide). */
export function transformAnnotation(
  binding: AnatomicalBinding, { scale = 1, degrees = 0 }: { scale?: number; degrees?: number }, atlas: GenericFaceAtlas,
  accepts: (address: FaceAddress) => boolean = () => true,
): AnatomicalBinding | null {
  const points = binding.paths.flat().map(address => canonicalAnnotationPoint(address, atlas));
  if (!points.length || !Number.isFinite(scale) || scale <= 0) return null;
  const pivot = binding.center ? canonicalAnnotationPoint(binding.center, atlas)
    : { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
  const cos = Math.cos(degrees * Math.PI / 180), sin = Math.sin(degrees * Math.PI / 180);
  return mapAnnotation(binding, atlas, ({ x, y }) => {
    const dx = (x - pivot.x) * scale, dy = (y - pivot.y) * scale;
    return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
  }, accepts);
}

/** Negativo en el atlas frontal = derecha DEL PACIENTE, no del observador. */
export function annotationLaterality(binding: AnatomicalBinding, atlas: GenericFaceAtlas): string {
  const addresses = binding.center ? [binding.center] : binding.paths.flat();
  const xs = addresses.map(address => atlas.triangles.slice(address.triangle * 3, address.triangle * 3 + 3)
    .reduce((sum, id, i) => sum + atlas.positions[id * 3] * address.weights[i], 0));
  if (!xs.length) return 'Sin lateralidad';
  if (xs.some(x => x < -0.015) && xs.some(x => x > 0.015)) return 'Bilateral del paciente';
  const x = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  return Math.abs(x) <= 0.015 ? 'Línea media' : x < 0 ? 'Derecha del paciente' : 'Izquierda del paciente';
}

/** Una sola entrada de historial para cualquier transacción (incluye el par bilateral). */
export function annotationHistory<T>(history: T[], before: T): T[] {
  return [...history.slice(-30), before];
}
