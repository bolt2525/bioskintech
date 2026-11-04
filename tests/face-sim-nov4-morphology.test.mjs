import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { buildPersonalSurface, trianglesFromEdges } from '../src/lab/faceSim/engine.ts';
import { refineDisplaySurface } from '../src/lab/faceSim/displaySurface.ts';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const atlas = JSON.parse(read('../src/lab/faceSim/genericFaceAtlas.json'));
const compileURL = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`;
const simulationURL = compileURL(read('../src/lab/faceSim/simulation.ts')
  .replace("import atlasData from './genericFaceAtlas.json' with { type: 'json' };", `const atlasData = ${JSON.stringify(atlas)};`));
const sim = await import(simulationURL);
const session = await import(compileURL(read('../src/lab/faceSim/morphologySession.ts')
  .replace("from './simulation'", `from '${simulationURL}'`)));
const reduce = session.morphologySessionReducer;
const initial = session.initialMorphologySession;
const change = parameters => ({ type: 'change', parameters });
const at = (p, id) => Array.from(p.slice(id * 3, id * 3 + 3));
const fixture = JSON.parse(read('./fixtures/face-sim-mediapipe-synthetic.json'));
const personal = buildPersonalSurface(fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect,
  trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION));
const meshes = [['atlas', sim.createSimulationMesh()], ['personal sintético', sim.createSimulationMesh(personal)]];

test('sesión: un arrastre de 100 frames o repetición de teclas es una sola entrada; no-op no registra', () => {
  let state = reduce(initial(), { type: 'begin' });
  for (let frame = 1; frame <= 100; frame++) {
    state = reduce(state, { type: 'begin' }); // repetición de keydown no reinicia la referencia
    state = reduce(state, change({ noseRadix: -frame / 100 }));
    assert.equal(state.past.length, 0);
  }
  state = reduce(state, { type: 'end' });
  assert.equal(state.past.length, 1);
  assert.equal(state.present.parameters.noseRadix, -1);
  state = reduce(state, { type: 'undo' });
  assert.equal(state.present.parameters.noseRadix, 0);
  state = reduce(state, { type: 'redo' });
  assert.equal(state.present.parameters.noseRadix, -1);
  const before = state;
  state = reduce(reduce(state, { type: 'begin' }), { type: 'end' });
  assert.equal(state.past, before.past);
  assert.equal(reduce(state, change({ noseRadix: -1 })), state);
});

test('sesión: undo/redo de restaurar región, dirección, simetría, reset, guardar/aplicar/eliminar variante', () => {
  let state = reduce(initial(), change({ noseBridge: -.8, lipUpper: .4 }));
  state = reduce(state, { type: 'change', parameters: { noseSymmetry: -.7 }, symmetryDirection: -1 });
  const edited = state.present;
  state = reduce(state, { type: 'save', id: 'a', name: '  Dorso A  ' });
  assert.equal(state.present.variants[0].name, 'Dorso A');
  state = reduce(state, change({ noseBridge: 0, noseSymmetry: 0 }));
  assert.equal(state.present.parameters.lipUpper, .4, 'restaurar nariz no toca labios');
  state = reduce(state, { type: 'undo' });
  assert.deepEqual(state.present.parameters, edited.parameters);
  state = reduce(state, { type: 'redo' });
  state = reduce(state, { type: 'apply', id: 'a' });
  assert.deepEqual(state.present.parameters, edited.parameters);
  assert.equal(state.present.symmetryDirection, -1);
  state = reduce(state, { type: 'undo' });
  assert.equal(state.present.parameters.noseBridge, 0, 'aplicar también es reversible');
  state = reduce(state, { type: 'redo' });
  state = reduce(state, { type: 'change', parameters: sim.NEUTRAL_SIMULATION, symmetryDirection: 1 });
  assert.deepEqual(state.present.parameters, sim.NEUTRAL_SIMULATION);
  state = reduce(state, { type: 'undo' });
  assert.deepEqual(state.present.parameters, edited.parameters);
  assert.equal(state.present.symmetryDirection, -1);
  state = reduce(state, { type: 'delete', id: 'a' });
  assert.equal(state.present.variants.length, 0);
  state = reduce(state, { type: 'undo' });
  assert.equal(state.present.variants.length, 1);
  state = reduce(state, { type: 'undo' }); // guardar, una vez eliminado el reset/redo
  assert.equal(state.present.variants.length, 1);
  state = reduce(initial(), { type: 'save', id: 'a', name: 'A' });
  state = reduce(state, { type: 'undo' });
  assert.equal(state.present.variants.length, 0);
  state = reduce(state, { type: 'redo' });
  assert.equal(state.present.variants.length, 1);
});

test('sesión: rama nueva elimina redo; límites, sanitización e independencia de snapshots', () => {
  let state = initial();
  for (let i = 0; i < 120; i++) state = reduce(state, change({ noseTip: (i % 2) * 2 - 1 }));
  assert.equal(state.past.length, session.MORPHOLOGY_HISTORY_LIMIT);
  state = reduce(state, { type: 'undo' });
  state = reduce(state, change({ noseRotation: .3 }));
  assert.equal(state.future.length, 0);
  const saved = state.present;
  for (let i = 0; i < 20; i++) state = reduce(state, { type: 'save', id: String(i), name: `Variante ${i}` });
  assert.equal(state.present.variants.length, session.MORPHOLOGY_VARIANT_LIMIT);
  assert.equal(saved.variants.length, 0);
  const snapshot = state.present.variants[0];
  state = reduce(state, change({ noseTip: NaN, noseRotation: Infinity, noseBridge: -100 }));
  assert.equal(state.present.parameters.noseBridge, -1);
  assert.equal(state.present.parameters.noseTip, 0);
  assert.notDeepEqual(snapshot.parameters, state.present.parameters);
  state = reduce(reduce(state, { type: 'begin' }), change({ noseRadix: -.9 }));
  state = reduce(state, { type: 'undo' }); // gesto activo se cierra antes de deshacer
  assert.equal(state.present.parameters.noseRadix, 0);
});

test('sesión: cambio de fuente descarta historial/variantes; dirección neutra no recalcula geometría', () => {
  let state = initial();
  const neutral = state.present.parameters;
  state = reduce(state, { type: 'change', symmetryDirection: -1 });
  assert.equal(state.present.parameters, neutral, 'cambio de dirección sin intensidad reutiliza parámetros');
  state = reduce(state, change({ noseRadix: -.8 }));
  state = reduce(state, { type: 'save', id: 'old', name: 'Base anterior' });
  state = reduce(state, { type: 'undo' });
  state = reduce(state, { type: 'restart' });
  assert.deepEqual(state, initial());
  assert.equal(reduce(state, { type: 'redo' }), state, 'ningún estado viejo reaparece en la base calibrada');
  const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx');
  assert.match(viewer, /morphologySource\.current\.surface === surface && morphologySource\.current\.photo === photo/);
  assert.match(viewer, /dispatchMorphology\(\{ type: 'restart' \}\)/);
});

test('callback real de teclado: Ctrl/⌘ Z/Y, sin capturar inputs, select, editable ni Piel', () => {
  const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx');
  const source = ts.createSourceFile('viewer.tsx', viewer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'section'
      && node.attributes.properties.some(p => p.name?.getText(source) === 'data-face-editor')) {
      callback = node.attributes.properties.find(p => p.name?.getText(source) === 'onKeyDown').initializer.expression.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback, 'el harness extrae el callback JSX real, con su cierre');
  const compiled = ts.transpileModule(`const callback = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const actions = [];
  const create = tool => new Function('tool', 'dispatchMorphology', `${compiled}\nreturn callback;`)(tool, action => actions.push(action.type));
  const handler = create('morphology');
  let prevented = 0;
  const event = overrides => ({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    defaultPrevented: false, repeat: false, target: { closest: () => null }, preventDefault: () => prevented++, ...overrides });
  handler(event({}));
  handler(event({ ctrlKey: false, metaKey: true, shiftKey: true }));
  handler(event({ key: 'y' }));
  assert.deepEqual(actions, ['undo', 'redo', 'redo']);
  assert.equal(prevented, 3);
  for (const tag of ['input', 'textarea', 'select', 'contenteditable']) {
    handler(event({ target: { closest: selector => {
      assert.match(selector, /input, textarea, select, \[contenteditable\]/);
      return tag;
    } } }));
  }
  for (const override of [{ altKey: true }, { defaultPrevented: true }, { ctrlKey: false }, { key: 'x' }]) handler(event(override));
  create('skin')(event({}));
  assert.equal(actions.length, 3);
  handler(event({ repeat: true }));
  assert.equal(actions.length, 3, 'mantener Ctrl+Z no vacía el historial por repetición');
});

