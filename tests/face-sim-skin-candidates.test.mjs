import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSkinAppearance, MAX_SKIN_VISUAL_CANDIDATES, skinVisualCandidates } from '../src/lab/faceSim/skinAppearance.ts';

// Exclusivamente RGB generado: no fotografías ni fixtures clínicos.
function fixture(pixel = () => [180, 130, 110], width = 128, height = width) {
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const mask = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    image.data.set([...pixel(x, y), 255], (y * width + x) * 4);
  }
  return { image, mask };
}
function detect(f, sensitivity = 0.5) {
  const result = analyzeSkinAppearance(f.image, f.mask, { sensitivity });
  return { result, boxes: skinVisualCandidates(result, f.mask, f.image.width, f.image.height) };
}
function assertBoxesInside(boxes, { image: { width, height }, mask }) {
  for (const box of boxes) {
    assert.deepEqual(Object.keys(box).sort(), ['channel', 'height', 'id', 'width', 'x', 'y']);
    assert.ok(['contrast', 'redness', 'texture'].includes(box.channel));
    assert.ok(box.width > 0 && box.height > 0);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1 && box.y + box.height <= 1);
    const left = Math.round(box.x * width), top = Math.round(box.y * height);
    const right = left + Math.round(box.width * width), bottom = top + Math.round(box.height * height);
    for (let y = top - 2; y < bottom + 2; y++) for (let x = left - 2; x < right + 2; x++) {
      assert.ok(mask[y * width + x], `caja ${box.id} fuera de máscara en ${x}, ${y}`);
    }
  }
}

test('mancha, rojez y microtextura sintéticas reutilizan sus mapas y generan cajas locales, no diagnósticos', t => {
  for (const kind of ['contrast', 'redness', 'texture']) {
    const f = fixture((x, y) => {
      const s = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / 18);
      if (kind === 'contrast') return [180 - 45 * s, 130 - 32 * s, 110 - 27 * s];
      if (kind === 'redness') return [180 + 45 * s, 130 - 30 * s, 110 - 10 * s];
      const delta = x >= 52 && x < 76 && y >= 52 && y < 76 ? ((x + y) % 2 ? 8 : -8) : 0;
      return [180 + delta, 130 + delta, 110 + delta];
    });
    const original = f.image.data.slice(), mask = f.mask.slice();
    const { result, boxes } = detect(f);
    assert.ok(result.usable);
    assert.ok(boxes.some(box => box.channel === kind), `${kind}: ${JSON.stringify(boxes)}`);
    assert.ok(boxes.length <= MAX_SKIN_VISUAL_CANDIDATES);
    for (const box of boxes) {
      assert.ok(Math.abs((box.x + box.width / 2) - 0.5) < 0.05);
      assert.ok(Math.abs((box.y + box.height / 2) - 0.5) < 0.05);
      assert.ok(box.width * box.height < 0.06);
    }
    assertBoxesInside(boxes, f);
    assert.deepEqual(f.image.data, original); assert.deepEqual(f.mask, mask);
    assert.deepEqual(detect(f).boxes, boxes);
    t.diagnostic(`${kind}: ${JSON.stringify(boxes)}`);
  }
});

test('superficie uniforme, sombra gradual, ruido leve y textura/ruido extendido no llenan la foto de cajas', () => {
  const pixels = [
    () => [180, 130, 110],
    (x, y) => {
      const gain = 0.6 + 0.3 * (x + y) / 254;
      return [180 * gain, 130 * gain, 110 * gain];
    },
    (x, y) => {
      const delta = ((x * 17 + y * 31) % 5) - 2;
      return [180 + delta, 130 + delta, 110 + delta];
    },
    (x, y) => {
      const delta = (x + y) % 2 ? 8 : -8;
      return [180 + delta, 130 + delta, 110 + delta];
    },
  ];
  for (const pixel of pixels) for (const sensitivity of [0, 0.5, 1]) {
    assert.deepEqual(detect(fixture(pixel), sensitivity).boxes, []);
  }
});

