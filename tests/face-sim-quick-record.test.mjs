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
const quick = load(path.join(root, 'quickRecord.ts'));
const records = load(path.join(root, 'injectableLocalRecord.ts'));
const atlas = load(path.join(root, 'genericFaceAtlas.json'));
const addressAt = id => {
  const triangle = atlas.triangles.findIndex(value => value === id);
  assert.ok(triangle >= 0);
  return { triangle: Math.floor(triangle / 3), weights: [0, 1, 2].map(i => i === triangle % 3 ? 1 : 0) };
};
const binding = (...ids) => ({ kind: ids.length === 1 ? 'point' : 'free', paths: [ids.map(addressAt)] });
const metadata = (product, mode = 'toxina', dose = 0) => ({ product, mode, dose, zone: 'Auto' });
const plain = value => JSON.parse(JSON.stringify(value));

test('registro rapido detecta zona, tercio y lado del paciente sin dosis por marca', () => {
  const groups = quick.quickRecordGroups({ a: metadata('Vial QA'), b: metadata('Vial QA') }, { a: binding(50), b: binding(280) });
  assert.equal(groups.length, 1);
  const sides = groups[0].zones.map(zone => zone.side);
  assert.ok(sides.includes('derecho')); assert.ok(sides.includes('izquierdo'));
  assert.ok(groups[0].zones.every(zone => zone.zone !== 'Auto'));
  assert.equal(quick.quickGroupSummary(groups[0]).assigned, 0);
  assert.equal(quick.quickGroupSummary(groups[0]).pending, groups[0].zones.length);
  const withDose = quick.quickRecordGroups({ a: metadata('Vial QA', 'toxina', 999), b: metadata('Vial QA', 'toxina', 999) }, { a: binding(50), b: binding(280) });
  assert.deepEqual(plain(groups), plain(withDose), 'Las cantidades por marca nunca se suman al modo rapido.');
});

test('trazos multizona no duplican cantidad y los tercios suman el total exacto', () => {
  const [group] = quick.quickRecordGroups({ line: metadata('Vial QA', 'relleno_ha') }, { line: binding(10, 50, 152) });
  assert.ok(group.zones.length >= 3);
  const values = { total: 0.6, zones: Object.fromEntries(group.zones.map(zone => [zone.key, 0.2])) };
  const result = quick.quickGroupSummary(group, values);
  assert.ok(Math.abs(result.assigned - group.zones.length * 0.2) < 1e-10);
  assert.ok(Math.abs(Object.values(result.thirds).reduce((a, b) => a + b, 0) - result.assigned) < 1e-10);
  assert.equal(result.pending, 0);
  assert.equal(group.elements.length, 1);
  assert.equal(quick.quickGroupSummary(group, { total: 0, zones: { [group.zones[0].key]: 0 } }).pending, group.zones.length - 1);
});

test('productos y categorias no mezclan unidades; zona sin marcas queda explicita', () => {
  const meta = { a: metadata('A'), b: metadata('B'), c: metadata('A', 'bioestimulador') };
  const bindings = { a: binding(50), b: binding(50), c: binding(50) };
  const groups = quick.quickRecordGroups(meta, bindings);
  assert.equal(groups.length, 3);
  const [group] = groups, stale = JSON.stringify(['inferior', 'Zona anterior', 'central']);
  const result = quick.quickGroupSummary(group, { total: 5, zones: { [stale]: 3, [group.zones[0].key]: 1 } });
  assert.equal(result.assigned, 1); assert.equal(result.orphaned, 3); assert.equal(result.difference, 4);
  assert.equal(result.stale.length, 1);
  assert.throws(() => quick.quickRecordGroups({}, { a: binding(50) }), /categoría/);
});

test('validacion rechaza cantidades invalidas y mantiene null distinto de cero', () => {
  const key = quick.quickGroupKey('toxina', 'Vial QA'), zone = JSON.stringify(['medio', 'Pomulos', 'derecho']);
  const value = { version: 1, entries: { [key]: { total: null, zones: { [zone]: 0 } } } };
  assert.deepEqual(plain(quick.validateQuickRecord(value)), value);
  for (const bad of [-1, NaN, Infinity, '0', undefined]) {
    assert.throws(() => quick.validateQuickRecord({ ...value, entries: { [key]: { total: bad, zones: {} } } }), /inválid/);
  }
  assert.throws(() => quick.validateQuickRecord({ version: 2, entries: {} }), /versión/);
  assert.throws(() => quick.validateQuickRecord(JSON.parse('{"version":1,"entries":{"__proto__":{}}}')), /inválid|versión/);
  assert.throws(() => quick.quickRecordGroups({ a: metadata('Vial QA') }, { a: { kind: 'point', paths: [[{ triangle: -1, weights: [1, 0, 0] }]] } }), /válida/);
});

test('JSON conserva totales rapidos sin asignarlos a puntos; formato previo sigue valido', () => {
  const key = quick.quickGroupKey('toxina', 'Vial QA'), zone = JSON.stringify(['medio', 'Pomulos', 'derecho']);
  const settings = { version: 1, entries: { [key]: { total: 5, zones: { [zone]: 5 } } } };
  const position = { x: atlas.positions[50 * 3], y: atlas.positions[50 * 3 + 1], z: atlas.positions[50 * 3 + 2] };
  const saved = records.localRecord([{ id: 'm', position }], [], [], { m: metadata('Vial QA') }, {}, {}, settings, { m: 'muscle' });
  const restored = records.importLocalRecord(JSON.stringify(saved), []);
  assert.deepEqual(plain(restored.quickRecord), settings);
  assert.equal(Object.values(restored.meta)[0].dose, 0);
  assert.deepEqual(Object.values(restored.illustrativePlanes), ['muscle']);
  const old = records.localRecord([{ id: 'm', position }], [], [], { m: metadata('Vial QA', 'toxina', 3) });
  assert.equal(records.importLocalRecord(JSON.stringify(old), []).quickRecord, undefined);
  assert.equal(Object.keys(records.importLocalRecord(JSON.stringify(old), []).illustrativePlanes).length, 0);
  saved.mapping_data.lab.illustrativePlanes.m = 'intramuscular';
  assert.throws(() => records.importLocalRecord(JSON.stringify(saved), []), /ilustrativa/);
  saved.mapping_data.lab.illustrativePlanes.m = 'muscle';
  saved.mapping_data.lab.quickRecord.entries[key].zones[zone] = -1;
  assert.throws(() => records.importLocalRecord(JSON.stringify(saved), []), /inválid/);
});
