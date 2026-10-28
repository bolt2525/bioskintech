import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as anatomy from '../src/lab/faceSim/anatomicalReference.ts';

// Mismo patrón del repo: TSX real transpilado + hooks deterministas; sin dependencias nuevas.
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/lab/faceSim/AnatomicalReferencePanel.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(n => find(n, predicate));
  return [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
};
const text = tree => Array.isArray(tree) ? tree.map(text).join('')
  : tree && typeof tree === 'object' ? text(tree.props?.children) : String(tree ?? '');
const button = (tree, label) => find(tree, n => n.type === 'button' && text(n) === label)[0];
const tick = () => new Promise(resolve => setImmediate(resolve));
const fakeCanvas = () => ({ width: 800, height: 1000, getContext: () => ({ drawImage() {} }) });
const surface = () => {
  const uvs = new Float32Array(478 * 2).fill(0.5);
  uvs.set([0.25, 0.3], 33 * 2);
  uvs.set([0.75, 0.3], 263 * 2);
  uvs.set([0.5, 0.8], 152 * 2);
  return uvs;
};
function component(hooks, loader) {
  const exports = {};
  vm.runInNewContext(code, {
    exports, AbortController, Error,
    require: name => name === 'react' ? hooks
      : name === './anatomicalReference' ? { ...anatomy, loadAnatomicalImage: loader }
        : name === './detection' ? { detectImageLandmarks: async () => globalThis.__detected ?? null }
        : require(name),
  });
  return exports.default;
}
function panel() {
  const slots = [], pendingEffects = [], emitted = [], loads = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    ...React,
    useId: () => 'anatomy-test',
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => {
        slots[i].value = typeof value === 'function' ? value(slots[i].value) : value;
      }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps, cleanup: previous?.cleanup };
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[i].cleanup = fn();
        });
      }
    },
  };
  const Component = component(hooks, (file, signal) => new Promise((resolve, reject) => {
    // Ignora abort a propósito para probar la protección adicional contra cargas tardías.
    loads.push({ file, signal, resolve, reject });
  }));
  const preview = fakeCanvas();
  let props = { surfaceUVs: surface(), onChange: value => emitted.push(value) };
  return {
    emitted, loads, preview,
    render(next = {}) {
      props = { ...props, ...next };
      cursor = 0;
      const tree = Component(props);
      for (const node of find(tree, n => n.type === 'canvas')) node.ref.current = preview;
      pendingEffects.splice(0).forEach(run => run());
      return tree;
    },
    unmount() { slots.forEach(slot => slot.cleanup?.()); },
  };
}
function selectFile(tree, file = { type: 'image/png', size: 1000 }) {
  const input = find(tree, n => n.type === 'input' && n.props.type === 'file')[0];
  const target = { files: [file], value: 'local.png' };
  input.props.onChange({ currentTarget: target });
  assert.equal(target.value, '', 'permite volver a seleccionar el mismo archivo');
}
async function loaded(app) {
  selectFile(app.render());
  const canvas = fakeCanvas();
  app.loads.at(-1).resolve(canvas);
  await tick();
  return { canvas, tree: app.render() };
}
function place(app, x, y) {
  const tree = app.render();
  const target = find(tree, n => n.type === 'button' && n.props['aria-label']?.startsWith('Colocar'))[0];
  target.props.onPointerDown({
    button: 0, clientX: x * 400, clientY: y * 500,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 500 }) },
  });
  return app.render();
}
function register(app) {
  place(app, 0.2, 0.25);
  place(app, 0.8, 0.25);
  return place(app, 0.5, 0.9);
}

test('render React real: aviso clínico, licencia, privacidad, labels y estado vacío', () => {
  const Component = component(React, anatomy.loadAnatomicalImage);
  const html = renderToStaticMarkup(React.createElement(Component, { surfaceUVs: surface(), onChange() {} }));
  assert.match(html, /no anatomía del paciente/);
  assert.match(html, /Conserva las marcas de agua/);
  assert.match(html, /no se envían ni guardan/);
  assert.match(html, /Sin referencia/);
  assert.match(html, /image\/jpeg,image\/png,image\/webp/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<canvas/);
});

