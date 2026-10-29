import { FACE_OVAL, type P2 } from './engine.ts';
import { FACE_REGION_BOUNDARIES, FACE_REGION_SEEDS } from './faceRegions.ts';
import { analyzeSkinAppearance, applySkinCosmetics, SKIN_CANDIDATE_COLORS, skinSignalLayer, type SkinAppearanceResult, type SkinCosmeticParameters, type SkinSignalChannel, type SkinVisualCandidate } from './skinAppearance.ts';

export const SKIN_SIGNAL_RESOLUTIONS = [
  { value: 384, label: 'Rápido · 384 px' },
  { value: 768, label: 'Detalle · 768 px' },
  { value: 1400, label: 'Original · máximo 1400 px' },
] as const;
export type SkinSignalResolution = typeof SKIN_SIGNAL_RESOLUTIONS[number]['value'];
const MAX_ANALYSIS_SIDE = 1400;

function inside(x: number, y: number, polygon: readonly P2[]): boolean {
  let contained = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) contained = !contained;
  }
  return contained;
}

/**
 * ROI conservador aproximado MediaPipe, no segmentación de piel/cabello.
 * Sin referencias: máscara completa; el panel exige confirmar un recorte de solo piel.
 */
export function createSkinSignalMask(width: number, height: number, landmarks?: readonly P2[]): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 4096 || height > 4096 || width * height > 4_194_304) throw new RangeError('Dimensiones de máscara inválidas.');
  const mask = new Uint8Array(width * height);
  if (!landmarks) return mask.fill(1);
  const brows = FACE_REGION_SEEDS.find(entry => entry.zone === 'Cola de ceja')!.indices;
  const boundaries = [FACE_OVAL, ...Object.values(FACE_REGION_BOUNDARIES), brows];
  if (boundaries.some(ids => ids.some(i => !landmarks[i] || !Number.isFinite(landmarks[i].x)
    || !Number.isFinite(landmarks[i].y) || landmarks[i].x < 0 || landmarks[i].x > 1
    || landmarks[i].y < 0 || landmarks[i].y > 1))) {
    throw new TypeError('Referencias faciales incompletas o fuera de la imagen. Vuelve a detectar el rostro.');
  }
  const oval = FACE_OVAL.map(i => landmarks[i]);
  const center = oval.reduce((p, q) => ({ x: p.x + q.x / oval.length, y: p.y + q.y / oval.length }), { x: 0, y: 0 });
  const inset = oval.map(p => ({ x: center.x + (p.x - center.x) * 0.92, y: center.y + (p.y - center.y) * 0.92 }));
  const bounds = (ids: readonly number[], padding: number) => ({
    left: Math.min(...ids.map(i => landmarks[i].x)) - padding,
    right: Math.max(...ids.map(i => landmarks[i].x)) + padding,
    top: Math.min(...ids.map(i => landmarks[i].y)) - padding,
    bottom: Math.max(...ids.map(i => landmarks[i].y)) + padding,
  });
  const faceHeight = Math.max(...oval.map(p => p.y)) - Math.min(...oval.map(p => p.y));
  const margin = faceHeight * 0.04;
  const exclusions = [
    bounds(FACE_REGION_BOUNDARIES.leftEye, margin),
    bounds(FACE_REGION_BOUNDARIES.rightEye, margin),
    bounds([...FACE_REGION_BOUNDARIES.upperLip, ...FACE_REGION_BOUNDARIES.lowerLip], margin),
    ...brows.map(i => bounds([i], margin)),
  ];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width, v = (y + 0.5) / height;
    if (inside(u, v, inset) && !exclusions.some(b => u >= b.left && u <= b.right && v >= b.top && v <= b.bottom)) {
      mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Canvas RGB sin ampliar; lado mayor limitado a maxSide y nunca superior a 1400 px. */
export function skinSignalPreview(source: HTMLCanvasElement, maxSide: number = 384): HTMLCanvasElement {
  if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width < 1 || source.height < 1
    || source.width > 8192 || source.height > 8192 || source.width * source.height > 16_777_216) {
    throw new RangeError('La imagen está vacía o es demasiado grande. Usa una imagen de hasta 16 megapíxeles y lados de hasta 8192 px.');
  }
  if (!Number.isSafeInteger(maxSide) || maxSide < 1) throw new RangeError('Resolución de análisis inválida.');
  const scale = Math.min(1, Math.min(MAX_ANALYSIS_SIDE, maxSide) / Math.max(source.width, source.height));
  const preview = document.createElement('canvas');
  preview.width = Math.max(1, Math.round(source.width * scale));
  preview.height = Math.max(1, Math.round(source.height * scale));
  const context = preview.getContext('2d');
  if (!context) throw new Error('No se pudo abrir la imagen. Vuelve a cargar una captura local.');
  context.drawImage(source, 0, 0, preview.width, preview.height);
  return preview;
}

