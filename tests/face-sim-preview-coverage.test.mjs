import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const file = path.resolve('src/lab/faceSim/injectablePreview.ts');
const preview = (() => {
  const exports = {};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  vm.runInNewContext(code, { exports, require: () => ({}) }, { filename: file });
  return exports;
})();

const MODES = ['toxina', 'relleno_ha', 'hidratacion', 'bioestimulador'];
const only = mode => Object.fromEntries(MODES.map(m => [m, m === mode]));
const base = (mode, extra = {}) => ({ ...preview.DEFAULT_PREVIEW, intensity: 1, enabled: only(mode), ...extra });
const SKIN = 170, SIZE = 400;
const FINE_ROW = 100, COARSE_ROWS = [200, 201, 202, 203], EDGE_X = 300, EDGE_ROWS = [300, 360];

/** Piel plana con una línea fina (1 px), una línea ancha (4 px) y un rasgo oscuro de borde marcado. */
function synthetic({ alpha = 255 } = {}) {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    let v = SKIN;
    if (y === FINE_ROW) v = 140;
    if (COARSE_ROWS.includes(y)) v = 135;
    if (y >= EDGE_ROWS[0] && y < EDGE_ROWS[1] && x >= EDGE_X) v = 40;
    const at = (y * SIZE + x) * 4;
    rgba[at] = v; rgba[at + 1] = v - 10; rgba[at + 2] = v - 20; rgba[at + 3] = alpha;
  }
  return rgba;
}
const fullMask = () => new Uint8Array(SIZE * SIZE).fill(1);
const px = (rgba, x, y) => rgba[(y * SIZE + x) * 4];
const lineContrast = (rgba, x, row) => Math.abs(px(rgba, x, row - 6) - px(rgba, x, row));
const toxinSamples = [
  { mode: 'toxina', x: 0.5, y: FINE_ROW / SIZE },
  { mode: 'toxina', x: 0.5, y: COARSE_ROWS[1] / SIZE },
];

test('API: radios base distintos por categoría, escala 0.5/2 acotada y aspecto conservado', () => {
  const s = { ...preview.DEFAULT_PREVIEW };
  const radii = MODES.map(mode => preview.previewRadius(s, mode));
  assert.deepEqual(radii, [0.065, 0.045, 0.1, 0.085]);
  assert.equal(new Set(radii).size, 4);
  for (const mode of MODES) {
    const r = preview.PREVIEW_COVERAGE_BASE[mode];
    assert.equal(preview.previewRadius({ ...s, coverage: { [mode]: 0.5 } }, mode), r * 0.5);
    assert.equal(preview.previewRadius({ ...s, coverage: { [mode]: 2 } }, mode), r * 2);
    assert.equal(preview.previewRadius({ ...s, coverage: { [mode]: 0.1 } }, mode), r * preview.MIN_COVERAGE);
    assert.equal(preview.previewRadius({ ...s, coverage: { [mode]: 99 } }, mode), r * preview.MAX_COVERAGE);
    assert.equal(preview.previewRadius({ ...s, coverage: { [mode]: Number.NaN } }, mode), r);
    assert.equal(preview.previewRadius({ ...s, coverage: undefined }, mode), r);
  }
  const fx = aspect => preview.buildIllustrativeEffects([{ mode: 'toxina', x: 0.5, y: 0.5 }], base('toxina', { coverage: { toxina: 2 } }), aspect);
  assert.ok(Math.abs(fx(2).a[2] - 0.13) < 1e-6, 'aspecto ≥ 1 no reduce el radio');
  assert.ok(Math.abs(fx(0.5).a[2] - 0.065) < 1e-6, 'aspecto < 1 conserva la corrección previa');
  for (const aspect of [0, Number.NaN, -1]) assert.ok([...fx(aspect).a].every(Number.isFinite));
});

