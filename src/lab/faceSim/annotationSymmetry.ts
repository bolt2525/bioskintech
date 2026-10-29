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
