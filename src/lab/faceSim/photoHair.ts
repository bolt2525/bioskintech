import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { HairPhotoProjection, PhotoHairSource } from './estimatedHair';

export async function segmentPhotoHair(photos: readonly { label: string; canvas: HTMLCanvasElement; projection: HairPhotoProjection }[]): Promise<PhotoHairSource[]> {
  const segmenter = await ImageSegmenter.createFromOptions(await FilesetResolver.forVisionTasks('/mediapipe/wasm'), {
    baseOptions: { modelAssetPath: '/models/face/hair_segmenter.tflite', delegate: 'CPU' },
    runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  });
  try {
    const sources: PhotoHairSource[] = [];
    for (const photo of photos) {
      const result = segmenter.segment(photo.canvas);
      try {
        const hair = result.confidenceMasks?.[1];
        if (!hair) throw new Error('El segmentador no devolvió la categoría cabello.');
        const width = hair.width, height = hair.height, mask = hair.getAsFloat32Array().slice();
        const texture = document.createElement('canvas'), normal = document.createElement('canvas');
        texture.width = normal.width = width; texture.height = normal.height = height;
        const ctx = texture.getContext('2d'), nctx = normal.getContext('2d');
        if (!ctx || !nctx) throw new Error('No se pudo preparar la textura capilar.');
        ctx.drawImage(photo.canvas, 0, 0, width, height);
        const rgb = ctx.getImageData(0, 0, width, height), normals = nctx.createImageData(width, height);
        const luminance = Float32Array.from(mask, (_, i) => (rgb.data[i * 4] * 0.2126 + rgb.data[i * 4 + 1] * 0.7152 + rgb.data[i * 4 + 2] * 0.0722) / 255);
        const value = (x: number, y: number) => luminance[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))];
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = y * width + x;
          rgb.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (mask[i] - 0.35) / 0.4)) * 255);
          const dx = (value(x - 1, y) - value(x + 1, y)) * 2, dy = (value(x, y - 1) - value(x, y + 1)) * 2;
          const length = Math.hypot(dx, dy, 1);
          normals.data.set([Math.round((dx / length + 1) * 127.5), Math.round((dy / length + 1) * 127.5), Math.round((1 / length + 1) * 127.5), 255], i * 4);
        }
        ctx.putImageData(rgb, 0, 0); nctx.putImageData(normals, 0, 0);
        sources.push({ label: photo.label, width, height, mask, texture, normal, projection: photo.projection });
      } finally { result.close(); }
    }
    return sources;
  } finally { segmenter.close(); }
}