test('uniformes: cobertura cambia el radio y la ganancia 1–1.5 sigue variando', () => {
  const sample = [{ mode: 'hidratacion', x: 0.4, y: 0.6 }];
  const at = extra => preview.buildIllustrativeEffects(sample, base('hidratacion', extra), 1).a;
  assert.ok(at({ coverage: { hidratacion: 2 } })[2] > at({ coverage: { hidratacion: 0.5 } })[2]);
  const g1 = at({ levels: { hidratacion: 1 } })[3], g12 = at({ levels: { hidratacion: 1.2 } })[3], g15 = at({ levels: { hidratacion: 1.5 } })[3];
  assert.ok(g1 < g12 && g12 < g15, `ganancias ${g1} ${g12} ${g15}`);
});

test('overlay de cobertura: solo con showCoverage, categorías activas y nivel > 0', () => {
  const samples = [{ mode: 'toxina', x: 0.2, y: 0.3 }, { mode: 'relleno_ha', x: 0.5, y: 0.5 }, { mode: 'hidratacion', x: Number.NaN, y: 0 }];
  const s = { ...preview.DEFAULT_PREVIEW, enabled: { ...preview.DEFAULT_PREVIEW.enabled, relleno_ha: false } };
  assert.deepEqual([...preview.previewCoverage(samples, s)], []);
  const areas = preview.previewCoverage(samples, { ...s, showCoverage: true, coverage: { toxina: 2 } });
  assert.equal(areas.length, 1);
  assert.deepEqual({ ...areas[0] }, { mode: 'toxina', x: 0.2, y: 0.3, radius: 0.13 });
  assert.deepEqual([...preview.previewCoverage(samples, { ...s, showCoverage: true, levels: { toxina: 0 } })], []);
});

test('toxina: atenúa línea fina y línea ancha existentes sin borrar el rasgo de borde marcado', () => {
  const rgba = synthetic(), copy = rgba.slice();
  const edgeSample = { mode: 'toxina', x: EDGE_X / SIZE, y: 330 / SIZE };
  const out = preview.previewPixels(rgba, SIZE, SIZE, [...toxinSamples, edgeSample], base('toxina'), fullMask());
  assert.deepEqual(rgba, copy, 'entrada inmutable');
  const fineBefore = lineContrast(rgba, 200, FINE_ROW), fineAfter = lineContrast(out, 200, FINE_ROW);
  const coarseBefore = lineContrast(rgba, 200, COARSE_ROWS[1]), coarseAfter = lineContrast(out, 200, COARSE_ROWS[1]);
  assert.ok(fineAfter < fineBefore * 0.6, `fina ${fineBefore}→${fineAfter}`);
  assert.ok(coarseAfter < coarseBefore * 0.8, `ancha ${coarseBefore}→${coarseAfter}`);
  assert.ok(fineAfter > 0 || coarseAfter > 0, 'no plastifica por completo');
  const edgeBefore = px(rgba, EDGE_X - 4, 330) - px(rgba, EDGE_X + 4, 330);
  const edgeAfter = px(out, EDGE_X - 4, 330) - px(out, EDGE_X + 4, 330);
  assert.ok(edgeAfter > edgeBefore * 0.85, `borde ${edgeBefore}→${edgeAfter}`);
  assert.ok(px(out, 350, 330) < 70, 'el rasgo oscuro no se aclara hacia la piel');
});

test('toxina: cobertura 0.5 vs 2 y ganancia 1 vs 1.5 cambian el alcance/fuerza', () => {
  const rgba = synthetic(), mask = fullMask();
  const offX = 200 + 40; // 0.1 de altura desde la muestra
  const contrastWith = extra => lineContrast(preview.previewPixels(rgba, SIZE, SIZE, toxinSamples, base('toxina', extra), mask), offX, FINE_ROW);
  const narrow = contrastWith({ coverage: { toxina: 0.5 } }), wide = contrastWith({ coverage: { toxina: 2 } });
  assert.equal(narrow, lineContrast(rgba, offX, FINE_ROW), 'radio 0.5 no alcanza a 0.1');
  assert.ok(wide < narrow * 0.85, `cobertura ${narrow}→${wide}`);
  const at = level => lineContrast(preview.previewPixels(rgba, SIZE, SIZE, toxinSamples, base('toxina', { levels: { toxina: level } }), mask), 200, COARSE_ROWS[1]);
  assert.ok(at(1.5) < at(1), 'ganancia 1.5 atenúa más que 1');
});

