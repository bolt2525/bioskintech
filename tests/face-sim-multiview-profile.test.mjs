import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILE_MIDLINE, refineProfileDepth } from '../src/lab/faceSim/multiViewHead.ts';
import { refineDepthFromProfiles } from '../src/lab/faceSim/engine.ts';

// Exclusivamente geometría y segmentaciones sintéticas: sin imágenes ni datos de pacientes.
const H = 2;
const ys = [0.5, 0.4, 0.3, 0.2, 0.12, 0.06, 0, -0.1, -0.18, -0.25, -0.32];
const prior = y => 0.25 + 0.4 * Math.exp(-(((y - 0.02) / 0.22) ** 2));
const correction = y => 0.075 * Math.sin((y + 0.32) / 0.82 * Math.PI) - 0.025;
const lipIds = [0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91, 95,
  146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311, 312, 314,
  317, 318, 321, 324, 375, 402, 405, 409, 415];
function fixture() {
  const positions = new Float32Array(468 * 3);
  for (let i = 0; i < 468; i++) positions.set([0.6, -0.7, 0], i * 3);
  const put = (id, x, y, z) => positions.set([x, y, z], id * 3);
  put(10, 0, 1, 0); put(152, 0, -1, 0);
  put(234, -0.6, 0, 0); put(454, 0.6, 0, 0);
  PROFILE_MIDLINE.forEach((id, i) => put(id, 0, ys[i], prior(ys[i])));
  lipIds.forEach((id, i) => put(id, ((i % 5) - 2) * 0.025, -0.5 - (i % 3) * 0.01, 0.28));
  // Puntos intermedios que no son anclajes: validación independiente de la interpolación.
  const probes = [100, 101, 102, 103, 104, 105, 106, 107];
  probes.forEach((id, i) => { const y = -0.28 + i * 0.1; put(id, 0, y, prior(y)); });
  return { positions, probes };
}
function interpolate(points, y) {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  const j = sorted.findIndex(p => p.y >= y);
  if (j <= 0) return sorted[j === 0 ? 0 : sorted.length - 1].z;
  const a = sorted[j - 1], b = sorted[j];
  return a.z + (b.z - a.z) * (y - a.y) / (b.y - a.y);
}
function profile(positions, side, { delta = correction, lateral = 1, size = 768, beard = 0, pitch = 0 } = {}) {
  const width = size, height = size, scale = 0.3, dir = -side;
  const points = PROFILE_MIDLINE.map(id => ({
    y: positions[id * 3 + 1], z: positions[id * 3 + 2] + delta(positions[id * 3 + 1]),
  }));
  const edges = Float64Array.from({ length: height }, (_, row) => {
    const y = (0.5 - (row + 0.5) / height) / scale;
    return interpolate(points, y) + (y < -0.4 ? beard : 0);
  });
  const mask = Float32Array.from({ length: width * height }, (_, i) => {
    const u = (i % width + 0.5) / width;
    const z = (u - 0.45) / (dir * scale * lateral);
    return z < edges[Math.floor(i / width)] && z > -0.8 ? 1 : 0;
  });
  return { label: side < 0 ? 'A' : 'B', width, height, mask, texture: {},
    projection: { u: [scale * Math.sqrt(1 - lateral * lateral), 0, dir * scale * lateral, 0.45],
      v: [0, -scale, pitch, 0.5], towardCamera: [side, 0, 0] } };
}
const rms = values => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);

test('perfil bilateral: reduce error nasal en anclajes y alturas independientes, XY/labios exactos', t => {
  const { positions, probes } = fixture(), original = positions.slice();
  const result = refineProfileDepth(positions, [profile(positions, -1), profile(positions, 1)]);
  assert.ok(result);
  assert.equal(result.coverage, 'bilateral');
  assert.equal(result.points, PROFILE_MIDLINE.length);
  const errors = ids => ids.map(id => {
    const target = interpolate(PROFILE_MIDLINE.map(n => ({
      y: positions[n * 3 + 1], z: correction(positions[n * 3 + 1]),
    })), positions[id * 3 + 1]);
    return target - (result.positions[id * 3 + 2] - positions[id * 3 + 2]);
  });
  const before = rms(probes.map(id => correction(positions[id * 3 + 1]))), after = rms(errors(probes));
  const anchorBefore = rms(PROFILE_MIDLINE.map(id => correction(positions[id * 3 + 1])));
  const anchorAfter = rms(errors(PROFILE_MIDLINE));
  assert.ok(result.afterRmse < result.beforeRmse * 0.1, JSON.stringify({
    before: result.beforeRmse, after: result.afterRmse,
    samples: PROFILE_MIDLINE.map(id => [id, positions[id * 3 + 1], correction(positions[id * 3 + 1]), result.positions[id * 3 + 2] - positions[id * 3 + 2]]),
  }));
  assert.ok(after < before * 0.12, `${before} → ${after}`);
  assert.ok(result.maxDisplacement <= H * 0.08);
  for (let i = 0; i < 468; i++) {
    assert.equal(result.positions[i * 3], positions[i * 3]);
    assert.equal(result.positions[i * 3 + 1], positions[i * 3 + 1]);
  }
  for (const id of [...lipIds, 10, 152, 234, 454]) {
    assert.deepEqual(result.positions.slice(id * 3, id * 3 + 3), positions.slice(id * 3, id * 3 + 3));
  }
  assert.deepEqual(positions, original, 'no muta la entrada');
  t.diagnostic(`RMSE contra geometría conocida: anclajes ${(anchorBefore / H * 100).toFixed(3)}%H → ${(anchorAfter / H * 100).toFixed(3)}%H; alturas independientes ${(before / H * 100).toFixed(3)}%H → ${(after / H * 100).toFixed(3)}%H; máximo ${(result.maxDisplacement / H * 100).toFixed(3)}%H.`);
});

