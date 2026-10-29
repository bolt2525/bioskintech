import assert from 'node:assert/strict';
import test from 'node:test';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { buildPersonalSurface, refineDepthFromProfiles, trianglesFromEdges } from '../src/lab/faceSim/engine.ts';

// Las cuatro bandas reales de la teselación MediaPipe, de fuera hacia dentro.
const rings = [
  [[61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291], [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]],
  [[76, 184, 74, 73, 72, 11, 302, 303, 304, 408, 306], [76, 77, 90, 180, 85, 16, 315, 404, 320, 307, 306]],
  [[62, 183, 42, 41, 38, 12, 268, 271, 272, 407, 292], [62, 96, 89, 179, 86, 15, 316, 403, 319, 325, 292]],
  [[78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308], [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]],
];
const lipIds = [...new Set(rings.flat(2))];
const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
function fixture(open) {
  const truth = Array.from({ length: 468 }, (_, i) => ({
    x: ((i % 26) / 25 - 0.5) * 0.6,
    y: (Math.floor(i / 26) / 17 - 0.5) * 0.8,
    z: 0.07 * Math.cos(i * 0.17),
  }));
  truth[10].y = 0.4; truth[152].y = -0.4;
  for (let ring = 0; ring < rings.length; ring++) {
    rings[ring].forEach((row, side) => row.forEach((id, i) => {
      const t = i / 10 * Math.PI, amplitude = [0.035, 0.024, 0.012, open ? 0.012 : 0][ring];
      truth[id] = { x: -Math.cos(t) * (0.12 - ring * 0.004),
        y: -0.15 + (side ? -1 : 1) * Math.sin(t) * amplitude, z: 0.08 };
    }));
  }
  const front = { aspect: 1, pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    landmarks: truth.map(p => ({ x: 0.5 + p.x, y: 0.5 - p.y, z: -p.z * 0.7 })) };
  const profiles = [-1.1, 1.1].map(yaw => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { aspect: 1, pose: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1],
      landmarks: truth.map(p => ({ x: 0.5 + c * p.x + s * p.z, y: 0.5 - p.y, z: -(c * p.z - s * p.x) })) };
  });
  return { front, profiles };
}
const spanZ = (surface, ids) => {
  const depths = ids.map(id => surface.positions[id * 3 + 2]);
  return Math.max(...depths) - Math.min(...depths);
};

for (const open of [false, true]) {
  test(`preserveLips protege las 4 bandas: boca ${open ? 'abierta permanece abierta' : 'cerrada no adquiere láminas de perfil'}`, t => {
    const { front, profiles } = fixture(open);
    const original = structuredClone(front);
    const result = refineDepthFromProfiles(front, profiles, { preserveLips: true });
    const unrestricted = refineDepthFromProfiles(front, profiles);
    assert.equal(result.coverage, 'bilateral');
    assert.equal(result.used, 2);
    assert.equal(lipIds.length, 80);
    const baseline = buildPersonalSurface(front.landmarks, 1, triangles);
    const surface = buildPersonalSurface(result.landmarks, 1, triangles);
    // Política anterior exacta: el solver no cambia; solo se restauraban los dos contornos.
    const contoursOnly = new Set([...rings[0].flat(), ...rings[3].flat()]);
    const partial = buildPersonalSurface(unrestricted.landmarks.map((p, id) =>
      contoursOnly.has(id) ? front.landmarks[id] : p), 1, triangles);
    assert.ok(baseline && surface && partial);
    assert.ok(spanZ(partial, lipIds) > 0.05, 'reproduce las bandas entre contornos congelados');
    assert.equal(spanZ(surface, lipIds), 0);
    for (const id of lipIds) {
      assert.deepEqual(result.landmarks[id], front.landmarks[id], `banda labial, vértice ${id}`);
      assert.deepEqual(surface.positions.slice(id * 3, id * 3 + 2), baseline.positions.slice(id * 3, id * 3 + 2));
      // buildPersonalSurface recentra Z globalmente; comparar relieve relativo, no esa traslación.
      assert.ok(Math.abs((surface.positions[id * 3 + 2] - surface.positions[61 * 3 + 2])
        - (baseline.positions[id * 3 + 2] - baseline.positions[61 * 3 + 2])) < 1e-7);
    }
    for (let i = 0; i < 468; i++) {
      assert.equal(result.landmarks[i].x, front.landmarks[i].x);
      assert.equal(result.landmarks[i].y, front.landmarks[i].y);
    }
    assert.deepEqual(surface.uvs, baseline.uvs);
    assert.deepEqual(surface.indices, baseline.indices, 'sin tapas, soldadura ni eliminación de abertura');
    const gap = Math.hypot(...[0, 1, 2].map(k => surface.positions[13 * 3 + k] - surface.positions[14 * 3 + k]));
    const originalGap = Math.hypot(...[0, 1, 2].map(k => baseline.positions[13 * 3 + k] - baseline.positions[14 * 3 + k]));
    assert.equal(gap, originalGap);
    assert.ok(open ? gap > 0.1 : gap === 0);
    for (const id of [1, 4, 6, 168, 164]) assert.deepEqual(result.landmarks[id], unrestricted.landmarks[id], `nariz sin cambios ${id}`);
    assert.notEqual(result.landmarks[1].z, front.landmarks[1].z, 'los perfiles siguen aportando profundidad nasal');
    assert.deepEqual(front, original, 'sin mutación');
    t.diagnostic(`Dispersión Z sintética: política anterior (40 vértices) ${spanZ(partial, lipIds).toFixed(6)}, protección completa (80) ${spanZ(surface, lipIds).toFixed(6)}; gap ${gap.toFixed(6)} (original ${originalGap.toFixed(6)}).`);
  });
}

test('buildPersonalSurface no aplana un gap de Z que ya exista en el prior frontal', () => {
  const { front } = fixture(false);
  front.landmarks[13].z -= 0.02;
  const surface = buildPersonalSurface(front.landmarks, 1, triangles);
  assert.ok(surface);
  assert.ok(Math.abs(surface.positions[13 * 3 + 2] - surface.positions[14 * 3 + 2]) > 0.1,
    'no interpretar una coincidencia XY como permiso para borrar profundidad sin evidencia adicional');
});