test('registro solo tras 3 clics: UV reales, metadatos y ajustes sin reconstruir textura', async () => {
  const app = panel();
  const { canvas } = await loaded(app);
  assert.equal(app.emitted.at(-1), undefined);
  place(app, 0.2, 0.25);
  place(app, 0.8, 0.25);
  assert.equal(app.emitted.at(-1), undefined);
  let tree = place(app, 0.5, 0.9);
  const ref = app.emitted.at(-1);
  assert.equal(ref.canvas, canvas);
  assert.equal(ref.kind, 'muscle');
  assert.equal(ref.depth, 0.02);
  assert.equal(ref.opacity, 0.5);
  assert.ok(Math.abs(ref.uvs[66] - 0.2) < 1e-6);
  assert.ok(Math.abs(ref.uvs[527] - 0.25) < 1e-6);
  assert.ok(Math.abs(ref.uvs[305] - 0.9) < 1e-6);
  const input = name => find(tree, n => n.type === 'input' && n.props.name === name)[0];
  input('reference-opacity').props.onChange({ target: { value: '0' } });
  input('reference-depth').props.onChange({ target: { value: '0.1' } });
  const kind = find(tree, n => n.type === 'select' && n.props.value === 'muscle')[0];
  kind.props.onChange({ target: { value: 'vessels' } });
  tree = app.render();
  const updated = app.emitted.at(-1);
  assert.equal(updated.opacity, 0);
  assert.equal(updated.depth, 0.1);
  assert.equal(updated.kind, 'vessels');
  assert.equal(updated.canvas, canvas);
  assert.equal(updated.uvs, ref.uvs, 'solo los anclajes o UV fuente recalculan registro');
  assert.match(text(tree), /Alineada con 3 anclajes manuales/);
  app.unmount();
});

test('degeneración explícita invalida la capa y rehacer anclajes la retira', async () => {
  const app = panel();
  await loaded(app);
  place(app, 0.2, 0.2);
  place(app, 0.5, 0.5);
  const tree = place(app, 0.8, 0.8);
  assert.match(text(find(tree, n => n.props.role === 'alert')), /degenerados/);
  assert.equal(app.emitted.at(-1), undefined);
  button(app.render(), 'Rehacer anclajes').props.onClick();
  register(app);
  assert.ok(app.emitted.at(-1));
  button(app.render(), 'Rehacer anclajes').props.onClick();
  app.render();
  assert.equal(app.emitted.at(-1), undefined);
  app.unmount();
});

test('arrastre con captura, flechas y coordenadas numéricas actualizan los mismos anclajes', async () => {
  const app = panel();
  await loaded(app);
  let tree = register(app);
  const marker = find(tree, n => n.props['aria-label'] === 'Mover Ojo lado 33')[0];
  let captured;
  marker.props.onPointerDown({ button: 0, pointerId: 7, currentTarget: { setPointerCapture: id => { captured = id; } } });
  marker.props.onPointerMove({
    pointerId: 7, clientX: 120, clientY: 100,
    currentTarget: { parentElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 500 }) } },
  });
  assert.equal(captured, 7);
  tree = app.render();
  assert.ok(Math.abs(app.emitted.at(-1).uvs[66] - 0.3) < 1e-6);
  const moved = find(tree, n => n.props['aria-label'] === 'Mover Ojo lado 33')[0];
  moved.props.onPointerCancel();
  moved.props.onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault() {} });
  tree = app.render();
  assert.ok(Math.abs(app.emitted.at(-1).uvs[66] - 0.31) < 1e-6);
  const coordinate = find(tree, n => n.props.name === 'anchor-x')[0];
  coordinate.props.onChange({ currentTarget: { value: '40', validity: { valid: true } } });
  app.render();
  assert.ok(Math.abs(app.emitted.at(-1).uvs[66] - 0.4) < 1e-6);
  app.unmount();
});

test('cambiar surfaceUVs recalcula; callback inline no causa nuevas publicaciones', async () => {
  const app = panel();
  await loaded(app);
  register(app);
  const count = app.emitted.length, first = app.emitted.at(-1);
  const fresh = [];
  app.render({ onChange: v => fresh.push(v) });
  app.render({ onChange: v => fresh.push(v) });
  assert.equal(app.emitted.length, count);
  assert.equal(fresh.length, 0);
  const uvs = surface(); uvs[0] = 0.6;
  app.render({ surfaceUVs: uvs });
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0].uvs[0], first.uvs[0]);
  app.render({ surfaceUVs: new Float32Array(2) });
  assert.equal(fresh.at(-1), undefined);
  assert.match(text(app.render()), /UV de paciente inválidos/);
  app.unmount();
});

test('sustituir carga cancela anterior y libera cualquier resultado tardío', async () => {
  const app = panel();
  selectFile(app.render());
  assert.match(text(app.render()), /Cargando imagen local/);
  selectFile(app.render());
  assert.equal(app.loads[0].signal.aborted, true);
  const current = fakeCanvas(), late = fakeCanvas();
  app.loads[1].resolve(current);
  await tick();
  app.render();
  register(app);
  app.loads[0].resolve(late);
  await tick();
  app.render();
  assert.equal(late.width, 0);
  assert.equal(late.height, 0);
  assert.equal(app.emitted.at(-1).canvas, current);
  app.unmount();
});

