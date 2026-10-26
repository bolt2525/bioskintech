import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODEL_REGISTRATION_ANCHORS, applyRegistration, autoRegistration, buildPersonalSurface, elemsFrom3D, fitAffineRegistration, frameFromLandmarks, isRegistrationAccepted,
  isWithinFace, projectModel, projectPersonal, rebasePersonalPoint, refineDepthFromProfiles, registrationAnchorIndices, trianglesFromEdges, updateRegistrationAnchor,
} from '../src/lab/faceSim/engine.ts';
import { FaceLandmarker } from '@mediapipe/tasks-vision';

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
  assert.deepEqual(detected.anchors[11], landmarks[61]);
  assert.deepEqual(detected.anchors[12], landmarks[291]);
  assert.deepEqual(detected.anchors[13], landmarks[98]);
  assert.deepEqual(detected.anchors[14], landmarks[327]);
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
  const target = projected.map(p => ({ x: p.x, y: p.y - 0.025 * Math.sin(2 * Math.PI * (p.y - base.top) / (base.bottom - base.top)) }));
  const registration = autoRegistration('frontal', { ...base, anchors: target }, 0.75, false);
  assert.ok(registration?.warp);
  projected.forEach((p, i) => {
    const mapped = applyRegistration(p, registration);
    assert.ok(Math.hypot(mapped.x - target[i].x, mapped.y - target[i].y) < 1e-6, `anclaje ${i}`);
  });
});

test('comisuras y alas nasales coinciden con sus referencias con error inferior a un píxel', () => {
  const base = { ...frame, axisTop: { x: 0.5, y: 0.1 } };
  const anchors = MODEL_REGISTRATION_ANCHORS.map(p => projectModel(p, 'frontal', base, false, 0.75));
  const target = anchors.map((p, i) => ({
    x: p.x + (i === 11 ? -0.02 : i === 12 ? 0.02 : 0),
    y: p.y + (i === 11 || i === 12 ? 0.025 : 0),
  }));
  const detected = { ...base, anchors: target };
  const registration = autoRegistration('frontal', detected, 0.75, false);
  assert.ok(isRegistrationAccepted(registration));
  const markers = [11, 12, 13, 14].map(i => ({ id: `ref-${i}`, position: MODEL_REGISTRATION_ANCHORS[i] }));
  const meta = Object.fromEntries(markers.map(m => [m.id, { mode: 'relleno_ha', dose: 0.2, zone: 'Auto' }]));
  const elems = elemsFrom3D({ markers, lines: [], shapes: [], meta }, 'frontal', detected, 0.75, false, registration);
  assert.equal(elems.length, markers.length);
  elems.forEach((elem, i) => {
    const q = elem.paths[0][0], expected = target[11 + i];
    assert.ok(Math.hypot((q.x - expected.x) * 1050, (q.y - expected.y) * 1400) < 1);
    assert.ok(isWithinFace(q, detected));
  });
  const adjusted = updateRegistrationAnchor('frontal', detected, 0.75, false, 11,
    { ...target[11], y: target[11].y + 0.005 }, MODEL_REGISTRATION_ANCHORS);
  assert.ok(adjusted);
  const q = projectModel(MODEL_REGISTRATION_ANCHORS[11], 'frontal', adjusted.frame, false, 0.75, adjusted.registration);
  assert.ok(Math.abs(q.y - target[11].y - 0.005) * 1400 < 1);
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
  const model = registrationAnchorIndices('frontal').map(i => ({ ...MODEL_REGISTRATION_ANCHORS[i], y: MODEL_REGISTRATION_ANCHORS[i].y + 0.02 }));
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

test('superficie personal: triangulación MediaPipe y correspondencia exacta 3D→foto', () => {
  const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
  assert.equal(triangles.length / 3, 852);
  assert.deepEqual(trianglesFromEdges([{ start: 1, end: 2 }, { start: 2, end: 3 }, { start: 9, end: 1 }]), []);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lm = Array.from({ length: 478 }, () => {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
    return { x: 0.5 + 0.2 * r * Math.cos(a), y: 0.5 + 0.3 * r * Math.sin(a), z: -0.06 * (1 - r * r) };
  });

  const aspect = 0.75;
  const surface = buildPersonalSurface(lm, aspect, triangles, 1);
  assert.ok(surface);
  const pos = i => ({ x: surface.positions[i * 3], y: surface.positions[i * 3 + 1], z: surface.positions[i * 3 + 2] });
  // Normalizada como el visor (dimensión máxima 5, centrada) para que su transformación sea identidad.
  const xs = lm.map((_, i) => pos(i).x), ys = lm.map((_, i) => pos(i).y);
  assert.ok(Math.abs(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) - 5) < 1e-4);
  assert.ok(Math.abs(Math.max(...ys) + Math.min(...ys)) < 1e-4);
  lm.forEach((p, i) => {
    const q = projectPersonal(pos(i), surface.projection);
    assert.ok(Math.abs(q.x - p.x) < 1e-5 && Math.abs(q.y - p.y) < 1e-5, `vértice ${i}`);
    assert.ok(Math.abs(surface.uvs[i * 2] - p.x) < 1e-6 && Math.abs(surface.uvs[i * 2 + 1] - p.y) < 1e-6);
  });
  // Un clic dentro de un triángulo (raycast) cae en el mismo punto interpolado de la textura/foto.
  const [a, b, c] = triangles.slice(0, 3), w = [0.2, 0.3, 0.5];
  const hit = ['x', 'y', 'z'].reduce((o, k) => ({ ...o, [k]: w[0] * pos(a)[k] + w[1] * pos(b)[k] + w[2] * pos(c)[k] }), {});
  const expected = { x: w[0] * lm[a].x + w[1] * lm[b].x + w[2] * lm[c].x, y: w[0] * lm[a].y + w[1] * lm[b].y + w[2] * lm[c].y };
  const [elem] = elemsFrom3D({ markers: [{ id: 'm1', position: hit }], lines: [], shapes: [], meta: { m1: { mode: 'toxina', dose: 4, zone: 'Auto' } } },
    'frontal', frame, aspect, false, undefined, surface.projection);
  assert.ok(Math.abs(elem.paths[0][0].x - expected.x) < 1e-5 && Math.abs(elem.paths[0][0].y - expected.y) < 1e-5);
  // El relieve no altera la correspondencia en foto.
  const deeper = buildPersonalSurface(lm, aspect, triangles, 2);
  assert.ok(Math.abs(projectPersonal({ x: deeper.positions[0], y: deeper.positions[1], z: 0 }, deeper.projection).x - lm[0].x) < 1e-5);
  for (const index of [61, 291, 98, 327]) {
    const rebased = rebasePersonalPoint(pos(index), surface.projection, deeper.projection, 2);
    ['x', 'y', 'z'].forEach((axis, offset) =>
      assert.ok(Math.abs(rebased[axis] - deeper.positions[index * 3 + offset]) < 1e-5, `${index}:${axis}`));
  }
  assert.equal(buildPersonalSurface(lm.slice(0, 100), aspect, triangles), null);
  assert.equal(buildPersonalSurface(lm, aspect, [0, 1, 999]), null);
});

const yawPose = angle => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -40, 1];
};
function depthFixture() {
  const aspect = 0.75;
  const landmarks = Array.from({ length: 478 }, (_, i) => ({
    x: 0.2 + (i % 22) / 21 * 0.6,
    y: 0.15 + Math.floor(i / 22) / 21 * 0.7,
    z: 0,
  }));
  landmarks[10].y = 0.15; landmarks[152].y = 0.85;
  const truth = landmarks.map(p => 0.12 * Math.exp(-((p.x - 0.5) ** 2 + (p.y - 0.48) ** 2) / 0.02));
  landmarks.forEach((p, i) => { p.z = -truth[i] * 2 / aspect; });
  const profile = (angle, scale = 0.9, depthScale = 1) => ({
    aspect: 0.8, pose: yawPose(angle),
    landmarks: landmarks.map((p, i) => ({
      x: (0.4 + scale * (Math.cos(angle) * (p.x - 0.5) * aspect + Math.sin(angle) * truth[i] * depthScale)) / 0.8,
      y: 0.5 + scale * (p.y - 0.5), z: 0,
    })),
  });
  return { front: { landmarks, aspect, pose: yawPose(0) }, truth, profile };
}

