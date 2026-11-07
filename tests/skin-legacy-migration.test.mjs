import test from 'node:test';
import assert from 'node:assert/strict';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import { modelPoint, locateModelPoint } from '../src/lab/faceSim/faceTransfer.ts';
import { skinAnatomicalOverlay, skinZoneAt } from '../src/components/admin/ficha-clinica/components/skinAnatomy.ts';
import { migrateLegacySkinMarks, placeUntransferredSkinMark } from '../src/components/admin/ficha-clinica/components/skinLegacyMigration.ts';
import { toPersistedSkinReview, validateEvaluationGroup } from '../src/components/admin/ficha-clinica/components/skinEvaluation.ts';
import { validateSkinVisualReview } from '../lib/modules/fichas-clinicas/physical-exam.js';

const surface = { positions: Float32Array.from(atlas.positions), indices: Uint32Array.from(atlas.triangles),
  uvs: new Float32Array(936), projection: { cx: .5, cy: .5, k: .1, aspect: 1 } };
const source = { id: 'frontal', label: 'Frontal', group: 'front', confirmed: true, canvas: { width: 1200, height: 900 },
  mapping: { landmarks: Array.from({ length: 468 }, (_, i) => ({ x: .5 + atlas.positions[i * 3] * .1,
    y: .5 - atlas.positions[i * 3 + 1] * .1 })), direction: [0, 0, 1], manual: false } };
let legacy;
for (let triangle = 0; triangle < atlas.triangles.length / 3; triangle++) {
  const position3D = modelPoint({ triangle, weights: [.2, .3, .5] });
  if (!position3D) continue;
  const mark = { id: 'original-1', is3D: true, position3D, x: 0, y: 0, category: 'Etiqueta libre', notes: 'Zona original', distribution: 'zonal' };
  if (migrateLegacySkinMarks([mark], 42, [source], surface, []).added === 1) { legacy = mark; break; }
}
assert.ok(legacy, 'Fixture con correspondencia anatómica real del atlas');

