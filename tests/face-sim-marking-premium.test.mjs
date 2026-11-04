import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

// Solo geometría sintética y el atlas público del proyecto. Sin fotos ni registros reales.
const root = path.resolve('src/lab/faceSim'), require = createRequire(import.meta.url);
function loader(overrides = {}) {
  const cache = new Map();
  return function load(file) {
    if (cache.has(file)) return cache.get(file);
    if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    vm.runInNewContext(code, { exports, console, Error, structuredClone, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
      require(name) {
        if (name in overrides) return overrides[name];
        if (!name.startsWith('.')) return require(name);
        const base = path.resolve(path.dirname(file), name);
        const target = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p));
        if (!target) throw new Error(`Missing ${base}`);
        return load(target);
      },
    }, { filename: file });
    return exports;
  };
}
const load = loader(), operations = load(path.join(root, 'markingOperations.ts'));
const model = load(path.join(root, 'markingModel.ts'));
const transfer = load(path.join(root, 'faceTransfer.ts'));
const symmetry = load(path.join(root, 'annotationSymmetry.ts'));
const record = load(path.join(root, 'injectableLocalRecord.ts'));
const atlas = transfer.genericFaceAtlas;
const point = id => ({ x: atlas.positions[id * 3], y: atlas.positions[id * 3 + 1], z: atlas.positions[id * 3 + 2] });
const at = id => {
  const address = transfer.locateModelPoint(point(id), atlas);
  assert.ok(address); return address;
};
const a = at(50), b = at(205);
const binding = address => ({ kind: 'point', paths: [[address]], illustrativePlane: 'skin' });
function fixture() {
  return {
    meta: {
      fan: { mode: 'relleno_ha', dose: 99, zone: 'Auto', product: 'Vial entrada', entry: true, technique: 'Abanico' },
      t0: { mode: 'relleno_ha', dose: 0.1, zone: 'Auto', product: 'Vial A', plane: 'Subcutáneo', parent: 'fan', tip: 0 },
      t1: { mode: 'relleno_ha', dose: 0.2, zone: 'Auto', product: 'Vial B', plane: 'Supraperióstico', parent: 'fan', tip: 1 },
      graphic: { mode: 'toxina', dose: 999, zone: 'Auto', graphicOnly: true, plane: 'Intramuscular', strokeColor: '#123456', strokeWidth: 3, annotationText: 'Sintético', annotationKind: 'text' },
      extended: { mode: 'toxina', dose: 4, zone: 'Extendida' },
    },
    bindings: {
      fan: { kind: 'pattern', paths: [[a, b], [a, a]], illustrativePlane: 'skin' },
      t0: binding(b), t1: binding(a), graphic: binding(a),
    },
    markers: [], lines: [],
  };
}
function copy(extra = {}) {
  let serial = 0;
  return operations.prepareMarkingCopy({
    ...fixture(), ids: ['fan', 't0', 't1'], operation: 'mirror',
    intent: { confirmedQuantities: true, discardExtended: false },
    atlas, plane: 'skin', accepts: () => true, newId: () => `copy-${++serial}`, ...extra,
  });
}
const ids = result => Object.keys(result.meta);
const from = (result, id) => Object.entries(result.meta).find(([, m]) => m.markingCopyIntent.sourceId === id);

test('copia/reflejo: familias sin duplicación doble; categorías, viales, dosis, planos y parent/tip conservados', () => {
  for (const operation of ['duplicate', 'mirror']) {
    const before = fixture(), snapshot = structuredClone(before);
    const result = copy({ ...before, operation });
    assert.equal(ids(result).length, 3);
    const [parent, entry] = from(result, 'fan');
    assert.equal(entry.entry, true); assert.equal(entry.dose, 0); assert.equal(entry.plane, undefined);
    for (const source of ['t0', 't1']) {
      const [id, meta] = from(result, source);
      for (const key of ['mode', 'product', 'dose', 'plane', 'tip']) assert.equal(meta[key], before.meta[source][key], key);
      assert.equal(meta.parent, parent); assert.notEqual(id, source);
      assert.equal(result.bindings[id].illustrativePlane, 'skin');
      const old = symmetry.canonicalAnnotationPoint(before.bindings[source].paths[0][0], atlas);
      const next = symmetry.canonicalAnnotationPoint(result.bindings[id].paths[0][0], atlas);
      assert.ok(Math.abs(next.x - (operation === 'mirror' ? -old.x : old.x)) < 1e-6);
      assert.ok(Math.abs(next.y - old.y) < 1e-6);
    }
    assert.equal(new Set(Object.values(result.meta).map(m => m.markingCopyIntent.transactionId)).size, 1);
    assert.equal(JSON.stringify(before), JSON.stringify(snapshot));
    const rows = model.ledgerRows(result.meta, result.bindings);
    assert.equal(model.volumeTotals(rows).reduce((sum, t) => sum + t.total, 0), 0.30000000000000004);
    assert.ok(rows.every(r => r.side === (operation === 'mirror' ? 'izquierdo' : 'derecho')));
  }
});