export function analyzeSkinSignalCanvas(base: HTMLCanvasElement, landmarks: readonly P2[] | undefined, sensitivity: number): SkinAppearanceResult {
  // Rechazar antes de leer/asignar RGBA si se omite accidentalmente skinSignalPreview.
  if (!Number.isSafeInteger(base.width) || !Number.isSafeInteger(base.height) || base.width < 1 || base.height < 1
    || base.width > MAX_ANALYSIS_SIDE || base.height > MAX_ANALYSIS_SIDE) {
    throw new RangeError('El análisis admite imágenes de hasta 1400 px por lado.');
  }
  const context = base.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No se pudieron leer los píxeles. Vuelve a cargar una captura local.');
  return analyzeSkinAppearance(
    context.getImageData(0, 0, base.width, base.height),
    createSkinSignalMask(base.width, base.height, landmarks),
    { sensitivity },
  );
}

/** Sólo se retoca una foto con referencias: no hay fallback de máscara sobre toda la imagen. */
export function composeSkinCosmeticTexture(
  source: HTMLCanvasElement, landmarks: readonly P2[], parameters: Partial<SkinCosmeticParameters>,
): HTMLCanvasElement {
  const output = skinSignalPreview(source, 768);
  const context = output.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No se pudo preparar el retoque cosmético local.');
  const image = context.getImageData(0, 0, output.width, output.height);
  const mask = createSkinSignalMask(output.width, output.height, landmarks);
  image.data.set(applySkinCosmetics(image, mask, parameters));
  context.putImageData(image, 0, 0);
  return output;
}

/** Textura compuesta nueva a resolución original; no modifica el canvas recibido. */
export function composeSkinSignalTexture(source: HTMLCanvasElement, base: HTMLCanvasElement, result: SkinAppearanceResult, channel: SkinSignalChannel): HTMLCanvasElement {
  const output = document.createElement('canvas');
  output.width = source.width; output.height = source.height;
  const context = output.getContext('2d');
  const overlay = document.createElement('canvas');
  overlay.width = base.width; overlay.height = base.height;
  const overlayContext = overlay.getContext('2d');
  if (!context || !overlayContext) throw new Error('No se pudo dibujar el filtro. Vuelve a seleccionar la imagen.');
  const image = overlayContext.createImageData(base.width, base.height);
  image.data.set(skinSignalLayer(result, channel).rgba);
  overlayContext.putImageData(image, 0, 0);
  context.drawImage(source, 0, 0);
  context.drawImage(overlay, 0, 0, output.width, output.height);
  return output;
}

/** Cuadros numerados sobre una copia: nunca quema ni modifica la fotografía original. */
export function composeSkinCandidateTexture(source: HTMLCanvasElement, candidates: readonly SkinVisualCandidate[]): HTMLCanvasElement {
  const output = document.createElement('canvas');
  output.width = source.width; output.height = source.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('No se pudieron dibujar los cuadros. Vuelve a activar los candidatos.');
  context.drawImage(source, 0, 0);
  const scale = Math.max(1, Math.max(source.width, source.height) / 384);
  context.font = `bold ${Math.round(11 * scale)}px sans-serif`;
  candidates.forEach((candidate, index) => {
    const x = candidate.x * output.width, y = candidate.y * output.height;
    const w = candidate.width * output.width, h = candidate.height * output.height;
    // Doble trazo y número: no depende exclusivamente del color de la categoría.
    context.strokeStyle = 'black'; context.lineWidth = 3 * scale;
    context.strokeRect(x, y, w, h);
    context.strokeStyle = SKIN_CANDIDATE_COLORS[candidate.channel] ?? 'white'; context.lineWidth = 2 * scale;
    context.strokeRect(x, y, w, h);
    const label = String(index + 1);
    const labelWidth = (label.length * 7 + 4) * scale, labelHeight = 14 * scale;
    const labelX = Math.min(x, Math.max(0, output.width - labelWidth));
    const labelY = Math.max(labelHeight, y);
    context.fillStyle = 'black';
    context.fillRect(labelX, labelY - labelHeight, labelWidth, labelHeight);
    context.fillStyle = SKIN_CANDIDATE_COLORS[candidate.channel] ?? 'white';
    context.fillRect(labelX, labelY - 2 * scale, labelWidth, 2 * scale);
    context.fillStyle = 'white';
    context.fillText(label, labelX + 2 * scale, labelY - 3 * scale);
  });
  return output;
}
