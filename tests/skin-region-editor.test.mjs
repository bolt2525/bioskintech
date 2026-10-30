import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as review from '../src/lab/faceSim/skinRegionReview.ts';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/lab/faceSim/SkinRegionEditor.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

class FakeCanvas {
  constructor(width = 100, height = width) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4).fill(160); }
  getContext() {
    return {
      drawImage: () => {},
      getImageData: (_x, _y, width = this.width, height = this.height) => ({
        width, height, data: this.data.slice(0, width * height * 4),
      }),
      putImageData: () => {},
    };
  }
}

function harness(initialCanvas = new FakeCanvas()) {
  const states = [], refs = [], effects = [], timers = new Map(), calls = [], regionCalls = [];
  const windowListeners = new Map();
  let stateCursor = 0, refCursor = 0, effectCursor = 0, dirty = false, timerId = 0, analyses = 0;
  let props = {
    canvas: initialCanvas,
    landmarks: undefined,
    onTexture: value => calls.push(value),
    onRegionsChange: regions => regionCalls.push(regions),
  };
  let tree;
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  globalThis.document = { createElement: tag => { assert.equal(tag, 'canvas'); return new FakeCanvas(); } };
  globalThis.window = {
    addEventListener: (name, callback) => windowListeners.set(name, callback),
    removeEventListener: (name, callback) => { if (windowListeners.get(name) === callback) windowListeners.delete(name); },
  };
  const hooks = {
    useState(initial) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], next => {
        const value = typeof next === 'function' ? next(states[index]) : next;
        if (!Object.is(value, states[index])) { states[index] = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect(callback, dependencies) {
      const index = effectCursor++, previous = effects[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects[index] = { dependencies, callback, cleanup: previous?.cleanup, pending: true };
      }
    },
  };
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol('Fragment'),
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, Error, Intl, Uint8Array, Uint8ClampedArray, Math, Date, Number, Object, Array, String, window: globalThis.window,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return jsxRuntime;
      if (name === './skinAppearance') return {
        analyzeSkinAppearance() {
          analyses++;
          return {
            usable: true, warnings: [],
            channels: {
              contrast: { status: 'highlighted' }, redness: { status: 'no-signal' },
              texture: { status: 'no-signal' }, shine: { status: 'no-signal' },
            },
          };
        },
      };
      if (name === './skinSignalTexture') return {
        skinSignalPreview: () => new FakeCanvas(100, 100),
        createSkinSignalMask: (width, height) => new Uint8Array(width * height).fill(1),
      };
      if (name === './skinRegionReview') return review;
      return require(name);
    },
  });
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(child => find(child, predicate));
    return [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)];
  };
  const render = () => {
    let turns = 0;
    do {
      assert.ok(++turns < 30, 'render sin convergencia');
      dirty = false; stateCursor = 0; refCursor = 0; effectCursor = 0;
      tree = exports.default(props);
      for (const node of find(tree, node => node.type === 'canvas')) node.props.ref.current ??= new FakeCanvas();
      for (const effect of effects) if (effect.pending) {
        effect.pending = false;
        effect.cleanup?.();
        effect.cleanup = effect.callback();
      }
    } while (dirty);
    return tree;
  };
  return {
    calls, regionCalls, timers, windowListeners, find, render,
    get analyses() { return analyses; },
    update(next) { props = { ...props, ...next }; return render(); },
    button(label) {
      const node = find(render(), item => item.type === 'button' && flatten(item.props.children).includes(label))[0];
      assert.ok(node, `botón no encontrado: ${label}`);
      return node;
    },
    get svg() { return find(render(), item => item.type === 'svg')[0]; },
    restore() { globalThis.document = previousDocument; globalThis.window = previousWindow; },
  };
}
const flatten = node => Array.isArray(node) ? node.map(flatten).join('')
  : node && typeof node === 'object' ? flatten(node.props?.children) : String(node ?? '');
