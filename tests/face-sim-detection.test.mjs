import assert from 'node:assert/strict';
import test from 'node:test';
import { DETECTION_RETRIES, restoreDetectionPoint } from '../src/lab/faceSim/detection.ts';

test('reintentos invierten giro y escala sin deformar la foto ni su profundidad', () => {
  const width = 768, height = 1024, source = { x: 0.71, y: 0.32, z: -0.07 };
  for (const t of DETECTION_RETRIES) {
    const r = t.angle * Math.PI / 180;
    const x = (source.x - 0.5) * width, y = (source.y - 0.5) * height;
    const transformed = {
      x: (Math.cos(r) * x - Math.sin(r) * y) * t.scale / width + 0.5,
      y: (Math.sin(r) * x + Math.cos(r) * y) * t.scale / height + 0.5,
      z: source.z * t.scale,
    };
    const restored = restoreDetectionPoint(transformed, width, height, t);
    for (const key of ['x', 'y', 'z']) assert.ok(Math.abs(restored[key] - source[key]) < 1e-12);
  }
});
