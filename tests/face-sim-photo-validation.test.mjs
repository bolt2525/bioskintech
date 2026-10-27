import assert from 'node:assert/strict';
import test from 'node:test';
import { assessFaceCapture, compareFaceGeometry } from '../src/lab/faceSim/photoValidation.ts';
import data from './fixtures/face-sim-mediapipe-synthetic.json' with { type: 'json' };
const fixture = { ...data, landmarks: data.landmarks.map(([x, y, z]) => ({ x, y, z })) };

function image(uniform = false) {
  const width = 400, height = 500, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = uniform ? 0 : (x % 5) * 12 + (y % 3) * 6;
    data.set([120 + d, 100 + d, 80 + d, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}
function landmarks() {
  const xs = fixture.landmarks.map(p => p.x), ys = fixture.landmarks.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  return fixture.landmarks.map(p => ({ x: 0.22 + 0.56 * (p.x - x) / w, y: 0.12 + 0.76 * (p.y - y) / h, z: p.z }));
}

test('captura cercana detallada con un rostro supera el control, no equivale a identidad verificada', () => {
  const result = assessFaceCapture(image(), landmarks(), 1);
  assert.equal(result.accepted, true);
  assert.ok(result.faceFraction > 0.4);
  assert.deepEqual(result.reasons, []);
});
test('rechaza dos rostros y retrato pequeño típico de documento/collage', () => {
  assert.equal(assessFaceCapture(image(), landmarks(), 2).accepted, false);
  const small = landmarks().map(p => ({ ...p, x: 0.4 + (p.x - 0.5) * 0.3, y: 0.4 + (p.y - 0.5) * 0.3 }));
  const result = assessFaceCapture(image(), small, 1);
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(' '), /cédula/);
});
test('rechaza falta de detalle/exposición y referencias recortadas o inválidas', () => {
  assert.equal(assessFaceCapture(image(true), landmarks(), 1).accepted, false);
  const crop = landmarks(); crop[152].y = 1.01;
  assert.equal(assessFaceCapture(image(), crop, 1).accepted, false);
  const bad = landmarks(); bad[33].x = NaN;
  assert.equal(assessFaceCapture(image(), bad, 1).accepted, false);
  assert.throws(() => assessFaceCapture({ ...image(), data: new Uint8ClampedArray(3) }, landmarks(), 1), /inválidos/);
});
test('comparación conserva escala, giro 3D, traslación y aspecto sin afirmar identidad', () => {
  const a = { landmarks: fixture.landmarks, aspect: fixture.aspect };
  const angle = 0.7, k = 0.8, aspect = 0.75;
  const b = { aspect, landmarks: a.landmarks.map(p => {
    const x = p.x * a.aspect, y = p.y, z = p.z * a.aspect;
    return { x: (k * (x * Math.cos(angle) + z * Math.sin(angle)) + 0.15) / aspect, y: k * y + 0.08,
      z: k * (-x * Math.sin(angle) + z * Math.cos(angle)) / aspect };
  }) };
  const check = compareFaceGeometry(a, b);
  assert.equal(check.compatible, true);
  assert.ok(check.medianDifference < 1e-12);
  assert.match(check.reason, /NO verifica identidad/);
});
test('no fusiona diferencias anatómicas grandes en nariz, mandíbula y pómulos aunque estén confirmadas', () => {
  const a = { landmarks: landmarks(), aspect: 0.8 }, b = structuredClone(a);
  for (const [left, right] of [[98, 327], [172, 397], [50, 280], [234, 454]]) {
    const center = (b.landmarks[left].x + b.landmarks[right].x) / 2;
    for (const i of [left, right]) b.landmarks[i].x = center + (b.landmarks[i].x - center) * 1.6;
  }
  const result = compareFaceGeometry(a, b);
  assert.equal(result.compatible, false);
  assert.match(result.reason, /No se fusionarán/);
});
test('proporciones compatibles de dos personas parecidas no constituyen una prueba de identidad', () => {
  const a = { landmarks: landmarks(), aspect: 0.8 }, b = structuredClone(a);
  b.landmarks[1].z -= 0.002;
  const result = compareFaceGeometry(a, b);
  assert.equal(result.compatible, true);
  assert.match(result.reason, /Confirma/);
  assert.equal(compareFaceGeometry({ ...a, aspect: NaN }, b).compatible, false);
});
test('dos discrepancias extremas no quedan ocultas por la mediana de proporciones', () => {
  const a = { landmarks: landmarks(), aspect: 0.8 }, b = structuredClone(a);
  for (const [left, right] of [[168, 2], [6, 152]]) {
    for (const axis of ['x', 'y', 'z']) {
      const center = (a.landmarks[left][axis] + a.landmarks[right][axis]) / 2;
      for (const i of [left, right]) b.landmarks[i][axis] = center + (a.landmarks[i][axis] - center) * 1.6;
    }
  }
  const result = compareFaceGeometry(a, b);
  assert.ok(result.medianDifference < 0.13);
  assert.equal(result.compatible, false);
});