test('selección de solo una punta copia su familia; gráfico sin dosis/plano; cantidades e intención exportables por localRecord', () => {
  const result = copy({ ids: ['t1', 'graphic'] });
  assert.equal(ids(result).length, 4);
  const [graphicId, graphic] = from(result, 'graphic');
  assert.equal(graphic.dose, 0); assert.equal(graphic.plane, undefined); assert.equal(graphic.graphicOnly, true);
  assert.equal(graphic.strokeColor, '#123456'); assert.equal(graphic.annotationText, 'Sintético');
  assert.ok(result.bindings[graphicId]);
  const exported = record.localRecord(result.markers, result.lines, [], result.meta);
  const labMeta = JSON.parse(JSON.stringify(exported)).mapping_data.lab.meta;
  assert.equal(labMeta[graphicId].markingCopyIntent.confirmedQuantities, true);
  assert.equal(labMeta[graphicId].markingCopyIntent.operation, 'mirror');
  assert.ok(labMeta[graphicId].markingCopyIntent.confirmedAt);
  const imported = record.importLocalRecord(JSON.stringify(exported), ['Auto']);
  const restoredTips = Object.values(imported.meta).filter(m => m.parent);
  assert.equal(restoredTips.length, 2);
  assert.deepEqual(restoredTips.map(m => [m.product, m.dose, m.plane]), [['Vial A', 0.1, 'Subcutáneo'], ['Vial B', 0.2, 'Supraperióstico']]);
  const expected = new Map(Object.values(result.meta).map(m => [m.markingCopyIntent.sourceId, m]));
  for (const item of Object.values(imported.meta)) {
    const original = expected.get(item.markingCopyIntent.sourceId);
    assert.ok(original);
    assert.equal(JSON.stringify(item.markingCopyIntent), JSON.stringify(original.markingCopyIntent));
    for (const key of ['mode', 'product', 'dose', 'plane', 'tip', 'entry', 'graphicOnly']) assert.equal(item[key], original[key], key);
    if (item.parent) {
      assert.ok(imported.meta[item.parent].entry);
      assert.equal(imported.meta[item.parent].markingCopyIntent.sourceId, 'fan');
    }
  }
  const reexported = record.localRecord(imported.markers, imported.lines, imported.shapes, imported.meta);
  const twice = record.importLocalRecord(JSON.stringify(reexported), ['Auto']);
  assert.equal(JSON.stringify(Object.values(twice.meta).map(m => m.markingCopyIntent)),
    JSON.stringify(Object.values(imported.meta).map(m => m.markingCopyIntent)));
});

test('round-trip duplicar y reflejar: intención histórica estable, identidad familiar remapeada y metadatos completos', () => {
  for (const operation of ['duplicate', 'mirror']) {
    const copied = copy({ operation });
    const input = record.localRecord(copied.markers, copied.lines, [], copied.meta);
    const restored = record.importLocalRecord(JSON.stringify(input), ['Auto']);
    const parent = Object.entries(restored.meta).find(([, m]) => m.entry);
    assert.ok(parent);
    assert.equal(parent[1].dose, 0);
    assert.equal(parent[1].markingCopyIntent.operation, operation);
    const tips = Object.entries(restored.meta).filter(([, m]) => m.parent);
    assert.equal(tips.length, 2);
    for (const [id, tip] of tips) {
      const original = Object.values(copied.meta).find(m => m.markingCopyIntent.sourceId === tip.markingCopyIntent.sourceId);
      assert.equal(tip.parent, parent[0]);
      assert.notEqual(id, copied.markers.find(m => copied.meta[m.id].tip === tip.tip).id);
      for (const key of ['mode', 'product', 'dose', 'plane', 'tip']) assert.equal(tip[key], original[key], key);
      assert.equal(JSON.stringify(tip.markingCopyIntent), JSON.stringify(original.markingCopyIntent));
    }
  }
});

