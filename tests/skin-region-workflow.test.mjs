import test from 'node:test';
import assert from 'node:assert/strict';
import { skinBrushPolygon } from '../src/lab/faceSim/skinDrawing.ts';
import { applySkinRegionRgb, createSkinReviewRegion, createSkinRegionMask, isValidSkinPolygon, skinEducationalPreset } from '../src/lab/faceSim/skinRegionReview.ts';
import { analyzeSkinAppearance } from '../src/lab/faceSim/skinAppearance.ts';

test('pincel seguro acepta toque corto y rechaza recorrido largo, límites y datos no finitos', () => {
  assert.ok(isValidSkinPolygon(skinBrushPolygon([{ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 }])));
  assert.deepEqual(skinBrushPolygon([{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }]), []);
  assert.deepEqual(skinBrushPolygon([{ x: NaN, y: 0.5 }]), []);
  assert.equal(isValidSkinPolygon(skinBrushPolygon([{ x: 0, y: 0 }])), false);
});

test('todas las etiquetas tienen combinación educativa tipada; cicatriz permite tono/uniformidad/relieve independientes', () => {
  const preset = skinEducationalPreset('Cicatriz');
  for (const key of ['attenuation', 'scarAttenuation', 'tone', 'uniformity', 'relief']) assert.notEqual(preset[key], 0);
  assert.equal(skinEducationalPreset('Textura').relief, 0);
  assert.equal(skinEducationalPreset('Otra').attenuation, 0);
  assert.equal({ ...preset, tone: 0, relief: 0 }.scarAttenuation, preset.scarAttenuation);
});

test('combinación cicatriz reduce contraste y dispersión de color ROI sin acumular ni cambiar alfa/protección', () => {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const scar = x > 53 && x < 73 && y > 36 && y < 90;
    const amount = scar ? (x % 4 < 2 ? -12 : 7) : 0;
    data.set([180 + amount, 135 + amount * 0.5, 110 + amount * 0.25, 255], (y * width + x) * 4);
  }
  const original = data.slice(), safe = new Uint8Array(width * height).fill(1);
  safe[64 * width + 64] = 0;
  const region = { ...createSkinReviewRegion('scar', [
    { x: 0.25, y: 0.2 }, { x: 0.75, y: 0.2 }, { x: 0.75, y: 0.8 }, { x: 0.25, y: 0.8 },
  ], 'Cicatriz'), verified: true, adjustments: skinEducationalPreset('Cicatriz') };
  const mask = createSkinRegionMask(width, height, region.polygon, safe);
  const after = applySkinRegionRgb({ width, height, data }, safe, [region]);
  const variance = pixels => {
    const values = [...mask.keys()].filter(i => mask[i]).map(i => pixels[i * 4] - pixels[i * 4 + 1]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  };
  assert.ok(variance(after) < variance(data));
  for (let i = 0; i < mask.length; i++) {
    assert.equal(after[i * 4 + 3], data[i * 4 + 3]);
    if (!mask[i]) assert.deepEqual(after.slice(i * 4, i * 4 + 4), data.slice(i * 4, i * 4 + 4));
  }
  assert.deepEqual(data, original);
  assert.deepEqual(applySkinRegionRgb({ width, height, data }, safe, [region]), after);
  assert.deepEqual(applySkinRegionRgb({ width, height, data }, safe, []), original);
});

test('motor reutilizado no diagnostica identidad: sombra gradual y uniforme no producen señales múltiples', () => {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const light = x / width * 12;
    data.set([160 + light, 125 + light, 105 + light, 255], (y * width + x) * 4);
  }
  const result = analyzeSkinAppearance({ width, height, data }, new Uint8Array(width * height).fill(1));
  assert.ok(result.usable);
  for (const channel of ['redness', 'contrast', 'texture']) assert.equal(result.channels[channel].coverage, 0);
});