const openings = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95],
];
for (const [label, mesh] of meshes) {
  test(`${label}: raíz/dorso superior efectivos, giro fuerte progresivo y proyección independiente`, t => {
    const anchors = mesh.anchors, h = sim.meshBounds(anchors).height;
    const root = sim.deformPositions(anchors, anchors, { noseRadix: -1 });
    const bridge = sim.deformPositions(anchors, anchors, { noseBridge: -1 });
    const full = sim.deformPositions(anchors, anchors, { noseRotation: 1 });
    const half = sim.deformPositions(anchors, anchors, { noseRotation: .5 });
    const rootShift = (anchors[6 * 3 + 2] - root[6 * 3 + 2]) / h;
    const bridgeShift = (anchors[6 * 3 + 2] - bridge[6 * 3 + 2]) / h;
    const rotationShift = (full[1 * 3 + 1] - anchors[1 * 3 + 1]) / h;
    assert.ok(rootShift > .04, `inicio del dorso sin alcance: ${rootShift}`);
    assert.ok(bridgeShift > .025, `dorso superior sin alcance: ${bridgeShift}`);
    assert.ok(rotationShift > .025, `rotación pobre: ${rotationShift}`);
    assert.ok(full[1 * 3 + 1] - anchors[1 * 3 + 1] > (half[1 * 3 + 1] - anchors[1 * 3 + 1]) * 1.3);
    for (const sign of [-1, 1]) {
      const projection = sim.deformPositions(anchors, anchors, { noseTip: sign });
      assert.equal(projection[1 * 3 + 1], anchors[1 * 3 + 1]);
    }
    t.diagnostic(`raíz en 6=${(100 * rootShift).toFixed(2)}%h; dorso en 6=${(100 * bridgeShift).toFixed(2)}%h; elevación punta=${(100 * rotationShift).toFixed(2)}%h`);
  });

  test(`${label}: rebaja prominencia sintética del dorso superior, sin desplazar UV ni original`, t => {
    const anchors = mesh.anchors, h = sim.meshBounds(anchors).height;
    // Probes sintéticos: línea entre raíz/dorso medio más prominencia conocida en 6.
    // No usa reconstrucción ni atribuye un defecto de captura a anatomía.
    const [upper, lower] = [at(anchors, 168), at(anchors, 195)];
    const y = anchors[6 * 3 + 1], ratio = (y - lower[1]) / (upper[1] - lower[1]);
    const z = lower[2] + (upper[2] - lower[2]) * ratio;
    const probes = Float32Array.from([...lower, anchors[6 * 3], y, z + h * .025, ...upper]);
    const original = probes.slice();
    const out = sim.deformPositions(probes, anchors, { noseRadix: -1, noseBridge: -.4 });
    const excessBefore = probes[5] - (probes[2] + (probes[8] - probes[2]) * ratio);
    const excessAfter = out[5] - (out[2] + (out[8] - out[2]) * ratio);
    assert.ok(excessAfter < excessBefore * .65, `prominencia residual ${excessAfter / excessBefore}`);
    assert.deepEqual(probes, original);
    assert.deepEqual(sim.deformPositions(probes, anchors, {}), probes);
    t.diagnostic(`prominencia superior residual=${(100 * excessAfter / excessBefore).toFixed(1)}%`);
  });

  test(`${label}: extremos combinados conservan TODAS las aberturas y topología refinada`, t => {
    const dense = refineDisplaySurface(mesh.anchors, Uint32Array.from(atlas.triangles));
    const cases = [-1, 1].flatMap(sign => [
      { noseRadix: sign }, { noseBridge: sign }, { noseRotation: sign },
      { noseRadix: sign, noseBridge: sign, noseHump: sign, noseRotation: sign, noseTip: sign },
      { noseSymmetry: sign },
    ]);
    let minimum = 1;
    for (const parameters of cases) {
      const out = sim.deformPositions(dense.positions, mesh.anchors, parameters, dense.indices);
      assert.ok(out.every(Number.isFinite));
      for (const id of openings.flat()) assert.deepEqual(at(out, id), at(dense.positions, id), `abertura ${id}`);
      for (let k = 0; k < dense.indices.length; k += 3) {
        const ids = Array.from(dense.indices.slice(k, k + 3));
        const normal = p => {
          const [a, b, c] = ids.map(id => new THREE.Vector3(...at(p, id)));
          return b.sub(a).cross(c.sub(a));
        };
        const before = normal(dense.positions), after = normal(out);
        if (before.lengthSq() < 1e-20) continue;
        const orientedArea = before.dot(after) / before.lengthSq();
        minimum = Math.min(minimum, orientedArea);
        assert.ok(orientedArea >= .099, `área orientada ${orientedArea}`);
      }
    }
    t.diagnostic(`casos=${cases.length}; área orientada mínima=${minimum.toFixed(4)}; bordes protegidos=${openings.flat().length}`);
  });

  test(`${label}: umbrales de pantalla frontales/perfil a encuadre neutro, sin WebGL`, t => {
    const anchors = mesh.anchors, bounds = sim.meshBounds(anchors), h = bounds.height;
    const rotated = sim.deformPositions(anchors, anchors, { noseRotation: 1 });
    const root = sim.deformPositions(anchors, anchors, { noseRadix: -1 });
    const metrics = [];
    for (const [width, height] of [[640, 600], [366, 320]]) {
      const camera = new THREE.OrthographicCamera(-h * width / height * .6, h * width / height * .6, h * .6, -h * .6, .01, 1000);
      for (const side of [0, -1, 1]) {
        const center = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
        camera.position.copy(center).add(new THREE.Vector3(side * h * 3, 0, side ? 0 : h * 3));
        camera.lookAt(center); camera.updateMatrixWorld();
        const project = (p, id) => {
          const v = new THREE.Vector3(...at(p, id)).project(camera);
          return [v.x * width / 2, v.y * height / 2];
        };
        const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        const tipPx = distance(project(anchors, 1), project(rotated, 1));
        const radixPx = distance(project(anchors, 6), project(root, 6));
        assert.ok(tipPx > 6, `giro apenas visible: ${tipPx}px`);
        if (side) assert.ok(radixPx > 9, `dorso superior apenas visible: ${radixPx}px`);
        else assert.ok(radixPx < .001, 'profundidad pura no mueve frente XY');
        metrics.push(`${width}/${side ? `perfil${side}` : 'frente'}: punta ${tipPx.toFixed(1)}px, raíz ${radixPx.toFixed(1)}px`);
      }
    }
    t.diagnostic(metrics.join('; '));
  });
}