test('importación: intención opcional y validada; rechaza confirmación falsa, fechas, ids y resúmenes adulterados', () => {
  const copied = copy(), exported = record.localRecord(copied.markers, copied.lines, [], copied.meta);
  const firstId = Object.keys(copied.meta)[0];
  const invalid = [
    null, [], {}, { confirmedQuantities: false }, { discardExtended: 'sí' }, { operation: 'apply' },
    { sourceId: '' }, { transactionId: ' ' }, { confirmedAt: '2026-02-30T00:00:00.000Z' },
    { confirmedAt: 'ayer' }, { totals: {} },
    { totals: [{ ...copied.meta[firstId].markingCopyIntent.totals[0], total: -1 }] },
    { totals: [{ ...copied.meta[firstId].markingCopyIntent.totals[0], pending: 99 }] },
    { totals: [{ ...copied.meta[firstId].markingCopyIntent.totals[0], points: 1.5 }] },
    { totals: [{ ...copied.meta[firstId].markingCopyIntent.totals[0], mode: 'otra' }] },
    { totals: [{ ...copied.meta[firstId].markingCopyIntent.totals[0], key: 'otro vial' }] },
    { totals: Array(2).fill(copied.meta[firstId].markingCopyIntent.totals[0]) },
  ];
  for (const change of invalid) {
    const payload = JSON.parse(JSON.stringify(exported));
    payload.mapping_data.lab.meta[firstId].markingCopyIntent = change === null || Array.isArray(change)
      ? change : { ...payload.mapping_data.lab.meta[firstId].markingCopyIntent, ...change };
    if (change && !Array.isArray(change) && Object.keys(change).length === 0) payload.mapping_data.lab.meta[firstId].markingCopyIntent = {};
    assert.throws(() => record.importLocalRecord(JSON.stringify(payload), ['Auto']), /copia.*inválid/);
  }
  const legacy = JSON.parse(JSON.stringify(exported));
  for (const item of Object.values(legacy.mapping_data.lab.meta)) delete item.markingCopyIntent;
  const imported = record.importLocalRecord(JSON.stringify(legacy), ['Auto']);
  assert.ok(Object.values(imported.meta).every(m => !Object.hasOwn(m, 'markingCopyIntent')));
  assert.equal(JSON.stringify(exported.mapping_data.lab.meta), JSON.stringify(copied.meta));
});

test('extendidas solo se excluyen con consentimiento expreso; errores no producen una copia parcial', () => {
  assert.throws(() => copy({ ids: ['fan', 'extended'] }), /explícitamente/);
  const result = copy({ ids: ['fan', 'extended'], intent: { confirmedQuantities: true, discardExtended: true } });
  assert.equal(ids(result).length, 3); assert.equal(result.excluded, 1);
  assert.throws(() => copy({ ids: ['extended'], intent: { confirmedQuantities: true, discardExtended: true } }), /No hay marcas transferibles/);
  assert.throws(() => copy({ intent: { confirmedQuantities: false } }), /Confirma explícitamente/);
  assert.throws(() => copy({ plane: 'muscle' }), /otra capa/);
  assert.throws(() => copy({ accepts: () => false }), /cobertura/);
  assert.throws(() => copy({ newId: () => 'fan' }), /único/);
  assert.throws(() => copy({ ids: ['missing'] }), /selección cambió/);
  const broken = fixture(); delete broken.bindings.fan;
  assert.throws(() => copy({ ...broken, ids: ['t0'] }), /entrada transferible|extendidas/);
});

test('cobertura interior: un trazo no puede cruzar un hueco aunque ambos extremos sean válidos', () => {
  const fa = symmetry.canonicalAnnotationPoint(a, atlas), fb = symmetry.canonicalAnnotationPoint(b, atlas);
  const center = { x: (fa.x + fb.x) / 2, y: (fa.y + fb.y) / 2 };
  assert.throws(() => copy({ operation: 'duplicate', accepts: address => {
    const p = symmetry.canonicalAnnotationPoint(address, atlas);
    return Math.hypot(p.x - center.x, p.y - center.y) > 0.02;
  } }), /cruza una zona sin cobertura/);
});

