import { fitAnatomicalUVs, fitLandmarkUVs, type AnatomicalReference, type ReferenceAnchors, type ReferencePoint } from './anatomicalReference';

export type AnatomyPlane = 'skin' | AnatomicalReference['kind'];
export const ANATOMY_PLANES: readonly { id: AnatomyPlane; label: string; hint: string }[] = [
  { id: 'skin', label: 'Piel', hint: 'Superficie del paciente' },
  { id: 'muscle', label: 'Músculo', hint: 'Plano muscular genérico acoplado al rostro' },
  { id: 'vessels', label: 'Vascular', hint: 'Arterias principales genéricas acopladas al rostro' },
  { id: 'bone', label: 'Óseo', hint: 'Plano óseo genérico acoplado al rostro' },
];

interface LayerSource { kind: AnatomicalReference['kind']; url: string; depth: number; opacity: number; anchors: ReferenceAnchors }
/** Anclajes 33/263/152 medidos sobre cada ilustración: respaldo si MediaPipe no detecta el rostro. */
export const DEFAULT_LAYER_SOURCES: readonly LayerSource[] = [
  { kind: 'muscle', url: '/face-layers/muscular.webp', depth: 0.02, opacity: 0.95, anchors: [{ x: 0.253, y: 0.528 }, { x: 0.761, y: 0.528 }, { x: 0.504, y: 0.975 }] },
  { kind: 'vessels', url: '/face-layers/vascular.webp', depth: 0.035, opacity: 0.95, anchors: [{ x: 0.217, y: 0.442 }, { x: 0.778, y: 0.442 }, { x: 0.5, y: 0.804 }] },
  { kind: 'bone', url: '/face-layers/oseo.webp', depth: 0.06, opacity: 1, anchors: [{ x: 0.205, y: 0.416 }, { x: 0.802, y: 0.416 }, { x: 0.5, y: 0.867 }] },
];

/** Fondo blanco → transparente solo si conecta con el borde (conserva dientes y escleras). */
export function keyOutBackground(data: Uint8ClampedArray, width: number, height: number, threshold = 236): void {
  const seen = new Uint8Array(width * height), stack: number[] = [];
  const light = (i: number) => Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= threshold;
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || !light(i)) continue;
    seen[i] = 1; data[i * 4 + 3] = 0;
    const x = i % width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (i >= width) stack.push(i - width);
    if (i < width * (height - 1)) stack.push(i + width);
  }
  // Borde suave: píxeles opacos vecinos del fondo toman alfa parcial según su luminosidad.
  for (let i = 0; i < width * height; i++) if (!seen[i]) {
    const x = i % width;
    if ((x > 0 && seen[i - 1]) || (x < width - 1 && seen[i + 1]) || seen[i - width] || seen[i + width]) {
      const m = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      data[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0.35, (255 - m) / 60)));
    }
  }
}

interface LoadedLayer { source: LayerSource; canvas: HTMLCanvasElement; landmarks: ReferencePoint[] | null }
let cache: Promise<LoadedLayer[]> | undefined;

async function loadLayer(source: LayerSource): Promise<LoadedLayer> {
  const image = new Image();
  image.decoding = 'async';
  image.src = source.url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No se pudo preparar la capa anatómica.');
  context.drawImage(image, 0, 0);
  // Detectar antes de recortar: MediaPipe espera la imagen completa.
  const { detectImageLandmarks } = await import('./detection');
  const landmarks = await detectImageLandmarks(canvas).catch(() => null);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  keyOutBackground(pixels.data, canvas.width, canvas.height);
  context.putImageData(pixels, 0, 0);
  return { source, canvas, landmarks: landmarks && landmarks.length >= 468 ? landmarks : null };
}

/** Carga única por sesión; las capas que fallen se omiten sin bloquear el visor. */
export function loadDefaultLayers(): Promise<LoadedLayer[]> {
  cache ??= Promise.all(DEFAULT_LAYER_SOURCES.map(source => loadLayer(source).catch(() => null)))
    .then(layers => layers.filter((layer): layer is LoadedLayer => Boolean(layer)));
  return cache;
}

/** Acopla cada ilustración a los UV del paciente: landmarks densos si hay detección, si no tres anclajes. */
export function registerLayers(layers: readonly LoadedLayer[], surfaceUVs: Float32Array): AnatomicalReference[] {
  return layers.flatMap(({ source, canvas, landmarks }) => {
    try {
      const uvs = landmarks ? fitLandmarkUVs(surfaceUVs, landmarks) : fitAnatomicalUVs(surfaceUVs, source.anchors);
      return [{ canvas, uvs, depth: source.depth, opacity: source.opacity, kind: source.kind }];
    } catch { return []; }
  });
}

/** Estado de transición entre planos: opacidad y profundidad interpoladas con easing. */
export function anatomyBlend(from: AnatomyPlane, to: AnatomyPlane, t: number, depths: Partial<Record<AnatomyPlane, number>>) {
  const e = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const skinOf = (plane: AnatomyPlane) => plane === 'skin' ? 1 : 0.12;
  const depthOf = (plane: AnatomyPlane) => depths[plane] ?? 0;
  const layer = (kind: AnatomyPlane) => {
    const opacity = (kind === from ? 1 - e : 0) + (kind === to ? e : 0);
    // La capa entrante «emerge» desde la profundidad de la saliente hasta la suya.
    const depth = kind === to ? depthOf(from) + (depthOf(to) - depthOf(from)) * e : depthOf(kind);
    return { opacity, depth };
  };
  return { done: t >= 1, skin: skinOf(from) + (skinOf(to) - skinOf(from)) * e, layer };
}