test('embellecimiento: hidratación y bioestimulador atenúan textura además de iluminar; toxina no aclara piel plana', () => {
  const rgba = synthetic(), mask = fullMask(), samples = [{ x: 0.5, y: FINE_ROW / SIZE }];
  for (const mode of ['hidratacion', 'bioestimulador']) {
    const render = level => preview.previewPixels(rgba, SIZE, SIZE, samples.map(p => ({ ...p, mode })),
      base(mode, { levels: { [mode]: level } }), mask);
    const before = lineContrast(rgba, 200, FINE_ROW), result = render(1.5);
    assert.ok(lineContrast(result, 200, FINE_ROW) < before * 0.75, `${mode}: contraste se reduce ≥ 25 %, no solo brillo`);
    assert.ok(px(result, 200, FINE_ROW - 6) > px(rgba, 200, FINE_ROW - 6), `${mode}: luminosidad local`);
    assert.ok(lineContrast(result, 200, FINE_ROW) < lineContrast(render(0.5), 200, FINE_ROW), 'intensidad gradual');
    assert.deepEqual(render(0), rgba, 'cero restaura');
    assert.deepEqual(result.slice(0, 4), rgba.slice(0, 4), 'fuera de cobertura intacto');
  }
  const flat = new Uint8ClampedArray(SIZE * SIZE * 4).fill(170);
  assert.deepEqual(preview.previewPixels(flat, SIZE, SIZE, [{ mode: 'toxina', x: 0.5, y: 0.5 }], base('toxina'), mask), flat);
});

test('máscara: fuera intacto, alpha conservado y sin promediar ojos/labios excluidos hacia la piel', () => {
  const rgba = synthetic({ alpha: 77 }), mask = fullMask();
  // "Ojo" oscuro excluido de la máscara en mitad de piel plana.
  for (let y = 150; y < 170; y++) for (let x = 150; x < 250; x++) {
    const at = (y * SIZE + x) * 4; rgba[at] = rgba[at + 1] = rgba[at + 2] = 20; mask[y * SIZE + x] = 0;
  }
  const samples = MODES.map(mode => ({ mode, x: 0.5, y: 160 / SIZE }));
  const s = { ...preview.DEFAULT_PREVIEW, intensity: 1, levels: { hidratacion: 0, relleno_ha: 0, bioestimulador: 1, toxina: 1.5 }, coverage: { toxina: 2, bioestimulador: 2 } };
  const out = preview.previewPixels(rgba, SIZE, SIZE, samples, s, mask);
  for (let i = 0; i < SIZE * SIZE; i++) {
    assert.equal(out[i * 4 + 3], 77);
    if (!mask[i]) for (let c = 0; c < 3; c++) assert.equal(out[i * 4 + c], rgba[i * 4 + c]);
  }
  const toxOnly = preview.previewPixels(rgba, SIZE, SIZE, samples, { ...s, levels: { ...s.levels, bioestimulador: 0 } }, mask);
  for (const [x, y] of [[200, 149], [200, 170], [149, 160], [250, 160], [200, 146]]) {
    for (let c = 0; c < 3; c++) {
      const at = (y * SIZE + x) * 4 + c;
      assert.equal(toxOnly[at], rgba[at], `piel plana junto al ojo ${x},${y}`);
      assert.ok(out[at] >= rgba[at], `bioestimulador no oscurece hacia el ojo ${x},${y}`);
    }
  }
});

