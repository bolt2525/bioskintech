import test from 'node:test';
import assert from 'node:assert/strict';
// La historia del range se prueba también con frames WebGL en skin-marks-undo.
import { SkinEditHistory } from '../src/components/admin/ficha-clinica/components/skinEditHistory.ts';

test('un gesto de tamaño conserva un snapshot y rehace el último input exacto', () => {
  const history = new SkinEditHistory();
  const before = [{ id: 'size', box: { width: .04 }, anchor: { triangle: 1, weights: [.2, .3, .5] }, status: 'validated' }];
  const first = [{ ...before[0], box: { width: .05 }, status: 'pending' }];
  const final = [{ ...first[0], box: { width: .06 } }];
  history.push(before, first);
  history.replace(final);
  history.sync(final);
  assert.equal(history.size, 1);
  assert.deepEqual(history.undo(), before);
  assert.deepEqual(history.redo(), final);
});
import { anchorForPhoto, skinDisplayPoints } from '../src/components/admin/ficha-clinica/components/skinEvaluation.ts';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };

const surface = { positions: Float32Array.from(atlas.positions), indices: Uint32Array.from(atlas.triangles),
  uvs: new Float32Array(936), projection: { cx: .5, cy: .5, k: .1, aspect: 1 } };
const source = { id: 'frontal', confirmed: true, canvas: { width: 1200, height: 900 },
  mapping: { landmarks: Array.from({ length: 468 }, (_, i) => ({ x: .5 + atlas.positions[i * 3] * .1,
    y: .5 - atlas.positions[i * 3 + 1] * .1 })), direction: [0, 0, 1] } };
const box = { x: .45, y: .45, width: .1, height: .1 };
const original = [{ id: 'synthetic', label: 'Eritema', category: 'other', note: 'Fixture',
  sourceId: source.id, box, anchor: anchorForPhoto(box, source, surface), status: 'validated',
  reviewedAt: '2026-01-01T00:00:00Z', source: { provider: 'manual' },
  observations: [{ sourceId: 'otra', box: { ...box } }], crop: { box: { ...box }, sourceWidth: 500, sourceHeight: 600 } }];

test('deshacer restaura FaceAddress, coordenadas, área derivada, evidencia y revisión exactamente', () => {
  const history = new SkinEditHistory();
  const before = structuredClone(original), points = skinDisplayPoints(before, [source], surface);
  const after = [{ ...original[0], box: { x: .47, y: .47, width: .04, height: .04 },
    anchor: undefined, observations: undefined, status: 'pending', reviewedAt: undefined,
    source: { provider: 'edited', original: { provider: 'manual' } } }];
  history.push(original, after);
  original[0].observations[0].box.x = .1;
  history.sync(after);
  const restored = history.undo();
  assert.deepEqual(restored, before);
  assert.deepEqual(skinDisplayPoints(restored, [source], surface), points);
  assert.equal(history.size, 0); assert.equal(history.undo(), undefined);
});

test('historia acotada, restauración externa y nuevo examen no filtran cambios previos', () => {
  const history = new SkinEditHistory(3);
  let current = [];
  for (let i = 0; i < 8; i++) { const next = [{ ...original[0], label: `${i}` }]; history.push(current, next); current = next; }
  assert.equal(history.size, 3);
  assert.equal(history.undo()[0].label, '6');
  history.sync([]); assert.equal(history.size, 0);
  history.push([], current); history.clear(); assert.equal(history.undo(), undefined);
});

test('historia de revisión es independiente: cancelar no altera el examen original', () => {
  const main = new SkinEditHistory(), draft = new SkinEditHistory();
  const baseline = structuredClone(original), changed = [{ ...baseline[0], note: 'Corrección' }];
  draft.push(baseline, changed); draft.clear();
  assert.equal(main.size, 0); assert.equal(draft.size, 0); assert.notEqual(baseline[0].note, changed[0].note);
});

test('rehacer conserva eliminación/movimientos exactos y una edición nueva invalida el futuro', () => {
  const history = new SkinEditHistory(), before = structuredClone(original), removed = [];
  history.push(before, removed);
  assert.deepEqual(history.undo(), before); assert.equal(history.redoSize, 1);
  assert.deepEqual(history.redo(), []); assert.equal(history.redoSize, 0);
  assert.deepEqual(history.undo(), before);
  history.push(before, [{ ...before[0], note: 'Nueva corrección' }]);
  assert.equal(history.redo(), undefined);
  history.clear(); assert.equal(history.redoSize, 0); assert.equal(history.size, 0);
});
