import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import { annotationHistory, annotationLaterality, mirrorAnnotation, transformAnnotation, translateAnnotation } from '../src/lab/faceSim/annotationSymmetry.ts';
import { photoPatternPaths } from '../src/lab/faceSim/anatomicalAnnotations.ts';
import { locateModelPoint, modelPoint } from '../src/lab/faceSim/faceTransfer.ts';

const kinds = ['point', 'line', 'arrow', 'free', 'circle', 'rect', 'pattern'];
const vertex = i => ({ x: atlas.positions[i * 3], y: atlas.positions[i * 3 + 1], z: atlas.positions[i * 3 + 2] });
const a = locateModelPoint(vertex(50), atlas), b = locateModelPoint(vertex(205), atlas);
assert.ok(a && b);
const make = kind => ({
  kind, illustrativePlane: 'muscle',
  paths: kind === 'point' ? [[a]] : kind === 'pattern' ? [[a, b], [b, a]] : [[a, b]],
  ...(['circle', 'rect'].includes(kind) ? { center: a } : {}),
});

for (const kind of kinds) test(`espejo ${kind}: conserva original, segmentos, centro y contexto ilustrativo`, () => {
  const original = make(kind), before = structuredClone(original);
  const mirrored = mirrorAnnotation(original, atlas);
  assert.ok(mirrored);
  assert.deepEqual(original, before);
  assert.equal(mirrored.kind, kind);
  assert.equal(mirrored.illustrativePlane, 'muscle');
  assert.deepEqual(mirrored.paths.map(p => p.length), original.paths.map(p => p.length));
  assert.equal(Boolean(mirrored.center), Boolean(original.center));
  const x = address => atlas.triangles.slice(address.triangle * 3, address.triangle * 3 + 3)
    .reduce((sum, id, i) => sum + atlas.positions[id * 3] * address.weights[i], 0);
  original.paths.forEach((p, i) => p.forEach((address, j) => assert.ok(Math.abs(x(address) + x(mirrored.paths[i][j])) < 1e-6)));
  assert.notEqual(annotationLaterality(original, atlas), annotationLaterality(mirrored, atlas));
});

test('lateralidad se calcula en atlas del paciente, no por foto ni por etiqueta', () => {
  const right = { kind: 'point', paths: [[a]] };
  assert.equal(annotationLaterality(right, atlas), 'Derecha del paciente');
  const left = mirrorAnnotation(right, atlas);
  assert.equal(annotationLaterality(left, atlas), 'Izquierda del paciente');
  assert.equal(annotationLaterality({ kind: 'free', paths: [right.paths[0], left.paths[0]] }, atlas), 'Bilateral del paciente');
});

test('espejo rechaza el elemento COMPLETO si falla un segmento o el centro', () => {
  const original = make('pattern'), before = structuredClone(original);
  let count = 0;
  assert.equal(mirrorAnnotation(original, atlas, () => ++count < 4), null);
  assert.deepEqual(original, before);
  count = 0;
  assert.equal(mirrorAnnotation(make('circle'), atlas, () => ++count < 3), null);
});

test('patrones fotográficos generan múltiples segmentos sin mutar los puntos', () => {
  const start = { x: 0.3, y: 0.4 }, end = { x: 0.4, y: 0.5 };
  for (const kind of ['fan', 'grid', 'fern']) {
    const paths = photoPatternPaths(start, end, 0.8, kind);
    assert.ok(paths.length >= 5);
    assert.ok(paths.every(p => p.length === 2 && p.every(q => Number.isFinite(q.x) && Number.isFinite(q.y))));
  }
  assert.deepEqual(start, { x: 0.3, y: 0.4 }); assert.deepEqual(end, { x: 0.4, y: 0.5 });
});

test('traslado conserva kind, segmentos y centro sin mutar ni recortar el original', () => {
  for (const kind of kinds) {
    const binding = make(kind), before = structuredClone(binding);
    const moved = translateAnnotation(binding, { x: 0.005, y: 0.003 }, atlas);
    assert.ok(moved);
    assert.equal(moved.kind, kind);
    assert.deepEqual(moved.paths.map(p => p.length), binding.paths.map(p => p.length));
    assert.deepEqual(binding, before);
    assert.equal(translateAnnotation(binding, { x: 100, y: 0 }, atlas), null);
  }
});