test('migra sin mutar legacy, exige revisión y reintentar no duplica identidad', () => {
  const before = structuredClone(legacy);
  const migrated = migrateLegacySkinMarks([legacy], 42, [source], surface, []);
  assert.equal(migrated.added, 1); assert.equal(migrated.skipped.length, 0);
  const mark = migrated.marks[0];
  assert.equal(mark.id, 'legacy-exam:42:original-1'); assert.equal(mark.status, 'pending');
  assert.equal(mark.label, 'Etiqueta libre'); assert.equal(mark.category, 'other');
  assert.ok(mark.anchor); assert.equal(mark.box.width, .1);
  assert.match(mark.note, /examen #42/); assert.match(mark.note, /Zona original/);
  const refs = { frontal: { id: 1, r2Key: 'clinics/fixture/records/12/photos/1.png' } };
  assert.equal(toPersistedSkinReview(migrated.marks, refs).annotations.length, 0);
  const validated = validateEvaluationGroup(migrated.marks, [mark.id]);
  const persisted = toPersistedSkinReview(validated, refs);
  assert.doesNotThrow(() => validateSkinVisualReview(persisted, { clinicId: 'fixture', recordId: 12, isOwnedPhotoKey: () => true }));
  const retry = migrateLegacySkinMarks([legacy], 42, [source], surface, validated);
  assert.equal(retry.added, 0); assert.deepEqual(retry.marks, validated); assert.deepEqual(legacy, before);
  assert.notEqual(migrateLegacySkinMarks([legacy], 43, [source], surface, []).marks[0].id, mark.id);
});

test('2D, nuca, falta de detección y foto oculta permanecen legacy con aviso explícito', () => {
  for (const [marks, photos] of [
    [[{ ...legacy, is3D: false, x: 50, y: 50 }], [source]],
    [[{ ...legacy, position3D: { x: 0, y: 0, z: -20 } }], [source]],
    [[legacy], [{ ...source, confirmed: false }]],
    [[legacy], [{ ...source, mapping: undefined }]],
    [[legacy], [{ ...source, mapping: { ...source.mapping, direction: [0, 0, -1] } }]],
  ]) {
    const result = migrateLegacySkinMarks(marks, 42, photos, surface, []);
    assert.equal(result.added, 0); assert.equal(result.skipped.length, 1); assert.ok(result.skipped[0].reason);
  }
});

test('impacto normal del visor migra sin restar un offset que nunca se aplicó', () => {
  const normal = { x: 0, y: 0, z: 1 };
  const original = { ...legacy, normal3D: normal };
  const result = migrateLegacySkinMarks([original], 42, [source], surface, []);
  assert.equal(result.added, 1, JSON.stringify(result.skipped));
  assert.equal(locateModelPoint({ ...original.position3D, z: original.position3D.z - .03 }, undefined, { normal }), null,
    'La resta incondicional anterior descarta este impacto real del GLB');
  assert.deepEqual(original.position3D, legacy.position3D);
  const offset = { ...original, position3D: { ...original.position3D, z: original.position3D.z + .03 } };
  assert.equal(migrateLegacySkinMarks([offset], 42, [source], surface, []).added, 1);
});

test('modelo y máscara comparten zonas anatómicas sin modificar su geometría', () => {
  const anchor = migrateLegacySkinMarks([legacy], 42, [source], surface, []).marks[0].anchor;
  assert.match(skinZoneAt(anchor), /Derecha|Izquierda|Central/);
  const before = Array.from(surface.positions);
  for (const overlay of [skinAnatomicalOverlay(), skinAnatomicalOverlay(surface)]) {
    assert.ok(overlay.positions.length > 0);
    assert.equal(overlay.positions.length, overlay.colors.length);
    assert.equal(overlay.positions.length / 9, overlay.labels.length);
    assert.ok(overlay.positions.every(Number.isFinite));
    assert.ok(overlay.colors.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  assert.deepEqual(Array.from(surface.positions), before);
});

test('frente dentro del atlas se traslada; frente alta fuera de mesh468 se conserva sin inventar posición', () => {
  let covered = 0;
  for (let triangle = 0; triangle < atlas.triangles.length / 3; triangle++) {
    const anchor = { triangle, weights: [.2, .3, .5] };
    if (!skinZoneAt(anchor)?.toLowerCase().includes('frente')) continue;
    const position3D = modelPoint(anchor);
    if (!position3D) continue;
    const result = migrateLegacySkinMarks([{ ...legacy, position3D }], 42, [source], surface, []);
    assert.equal(result.added, 1, JSON.stringify(result.skipped));
    covered++;
  }
  assert.ok(covered > 20);
  const vertices = Array.from({ length: atlas.surface.positions.length / 3 }, (_, i) => ({
    x: atlas.surface.positions[i * 3], y: atlas.surface.positions[i * 3 + 1], z: atlas.surface.positions[i * 3 + 2],
  }));
  const position3D = vertices.filter(p => p.y > 1.7 && Math.abs(p.x) < .3).sort((a, b) => b.z - a.z)[0];
  assert.ok(position3D);
  const high = { ...legacy, id: 'frente-alta', position3D };
  const before = structuredClone(high), result = migrateLegacySkinMarks([high], 42, [source], surface, []);
  assert.equal(result.added, 0); assert.match(result.skipped[0].reason, /fuera.*correspondencia/);
  assert.equal(result.skipped[0].original.id, high.id); assert.deepEqual(high, before);
  const valid = migrateLegacySkinMarks([legacy], 42, [source], surface, []).marks[0];
  const manual = placeUntransferredSkinMark(high, 42, valid.sourceId, valid.box, valid.anchor);
  const retry = migrateLegacySkinMarks([high], 42, [source], surface, [manual]);
  assert.equal(retry.marks.length, 1); assert.equal(retry.added, 0); assert.equal(retry.skipped.length, 0);
  assert.deepEqual(high, before);
});
