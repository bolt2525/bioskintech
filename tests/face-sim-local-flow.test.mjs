import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve('src/lab/faceSim');
const atlas = JSON.parse(readFileSync(path.join(root, 'genericFaceAtlas.json'), 'utf8'));
const clinical = () => null;
function loader(react = React) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    vm.runInNewContext(code, { exports, console, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
      require(name) {
        if (name === 'react') return react;
        if (name.endsWith('/Clinical3DViewer')) return clinical;
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
  return load;
}
const load = loader();
const preview = load(path.join(root, 'injectablePreview.ts'));
const records = load(path.join(root, 'injectableLocalRecord.ts'));
const pos = i => ({ x: atlas.positions[i * 3], y: atlas.positions[i * 3 + 1], z: atlas.positions[i * 3 + 2] });
const settings = { ...preview.DEFAULT_PREVIEW, intensity: 1 };

test('preview: las cuatro categorías son locales, conmutables y ajenas a dosis', () => {
  for (const mode of Object.keys(settings.enabled)) {
    const samples = [{ mode, x: 0.5, y: 0.5, dose: 0 }];
    const first = preview.buildIllustrativeEffects(samples, settings, 1);
    const otherDose = preview.buildIllustrativeEffects([{ ...samples[0], dose: 9999 }], settings, 1);
    assert.deepEqual(first, otherDose);
    assert.equal(first.count, 1);
    assert.equal(preview.buildIllustrativeEffects(samples, { ...settings, after: false }, 1).count, 0);
    assert.equal(preview.buildIllustrativeEffects(samples, { ...settings, intensity: 0 }, 1).count, 0);
    assert.equal(preview.buildIllustrativeEffects(samples, { ...settings, enabled: { ...settings.enabled, [mode]: false } }, 1).count, 0);
  }
});

test('preview: buffers originales intactos, tapa fuera del límite y toxina sin geometría', () => {
  const positions = new Float32Array([0, 0, 0, 0, 0, 1]), uv = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  const rgb = new Float32Array([0.7, 0.6, 0.5, 0.7, 0.6, 0.5]);
  const sample = [{ mode: 'relleno_ha', x: 0.5, y: 0.5 }];
  const result = preview.previewSurface(positions, uv, sample, settings, 1, rgb, 1);
  assert.ok(result.positions[2] > 0);
  assert.equal(result.positions[5], 1);
  assert.equal(positions[2], 0);
  assert.deepEqual(preview.previewSurface(positions, uv, [{ ...sample[0], mode: 'toxina' }], settings, 1).positions, positions);
  const pixels = new Uint8ClampedArray([160, 140, 130, 255, 160, 140, 130, 255]);
  const next = preview.previewPixels(pixels, 2, 1, [{ mode: 'hidratacion', x: 0, y: 0 }], settings, new Uint8Array([1, 0]));
  assert.ok(next[0] > pixels[0]);
  assert.deepEqual(next.slice(4), pixels.slice(4));
  const off = preview.previewPixels(pixels, 2, 1, [{ mode: 'hidratacion', x: 0, y: 0 }], { ...settings, levels: { hidratacion: 0 } }, new Uint8Array([1, 0]));
  assert.deepEqual(off, pixels, 'nivel 0 del inyectable anula su filtro');
  assert.equal(preview.previewGain({ ...settings, levels: { toxina: 9 } }, 'toxina'), preview.MAX_LEVEL);
});

test('Inyectables: export/import mixto conserva categorías, producto, zona y dosis cero', () => {
  const markers = Object.keys(settings.enabled).map((mode, i) => ({ id: `m${i}`, position: pos(50 + i), units: i }));
  const meta = Object.fromEntries(markers.map((m, i) => [m.id, {
    mode: Object.keys(settings.enabled)[i], dose: i, product: `Producto ficticio ${i}`, zone: 'Zona manual',
  }]));
  const encoded = records.localRecord(markers, [], [], meta);
  assert.equal(encoded.mapping_data.injectionPoints.length, 4);
  const decoded = records.importLocalRecord(JSON.stringify(encoded), []);
  assert.equal(decoded.markers.length, 4);
  assert.deepEqual(Object.values(decoded.meta).map(v => ({ ...v })), Object.values(meta));
  assert.throws(() => records.importLocalRecord('{', []));
  encoded.mapping_data.lab.meta.m0.dose = -1;
  assert.throws(() => records.importLocalRecord(JSON.stringify(encoded), []));
});

test('Inyectables: trazos/contornos y formato previo conservan datos sin intensidad serializada', () => {
  const lines = [{ id: 'contour', points: [pos(50), pos(205)], color: '#000', thickness: 1.5, technique_preset: 'Libre' }];
  const shapes = [{ id: 'shape', shapeType: 'circle', center: pos(205), radius: 0.025,
    normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 } }];
  const meta = { contour: { mode: 'hidratacion', dose: 0.125, zone: 'Zona QA', product: 'Producto ficticio' },
    shape: { mode: 'bioestimulador', dose: 0.75, zone: 'Auto' } };
  const encoded = records.localRecord([], lines, shapes, meta, { contour: 'rect', shape: 'circle' }, { contour: pos(205) });
  assert.equal(JSON.stringify(encoded).includes('intensity'), false);
  const decoded = records.importLocalRecord(JSON.stringify(encoded), []);
  assert.equal(decoded.lines.length, 1); assert.equal(decoded.shapes.length, 1);
  const id = decoded.lines[0].id;
  assert.equal(decoded.kinds[id], 'rect');
  assert.equal(decoded.meta[id].dose, 0.125);
  assert.deepEqual({ ...decoded.centers[id] }, pos(205));
  assert.deepEqual(Array.from(decoded.lines[0].points, p => ({ ...p })), Array.from(lines[0].points, p => ({ ...p })));
  const existing = records.importLocalRecord(JSON.stringify({ product_type: 'toxina', product_name: 'Marca ficticia',
    mapping_data: { injectionPoints: [{ position: pos(50), units: 7.25, label: 'Zona QA' }] } }), ['Zona QA']);
  const entry = Object.values(existing.meta)[0];
  assert.equal(entry.mode, 'toxina'); assert.equal(entry.dose, 7.25);
  assert.equal(entry.product, 'Marca ficticia'); assert.equal(entry.zone, 'Zona QA');
});

const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object'
  ? text(tree.props?.children) : String(tree ?? '');
const find = (tree, fn) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(t => find(t, fn)) : [...(fn(tree) ? [tree] : []), ...find(tree.props?.children, fn)];
function app() {
  const source = readFileSync(path.join(root, 'FaceSimLab.tsx'), 'utf8');
  const names = [...source.matchAll(/const \[(\w+),[^\]]+\] = useState/g)].map(m => m[1]);
  let cursor = 0, refCursor = 0, tree;
  const states = [], refs = [];
  const loadUI = loader({ ...React, useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn, useId: () => 'test-id',
    useRef(initial) { const i = refCursor++; return refs[i] ??= { current: initial }; }, useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
    } });
  const Component = loadUI(path.join(root, 'FaceSimLab.tsx')).default;
  // Los paneles del flujo de marcación se expanden; el resto (visor, capas) sigue siendo superficial.
  const panels = new Set(Object.values(loadUI(path.join(root, 'MarkingPanels.tsx'))).filter(v => typeof v === 'function'));
  const expand = n => Array.isArray(n) ? n.map(expand) : !n || typeof n !== 'object' ? n
    : panels.has(n.type) ? expand(n.type(n.props)) : n.props?.children === undefined ? n
      : { ...n, props: { ...n.props, children: expand(n.props.children) } };
  const api = {
    render() {
      // El exportador GLB es asíncrono en navegador; aquí se simula su confirmación.
      if (states[names.indexOf('genericPreviewGlb')]) states[names.indexOf('genericPreviewAfter')] = states[names.indexOf('preview')].after;
      cursor = 0; refCursor = 0; tree = expand(Component()); return tree;
    },
    set(name, value) { assert.ok(names.includes(name), name); states[names.indexOf(name)] = value; },
    get(name) { return states[names.indexOf(name)]; },
    button(label) { return find(tree, n => n.type === 'button' && (text(n) === label || n.props?.['aria-label'] === label))[0]; },
    viewer() { return find(tree, n => n.type === clinical)[0]; },
    query(fn) { return find(tree, fn); },
  };
  api.render(); return api;
}

