import type { AnatomicalReference } from './anatomicalReference';
import { anatomicalZoneAt } from './anatomicalZones.ts';
import type { AnatomicalBinding, AnatomicalBindings } from './anatomicalAnnotations';
import type { FaceAddress, GenericFaceAtlas } from './faceTransfer';
import type { Vec3 } from './engine';
import { buildReferenceGeometry } from './referenceGeometry.ts';
import { fromCanonicalPosition, personalFaceFrame, toCanonicalPosition } from './simulation.ts';
import type { PersonalSurface } from './engine';
import { annotationLaterality } from './annotationSymmetry.ts';
import { fitAffineTransform, type ReferenceAnchors } from './anatomicalReference.ts';
import { addressHasPhotoCoverage } from './anatomicalAnnotations.ts';
import type { P2 } from './engine';

export interface AnnotationLayerView {
  reference: AnatomicalReference;
  positions: Float32Array;
  indices: Uint32Array;
  accepts: (address: FaceAddress) => boolean;
  point: (address: FaceAddress) => Vec3;
  zone: (address: FaceAddress) => string | null;
}

export function annotationUVs(atlas: GenericFaceAtlas): Float32Array {
  const xs = atlas.positions.filter((_, i) => i % 3 === 0), ys = atlas.positions.filter((_, i) => i % 3 === 1);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.max(...ys), bottom = Math.min(...ys);
  return Float32Array.from(xs.flatMap((x, i) => [(x - left) / (right - left), (top - ys[i]) / (top - bottom)]));
}

/** Los canvas de capa no se modifican tras cargarse: una lectura de píxeles por canvas y sesión. */
const pixelCache = new WeakMap<HTMLCanvasElement, ImageData>();
function coveragePixels(canvas: HTMLCanvasElement): ImageData {
  const cached = pixelCache.get(canvas);
  if (cached && cached.width === canvas.width && cached.height === canvas.height) return cached;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No se pudo leer la cobertura de la referencia.');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  pixelCache.set(canvas, pixels);
  return pixels;
}

/** La profundidad solo modifica buffers VISUALES; el localizador sigue en piel. */
export function buildAnnotationLayerView(
  input: AnatomicalReference, atlas: GenericFaceAtlas, surface?: PersonalSurface,
): AnnotationLayerView {
  const frame = surface ? personalFaceFrame(surface) : undefined;
  const source = surface?.positions ?? Float32Array.from(atlas.positions);
  // Fotos MediaPipe traen 478 puntos (iris); el atlas y la capa solo usan los 468 faciales.
  const reference = input.uvs.length > (source.length / 3) * 2
    ? { ...input, uvs: input.uvs.slice(0, (source.length / 3) * 2) } : input;
  const canonical = source.slice();
  if (frame) for (let i = 0; i < canonical.length; i += 3) {
    const p = toCanonicalPosition({ x: source[i], y: source[i + 1], z: source[i + 2] }, frame);
    canonical.set([p.x, p.y, p.z], i);
  }
  // Solo triángulos faciales observados: nunca el casquete, cierres u orejas.
  const geometry = buildReferenceGeometry(canonical, Uint32Array.from(atlas.triangles), reference);
  const positions = geometry.positions.slice();
  if (frame) for (let i = 0; i < positions.length; i += 3) {
    const p = fromCanonicalPosition({ x: positions[i], y: positions[i + 1], z: positions[i + 2] }, frame);
    positions.set([p.x, p.y, p.z], i);
  }
  const triangles = new Set<string>();
  const key = (ids: number[]) => ids.slice().sort((a, b) => a - b).join(':');
  for (let i = 0; i < geometry.indices.length; i += 3) triangles.add(key(Array.from(geometry.indices.slice(i, i + 3))));
  const pixels = coveragePixels(reference.canvas);
  const idsAt = (address: FaceAddress) => atlas.triangles.slice(address.triangle * 3, address.triangle * 3 + 3);
  const uvAt = (address: FaceAddress) => [0, 1].map(axis => idsAt(address)
    .reduce((sum, id, i) => sum + reference.uvs[id * 2 + axis] * address.weights[i], 0));
  const accepts = (address: FaceAddress) => {
    const ids = idsAt(address), [u, v] = uvAt(address);
    if (ids.length !== 3 || !triangles.has(key(ids)) || ![u, v].every(n => Number.isFinite(n) && n >= 0 && n < 1)) return false;
    return pixels.data[(Math.floor(v * pixels.height) * pixels.width + Math.floor(u * pixels.width)) * 4 + 3] >= 16;
  };
  return {
    reference, positions, indices: geometry.indices, accepts,
    point: address => {
      const ids = idsAt(address);
      const xyz = [0, 1, 2].map(axis => ids.reduce((sum, id, i) => sum + positions[id * 3 + axis] * address.weights[i], 0));
      return { x: xyz[0], y: xyz[1], z: xyz[2] };
    },
    zone: address => {
      if (!accepts(address)) return null;
      const [u, v] = uvAt(address);
      const label = anatomicalZoneAt(reference.zones ?? [], u, v);
      if (!label) return null;
      // La lateralidad procede del atlas del paciente, no de etiquetas de la ilustración.
      return `${label.replace(/\s*·\s*(derecho|izquierdo)\s*\(referencia\)/, '')} · ${annotationLaterality({ paths: [[address]], kind: 'point' }, atlas)}`;
    },
  };
}

