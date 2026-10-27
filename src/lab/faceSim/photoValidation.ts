import type { DepthView } from './engine';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };
export interface CaptureQuality {
  accepted: boolean;
  reasons: string[];
  warnings: string[];
  faceFraction: number;
}

/** Control de captura, no detector de documentos ni prueba de vida/identidad. */
export function assessFaceCapture(image: Pixels, landmarks: DepthView['landmarks'], faceCount: number): CaptureQuality {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) {
    throw new Error('No se puede validar la captura: píxeles o dimensiones inválidos.');
  }
  const reasons: string[] = [], warnings: string[] = [];
  if (faceCount !== 1) reasons.push('Se requiere exactamente un rostro, sin otras personas ni retratos dentro de la foto.');
  if (landmarks.length < 468 || landmarks.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) {
    return { accepted: false, reasons: [...reasons, 'Las referencias faciales están incompletas o no son válidas.'], warnings, faceFraction: 0 };
  }
  const xs = landmarks.slice(0, 468).map(p => p.x), ys = landmarks.slice(0, 468).map(p => p.y);
  const left = Math.max(0, Math.min(...xs)), right = Math.min(1, Math.max(...xs));
  const top = Math.max(0, Math.min(...ys)), bottom = Math.min(1, Math.max(...ys));
  const faceFraction = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (faceFraction < 0.12 || (bottom - top) * height < 160 || (right - left) * width < 100) {
    reasons.push('El rostro es demasiado pequeño. Usa una foto cercana del rostro, no una cédula, documento, collage o captura con un retrato pequeño.');
  }
  if ([33, 263, 1, 13, 152].some(i => landmarks[i].x <= 0.005 || landmarks[i].x >= 0.995 || landmarks[i].y <= 0.005 || landmarks[i].y >= 0.995)) {
    reasons.push('Faltan referencias por recorte. Incluye ojos, nariz, boca y mentón completos.');
  }
  if (top < 0.025) warnings.push('La frente queda cerca del borde de la imagen: puede faltar piel superior. Revisa la línea del cabello.');
  const luma = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  const samples: number[] = [];
  let lap2 = 0, clipped = 0;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 256));
  for (let y = Math.max(1, Math.ceil(top * height)); y < Math.min(height - 1, bottom * height); y += step) {
    for (let x = Math.max(1, Math.ceil(left * width)); x < Math.min(width - 1, right * width); x += step) {
      const value = luma(x, y);
      samples.push(value);
      lap2 += (luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1) - 4 * value) ** 2;
      if (value < 8 || value > 247) clipped++;
    }
  }
  samples.sort((a, b) => a - b);
  if (!samples.length || samples[Math.floor(samples.length * 0.9)] - samples[Math.floor(samples.length * 0.1)] < 14 || clipped / samples.length > 0.65) {
    reasons.push('La exposición no conserva suficientes detalles faciales. Evita oscuridad, reflejos y sobreexposición.');
  } else if (lap2 / samples.length < 2) {
    reasons.push('La captura no tiene suficiente detalle para reconstruir una superficie fiable. Usa una foto enfocada sin filtros de suavizado.');
  } else if (lap2 / samples.length < 15) {
    warnings.push('Detalle limitado: revisa enfoque, resolución y filtros de suavizado.');
  }
  return { accepted: reasons.length === 0, reasons, warnings, faceFraction };
}

const STABLE_DISTANCES: readonly [number, number][] = [
  [133, 362], [98, 327], [234, 454], [172, 397], [168, 2], [6, 152], [50, 280], [127, 356],
];

/** Compara proporciones 3D invariantes a giro/escala. Compatibilidad NO significa misma identidad. */
export function compareFaceGeometry(a: DepthView, b: DepthView): { compatible: boolean; medianDifference: number; reason: string } {
  const signature = (v: DepthView) => {
    if (v.landmarks.length < 468 || !Number.isFinite(v.aspect) || v.aspect <= 0
      || v.landmarks.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) return null;
    const distance = (i: number, j: number) => {
      const p = v.landmarks[i], q = v.landmarks[j];
      return Math.hypot((p.x - q.x) * v.aspect, p.y - q.y, (p.z - q.z) * v.aspect);
    };
    const scale = distance(33, 263);
    if (scale < 1e-4) return null;
    const ratios = STABLE_DISTANCES.map(([i, j]) => distance(i, j) / scale);
    return ratios.every(x => Number.isFinite(x) && x > 1e-4) ? ratios : null;
  };
  const x = signature(a), y = signature(b);
  if (!x || !y) return { compatible: false, medianDifference: Infinity, reason: 'No hay referencias estables suficientes para comparar las fotografías.' };
  const differences = x.map((v, i) => Math.abs(Math.log(v / y[i]))).sort((a, b) => a - b);
  const medianDifference = (differences[3] + differences[4]) / 2;
  const compatible = medianDifference <= 0.13
    && differences.filter(d => d > 0.22).length < 3
    && differences.filter(d => d > 0.35).length < 2;
  return { compatible, medianDifference, reason: compatible
    ? 'Proporciones compatibles; esto NO verifica identidad. Confirma que las fotos son de la misma persona.'
    : 'Las proporciones faciales son incompatibles. Pueden ser personas distintas, filtros, oclusión o capturas no comparables. No se fusionarán.' };
}