test('flujo: dos espacios, captura sin marcas, cámara protegida, punto/editar/quitar/undo comunes', () => {
  const ui = app();
  const nav = ui.query(n => n.props?.['aria-label'] === 'Espacios del laboratorio')[0];
  assert.equal(find(nav, n => n.type === 'button').length, 2);
  assert.equal(ui.viewer(), undefined);
  ui.button('Simular y marcar').props.onClick();
  ui.set('genericPreviewGlb', new ArrayBuffer(8)); ui.render();
  assert.equal(ui.viewer().props.readOnly, true);
  assert.ok(ui.viewer().props.surfaceConstraint === undefined);
  ui.button('Punto').props.onClick(); ui.render();
  assert.equal(ui.get('preview').after, false);
  assert.equal(ui.viewer().props.readOnly, false);
  assert.ok(ui.viewer().props.surfaceConstraint);
  const marker = { id: 'real-mark', position: pos(50), normal: { x: 0, y: 0, z: 1 }, rotation: [0, 0, 0] };
  ui.viewer().props.onMarkerPlaced(marker); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
  ui.button('Después').props.onClick(); ui.render();
  assert.equal(ui.get('tool3d'), 'navigate');
  ui.viewer().props.onMarkerPlaced({ ...marker, id: 'preview-should-not-mark' }); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
  ui.button('Punto').props.onClick(); ui.render();
  assert.equal(ui.get('preview').after, false);
  assert.equal(ui.get('meta')['real-mark'].dose, 0);
  const dose = ui.query(n => n.props?.['aria-label'] === 'Dosis marca 1')[0];
  dose.props.onChange({ target: { value: '7.5' } }); ui.render();
  assert.equal(ui.get('meta')['real-mark'].dose, 7.5);
  assert.equal(ui.get('preview').intensity, 0.6);
  ui.query(n => n.props?.['aria-label'] === 'Eliminar marca 1')[0].props.onClick(); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 0);
  ui.button('Deshacer').props.onClick(); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
  ui.button('Mover cámara').props.onClick(); ui.render();
  ui.viewer().props.onMarkerPlaced({ ...marker, id: 'should-not-exist' }); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
  ui.button('Capturas').props.onClick(); ui.render();
  assert.equal(ui.query(n => n.props?.['aria-label'] === 'Elementos marcados').length, 0);
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
});