export function bindingsOnLayer(bindings: AnatomicalBindings, layer?: AnnotationLayerView): AnatomicalBindings {
  if (!layer) return bindings;
  return Object.fromEntries(Object.entries(bindings).filter(([, binding]) => bindingOnLayer(binding, layer)));
}

export function bindingOnLayer(binding: AnatomicalBinding, layer: AnnotationLayerView): boolean {
  return binding.paths.flat().every(layer.accepts) && (!binding.center || layer.accepts(binding.center));
}

/** Proyección triangular sobre la foto; conserva huecos y transparencia de la ilustración. */
export function annotationPhotoLayer(layer: AnnotationLayerView, landmarks: readonly P2[], atlas: GenericFaceAtlas): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1000; canvas.height = 1000;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No se pudo preparar la capa fotográfica.');
  const reference = layer.reference;
  const triangleKeys = new Set<string>();
  const key = (ids: number[]) => ids.slice().sort((a, b) => a - b).join(':');
  for (let i = 0; i < layer.indices.length; i += 3) triangleKeys.add(key(Array.from(layer.indices.slice(i, i + 3))));
  for (let triangle = 0; triangle < atlas.triangles.length / 3; triangle++) {
    const ids = atlas.triangles.slice(triangle * 3, triangle * 3 + 3);
    if (!triangleKeys.has(key(ids)) || !addressHasPhotoCoverage({ triangle, weights: [1 / 3, 1 / 3, 1 / 3] }, landmarks, atlas)) continue;
    const source = ids.map(id => ({ x: reference.uvs[id * 2] * reference.canvas.width,
      y: reference.uvs[id * 2 + 1] * reference.canvas.height })) as unknown as ReferenceAnchors;
    const target = ids.map(id => ({ x: landmarks[id].x * canvas.width, y: landmarks[id].y * canvas.height })) as unknown as ReferenceAnchors;
    let transform: ReturnType<typeof fitAffineTransform>;
    try { transform = fitAffineTransform(source, target); } catch { continue; }
    context.save();
    context.beginPath(); context.moveTo(target[0].x, target[0].y);
    context.lineTo(target[1].x, target[1].y); context.lineTo(target[2].x, target[2].y);
    context.closePath(); context.clip();
    const [a, b, c, d, e, f] = transform;
    context.setTransform(a, d, b, e, c, f); context.drawImage(reference.canvas, 0, 0); context.restore();
  }
  return canvas.toDataURL('image/png');
}
