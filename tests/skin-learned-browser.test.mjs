import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SKIN_MODEL, prepareSkinTensor, cropSkinProbability, skinLetterboxGeometry } from '../src/lab/faceSim/skinLearnedImage.ts';
import { SkinLearnedClient } from '../src/lab/faceSim/skinLearnedClient.ts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/skin-learned-pil.json', import.meta.url), 'utf8'));
for (const item of fixtures.cases) {
  test(`preprocesamiento frente a PIL: ${item.width}x${item.height} → ${item.size}`, () => {
    const data = new Uint8ClampedArray(item.width * item.height * 4);
    for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) {
      data.set([0, 1, 2].map(channel => (x * 37 + y * 13 + channel * 73) % 256).concat(255), (y * item.width + x) * 4);
    }
    const { input, geometry } = prepareSkinTensor({ width: item.width, height: item.height, data }, item.size);
    assert.deepEqual(geometry, item.geometry);
    const expected = Buffer.from(item.rgb, 'base64');
    let maximum = 0;
    for (let i = 0; i < item.size * item.size; i++) for (let channel = 0; channel < 3; channel++) {
      const value = Math.fround(Math.fround(expected[i * 3 + channel] / 127.5) - 1);
      maximum = Math.max(maximum, Math.abs(input[channel * item.size * item.size + i] - value));
    }
    assert.equal(maximum, 0, 'la normalización debe coincidir con PIL/PyTorch');
  });
}

test('geometría rechaza datos inválidos antes de reservar canvas y respeta round-to-even', () => {
  assert.deepEqual(skinLetterboxGeometry(3, 12, 10), { w: 2, h: 10, x: 4, y: 0 });
  for (const values of [[0, 2], [8193, 2], [5000, 5000], [1.5, 2], [NaN, 2]]) {
    assert.throws(() => skinLetterboxGeometry(...values));
  }
  assert.throws(() => prepareSkinTensor({ width: 10, height: 10, data: new Uint8ClampedArray(4) }));
});

test('el padding no aparece en la probabilidad trasladada a la foto', () => {
  const probability = new Float32Array(100).fill(.25);
  for (let y = 0; y < 10; y++) for (let x = 4; x < 6; x++) probability[y * 10 + x] = .75;
  const result = cropSkinProbability(probability, 3, 12, 10);
  assert.equal(result.width, 2); assert.equal(result.height, 10);
  assert.ok(result.probability.every(value => value === .75));
  probability[0] = NaN;
  assert.throws(() => cropSkinProbability(probability, 3, 12, 10));
  assert.throws(() => cropSkinProbability(new Float32Array(10), 3, 12, 10));
});

test('el activo distribuido es exactamente el modelo congelado', () => {
  const model = readFileSync(new URL('../public' + SKIN_MODEL.url, import.meta.url));
  assert.equal(model.length, SKIN_MODEL.bytes);
  assert.equal(createHash('sha256').update(model).digest('hex'), SKIN_MODEL.sha256);
  const sources = JSON.parse(readFileSync(new URL('../public/models/skin/SOURCES.json', import.meta.url)));
  assert.equal(sources.eligibleForClinicalUse, false);
  assert.equal(sources.sha256, SKIN_MODEL.sha256);
});

test('cliente: progreso, exclusión mutua, cancelación y resultados tardíos', async () => {
  const keys = ['Worker', 'OffscreenCanvas', 'createImageBitmap'];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const workers = [];
  class FakeWorker {
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  try {
    globalThis.Worker = FakeWorker; globalThis.OffscreenCanvas = class {}; globalThis.createImageBitmap = () => {};
    const client = new SkinLearnedClient(), statuses = [], image = { close() { this.closed = true; } };
    const pending = client.analyze(image, message => statuses.push(message));
    workers[0].onmessage({ data: { kind: 'progress', message: 'Preparando' } });
    const second = { close() { this.closed = true; } };
    await assert.rejects(client.analyze(second, () => {}), /procesando/);
    assert.equal(second.closed, true);
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    client.dispose(); await rejected;
    workers[0].onmessage({ data: { kind: 'progress', message: 'Tardío' } });
    assert.equal(workers[0].terminated, true);
    assert.deepEqual(statuses, ['Preparando']);
    await assert.rejects(client.analyze(image, () => {}), /disponible/);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]);
      else delete globalThis[key];
    });
  }
});