const pointer = (node, x, y) => ({
  clientX: x, clientY: y, pointerId: 1, preventDefault() {},
  currentTarget: {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture() {},
  },
});

test('flujo de componente: dibuja, etiqueta, analiza solo bajo demanda y valida manualmente', t => {
  const app = harness();
  t.after(() => app.restore());
  app.render();
  assert.equal(app.analyses, 0, 'el análisis no se activa al cargar');
  app.button('Rectángulo').props.onClick();
  let svg = app.svg;
  svg.props.onPointerDown(pointer(svg, 20, 20));
  svg.props.onPointerUp(pointer(svg, 80, 80));
  let selects = app.find(app.render(), node => node.type === 'select');
  assert.equal(selects.length, 1);
  selects[0].props.onChange({ target: { value: 'Mancha' } });
  assert.equal(app.analyses, 0);
  app.button('Analizar solo esta zona').props.onClick();
  assert.equal(app.analyses, 0, 'el análisis espera la acción local explícita');
  const [timerId, runAnalysis] = [...app.timers.entries()][0];
  app.timers.delete(timerId);
  runAnalysis();
  app.render();
  assert.equal(app.analyses, 1);
  app.button('Validar revisión manual').props.onClick();
  app.render();
  assert.equal(app.regionCalls.at(-1)[0].verified, true);
  assert.equal(app.find(app.render(), node => node.type === 'input' && node.props.type === 'range').length, 4);
  app.find(app.render(), node => node.type === 'input' && node.props['aria-label'] === 'Relieve ilustrativo · sin medición')[0]
    .props.onChange({ target: { value: '0.5' } });
  app.render();
  app.button('Ver antes').props.onClick();
  app.render();
  assert.equal(app.regionCalls.at(-1).length, 0, 'la comparación anterior suspende relieve en el padre');
  app.button('Ver después').props.onClick();
  app.render();
  assert.equal(app.regionCalls.at(-1)[0].verified, true, 'después publica solo zonas verificadas');
  app.button('Restablecer · imagen original').props.onClick();
  app.render();
  assert.equal(app.regionCalls.at(-1).length, 0, 'restablecer retira la máscara de relieve del padre');
  assert.equal(app.calls.at(-1), undefined, 'restablecer no conserva textura local derivada');
});

test('Escape cancela el borrador sin interceptar Escape dentro de un input', t => {
  const app = harness();
  t.after(() => app.restore());
  app.render();
  app.button('Rectángulo').props.onClick();
  const svg = app.svg;
  svg.props.onPointerDown(pointer(svg, 20, 20));
  app.render();
  const escape = app.windowListeners.get('keydown');
  assert.equal(typeof escape, 'function');
  escape({ key: 'Escape', target: { closest: () => ({}) } });
  assert.equal(app.find(app.render(), node => node.type === 'button' && flatten(node.props.children).includes('Cancelar')).length, 1);
  escape({ key: 'Escape', target: null });
  assert.equal(app.find(app.render(), node => node.type === 'button' && flatten(node.props.children).includes('Cancelar')).length, 0);
});

test('cambio de fuente invalida zonas y cancela el análisis pendiente', t => {
  const app = harness();
  t.after(() => app.restore());
  app.render();
  app.button('Rectángulo').props.onClick();
  const svg = app.svg;
  svg.props.onPointerDown(pointer(svg, 20, 20));
  svg.props.onPointerUp(pointer(svg, 80, 80));
  app.find(app.render(), node => node.type === 'select')[0].props.onChange({ target: { value: 'Cicatriz' } });
  app.button('Analizar solo esta zona').props.onClick();
  assert.equal(app.timers.size, 1);
  const before = app.analyses;
  app.update({ canvas: new FakeCanvas() });
  assert.equal(app.timers.size, 0);
  assert.equal(app.analyses, before);
  assert.equal(app.regionCalls.at(-1).length, 0);
});