test('controles sin efecto devuelven copia exacta: antes, 0, intensidad, deshabilitado', () => {
  const rgba = synthetic(), mask = fullMask();
  const samples = MODES.map(mode => ({ mode, x: 0.5, y: FINE_ROW / SIZE }));
  const all = { ...preview.DEFAULT_PREVIEW, intensity: 1 };
  const cases = [
    { ...all, after: false },
    { ...all, intensity: 0 },
    { ...all, intensity: Number.NaN },
    { ...all, enabled: only('ninguno') },
    { ...all, levels: { toxina: 0, relleno_ha: 0, hidratacion: 0, bioestimulador: 0 } },
    { ...all, after: false, showCoverage: true, coverage: { toxina: 2 } },
  ];
  for (const s of cases) {
    const out = preview.previewPixels(rgba, SIZE, SIZE, samples, s, mask);
    assert.notEqual(out, rgba);
    assert.deepEqual(out, rgba);
  }
  const on = preview.previewPixels(rgba, SIZE, SIZE, samples, all, mask);
  assert.deepEqual(preview.previewPixels(rgba, SIZE, SIZE, samples, { ...all, showCoverage: true }, mask), on, 'showCoverage no pinta píxeles');
  assert.deepEqual(preview.previewPixels(rgba, SIZE, SIZE, samples, all, new Uint8Array(SIZE * SIZE)), rgba, 'máscara vacía');
});

test('caché: reutilizar el mismo buffer es estable y una mutación invalida la base', () => {
  const rgba = synthetic(), mask = fullMask(), s = base('toxina');
  const first = preview.previewPixels(rgba, SIZE, SIZE, toxinSamples, s, mask);
  assert.deepEqual(preview.previewPixels(rgba, SIZE, SIZE, toxinSamples, s, mask), first);
  for (let x = 0; x < SIZE; x++) rgba.fill(SKIN, (FINE_ROW * SIZE + x) * 4, (FINE_ROW * SIZE + x) * 4 + 1);
  const fresh = preview.previewPixels(rgba.slice(), SIZE, SIZE, toxinSamples, s, mask);
  assert.deepEqual(preview.previewPixels(rgba, SIZE, SIZE, toxinSamples, s, mask), fresh);
});

test('límites: tamaños mínimos, radios extremos y entradas no finitas producen valores finitos acotados', () => {
  for (const [w, h] of [[1, 1], [1, 7], [9, 1], [3, 2]]) {
    const rgba = new Uint8ClampedArray(w * h * 4).fill(120);
    for (const coverage of [0.5, 2, Number.NaN, Infinity]) for (const mode of MODES) {
      const s = base(mode, { coverage: { [mode]: coverage }, levels: { [mode]: 1.5 } });
      const out = preview.previewPixels(rgba, w, h, [{ mode, x: 0, y: 0 }, { mode, x: Number.NaN, y: 1 }], s, new Uint8Array(w * h).fill(1));
      assert.equal(out.length, rgba.length);
      for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i] - rgba[i]) <= 40, `${w}x${h} ${mode} ${coverage}`);
    }
  }
  const rgba = new Uint8ClampedArray(16).fill(100);
  for (const [w, h] of [[0, 4], [-2, -2], [2.5, 1], [Number.NaN, 2], [8, 8]]) {
    assert.deepEqual(preview.previewPixels(rgba, w, h, [{ mode: 'toxina', x: 0, y: 0 }], base('toxina'), new Uint8Array(4).fill(1)), rgba);
  }
  const short = preview.previewPixels(new Uint8ClampedArray(16).fill(100), 2, 2, [{ mode: 'hidratacion', x: 0, y: 0 }], base('hidratacion'), new Uint8Array(1).fill(1));
  assert.deepEqual([...short.slice(4)], new Array(12).fill(100), 'máscara corta: el resto queda fuera');
});