test('edición en lote: deduplica puntas, ignora gráficos/entradas, valida plano, dosis y categorías mixtas', () => {
  const { meta, bindings } = fixture(), rows = model.ledgerRows(meta, bindings, ['extended']);
  const edited = model.editMarkingBatch(meta, rows, ['fan', 't0', 'graphic'], { dose: 0.5 });
  assert.equal(edited.t0.dose, 0.5); assert.equal(edited.t1.dose, 0.5);
  assert.equal(edited.fan, meta.fan); assert.equal(edited.graphic, meta.graphic);
  assert.equal(meta.t0.dose, 0.1);
  assert.equal(model.editMarkingBatch(meta, rows, ['fan'], { product: 'Nuevo vial' }).t1.product, 'Nuevo vial');
  assert.equal(model.editMarkingBatch(meta, rows, ['fan'], { plane: 'Subcutáneo' }).t0.plane, 'Subcutáneo');
  assert.throws(() => model.editMarkingBatch(meta, rows, ['fan'], { plane: 'Intramuscular' }), /plano no es válido/);
  assert.throws(() => model.editMarkingBatch(meta, rows, ['fan', 'extended'], { dose: 1 }), /mezcla categorías/);
  assert.throws(() => model.editMarkingBatch(meta, rows, ['fan'], { dose: Infinity }), /finito/);
  assert.throws(() => model.editMarkingBatch(meta, rows, ['graphic'], { dose: 1 }), /gráficos no admiten/);
});

test('filtros combinados y resumen visible por producto: pendientes sin gráficos/entradas, U y ml separados', () => {
  const f = fixture(); f.meta.extended.dose = 0;
  const rows = model.ledgerRows(f.meta, f.bindings, ['extended']);
  assert.deepEqual(Array.from(model.filterRows(rows, { ...model.ALL_ROWS, volume: 'without' }), r => r.id), ['extended']);
  const visible = model.filterRows(rows, { ...model.ALL_ROWS, product: JSON.stringify(['relleno_ha', 'Vial A']), side: 'derecho', search: 'subcutaneo' });
  assert.deepEqual(Array.from(visible, r => r.id), ['t0']);
  assert.deepEqual(Array.from(model.volumeTotals(visible), t => [t.product, t.total]), [['Vial A', 0.1]]);
  const totals = model.volumeTotals(rows);
  assert.equal(totals.length, 3);
  assert.equal(totals.find(t => t.mode === 'toxina').pending, 1);
});

const find = (tree, predicate) => Array.isArray(tree) ? tree.flatMap(n => find(n, predicate))
  : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : String(tree ?? '');

function app() {
  const states = [], refs = [], memos = [];
  let cursor = 0, refCursor = 0, memoCursor = 0, tree;
  const names = [...readFileSync(path.join(root, 'FaceSimLab.tsx'), 'utf8').matchAll(/const \[(\w+),[^\]]+\] = useState/g)].map(m => m[1]);
  const Clinical = () => null;
  const appLoad = loader({
    react: { ...React, useEffect() {}, useCallback: fn => fn, useId: () => 'premium-test',
      useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
        return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
      useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
      useMemo(fn, dependencies) { const i = memoCursor++, old = memos[i];
        if (!old || dependencies.some((d, j) => !Object.is(d, old.dependencies[j]))) memos[i] = { value: fn(), dependencies };
        return memos[i].value; },
    },
    '../../components/admin/ficha-clinica/components/Clinical3DViewer': Clinical,
    '../../components/ui/Tooltip': { Tooltip: () => null },
  });
  const Component = appLoad(path.join(root, 'FaceSimLab.tsx')).default;
  const api = {
    render() { cursor = 0; refCursor = 0; memoCursor = 0; tree = Component(); },
    set(name, value) { assert.ok(names.includes(name), name); states[names.indexOf(name)] = value; },
    get(name) { return states[names.indexOf(name)]; },
    ledger() { const node = find(tree, n => n.type?.name === 'PointLedger')[0]; assert.ok(node); return node.props; },
    undo() { const node = find(tree, n => n.props?.label === 'Deshacer' || n.type === 'button' && text(n).includes('Deshacer'))[0]; assert.ok(node); node.props.onClick(); },
  };
  api.render(); api.set('workspace', 'simulate'); api.set('editorGroup', 'annotations'); api.set('preview', { ...api.get('preview'), after: false });
  api.render(); return api;
}

