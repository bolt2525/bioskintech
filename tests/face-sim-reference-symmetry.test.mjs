import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = new URL('../src/lab/faceSim/', import.meta.url);
const atlas = JSON.parse(readFileSync(new URL('genericFaceAtlas.json', root), 'utf8'));
const compile = name => ts.transpileModule(readFileSync(new URL(name, root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const exports = {};
  modules[name] = exports;
  vm.runInNewContext(compile(name), { exports, console, require: path => {
    if (path === './genericFaceAtlas.json') return { default: atlas };
    if (path.startsWith('./')) return load(/\.(ts|tsx)$/.test(path) ? path.slice(2) : `${path.slice(2)}.ts`);
    return require(path);
  } });
  return exports;
}
const sim = load('simulation.ts');
const zones = load('anatomicalZones.ts');
const { buildReferenceGeometry } = load('referenceGeometry.ts');
const displayAPI = load('anatomyDisplay.tsx');
const { initialAnatomyDisplay, chooseAnatomyDisplay, AnatomyLayerControls } = displayAPI;
const at = (p, i) => Array.from(p.slice(i * 3, i * 3 + 3));
const near = (a, b, epsilon = 2e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${i}: ${v} ≠ ${b[i]}`));
const clone = value => JSON.parse(JSON.stringify(value));

test('hueco nasal geométrico: filtra índices sin renumerar UV; puente alto intacto; no mutación ni DOM', () => {
  const positions = Float32Array.from([
    -1, 0, 0, 1, 0, 0, 0, 1, 0, // puente óseo alto
    -0.1, 0, 2, 0.1, 0, 2, 0, 0.1, 2, // abertura
    -1, -1, 0, 1, -1, 0, 0, -0.5, 0, // maxilar
  ]);
  const indices = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const uvs = Float32Array.from([0.47, 0.41, 0.54, 0.41, 0.51, 0.37,
    0.49, 0.55, 0.55, 0.55, 0.52, 0.59, 0.35, 0.66, 0.68, 0.66, 0.51, 0.73]);
  const reference = { kind: 'bone', depth: 0, uvs, zones: zones.ANATOMICAL_ZONES.bone };
  const before = [positions.slice(), indices.slice(), uvs.slice()];
  const result = buildReferenceGeometry(positions, indices, reference);
  assert.deepEqual(Array.from(result.indices), [0, 1, 2, 6, 7, 8]);
  assert.equal(result.positions.length, positions.length);
  near(Array.from(result.positions.slice(0, 9)), Array.from(positions.slice(0, 9)));
  assert.ok(result.positions[3 * 3 + 2] < 0.01, 'no queda una punta cutánea sólida');
  for (const [i, buffer] of [positions, indices, uvs].entries()) assert.deepEqual(buffer, before[i]);
  assert.notEqual(result.positions, positions); assert.notEqual(result.indices, indices);
  for (const kind of ['muscle', 'vessels']) {
    assert.deepEqual(Array.from(buildReferenceGeometry(positions, indices, { ...reference, kind }).indices), Array.from(indices));
  }
  assert.equal(buildReferenceGeometry(positions, indices, { ...reference, zones: undefined }).indices.length, indices.length,
    'las imágenes propias no heredan huecos de la ilustración');
  assert.throws(() => buildReferenceGeometry(positions, indices, { ...reference, uvs: new Float32Array(2) }), /inválidos/);
  assert.throws(() => buildReferenceGeometry(positions, Uint32Array.from([0, 1, 99]), reference), /inválidos/);
});

test('zonas medidas en imagen completa: músculos, rutas vasculares finas, abertura y huesos nasales', () => {
  for (const [u, v] of [[0.515, 0.48], [0.50, 0.55], [0.55, 0.60]]) {
    assert.equal(zones.isBoneNasalOpening(u, v), true);
    assert.equal(zones.anatomicalZoneAt(zones.ANATOMICAL_ZONES.bone, u, v), null);
  }
  assert.equal(zones.isBoneNasalOpening(0.5, 0.42), false);
  assert.match(zones.anatomicalZoneAt(zones.ANATOMICAL_ZONES.bone, 0.5, 0.42), /nasales/);
  assert.match(zones.anatomicalZoneAt(zones.ANATOMICAL_ZONES.muscle, 0.22, 0.77), /Masetero/);
  assert.match(zones.anatomicalZoneAt(zones.ANATOMICAL_ZONES.vessels, 0.29, 0.735), /facial/);
  assert.match(zones.anatomicalZoneAt(zones.ANATOMICAL_ZONES.vessels, 0.71, 0.735), /facial/);
  assert.equal(zones.anatomicalZoneAt(zones.ANATOMICAL_ZONES.vessels, 0.25, 0.755), null,
    'no clasifica el antiguo trayecto desplazado');
});

test('registro óseo real del atlas: puente alto fuera del hueco, punta dentro; overlay usa esos mismos UV', () => {
  const { DEFAULT_LAYER_SOURCES, registerLayers } = load('defaultLayers.ts');
  const source = DEFAULT_LAYER_SOURCES.find(layer => layer.kind === 'bone');
  const photoUVs = Float32Array.from(Array.from({ length: 468 }, (_, i) =>
    [0.5 + atlas.positions[i * 3] / 4, 0.5 - atlas.positions[i * 3 + 1] / 4]).flat());
  const snapshot = photoUVs.slice();
  const [reference] = registerLayers([{ source, canvas: {}, landmarks: null }], photoUVs);
  for (const id of [168, 6]) assert.equal(zones.isBoneNasalOpening(reference.uvs[id * 2], reference.uvs[id * 2 + 1]), false);
  assert.equal(zones.isBoneNasalOpening(reference.uvs[4 * 2], reference.uvs[4 * 2 + 1]), true);
  const indices = Uint32Array.from(atlas.triangles);
  const geometry = buildReferenceGeometry(Float32Array.from(atlas.positions), indices, reference);
  assert.ok(geometry.indices.length < indices.length);
  assert.ok(geometry.indices.includes(6), 'conserva geometría del puente alto');
  assert.equal(geometry.indices.includes(4), false, 'la punta no tapa la abertura');
  // El overlay interpola en cada triángulo retenido, no en UV de foto ni en etiquetas previas.
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const ids = Array.from(geometry.indices.slice(i, i + 3));
    const uv = [0, 1].map(axis => ids.reduce((sum, id) => sum + reference.uvs[id * 2 + axis] / 3, 0));
    assert.equal(zones.isBoneNasalOpening(...uv), false);
  }
  assert.deepEqual(photoUVs, snapshot);
});

test('UV genéricos iguales al chart XY de marcaciones: 33/263/152 alineados, sin UV de foto inventados', () => {
  const { buildCanonicalReferenceUVs, registerLayers, DEFAULT_LAYER_SOURCES } = load('defaultLayers.ts');
  const source = atlas.positions.slice(), snapshot = source.slice();
  const uvs = buildCanonicalReferenceUVs(source);
  const xs = atlas.positions.filter((_, i) => i % 3 === 0), ys = atlas.positions.filter((_, i) => i % 3 === 1);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.max(...ys), bottom = Math.min(...ys);
  // Mismo criterio que annotationUVs(atlas), sin importar ni modificar archivos del agente B.
  const annotationUVs = Float32Array.from(xs.flatMap((x, i) => [(x - left) / (right - left), (top - ys[i]) / (top - bottom)]));
  assert.deepEqual(Array.from(uvs), Array.from(annotationUVs));
  const loaded = DEFAULT_LAYER_SOURCES.map(source => ({ source, canvas: {}, landmarks: null }));
  const references = registerLayers(loaded, uvs);
  for (const [layer, reference] of references.entries()) {
    for (const [anchor, id] of [33, 263, 152].entries()) {
      near(Array.from(reference.uvs.slice(id * 2, id * 2 + 2)),
        [loaded[layer].source.anchors[anchor].x, loaded[layer].source.anchors[anchor].y]);
    }
  }
  assert.deepEqual(source, snapshot);
  assert.throws(() => buildCanonicalReferenceUVs([0, 0, 0, 0, 1, 0]), /extensión XY/);
  assert.throws(() => buildCanonicalReferenceUVs([0, NaN, 0]), /no finitas/);
  assert.throws(() => buildCanonicalReferenceUVs([0, 1]), /incompleto/);
});

test('preparación de render genérico: referencias sobre cara468, nunca sobre índices de la cabeza completa', () => {
  const { buildCanonicalReferenceUVs, registerLayers, DEFAULT_LAYER_SOURCES } = load('defaultLayers.ts');
  const mesh = sim.createSimulationMesh();
  assert.ok(mesh.positions.length > mesh.anchors.length);
  assert.notDeepEqual(Array.from(mesh.positions.slice(0, 468 * 3)), Array.from(mesh.anchors));
  assert.equal(mesh.uvs, undefined, 'la piel genérica no tiene una foto ni UV fotográficos');
  const prepared = sim.buildSimulationReferenceSurface(mesh, {});
  assert.deepEqual(Array.from(prepared.positions), atlas.positions.map(Math.fround));
  assert.deepEqual(Array.from(prepared.indices), atlas.triangles);
  const uvs = buildCanonicalReferenceUVs(atlas.positions);
  const references = registerLayers(DEFAULT_LAYER_SOURCES.map(source => ({ source, canvas: {}, landmarks: null })), uvs);
  for (const reference of references) {
    const data = buildReferenceGeometry(prepared.positions, prepared.indices, reference);
    assert.equal(data.positions.length / 3, 468);
    assert.ok(data.indices.length > 0, reference.kind);
    assert.ok(data.indices.every(id => id < 468), reference.kind);
    assert.equal(reference.uvs.length, data.positions.length / 3 * 2);
  }
  const deformed = sim.buildSimulationReferenceSurface(mesh, { noseTip: 0.6 });
  assert.notDeepEqual(Array.from(deformed.positions), Array.from(prepared.positions));
  assert.deepEqual(Array.from(mesh.anchors), atlas.positions.map(Math.fround));
});

function asymmetricNose() {
  const p = Float32Array.from(atlas.positions);
  // Marco sin roll ni yaw; alas deliberadamente distintas en X, Y y Z.
  p.set([-0.7, 0.8, 1.15], 33 * 3); p.set([0.7, 0.8, 1.15], 263 * 3);
  p[10 * 3] = p[152 * 3] = 0;
  p.set([-0.25, 0.10, 1.48], 98 * 3); p.set([0.34, 0.18, 1.56], 327 * 3);
  return p;
}

test('simetría real ambas direcciones DEL PACIENTE: corrige anchura, altura y profundidad; intensidad lineal', () => {
  const original = asymmetricNose(), snapshot = original.slice();
  for (const direction of [1, -1]) {
    const source = direction === 1 ? 98 : 327, target = direction === 1 ? 327 : 98;
    const result = sim.deformPositions(original, original, { noseSymmetry: direction });
    const expected = at(original, source); expected[0] *= -1;
    near(at(result, target), expected);
    near(at(result, source), at(original, source));
    const half = sim.deformPositions(original, original, { noseSymmetry: direction * 0.5 });
    near(at(half, target), at(original, target).map((v, axis) => (v + expected[axis]) / 2));
    for (const id of [10, 152, 33, 263, 13, 14, 172, 397, 117, 346]) near(at(result, id), at(original, id));
    assert.deepEqual(result, sim.deformPositions(original, original, { noseSymmetry: direction }));
  }
  assert.deepEqual(Array.from(sim.deformPositions(original, original, {})), Array.from(original));
  assert.deepEqual(Array.from(sim.deformPositions(original, original, { noseSymmetry: 0 })), Array.from(original));
  assert.deepEqual(original, snapshot);
  assert.equal(sim.sanitizeSimulation({ noseSymmetry: 3 }).noseSymmetry, 1);
  assert.equal(sim.sanitizeSimulation({ noseSymmetry: -3 }).noseSymmetry, -1);
  assert.equal(sim.sanitizeSimulation({ noseSymmetry: NaN }).noseSymmetry, 0);
});

test('simetría independiente de pose rígida; continuidad de línea media y superficie densa', () => {
  const original = asymmetricNose();
  // Rotación yaw seguida de roll, más traslación.
  const rigid = p => {
    const x = Math.cos(0.8) * p[0] + Math.sin(0.8) * p[2];
    return [Math.cos(0.3) * x - Math.sin(0.3) * p[1] + 3,
      Math.sin(0.3) * x + Math.cos(0.3) * p[1] - 4,
      -Math.sin(0.8) * p[0] + Math.cos(0.8) * p[2] - 2];
  };
  const posed = Float32Array.from(Array.from({ length: 468 }, (_, i) => rigid(at(original, i))).flat());
  for (const direction of [1, -1]) {
    const canonical = sim.deformPositions(original, original, { noseSymmetry: direction });
    const result = sim.deformPositions(posed, posed, { noseSymmetry: direction });
    for (let i = 0; i < 468; i++) near(at(result, i), rigid(at(canonical, i)), 3e-6);
  }
  const dense = Float32Array.from([...original, ...at(original, 327)]);
  const corrected = sim.deformPositions(dense, original, { noseSymmetry: 1 });
  near(at(corrected, 468), at(corrected, 327), 2e-5);
  const center = at(original, 4);
  const probes = Float32Array.from([-1e-5, 0, 1e-5].flatMap(dx => [center[0] + dx, center[1] + dx, center[2]]));
  const result = sim.deformPositions(probes, original, { noseSymmetry: 1 });
  assert.ok(Math.hypot(...at(result, 0).map((v, axis) => v - at(result, 2)[axis])) < 0.001);
});

test('estado compartido: vistas rápidas inmutables, opacidades conservadas, reset independiente', () => {
  const current = initialAnatomyDisplay(), snapshot = clone(current);
  current.references.muscle.opacity = 0.32;
  const vascular = chooseAnatomyDisplay(current, 'vessels');
  assert.equal(vascular.references.muscle.visible, true);
  assert.equal(vascular.references.vessels.visible, true);
  assert.equal(vascular.references.bone.visible, false);
  assert.equal(vascular.references.muscle.opacity, 0.32);
  assert.equal(vascular.skin.opacity, 0);
  assert.equal(current.skin.opacity, 1);
  assert.deepEqual(clone(initialAnatomyDisplay()), snapshot);
  assert.equal(chooseAnatomyDisplay(vascular, 'skin').skin.opacity, 1);
});

const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object'
  ? text(tree.props?.children) : String(tree ?? '');
const find = (tree, predicate) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(child => find(child, predicate))
  : [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
const expand = tree => !tree || typeof tree !== 'object' ? tree : Array.isArray(tree) ? tree.map(expand)
  : typeof tree.type === 'function' ? expand(tree.type(tree.props))
    : { ...tree, props: { ...tree.props, children: expand(tree.props?.children) } };

function editor({ runEffects = false, loadLayers } = {}) {
  const states = [];
  const effects = [], refs = [];
  let cursor = 0, effectCursor = 0, refCursor = 0, pending = [], renderState;
  const exports = {};
  vm.runInNewContext(compile('FacialSimulationViewer.tsx'), {
    exports, console, Error, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    window: { matchMedia: () => ({ matches: false }) }, require: name => {
      if (name === 'react') return { ...React, useId: () => 'editor',
        useRef: initial => {
          const i = refCursor++;
          return refs[i] ??= { current: initial };
        },
        useEffect(fn, deps) {
          const i = effectCursor++;
          if (!runEffects || deps && effects[i]?.deps && deps.every((value, j) => Object.is(value, effects[i].deps[j]))) return;
          pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; });
        },
        useMemo: fn => {
          const value = fn();
          if (value?.parameters && value?.references) renderState = value;
          return value;
        },
        useCallback: fn => fn,
        useState(initial) {
          const i = cursor++;
          if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
          return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
        } };
      if (name === './genericFaceAtlas.json') return { default: atlas };
      if (name === './anatomyDisplay') return displayAPI;
      if (name === './faceRegions') return { buildFaceRegionMap: () => ({}), buildFaceTriangleRegions: () => [] };
      if (name === './regionMesh') return { buildRegionCells: () => [] };
      if (name === './estimatedHair') return { DEFAULT_HAIR: { enabled: false } };
      if (name === './MarkingPanels') return { editorPanel: 'editor-panel' };
      if (name === './skinSignalTexture') return {};
      if (name === './defaultLayers' && loadLayers) return { ...load('defaultLayers.ts'), loadDefaultLayers: loadLayers };
      if (name.startsWith('three/')) return {};
      if (name.startsWith('./')) return load(`${name.slice(2)}.ts`);
      if (name.endsWith('/clinicalCamera')) return {};
      return require(name);
    },
  });
  return {
    render(props = {}) {
      cursor = 0; effectCursor = 0; refCursor = 0; pending = [];
      const tree = expand(exports.FacialSimulationViewer(props));
      pending.forEach(fn => fn());
      return tree;
    },
    get state() { return renderState; },
  };
}

test('visor sin surface: carga referencias reales para Músculo y muestra preparación/error, no silencio', async () => {
  const { DEFAULT_LAYER_SOURCES } = load('defaultLayers.ts');
  let calls = 0;
  const app = editor({ runEffects: true, loadLayers: async () => {
    calls++;
    return DEFAULT_LAYER_SOURCES.map(source => ({ source, canvas: {}, landmarks: null }));
  } });
  const props = {};
  let tree = app.render(props);
  find(tree, n => n.type === 'button' && text(n) === 'Capas')[0].props.onClick();
  tree = app.render(props);
  find(tree, n => n.type === 'button' && text(n) === 'Músculo')[0].props.onClick();
  tree = app.render(props);
  assert.equal(calls, 1, 'carga aun sin foto ni surface');
  assert.match(text(tree), /Preparando referencias ilustrativas sobre el modelo genérico/);
  assert.doesNotMatch(text(tree), /Carga una foto con referencias faciales para acoplar/);
  await new Promise(resolve => setImmediate(resolve));
  tree = app.render(props);
  assert.equal(calls, 1, 'el chart genérico es estable entre renders');
  assert.equal(app.state.references.length, 3);
  const muscle = app.state.references.find(reference => reference.kind === 'muscle');
  assert.ok(muscle);
  assert.equal(app.state.referenceLayers.muscle.visible, true);
  assert.equal(app.state.layers.skin.opacity, 0);
  const prepared = sim.buildSimulationReferenceSurface(sim.createSimulationMesh(), app.state.parameters);
  assert.ok(buildReferenceGeometry(prepared.positions, prepared.indices, muscle).indices.length > 0);
  assert.doesNotMatch(text(tree), /Preparando referencias ilustrativas/);

  const failed = editor({ runEffects: true, loadLayers: async () => { throw new Error('Ilustración local no disponible'); } });
  const first = failed.render(props);
  find(first, n => n.type === 'button' && text(n) === 'Capas')[0].props.onClick();
  failed.render(props); await new Promise(resolve => setImmediate(resolve));
  const errorTree = failed.render(props);
  assert.ok(find(errorTree, n => n.props?.role === 'alert' && text(n).includes('Ilustración local no disponible')).length);
  assert.ok(find(errorTree, n => n.type === 'button' && text(n) === 'Reintentar referencias').length);
});

test('transición genérico→personal descarta referencias/UV previos antes de preparar el nuevo render', async () => {
  const { DEFAULT_LAYER_SOURCES, buildCanonicalReferenceUVs } = load('defaultLayers.ts');
  const loaded = DEFAULT_LAYER_SOURCES.map(source => ({ source, canvas: {}, landmarks: null }));
  let resolvePersonal;
  let calls = 0;
  const app = editor({ runEffects: true, loadLayers: () => ++calls === 1 ? Promise.resolve(loaded)
    : new Promise(resolve => { resolvePersonal = resolve; }) });
  const first = app.render();
  find(first, n => n.type === 'button' && text(n) === 'Capas')[0].props.onClick();
  app.render(); await new Promise(resolve => setImmediate(resolve)); app.render();
  const genericReferences = app.state.references;
  const uvs = buildCanonicalReferenceUVs(atlas.positions);
  const surface = {
    positions: Float32Array.from(atlas.positions), indices: Uint32Array.from(atlas.triangles), uvs,
    projection: { cx: 0, cy: 0, k: 1, aspect: 1 },
  };
  app.render({ surface });
  assert.equal(app.state.references.length, 0, 'no entrega referencias del genérico al nuevo renderer personal');
  resolvePersonal(loaded);
  await new Promise(resolve => setImmediate(resolve));
  app.render({ surface });
  assert.equal(app.state.references.length, 3);
  assert.notEqual(app.state.references, genericReferences);
  const base = sim.createSimulationMesh(surface);
  const refined = load('displaySurface.ts').refineDisplaySurface(base.positions, base.indices);
  const personal = sim.buildSimulationReferenceSurface({ ...base, positions: refined.positions, indices: refined.indices }, {});
  for (const reference of app.state.references) assert.ok(buildReferenceGeometry(personal.positions, personal.indices, {
    ...reference, uvs: refined.attribute(reference.uvs, 2),
  }).indices.length);
});

test('controles compartidos accesibles: emiten cambios sin mutar props, mesh y disabled', () => {
  const value = initialAnatomyDisplay(), changes = [], meshes = [];
  const tree = AnatomyLayerControls({ value, onChange: next => changes.push(next), showMesh: false,
    onMeshChange: next => meshes.push(next), disabled: true });
  assert.equal(tree.props.disabled, true);
  assert.equal(find(tree, n => n.type === 'button').length, 4);
  const slider = find(tree, n => n.props?.['aria-label'] === 'Opacidad: Piel')[0];
  slider.props.onChange({ target: { value: '0.2' } });
  assert.equal(changes[0].skin.opacity, 0.2); assert.equal(value.skin.opacity, 1);
  find(tree, n => n.type === 'input' && n.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(meshes, [true]);
});

test('visor independiente: capas no se heredan, selección restaura opacidad y morfología vuelve a piel', () => {
  const app = editor();
  const external = chooseAnatomyDisplay(initialAnatomyDisplay(), 'bone');
  const props = () => ({ anatomyDisplay: external, showMesh: true,
    surface: { uvs: new Float32Array(936) } });
  let tree = app.render(props());
  const button = label => find(tree, n => n.type === 'button' && text(n) === label)[0];
  const opacity = () => find(tree, n => n.props?.['aria-label'] === 'Opacidad: Piel')[0];
  assert.equal(app.state.anatomy, 'skin');
  assert.equal(app.state.showMesh, false);
  button('Capas').props.onClick(); tree = app.render(props());
  assert.equal(find(tree, n => n.props?.['aria-label'] === 'Capa rápida').length, 1);
  button('Óseo').props.onClick();
  tree = app.render(props());
  assert.equal(app.state.anatomy, 'bone');
  assert.equal(app.state.showMesh, false, 'seleccionar capa no activa malla');
  tree = app.render(props());
  assert.equal(opacity().props.value, 0);
  opacity().props.onChange({ target: { value: '0.41' } });
  tree = app.render(props());
  assert.equal(opacity().props.value, 0.41);
  button('Músculo').props.onClick(); tree = app.render(props());
  assert.equal(app.state.referenceLayers.vessels.visible, true);
  const muscleOpacity = find(tree, n => n.props?.['aria-label'] === 'Opacidad: Músculo')[0];
  muscleOpacity.props.onChange({ target: { value: '0' } }); tree = app.render(props());
  button('Músculo').props.onClick(); tree = app.render(props());
  assert.ok(app.state.referenceLayers.muscle.opacity > 0);
  button('Corte').props.onClick(); tree = app.render(props());
  const cut = find(tree, n => n.type === 'label' && text(n).startsWith('Modo de corte'))[0];
  find(cut, n => n.type === 'select')[0].props.onChange({ target: { value: 'progressive' } });
  tree = app.render(props());
  assert.equal(app.state.overlay, false);
  assert.equal(app.state.layers.skin.opacity, 1);
  button('Morfología').props.onClick(); tree = app.render(props());
  assert.equal(app.state.anatomy, 'skin');
  assert.equal(app.state.layers.skin.opacity, 1);
  assert.equal(app.state.cut.scope, 'none');
  assert.equal(app.state.reveal.mode, 'none');
  assert.equal(app.state.referenceLayers.muscle.visible, false);
  assert.equal(external.anatomy, 'bone', 'estado externo intacto');
  button('Restablecer todo').props.onClick();
  tree = app.render(props());
  assert.equal(app.state.anatomy, 'skin');
});

test('visor standalone: simetría reversible sin tocar otros controles ni UV; dirección separada 0..1', () => {
  const app = editor();
  let tree = app.render();
  const label = prefix => find(tree, n => n.type === 'label' && text(n).startsWith(prefix))[0];
  const control = (prefix, type) => find(label(prefix), n => n.type === type)[0];
  control('Intensidad de simetría', 'input').props.onChange({ target: { value: '0.7' } });
  tree = app.render(); assert.equal(control('Intensidad de simetría', 'input').props.value, 0.7);
  control('Simetría nasal', 'select').props.onChange({ target: { value: '-1' } });
  tree = app.render(); assert.equal(control('Simetría nasal', 'select').props.value, -1);
  assert.equal(control('Intensidad de simetría', 'input').props.value, 0.7);
  find(tree, n => n.props?.id === 'editor-lipUpper')[0].props.onChange({ target: { value: '0.3' } });
  tree = app.render();
  find(tree, n => n.type === 'button' && text(n) === 'Restaurar nariz')[0].props.onClick();
  tree = app.render();
  assert.equal(control('Intensidad de simetría', 'input').props.value, 0);
  assert.equal(find(tree, n => n.props?.id === 'editor-lipUpper')[0].props.value, 0.3);
});

test('simetría nasal densa: copia el relieve del hemimallado origen XY estable y lado origen intacto', () => {
  const anchors = Float32Array.from(atlas.positions), frame = sim.personalFaceFrame({ positions: anchors });
  const canon = p => sim.toCanonicalPosition({ x: p[0], y: p[1], z: p[2] }, frame);
  const world = c => { const p = sim.fromCanonicalPosition(c, frame); return [p.x, p.y, p.z]; };
  const s = canon(at(anchors, 98).map((v, k) => v * 0.8 + at(anchors, 4)[k] * 0.2));
  const source = world(s), target = world({ x: -s.x, y: s.y, z: s.z + 0.03 });
  const dense = Float32Array.from([...anchors, ...source, ...target]);
  const result = sim.deformPositions(dense, anchors, { noseSymmetry: 1 });
  near(at(result, 468), source, 1e-4);
  const fixed = canon(at(result, 469));
  // El espejo de landmarks puede corregir levemente XY; la copia densa solo actúa en profundidad.
  assert.ok(Math.abs(fixed.x + s.x) < 0.01 && Math.abs(fixed.y - s.y) < 0.01, `XY ${fixed.x},${fixed.y} vs ${-s.x},${s.y}`);
  assert.ok(Math.abs(fixed.z - s.z) < 0.006, `profundidad copiada ${fixed.z} vs ${s.z} (defecto 0.03)`);
  assert.ok(result.every(Number.isFinite));
});