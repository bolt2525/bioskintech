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
