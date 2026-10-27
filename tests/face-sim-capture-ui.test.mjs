import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import * as engine from '../src/lab/faceSim/engine.ts';

const require = createRequire(import.meta.url);
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
