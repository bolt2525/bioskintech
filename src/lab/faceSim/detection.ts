export interface DetectionTransform {
  angle: number;
  scale: number;
  enhanced: boolean;
}

export const DETECTION_RETRIES: readonly DetectionTransform[] = [
  { angle: 0, scale: 0.82, enhanced: false },
  { angle: 0, scale: 1, enhanced: true },
  { angle: -15, scale: 0.85, enhanced: false },
  { angle: 15, scale: 0.85, enhanced: false },
  { angle: -30, scale: 0.8, enhanced: true },
  { angle: 30, scale: 0.8, enhanced: true },
];

export function restoreDetectionPoint(
  point: { x: number; y: number; z: number }, width: number, height: number, transform: DetectionTransform,
): { x: number; y: number; z: number } {
  const radians = transform.angle * Math.PI / 180;
  const x = (point.x - 0.5) * width / transform.scale;
  const y = (point.y - 0.5) * height / transform.scale;
  return {
    x: (Math.cos(radians) * x + Math.sin(radians) * y) / width + 0.5,
    y: (-Math.sin(radians) * x + Math.cos(radians) * y) / height + 0.5,
    z: point.z / transform.scale,
  };
}

export function detectionImage(source: HTMLCanvasElement, transform: DetectionTransform): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width; canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No se pudo preparar el reintento de detección.');
  context.fillStyle = '#808080'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(transform.angle * Math.PI / 180);
  context.scale(transform.scale, transform.scale);
  context.filter = transform.enhanced ? 'contrast(1.18) brightness(1.06)' : 'none';
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/**
 * Segunda pasada sobre un recorte ampliado del rostro: con caras pequeñas o lejanas MediaPipe
 * trabaja a 256 px de entrada y pierde precisión. Solo se acepta si concuerda con la primera pasada.
 */
export function refineLandmarksByCrop(
  landmarker: { detect(image: HTMLCanvasElement): { faceLandmarks: { x: number; y: number; z: number }[][] } },
  image: HTMLCanvasElement, landmarks: { x: number; y: number; z: number }[],
): { x: number; y: number; z: number }[] | null {
  const xs = landmarks.slice(0, 468).map(p => p.x * image.width), ys = landmarks.slice(0, 468).map(p => p.y * image.height);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const faceHeight = y1 - y0, side = Math.max(x1 - x0, faceHeight) * 1.7;
  if (!(faceHeight > 8) || faceHeight > image.height * 0.6) return null;
  const left = Math.max(0, (x0 + x1 - side) / 2), top = Math.max(0, (y0 + y1 - side) / 2);
  const width = Math.min(image.width - left, side), height = Math.min(image.height - top, side);
  const scale = Math.min(2, 1024 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, left, top, width, height, 0, 0, canvas.width, canvas.height);
  const result = landmarker.detect(canvas);
  // El recorte no debe sustituir una detección única por el primer rostro de varios.
  if (result.faceLandmarks.length !== 1) return null;
  const found = result.faceLandmarks[0];
  if (!found || found.length < 468) return null;
  const refined = found.map(p => ({
    x: (p.x * width + left) / image.width, y: (p.y * height + top) / image.height, z: p.z * width / image.width,
  }));
  const shift = refined.slice(0, 468).reduce((s, p, i) =>
    s + Math.hypot((p.x - landmarks[i].x) * image.width, (p.y - landmarks[i].y) * image.height), 0) / 468;
  return shift < faceHeight * 0.05 && refined.every(p => [p.x, p.y, p.z].every(Number.isFinite)) ? refined : null;
}

/** Landmarks 2D (normalizados) de una imagen cualquiera, p. ej. una ilustración frontal; null si no hay rostro. */
export async function detectImageLandmarks(image: HTMLCanvasElement): Promise<{ x: number; y: number }[] | null> {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/face/face_landmarker.task' }, runningMode: 'IMAGE', numFaces: 1,
    minFaceDetectionConfidence: 0.25, minFacePresenceConfidence: 0.35,
  });
  try {
    for (const transform of [{ angle: 0, scale: 1, enhanced: false }, ...DETECTION_RETRIES]) {
      const found = landmarker.detect(transform.angle || transform.scale !== 1 || transform.enhanced ? detectionImage(image, transform) : image).faceLandmarks[0];
      if (found) return found.map(point => restoreDetectionPoint(point, image.width, image.height, transform));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return null;
  } finally { landmarker.close(); }
}
