import test from 'node:test';
import assert from 'node:assert/strict';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import { COLORS } from '../src/constants/theme.ts';
import {
  anchorForPhoto, bestPhotoForAnchor, cropToOriginal, fromPersistedSkinReview,
  photoForAnchor, skinRequestContext, skinReviewSummaries, toPersistedSkinReview, validateEvaluationGroup,
  isZonalSkinMark, resizeSkinBox, skinDisplayPoints, visibleSkinTriangles,
} from '../src/components/admin/ficha-clinica/components/skinEvaluation.ts';

const ref = { id: 5, r2Key: 'clinics/1/records/2/photos/5.jpg' };
const mark = { id: 'm1', sourceId: 'frontal', category: 'other', label: 'Lesión',
  note: '', box: { x: .1, y: .2, width: .3, height: .4 }, status: 'pending', source: { provider: 'manual' } };
const surface = { positions: Float32Array.from(atlas.positions), indices: Uint32Array.from(atlas.triangles),
  uvs: new Float32Array(atlas.positions.length / 3 * 2), projection: { cx: 0, cy: 0, k: 1, aspect: 1 } };
const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: .5 + atlas.positions[i * 3] * .1, y: .5 - atlas.positions[i * 3 + 1] * .1 }));
const source = { id: 'frontal', label: 'Frontal', group: 'front', confirmed: true,
  canvas: { width: 1200, height: 900 }, mapping: { landmarks, direction: [0, 0, 1], manual: false } };

test('recorte y región se transforman a coordenadas de la fotografía original', () => {
  const result = cropToOriginal({ x: .2, y: .4, width: .3, height: .2 }, { x: .1, y: .2, width: .5, height: .5 });
  assert.ok(Math.abs(result.x - .2) < 1e-10);
  assert.ok(Math.abs(result.y - .4) < 1e-10);
  assert.ok(Math.abs(result.width - .15) < 1e-10);
  assert.throws(() => cropToOriginal({ ...mark.box, x: -1 }, mark.box));
});

test('el contexto vacío no se envía y se respetan las restricciones del servidor', () => {
  assert.deepEqual(skinRequestContext({ skinType: '', phototype: ' II ', hydration: '  ' }), { phototype: 'II' });
  assert.throws(() => skinRequestContext({ skinType: 'texto; inválido' }), /contexto/);
});

test('solo grupo seleccionado se valida y solo con foto durable se exporta', () => {
  const validated = validateEvaluationGroup([mark, { ...mark, id: 'm2' }], ['m1'], '2026-01-01T00:00:00.000Z');
  assert.deepEqual(validated.map(m => m.status), ['validated', 'pending']);
  assert.throws(() => toPersistedSkinReview(validated, {}), /foto durable/);
  const result = toPersistedSkinReview(validated, { frontal: ref });
  assert.equal(result.annotations.length, 1);
  assert.deepEqual(fromPersistedSkinReview(JSON.stringify(result), { frontal: ref }), [validated[0]]);
  assert.throws(() => validateEvaluationGroup([{ ...mark, label: '' }], ['m1']));
  const edited = { ...validated[0], source: { provider: 'edited', original: { provider: 'manual' } } };
  assert.deepEqual(fromPersistedSkinReview(toPersistedSkinReview([edited], { frontal: ref }), { frontal: ref }), [edited]);
  const withCrop = { ...edited, crop: { box: { x: .1, y: .1, width: .5, height: .5 }, sourceWidth: 3200, sourceHeight: 2400 } };
  const exported = toPersistedSkinReview([withCrop], { frontal: ref });
  assert.deepEqual(fromPersistedSkinReview(exported, { frontal: ref }), [withCrop]);
  assert.equal(skinReviewSummaries(exported)[0].description, 'Lesión · Foto clínica #5');
  assert.deepEqual(skinReviewSummaries('invalido'), []);
});

test('no proyecta fotos sin correspondencia o con cara oculta', () => {
  const box = { x: .48, y: .48, width: .04, height: .04 };
  assert.equal(anchorForPhoto(box, { ...source, mapping: undefined }, surface), undefined);
  assert.equal(anchorForPhoto(box, { ...source, confirmed: false }, surface), undefined);
  const hidden = { ...source, mapping: { ...source.mapping, direction: [0, 0, -1] } };
  const anchor = anchorForPhoto(box, source, surface);
  assert.ok(anchor);
  assert.ok(photoForAnchor(anchor, source, surface));
  assert.equal(photoForAnchor(anchor, hidden, surface), null);
  assert.equal(bestPhotoForAnchor(anchor, [hidden, source], surface)?.id, 'frontal');
});

test('puntos y zonas se redimensionan sin salir de la foto ni perder su identidad al guardar', () => {
  const point = resizeSkinBox({ x: .97, y: .97, width: .02, height: .02 }, .14);
  assert.ok(point.x + point.width <= 1 && point.y + point.height <= 1);
  assert.equal(isZonalSkinMark(point), true);
  assert.equal(isZonalSkinMark(resizeSkinBox(point, .04)), false);
  const zonal = { ...mark, box: point };
  const restored = fromPersistedSkinReview(toPersistedSkinReview(validateEvaluationGroup([zonal], [zonal.id]), { frontal: ref }), { frontal: ref });
  assert.equal(restored[0].id, zonal.id);
  assert.deepEqual(restored[0].box, point);
});

test('proyección de puntos y áreas es derivada, conserva identidades y reutiliza cobertura', () => {
  const box = { x: .45, y: .45, width: .1, height: .1 };
  const anchor = anchorForPhoto(box, source, surface);
  assert.ok(anchor);
  const marks = [{ ...mark, box, anchor }];
  const before = structuredClone(marks);
  const mask = skinDisplayPoints(marks, [source], surface);
  const generic = skinDisplayPoints(marks, [source], surface, 'reference');
  assert.equal(mask.length, 1);
  assert.equal(generic.length, 1);
  assert.equal(mask[0].id, generic[0].id);
  assert.equal(mask[0].color, COLORS.skinPending);
  assert.equal(mask[0].color, generic[0].color);
  assert.equal(mask[0].name, mark.label, 'El estado se explica por color y leyenda, no se repite en cada etiqueta');
  const validated = skinDisplayPoints([{ ...marks[0], status: 'validated' }], [source], surface);
  assert.equal(validated[0].color, COLORS.skinValidated);
  assert.equal(validated[0].name, mark.label);
  assert.ok(mask[0].area?.radius > 0);
  assert.ok(generic[0].area?.radius > 0);
  assert.ok(Math.abs(Math.hypot(...Object.values(mask[0].area.normal)) - 1) < 1e-8);
  assert.deepEqual(marks, before, 'Proyectar no modifica el registro');
  assert.deepEqual(skinDisplayPoints([{ ...mark }], [source], surface), [], 'Sin anclaje permanece 2D');
  assert.equal(visibleSkinTriangles(source, surface), visibleSkinTriangles(source, surface));
});
