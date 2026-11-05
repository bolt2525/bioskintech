import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkinScanCandidates, planSkinScan, remapSkinScanCandidate, scanSkinRegions } from '../src/lab/faceSim/skinAutoScan.ts';

const candidate = (id, x = .2, channel = 'redDots') => ({ id, channel, x, y: .2, width: .02, height: .02 });
function pixels(width = 600, height = 600) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([180, 130, 110, 255], i * 4);
  return { width, height, data };
}
const options = () => ({ sensitivity: .5, cancelled: () => false, onProgress: () => {} });

test('plan automático cubre todos los píxeles autorizados sin depender de candidatos', () => {
  for (const [width, height] of [[128, 128], [600, 700], [1400, 1400], [300, 1400]]) {
    const mask = Uint8Array.from({ length: width * height }, (_, i) => Number(i % width > width * .15 && i % width < width * .85));
    const windows = planSkinScan(width, height, mask), covered = new Uint8Array(mask.length);
    assert.ok(windows.length > 0 && windows.length <= 16);
    for (const window of windows) {
      assert.ok(window.width <= 512 && window.height <= 512);
      assert.ok(window.x >= 0 && window.y >= 0 && window.x + window.width <= width && window.y + window.height <= height);
      for (let y = window.y; y < window.y + window.height; y++) for (let x = window.x; x < window.x + window.width; x++) covered[y * width + x] = 1;
    }
    assert.ok(mask.every((pixel, i) => !pixel || covered[i]));
  }
});

test('plan rechaza área vacía o inválida y no amplía una imagen pequeña', () => {
  assert.throws(() => planSkinScan(600, 600, new Uint8Array(600 * 600)), /64 píxeles/);
  assert.throws(() => planSkinScan(1401, 600, new Uint8Array(1401 * 600)), /1400/);
  assert.throws(() => planSkinScan(100, 100, new Uint8Array(10)), /válidas/);
  assert.deepEqual(planSkinScan(16, 16, new Uint8Array(256).fill(1)), [{ x: 0, y: 0, width: 16, height: 16 }]);
});

test('inversión de recorte conserva la posición original y rechaza coordenadas inválidas', () => {
  const original = candidate('a');
  const mapped = remapSkinScanCandidate(original, { x: 200, y: 300, width: 400, height: 500 }, 1000, 1200);
  assert.equal(mapped.x, .28); assert.equal(mapped.y, 1 / 3);
  assert.equal(mapped.width, .008); assert.equal(mapped.height, 1 / 120);
  assert.equal(original.x, .2);
  assert.throws(() => remapSkinScanCandidate({ ...original, x: NaN }, { x: 0, y: 0, width: 512, height: 512 }, 600, 600));
  assert.throws(() => remapSkinScanCandidate(original, { x: 400, y: 0, width: 512, height: 512 }, 600, 600));
});

test('deduplicación conserva canales distintos y distribuye el límite entre sectores', () => {
  const a = candidate('a'), b = { ...a, id: 'b' }, red = candidate('c', .2, 'redness');
  const merged = mergeSkinScanCandidates([[a], [b, red]]);
  assert.deepEqual(merged.candidates, [a, red]); assert.equal(merged.truncated, false);
  const many = [0, 1, 2].map(pass => Array.from({ length: 60 }, (_, i) => ({
    ...candidate(`${pass}-${i}`, (i % 20) / 20), y: pass * .25 + Math.floor(i / 20) * .05, width: .01, height: .01,
  })));
  const limited = mergeSkinScanCandidates(many);
  assert.equal(limited.truncated, true); assert.equal(limited.candidates.length, 112);
  assert.deepEqual(limited.candidates.slice(0, 3).map(item => item.id), ['0-0', '1-0', '2-0']);
});

test('exploración uniforme mide cobertura única, no inventa lesiones ni muta píxeles', async () => {
  const image = pixels(), mask = new Uint8Array(image.width * image.height).fill(1);
  const before = image.data.slice(), areaBefore = mask.slice(), progress = [];
  const result = await scanSkinRegions(image, mask, [], { ...options(), onProgress: (...value) => progress.push(value) });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.scan, { windows: 4, coverage: 1, truncated: false });
  assert.deepEqual(progress.at(-1), [4, 4]);
  assert.deepEqual(image.data, before); assert.deepEqual(mask, areaBefore);
});

test('exploración encuentra señal sintética, invierte cajas y excluye píxeles no autorizados', async () => {
  const image = pixels(), mask = new Uint8Array(image.width * image.height).fill(1);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const signal = Math.exp(-((x - 480) ** 2 + (y - 450) ** 2) / 100);
    image.data.set([180 + 45 * signal, 130 - 30 * signal, 110 - 10 * signal, 255], (y * image.width + x) * 4);
  }
  const result = await scanSkinRegions(image, mask, [], options());
  assert.ok(result.candidates.some(box => Math.abs(box.x + box.width / 2 - .8) < .02 && Math.abs(box.y + box.height / 2 - .75) < .02));
  for (let y = 400; y < 510; y++) for (let x = 430; x < 530; x++) mask[y * image.width + x] = 0;
  const excluded = await scanSkinRegions(image, mask, [], options());
  assert.equal(excluded.candidates.length, 0);
});

test('cancelar entre sectores rechaza resultados tardíos y conserva las entradas', async () => {
  const image = pixels(), mask = new Uint8Array(image.width * image.height).fill(1), baseline = [candidate('prior')];
  let cancelled = false, calls = 0;
  await assert.rejects(scanSkinRegions(image, mask, baseline, {
    ...options(), cancelled: () => cancelled, onProgress: () => { calls++; cancelled = true; },
  }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(baseline[0].id, 'prior');
  await assert.rejects(scanSkinRegions(image, mask, baseline, { ...options(), cancelled: () => true }), { name: 'AbortError' });
});

test('cobertura parcial se declara y ninguna zona utilizable produce un error explícito', async () => {
  const image = pixels(1024, 512), mask = new Uint8Array(1024 * 512).fill(1);
  for (let y = 0; y < 512; y++) for (let x = 512; x < 1024; x++) image.data.set([0, 0, 0, 255], (y * 1024 + x) * 4);
  const result = await scanSkinRegions(image, mask, [], options());
  assert.ok(result.scan.coverage > 0 && result.scan.coverage < 1);
  image.data.fill(0);
  await assert.rejects(scanSkinRegions(image, mask, [], options()), /Ninguna zona tiene calidad/);
});