test('superficie: roles preservados, cobertura y ganancia afectan, buffers inmutables', () => {
  const positions = new Float32Array([0, 0, 0, 0, 0, 0]), uvs = new Float32Array([0.5, 0.5, 0.6, 0.5]);
  const rgb = new Float32Array([0.8, 0.6, 0.5, 0.8, 0.6, 0.5]), copy = rgb.slice();
  const sample = mode => [{ mode, x: 0.5, y: 0.5 }];
  const tox = preview.previewSurface(positions, uvs, sample('toxina'), base('toxina'), 1, rgb);
  assert.deepEqual(tox.positions, positions, 'toxina sin geometría');
  assert.ok(tox.rgb[0] < rgb[0]);
  assert.deepEqual(preview.previewSurface(positions, uvs, sample('hidratacion'), base('hidratacion'), 1, rgb).positions, positions);
  const far = coverage => preview.previewSurface(positions, uvs, sample('relleno_ha'), base('relleno_ha', { coverage: { relleno_ha: coverage } }), 1).positions[5];
  assert.ok(far(2) > far(0.5) * 10, 'cobertura amplía el alcance del relieve');
  const z = level => preview.previewSurface(positions, uvs, sample('relleno_ha'), base('relleno_ha', { levels: { relleno_ha: level } }), 1).positions[2];
  assert.ok(z(1.5) > z(1.2) && z(1.2) > z(1));
  assert.deepEqual(rgb, copy);
  assert.deepEqual([...positions], [0, 0, 0, 0, 0, 0]);
  const weird = preview.previewSurface(positions, new Float32Array(2), sample('relleno_ha'), base('relleno_ha'), Number.NaN, rgb);
  assert.ok([...weird.positions, ...weird.rgb].every(Number.isFinite), 'uv corto y aspecto no finito');
});

test('relleno: relieve visible relativo al rostro, independiente de escala y sin desplazar XY', () => {
  // Plano oblicuo de altura facial 5: un cambio distinto de cero no basta para ser perceptible.
  const positions = new Float32Array([-2.5, -2.5, 2.5, 2.5, -2.5, -2.5, 0, 2.5, 0, 0, 0, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 0.5, 0, 0.5, 0.5]);
  const samples = [{ mode: 'relleno_ha', x: 0.5, y: 0.5 }];
  const settings = base('relleno_ha', { intensity: 0.6, levels: { relleno_ha: 1.5 } });
  const result = preview.previewSurface(positions, uvs, samples, settings, 1, undefined, 4).positions;
  const distance = Math.hypot(...[0, 1, 2].map(k => result[9 + k] - positions[9 + k]));
  assert.ok(distance >= 5 * 0.015, `relieve ${distance}: mínimo ilustrativo 1,5 % de altura`);
  assert.ok(distance <= 5 * 0.03, 'sin picos mayores al 3 %');
  for (let i = 0; i < positions.length; i++) if (i % 3 !== 2) assert.equal(result[i], positions[i], 'XY intacto');
  const scaled = preview.previewSurface(Float32Array.from(positions, v => v * 10), uvs,
    samples, settings, 1, undefined, 4).positions;
  for (let i = 0; i < result.length; i++) assert.ok(Math.abs(result[i] * 10 - scaled[i]) < 1e-5, 'escala equivarante');
  assert.deepEqual(preview.previewSurface(positions, uvs, samples, { ...settings, after: false }, 1, undefined, 4).positions, positions);
  assert.deepEqual(preview.previewSurface(positions, uvs, samples, { ...settings, levels: { relleno_ha: 0 } }, 1, undefined, 4).positions, positions);
  const limited = preview.previewSurface(positions, uvs, samples, settings, 1, undefined, 3).positions;
  assert.deepEqual(limited.slice(9), positions.slice(9), 'fuera de superficie observada intacto');
});