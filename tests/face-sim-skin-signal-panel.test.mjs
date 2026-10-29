import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import * as texture from '../src/lab/faceSim/skinSignalTexture.ts';
import * as appearance from '../src/lab/faceSim/skinAppearance.ts';
import { FACE_OVAL } from '../src/lab/faceSim/engine.ts';
import { FACE_REGION_BOUNDARIES, FACE_REGION_SEEDS } from '../src/lab/faceSim/faceRegions.ts';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/lab/faceSim/SkinSignalPanel.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Canvas mínimo en memoria: píxeles sintéticos y mezcla source-over real para comprobar la composición.
class MemoryCanvas {
  constructor(width = 128, height = width) { this.width = width; this.height = height; }
  get data() {
    if (this.pixels?.length !== this.width * this.height * 4) this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    return this.pixels;
  }
  getContext() {
    if (this.unreadable) return null;
    const context = {
      fillRect: (x, y, w, h) => {
        const style = context.fillStyle;
        const rgb = style === 'white' ? [255, 255, 255, 255] : /^#[0-9a-f]{6}$/i.test(style)
          ? [1, 3, 5].map(i => parseInt(style.slice(i, i + 2), 16)).concat(255) : [0, 0, 0, 255];
        for (let py = Math.max(0, Math.floor(y)); py < Math.min(this.height, Math.ceil(y + h)); py++) {
          for (let px = Math.max(0, Math.floor(x)); px < Math.min(this.width, Math.ceil(x + w)); px++) {
            this.data.set(rgb, (py * this.width + px) * 4);
          }
        }
      },
      strokeRect: (x, y, w, h) => {
        context.fillStyle = context.strokeStyle;
        const line = context.lineWidth;
        context.fillRect(x, y, w, line); context.fillRect(x, y + h - line, w, line);
        context.fillRect(x, y, line, h); context.fillRect(x + w - line, y, line, h);
      },
      fillText: (...args) => { (this.labels ??= []).push(args); },
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: () => {
        if (this.tainted) throw Object.assign(new Error('origen restringido'), { name: 'SecurityError' });
        return { width: this.width, height: this.height, data: this.data.slice() };
      },
      putImageData: image => this.data.set(image.data),
      drawImage: (input, _x, _y, width = input.width, height = input.height) => {
        this.tainted = input.tainted;
        this.labels = input.labels?.map(label => [...label]);
        for (let y = 0; y < Math.min(this.height, height); y++) for (let x = 0; x < Math.min(this.width, width); x++) {
          const i = (y * this.width + x) * 4;
          const j = (Math.floor(y / height * input.height) * input.width + Math.floor(x / width * input.width)) * 4;
          const alpha = input.data[j + 3] / 255, previous = this.data[i + 3] / 255;
          const outAlpha = alpha + previous * (1 - alpha);
          for (let c = 0; c < 3; c++) this.data[i + c] = outAlpha
            ? (input.data[j + c] * alpha + this.data[i + c] * previous * (1 - alpha)) / outAlpha : 0;
          this.data[i + 3] = outAlpha * 255;
        }
      },
    };
    return context;
  }
}

function image(kind = 'red', width = 128, height = width) {
  const canvas = new MemoryCanvas(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = kind === 'red' ? Math.exp(-((x - width / 2) ** 2 + (y - height / 2) ** 2) / 8) : 0;
    canvas.data.set(kind === 'dark' ? [10, 7, 5, 255] : [180 + 45 * s, 130 - 30 * s, 110 - 10 * s, 255], (y * width + x) * 4);
  }
  return canvas;
}