// ── Dorso · alinear perfil ────────────────────────────────────────────────
// Base sintética con giba conocida centrada entre 6 y 197. Una ventana sin² la anula
// en glabela 9 y suprapunta 5, de modo que la cuerda de referencia NO cambia; la
// amplitud se ajusta hasta que el relieve medido sobre esa cuerda sea exactamente E·h.
// Mismo campo en anclas y superficie refinada. Sin foto, persona real ni reconstrucción.
function humpedBase(anchors, elevation, sigma = [.10, .07]) {
  const h = sim.meshBounds(anchors).height;
  const axis = (anchors[30] + anchors[456] + anchors[3]) / 3;
  const y5 = anchors[5 * 3 + 1], y9 = anchors[9 * 3 + 1];
  const cy = (anchors[6 * 3 + 1] + anchors[197 * 3 + 1]) / 2;
  const dense = refineDisplaySurface(anchors, Uint32Array.from(atlas.triangles));
  const bump = (source, amplitude) => {
    const out = Float32Array.from(source);
    for (let i = 0; i < out.length / 3; i++) {
      const y = out[i * 3 + 1], t = (y - y5) / (y9 - y5);
      if (t <= 0 || t >= 1) continue;
      const dx = (out[i * 3] - axis) / (sigma[0] * h), dy = (y - cy) / (sigma[1] * h);
      out[i * 3 + 2] += amplitude * Math.exp(-(dx * dx + dy * dy) / 2) * Math.sin(Math.PI * t) ** 2;
    }
    return out;
  };
  let low = 0, high = h * .5;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (sim.nasalProfileExcess(bump(dense.positions, middle), anchors) < elevation) low = middle; else high = middle;
  }
  return { anchors: bump(anchors, high), dense: { ...dense, positions: bump(dense.positions, high) }, h };
}
function minimumOrientedArea(before, after, indices) {
  let minimum = 1;
  for (let k = 0; k < indices.length; k += 3) {
    const ids = Array.from(indices.slice(k, k + 3));
    const normal = p => {
      const [a, b, c] = ids.map(id => new THREE.Vector3(...at(p, id)));
      return b.sub(a).cross(c.sub(a));
    };
    const n0 = normal(before), n1 = normal(after);
    if (n0.lengthSq() >= 1e-20) minimum = Math.min(minimum, n0.dot(n1) / n0.lengthSq());
  }
  return minimum;
}

