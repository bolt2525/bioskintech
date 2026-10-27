import assert from 'node:assert/strict';
import test from 'node:test';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import data from './fixtures/face-sim-mediapipe-synthetic.json' with { type: 'json' };
import { extendVisibleForehead, proposeForeheadBoundary } from '../src/lab/faceSim/faceContour.ts';
import { buildPersonalSurface, projectPersonal, trianglesFromEdges } from '../src/lab/faceSim/engine.ts';

const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
const fixture = { ...data, landmarks: data.landmarks.map(([x, y, z]) => ({ x, y, z })) };
const target = amount => {
  const [top, brow, chin] = [10, 9, 152].map(i => fixture.landmarks[i]);
  const dx = (top.x - brow.x) * fixture.aspect, dy = top.y - brow.y, length = Math.hypot(dx, dy);
  const height = Math.hypot((top.x - chin.x) * fixture.aspect, top.y - chin.y);
  return { x: top.x + dx / length * height * amount / fixture.aspect, y: top.y + dy / length * height * amount };
};
test('amplía banda frontal visible hasta el límite revisado, sin mover ojos/cejas ni alterar Z', () => {
  const before = structuredClone(fixture.landmarks), point = target(0.12);
  const result = extendVisibleForehead(fixture.landmarks, point, fixture.aspect, triangles);
  assert.ok(result);
  assert.ok(Math.hypot(result[10].x - point.x, result[10].y - point.y) < 1e-12);
  for (const i of [9, 33, 263, 70, 300, 66, 105, 296, 152]) assert.deepEqual(result[i], before[i]);
  result.forEach((p, i) => assert.equal(p.z, before[i].z));
  assert.deepEqual(fixture.landmarks, before);
  const surface = buildPersonalSurface(result, fixture.aspect, triangles);
  const pixel = projectPersonal({ x: surface.positions[30], y: surface.positions[31], z: surface.positions[32] }, surface.projection);
  assert.ok(Math.hypot(pixel.x - point.x, pixel.y - point.y) < 1e-6);
});
test('rechaza extensiones excesivas, hacia cejas, laterales o fuera de imagen', () => {
  assert.equal(extendVisibleForehead(fixture.landmarks, target(0.8), fixture.aspect, triangles), null);
  assert.equal(extendVisibleForehead(fixture.landmarks, target(-0.1), fixture.aspect, triangles), null);
  assert.equal(extendVisibleForehead(fixture.landmarks, { ...target(0.1), x: 0.95 }, fixture.aspect, triangles), null);
  assert.equal(extendVisibleForehead(fixture.landmarks, { x: 0.5, y: -0.01 }, fixture.aspect, triangles), null);
});
test('un borde capilar oscuro solo genera propuesta; sin borde no inventa frente', () => {
  const width = 500, height = 600;
  const data = new Uint8ClampedArray(width * height * 4);
  const top = fixture.landmarks[10], chin = fixture.landmarks[152];
  const cutoff = Math.round((top.y - (chin.y - top.y) * 0.12) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(y < cutoff ? [20, 15, 12, 255] : [190, 145, 130, 255], (y * width + x) * 4);
  const result = proposeForeheadBoundary(fixture.landmarks, { width, height, data });
  assert.ok(result.point);
  assert.match(result.reason, /candidato/);
  assert.ok(result.point.y < top.y);
  assert.ok(Math.abs(result.point.y * height - cutoff) < 8);
  data.fill(128);
  assert.equal(proposeForeheadBoundary(fixture.landmarks, { width, height, data }).point, null);
});