function landmarks() {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const ellipse = (ids, cx, cy, rx, ry) => ids.forEach((id, i) => {
    const angle = 2 * Math.PI * i / ids.length;
    points[id] = { x: cx + rx * Math.sin(angle), y: cy - ry * Math.cos(angle) };
  });
  ellipse(FACE_OVAL, 0.5, 0.5, 0.4, 0.45);
  ellipse(FACE_REGION_BOUNDARIES.leftEye, 0.33, 0.36, 0.07, 0.03);
  ellipse(FACE_REGION_BOUNDARIES.rightEye, 0.67, 0.36, 0.07, 0.03);
  ellipse([...new Set([...FACE_REGION_BOUNDARIES.upperLip, ...FACE_REGION_BOUNDARIES.lowerLip])], 0.5, 0.7, 0.1, 0.04);
  FACE_REGION_SEEDS.find(entry => entry.zone === 'Cola de ceja').indices.forEach((id, i) => {
    points[id] = { x: i % 2 ? 0.68 : 0.32, y: 0.29 };
  });
  return points;
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => find(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
}
const text = tree => Array.isArray(tree) ? tree.map(text).join('')
  : tree && typeof tree === 'object' ? text(tree.props?.children) : String(tree ?? '');

function panel(canvas = image(), points) {
  const states = [], refs = [], effects = [], timers = new Map(), calls = [], analyzedSizes = [];
  let stateCursor = 0, refCursor = 0, effectCursor = 0, dirty = false, timerId = 0, analyses = 0;
  let props = { canvas, landmarks: points, onTexture: value => calls.push(value) };
  let tree;
  globalThis.document = { createElement: tag => { assert.equal(tag, 'canvas'); return new MemoryCanvas(); } };
  const hooks = {
    ...React,
    useState(initial) {
      const i = stateCursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], next => {
        const value = typeof next === 'function' ? next(states[i]) : next;
        if (!Object.is(value, states[i])) { states[i] = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const i = refCursor++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
    useEffect(fn, deps) {
      const i = effectCursor++, previous = effects[i];
      if (!previous || deps.some((dep, j) => !Object.is(dep, previous.deps[j]))) {
        effects[i] = { deps, fn, cleanup: previous?.cleanup, pending: true };
      }
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, Error, Intl,
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => {
      if (name === 'react') return hooks;
      if (name === './skinAppearance') return appearance;
      if (name === './skinSignalTexture') return {
        ...texture,
        analyzeSkinSignalCanvas(...args) {
          analyses++; analyzedSizes.push([args[0].width, args[0].height]);
          return texture.analyzeSkinSignalCanvas(...args);
        },
      };
      if (name.endsWith('/Tooltip')) return { Tooltip: ({ children }) => children };
      return require(name);
    },
  });
  const render = () => {
    let turns = 0;
    do {
      assert.ok(++turns < 25, 'sin bucle de efectos');
      dirty = false; stateCursor = 0; refCursor = 0; effectCursor = 0;
      tree = exports.default(props);
      for (const node of find(tree, n => n.type === 'canvas')) node.ref.current ??= new MemoryCanvas();
      for (const effect of effects) if (effect.pending) {
        effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn();
      }
    } while (dirty);
    return tree;
  };
  return {
    calls, render, timers, analyzedSizes,
    get analyses() { return analyses; },
    update(next) { props = { ...props, ...next }; return render(); },
    control(name) { return find(render(), n => n.props?.name === name)[0]; },
    select(mode) { this.control('skin-signal-mode').props.onChange({ target: { value: mode } }); return render(); },
    resolution(value) { this.control('skin-signal-resolution').props.onChange({ target: { value: String(value) } }); return render(); },
    confirm() { find(render(), n => n.type === 'input' && n.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }); return render(); },
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } return render(); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

test.afterEach(() => { delete globalThis.document; });

test('ROI conserva piel interior y excluye fondo, margen, ojos, labios y cejas sin modificar referencias', () => {
  const points = landmarks(), original = structuredClone(points);
  const mask = texture.createSkinSignalMask(128, 128, points);
  const at = (u, v) => mask[Math.floor(v * 128) * 128 + Math.floor(u * 128)];
  for (const [u, v] of [[0, 0], [0.105, 0.5], [0.33, 0.36], [0.67, 0.36], [0.5, 0.7], [0.32, 0.29]]) assert.equal(at(u, v), 0);
  for (const [u, v] of [[0.35, 0.55], [0.65, 0.55], [0.5, 0.2]]) assert.equal(at(u, v), 1);
  assert.deepEqual(points, original);
  assert.ok(texture.createSkinSignalMask(20, 30).every(v => v === 1));
  assert.throws(() => texture.createSkinSignalMask(128, 128, []), /incompletas/);
  points[10].x = NaN;
  assert.throws(() => texture.createSkinSignalMask(128, 128, points), /incompletas/);
  assert.throws(() => texture.createSkinSignalMask(-1, 128), RangeError);
});

test('panel original: vistas históricas y candidatos opt-in, controles etiquetados y límites', () => {
  const app = panel(), tree = app.render();
  assert.deepEqual(find(app.control('skin-signal-mode'), n => n.type === 'option').map(text), [
    'Original', 'Rojeces', 'Pigmentación · contraste aparente', 'Textura', 'Poros-candidatos', 'Puntos-rojizos', 'Candidatos visuales · cuadros',
  ]);
  assert.equal(app.control('skin-signal-sensitivity').props.disabled, true);
  assert.equal(app.control('skin-signal-resolution').props.value, 384);
  assert.deepEqual(find(app.control('skin-signal-resolution'), n => n.type === 'option').map(text), [
    'Rápido · 384 px', 'Detalle · 768 px', 'Original · máximo 1400 px',
  ]);
  const tip = find(tree, n => typeof n.props?.content === 'string')[0];
  assert.match(tip.props.content, /no diagnóstico/);
  assert.match(tip.props.content, /No identifica acné, poros ni vasos reales/);
  assert.match(tip.props.content, /candidatos no confirman poros ni acné/);
  assert.match(tip.props.content, /resolución y la luz limitan la señal/);
  assert.ok(find(tree, n => n.type === 'label').length >= 3);
  assert.equal(app.analyses, 0);
  assert.equal(app.calls.at(-1), undefined);
  assert.equal(find(tree, n => n.props?.role === 'status')[0].props['aria-live'], 'polite');
  app.unmount();
});

test('sin referencias no analiza hasta confirmar solo piel; produce textura distinta sin mutar origen', () => {
  const canvas = image(), before = canvas.data.slice(), app = panel(canvas);
  app.select('redness');
  assert.match(text(app.render()), /confirma que el recorte/);
  assert.equal(app.timers.size, 0);
  const busy = app.confirm();
  assert.equal(find(busy, n => n.props?.role === 'status')[0].props['aria-busy'], true);
  app.flush();
  const output = app.calls.at(-1);
  assert.notEqual(output, canvas);
  assert.equal(output.width, canvas.width);
  assert.equal(output.height, canvas.height);
  assert.notDeepEqual(output.data, before);
  assert.deepEqual(canvas.data, before);
  assert.match(text(app.render()), /no es una medida clínica/);
  app.unmount();
  assert.equal(app.calls.at(-1), undefined);
});

test('referencias válidas evitan confirmación; alternar filtros reutiliza análisis y original restaura', () => {
  const app = panel(image(), landmarks());
  assert.equal(find(app.render(), n => n.props?.type === 'checkbox' && !n.props.name).length, 0);
  for (const channel of ['redness', 'contrast', 'texture', 'poreCandidates', 'redDots']) {
    app.select(channel); app.flush();
    assert.ok(app.calls.at(-1) instanceof MemoryCanvas);
  }
  assert.equal(app.analyses, 1);
  app.select('original');
  assert.equal(app.calls.at(-1), undefined);
  assert.equal(app.timers.size, 0);
  app.unmount();
});

const discardButtons = app => find(app.render(), node => node.type === 'button'
  && node.props['aria-label']?.startsWith('Descartar candidato'));
function checkbox(app, name, checked) {
  app.control(name).props.onChange({ target: { checked } });
  return app.render();
}

test('cuadros opt-in en foto, etiquetas neutrales, descarte/restauración y copia opcional al visor sin quemar original', () => {
  const source = image(), original = source.data.slice(), app = panel(source, landmarks());
  assert.equal(app.control('skin-candidates-enabled').props.checked, false);
  checkbox(app, 'skin-candidates-enabled', true); app.flush();
  const initialCount = discardButtons(app).length;
  assert.ok(initialCount > 0);
  assert.equal(app.calls.at(-1), undefined, 'por defecto no cambia la textura del visor');
  assert.equal(app.control('skin-candidates-viewer').props.checked, false);
  assert.match(text(app.render()), /Enrojecimiento aparente/);
  assert.match(text(app.render()), /Sombras, barba y reflejos/);
  const preview = find(app.render(), node => node.type === 'canvas')[0].ref.current;
  assert.notDeepEqual(preview.data, original, 'cuadros visibles sobre foto');
  assert.ok(preview.labels.length > 0, 'cuadros numerados, no solo color');
  checkbox(app, 'skin-candidates-viewer', true); app.flush();
  assert.notEqual(app.calls.at(-1), source);
  assert.notDeepEqual(app.calls.at(-1).data, original);
  const outputBeforeDiscard = app.calls.at(-1).data.slice();
  discardButtons(app)[0].props.onClick(); app.render(); app.flush();
  assert.equal(discardButtons(app).length, initialCount - 1);
  if (app.calls.at(-1)) assert.notDeepEqual(app.calls.at(-1).data, outputBeforeDiscard);
  assert.match(text(app.render()), /1 descartados/);
  assert.equal(app.analyses, 1, 'descartar y alternar visor reutiliza el análisis RGB');
  find(app.render(), node => node.type === 'button' && text(node) === 'Restablecer descartados')[0].props.onClick();
  app.render(); app.flush();
  assert.equal(discardButtons(app).length, initialCount);
  checkbox(app, 'skin-candidates-viewer', false); app.flush();
  assert.equal(app.calls.at(-1), undefined);
  checkbox(app, 'skin-candidates-enabled', false);
  assert.equal(app.calls.at(-1), undefined);
  assert.equal(app.control('skin-signal-mode').props.value, 'original');
  assert.deepEqual(find(app.render(), node => node.type === 'canvas')[0].ref.current.data, original);
  assert.deepEqual(source.data, original);
  app.unmount();
});

test('descartar todos deja foto sin cuadros y restaura visor; cambiar sensibilidad, foto o referencias inicia revisión nueva', () => {
  const source = image(), points = landmarks(), app = panel(source, points);
  app.select('visualCandidates'); app.flush();
  const count = discardButtons(app).length;
  assert.ok(count > 0);
  checkbox(app, 'skin-candidates-viewer', true); app.flush();
  for (let i = 0; i < count; i++) {
    discardButtons(app)[0].props.onClick(); app.render(); app.flush();
  }
  assert.equal(discardButtons(app).length, 0);
  assert.equal(app.calls.at(-1), undefined);
  assert.match(text(app.render()), /0 candidatos visuales visibles/);
  assert.deepEqual(find(app.render(), node => node.type === 'canvas')[0].ref.current.data, source.data);
  app.control('skin-signal-sensitivity').props.onChange({ target: { value: '55' } });
  app.render(); app.flush();
  assert.ok(discardButtons(app).length > 0);
  assert.match(text(app.render()), /0 descartados/);
  discardButtons(app)[0].props.onClick(); app.render(); app.flush();
  app.update({ landmarks: landmarks() }); app.flush();
  assert.match(text(app.render()), /0 descartados/);
  discardButtons(app)[0].props.onClick(); app.render(); app.flush();
  app.update({ canvas: image() }); app.flush();
  assert.match(text(app.render()), /0 descartados/);
  // Volver a una sensibilidad anterior no recupera descartes de otra revisión.
  app.control('skin-signal-sensitivity').props.onChange({ target: { value: '50' } });
  app.render(); app.flush();
  assert.match(text(app.render()), /0 descartados/);
  app.unmount();
});

test('cuadros limitan cálculo a 384 aunque se eligieran 768; sin referencias exige confirmación y limpia timers', () => {
  const app = panel(image('uniform', 600, 300));
  app.resolution(768);
  checkbox(app, 'skin-candidates-enabled', true);
  assert.equal(app.timers.size, 0);
  assert.match(text(app.render()), /confirma que el recorte/);
  app.confirm(); app.flush();
  assert.deepEqual(app.analyzedSizes.at(-1), [384, 192]);
  assert.equal(app.control('skin-signal-resolution').props.disabled, true);
  assert.equal(app.control('skin-signal-resolution').props.value, 384);
  assert.match(text(app.render()), /0 candidatos visuales visibles/);
  assert.equal(app.calls.at(-1), undefined);
  checkbox(app, 'skin-candidates-enabled', false);
  assert.equal(app.control('skin-signal-resolution').props.value, 768);
  assert.equal(app.timers.size, 0);
  checkbox(app, 'skin-candidates-enabled', true);
  app.unmount();
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls.at(-1), undefined);
});

test('errores de lectura o dibujo de cuadros son visibles y no envían textura ni candidatos obsoletos', () => {
  const source = image(), app = panel(source, landmarks());
  source.tainted = true;
  app.select('visualCandidates'); app.flush();
  assert.match(text(app.render()), /captura local sin restricciones de origen/);
  assert.equal(discardButtons(app).length, 0);
  assert.equal(app.calls.at(-1), undefined);
  source.tainted = false;
  app.control('skin-signal-sensitivity').props.onChange({ target: { value: '55' } });
  app.render(); app.flush();
  assert.ok(discardButtons(app).length > 0);
  const create = globalThis.document.createElement;
  globalThis.document.createElement = () => {
    const canvas = new MemoryCanvas(), getContext = canvas.getContext.bind(canvas);
    canvas.getContext = () => {
      const context = getContext();
      context.strokeRect = () => { throw new Error('No se pudieron dibujar los cuadros.'); };
      return context;
    };
    return canvas;
  };
  checkbox(app, 'skin-candidates-viewer', true); app.flush();
  assert.match(text(app.render()), /No se pudieron dibujar los cuadros/);
  assert.equal(discardButtons(app).length, 0);
  assert.equal(app.calls.at(-1), undefined);
  globalThis.document.createElement = create;
  app.unmount();
});

test('sensibilidad agrupa cambios; callback inline no recalcula ni entra en bucle', () => {
  const app = panel(image(), landmarks());
  app.select('redness'); app.flush();
  for (const value of [20, 35, 80]) {
    app.control('skin-signal-sensitivity').props.onChange({ target: { value: String(value) } });
    app.render();
  }
  assert.equal(app.timers.size, 1);
  assert.equal(app.calls.at(-1), undefined, 'retira textura anterior mientras recalcula');
  app.flush();
  assert.equal(app.analyses, 2);
  const received = [];
  app.update({ onTexture: output => received.push(output) });
  assert.equal(app.timers.size, 0);
  assert.equal(app.analyses, 2);
  app.select('redDots'); app.flush();
  assert.ok(received.at(-1) instanceof MemoryCanvas);
  app.unmount();
});

test('cambio de imagen revoca confirmación y cancela trabajo pendiente; desmontaje limpia textura', () => {
  const app = panel();
  app.select('redness'); app.confirm();
  assert.equal(app.timers.size, 1);
  app.update({ canvas: image() });
  app.flush();
  assert.equal(app.analyses, 0);
  assert.equal(app.calls.at(-1), undefined);
  assert.equal(find(app.render(), n => n.props?.type === 'checkbox')[0].props.checked, false);
  app.confirm();
  app.unmount();
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls.at(-1), undefined);
});

test('sin señal, calidad no utilizable y referencias incompletas no producen falsos hallazgos', () => {
  const uniform = panel(image('uniform'), landmarks());
  uniform.select('redDots'); uniform.flush();
  assert.match(text(uniform.render()), /no indica ausencia/);
  assert.ok(uniform.calls.at(-1) instanceof MemoryCanvas);
  uniform.unmount();
  const dark = panel(image('dark'), landmarks());
  dark.select('redness'); dark.flush();
  assert.match(text(dark.render()), /No utilizable.*oscuridad/);
  assert.equal(dark.calls.at(-1), undefined);
  dark.unmount();
  const invalid = panel(image(), []);
  invalid.select('redness'); invalid.flush();
  assert.match(text(invalid.render()), /incompletas/);
  assert.equal(invalid.calls.at(-1), undefined);
  invalid.unmount();
});

test('imagen vacía, contexto inexistente y canvas restringido fallan de forma recuperable', () => {
  const empty = panel(new MemoryCanvas(0, 0));
  assert.match(text(empty.render()), /imagen está vacía/);
  empty.unmount();
  const canvas = image(); canvas.tainted = true;
  const restricted = panel(canvas, landmarks());
  restricted.select('redness'); restricted.flush();
  assert.match(text(restricted.render()), /captura local sin restricciones de origen/);
  assert.equal(restricted.calls.at(-1), undefined);
  restricted.unmount();
  const originalCreate = globalThis.document.createElement;
  const unavailable = panel();
  globalThis.document.createElement = () => Object.assign(new MemoryCanvas(), { unreadable: true });
  assert.match(text(unavailable.render()), /No se pudo abrir la imagen/);
  assert.equal(unavailable.calls.at(-1), undefined);
  unavailable.unmount();
  globalThis.document.createElement = originalCreate;
});

test('preview reduce sin ampliar y mantiene orientación; composición conserva dimensiones y transparencia exterior', () => {
  panel(); // Instala únicamente el adaptador canvas local.
  const source = image('uniform', 600, 300), before = source.data.slice();
  const base = texture.skinSignalPreview(source);
  assert.equal(base.width, 384);
  assert.equal(base.height, 192);
  const result = texture.analyzeSkinSignalCanvas(base, undefined, 0.5);
  const output = texture.composeSkinSignalTexture(source, base, result, 'poreCandidates');
  assert.equal(output.width, 600);
  assert.equal(output.height, 300);
  assert.deepEqual(output.data, before, 'capa vacía no altera el RGB original');
  assert.deepEqual(source.data, before);
});

test('copia de cuadros normalizados conserva tamaño y orientación de foto rectangular; vacío mantiene RGB exacto', () => {
  panel(); // Adaptador local, sin navegador/red.
  const source = image('uniform', 600, 300), before = source.data.slice();
  const candidate = { id: 'synthetic', channel: 'texture', x: 0.25, y: 0.3, width: 0.1, height: 0.2 };
  const output = texture.composeSkinCandidateTexture(source, [candidate]);
  assert.notEqual(output, source);
  assert.deepEqual([output.width, output.height], [600, 300]);
  assert.deepEqual([...output.data.slice((90 * 600 + 150) * 4, (90 * 600 + 150) * 4 + 3)], [34, 211, 238], 'borde con el color de su categoría');
  assert.deepEqual([...output.data.slice((150 * 600 + 300) * 4, (150 * 600 + 300) * 4 + 4)], [180, 130, 110, 255]);
  assert.deepEqual(output.labels.map(label => label[0]), ['1']);
  assert.deepEqual(texture.composeSkinCandidateTexture(source, []).data, before);
  assert.deepEqual(source.data, before);
});

test('cada resolución respeta su umbral, proporciones y orientación; nunca amplía fotos pequeñas', () => {
  // Solo dimensiones: permite probar todos los límites sin reservar fotos ni buffers grandes.
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext() { return { drawImage: (...args) => { this.draw = args; } }; },
    }),
  };
  for (const limit of [384, 768, 1400]) {
    for (const [width, height] of [
      [2400, 1200], [1200, 2400], [limit + 1, limit + 1],
      [limit, limit], [limit - 1, limit - 1], [640, 480], [80, 120], [1, 1],
    ]) {
      const source = { width, height }, copy = { ...source };
      const base = texture.skinSignalPreview(source, limit);
      const factor = Math.min(1, limit / Math.max(width, height));
      assert.equal(base.width, Math.max(1, Math.round(width * factor)));
      assert.equal(base.height, Math.max(1, Math.round(height * factor)));
      assert.ok(Math.max(base.width, base.height) <= limit);
      assert.ok(base.width <= width && base.height <= height);
      assert.deepEqual(base.draw, [source, 0, 0, base.width, base.height]);
      assert.deepEqual(source, copy);
      if (Math.max(width, height) <= limit) assert.deepEqual([base.width, base.height], [width, height]);
    }
  }
  const source = { width: 2400, height: 1200 };
  assert.equal(texture.skinSignalPreview(source).width, 384, '384 sigue siendo el valor predeterminado');
  assert.equal(texture.skinSignalPreview(source, 10000).width, 1400, 'tope absoluto aunque el llamador solicite más');
  for (const invalid of [0, -1, NaN, Infinity, 768.5]) {
    assert.throws(() => texture.skinSignalPreview(source, invalid), /Resolución de análisis inválida/);
  }
});