for (const workMode of ['3d', 'foto']) test(`FaceSimLab ${workMode}: transacción real vía PointLedger, un solo undo, bilateral no multiplica`, () => {
  const ui = app(), fixtureData = fixture();
  ui.set('workMode', workMode);
  if (workMode === 'foto') {
    const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: 0.5 + point(i).x * 0.15, y: 0.5 - point(i).y * 0.15, z: 0 }));
    ui.set('photos', { frontal: { canvas: { width: 1000, height: 1000 }, aspect: 1, landmarks, captureConfirmed: true } });
  }
  for (const key of ['meta', 'bindings', 'markers', 'lines']) ui.set(key, fixtureData[key]);
  ui.set('bilateral', true); ui.set('history', []); ui.render();
  const beforeQuick = ui.get('quickRecord');
  const error = ui.ledger().onCopy(['fan', 't0', 't1'], 'mirror', { confirmedQuantities: true, discardExtended: false });
  assert.equal(error, null); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 7);
  assert.equal(ui.get('history').length, 1);
  assert.equal(ui.get('quickRecord'), beforeQuick);
  assert.equal(Object.values(ui.get('meta')).filter(m => m.markingCopyIntent).length, 3);
  ui.undo(); ui.render();
  assert.equal(ui.get('bindings'), fixtureData.bindings); assert.equal(ui.get('meta'), fixtureData.meta);
  assert.equal(ui.get('history').length, 0);
  const invalid = ui.ledger().onCopy(['fan'], 'mirror', { confirmedQuantities: false });
  assert.match(invalid, /Confirma/); assert.equal(ui.get('history').length, 0);
  assert.equal(ui.get('bindings'), fixtureData.bindings);
  assert.equal(ui.ledger().onBatch(['fan', 't0'], { dose: 0.7 }), null); ui.render();
  assert.equal(ui.get('meta').t1.dose, 0.7); assert.equal(ui.get('history').length, 1);
  ui.undo(); ui.render(); assert.equal(ui.get('meta'), fixtureData.meta);
});

function copyPanel(props) {
  const slots = [], effects = [];
  let cursor = 0, dirty = false;
  const panels = loader({ react: { ...React,
    useMemo: fn => fn(),
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i];
      if (!old || deps.some((d, j) => !Object.is(d, old[j]))) { slots[i] = deps; effects.push(effect); } },
  } })(path.join(root, 'MarkingPanels.tsx'));
  return {
    render(next = {}) { props = { ...props, ...next }; let tree;
      do { dirty = false; cursor = 0; tree = panels.MarkingCopyControls(props); effects.splice(0).forEach(fn => fn()); } while (dirty);
      return tree;
    },
  };
}
const button = (tree, label) => { const n = find(tree, n => n.type === 'button' && text(n) === label)[0]; assert.ok(n, label); return n; };
const checkbox = (tree, prefix) => { const label = find(tree, n => n.type === 'label' && text(n).startsWith(prefix))[0];
  assert.ok(label, prefix); return find(label, n => n.type === 'input')[0]; };
const form = tree => find(tree, n => n.type === 'form')[0];

test('confirmación UI: selección explícita, resumen previo, exclusión extendida, errores visibles y recuperación de foco', () => {
  const f = fixture(), rows = model.ledgerRows(f.meta, f.bindings, ['extended']), calls = [];
  const ui = copyPanel({ rows, ids: ['fan', 't0', 'extended'], onCopy: (...args) => { calls.push(args); return 'Cobertura rechazada'; } });
  let tree = ui.render(), focused = 0;
  button(tree, 'Reflejar selección').props.onClick({ currentTarget: { focus() { focused++; } } }); tree = ui.render();
  assert.equal(button(tree, 'Reflejar selección').props['aria-pressed'], true);
  assert.equal(button(tree, 'Confirmar reflejo').props.disabled, true);
  assert.ok(find(tree, n => n.props?.label === 'Cantidades que se añadirán')[0]);
  form(tree).props.onSubmit({ preventDefault() {} }); tree = ui.render(); assert.equal(calls.length, 0);
  checkbox(tree, 'Confirmo duplicar').props.onChange({ target: { checked: true } }); tree = ui.render();
  assert.equal(button(tree, 'Confirmar reflejo').props.disabled, true);
  checkbox(tree, 'Excluir 1').props.onChange({ target: { checked: true } }); tree = ui.render();
  assert.equal(button(tree, 'Confirmar reflejo').props.disabled, false);
  form(tree).props.onSubmit({ preventDefault() {} }); tree = ui.render();
  assert.deepEqual(calls[0][0], ['fan', 't0', 'extended']); assert.equal(calls[0][1], 'mirror');
  assert.equal(calls[0][2].confirmedQuantities, true); assert.equal(calls[0][2].discardExtended, true);
  assert.match(text(find(tree, n => n.props?.role === 'alert')[0]), /Cobertura rechazada/);
  button(tree, 'Cancelar copia').props.onClick(); tree = ui.render();
  assert.equal(form(tree), undefined); assert.equal(focused, 1);
  button(tree, 'Duplicar selección').props.onClick({ currentTarget: { focus() {} } }); tree = ui.render();
  checkbox(tree, 'Confirmo duplicar').props.onChange({ target: { checked: true } }); tree = ui.render();
  tree = ui.render({ ids: ['t1'] });
  assert.equal(form(tree), undefined, 'cambiar selección invalida la confirmación previa');
  assert.equal(calls.length, 1);
});