test('sensibilidad ajusta la señal, sin mutar mapas; mala calidad no genera candidatos', () => {
  const f = fixture((x, y) => {
    const s = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / 18);
    return [180 + 25 * s, 130 - 15 * s, 110 - 5 * s];
  });
  const low = detect(f, 0), high = detect(f, 1);
  assert.ok(high.result.channels.redness.threshold < low.result.channels.redness.threshold);
  assert.ok(high.boxes.some(box => box.channel === 'redness'));
  const before = structuredClone(high.result);
  skinVisualCandidates(high.result, f.mask, 128, 128);
  assert.deepEqual(high.result, before);
  const dark = detect(fixture(() => [10, 7, 5]));
  assert.equal(dark.result.usable, false); assert.deepEqual(dark.boxes, []);
});

function paintMap(result, width, channel, left, top, w, h) {
  const layer = result.channels[channel];
  for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) {
    layer.rgba[(y * width + x) * 4 + 3] = 100;
  }
  layer.status = 'highlighted';
  layer.highlightedPixels = layer.rgba.filter((value, i) => i % 4 === 3 && value > 0).length;
  layer.coverage = layer.highlightedPixels / (layer.rgba.length / 4);
}

test('cajas rectangulares normalizadas: borde y agujeros tipo ojos/labios se excluyen incluso si el mapa los rodea', () => {
  const f = fixture(undefined, 128, 96), result = detect(f).result;
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) {
    f.mask[y * 128 + x] = x < 8 || y < 8 || x >= 120 || y >= 88
      || (x >= 40 && x < 44 && y >= 35 && y < 39)
      || (x >= 70 && x < 80 && y >= 65 && y < 70) ? 0 : 255;
  }
  paintMap(result, 128, 'contrast', 6, 20, 6, 6); // cruza borde
  paintMap(result, 128, 'contrast', 37, 32, 10, 10); // rodea agujero
  paintMap(result, 128, 'redness', 67, 62, 16, 11); // rodea labios
  paintMap(result, 128, 'texture', 90, 40, 8, 6); // válida, no cuadrada
  const boxes = skinVisualCandidates(result, f.mask, 128, 96);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0], {
    id: 'texture:90:40:8:6', channel: 'texture', x: 90 / 128, y: 40 / 96, width: 8 / 128, height: 6 / 96,
  });
  assertBoxesInside(boxes, f);
});

test('agrupación acotada a ocho cajas por canal y 24 totales; señales extensas y líneas no se trocean', () => {
  const f = fixture(), result = detect(f).result;
  for (const [channel, startY] of [['contrast', 12], ['redness', 48], ['texture', 84]]) {
    for (let y = startY; y < startY + 36; y += 12) for (let x = 12; x < 115; x += 12) {
      paintMap(result, 128, channel, x, y, 3, 3);
    }
  }
  const boxes = skinVisualCandidates(result, f.mask, 128, 128);
  assert.equal(boxes.length, 24);
  assert.equal(new Set(boxes.map(box => box.id)).size, 24);
  assertBoxesInside(boxes, f);
  const broad = detect(f).result;
  paintMap(broad, 128, 'contrast', 24, 24, 70, 70);
  paintMap(broad, 128, 'redness', 64, 12, 3, 100);
  assert.deepEqual(skinVisualCandidates(broad, f.mask, 128, 128), []);
});

test('el mismo parche no recibe cajas duplicadas de rojez y contraste', () => {
  const f = fixture(), result = detect(f).result;
  paintMap(result, 128, 'contrast', 50, 50, 10, 10);
  paintMap(result, 128, 'redness', 50, 50, 10, 10);
  const boxes = skinVisualCandidates(result, f.mask, 128, 128);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].channel, 'redness');
});

test('validación del límite de procesamiento y shape de mapas antes de agrupar', () => {
  const f = fixture(), result = detect(f).result;
  for (const [width, height] of [[385, 128], [128, 385], [0, 1], [1.5, 2], [Infinity, 2]]) {
    assert.throws(() => skinVisualCandidates(result, f.mask, width, height), RangeError);
  }
  assert.throws(() => skinVisualCandidates(result, new Uint8Array(2), 128, 128), TypeError);
  result.channels.texture.rgba = new Uint8ClampedArray(4);
  assert.throws(() => skinVisualCandidates(result, f.mask, 128, 128), TypeError);
});