test('el analizador del módulo rechaza lados superiores a 1400 antes de leer píxeles', () => {
  for (const [width, height] of [[1401, 100], [100, 1401], [1401, 1401]]) {
    let read = false;
    const base = { width, height, getContext() { read = true; throw new Error('No debe leer ni asignar RGBA'); } };
    assert.throws(() => texture.analyzeSkinSignalCanvas(base, undefined, 0.5), /hasta 1400 px/);
    assert.equal(read, false);
  }
});

test('cambiar resolución invalida caché, agrupa cambios y cancela resultados pendientes sin ampliar', () => {
  const app = panel(image(), landmarks());
  app.select('redness'); app.flush();
  assert.equal(app.analyses, 1);
  app.resolution(768);
  assert.equal(app.calls.at(-1), undefined);
  app.resolution(1400);
  assert.equal(app.timers.size, 1);
  app.flush();
  assert.equal(app.analyses, 2, 'solo se calcula la última resolución seleccionada');
  assert.deepEqual(app.analyzedSizes, [[128, 128], [128, 128]], 'ni detalle ni original amplían fotos pequeñas');
  app.select('redDots'); app.flush();
  assert.equal(app.analyses, 2, 'reutiliza la caché en la misma resolución');
  app.resolution(384); app.flush();
  assert.equal(app.analyses, 3, 'volver al límite anterior recalcula, sin retener varias resoluciones');
  app.resolution(9999);
  assert.equal(app.control('skin-signal-resolution').props.value, 384);
  assert.equal(app.timers.size, 0);
  app.resolution(768);
  app.update({ canvas: image() });
  assert.equal(app.timers.size, 1);
  app.unmount();
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls.at(-1), undefined);
});

test('el selector entrega al algoritmo la resolución elegida, no un preview fijo a 384', () => {
  const app = panel(image('uniform', 480, 240), landmarks());
  app.select('texture'); app.flush();
  app.resolution(768); app.flush();
  app.resolution(1400); app.flush();
  assert.deepEqual(app.analyzedSizes, [[384, 192], [480, 240], [480, 240]]);
  assert.equal(app.calls.at(-1).width, 480, 'la textura conserva el tamaño original');
  assert.equal(app.calls.at(-1).height, 240);
  app.unmount();
});