test('alinear perfil: parámetro unidireccional 0..1, neutro 0 y fuera de los controles bipolares', () => {
  assert.equal(sim.NEUTRAL_SIMULATION.noseProfileAlign, 0);
  assert.equal(sim.sanitizeSimulation({ noseProfileAlign: -1 }).noseProfileAlign, 0, 'no rellena: sin valores negativos');
  assert.equal(sim.sanitizeSimulation({ noseProfileAlign: 4 }).noseProfileAlign, 1);
  assert.equal(sim.sanitizeSimulation({ noseProfileAlign: Number.NaN }).noseProfileAlign, 0);
  assert.ok(!sim.SIMULATION_CONTROLS.some(control => control.key === 'noseProfileAlign'), 'no hereda rango −1..1');
  for (const control of sim.SIMULATION_CONTROLS) assert.equal(sim.sanitizeSimulation({ [control.key]: -1 })[control.key], -1, `${control.key} conserva rango`);
  let state = reduce(initial(), { type: 'begin' });
  state = reduce(state, change({ noseProfileAlign: .4 }));
  state = reduce(state, change({ noseProfileAlign: 1 }));
  state = reduce(reduce(state, { type: 'end' }), { type: 'save', id: 'a', name: 'Dorso alineado' });
  assert.equal(state.present.variants[0].parameters.noseProfileAlign, 1, 'la variante guarda el control');
  state = reduce(state, change({ ...sim.NEUTRAL_SIMULATION }));
  assert.equal(state.present.parameters.noseProfileAlign, 0, 'restablecer todo lo vuelve a 0');
  state = reduce(state, { type: 'undo' });
  assert.equal(state.present.parameters.noseProfileAlign, 1, 'deshacer restablece el control');
  state = reduce(reduce(state, { type: 'undo' }), { type: 'undo' });
  assert.equal(state.present.parameters.noseProfileAlign, 0, 'el arrastre completo es una sola entrada');
});