test('punta, dorso y columela admiten correcciones de distinto signo sin mover la boca', () => {
  const { positions } = fixture();
  const delta = y => y > 0.15 ? 0.06 : y > -0.05 ? -0.055 : 0.035;
  const result = refineProfileDepth(positions, [-1, 1].map(side => profile(positions, side, { delta })));
  assert.ok(result);
  for (const id of [6, 197, 4, 1, 19, 94, 2]) {
    const change = result.positions[id * 3 + 2] - positions[id * 3 + 2];
    assert.equal(Math.sign(change), Math.sign(delta(positions[id * 3 + 1])));
    assert.ok(Math.abs(change - delta(positions[id * 3 + 1])) < 0.008, `${id}: ${change} vs ${delta(positions[id * 3 + 1])}`);
  }
});

test('confianza absoluta por ángulo, unilateral y resolución; no amplifica vistas rasantes', () => {
  const { positions } = fixture();
  const full = refineProfileDepth(positions, [profile(positions, -1)]);
  const oblique = refineProfileDepth(positions, [profile(positions, -1, { lateral: 0.83 })]);
  assert.ok(full && oblique);
  assert.equal(full.coverage, 'one-sided');
  assert.ok(oblique.maxDisplacement < full.maxDisplacement * 0.2);
  assert.equal(refineProfileDepth(positions, [profile(positions, -1, { lateral: 0.79 })]), null);
  assert.equal(refineProfileDepth(positions, [profile(positions, -1, { size: 48 })]), null);
  assert.equal(refineProfileDepth(positions, [profile(positions, -1, { pitch: 0.1 })]), null);
});

test('barba bajo el subnasal no cambia nariz ni labios; orden bilateral es invariante', () => {
  const { positions } = fixture();
  const sources = [-1, 1].map(side => profile(positions, side));
  const beard = [-1, 1].map(side => profile(positions, side, { beard: 0.6 }));
  const a = refineProfileDepth(positions, sources), b = refineProfileDepth(positions, beard);
  assert.ok(a && b);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.positions, refineProfileDepth(positions, sources.reverse()).positions);
});

test('una fila perdida por muestra no arrastra el borde ni la pendiente del dorso', () => {
  const { positions } = fixture();
  const cleanSources = [-1, 1].map(side => profile(positions, side));
  const noisySources = cleanSources.map(source => {
    const mask = source.mask.slice();
    for (const id of PROFILE_MIDLINE) {
      const y = Math.floor((0.5 - positions[id * 3 + 1] * 0.3) * source.height);
      mask.fill(0, y * source.width, (y + 1) * source.width);
    }
    return { ...source, mask };
  });
  const clean = refineProfileDepth(positions, cleanSources), noisy = refineProfileDepth(positions, noisySources);
  assert.ok(clean && noisy);
  assert.equal(noisy.coverage, 'bilateral');
  for (const id of PROFILE_MIDLINE) assert.ok(Math.abs(clean.positions[id * 3 + 2] - noisy.positions[id * 3 + 2]) < H * 0.004);
});

test('siluetas incompatibles, recortadas, cabello y datos inválidos no inventan perfil', () => {
  const { positions } = fixture();
  assert.equal(refineProfileDepth(positions, [
    profile(positions, -1, { delta: () => 0.1 }), profile(positions, 1, { delta: () => -0.1 }),
  ]), null);
  assert.equal(refineProfileDepth(positions, [profile(positions, -1, { delta: () => H * 0.15 })]), null);
  const hair = profile(positions, -1); hair.hair = new Float32Array(hair.mask.length).fill(1);
  assert.equal(refineProfileDepth(positions, [hair]), null);
  const clipped = profile(positions, -1); clipped.mask.fill(1);
  assert.equal(refineProfileDepth(positions, [clipped]), null);
  const invalid = positions.slice(); invalid[3] = NaN;
  assert.equal(refineProfileDepth(invalid, []), null);
  assert.throws(() => refineProfileDepth(positions, [{ ...hair, hair: new Float32Array(2) }]), /inválida/);
});

test('engine permite conservar labios explícitamente durante triangulación multivista', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const yaw = 1.1, c = Math.cos(yaw), s = Math.sin(yaw);
  const truth = Array.from({ length: 468 }, (_, i) => ({
    x: ((i % 26) / 25 - 0.5) * 0.6,
    y: (Math.floor(i / 26) / 17 - 0.5) * 0.8,
    z: 0.07 * Math.cos(i * 0.17),
  }));
  truth[10].y = 0.4; truth[152].y = -0.4;
  const front = { aspect: 1, pose: identity, landmarks: truth.map(p => ({ x: p.x + 0.5, y: 0.5 - p.y, z: -p.z * 0.7 })) };
  const side = { aspect: 1, pose: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1],
    landmarks: truth.map(p => ({ x: 0.5 + c * p.x + s * p.z, y: 0.5 - p.y, z: -(c * p.z - s * p.x) })) };
  const result = refineDepthFromProfiles(front, [side], { preserveLips: true });
  assert.equal(result.used, 1);
  for (const id of lipIds) assert.deepEqual(result.landmarks[id], front.landmarks[id]);
  assert.ok(result.landmarks.some((p, i) => !lipIds.includes(i) && p.z !== front.landmarks[i].z), 'el resto sí aporta relieve');
});
