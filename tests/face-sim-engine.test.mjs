import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODEL_REGISTRATION_ANCHORS, applyRegistration, autoRegistration, fitAffineRegistration, frameFromLandmarks, isRegistrationAccepted,
  isWithinFace, projectModel, registrationAnchorIndices, updateRegistrationAnchor,
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
  landmarks[9] = { x: 0.51, y: 0.35 };
  landmarks[234] = { x: 0.2, y: 0.5 };
  landmarks[454] = { x: 0.8, y: 0.5 };
  const detected = frameFromLandmarks(landmarks);
  assert.equal(detected.source, 'landmarks');
  assert.equal(detected.outline?.length, 36);
  assert.deepEqual(detected.axisTop, landmarks[9]);
  assert.deepEqual(detected.anchors[1], landmarks[9]);
  assert.notDeepEqual(detected.anchors[1], landmarks[168]);
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
  [338, 297, 332, 284, 251, 389, 356, 323, 361, 288, 397, 365, 379, 378, 400, 377].forEach(i => { landmarks[i] = { x: 0.7, y: 0.5 }; });
  [148, 176, 149, 150, 136, 172, 58, 132, 93, 127, 162, 21, 54, 103, 67, 109].forEach(i => { landmarks[i] = { x: 0.3, y: 0.5 }; });
  landmarks[234] = { x: 0.2, y: 0.5 };
  landmarks[33] = { x: Number.NaN, y: 0.4 };
  assert.throws(() => frameFromLandmarks(landmarks), /fuera de rango/);
  landmarks[33] = { x: 0.3, y: 0.4 };
  landmarks[152] = { x: 0.5, y: 1.08 };
  assert.equal(frameFromLandmarks(landmarks).bottom, 1.08);
  landmarks[152] = { x: 0.5, y: 3 };
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

test('alinea automáticamente el modelo con anclajes detectados y rechaza poses discordantes', () => {
  const base = { ...frame, axisTop: { x: 0.5, y: 0.1 } };
  const scaled = MODEL_REGISTRATION_ANCHORS.map(p => projectModel(p, 'frontal', base, false, 0.75))
    .map(p => ({ x: 0.5 + (p.x - 0.5) * 0.9, y: 0.12 + p.y * 0.85 }));
  const registration = autoRegistration('frontal', { ...base, anchors: scaled }, 0.75, false);
  assert.ok(isRegistrationAccepted(registration));
  const nose = applyRegistration(projectModel(MODEL_REGISTRATION_ANCHORS[4], 'frontal', base, false, 0.75), registration);
  assert.ok(Math.hypot(nose.x - scaled[4].x, nose.y - scaled[4].y) < 1e-6);
  assert.equal(autoRegistration('frontal', base, 0.75, false), null);
  // Punta nasal por encima de la glabela: orden anatómico imposible.
  const inverted = scaled.map((p, i) => (i === 4 ? { ...p, y: scaled[1].y - 0.05 } : p));
  assert.equal(autoRegistration('frontal', { ...base, anchors: inverted }, 0.75, false), null);
  // Ojos cruzados: la deformación plegaría la imagen y debe rechazarse.
  const crossed = scaled.map((p, i) => (i === 2 ? scaled[3] : i === 3 ? scaled[2] : p));
  assert.equal(isRegistrationAccepted(autoRegistration('frontal', { ...base, anchors: crossed }, 0.75, false)), false);
});

test('la deformación thin-plate lleva cada anclaje a su landmark sin plegar el rostro', () => {
  const base = { ...frame, axisTop: { x: 0.5, y: 0.1 } };
  const projected = MODEL_REGISTRATION_ANCHORS.map(p => projectModel(p, 'frontal', base, false, 0.75));
  // Cejas más altas y nariz/labio más bajos que el modelo, como en pacientes reales.
  const target = projected.map((p, i) => ({ x: p.x, y: p.y + (i >= 7 ? -0.05 : i === 4 || i === 5 ? 0.04 : 0) }));
  const registration = autoRegistration('frontal', { ...base, anchors: target }, 0.75, false);
  assert.ok(registration?.warp);
  projected.forEach((p, i) => {
    const mapped = applyRegistration(p, registration);
    assert.ok(Math.hypot(mapped.x - target[i].x, mapped.y - target[i].y) < 1e-6, `anclaje ${i}`);
  });
});