for (const [label, mesh] of meshes) {
  test(`${label}: alinear perfil no actúa sobre un perfil que ya queda bajo la línea 9→5`, t => {
    const dense = refineDisplaySurface(mesh.anchors, Uint32Array.from(atlas.triangles));
    const h = sim.meshBounds(mesh.anchors).height;
    const excess = sim.nasalProfileExcess(dense.positions, mesh.anchors);
    const out = sim.deformPositions(dense.positions, mesh.anchors, { noseProfileAlign: 1 }, dense.indices);
    let moved = 0;
    for (let i = 0; i < out.length; i++) moved = Math.max(moved, Math.abs(out[i] - dense.positions[i]));
    assert.ok(moved <= Math.max(excess * h, h * .0005) + 1e-6, `movió ${moved / h}h sin giba`);
    t.diagnostic(`relieve base=${(100 * excess).toFixed(3)}%h; desplazamiento máx=${(100 * moved / h).toFixed(3)}%h`);
  });

  test(`${label}: alinear perfil al 100 % deja ≤10 % de la giba conocida, XY/aberturas/punta intactos`, t => {
    const metrics = [];
    for (const elevation of [.01, .02, .03]) {
      const base = humpedBase(mesh.anchors, elevation);
      const { positions, indices } = base.dense, original = positions.slice();
      const before = sim.nasalProfileExcess(positions, base.anchors);
      assert.ok(before > elevation * .7, `giba sintética no construida: ${before}`);
      let protection;
      const full = sim.deformPositions(positions, base.anchors, { noseProfileAlign: 1 }, indices, value => { protection = value; });
      const half = sim.deformPositions(positions, base.anchors, { noseProfileAlign: .5 }, indices);
      const deformedAnchors = sim.deformPositions(base.anchors, base.anchors, { noseProfileAlign: 1 });
      for (const id of [9, 5, 4, 1, 2, 94]) assert.deepEqual(at(deformedAnchors, id), at(base.anchors, id), `ancla ${id}`);
      const residual = sim.nasalProfileExcess(full, base.anchors) / before;
      const residualHalf = sim.nasalProfileExcess(half, base.anchors) / before;
      assert.ok(residual <= .10, `residual ${(100 * residual).toFixed(1)}% (protección ${JSON.stringify(protection)})`);
      assert.ok(residualHalf > residual + .25 && residualHalf < .75, `progresión 50 %: ${residualHalf}`);
      for (let i = 0; i < full.length; i += 3) {
        assert.equal(full[i], positions[i]); assert.equal(full[i + 1], positions[i + 1]);
        assert.ok(full[i + 2] <= positions[i + 2] + 1e-6, 'solo rebaja, nunca rellena');
      }
      for (const id of openings.flat()) assert.deepEqual(at(full, id), at(positions, id), `abertura ${id}`);
      const area = minimumOrientedArea(positions, full, indices);
      assert.ok(area >= .099, `área orientada ${area}`);
      assert.deepEqual(positions, original);
      metrics.push(`E${elevation}: ${(100 * before).toFixed(2)}%h→residual ${(100 * residual).toFixed(1)}% (50 %: ${(100 * residualHalf).toFixed(0)}%), área ${area.toFixed(3)}, moderado ${protection.moderatedComponents}`);
    }
    t.diagnostic(metrics.join('; '));
  });

  test(`${label}: giba estrecha extrema o combinada con todos los controles nasales es segura o avisa`, t => {
    const base = humpedBase(mesh.anchors, .03, [.06, .06]);
    const { positions, indices } = base.dense;
    const before = sim.nasalProfileExcess(positions, base.anchors);
    let protection;
    const out = sim.deformPositions(positions, base.anchors, { noseProfileAlign: 1 }, indices, value => { protection = value; });
    const residual = sim.nasalProfileExcess(out, base.anchors) / before;
    assert.ok(residual <= .10 || protection.moderatedComponents > 0, `residual ${residual} sin aviso de protección`);
    let minimum = minimumOrientedArea(positions, out, indices);
    for (const sign of [-1, 1]) {
      const combined = sim.deformPositions(positions, base.anchors, {
        noseProfileAlign: 1, noseRadix: sign, noseBridge: sign, noseHump: sign, noseRotation: sign, noseTip: sign, noseWidth: sign,
      }, indices);
      for (const id of openings.flat()) assert.deepEqual(at(combined, id), at(positions, id), `abertura ${id}`);
      minimum = Math.min(minimum, minimumOrientedArea(positions, combined, indices));
    }
    assert.ok(minimum >= .099, `área orientada ${minimum}`);
    t.diagnostic(`giba estrecha ${(100 * before).toFixed(2)}%h → residual ${(100 * residual).toFixed(1)}%; moderado ${protection.moderatedComponents} (mín ${(100 * protection.minimumStrength).toFixed(0)}%); área mín ${minimum.toFixed(3)}`);
  });
}
