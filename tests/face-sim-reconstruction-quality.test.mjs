import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { buildPersonalSurface, refineDepthFromProfiles, trianglesFromEdges, fitHairPhotoProjection } from '../src/lab/faceSim/engine.ts';
import { extendVisibleForehead } from '../src/lab/faceSim/faceContour.ts';
import { PROFILE_CALIBRATION, calibrateProfileDepth } from '../src/lab/faceSim/profileCalibration.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const landmarks = fixture.landmarks.map(([x, y, z]) => ({ x, y, z }));
const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const front = { landmarks, aspect: fixture.aspect, pose: identity };

test('detección recuperada nunca aporta profundidad, aunque pose y número de puntos sean válidos', () => {
  const result = refineDepthFromProfiles(front, [{ ...front, recovered: true }], { preserveLips: true, preserveForehead: true });
  assert.equal(result.used, 0);
  assert.equal(result.diagnostics[0].status, 'rejected');
  assert.match(result.diagnostics[0].reason, /recuperada/);
  assert.deepEqual(result.landmarks, landmarks);
  const recoveredSource = refineDepthFromProfiles({ ...front, recovered: true }, [front]);
  assert.equal(recoveredSource.used, 0);
  assert.match(recoveredSource.diagnostics[0].reason, /monocular/);
});

test('frente recuperada mal situada no se extrapola sobre vecinos más altos', () => {
  const broken = structuredClone(landmarks);
  broken[10].y += (landmarks[152].y - landmarks[10].y) * 0.13;
  assert.equal(extendVisibleForehead(broken, { x: broken[10].x, y: landmarks[10].y - 0.03 }, fixture.aspect, triangles), null);
});

test('perfil directo conserva subnasal/filtrum y bandas labiales sin perder aporte nasal', () => {
  const angle = Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle), aspect = fixture.aspect;
  const side = { aspect, pose: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1],
    landmarks: landmarks.map(p => {
      const x = (p.x - 0.5) * aspect, z = -p.z * aspect * 1.15;
      return { x: 0.5 + (c * x + s * z) / aspect, y: p.y, z: -(c * z - s * x) / aspect };
    }) };
  const result = refineDepthFromProfiles(front, [side], { preserveLips: true, preserveForehead: true, preservePerioral: true });
  assert.equal(result.used, 1);
  for (const id of [2, 164, 0, 13, 14, 17, 10]) assert.deepEqual(result.landmarks[id], landmarks[id], String(id));
  assert.ok(result.landmarks.some((p, i) => p.z !== landmarks[i].z), 'el perfil válido sí aporta fuera de áreas protegidas');
});

test('calibración base: ocho zonas perceptibles, XY/UV e iris intactos y cero exacto', t => {
  const surface = buildPersonalSurface(landmarks, fixture.aspect, triangles);
  assert.ok(surface);
  const original = surface.positions.slice();
  const height = Math.hypot(original[30] - original[456], original[31] - original[457]);
  for (const control of PROFILE_CALIBRATION) {
    const result = calibrateProfileDepth(original, surface.indices, { [control.id]: 0.04 });
    const shift = result.positions[control.landmark * 3 + 2] - original[control.landmark * 3 + 2];
    assert.ok(shift > height * 0.005, `${control.id}: ${shift / height}`);
    for (let i = 0; i < original.length; i++) {
      if (i % 3 !== 2 || Math.floor(i / 3) >= 468) assert.equal(result.positions[i], original[i]);
    }
    for (const id of [33, 133, 263, 362, 10, 9]) {
      assert.deepEqual(result.positions.slice(id * 3, id * 3 + 3), original.slice(id * 3, id * 3 + 3));
    }
    assert.deepEqual(original, surface.positions);
    t.diagnostic(`${control.id}: ${(shift / height * 100).toFixed(2)}%H, ganancia ${(result.gain * 100).toFixed(1)}%`);
  }
  assert.deepEqual(calibrateProfileDepth(original, surface.indices, {}).positions, original);
  assert.deepEqual(calibrateProfileDepth(original, surface.indices, { tip: 0 }).positions, original);
});

test('calibración extrema preserva área orientada y no acumula; entradas inválidas se rechazan', () => {
  const surface = buildPersonalSurface(landmarks, fixture.aspect, triangles);
  const before = surface.positions.slice();
  const settings = Object.fromEntries(PROFILE_CALIBRATION.map((control, index) => [control.id, index % 2 ? -0.08 : 0.08]));
  const result = calibrateProfileDepth(before, surface.indices, settings);
  assert.deepEqual(result.positions, calibrateProfileDepth(before, surface.indices, settings).positions);
  const normal = (positions, a, b, c) => {
    const ab = [0, 1, 2].map(axis => positions[b * 3 + axis] - positions[a * 3 + axis]);
    const ac = [0, 1, 2].map(axis => positions[c * 3 + axis] - positions[a * 3 + axis]);
    return [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  };
  for (let i = 0; i < triangles.length; i += 3) {
    const ids = triangles.slice(i, i + 3), a = normal(before, ...ids), b = normal(result.positions, ...ids);
    const area = a.reduce((sum, v) => sum + v * v, 0);
    if (area > 1e-18) assert.ok(b.reduce((sum, v, j) => sum + v * a[j], 0) >= area * 0.199);
  }
  assert.throws(() => calibrateProfileDepth(before, surface.indices, { tip: NaN }), /inválida/);
  assert.throws(() => calibrateProfileDepth(before, surface.indices, { tip: 0.1 }), /inválida/);
  assert.throws(() => calibrateProfileDepth(before, surface.indices, { unknown: 0 }), /inválida/);
});

test('cámara ignora frente extrapolada y usa referencias rígidas válidas explícitas', () => {
  const surface = buildPersonalSurface(landmarks, fixture.aspect, triangles);
  const references = landmarks.map((_, i) => i).filter(i => i < 468 && landmarks[i].y >= landmarks[9].y);
  const distorted = landmarks.map((p, i) => references.includes(i) ? p : { ...p, x: p.x + 0.4, y: p.y - 0.2 });
  const fit = fitHairPhotoProjection(surface.positions, distorted, references);
  assert.ok(fit && fit.error < 1e-5);
  assert.equal(fitHairPhotoProjection(surface.positions, landmarks, [1, 2]), null);
  assert.equal(fitHairPhotoProjection(surface.positions, landmarks, Array(20).fill(1)), null);
});
