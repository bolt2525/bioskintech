import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateSkinLesions, SKIN_LESION_CATEGORIES, skinBoxIoU } from '../src/lab/faceSim/skinLesionEvaluation.ts';

const box = category => ({ category, x: .2, y: .2, width: .1, height: .1 });
const references = () => ({ version: 1, trainingGroups: ['train-1'], images: [
  { id: 'img-1', group: 'test-1', boxes: [box('acne')] }, { id: 'img-2', group: 'test-2', boxes: [] },
] });
const predictions = () => ({ version: 1, model: 'synthetic-only', images: [
  { id: 'img-1', boxes: [{ ...box('acne'), score: .9 }] }, { id: 'img-2', boxes: [] },
] });
const acne = result => result.classes.find(item => item.category === 'acne');

test('categorías solicitadas presentes; evaluación exacta conjunta no inventa soporte de otras clases', () => {
  const result = evaluateSkinLesions(references(), predictions());
  assert.equal(result.images, 2); assert.equal(result.groups, 2);
  assert.deepEqual(acne(result), { category: 'acne', referenceCount: 1, predictionCount: 1, truePositive: 1, falsePositive: 0,
    falseNegative: 0, precision: 1, recall: 1, observedAbove70: true });
  assert.equal(result.classes.length, 8);
  for (const category of Object.keys(SKIN_LESION_CATEGORIES).filter(category => category !== 'acne')) {
    const item = result.classes.find(item => item.category === category);
    assert.equal(item.precision, null); assert.equal(item.recall, null); assert.equal(item.observedAbove70, false);
  }
  assert.match(result.scope, /Sin mAP/); assert.match(result.scope, /validación clínica/);
});

test('no confunde clase correcta con localización correcta; duplicados y piel sana suman falsos positivos', () => {
  const wrongClass = predictions(); wrongClass.images[0].boxes[0].category = 'nevus';
  const wrong = evaluateSkinLesions(references(), wrongClass);
  assert.equal(acne(wrong).falseNegative, 1); assert.equal(wrong.classes.find(item => item.category === 'nevus').falsePositive, 1);
  const duplicate = predictions();
  duplicate.images[0].boxes.push({ ...box('acne'), score: .8 });
  duplicate.images[1].boxes.push({ ...box('acne'), score: .9 });
  const result = acne(evaluateSkinLesions(references(), duplicate));
  assert.equal(result.truePositive, 1); assert.equal(result.falsePositive, 2); assert.equal(result.precision, 1 / 3);
  const shifted = predictions(); shifted.images[0].boxes[0].x = .7;
  const miss = acne(evaluateSkinLesions(references(), shifted));
  assert.equal(miss.falsePositive, 1); assert.equal(miss.falseNegative, 1); assert.equal(miss.observedAbove70, false);
});

test('ausencias y abstenciones se cuentan como omisiones, no como aciertos', () => {
  const absent = predictions(); absent.images[0].boxes = [];
  const result = acne(evaluateSkinLesions(references(), absent));
  assert.equal(result.precision, null); assert.equal(result.recall, 0); assert.equal(result.falseNegative, 1);
  const healthy = references(); healthy.images[0].boxes = [];
  const noBoxes = predictions(); noBoxes.images[0].boxes = [];
  assert.ok(evaluateSkinLesions(healthy, noBoxes).classes.every(item => !item.observedAbove70));
});

test('IoU y umbral estricto >70% se calculan sin equiparar accuracy a detección', () => {
  assert.equal(skinBoxIoU(box('acne'), box('acne')), 1);
  assert.equal(skinBoxIoU(box('acne'), { ...box('acne'), x: .8 }), 0);
  const ref = references(), pred = predictions();
  ref.images[0].boxes = Array.from({ length: 10 }, (_, i) => ({ ...box('acne'), x: i * .09, width: .05 }));
  pred.images[0].boxes = ref.images[0].boxes.slice(0, 7).map(item => ({ ...item, score: .9 }));
  const result = acne(evaluateSkinLesions(ref, pred));
  assert.equal(result.precision, 1); assert.equal(result.recall, .7); assert.equal(result.observedAbove70, false);
});

test('rechaza fuga declarada de pacientes, imágenes omitidas y datos mal formados', () => {
  const leaked = references(); leaked.images[0].group = 'train-1';
  assert.throws(() => evaluateSkinLesions(leaked, predictions()), /compartidos/);
  const omitted = predictions(); omitted.images.pop();
  assert.throws(() => evaluateSkinLesions(references(), omitted), /mismas imágenes/);
  const repeated = references(); repeated.images.push(repeated.images[0]);
  assert.throws(() => evaluateSkinLesions(repeated, predictions()), /repiten/);
  for (const bad of [NaN, Infinity, -1, 1.1]) {
    const input = predictions(); input.images[0].boxes[0].score = bad;
    assert.throws(() => evaluateSkinLesions(references(), input), /Predicciones inválidas/);
  }
  const invalid = references(); invalid.images[0].boxes[0].category = 'redDots';
  assert.throws(() => evaluateSkinLesions(invalid, predictions()), /Referencias inválidas/);
  const outside = predictions(); outside.images[0].boxes[0].width = 2;
  assert.throws(() => evaluateSkinLesions(references(), outside), /Predicciones inválidas/);
});

test('informe agregado no incluye IDs, grupos concretos ni imágenes; declara independencia desconocida', () => {
  const ref = references(); ref.trainingGroups = [];
  const result = evaluateSkinLesions(ref, predictions()), serialized = JSON.stringify(result);
  assert.match(result.independence, /no verificada/);
  for (const secret of ['img-1', 'test-1', 'train-1']) assert.ok(!serialized.includes(secret));
});

test('CLI real devuelve JSON, ayuda y errores explícitos sin red ni fotos', async () => {
  const script = fileURLToPath(new URL('../scripts/evaluate-skin-lesions.mjs', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'bioskin-skin-eval-'));
  const ref = join(directory, 'references.json'), pred = join(directory, 'predictions.json');
  try {
    await writeFile(ref, JSON.stringify(references())); await writeFile(pred, JSON.stringify(predictions()));
    const output = execFileSync(process.execPath, [script, ref, pred], { encoding: 'utf8' });
    assert.equal(acne(JSON.parse(output)).truePositive, 1);
    assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /sin fotos, red/);
    await writeFile(pred, '{not-json');
    const invalid = spawnSync(process.execPath, [script, ref, pred], { encoding: 'utf8' });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /JSON válido/); assert.equal(invalid.stdout, '');
    assert.ok(!invalid.stderr.includes('{not-json'));
  } finally { await unlink(ref); await unlink(pred); await rmdir(directory); }
});
