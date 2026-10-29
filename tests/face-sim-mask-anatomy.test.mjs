import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildMaskBacking, INITIAL_REVEAL, revealPlane, revealStage } from '../src/lab/faceSim/maskAnatomy.ts';
import { anatomicalZoneAt, ANATOMICAL_ZONES } from '../src/lab/faceSim/anatomicalZones.ts';

test('desvelado: ambos extremos y continuidad piel → músculo → hueso', () => {
  assert.equal(revealStage(INITIAL_REVEAL), null);
  const stage = progress => revealStage({ ...INITIAL_REVEAL, mode: 'progressive', progress });
  assert.deepEqual(stage(0), { from: 'skin', to: 'muscle', fraction: 0 });
  assert.deepEqual(stage(0.25), { from: 'skin', to: 'muscle', fraction: 0.5 });
  assert.deepEqual(stage(0.5), { from: 'muscle', to: 'bone', fraction: 0 });
  assert.deepEqual(stage(1), { from: 'muscle', to: 'bone', fraction: 1 });
  assert.throws(() => stage(NaN));
  assert.throws(() => stage(1.1));
  assert.throws(() => revealStage({ mode: 'compare', from: 'muscle', to: 'muscle', progress: 0.4 }));
  assert.deepEqual(revealStage({ mode: 'compare', from: 'skin', to: 'bone', progress: 0.7 }), { from: 'skin', to: 'bone', fraction: 0.7 });
});

test('el plano retira primero la punta y al final toda la superficie saliente', () => {
  const distance = (plane, z) => plane.normal.z * z + plane.constant;
  assert.ok(distance(revealPlane(-0.2, 0.8, 0), 0.8) > 0);
  const mid = revealPlane(-0.2, 0.8, 0.5);
  assert.ok(distance(mid, 0.8) < 0);
  assert.ok(distance(mid, -0.2) > 0);
  assert.ok(distance(revealPlane(-0.2, 0.8, 1), -0.2) < 0);
  assert.throws(() => revealPlane(0, 0, 0.5));
});

test('reverso: tapa y contorno, no fotografía, conserva la superficie frontal', () => {
  const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
  const front = Float32Array.from(atlas.positions), original = front.slice();
  const back = buildMaskBacking(front, Uint32Array.from(atlas.triangles));
  assert.deepEqual(front, original);
  assert.ok(back.positions.every(Number.isFinite));
  assert.ok(back.indices.length > 0 && back.indices.every(i => i * 3 + 2 < back.positions.length));
  const n = front.length / 3;
  assert.ok(back.positions.length >= front.length * 2);
  const ids = [...new Set(atlas.triangles)];
  for (const id of ids) {
    const depth = front[id * 3 + 2] - back.positions[(id + n) * 3 + 2];
    assert.ok(depth >= back.thickness * 0.3 - 1e-6, 'el reverso queda siempre detrás de la piel');
  }
  // Rugosidad = diferencia media con el promedio de vecinos; el reverso no debe repetir ojos/boca en negativo.
  const neighbours = new Map(ids.map(id => [id, new Set()]));
  for (let i = 0; i < atlas.triangles.length; i += 3) for (let j = 0; j < 3; j++) {
    neighbours.get(atlas.triangles[i + j]).add(atlas.triangles[i + (j + 1) % 3]);
    neighbours.get(atlas.triangles[i + (j + 1) % 3]).add(atlas.triangles[i + j]);
  }
  const roughness = zOf => ids.reduce((sum, id) => {
    const list = [...neighbours.get(id)];
    return sum + Math.abs(zOf(id) - list.reduce((s, k) => s + zOf(k), 0) / list.length);
  }, 0) / ids.length;
  assert.ok(roughness(id => back.positions[(id + n) * 3 + 2]) < roughness(id => front[id * 3 + 2]) * 0.5,
    'reverso liso: sin relieve facial invertido');
  const edgeCounts = new Map();
  const complete = [...atlas.triangles, ...back.indices];
  for (let i = 0; i < complete.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = complete[i + j], b = complete[i + (j + 1) % 3], key = [a, b].sort((a, b) => a - b).join(':');
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  assert.ok([...edgeCounts.values()].every(count => count === 2), 'piel + reverso cierran contornos, incluidos ojos y boca, sin caras flotantes');
  assert.throws(() => buildMaskBacking(front, Uint32Array.from([0, 1, 99999])));
  assert.throws(() => buildMaskBacking(front, Uint32Array.from(atlas.triangles), NaN));
  assert.ok(buildMaskBacking(front, Uint32Array.from(atlas.triangles), 0.225).thickness > back.thickness, 'una imagen propia más profunda no queda oculta por el cierre');
});

test('zonas autoradas: regiones, trayectos, lados y fuera de imagen', () => {
  assert.match(anatomicalZoneAt(ANATOMICAL_ZONES.muscle, 0.5, 0.50), /Prócer/);
  assert.match(anatomicalZoneAt(ANATOMICAL_ZONES.muscle, 0.31, 0.25), /derecho/);
  assert.match(anatomicalZoneAt(ANATOMICAL_ZONES.muscle, 0.69, 0.25), /izquierdo/);
  assert.match(anatomicalZoneAt(ANATOMICAL_ZONES.vessels, 0.25, 0.755), /facial/);
  assert.match(anatomicalZoneAt(ANATOMICAL_ZONES.bone, 0.5, 0.46), /nasales/);
  for (const [u, v] of [[-0.01, 0.5], [NaN, 0.5], [0.1, 2], [0.01, 0.01]]) assert.equal(anatomicalZoneAt(ANATOMICAL_ZONES.muscle, u, v), null);
  for (const zones of Object.values(ANATOMICAL_ZONES)) {
    assert.equal(new Set(zones.map(zone => zone.label)).size, zones.length);
    assert.ok(zones.every(zone => zone.points.every(point => point.every(v => v >= 0 && v <= 1))));
  }
});