test('escalar/rotar conserva estructura y rechaza escala inválida', () => {
  const binding = make('line'), before = structuredClone(binding);
  const same = transformAnnotation(binding, { scale: 1, degrees: 0 }, atlas);
  assert.ok(same);
  assert.deepEqual(same.paths.map(p => p.length), binding.paths.map(p => p.length));
  assert.ok(transformAnnotation(binding, { scale: 0.8, degrees: 15 }, atlas));
  assert.equal(transformAnnotation(binding, { scale: 0 }, atlas), null);
  assert.deepEqual(binding, before);
});

test('historial conserva una transacción bilateral como un solo deshacer', () => {
  const before = { bindings: {}, quickRecord: { total: 10 } };
  const after = { bindings: { a: make('pattern'), b: mirrorAnnotation(make('pattern'), atlas) }, quickRecord: { total: 10 } };
  const history = annotationHistory([], before);
  assert.equal(history.length, 1);
  assert.equal(Object.keys(after.bindings).length, 2);
  assert.equal(history.at(-1), before);
  assert.deepEqual(history.slice(0, -1), []);
});

// Prueba de handlers React 18 con el mismo contrato que el visor, sin WebGL ni pacientes.
const require = createRequire(import.meta.url);
const root = path.resolve('src/lab/faceSim');
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object'
  ? text(tree.props?.children) : String(tree ?? '');
const find = (tree, predicate) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(child => find(child, predicate))
  : [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
const Clinical = () => null;
function app() {
  let cursor = 0, refCursor = 0, memoCursor = 0, tree;
  const states = [], refs = [], memos = [], cache = new Map();
  const names = [...readFileSync(path.join(root, 'FaceSimLab.tsx'), 'utf8').matchAll(/const \[(\w+),[^\]]+\] = useState/g)].map(m => m[1]);
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    vm.runInNewContext(code, { exports, console, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
      require(name) {
        if (name === 'react') return { ...React, useEffect() {}, useCallback: fn => fn, useId: () => 'test-id',
          useMemo(fn, dependencies) {
            const i = memoCursor++, old = memos[i];
            if (!old || !dependencies || dependencies.some((d, j) => !Object.is(d, old.dependencies[j]))) memos[i] = { value: fn(), dependencies };
            return memos[i].value;
          },
          useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
          useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
            return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
        };
        if (name.endsWith('/Clinical3DViewer')) return Clinical;
        if (name.endsWith('/Tooltip')) return { Tooltip: () => null };
        if (!name.startsWith('.')) return require(name);
        const base = path.resolve(path.dirname(file), name);
        const target = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p));
        if (!target) throw new Error(`Missing ${base}`);
        return load(target);
      },
    }, { filename: file });
    return exports;
  }
  const Component = load(path.join(root, 'FaceSimLab.tsx')).default;
  const panels = new Set(Object.values(load(path.join(root, 'MarkingPanels.tsx'))).filter(v => typeof v === 'function'));
  const expand = n => Array.isArray(n) ? n.map(expand) : !n || typeof n !== 'object' ? n
    : panels.has(n.type) ? expand(n.type(n.props)) : n.props?.children === undefined ? n
      : { ...n, props: { ...n.props, children: expand(n.props.children) } };
  const api = {
    render() { cursor = 0; refCursor = 0; memoCursor = 0; tree = expand(Component()); },
    set(name, value) { assert.ok(names.includes(name), name); states[names.indexOf(name)] = value; },
    get(name) { return states[names.indexOf(name)]; },
    button(label) { const result = find(tree, node => node.type === 'button' && (text(node) === label || node.props?.['aria-label'] === label))[0]; assert.ok(result, label); return result; },
    viewer() { return find(tree, node => node.type === Clinical)[0]; },
  };
  api.render(); api.set('workspace', 'simulate'); api.set('genericPreviewGlb', new ArrayBuffer(8));
  api.set('genericPreviewAfter', false); api.set('preview', { ...api.get('preview'), after: false });
  api.set('tool3d', 'select'); api.render();
  return api;
}

