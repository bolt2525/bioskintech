import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { HairPhotoProjection } from './estimatedHair';
import type { HeadPhotoSource } from './multiViewHead';

/** Cabello + piel facial/corporal visible (orejas). Nunca usa ropa ni fondo. */
export async function segmentPhotoHeads(photos: readonly {
  label: string; canvas: HTMLCanvasElement; projection: HairPhotoProjection;
}[]): Promise<HeadPhotoSource[]> {
  const segmenter = await ImageSegmenter.createFromOptions(await FilesetResolver.forVisionTasks('/mediapipe/wasm'), {
    baseOptions: { modelAssetPath: '/models/face/selfie_multiclass.tflite', delegate: 'CPU' },
    runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  });
  try {
    const sources: HeadPhotoSource[] = [];
    for (const photo of photos) {
      const result = segmenter.segment(photo.canvas);
      try {
        const masks = result.confidenceMasks;
        if (!masks || masks.length < 4) throw new Error('El segmentador no devolvió piel y cabello.');
        const { width, height } = masks[0];
        const channels = [1, 2, 3].map(id => masks[id].getAsFloat32Array());
        const mask = Float32Array.from(channels[0], (_, i) => Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0)));
        const texture = document.createElement('canvas');
        texture.width = photo.canvas.width; texture.height = photo.canvas.height;
        const ctx = texture.getContext('2d');
        if (!ctx) throw new Error('No se pudo preparar la textura multivista.');
        ctx.drawImage(photo.canvas, 0, 0);
        sources.push({ label: photo.label, width, height, mask, texture, projection: photo.projection });
      } finally { result.close(); }
    }
    return sources;
  } finally { segmenter.close(); }
}