test('limpiar y desmontar retiran referencia y liberan canvas; no reviven cargas pendientes', async () => {
  const app = panel();
  const { canvas } = await loaded(app);
  register(app);
  button(app.render(), 'Limpiar referencia').props.onClick();
  assert.equal(app.emitted.at(-1), undefined);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.equal(app.preview.width, 800, 'la limpieza de preview ocurre en el efecto siguiente');
  assert.match(text(app.render()), /Sin referencia/);
  assert.equal(app.preview.width, 0);
  selectFile(app.render());
  app.unmount();
  assert.equal(app.loads.at(-1).signal.aborted, true);
  const late = fakeCanvas();
  app.loads.at(-1).resolve(late);
  await tick();
  assert.equal(late.width, 0);
  assert.equal(late.height, 0);
  assert.equal(app.emitted.at(-1), undefined);
});

test('errores de carga explícitos y recuperables sin referencia anterior', async () => {
  const app = panel();
  const { canvas } = await loaded(app);
  register(app);
  selectFile(app.render());
  assert.equal(canvas.width, 0);
  app.loads.at(-1).reject(new Error('Formato no admitido. Selecciona JPEG, PNG o WebP.'));
  await tick();
  const tree = app.render();
  assert.match(text(find(tree, n => n.props.role === 'alert')), /Formato no admitido/);
  assert.equal(app.emitted.at(-1), undefined);
  button(tree, 'Limpiar referencia').props.onClick();
  assert.equal(find(app.render(), n => n.props.role === 'alert').length, 0);
  app.unmount();
});

test('colocación por teclado y coordenadas permite completar los 3 puntos sin arrastre', async () => {
  const app = panel();
  await loaded(app);
  for (let i = 0; i < 3; i++) {
    const tree = app.render();
    find(tree, n => n.props['aria-label']?.startsWith('Colocar'))[0].props.onClick({ detail: 0 });
  }
  let tree = app.render();
  assert.match(text(tree), /degenerados/, 'los ojos inicialmente coinciden; error explícito hasta ajustar');
  const selector = find(tree, n => n.type === 'select' && typeof n.props.value === 'number')[0];
  selector.props.onChange({ target: { value: '0' } });
  tree = app.render();
  find(tree, n => n.props.name === 'anchor-x')[0].props.onChange({
    currentTarget: { value: '25', validity: { valid: true } },
  });
  tree = app.render();
  find(tree, n => n.type === 'select' && typeof n.props.value === 'number')[0].props.onChange({ target: { value: '1' } });
  tree = app.render();
  find(tree, n => n.props.name === 'anchor-x')[0].props.onChange({
    currentTarget: { value: '75', validity: { valid: true } },
  });
  app.render();
  assert.ok(app.emitted.at(-1), 'registro válido usando solo activación y controles de formulario');
  app.unmount();
});

test('limpiar durante carga cancela y no permite reaparecer el resultado', async () => {
  const app = panel();
  selectFile(app.render());
  button(app.render(), 'Limpiar referencia').props.onClick();
  assert.equal(app.loads[0].signal.aborted, true);
  const late = fakeCanvas();
  app.loads[0].resolve(late);
  await tick();
  assert.match(text(app.render()), /Sin referencia/);
  assert.equal(late.width, 0);
  assert.equal(app.emitted.at(-1), undefined);
  app.unmount();
});

test('error tardío de una carga sustituida no sobrescribe la referencia actual', async () => {
  const app = panel();
  selectFile(app.render());
  await loaded(app);
  register(app);
  app.loads[0].reject(new Error('Error obsoleto'));
  await tick();
  const tree = app.render();
  assert.ok(app.emitted.at(-1));
  assert.equal(find(tree, n => n.props.role === 'alert').length, 0);
  app.unmount();
});

test('ilustración con rostro: alineación automática densa; mover un punto vuelve al modo manual', async () => {
  const lm = Array.from({ length: 478 }, (_, i) => ({ x: 0.3 + 0.4 * (i % 23) / 22, y: 0.2 + 0.6 * (i % 29) / 28 }));
  lm[33] = { x: 0.3, y: 0.35 }; lm[263] = { x: 0.7, y: 0.35 }; lm[152] = { x: 0.5, y: 0.85 };
  globalThis.__detected = lm;
  try {
    const app = panel();
    const uvs = new Float32Array(478 * 2);
    for (let i = 0; i < 478; i++) uvs.set([0.2 + 0.6 * (i % 19) / 18, 0.1 + 0.8 * (i % 31) / 30], i * 2);
    app.render({ surfaceUVs: uvs });
    const { tree } = await loaded(app);
    assert.match(text(tree), /Alineada automáticamente con 468 puntos/);
    const ref = app.emitted.at(-1);
    assert.ok(ref?.uvs);
    assert.ok(Math.abs(ref.uvs[33 * 2] - 0.3) < 1e-6 && Math.abs(ref.uvs[152 * 2 + 1] - 0.85) < 1e-6);
    place(app, 0.5, 0.9);
    assert.match(text(app.render()), /Alineada con 3 anclajes manuales/);
  } finally { delete globalThis.__detected; }
});