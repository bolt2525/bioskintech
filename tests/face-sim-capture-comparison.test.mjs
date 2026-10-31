import assert from 'node:assert/strict';
import test from 'node:test';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import fixture from './fixtures/face-sim-mediapipe-synthetic.json' with { type: 'json' };
import { extendVisibleForehead, proposeForeheadBoundary } from '../src/lab/faceSim/faceContour.ts';
import { classifyFacePose } from '../src/lab/faceSim/photoValidation.ts';
import { trianglesFromEdges } from '../src/lab/faceSim/engine.ts';
import { refineLandmarksByCrop } from '../src/lab/faceSim/detection.ts';

const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
const rotated = degrees => {
  const angle = degrees * Math.PI / 180;
  return fixture.landmarks.map(([x, y, z]) => ({
    x: 0.5 + (x - 0.5) * Math.cos(angle) + z * Math.sin(angle),
    y, z: -(x - 0.5) * Math.sin(angle) + z * Math.cos(angle),
  }));
};
const area = (points, a, b, c) => (points[b].x - points[a].x) * (points[c].y - points[a].y)
  - (points[b].y - points[a].y) * (points[c].x - points[a].x);

test('pose geométrica clasifica frontal y lados opuestos, no el orden/nombre de archivos', () => {
  for (const [degrees, expected] of [[0, 'frontal'], [45, 'derecha'], [-45, 'izquierda'], [75, 'derecha'], [-75, 'izquierda']]) {
    assert.equal(classifyFacePose({ landmarks: rotated(degrees), aspect: fixture.aspect }).view, expected);
  }
  assert.equal(classifyFacePose({ landmarks: rotated(22), aspect: fixture.aspect }).view, null);
  assert.equal(classifyFacePose({ landmarks: [], aspect: 1 }).view, null);
  const invalid = rotated(0); invalid[9].x = NaN;
  assert.equal(classifyFacePose({ landmarks: invalid, aspect: 1 }).view, null);
  const collapsed = rotated(0); collapsed[454] = { ...collapsed[234] };
  assert.equal(classifyFacePose({ landmarks: collapsed, aspect: fixture.aspect }).view, null);
  const roll = Math.PI / 3;
  const tilted = rotated(45).map(p => {
    const x = (p.x - 0.5) * fixture.aspect, y = p.y - 0.5;
    return { ...p, x: 0.5 + (x * Math.cos(roll) - y * Math.sin(roll)) / fixture.aspect,
      y: 0.5 + x * Math.sin(roll) + y * Math.cos(roll) };
  });
  assert.equal(classifyFacePose({ landmarks: tilted, aspect: fixture.aspect }).view, 'derecha', 'invariante a inclinación');
});

test('frente elevada en perfiles conserva TODOS los triángulos y deja ojos/cejas y Z intactos', () => {
  for (const degrees of [-75, -60, -45, 45, 60, 75]) {
    const points = rotated(degrees), before = structuredClone(points);
    const top = points[10], brow = points[9], chin = points[152];
    const dx = (top.x - brow.x) * fixture.aspect, dy = top.y - brow.y;
    const length = Math.hypot(dx, dy);
    const height = Math.hypot((chin.x - top.x) * fixture.aspect, chin.y - top.y);
    const target = { x: top.x + dx / length * height * 0.12 / fixture.aspect, y: top.y + dy / length * height * 0.12 };
    const result = extendVisibleForehead(points, target, fixture.aspect, triangles);
    assert.ok(result, `extensión axial válida de perfil ${degrees}°`);
    assert.ok(Math.hypot(result[10].x - target.x, result[10].y - target.y) < 1e-12);
    for (let i = 0; i < triangles.length; i += 3) {
      const ids = triangles.slice(i, i + 3), original = area(points, ...ids);
      if (Math.abs(original) > 1e-10) assert.ok(area(result, ...ids) / original >= 0.15);
    }
    for (const i of [9, 33, 263, 70, 300, 105, 296, 152]) assert.deepEqual(result[i], points[i]);
    result.forEach((point, i) => assert.equal(point.z, points[i].z));
    assert.deepEqual(points, before);
    assert.equal(extendVisibleForehead(points, { x: 0.99, y: 0.01 }, fixture.aspect, triangles), null);
    assert.equal(extendVisibleForehead(points, brow, fixture.aspect, triangles), null);
    assert.equal(extendVisibleForehead(points, target, fixture.aspect, [0, 1, 999]), null);
  }
});

test('solo borde de piel coherente permite autoaceptar; imagen ambigua no inventa frente', () => {
  const width = 500, height = 600, data = new Uint8ClampedArray(width * height * 4);
  const landmarks = rotated(0);
  const cutoff = Math.round((landmarks[10].y - (landmarks[152].y - landmarks[10].y) * 0.1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const variation = (x * 7 + y * 13) % 9;
    data.set(y < cutoff ? [215 + variation, 185 + variation, 95, 255]
      : [190 + variation, 145 + variation, 130 + variation, 255], (y * width + x) * 4);
  }
  const proposal = proposeForeheadBoundary(landmarks, { width, height, data });
  assert.equal(proposal.reliable, true);
  assert.ok(extendVisibleForehead(landmarks, proposal.point, width / height, triangles));
  data.fill(128);
  assert.equal(proposeForeheadBoundary(landmarks, { width, height, data }).point, null);
});

test('refinamiento por recorte rechaza varios rostros en vez de elegir el primero', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) };
  try {
    const landmarks = rotated(0).map(p => ({ ...p, x: 0.25 + p.x * 0.5, y: 0.25 + p.y * 0.5 }));
    let detected = false;
    const landmarker = { detect() { detected = true; return { faceLandmarks: [landmarks, landmarks] }; } };
    assert.equal(refineLandmarksByCrop(landmarker, { width: 1000, height: 1200 }, landmarks), null);
    assert.equal(detected, true, 'se ejercita el recorte real, no un early return de dimensiones');
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