test('flujo: línea y forma comparten bindings, cámara no dibuja y cancelación no registra', () => {
  const ui = app();
  ui.button('Simular y marcar').props.onClick(); ui.set('genericPreviewGlb', new ArrayBuffer(8)); ui.render();
  ui.button('Línea').props.onClick(); ui.render();
  ui.viewer().props.onFreehandLineComplete({ id: 'line', points: [pos(50), pos(205)], color: '#000', thickness: 1 });
  ui.render();
  assert.ok(ui.get('bindings').line);
  ui.button('Mover cámara').props.onClick(); ui.render();
  ui.viewer().props.onFreehandLineComplete({ id: 'ignored', points: [pos(50), pos(205)], color: '#000', thickness: 1 });
  assert.equal(ui.get('bindings').ignored, undefined);
  ui.button('Círculo').props.onClick(); ui.render();
  ui.viewer().props.onShapeComplete({ id: 'shape', shapeType: 'circle', center: pos(205),
    normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 }, radius: 0.025 });
  ui.render();
  assert.ok(ui.get('bindings').shape);
});

test('foto: Capturas no marca; punto, arrastre, trazo, cancelación y undo usan el mismo registro', () => {
  const ui = app();
  const xs = atlas.positions.filter((_, i) => i % 3 === 0), ys = atlas.positions.filter((_, i) => i % 3 === 1);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.max(...ys), bottom = Math.min(...ys);
  const landmarks = Array.from({ length: 468 }, (_, i) => ({
    x: 0.15 + (pos(i).x - left) / (right - left) * 0.7,
    y: 0.1 + (top - pos(i).y) / (top - bottom) * 0.8, z: -pos(i).z / 4,
  }));
  const engine = load(path.join(root, 'engine.ts'));
  ui.set('photos', { frontal: { canvas: { width: 1000, height: 1000 }, aspect: 1, landmarks,
    frame: engine.frameFromLandmarks(landmarks), captureConfirmed: true } });
  ui.render();
  const target = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }), setPointerCapture() {} };
  const event = i => ({ currentTarget: target, clientX: landmarks[i].x * 1000,
    clientY: landmarks[i].y * 1000, button: 0, pointerId: 1, buttons: 1 });
  const photo = () => ui.query(n => n.props?.onPointerCancel)[0];
  photo().props.onPointerDown(event(205)); ui.render(); photo().props.onPointerUp();
  assert.equal(Object.keys(ui.get('bindings')).length, 0);
  ui.button('Simular y marcar').props.onClick(); ui.render();
  ui.button('Foto').props.onClick(); ui.render();
  photo().props.onPointerDown(event(205)); ui.render(); photo().props.onPointerUp(); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
  const id = Object.keys(ui.get('bindings'))[0], before = ui.get('markers')[0].position;
  photo().props.onPointerDown(event(205)); ui.render();
  photo().props.onPointerMove(event(50)); ui.render(); photo().props.onPointerUp(); ui.render();
  assert.notDeepEqual(ui.get('markers')[0].position, before);
  assert.ok(ui.get('bindings')[id]);
  ui.button('Deshacer').props.onClick(); ui.render();
  assert.deepEqual(ui.get('markers')[0].position, before);
  ui.button('Línea').props.onClick(); ui.render();
  photo().props.onPointerDown(event(50)); ui.render();
  photo().props.onPointerMove(event(205)); ui.render(); photo().props.onPointerUp(); ui.render();
  // La línea es entrada de aguja (sin dosis) + una punta con dosis en su extremo.
  assert.equal(Object.keys(ui.get('bindings')).length, 3);
  const lineId = Object.keys(ui.get('meta')).find(key => ui.get('meta')[key].entry);
  const tip = Object.values(ui.get('meta')).find(m => m.parent === lineId);
  assert.ok(lineId && tip && tip.tip === 0 && ui.get('meta')[lineId].dose === 0);
  photo().props.onPointerDown(event(205)); ui.render(); photo().props.onPointerCancel(); ui.render();
  photo().props.onPointerUp(); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 3);
});

