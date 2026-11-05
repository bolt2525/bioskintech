import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSkinAppearance, skinVisualCandidates } from '../src/lab/faceSim/skinAppearance.ts';
import { createSkinSignalMask } from '../src/lab/faceSim/skinSignalTexture.ts';
import fixture from './fixtures/face-sim-mediapipe-synthetic.json' with { type: 'json' };
import { replaceSkinFocusCandidates } from '../src/lab/faceSim/skinMultiView.ts';

test('siete categorías visuales independientes y extracción legacy intacta', () => {
  const width = 128, height = 128, mask = new Uint8Array(width * height).fill(1);
  const layer = () => ({ status: 'highlighted', coverage: .01, rgba: new Uint8ClampedArray(width * height * 4) });
  const result = { usable: true, channels: { contrast: layer(), redness: layer(), texture: layer(), shine: layer() },
    candidates: { poreCandidates: layer(), redDots: layer() } };
  for (const [i, channel] of ['redness', 'texture', 'shine', 'poreCandidates', 'redDots'].entries()) {
    const target = result.channels[channel] ?? result.candidates[channel];
    for (let y = 16; y < 20; y++) for (let x = 12 + i * 20; x < 16 + i * 20; x++) target.rgba[(y * width + x) * 4 + 3] = 180;
  }
  for (let y = 40; y < 45; y++) for (let x = 20; x < 25; x++) result.channels.contrast.rgba[(y * width + x) * 4 + 3] = 180;
  for (let y = 60; y < 63; y++) for (let x = 30; x < 54; x++) result.channels.contrast.rgba[(y * width + x) * 4 + 3] = 180;
  const expanded = skinVisualCandidates(result, mask, width, height, true);
  assert.deepEqual(new Set(expanded.map(candidate => candidate.channel)), new Set(['contrast', 'redness', 'texture', 'shine', 'poreCandidates', 'redDots', 'lines']));
  assert.ok(expanded.length <= 56);
  assert.ok(expanded.every(candidate => candidate.id.includes('128x128')));
  assert.ok(skinVisualCandidates(result, mask, width, height).every(candidate => ['contrast', 'redness', 'texture'].includes(candidate.channel)));
  assert.deepEqual(expanded, skinVisualCandidates(result, mask, width, height, true));
});

test('búsqueda dirigida conserva exterior, sustituye interior y limita acumulación sin mutar resultados', () => {
  const a = { id: 'outside', x: .1, y: .1, width: .02, height: .02 };
  const b = { id: 'inside', x: .5, y: .5, width: .02, height: .02 };
  const rectangle = [{ x: .4, y: .4 }, { x: .6, y: .4 }, { x: .6, y: .6 }, { x: .4, y: .6 }];
  const previous = [a, b], next = [{ ...b, id: 'new' }];
  assert.deepEqual(replaceSkinFocusCandidates(previous, next, rectangle), { outside: [a], candidates: [a, next[0]] });
  assert.deepEqual(previous, [a, b]);
  assert.throws(() => replaceSkinFocusCandidates(Array(112).fill(a), next, rectangle), /límite/);
});

test('alta resolución dirigida conserva límites de calidad y no inventa señal en piel uniforme', () => {
  const width = 512, height = 512, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([180, 130, 110, 255], i * 4);
  const mask = new Uint8Array(width * height).fill(1);
  const result = analyzeSkinAppearance({ width, height, data }, mask);
  assert.deepEqual(skinVisualCandidates(result, mask, width, height, true), []);
  assert.throws(() => skinVisualCandidates(result, mask, width, height), RangeError);
  assert.throws(() => skinVisualCandidates(result, mask, 769, height, true), RangeError);
});

test('ROI automático protege cejas completas además de ojos y labios', () => {
  const landmarks = fixture.landmarks.map(([x, y]) => ({ x, y }));
  const width = 384, height = 384, mask = createSkinSignalMask(width, height, landmarks);
  for (const id of [70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 336, 296, 334, 293, 300, 276, 283, 282, 295, 285]) {
    const p = landmarks[id], x = Math.floor(p.x * width), y = Math.floor(p.y * height);
    assert.equal(mask[y * width + x], 0);
  }
});
