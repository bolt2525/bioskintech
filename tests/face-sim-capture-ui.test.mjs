import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const require = createRequire(import.meta.url);
const genericFaceAtlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lab/faceSim/FaceSimLab.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

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
      if (name === './faceContour') return faceContour;
      if (name === './faceRegions') return faceRegions;
      if (name === './estimatedHead') return estimatedHead;
      if (name === './faceTransfer') return faceTransfer;
      if (name === './anatomicalAnnotations') return anatomicalAnnotations;
      if (name === './genericFaceAtlas.json') return { default: genericFaceAtlas };
      if (name === '@mediapipe/tasks-vision') return { FaceLandmarker };
      if (name === './personalSurfaceGlb') return { personalSurfaceToGlb: async () => new ArrayBuffer(8) };
      if (name.endsWith('Clinical3DViewer')) return { default: () => null };
      if (name.endsWith('injectables.json')) return { default: [] };
      return require(name);
    },
  });
  return {
    states,
    render() { stateCursor = 0; refCursor = 0; return exports.default(); },
    photos(photos) { states[0] = photos; },
    pending(pending) { states[1] = pending; },
  };
}

function photo() {
  return {
    canvas: { width: 600, height: 800 }, aspect: 0.75, frame: engine.DEFAULT_FRAME,
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
const button = (tree, label) => findAll(tree, n => n.type === 'button' && text(n) === label)[0];

test('capa educativa mantiene advertencia, fuente y geometría separada de marcaciones', () => {
  const app = lab();
  let tree = app.render();
  const select = findAll(tree, n => n.props?.['aria-label'] === 'Capa de referencia')[0];
  select.props.onChange({ target: { value: 'attention' } });
  tree = app.render();
  assert.match(text(tree), /no detección vascular/);
  assert.match(text(tree), /NO zonas seguras/);
  assert.match(text(tree), /no localizan arterias, venas, nervios ni su profundidad/);
  assert.equal(findAll(tree, n => n.type === 'p' && text(n) === 'EDUCATIVO · No detecta vasos ni certifica zonas seguras.').length, 3);
  assert.equal(findAll(tree, n => n.type === 'a' && n.props.href === 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9067448/').length, 1);
  assert.equal(viewers(tree)[0].props.anatomicalOverlay.positions.length, genericFaceAtlas.triangles.length * 3);
  assert.equal(viewers(tree)[0].props.markers.length, 0);
  select.props.onChange({ target: { value: 'none' } });
  assert.equal(viewers(app.render())[0].props.anatomicalOverlay, undefined);
});

test('marcaciones compartidas sobreviven a modo, reconstrucción y retirada de foto; deshacer restaura bindings', async () => {
  const app = lab();
  let tree = app.render();
  const seed = genericFaceAtlas.triangles.indexOf(11);
  const address = { triangle: Math.floor(seed / 3), weights: [0.2, 0.3, 0.5] };
  const position = faceTransfer.modelPoint(address, genericFaceAtlas);
  assert.ok(position);
  viewers(tree)[0].props.onMarkerPlaced({ id: 'shared', position, normal: { x: 0, y: 0, z: 1 }, pathology: 'filler' });
  tree = app.render();
  assert.equal(viewers(tree)[0].props.markers.length, 1);
  const initial = viewers(tree)[0].props.markers[0].position;
  const p = photo();
  p.landmarks = Array.from({ length: 478 }, (_, i) => ({
    x: 0.5 + genericFaceAtlas.positions[(i % 468) * 3] * 0.16,
    y: 0.5 - genericFaceAtlas.positions[(i % 468) * 3 + 1] * 0.16,
    z: -genericFaceAtlas.positions[(i % 468) * 3 + 2] * 0.16,
  }));
  app.photos({ frontal: p });
  calculate(app.render()).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = app.render();
  assert.equal(viewers(tree).length, 2);
  assert.equal(viewers(tree)[1].props.markers[0].id, 'shared');
  assert.deepEqual(viewers(tree)[0].props.markers[0].position, initial);
  const personal = viewers(tree)[1].props.markers[0];
  assert.equal(viewers(tree)[1].props.surfaceConstraint.accepts(personal.position), true);
  viewers(tree)[1].props.onMarkerPlaced({ ...personal, id: 'from-personal' });
  tree = app.render();
  assert.equal(viewers(tree)[0].props.markers.length, 2);
  button(tree, 'Foto').props.onClick();
  tree = app.render();
  assert.ok(viewers(tree).every(v => v.props.readOnly && v.props.markers.length === 2));
  const photoWrapper = root => findAll(root, n => n.props?.onPointerDown && n.props?.onPointerUp)[0];
  photoWrapper(tree).props.onPointerDown({
    clientX: p.landmarks[1].x, clientY: p.landmarks[1].y, pointerId: 1, button: 0,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }), setPointerCapture() {} },
  });
  photoWrapper(app.render()).props.onPointerUp();
  tree = app.render();
  assert.ok(viewers(tree).every(v => v.props.markers.length === 3));
  button(tree, 'Modelo 3D').props.onClick();
  calculate(app.render()).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = app.render();
  assert.ok(viewers(tree).every(v => v.props.markers.length === 3));
  assert.equal(viewers(tree)[0].props.surfaceConstraint.accepts({ x: 3, y: 0, z: 0 }), false);
  viewers(tree)[0].props.onMarkerPlaced({ ...personal, id: 'ear', position: { x: 3, y: 0, z: 0 } });
  tree = app.render();
  assert.match(text(tree), /Marcación rechazada/);
  assert.equal(viewers(tree)[0].props.markers.length, 3);
  button(tree, 'Deshacer').props.onClick();
  tree = app.render();
  assert.equal(viewers(tree)[0].props.markers.length, 2);
  button(tree, 'Deshacer').props.onClick();
  tree = app.render();
  assert.equal(viewers(tree)[0].props.markers.length, 1);
  button(tree, 'Limpiar').props.onClick();
  assert.equal(viewers(app.render())[0].props.markers.length, 0);
  button(app.render(), 'Deshacer').props.onClick();
  tree = app.render();
  assert.equal(viewers(tree)[0].props.markers.length, 1);
  findAll(tree, n => n.props?.['aria-label'] === 'Retirar Frontal')[0].props.onClick();
  assert.equal(viewers(app.render())[0].props.markers[0].id, 'shared');
});

test('captura progresiva: tres entradas principales y dos opcionales, sin exigir cinco fotos', () => {
  const app = lab(), tree = app.render();
  const inputs = findAll(tree, n => n.type === 'input' && n.props.type === 'file');
  assert.equal(inputs.length, 5);
  assert.ok(inputs.every(n => n.props['aria-label'].startsWith('Cargar ')));
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
  assert.equal(findAll(tree, n => n.type === 'section' && n.props['aria-label'] === 'Foto personal en 3D').length, 1);
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
  assert.equal(findAll(tree, n => n.type === 'section' && n.props['aria-label'] === 'Foto personal en 3D').length, 1);
  assert.match(text(tree), /Carga una foto y calcula la superficie/);
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
  assert.equal(findAll(tree, n => n.type === 'button' && text(n) === 'Foto')[0].props['aria-pressed'], true);
  assert.equal(findAll(tree, n => n.type === 'ul' && n.props['aria-label'] === 'Elementos marcados').length, 0);
});