test('visor dividido: registro único bidireccional, selección y undo entre genérico y máscara', () => {
  const ui = app();
  const engine = load(path.join(root, 'engine.ts'));
  const regions = load(path.join(root, 'faceRegions.ts'));
  const transfer = load(path.join(root, 'faceTransfer.ts'));
  const landmarks = Array.from({ length: 468 }, (_, i) => ({
    x: 0.5 + pos(i).x / 5.3, y: 0.5 - pos(i).y / 5.3, z: -pos(i).z / 5.3,
  }));
  const surface = engine.buildPersonalSurface(landmarks, 1, atlas.triangles, 1);
  const canvas = { width: 1400, height: 1400 };
  ui.set('photos', { frontal: { canvas, aspect: 1, landmarks,
    frame: engine.frameFromLandmarks(landmarks), captureConfirmed: true } });
  ui.set('personal', { view: 'frontal', canvas, glb: new ArrayBuffer(8), projection: surface.projection,
    surface, renderSurface: surface, regionMap: regions.buildFaceRegionMap(landmarks, atlas.triangles, 1, atlas.positions) });
  ui.button('Simular y marcar').props.onClick();
  ui.set('genericPreviewGlb', new ArrayBuffer(8)); ui.render();
  const splitControl = () => ui.query(n => n.type === 'input' && n.props?.['aria-label']?.startsWith('Visor dividido'))[0];
  splitControl().props.onChange({ target: { checked: true } }); ui.render();
  ui.button('Punto').props.onClick(); ui.render();
  const viewers = () => ui.query(n => n.type === clinical);
  assert.equal(viewers().length, 2);
  viewers()[0].props.onMarkerPlaced({ id: 'shared', position: pos(50) }); ui.render();
  assert.ok(viewers().every(viewer => viewer.props.editablePoints.length === 1 && viewer.props.editablePoints[0].id === 'shared'));
  const address = ui.get('bindings').shared.paths[0][0];
  const expected = transfer.surfacePoint(address, surface, atlas);
  const displayed = viewers()[1].props.editablePoints[0];
  assert.ok(Math.hypot(displayed.x - expected.x, displayed.y - expected.y, displayed.z - expected.z) < 1e-8);
  const section = ui.query(n => n.props?.['aria-label'] === 'Foto personal en 3D')[0];
  section.props.onPointerDownCapture(); ui.render();
  assert.equal(ui.get('modelKind'), 'personal');
  const next = transfer.surfacePoint(transfer.locateModelPoint(pos(205), atlas), surface, atlas);
  viewers()[1].props.onEditablePointMoved('shared', next); ui.render();
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
  const genericPoint = viewers()[0].props.editablePoints[0];
  assert.ok(Math.hypot(genericPoint.x - pos(205).x, genericPoint.y - pos(205).y, genericPoint.z - pos(205).z) < 1e-6);
  viewers()[1].props.onEditablePointClicked('shared'); ui.render();
  assert.ok(viewers().every(viewer => viewer.props.selectedPointId === 'shared'));
  ui.button('Deshacer').props.onClick(); ui.render();
  assert.ok(Math.hypot(viewers()[0].props.editablePoints[0].x - pos(50).x,
    viewers()[0].props.editablePoints[0].y - pos(50).y, viewers()[0].props.editablePoints[0].z - pos(50).z) < 1e-6);
  splitControl().props.onChange({ target: { checked: false } }); ui.render();
  assert.equal(viewers().length, 1);
  assert.equal(Object.keys(ui.get('bindings')).length, 1);
});
