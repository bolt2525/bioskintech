import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve('src/lab/faceSim'), cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
  const exports = {};
  cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports, console, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
    require(name) {
      if (!name.startsWith('.')) return require(name);
      const base = path.resolve(path.dirname(file), name);
      const target = [base, `${base}.ts`].find(p => existsSync(p));
      if (!target) throw new Error(`Missing ${base}`);
      return load(target);
    },
  }, { filename: file });
  return exports;
}
const model = load(path.join(root, 'markingModel.ts'));
const atlas = load(path.join(root, 'genericFaceAtlas.json'));

// Dirección baricéntrica centrada en un landmark del atlas (234 = mejilla derecha del paciente, 454 = izquierda).
const at = landmark => {
  const t = atlas.triangles.indexOf(landmark);
  const triangle = Math.floor(t / 3), weights = [0, 0, 0];
  weights[t % 3] = 1;
  return { triangle, weights };
};
const binding = landmark => ({ kind: 'point', paths: [[at(landmark)]], center: at(landmark) });
const meta = {
  a: { mode: 'toxina', dose: 4, zone: 'Auto', product: ' Vial A ' },
  b: { mode: 'toxina', dose: 0, zone: 'Auto', product: 'Vial A' },
  c: { mode: 'relleno_ha', dose: 0.1, zone: 'Auto', plane: 'Supraperióstico' },
  d: { mode: 'relleno_ha', dose: 0.2, zone: 'Auto' },
};

test('ledgerRows: una fila por marca, lateralidad del paciente y marcas extendidas', () => {
  const rows = model.ledgerRows(meta, { a: binding(234), b: binding(454), c: binding(234) }, ['d', 'a']);
  assert.deepEqual(Array.from(rows, r => r.id), ['a', 'b', 'c', 'd']);
  assert.equal(rows[0].side, 'derecho');
  assert.equal(rows[1].side, 'izquierdo');
  assert.equal(rows[0].product, 'Vial A');
  assert.equal(rows[2].plane, 'Supraperióstico');
  assert.deepEqual([rows[3].zone, rows[3].third, rows[3].extended], [model.EXTENDED_ZONE, 'extendida', true]);
  assert.deepEqual(Array.from(rows, r => r.index), [1, 2, 3, 4]);
});

test('filterRows y volumeTotals: filtros combinados y acumulado en tiempo real', () => {
  const rows = model.ledgerRows(meta, { a: binding(234), b: binding(454), c: binding(234) }, ['d']);
  assert.deepEqual(Array.from(model.filterRows(rows, { ...model.ALL_ROWS, volume: 'without' }), r => r.id), ['b']);
  assert.deepEqual(Array.from(model.filterRows(rows, { ...model.ALL_ROWS, mode: 'relleno_ha', third: 'extendida' }), r => r.id), ['d']);
  assert.deepEqual(Array.from(model.filterRows(rows, { ...model.ALL_ROWS, zone: rows[0].zone, mode: 'toxina' }), r => r.id).includes('a'), true);
  const totals = model.volumeTotals(rows);
  const toxin = totals.find(t => t.mode === 'toxina');
  assert.deepEqual([toxin.total, toxin.points, toxin.pending, toxin.product], [4, 2, 1, 'Vial A']);
  assert.equal(model.formatVolume(totals.find(t => t.mode === 'relleno_ha').total), '0.3');
});

test('patternTips: abanico, malla, helecho, línea y flecha depositan dosis solo en sus puntas', () => {
  const p = id => at(id), seg = (a, b) => [p(a), p(b)];
  assert.deepEqual(model.patternTips({ kind: 'pattern', paths: [seg(1, 50), seg(1, 205), seg(1, 234)] }), [p(50), p(205), p(234)]);
  assert.deepEqual(model.patternTips({ kind: 'arrow', paths: [seg(1, 50), seg(50, 205), seg(50, 234)] }), [p(50)]);
  assert.deepEqual(model.patternTips({ kind: 'line', paths: [[p(1), p(4), p(50)]] }), [p(50)]);
  for (const kind of ['point', 'free', 'circle', 'rect']) assert.equal(model.patternTips({ kind, paths: [seg(1, 50)] }).length, 0, kind);
});

test('entrada de aguja sin dosis: puntas como hijas, totales y filtros solo cuentan puntas', () => {
  const m = {
    fan: { mode: 'relleno_ha', dose: 0, zone: 'Auto', entry: true, technique: 'Abanico' },
    t1: { mode: 'relleno_ha', dose: 0.1, zone: 'Auto', parent: 'fan', tip: 1 },
    t0: { mode: 'relleno_ha', dose: 0.05, zone: 'Auto', parent: 'fan', tip: 0 },
    a: { mode: 'toxina', dose: 4, zone: 'Auto' },
  };
  const rows = model.ledgerRows(m, { t1: binding(205), a: binding(234), fan: { kind: 'pattern', paths: [[at(1), at(50)]] }, t0: binding(50) });
  assert.deepEqual(Array.from(rows, r => r.id), ['a', 'fan', 't0', 't1']);
  assert.deepEqual(Array.from(rows, r => r.label), ['Punto', 'Abanico', 'Punta 1', 'Punta 2']);
  assert.equal(rows[1].tips, 2);
  assert.equal(rows[1].entry, true);
  const ha = model.volumeTotals(rows).find(t => t.mode === 'relleno_ha');
  assert.deepEqual([Math.round(ha.total * 1000) / 1000, ha.points, ha.pending], [0.15, 2, 0]);
  assert.deepEqual(Array.from(model.filterRows(rows, { ...model.ALL_ROWS, volume: 'without' }), r => r.id), []);
});

test('patrón en foto respeta la configuración: N líneas, celdas y ramas desde la entrada', () => {
  const annotations = load(path.join(root, 'anatomicalAnnotations.ts'));
  const start = { x: 0.3, y: 0.5 }, end = { x: 0.6, y: 0.5 }, config = { fanLines: 7, fanAngle: 30, gridCells: 3, fernBranches: 4 };
  const fan = annotations.photoPatternPaths(start, end, 1, 'fan', config);
  assert.equal(fan.length, 7);
  assert.ok(fan.every(([a]) => a === start));
  const spread = Math.atan2(fan[6][1].y - start.y, fan[6][1].x - start.x) * 180 / Math.PI;
  assert.ok(Math.abs(spread - 30) < 1e-6, `media apertura ${spread}`);
  assert.equal(annotations.photoPatternPaths(start, end, 1, 'grid', config).length, 8);
  assert.equal(annotations.photoPatternPaths(start, end, 1, 'fern', config).length, 9);
  assert.equal(annotations.photoPatternPaths(start, end, 1, 'fan').length, 5);
});