for (const workMode of ['3d', 'foto']) test(`handlers ${workMode}: espejo todos los kinds; originals intactos, dosis 0, undo atómico`, () => {
  const ui = app();
  if (workMode === 'foto') {
    const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: 0.5 + vertex(i).x * 0.15, y: 0.5 - vertex(i).y * 0.15, z: 0 }));
    ui.set('photos', { frontal: { canvas: { width: 1000, height: 1000 }, aspect: 1, landmarks, captureConfirmed: true } });
  }
  ui.set('workMode', workMode);
  for (const kind of kinds) {
    const binding = { ...make(kind), illustrativePlane: 'skin' }, snapshot = structuredClone(binding);
    ui.set('bindings', { original: binding }); ui.set('meta', { original: { mode: 'toxina', zone: 'Auto', dose: 0, product: 'Vial de prueba' } });
    ui.set('markers', []); ui.set('lines', []); ui.set('shapes', []); ui.set('history', []);
    ui.set('selectedId', 'original'); ui.set('bilateral', true); ui.render();
    ui.button('Espejar selección').props.onClick(); ui.render();
    // Los trazos con entrada de aguja (línea, flecha, patrón) generan además sus puntas de dosis.
    const tips = kind === 'arrow' || kind === 'line' ? 1 : kind === 'pattern' ? binding.paths.filter(p => p.length > 1).length : 0;
    assert.equal(Object.keys(ui.get('bindings')).length, 2 + tips, kind);
    assert.deepEqual(ui.get('bindings').original, snapshot);
    assert.equal(ui.get('history').length, 1, 'el modo bilateral no crea un tercer elemento ni dos snapshots');
    assert.ok(Object.values(ui.get('meta')).every(m => m.dose === 0 && m.product === 'Vial de prueba'));
    ui.button('Deshacer').props.onClick(); ui.render();
    assert.equal(Object.keys(ui.get('bindings')).length, 1);
    assert.deepEqual(ui.get('bindings').original, snapshot);
    assert.equal(ui.get('history').length, 0);
  }
});

test('handlers 3D: bilateral nuevo, mover/editar conserva identidad y metadatos sin duplicar', () => {
  const ui = app(); ui.set('bilateral', true); ui.set('tool3d', 'point'); ui.render();
  ui.viewer().props.onMarkerPlaced({ id: 'new', position: vertex(50), normal: { x: 0, y: 0, z: 1 }, rotation: [0, 0, 0] });
  ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 2);
  assert.equal(ui.get('history').length, 1);
  ui.set('tool3d', 'select'); ui.render();
  ui.viewer().props.onEditablePointMoved('new', vertex(205)); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 2);
  assert.equal(ui.get('markers').filter(m => m.id === 'new').length, 1);
  assert.equal(ui.get('meta').new.dose, 0);
  ui.button('Deshacer').props.onClick(); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 2);
  ui.button('Deshacer').props.onClick(); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 0);
});

test('handlers: cantidades sin marcas se exportan; conflictos rechazan todo y limpiar tiene undo', () => {
  const ui = app(), key = JSON.stringify(['toxina', 'Vial de prueba']);
  const current = { version: 1, entries: { [key]: { total: 14, zones: {} } } };
  ui.set('quickRecord', current); ui.render();
  assert.equal(ui.button('Exportar JSON de Inyectables').props.disabled, false);
  const json = quickRecord => JSON.stringify({ mapping_data: { injectionPoints: [], freehandLines: [], surfaceShapes: [],
    lab: { version: 1, meta: {}, quickRecord } } });
  ui.set('importText', json(current)); ui.render(); ui.button('Importar').props.onClick(); ui.render();
  assert.equal(ui.get('quickRecord'), current);
  assert.equal(ui.get('history').length, 0);
  assert.match(ui.get('status'), /Importación rechazada completa/);
  const nextKey = JSON.stringify(['toxina', 'Segundo vial']);
  ui.set('importText', json({ version: 1, entries: { [nextKey]: { total: 5, zones: {} } } }));
  ui.render(); ui.button('Importar').props.onClick(); ui.render();
  assert.equal(Object.keys(ui.get('quickRecord').entries).length, 2);
  assert.equal(ui.get('history').length, 1);
  ui.button('Deshacer').props.onClick(); ui.render();
  assert.equal(ui.get('quickRecord'), current);
  ui.button('Limpiar').props.onClick(); ui.render();
  assert.equal(Object.keys(ui.get('quickRecord').entries).length, 0);
  ui.button('Deshacer').props.onClick(); ui.render();
  assert.equal(ui.get('quickRecord'), current);
});