test('profundidad multivista: reduce >90% el error de relieve en geometría conocida sin alterar XY', () => {
  const { front, truth, profile } = depthFixture();
  const refined = refineDepthFromProfiles(front, [profile(Math.PI / 3), profile(-Math.PI / 2, 1.3)]);
  assert.equal(refined.used, 2);
  assert.deepEqual(refined.rejected, []);
  const shapeError = depths => {
    const errors = depths.map((z, i) => z - truth[i]), mean = errors.reduce((s, z) => s + z, 0) / errors.length;
    return Math.sqrt(errors.reduce((s, z) => s + (z - mean) ** 2, 0) / errors.length);
  };
  const before = shapeError(front.landmarks.map(p => -p.z * front.aspect));
  const after = shapeError(refined.landmarks.map(p => -p.z * front.aspect));
  assert.ok(after < before * 0.1, `${before} → ${after}`);
  refined.landmarks.forEach((p, i) => {
    assert.equal(p.x, front.landmarks[i].x);
    assert.equal(p.y, front.landmarks[i].y);
  });
  assert.equal(refineDepthFromProfiles(front, [profile(Math.PI / 3)]).used, 1);
});

test('profundidad multivista: rechaza vistas sin parallax, poses inválidas y laterales discordantes', () => {
  const { front, profile } = depthFixture();
  const frontal = refineDepthFromProfiles(front, [profile(0)]);
  assert.equal(frontal.used, 0);
  assert.match(frontal.rejected[0], /giro lateral/);
  const invalid = refineDepthFromProfiles(front, [{ ...profile(1), pose: Array(16).fill(0) }]);
  assert.equal(invalid.used, 0);
  assert.match(invalid.rejected[0], /inválidos/);
  const inconsistent = profile(1);
  inconsistent.landmarks.forEach((p, i) => { p.y += i % 2 ? 0.15 : -0.15; });
  assert.match(refineDepthFromProfiles(front, [inconsistent]).rejected[0], /no concuerdan/);
  const disagree = refineDepthFromProfiles(front, [profile(Math.PI / 2, 1, 2), profile(-Math.PI / 2, 1, -2)]);
  assert.equal(disagree.used, 0);
  assert.match(disagree.rejected.join(' '), /discrepan/);
  assert.deepEqual(disagree.landmarks, front.landmarks);
  assert.equal(refineDepthFromProfiles({ ...front, pose: undefined }, [profile(1)]).used, 0);
  assert.equal(refineDepthFromProfiles(front, []).used, 0);
});
