import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODEL_REGISTRATION_ANCHORS, applyRegistration, autoRegistration, fitAffineRegistration, frameFromLandmarks, isRegistrationAccepted,
  isWithinFace, projectModel,
} from '../src/lab/faceSim/engine.ts';

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
  const ovalIndices = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ];
  ovalIndices.forEach((index, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / ovalIndices.length;
    landmarks[index] = { x: 0.5 + Math.cos(angle) * 0.3, y: 0.5 + Math.sin(angle) * 0.4 };
  });
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

test('rechaza landmarks no finitos y límites faciales degenerados', () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  landmarks[10] = { x: 0.5, y: 0.1 };
  landmarks[152] = { x: 0.5, y: 0.9 };
  landmarks[234] = { x: 0.5, y: 0.5 };
  landmarks[454] = { x: 0.5, y: 0.5 };
  assert.throws(() => frameFromLandmarks(landmarks), /Geometría/);
  landmarks[454] = { x: 0.8, y: 0.5 };
  landmarks[33] = { x: Number.NaN, y: 0.4 };
  assert.throws(() => frameFromLandmarks(landmarks), /fuera de rango/);
});

test('calibra modelo→foto con varios anclajes y reporta residuos', () => {
  const source = [
    { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.2, y: 0.8 },
    { x: 0.8, y: 0.8 }, { x: 0.5, y: 0.4 }, { x: 0.4, y: 0.6 }, { x: 0.6, y: 0.6 },
  ];
  const target = source.map(p => ({ x: 0.8 * p.x + 0.1 * p.y + 0.05, y: -0.1 * p.x + 0.9 * p.y + 0.08 }));
  const registration = fitAffineRegistration(source, target, 1, 0.8);
  assert.ok(registration);
  assert.ok(registration.rmse < 1e-6);
  assert.ok(registration.maxError < 1e-6);
  assert.ok(Math.abs(applyRegistration(source[0], registration).x - target[0].x) < 1e-6);
  assert.equal(fitAffineRegistration(source.slice(0, 4), target.slice(0, 4), 1, 0.8), null);
  assert.equal(fitAffineRegistration(source, source.map(p => ({ ...p, x: Number.NaN })), 1, 0.8), null);
  const discordant = target.map(p => ({ ...p }));
  discordant[0].x += 0.2;
  assert.ok((fitAffineRegistration(source, discordant, 1, 0.8)?.rmse ?? 0) > 0.025);
});

test('valida que el punto proyectado quede dentro del contorno facial calibrado', () => {
  const detected = {
    ...frame,
    outline: [
      { x: 0.5, y: 0.1 },
      { x: 0.75, y: 0.5 },
      { x: 0.5, y: 0.9 },
      { x: 0.25, y: 0.5 },
    ],
  };
  assert.equal(isWithinFace({ x: 0.5, y: 0.5 }, detected), true);
  assert.equal(isWithinFace({ x: 0.1, y: 0.5 }, detected), false);
  const registration = { a: 1, b: 0, c: -0.4, d: 0, e: 1, f: 0, rmse: 0, maxError: 0 };
  assert.equal(projectModel({ x: 0, y: 0.45, z: 0 }, 'frontal', detected, false, 1, registration), null);
});

test('alinea autom?ticamente el modelo con anclajes detectados y rechaza poses discordantes', () => {
  const base = { ...frame, axisTop: { x: 0.5, y: 0.1 } };
  const scaled = MODEL_REGISTRATION_ANCHORS.map(p => projectModel(p, 'frontal', base, false, 0.75))
    .map(p => ({ x: 0.5 + (p.x - 0.5) * 0.9, y: 0.12 + p.y * 0.85 }));
  const registration = autoRegistration('frontal', { ...base, anchors: scaled }, 0.75, false);
  assert.ok(isRegistrationAccepted(registration));
  const nose = applyRegistration(projectModel(MODEL_REGISTRATION_ANCHORS[4], 'frontal', base, false, 0.75), registration);
  assert.ok(Math.hypot(nose.x - scaled[4].x, nose.y - scaled[4].y) < 1e-6);
  assert.equal(autoRegistration('frontal', base, 0.75, false), null);
  const skewed = scaled.map((p, i) => (i === 4 ? { ...p, x: p.x + 0.15 } : p));
  assert.equal(isRegistrationAccepted(autoRegistration('frontal', { ...base, anchors: skewed }, 0.75, false)), false);
});