test('corrige una referencia en foto y reproyecta exactamente sin mutar el marco original', () => {
  const base = { ...frame, axisTop: { x: 0.5, y: 0.1 } };
  const anchors = MODEL_REGISTRATION_ANCHORS.map(p => projectModel(p, 'frontal', base, false, 0.75));
  const detected = { ...base, anchors };
  const point = { x: anchors[1].x + 0.005, y: anchors[1].y - 0.015 };
  const updated = updateRegistrationAnchor('frontal', detected, 0.75, false, 1, point);
  assert.ok(updated);
  assert.deepEqual(updated.frame.axisTop, point);
  assert.deepEqual(detected.anchors, anchors);
  assert.notDeepEqual(detected.anchors[1], point);
  anchors.forEach((anchor, i) => {
    const mapped = projectModel(MODEL_REGISTRATION_ANCHORS[i], 'frontal', updated.frame, false, 0.75, updated.registration);
    assert.ok(mapped);
    const target = i === 1 ? point : anchor;
    assert.ok(Math.hypot(mapped.x - target.x, mapped.y - target.y) < 1e-6, `referencia ${i}`);
  });
  assert.equal(updateRegistrationAnchor('frontal', detected, 0.75, false, -1, point), null);
  assert.equal(updateRegistrationAnchor('frontal', detected, 0.75, false, 1, { x: NaN, y: 0.4 }), null);
  assert.equal(updateRegistrationAnchor('frontal', detected, 0.75, false, 1, { x: 0, y: 0 }), null);
  assert.equal(updateRegistrationAnchor('frontal', detected, 0.75, false, 4, { ...point, y: anchors[1].y - 0.1 }), null);
});

test('la corrección fotográfica conserva los anclajes personalizados de calibración manual', () => {
  const base = { ...frame, axisTop: { x: 0.5, y: 0.1 } };
  const model = MODEL_REGISTRATION_ANCHORS.slice(0, 7).map(p => ({ ...p, y: p.y + 0.02 }));
  const anchors = model.map(p => projectModel(p, 'frontal', base, false, 0.75));
  const detected = { ...base, anchors };
  const point = { ...anchors[4], y: anchors[4].y + 0.01 };
  const updated = updateRegistrationAnchor('frontal', detected, 0.75, false, 4, point, model);
  assert.ok(updated);
  const mapped = projectModel(model[4], 'frontal', updated.frame, false, 0.75, updated.registration);
  assert.ok(Math.hypot(mapped.x - point.x, mapped.y - point.y) < 1e-6);
  assert.equal(updateRegistrationAnchor('frontal', detected, 0.75, false, 4, point, model.slice(0, 4)), null);
});

for (const view of ['frontal', 'izquierda', 'derecha']) {
  for (const flip of [false, true]) {
    test(`corrige referencias en ${view}, inversión ${flip}, sin cambiar su correspondencia`, () => {
      const base = { ...frame, axisTop: { x: 0.5, y: 0.1 } };
      const anchors = MODEL_REGISTRATION_ANCHORS.map(p => projectModel(p, view, base, flip, 0.75))
        .map(p => p ? { ...p, x: 0.5 + (p.x - 0.5) * 0.95 } : null);
      const detected = { ...base, anchors };
      const point = { ...anchors[4], y: anchors[4].y + 0.002 };
      const updated = updateRegistrationAnchor(view, detected, 0.75, flip, 4, point);
      assert.ok(updated);
      const mapped = projectModel(MODEL_REGISTRATION_ANCHORS[4], view, updated.frame, flip, 0.75, updated.registration);
      assert.ok(mapped);
      assert.ok(Math.hypot(mapped.x - point.x, mapped.y - point.y) < 1e-6);
      const model = registrationAnchorIndices(view).map(i => MODEL_REGISTRATION_ANCHORS[i]);
      const manual = updateRegistrationAnchor(view, detected, 0.75, flip, 4, point, model);
      assert.ok(manual);
    });
  }
}
