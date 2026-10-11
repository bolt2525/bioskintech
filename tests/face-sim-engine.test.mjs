import assert from 'node:assert/strict';
import test from 'node:test';
import { frameFromLandmarks, projectModel } from '../src/lab/faceSim/engine.ts';

const frame = {
  top: 0.1,
  bottom: 0.9,
  left: 0.1,
  right: 0.9,
  axisTop: { x: 0.5, y: 0.5 },
  axisBottom: { x: 0.5, y: 0.9 },
  source: 'landmarks',
};

test('adapta la proyección frontal al ancho local del contorno facial', () => {
  const detected = {
    ...frame,
    outline: [
      { x: 0.5, y: 0.1 },
      { x: 0.75, y: 0.5 },
      { x: 0.5, y: 0.9 },
      { x: 0.25, y: 0.5 },
    ],
  };
  const point = projectModel({ x: 1.1, y: 0.45, z: 0 }, 'frontal', detected, false);
  assert.ok(point);
  assert.ok(Math.abs(point.x - 0.75) < 0.001);
  assert.equal(point.y, 0.5);
});

test('usa el eje detectado para centrar la proyección cuando el rostro está inclinado', () => {
  const tilted = {
    ...frame,
    axisTop: { x: 0.55, y: 0.5 },
    axisBottom: { x: 0.45, y: 0.9 },
  };
  const point = projectModel({ x: 0, y: 0.45, z: 0 }, 'frontal', tilted, false);
  assert.ok(point);
  assert.ok(Math.abs(point.x - 0.55) < 0.001);
});

test('mantiene la escala manual cuando no hay contorno detectado', () => {
  const point = projectModel({ x: 1.1, y: 0.45, z: 0 }, 'frontal', frame, false);
  assert.ok(point);
  assert.equal(point.x, 0.9);
});

test('convierte los landmarks del óvalo en un contorno normalizado', () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  landmarks[10] = { x: 0.5, y: 0.1 };
  landmarks[152] = { x: 0.5, y: 0.9 };
  landmarks[168] = { x: 0.52, y: 0.45 };
  landmarks[234] = { x: 0.2, y: 0.5 };
  landmarks[454] = { x: 0.8, y: 0.5 };
  const detected = frameFromLandmarks(landmarks);
  assert.equal(detected.source, 'landmarks');
  assert.equal(detected.outline?.length, 36);
  assert.deepEqual(detected.axisTop, { x: 0.52, y: 0.45 });
  assert.throws(() => frameFromLandmarks(landmarks.slice(0, 200)), /incompletos/);
});
