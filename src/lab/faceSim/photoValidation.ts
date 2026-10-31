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
  if (faceFraction < 0.08 || (bottom - top) * height < 140 || (right - left) * width < 90) {
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

const MIDLINE_DISTANCES: readonly [number, number][] = [[168, 2], [6, 152], [1, 152], [10, 152]];
// Hemicara A (33, 61, 50, 172, 98, 234); la B usa los índices simétricos.
const HEMIFACE_DISTANCES: readonly [number, number][] = [[33, 1], [33, 152], [61, 152], [33, 61], [50, 1], [172, 152], [98, 1], [234, 1]];
const MIRROR: Record<number, number> = { 33: 263, 61: 291, 50: 280, 172: 397, 98: 327, 234: 454 };
/** Por encima de este giro la profundidad del lado oculto es una inferencia de MediaPipe, no una medida. */
const PROFILE_YAW = 25 * Math.PI / 180;

function validView(v: DepthView) {
  return v.landmarks.length >= 468 && Number.isFinite(v.aspect) && v.aspect > 0
    && v.landmarks.every(p => [p.x, p.y, p.z].every(Number.isFinite));
}
const viewDistance = (v: DepthView) => (i: number, j: number) => {
  const p = v.landmarks[i], q = v.landmarks[j];
  return Math.hypot((p.x - q.x) * v.aspect, p.y - q.y, (p.z - q.z) * v.aspect);
};
/** Giro con signo: positivo si la hemicara de 234 queda más cerca de la cámara (z menor). */
export function viewYaw(v: DepthView) {
  const p = v.landmarks[234], q = v.landmarks[454];
  return Math.atan2((q.z - p.z) * v.aspect, Math.hypot((q.x - p.x) * v.aspect, q.y - p.y));
}

/** Clasificación conservadora por geometría observada; nunca por nombre/orden del archivo. */
export function classifyFacePose(v: DepthView): { view: 'frontal' | 'izquierda' | 'derecha' | null; reason: string } {
  if (!validView(v)) return { view: null, reason: 'Sin detector fiable: asigna la vista manualmente; no se generará geometría.' };
  const a = v.landmarks[234], b = v.landmarks[454];
  if (Math.hypot((a.x - b.x) * v.aspect, a.y - b.y, (a.z - b.z) * v.aspect) < 1e-4) {
    return { view: null, reason: 'Referencias de pose colapsadas; asigna la vista manualmente.' };
  }
  const yaw = viewYaw(v);
  if (!Number.isFinite(yaw)) return { view: null, reason: 'Pose indeterminada; asigna la vista manualmente.' };
  const degrees = Math.abs(yaw) * 180 / Math.PI;
  if (degrees <= 15) return { view: 'frontal', reason: 'Frontal por pose facial.' };
  if (degrees < 30) return { view: null, reason: 'Giro intermedio: confirma manualmente frontal o lateral.' };
  return { view: yaw > 0 ? 'izquierda' : 'derecha', reason: `Lateral ${yaw > 0 ? 'A' : 'B'} por pose (${Math.round(degrees)}°). El lado oculto es estimado.` };
}

/** Compara proporciones 3D invariantes a giro/escala. Compatibilidad NO significa misma identidad. */
export function compareFaceGeometry(a: DepthView, b: DepthView): { compatible: boolean; blocking: boolean; medianDifference: number; reason: string } {
  const bilateral = (v: DepthView) => {
    const distance = viewDistance(v), scale = distance(33, 263);
    if (scale < 1e-4) return null;
    const ratios = STABLE_DISTANCES.map(([i, j]) => distance(i, j) / scale);
    return ratios.every(x => Number.isFinite(x) && x > 1e-4) ? ratios : null;
  };
  // Con un perfil, solo línea media y hemicara visible: el lado oculto deformaría la firma.
  const hemiface = (v: DepthView, sideA: boolean) => {
    const distance = viewDistance(v), scale = distance(168, 152);
    if (scale < 1e-4) return null;
    const side = (i: number) => sideA ? i : MIRROR[i] ?? i;
    const ratios = [...MIDLINE_DISTANCES, ...HEMIFACE_DISTANCES.map(([i, j]) => [side(i), side(j)] as const)]
      .map(([i, j]) => distance(i, j) / scale);
    return ratios.every(x => Number.isFinite(x) && x > 1e-4) ? ratios : null;
  };
  let x: number[] | null = null, y: number[] | null = null, profile = false;
  if (validView(a) && validView(b)) {
    const yawA = viewYaw(a), yawB = viewYaw(b);
    if (Math.abs(yawA) < PROFILE_YAW && Math.abs(yawB) < PROFILE_YAW) { x = bilateral(a); y = bilateral(b); }
    else {
      // Lado visible de la vista más girada; si ambas lo están, cada una usa el suyo (simetría aproximada).
      profile = true;
      const dominant = Math.abs(yawA) >= Math.abs(yawB) ? yawA : yawB;
      const sideOf = (yaw: number) => Math.abs(yaw) < PROFILE_YAW ? dominant > 0 : yaw > 0;
      x = hemiface(a, sideOf(yawA)); y = hemiface(b, sideOf(yawB));
    }
  }
  if (!x || !y) return { compatible: false, blocking: false, medianDifference: Infinity, reason: 'No hay referencias estables suficientes para comparar las fotografías.' };
  const differences = x.map((v, i) => Math.abs(Math.log(v / y[i]))).sort((a, b) => a - b);
  const half = differences.length / 2;
  const medianDifference = (differences[half - 1] + differences[half]) / 2;
  const compatible = medianDifference <= 0.13
    && differences.filter(d => d > 0.22).length < 3
    && differences.filter(d => d > 0.35).length < 2;
  // Entre vistas frontales la geometría es observada: criterio estricto. En perfil la hemicara oculta es
  // inferida por MediaPipe, así que solo bloquean discrepancias groseras; el resto es advertencia.
  const blocking = !compatible && (!profile || medianDifference > 0.3 || differences.filter(d => d > 0.5).length >= 4);
  return { compatible, blocking, medianDifference, reason: compatible
    ? 'Proporciones compatibles; esto NO verifica identidad. Confirma que las fotos son de la misma persona.'
    : blocking
      ? 'Las proporciones faciales son incompatibles. Pueden ser personas distintas, filtros, oclusión o capturas no comparables. No se fusionarán.'
      : 'Proporciones algo distintas en el perfil (giro, expresión o lente). Se permite el cálculo; confirma que es la misma persona y revisa el resultado.' };
}
