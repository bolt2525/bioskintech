import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import * as engine from '../src/lab/faceSim/engine.ts';
import * as faceContour from '../src/lab/faceSim/faceContour.ts';
import * as faceRegions from '../src/lab/faceSim/faceRegions.ts';
import * as estimatedHead from '../src/lab/faceSim/estimatedHead.ts';
import * as faceTransfer from '../src/lab/faceSim/faceTransfer.ts';
import * as anatomicalAnnotations from '../src/lab/faceSim/anatomicalAnnotations.ts';
import * as photoValidation from '../src/lab/faceSim/photoValidation.ts';
import * as detection from '../src/lab/faceSim/detection.ts';
import * as regionMesh from '../src/lab/faceSim/regionMesh.ts';
import * as estimatedHair from '../src/lab/faceSim/estimatedHair.ts';
import * as multiViewHead from '../src/lab/faceSim/multiViewHead.ts';
const templateHead = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(
  readFileSync(new URL('../src/lab/faceSim/templateHead.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText.replaceAll("'./estimatedHead'", `'${new URL('../src/lab/faceSim/estimatedHead.ts', import.meta.url)}'`)).toString('base64')}`);

const require = createRequire(import.meta.url);
const genericFaceAtlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lab/faceSim/FaceSimLab.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stateNames = [...source.slice(source.indexOf('export default function FaceSimLab')).matchAll(/const \[(\w+),[^\]]+\] = useState/g)].map(match => match[1]);
const localCache = new Map();
function loadLocal(file) {
  if (localCache.has(file)) return localCache.get(file);
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
  const exports = {};
  localCache.set(file, exports);
  vm.runInNewContext(ts.transpileModule(
    readFileSync(file, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } },
  ).outputText, { exports, console, Float32Array, Uint32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
    require(name) {
      if (name === './engine' || name === './engine.ts') return engine;
      if (!name.startsWith('.')) return require(name);
      const base = path.resolve(path.dirname(file), name);
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`].find(p => existsSync(p));
      if (!target) throw new Error(`Missing local module ${base}`);
      return loadLocal(target);
    },
  }, { filename: file });
  return exports;
}
const helper = name => loadLocal(fileURLToPath(new URL(`../src/lab/faceSim/${name}.ts`, import.meta.url)));
const injectablePreview = helper('injectablePreview');
const injectableLocalRecord = helper('injectableLocalRecord');
const panelsModule = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lab/faceSim/MarkingPanels.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, {
  exports: panelsModule, console,
  require: name => name === 'react'
    ? { ...React, useId: () => 'test-id', useState: v => [typeof v === 'function' ? v() : v, () => {}], useRef: v => ({ current: v }), useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn }
    : name.startsWith('.') ? loadLocal([path.resolve(fileURLToPath(new URL('../src/lab/faceSim/', import.meta.url)), name)].flatMap(b => [b, `${b}.ts`, `${b}.tsx`]).find(f => existsSync(f))) : require(name),
});
const panels = new Set(Object.values(panelsModule).filter(v => typeof v === 'function'));
const expand = n => Array.isArray(n) ? n.map(expand) : !n || typeof n !== 'object' ? n
  : panels.has(n.type) ? expand(n.type(n.props)) : n.props?.children === undefined ? n
    : { ...n, props: { ...n.props, children: expand(n.props.children) } };

function findAll(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => findAll(child, predicate));
  return [
    ...(predicate(tree) ? [tree] : []),
    ...findAll(tree.props?.children, predicate),
  ];
}
const text = tree => {
  if (Array.isArray(tree)) return tree.map(text).join('');
  return tree && typeof tree === 'object' ? text(tree.props?.children) : String(tree ?? '');
};

function lab() {
  const states = [], refs = [];
  let stateCursor = 0, refCursor = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const i = stateCursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
    },
    useRef(initial) {
      const i = refCursor++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
    useEffect() {},
    useMemo: fn => fn(),
    useCallback: fn => fn,
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, console, Date, ArrayBuffer,
    require: name => {
      if (name === 'react') return hooks;
      if (name === './engine') return engine;
      if (name === './MarkingPanels') return panelsModule;
      if (name === './injectablePreview') return injectablePreview;
      if (name === './injectableLocalRecord') return injectableLocalRecord;
      if (name === './faceContour') return faceContour;
      if (name === './faceRegions') return faceRegions;
      if (name === './estimatedHead') return estimatedHead;
      if (name === './faceTransfer') return faceTransfer;
      if (name === './anatomicalAnnotations') return anatomicalAnnotations;
      if (name === './photoValidation') return photoValidation;
      if (name === './detection') return detection;
      if (name === './regionMesh') return regionMesh;
      if (name === './estimatedHair') return estimatedHair;
      if (name === './multiViewHead') return multiViewHead;
      if (name === './templateHead') return templateHead;
      if (name === './photoHead') return { segmentPhotoHeads: async inputs => inputs.map(input => ({
        ...input, width: 64, height: 64, mask: new Float32Array(64 * 64).fill(1), hair: new Float32Array(64 * 64), texture: input.canvas,
      })) };
      if (name.endsWith('/Tooltip')) return { Tooltip: ({ children }) => children };
      if (name === './genericFaceAtlas.json') return { default: genericFaceAtlas };
      if (name === '@mediapipe/tasks-vision') return { FaceLandmarker };
      if (name === './personalSurfaceGlb') return { personalSurfaceToGlb: async () => new ArrayBuffer(8) };
      if (name.endsWith('Clinical3DViewer')) return { default: () => null };
      if (name.endsWith('injectables.json')) return { default: [] };
      if (name.startsWith('./')) {
        const base = fileURLToPath(new URL(`../src/lab/faceSim/${name.slice(2)}`, import.meta.url));
        const file = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p));
        if (file) return loadLocal(file);
      }
      return require(name);
    },
  });
  states[stateNames.indexOf('genericPreviewGlb')] = new ArrayBuffer(8);
  return {
    states,
    state(name) { return states[stateNames.indexOf(name)]; },
    set(name, value) { states[stateNames.indexOf(name)] = value; },
    render() {
      states[stateNames.indexOf('genericPreviewAfter')] = states[stateNames.indexOf('preview')]?.after ?? true;
      stateCursor = 0; refCursor = 0; return expand(exports.default());
    },
    photos(photos) { states[stateNames.indexOf('photos')] = photos; },
    pending(pending) { states[stateNames.indexOf('pendingPhotos')] = pending; },
  };
}

function photo() {
  return {
    canvas: { width: 600, height: 800 }, aspect: 0.75, frame: engine.DEFAULT_FRAME, captureConfirmed: true,
    pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1],
    landmarks: Array.from({ length: 478 }, (_, i) => ({
      x: 0.2 + (i % 22) / 21 * 0.6,
      y: 0.15 + Math.floor(i / 22) / 21 * 0.7,
      z: -0.02,
    })),
  };
}
const calculate = tree => findAll(tree, n => n.type === 'button' && text(n).startsWith('Calcular superficie'))[0];
const slotIds = ['frontal', 'izquierda', 'derecha', 'extra_a', 'extra_b'];
const viewers = tree => findAll(tree, n => typeof n.props?.onMarkerPlaced === 'function');
const renderedMarks = viewer => viewer.props.editablePoints.map(({ id, x, y, z }) => ({ id, position: { x, y, z } }));
const button = (tree, label) => findAll(tree, n => n.type === 'button' && (text(n) === label || n.props?.['aria-label'] === label))[0];
const openEditor = app => { button(app.render(), 'Simular y marcar').props.onClick(); return app.render(); };
const openAppearance = app => {
  openEditor(app); button(app.render(), 'Morfología, piel y capas').props.onClick(); return app.render();
};
const openCapture = app => { button(app.render(), 'Capturas').props.onClick(); return app.render(); };

test('malla predeterminada permite hover sin añadir marcas y revisión abre modal independiente', () => {
  const app = lab();
  let tree = app.render();
  assert.equal(viewers(tree).length, 0, 'Capturas no monta un editor de tratamientos');
  openEditor(app); app.set('meshVisible', true); tree = app.render();
  const viewer = viewers(tree)[0];
  assert.equal(viewer.props.activeTool, 'none');
  assert.equal(viewer.props.anatomicalOverlay.wireframe, true);
  assert.ok(viewer.props.anatomicalOverlay.labels.length > genericFaceAtlas.triangles.length / 3, 'refinamiento selectivo de límites');
  const colors = viewer.props.anatomicalOverlay.colors;
  for (let i = 0; i < colors.length; i += 9) {
    assert.deepEqual(colors.slice(i, i + 3), colors.slice(i + 3, i + 6));
    assert.deepEqual(colors.slice(i, i + 3), colors.slice(i + 6, i + 9), 'sin degradado hacia otra zona');
  }
  viewer.props.anatomicalOverlay.onHover('Mentón');
  assert.match(text(app.render()), /Mentón.*Piel.*0 U/);
  openCapture(app);
  app.photos({ frontal: photo() });
  tree = app.render();
  button(tree, 'Revisar frente, sienes y mentón').props.onClick();
  const modal = findAll(app.render(), n => n.props?.onApply && n.props?.onClose && n.props?.triangles)[0];
  assert.ok(modal);
  modal.props.onClose();
  assert.equal(findAll(app.render(), n => n.props?.onApply && n.props?.onClose && n.props?.triangles).length, 0);
  openEditor(app);
  assert.equal(viewers(app.render()).length, 1, 'solo un viewport de marcación activo');
});

test('no calcula capturas sin revisar; la confirmación no permite fusionar proporciones incompatibles', async () => {
  const app = lab(); app.render();
  app.photos({ frontal: { ...photo(), captureConfirmed: false } });
  let tree = app.render();
  assert.equal(calculate(tree).props.disabled, true);
  calculate(tree).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(text(app.render()), /Revisa y confirma/);
  findAll(app.render(), n => n.props?.['aria-label'] === 'Confirmar captura Frontal')[0].props.onChange({ target: { checked: true } });
  assert.equal(calculate(app.render()).props.disabled, false);
  const a = photo(), b = photo();
  for (const [left, right] of [[98, 327], [172, 397], [50, 280], [234, 454]]) {
    const center = (b.landmarks[left].x + b.landmarks[right].x) / 2;
    for (const i of [left, right]) b.landmarks[i].x = center + (b.landmarks[i].x - center) * 1.8;
  }
  app.photos({ frontal: a, izquierda: b });
  tree = app.render();
  assert.equal(calculate(tree).props.disabled, true);
  assert.match(text(tree), /No se fusionarán/);
  calculate(tree).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(viewers(app.render()).length, 0);
});

test('cada foto abre su revisión; la frente confirmada en frontal se ofrece en las demás vistas', () => {
  const app = lab(); app.render();
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
  const landmarks = fixture.landmarks.map(([x, y, z]) => ({ x, y, z }));
  const make = () => ({ ...photo(), canvas: { width: 600, height: 800 }, landmarks, detectedLandmarks: landmarks, aspect: fixture.aspect, frame: engine.frameFromLandmarks(landmarks) });
  app.photos({ frontal: make(), izquierda: make(), extra_a: make() });
  app.set('boundaryReview', ['frontal']);
  const modal = () => findAll(app.render(), n => n.props?.onApply && n.props?.onClose && n.props?.triangles)[0];
  assert.equal(modal().props.title, 'Frontal');
  assert.equal(modal().props.reference, null);
  const top = landmarks[10], brow = landmarks[9], chin = landmarks[152];
  const dx = (top.x - brow.x) * fixture.aspect, dy = top.y - brow.y, length = Math.hypot(dx, dy);
  const h = Math.hypot((top.x - chin.x) * fixture.aspect, top.y - chin.y);
  const point = { x: top.x + dx / length * h * 0.1 / fixture.aspect, y: top.y + dy / length * h * 0.1 };
  const extended = faceContour.extendVisibleForehead(landmarks, point, fixture.aspect, genericFaceAtlas.triangles);
  modal().props.onApply(extended, true, point);
  modal().props.onClose();
  assert.equal(app.state('photos').frontal.foreheadReviewed, true);
  assert.equal(app.state('photos').izquierda.foreheadReviewed, undefined, 'no se confirma otra vista en silencio');
  assert.deepEqual([...app.state('boundaryReview')], ['izquierda', 'extra_a']);
  const next = modal();
  assert.equal(next.props.title, 'Ángulo A');
  assert.ok(Math.hypot(next.props.reference.x - point.x, next.props.reference.y - point.y) < 1e-9);
  next.props.onApply(extended, true, point);
  next.props.onClose();
  assert.equal(app.state('photos').izquierda.foreheadReviewed, true);
  assert.equal(app.state('foreheadReference').slot, 'frontal', 'la frontal sigue como referencia');
  assert.equal(modal().props.title, 'Foto 4');
  modal().props.onClose();
  assert.equal(modal(), undefined);
});

test('ampliar frente exige revisar piel visible y no convierte el clic en tratamiento', async () => {
  const app = lab(); app.render();
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
  const landmarks = fixture.landmarks.map(([x, y, z]) => ({ x, y, z }));
  const source = { ...photo(), landmarks, aspect: fixture.aspect, frame: engine.frameFromLandmarks(landmarks) };
  app.photos({ frontal: source });
  button(app.render(), 'Elegir límite en foto').props.onClick();
  const top = landmarks[10], brow = landmarks[9], chin = landmarks[152];
  const dx = (top.x - brow.x) * fixture.aspect, dy = top.y - brow.y, length = Math.hypot(dx, dy);
  const h = Math.hypot((top.x - chin.x) * fixture.aspect, top.y - chin.y);
  const target = { x: top.x + dx / length * h * 0.1 / fixture.aspect, y: top.y + dy / length * h * 0.1 };
  const wrapper = findAll(app.render(), n => n.props?.onPointerDown && n.props?.onPointerUp)[0];
  wrapper.props.onPointerDown({ button: 0, clientX: target.x, clientY: target.y,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) } });
  let tree = app.render();
  assert.equal(button(tree, 'Aplicar frente revisada').props.disabled, true);
  assert.equal(app.state('markers').length, 0);
  findAll(tree, n => n.props?.['aria-label'] === 'Confirmar piel visible en frente')[0].props.onChange({ target: { checked: true } });
  button(app.render(), 'Aplicar frente revisada').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = app.render();
  assert.equal(app.state('photos').frontal.foreheadReviewed, true);
  assert.ok(Math.abs(app.state('photos').frontal.landmarks[10].y - target.y) < 1e-12);
  assert.equal(app.state('markers').length, 0);
  assert.match(text(tree), /Banda frontal ampliada/);
});

test('capa de simulación mantiene advertencia, fuente y geometría separada de marcaciones', () => {
  const app = lab();
  let tree = app.render();
  const select = findAll(tree, n => n.props?.['aria-label'] === 'Capa de referencia')[0];
  select.props.onChange({ target: { value: 'attention' } });
  tree = app.render();
  assert.match(text(tree), /no detección vascular/);
  assert.match(text(tree), /NO zonas seguras/);
  assert.match(text(tree), /no localizan arterias, venas, nervios ni su profundidad/);
  assert.equal(findAll(tree, n => n.type === 'p' && text(n) === 'SIMULACIÓN · No detecta vasos ni certifica zonas seguras.').length, 1);
  assert.equal(findAll(tree, n => n.type === 'a' && n.props.href === 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9067448/').length, 1);
  openEditor(app); app.set('meshVisible', true);
  tree = app.render();
  assert.equal(viewers(tree)[0].props.anatomicalOverlay.positions.length, viewers(tree)[0].props.anatomicalOverlay.labels.length * 9);
  assert.equal(app.state('markers').length, 0);
  select.props.onChange({ target: { value: 'none' } });
  const hiddenMesh = viewers(app.render())[0].props.anatomicalOverlay;
  assert.ok(hiddenMesh.positions.length > 0, 'ocultar aristas conserva geometría semántica para hover');
  assert.equal(hiddenMesh.opacity, 0, 'sin aristas ni triángulos coloreados visibles');
  assert.equal(typeof hiddenMesh.zoneAt, 'function');
  assert.equal(hiddenMesh.skin.visible, true);
});

test('marcaciones compartidas sobreviven a modo, reconstrucción y retirada de foto; deshacer restaura bindings', async () => {
  const app = lab();
  let tree = openEditor(app);
  button(tree, 'Punto').props.onClick();
  tree = app.render();
  const seed = genericFaceAtlas.triangles.indexOf(11);
  const address = { triangle: Math.floor(seed / 3), weights: [0.2, 0.3, 0.5] };
  const position = faceTransfer.modelPoint(address, genericFaceAtlas);
  assert.ok(position);
  viewers(tree)[0].props.onMarkerPlaced({ id: 'shared', position, normal: { x: 0, y: 0, z: 1 }, pathology: 'filler' });
  tree = app.render();
  assert.equal(renderedMarks(viewers(tree)[0]).length, 1);
  const initial = renderedMarks(viewers(tree)[0])[0].position;
  const p = photo();
  p.landmarks = Array.from({ length: 478 }, (_, i) => ({
    x: 0.5 + genericFaceAtlas.positions[(i % 468) * 3] * 0.16,
    y: 0.5 - genericFaceAtlas.positions[(i % 468) * 3 + 1] * 0.16,
    z: -genericFaceAtlas.positions[(i % 468) * 3 + 2] * 0.16,
  }));
  app.photos({ frontal: p });
  calculate(openCapture(app)).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = openEditor(app);
  assert.equal(viewers(tree).length, 1);
  assert.equal(renderedMarks(viewers(tree)[0])[0].id, 'shared');
  assert.deepEqual(app.state('markers')[0].position, initial);
  const personal = renderedMarks(viewers(tree)[0])[0];
  assert.equal(viewers(tree)[0].props.surfaceConstraint.accepts(personal.position), true);
  viewers(tree)[0].props.onMarkerPlaced({ ...personal, id: 'from-personal' });
  tree = app.render();
  assert.equal(renderedMarks(viewers(tree)[0]).length, 2);
  button(tree, 'Foto').props.onClick();
  tree = app.render();
  assert.equal(viewers(tree).length, 0, 'la foto sustituye, no duplica, el visor 3D');
  assert.equal(app.state('markers').length, 2);
  const photoWrapper = root => findAll(root, n => n.props?.onPointerDown && n.props?.onPointerUp)[0];
  photoWrapper(tree).props.onPointerDown({
    clientX: p.landmarks[1].x, clientY: p.landmarks[1].y, pointerId: 1, button: 0,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }), setPointerCapture() {} },
  });
  photoWrapper(app.render()).props.onPointerUp();
  tree = app.render();
  assert.equal(app.state('markers').length, 3);
  button(tree, 'Genérico').props.onClick();
  calculate(openCapture(app)).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = openEditor(app);
  assert.ok(viewers(tree).every(v => renderedMarks(v).length === 3));
  assert.equal(viewers(tree)[0].props.surfaceConstraint.accepts({ x: 3, y: 0, z: 0 }), false);
  viewers(tree)[0].props.onMarkerPlaced({ ...personal, id: 'ear', position: { x: 3, y: 0, z: 0 } });
  tree = app.render();
  assert.match(text(tree), /Marcación rechazada/);
  assert.equal(renderedMarks(viewers(tree)[0]).length, 3);
  button(tree, 'Deshacer').props.onClick();
  tree = app.render();
  assert.equal(renderedMarks(viewers(tree)[0]).length, 2);
  button(tree, 'Deshacer').props.onClick();
  tree = app.render();
  assert.equal(renderedMarks(viewers(tree)[0]).length, 1);
  button(tree, 'Limpiar').props.onClick();
  assert.equal(renderedMarks(viewers(app.render())[0]).length, 0);
  button(app.render(), 'Deshacer').props.onClick();
  tree = app.render();
  assert.equal(renderedMarks(viewers(tree)[0]).length, 1);
  findAll(openCapture(app), n => n.props?.['aria-label'] === 'Retirar Frontal')[0].props.onClick();
  assert.equal(renderedMarks(viewers(openEditor(app))[0])[0].id, 'shared');
});

test('captura progresiva: tres entradas principales y dos opcionales, sin exigir cinco fotos', () => {
  const app = lab(), tree = app.render();
  const inputs = findAll(tree, n => n.type === 'input' && n.props.type === 'file');
  assert.equal(inputs.length, 6);
  assert.equal(inputs.filter(n => n.props.multiple).length, 1);
  assert.ok(inputs.filter(n => !n.props.multiple).every(n => n.props['aria-label'].startsWith('Cargar ')));
  assert.equal(calculate(tree).props.disabled, true);
  const optional = findAll(tree, n => n.type === 'details' && text(n).includes('Añadir fotos 4 y 5'))[0];
  assert.equal(findAll(optional, n => n.type === 'input' && n.props.type === 'file').length, 2);
  for (let count = 1; count <= 5; count++) {
    app.photos(Object.fromEntries(slotIds.slice(0, count).map(id => [id, photo()])));
    const current = app.render();
    assert.equal(calculate(current).props.disabled, false);
    assert.equal(text(calculate(current)), `Calcular superficie con ${count} foto(s)`);
    assert.match(text(current), new RegExp(`${count} de 5 fotos cargadas`));
  }
});

test('selector múltiple rechaza más de tres archivos con progreso explícito sin cambiar fotos', async () => {
  const app = lab(); app.render();
  const input = findAll(app.render(), n => n.type === 'input' && n.props.multiple)[0];
  input.props.onChange({ target: { files: [{}, {}, {}, {}], value: 'selección' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.state('captureProgress'), /como máximo 3/);
  assert.deepEqual(Object.keys(app.state('photos')), []);
  assert.equal(app.state('batchBusy'), false);
});

test('comparación slider y doble reutilizan Antes original y Después; el registro y las dosis no cambian', () => {
  const app = lab(); openEditor(app);
  app.set('markTab', 'revisar');
  app.set('genericBeforeGlb', new ArrayBuffer(8));
  const record = { 'test-point': { mode: 'toxina', dose: 7, zone: 'Frente' } };
  app.set('meta', record);
  button(app.render(), 'Doble visor').props.onClick();
  let tree = app.render();
  let component = findAll(tree, n => n.props?.mode === 'doble' && n.props?.before && n.props?.after)[0];
  assert.ok(component);
  const pair = component.type(component.props);
  const models = viewers(pair);
  assert.equal(models.length, 2);
  assert.equal(models[0].props.modelData, app.state('genericBeforeGlb'));
  assert.equal(models[1].props.modelData, app.state('genericPreviewGlb'));
  assert.ok(models.every(n => n.props.readOnly && n.props.activeTool === 'none'));
  assert.equal(models[0].props.cameraSync, models[1].props.cameraSync, 'cámara compartida solo entre visores comparativos');
  const sharedCamera = models[0].props.cameraSync;
  button(tree, 'Deslizador').props.onClick();
  tree = app.render();
  const slider = findAll(tree, n => n.props?.['aria-label'] === 'Comparación Antes / Después')[0];
  slider.props.onChange({ target: { value: '0.75' } });
  tree = app.render();
  component = findAll(tree, n => n.props?.mode === 'slider' && n.props?.before)[0];
  assert.ok(findAll(component.type(component.props), n => n.props?.style?.clipPath === 'inset(0 25% 0 0)').length);
  assert.equal(app.state('meta'), record);
  assert.equal(app.state('meta')['test-point'].dose, 7);
  button(tree, 'Vista actual').props.onClick();
  assert.equal(app.state('comparison'), 'actual');
  assert.equal(viewers(app.render()).length, 1);
  assert.equal(viewers(app.render())[0].props.cameraSync, undefined, 'visor normal no comparte cámara');
  button(app.render(), 'Doble visor').props.onClick();
  const reopened = findAll(app.render(), n => n.props?.mode === 'doble' && n.props?.before)[0];
  assert.equal(viewers(reopened.type(reopened.props))[0].props.cameraSync, sharedCamera, 'conserva el objeto al cambiar formato');
});

test('la detección pendiente bloquea el cálculo hasta incluir todas las referencias cargadas', () => {
  const app = lab();
  app.render();
  app.photos({ frontal: photo(), izquierda: photo() });
  app.pending({ extra_a: true });
  let tree = app.render();
  assert.equal(calculate(tree).props.disabled, true);
  assert.equal(findAll(tree, n => n.type === 'button' && text(n) === 'Personal (foto)')[0].props.disabled, true);
  app.pending({ extra_a: false });
  tree = app.render();
  assert.equal(calculate(tree).props.disabled, false);
});

test('retirar referencias permite volver de cinco a una foto sin bloquear el cálculo rápido', () => {
  const app = lab();
  app.render();
  app.photos(Object.fromEntries(slotIds.map(id => [id, photo()])));
  for (const [label, expected] of [['Foto 5', 4], ['Foto 4', 3], ['Ángulo B', 2], ['Ángulo A', 1]]) {
    const button = findAll(app.render(), n => n.type === 'button' && n.props['aria-label'] === `Retirar ${label}`)[0];
    button.props.onClick();
    const tree = app.render();
    assert.equal(text(calculate(tree)), `Calcular superficie con ${expected} foto(s)`);
    assert.equal(calculate(tree).props.disabled, false);
  }
});

test('una foto sin detección conserva su error visible y no se cuenta como referencia útil', () => {
  const app = lab();
  app.render();
  app.photos({ frontal: photo(), extra_a: { ...photo(), landmarks: undefined, detectionError: 'Imagen sin rostro detectable.' } });
  const tree = app.render();
  assert.equal(text(calculate(tree)), 'Calcular superficie con 1 foto(s)');
  assert.match(text(tree), /2 de 5 fotos cargadas/);
  assert.match(text(tree), /Imagen sin rostro detectable/);
});

test('retirar la frontal permite calcular desde otra foto principal detectada', () => {
  const app = lab();
  app.render();
  app.photos({ frontal: photo(), izquierda: photo() });
  findAll(app.render(), n => n.type === 'button' && n.props['aria-label'] === 'Retirar Frontal')[0].props.onClick();
  assert.equal(calculate(app.render()).props.disabled, false);
});

test('una foto puede generar la superficie personal sin esperar referencias complementarias', async () => {
  const app = lab();
  app.render();
  app.photos({ frontal: photo() });
  calculate(app.render()).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = app.render();
  assert.match(text(tree), /Superficie 3D personal generada desde la foto Frontal/);
  assert.match(text(tree), /Cálculo rápido con una foto/);
  assert.equal(viewers(tree).length, 0, 'el cálculo no convierte Capturas en editor');
  const personalViewer = viewers(openEditor(app))[0];
  assert.equal(personalViewer.props.cameraPreset, 'face-surface');
});

test('cabeza estimada: tres archivos sin cobertura bilateral no habilitan un cierre engañoso', async () => {
  const app = lab();
  app.render();
  app.photos({ frontal: photo() });
  let head = findAll(app.render(), n => n.type === 'button' && text(n).startsWith('Cabeza estimada'))[0];
  assert.equal(head.props.disabled, true);
  app.photos({ frontal: photo(), izquierda: photo(), derecha: photo() });
  head = findAll(app.render(), n => n.type === 'button' && text(n).startsWith('Cabeza estimada'))[0];
  assert.equal(head.props.disabled, false);
  head.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = app.render();
  assert.match(text(tree), /requiere al menos tres fotos útiles que cubran ambos lados/);
  assert.equal(app.state('personal'), null);
  assert.equal(viewers(tree).length, 0);
});

test('cabeza estimada se transmite completa a Simular sin reemplazar la superficie de registro', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
  const base = { ...photo(), aspect: fixture.aspect, landmarks: fixture.landmarks.map(([x, y, z]) => ({ x, y, z })) };
  const profile = angle => {
    const c = Math.cos(angle), s = Math.sin(angle), aspect = 0.8;
    return { ...base, aspect, pose: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -40, 1],
      landmarks: base.landmarks.map(p => ({
        x: (0.4 + c * (p.x - 0.5) * base.aspect - s * p.z * base.aspect) / aspect, y: p.y, z: 0,
      })) };
  };
  const app = lab(); app.render();
  app.photos({ frontal: base, izquierda: profile(0.7), derecha: profile(-0.7) });
  const head = button(app.render(), 'Cabeza estimada · 3+ fotos');
  assert.equal(head.props.disabled, false);
  head.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = app.render();
  assert.match(text(tree), /Cabeza de plantilla anatómica/);
  const simulator = findAll(openAppearance(app), n => n.props && Object.hasOwn(n.props, 'surface') && Object.hasOwn(n.props, 'photo'))[0];
  assert.equal(simulator.props.surface.observedIndexCount, 852 * 3);
  assert.ok(simulator.props.surface.indices.length > 852 * 3 * 2);
  button(openCapture(app), 'Genérico').props.onClick();
  openAppearance(app);
  const genericSimulator = findAll(app.render(), n => n.props && Object.hasOwn(n.props, 'surface') && Object.hasOwn(n.props, 'photo'))[0];
  assert.equal(genericSimulator.props.surface, undefined, 'la selección genérica también gobierna Simular');
  assert.equal(genericSimulator.props.photo, undefined, 'no aplica fotos sin registro a la cabeza genérica');
});

test('Inyectables conserva malla y planos propios sin compartir estado con morfología', () => {
  const app = lab(); openEditor(app); app.set('meshVisible', true); let tree = app.render();
  const original = viewers(tree)[0].props.anatomicalOverlay.positions.slice();
  tree = openCapture(app);
  const plane = findAll(tree, n => n.props?.['aria-label'] === 'Plano visual')[0];
  plane.props.onChange({ target: { value: 'deep' } });
  tree = app.render();
  openEditor(app); app.set('meshVisible', true);
  assert.notDeepEqual(viewers(app.render())[0].props.anatomicalOverlay.positions, original);
  tree = openCapture(app);
  const label = findAll(tree, n => n.type === 'label' && text(n) === 'Mostrar mallado de zonas')[0];
  findAll(label, n => n.type === 'input')[0].props.onChange({ target: { checked: false } });
  openEditor(app);
  const semanticOverlay = viewers(app.render())[0].props.anatomicalOverlay;
  assert.ok(semanticOverlay.positions.length > 0, 'el hover permanece disponible sin aristas');
  assert.equal(semanticOverlay.opacity, 0);
  semanticOverlay.onHover('Mentón · Derecha del paciente');
  assert.match(text(app.render()), /Mentón · Derecha del paciente/);
  openAppearance(app);
  const simulator = () => findAll(app.render(), n => n.props && Object.hasOwn(n.props, 'surface') && Object.hasOwn(n.props, 'photo'))[0];
  for (const prop of ['showMesh', 'plane', 'onMeshChange', 'onPlaneChange', 'anatomyDisplay', 'onAnatomyDisplayChange']) {
    assert.equal(Object.hasOwn(simulator().props, prop), false, `${prop} no se comparte con morfología`);
  }
  findAll(openCapture(app), n => n.props?.['aria-label'] === 'Capa de referencia')[0].props.onChange({ target: { value: 'none' } });
  openAppearance(app);
  openEditor(app);
  button(app.render(), 'Marcaciones e inyectables').props.onClick();
  const controls = findAll(app.render(), n => typeof n.props?.onMeshChange === 'function')[0];
  assert.ok(controls, 'Inyectables mantiene su control propio');
  controls.props.onMeshChange(true);
  assert.equal(findAll(app.render(), n => typeof n.props?.onMeshChange === 'function')[0].props.showMesh, true);
});

test('elegir Genérico cancela el cálculo pendiente y no permite una selección personal tardía', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
  const app = lab(); app.render();
  app.photos({ frontal: { ...photo(), aspect: fixture.aspect, landmarks: fixture.landmarks.map(([x, y, z]) => ({ x, y, z })) } });
  calculate(app.render()).props.onClick();
  button(app.render(), 'Genérico').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(text(app.render()), /Modelo original seleccionado/);
  const simulator = findAll(openAppearance(app), n => n.props && Object.hasOwn(n.props, 'surface') && Object.hasOwn(n.props, 'photo'))[0];
  assert.equal(simulator.props.surface, undefined);
});

test('la máscara calculada en Capturas llega al grupo avanzado sin sustituirse por el atlas genérico', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
  const app = lab(); app.render();
  app.photos({ frontal: { ...photo(), aspect: fixture.aspect, landmarks: fixture.landmarks.map(([x, y, z]) => ({ x, y, z })) } });
  calculate(app.render()).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const simulator = findAll(openAppearance(app), n => n.props && Object.hasOwn(n.props, 'surface') && Object.hasOwn(n.props, 'photo'))[0];
  assert.ok(simulator.props.surface);
  assert.equal(simulator.props.surface.indices.length, 852 * 3);
  assert.ok(simulator.props.photo);
});

test('editar contorno expone 36 referencias y pasa a foto sin crear un tratamiento', () => {
  const app = lab();
  app.render();
  app.photos({ frontal: photo() });
  const select = findAll(app.render(), n => n.type === 'select' && n.props['aria-label'] === 'Punto del contorno')[0];
  assert.equal(findAll(select, n => n.type === 'option').length, 37);
  select.props.onChange({ target: { value: '152' } });
  const tree = app.render();
  assert.match(text(tree), /Aplicar contorno/);
  assert.equal(app.state('workMode'), 'foto');
  assert.equal(findAll(tree, n => n.type === 'ul' && n.props['aria-label'] === 'Elementos marcados').length, 0);
});
