import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import ts from 'typescript';
import { createCanvas } from '@napi-rs/canvas';
import * as THREE from 'three';
import { BufferAttribute, BufferGeometry, Triangle, Vector3 } from 'three';
import { refineDisplaySurface } from '../src/lab/faceSim/displaySurface.ts';

// Solo atlas y patrones sintéticos; ninguna fotografía o dato clínico.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const atlas = JSON.parse(read('../src/lab/faceSim/genericFaceAtlas.json'));
const compile = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`;
const simulationURL = compile(read('../src/lab/faceSim/simulation.ts')
  .replace("import atlasData from './genericFaceAtlas.json' with { type: 'json' };", `const atlasData = ${JSON.stringify(atlas)};`));
const sim = await import(simulationURL);
const session = await import(compile(read('../src/lab/faceSim/morphologySession.ts')
  .replace("from './simulation'", `from '${simulationURL}'`)));
const anchors = Float32Array.from(atlas.positions);
const indices = Uint32Array.from(atlas.triangles);
const at = (p, id) => new Vector3(...p.slice(id * 3, id * 3 + 3));
const frame = sim.personalFaceFrame({ positions: anchors });
const canonical = (p, id) => sim.toCanonicalPosition(at(p, id), frame);

test('rendimiento nasal 1050×1400: helper UV y callback real con tres photoPatches', t => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => createCanvas(1, 1) };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const photo = createCanvas(1050, 1400), context2D = photo.getContext('2d');
  context2D.fillStyle = '#d9ac91'; context2D.fillRect(0, 0, 1050, 1400);
  context2D.fillStyle = '#513827'; context2D.fillRect(0, 0, 525, 1400);
  const uvs = Float32Array.from(Array.from({ length: 468 }, (_, i) =>
    [.5 + anchors[i * 3] * .30, .5 - anchors[i * 3 + 1] * .25]).flat());
  const parameters = { ...sim.NEUTRAL_SIMULATION, noseSymmetry: .7 };
  const textureParameters = { ...parameters, noseSymmetryTexture: 1 };
  const timings = [];
  let composed;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    composed = sim.composeNasalSymmetryTexture(photo, uvs, anchors, textureParameters);
    timings.push(performance.now() - start);
  }
  assert.equal(composed.width, 1050); assert.equal(composed.height, 1400);

  const refined = refineDisplaySurface(anchors, indices);
  const mesh = { positions: refined.positions, indices: refined.indices, anchors, uvs: refined.attribute(uvs, 2) };
  const makeMesh = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  };
  const overlays = Array.from({ length: 3 }, () => {
    const object = makeMesh();
    object.userData.originalIndices = object.geometry.index.array;
    object.userData.originalMap = new THREE.CanvasTexture(photo);
    object.userData.skinSource = photo;
    return object;
  });
  const skin = makeMesh(); skin.material = [skin.material];
  const photoGroup = new THREE.Group(); photoGroup.add(...overlays);
  const references = [], hair = { enabled: false }, skinRegions = [];
  let deformations = 0, filtered = 0, normals = 0;
  const originalNormals = skin.geometry.computeVertexNormals.bind(skin.geometry);
  skin.geometry.computeVertexNormals = () => { normals++; return originalNormals(); };
  const context = {
    disposed: false, failed: false, state: undefined, lastParameters: undefined, lastSkinRegions: undefined, referenceParameters: undefined,
    drawing: { current: undefined }, skinCancel() {}, photo,
    previousReferences: undefined, previousSignal: undefined, previousPhotoPatches: undefined, previousHair: hair, previousPatches: undefined,
    previousView: 'orbit', previousAnatomy: 'skin', pointerInside: false, selectedZone: null,
    morphologyPositions: mesh.positions, morphologyNormals: undefined, deformedPositions: mesh.positions, regionState: undefined, mesh,
    afterMeshes: new Map([['skin', skin]]), afterBacking: undefined, beforeMesh: undefined,
    referenceGroup: { children: [] }, photoGroup, beforePhotoGroup: { children: [] },
    hairGroup: { children: [] }, regionOverlay: {}, highlight: {}, regionMaterial: {}, highlightMaterial: {},
    signalTexture: undefined, texture: new THREE.CanvasTexture(photo),
    controls: { mouseButtons: {}, touches: {} }, bounds: {}, THREE, onProtection() {},
    deformPositions: (...args) => { deformations++; return sim.deformPositions(...args); },
    nasalTextureOverlayIndices: (...args) => { filtered++; return sim.nasalTextureOverlayIndices(...args); },
    revealStage: () => null, buildCutPlane: () => null, selectZone() {}, requestRender() {},
  };
  const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx').replace(/\r\n/g, '\n');
  const start = viewer.indexOf('    update(next) {') + '    update(next) {'.length;
  const body = viewer.slice(start, viewer.indexOf('\n    },\n  };\n}', start));
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(`function update(next) {${body}\n}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const state = {
    parameters, references, referenceLayers: {}, layers: { skin: { visible: true, opacity: 1 } },
    anatomy: 'skin', showMesh: false, hair, skinSource: photo, skinRegions, cut: { scope: 'none' },
    view: 'orbit', reveal: {},
  };
  context.update(state);
  const baselineDeformations = deformations, baselineNormals = normals;
  const weights = refined.attribute(sim.nasalTextureDestinationWeights(anchors, textureParameters), 1);
  const updateStart = performance.now();
  const textured = { ...state, parameters: textureParameters, skinTexture: composed, nasalTextureWeights: weights };
  context.update(textured);
  const updateMs = performance.now() - updateStart;
  const countsAfterToggle = { deformations: deformations - baselineDeformations, normals: normals - baselineNormals, filtered };
  const repeatedStart = performance.now();
  for (let frame = 0; frame < 60; frame++) context.update(textured);
  const repeatedMs = performance.now() - repeatedStart;
  t.diagnostic(`helper UV ms=${timings.map(n => n.toFixed(1))}; toggle viewport=${updateMs.toFixed(1)}ms; 60 callbacks=${repeatedMs.toFixed(1)}ms; al activar=${JSON.stringify(countsAfterToggle)}; filtros totales=${filtered}`);
  assert.deepEqual(countsAfterToggle, { deformations: 0, normals: 0, filtered: 3 }, 'activar textura no recalcula XYZ, protección ni normales');
  assert.equal(filtered, 3, 'cada overlay se filtra una sola vez, nunca por frame');
  // Presupuesto holgado para runners CPU compartidos; no es una garantía de FPS/WebGL.
  assert.ok(Math.max(...timings) < 2000, `helper frío/caliente debe quedar <2 s, no bloquear 120 s: ${timings}`);
  assert.ok(Math.min(...timings.slice(1)) < 750, `raster caliente <750 ms: ${timings}`);
  assert.ok(updateMs < 250, `callback con tres parches <250 ms: ${updateMs}`);
  assert.ok(repeatedMs < 250, `60 callbacks sin invalidación <250 ms total: ${repeatedMs}`);
  assert.equal(deformations, baselineDeformations);
  assert.equal(normals, baselineNormals);
  for (const object of [skin, ...overlays]) object.geometry.dispose();
  for (const object of overlays) object.userData.originalMap.dispose();
  context.texture.dispose(); context.signalTexture?.dispose();
});

test('planificación real: checkbox pinta antes del raster, entradas estables memoizan y descartar cancela', t => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => createCanvas(1, 1) };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx');
  const file = ts.createSourceFile('viewer.tsx', viewer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let requestExpression, effect;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'nasalTextureRequest') requestExpression = node.initializer.getText(file);
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
      && node.arguments[0]?.getText(file).includes('const canvas = composeNasalSymmetryTexture')) effect = node.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(requestExpression && effect, 'ejecuta memo y effect de producción, no réplica');
  const js = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let memo, previousDeps;
  const useMemo = (fn, deps) => {
    if (!previousDeps || deps.some((v, i) => v !== previousDeps[i])) { memo = fn(); previousDeps = deps; }
    return memo;
  };
  const photo = createCanvas(1050, 1400), context = photo.getContext('2d');
  context.fillStyle = '#d9ac91'; context.fillRect(0, 0, 1050, 1400);
  context.fillStyle = '#603522'; context.fillRect(0, 0, 525, 1400);
  const uvs = Float32Array.from(Array.from({ length: 468 }, (_, i) =>
    [.5 + anchors[i * 3] * .30, .5 - anchors[i * 3 + 1] * .25]).flat());
  const sourceMesh = { anchors };
  const makeRequest = (enabled = 1, strength = .7) => new Function('useMemo', 'photo', 'surface', 'prepared', 'noseSymmetry',
    'noseSymmetryRange', 'noseSymmetryMargin', 'noseSymmetryTexture', js(`return ${requestExpression};`))(
    useMemo, photo, { uvs }, { sourceMesh }, strength, .5, .5, enabled);
  const frames = new Map();
  let sequence = 0, calls = 0, published;
  const requestFrame = callback => { frames.set(++sequence, callback); return sequence; };
  const nextFrame = () => {
    const callbacks = Array.from(frames.values()); frames.clear();
    callbacks.forEach(callback => callback());
  };
  const run = request => new Function('nasalTextureRequest', 'requestAnimationFrame', 'cancelAnimationFrame',
    'setNasalTextureResult', 'composeNasalSymmetryTexture', js(`return ${effect};`))(
    request, requestFrame, id => frames.delete(id), result => { published = result; },
    (...args) => { calls++; return sim.composeNasalSymmetryTexture(...args); })();
  const request = makeRequest();
  const cleanup = run(request);
  assert.equal(calls, 0, 'click/render no rasteriza sincrónicamente');
  nextFrame();
  assert.equal(calls, 0, 'hay oportunidad de pintar checkbox y Preparando antes del cálculo');
  nextFrame();
  assert.equal(calls, 1);
  assert.equal(published.request, request);
  assert.equal(published.canvas.width, 1050); assert.equal(published.canvas.height, 1400);
  for (let frame = 0; frame < 60; frame++) assert.equal(makeRequest(), request, 'hover/cámara/props wrapper no invalidan UV ni textura');
  assert.equal(calls, 1);
  cleanup();
  const cancelled = makeRequest(1, .6), cancel = run(cancelled);
  nextFrame(); cancel(); nextFrame();
  assert.equal(calls, 1, 'descartar cancela el trabajo antes de empezar');
  assert.notEqual(published.request, cancelled, 'resultado obsoleto no se publica');
  run(makeRequest(0));
  assert.equal(published, undefined, 'off retira el resultado sin retener foto/textura');
  assert.match(viewer, /disabled=\{!proposed \|\| texturePending\}/, 'no confirmar antes de revisar textura preparada');
});

function asymmetric(source, sign = 1) {
  const out = source.slice();
  for (let i = 0; i < out.length / 3; i++) {
    const p = canonical(source, i);
    if (p.x * sign <= 0) continue;
    const w = Math.exp(-(((p.x * sign - .12) / .12) ** 2 + ((source[i * 3 + 1] - .40) / .22) ** 2));
    out[i * 3] += sign * .025 * w;
    out[i * 3 + 1] += .018 * w;
    out[i * 3 + 2] += .025 * w;
  }
  return out;
}

function orientedArea(before, after, triangles) {
  let minimum = Infinity;
  for (let k = 0; k < triangles.length; k += 3) {
    const ids = Array.from(triangles.slice(k, k + 3));
    const normal = p => at(p, ids[1]).sub(at(p, ids[0])).cross(at(p, ids[2]).sub(at(p, ids[0])));
    const a = normal(before), b = normal(after);
    if (a.lengthSq() > 1e-20) minimum = Math.min(minimum, a.dot(b) / a.lengthSq());
  }
  return minimum;
}

test('XYZ: ambas direcciones reducen error de reflejo, progresan y conservan origen/ojos/labios', t => {
  for (const sign of [-1, 1]) {
    const base = asymmetric(anchors, sign);
    const localFrame = sim.personalFaceFrame({ positions: base });
    const source = sign > 0 ? 3 : 248, target = sign > 0 ? 248 : 3;
    const q = sim.toCanonicalPosition(at(base, source), localFrame);
    const expected = new Vector3(...Object.values(sim.fromCanonicalPosition({ ...q, x: -q.x }, localFrame)));
    const before = at(base, target).distanceTo(expected);
    let protection;
    const residuals = [0, .25, .5, 1].map(strength => {
      const out = sim.deformPositions(base, base, { noseSymmetry: strength * sign }, indices, p => { protection = p; });
      assert.deepEqual(at(out, source), at(base, source), 'origen exacto');
      for (const id of [33, 263, 13, 14, 17, 61, 291, 10, 152]) assert.deepEqual(at(out, id), at(base, id), `protegido ${id}`);
      assert.ok(orientedArea(base, out, indices) >= .099);
      return at(out, target).distanceTo(expected) / before;
    });
    assert.ok(residuals[3] < .85, `residual XYZ al 100 %: ${residuals}`);
    if (residuals[3] > .45) assert.ok(protection.moderatedComponents > 0 && protection.minimumStrength < .6, 'la copia parcial debe advertir protección');
    const unprotected = sim.deformPositions(base, base, { noseSymmetry: sign });
    assert.ok(at(unprotected, target).distanceTo(expected) < 1e-6, 'sin limitación topológica, la correspondencia XYZ es exacta');
    for (let i = 1; i < residuals.length; i++) assert.ok(residuals[i] < residuals[i - 1]);
    const full = sim.deformPositions(base, base, { noseSymmetry: sign }, indices);
    for (const axis of ['x', 'y', 'z']) assert.notEqual(at(full, target)[axis], at(base, target)[axis], `reflejo real de ${axis}`);
    assert.deepEqual(sim.deformPositions(base, base, {}), base, 'reset exacto, sin acumular');
    t.diagnostic(`dirección ${sign}: residual XYZ 0/25/50/100 % = ${residuals.map(x => x.toFixed(3)).join('/')}`);
  }
});

test('detalle denso: error a superficie origen reflejada disminuye; no invierte triángulos', t => {
  const refined = refineDisplaySurface(anchors, indices);
  const base = asymmetric(refined.positions);
  const baseAnchors = base.slice(0, 468 * 3);
  const localFrame = sim.personalFaceFrame({ positions: baseAnchors });
  const triangles = [];
  for (let k = 0; k < refined.indices.length; k += 3) {
    const ids = Array.from(refined.indices.slice(k, k + 3));
    if (!ids.every(id => canonical(refined.positions, id).x < -.015 && Math.abs(refined.positions[id * 3]) < .4
      && refined.positions[id * 3 + 1] > .1 && refined.positions[id * 3 + 1] < .7)) continue;
    triangles.push(new Triangle(...ids.map(id => {
      const p = sim.toCanonicalPosition(at(base, id), localFrame);
      const q = sim.fromCanonicalPosition({ ...p, x: -p.x }, localFrame);
      return new Vector3(q.x, q.y, q.z);
    })));
  }
  const probes = [];
  for (let id = 468; id < base.length / 3; id += 7) {
    if (base[id * 3] > .05 && base[id * 3] < .22 && base[id * 3 + 1] > .30 && base[id * 3 + 1] < .58) probes.push(id);
  }
  assert.ok(probes.length >= 15 && triangles.length > 100);
  const error = positions => {
    const closest = new Vector3();
    return Math.sqrt(probes.reduce((sum, id) => {
      const p = at(positions, id);
      let minimum = Infinity;
      for (const triangle of triangles) minimum = Math.min(minimum, triangle.closestPointToPoint(p, closest).distanceToSquared(p));
      return sum + minimum;
    }, 0) / probes.length);
  };
  let protection;
  const out = sim.deformPositions(base, baseAnchors, { noseSymmetry: 1 }, refined.indices, p => { protection = p; });
  const before = error(base), after = error(out), area = orientedArea(base, out, refined.indices);
  assert.ok(after < before * .85, `RMS ${before}→${after}`);
  assert.ok(protection.moderatedComponents > 0, 'la fixture de superficie irregular requiere moderación, no prometer simetría exacta');
  assert.ok(area >= .099, `área orientada ${area}`);
  for (let id = 468; id < base.length / 3; id++) {
    if (sim.toCanonicalPosition(at(base, id), localFrame).x <= 0) assert.deepEqual(at(out, id), at(base, id), 'origen denso intacto');
  }
  t.diagnostic(`sondas=${probes.length}; RMS ${before.toFixed(5)}→${after.toFixed(5)}; área mínima=${area.toFixed(3)}; moderadas=${protection.moderatedComponents}`);
});

test('alcance/margen están acotados, son efectivos y no activan por sí solos geometría', () => {
  assert.equal(sim.sanitizeSimulation({ noseSymmetryRange: 9 }).noseSymmetryRange, 1);
  assert.equal(sim.sanitizeSimulation({ noseSymmetryMargin: -9 }).noseSymmetryMargin, 0);
  assert.equal(sim.sanitizeSimulation({ noseSymmetryTexture: 5 }).noseSymmetryTexture, 0);
  const base = asymmetric(anchors);
  assert.deepEqual(sim.deformPositions(base, base, { noseSymmetryRange: 1, noseSymmetryMargin: 0, noseSymmetryTexture: 1 }), base);
  const narrow = sim.deformPositions(base, base, { noseSymmetry: 1, noseSymmetryRange: 0 });
  const wide = sim.deformPositions(base, base, { noseSymmetry: 1, noseSymmetryRange: 1 });
  const feathered = sim.deformPositions(base, base, { noseSymmetry: 1, noseSymmetryMargin: 1 });
  assert.notDeepEqual(narrow, wide);
  assert.notDeepEqual(wide, feathered);
});

test('orden real: simetría primero, retoque después (no suma de dos correcciones de la base)', () => {
  const base = asymmetric(anchors);
  const symmetry = { noseSymmetry: .6, noseSymmetryRange: .8, noseSymmetryMargin: .3 };
  const mirroredBase = sim.deformPositions(base, base, symmetry);
  const sequential = sim.deformPositions(mirroredBase, mirroredBase, { noseTip: .2, noseWidth: -.15 });
  const combined = sim.deformPositions(base, base, { ...symmetry, noseTip: .2, noseWidth: -.15 });
  assert.deepEqual(combined, sequential);
});

test('historial real: textura, dirección, alcance/margen, variante y reset conservan undo/redo', () => {
  const reduce = session.morphologySessionReducer;
  let state = session.initialMorphologySession();
  assert.equal(state.present.parameters.noseSymmetryTexture, 0);
  state = reduce(state, { type: 'begin' });
  state = reduce(state, { type: 'change', parameters: { noseSymmetry: -.4, noseSymmetryTexture: 1,
    noseSymmetryRange: .8, noseSymmetryMargin: .2 }, symmetryDirection: -1 });
  state = reduce(state, { type: 'end' });
  const snapshot = state.present;
  state = reduce(state, { type: 'save', id: 'nasal', name: 'Nariz sintética' });
  state = reduce(state, { type: 'change', parameters: sim.NEUTRAL_SIMULATION });
  state = reduce(state, { type: 'apply', id: 'nasal' });
  assert.deepEqual(state.present.parameters, snapshot.parameters);
  assert.equal(state.present.symmetryDirection, -1);
  state = reduce(state, { type: 'undo' });
  assert.equal(state.present.parameters.noseSymmetryTexture, 0);
  state = reduce(state, { type: 'redo' });
  assert.deepEqual(state.present.parameters, snapshot.parameters);
  assert.equal(reduce(state, { type: 'restart' }).past.length, 0);
});

const uvs = Float32Array.from(Array.from({ length: 468 }, (_, i) =>
  [0.5 + anchors[i * 3] * .30, .5 - anchors[i * 3 + 1] * .25]).flat());
const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
function canvasFixture() {
  const canvas = createCanvas(512, 512), context = canvas.getContext('2d');
  const image = context.createImageData(512, 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    // Patrón asimétrico RGB con variación vertical: detecta UV equivocada/inversión V.
    image.data.set([x < 256 ? 35 + y % 25 : 210, Math.floor(y / 2), x % 45 + 40, 255], (y * 512 + x) * 4);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

test('canvas 2D real + UV: ambas direcciones, V correcto, intensidad, origen y exterior intactos', t => {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => { assert.equal(tag, 'canvas'); return createCanvas(1, 1); } };
  try {
    const source = canvasFixture(), original = pixels(source).slice();
    assert.equal(sim.composeNasalSymmetryTexture(source, uvs, anchors, { noseSymmetry: 1 }), source, 'off inicial');
    assert.equal(sim.composeNasalSymmetryTexture(source, uvs, anchors, { noseSymmetryTexture: 1 }), source, '0 intensidad');
    for (const sign of [-1, 1]) {
      const half = pixels(sim.composeNasalSymmetryTexture(source, uvs, anchors, { noseSymmetry: sign * .5, noseSymmetryTexture: 1 }));
      const full = pixels(sim.composeNasalSymmetryTexture(source, uvs, anchors, { noseSymmetry: sign, noseSymmetryTexture: 1 }));
      let changed = 0, maximum = 0;
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
        const k = (y * 512 + x) * 4;
        const difference = Math.abs(full[k] - original[k]);
        if (difference) {
          changed++; maximum = Math.max(maximum, difference);
          assert.ok(sign * (x - 256) > -2, `no debe escribir mitad origen: x=${x}`);
          assert.ok(x > 175 && x < 337 && y > 115 && y < 337, 'no refleja ojos/labios/exterior');
        }
        assert.ok(Math.abs((half[k] - original[k]) * 2 - (full[k] - original[k])) <= 2, 'intensidad lineal');
        assert.equal(full[k + 3], original[k + 3], 'alfa original');
      }
      const target = sign > 0 ? 248 : 3, sourceId = sign > 0 ? 3 : 248;
      const x = Math.floor(uvs[target * 2] * 512), y = Math.floor(uvs[target * 2 + 1] * 512);
      const expectedGreen = Math.floor(uvs[sourceId * 2 + 1] * 512 / 2);
      assert.ok(Math.abs(full[(y * 512 + x) * 4 + 1] - expectedGreen) < 3, 'UV V de origen, sin invertir verticalmente');
      assert.ok(changed > 300 && maximum > 80, `reflejo visible: ${changed} píxeles, Δ=${maximum}`);
      t.diagnostic(`dirección ${sign}: ${changed} píxeles cambiados; ΔR máx=${maximum}`);
    }
    assert.deepEqual(pixels(source), original, 'canvas original sin mutar');
    assert.throws(() => sim.composeNasalSymmetryTexture(source, [NaN], anchors, { noseSymmetry: 1, noseSymmetryTexture: 1 }), /UV/);
    assert.deepEqual(pixels(source), original);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('UI: simetría antes de retoques, opción separada off, advertencia visible y comparación original', () => {
  const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx');
  assert.ok(viewer.indexOf('<NasalSymmetryControls parameters=') < viewer.indexOf('{SIMULATION_CONTROLS.filter(control => control.group === group)'));
  assert.match(viewer, /type="checkbox" checked=\{parameters.noseSymmetryTexture === 1\}/);
  assert.match(viewer, /Las fosas son textura y relieve: no se reconstruye su interior/);
  assert.match(viewer, /onCompare=\{\(\) => setComparison\('split'\)\}/);
  assert.match(viewer, /const activeSkinTexture = tool === 'skin' \? skinTexture : nasalTextureWeights && nasalTexture\.canvas/);
  assert.match(viewer, /skinSource: tool === 'skin' \? skinPhoto : photo/);
  for (const name of ['Dirección de simetría nasal', 'Intensidad de forma nasal', 'Alcance nasal', 'Margen suave',
    'Reflejar también textura nasal', 'Confirmar simetría nasal', 'Descartar propuesta nasal']) assert.ok(viewer.includes(name), name);
  assert.match(viewer, /parameters: tool === 'skin' \? NEUTRAL_SIMULATION : previewParameters/);
  assert.match(viewer, /onConfirm=\{confirmNasalProposal\} onDiscard=\{discardNasalProposal\}/);
});

test('callbacks UI reales: propuesta revisable no escribe historial; descartar restaura; confirmar es un único undo/redo', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => createCanvas(1, 1) };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  await t.test('photoPatches: tres overlays por mitad descubren el destino UV; Antes y reset conservan índices', () => {
    const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx');
    const file = ts.createSourceFile('viewer.tsx', viewer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let block;
    const visit = node => {
      if (ts.isIfStatement(node) && node.expression.getText(file).startsWith('group === photoGroup && object.userData.nasalTextureWeights')) {
        block = node.getText(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(block, 'se ejecuta el bloque real de actualización de overlays');
    const compiled = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const after = {}, before = {};
    const update = (object, group, weights) => new Function('group', 'photoGroup', 'object', 'next', 'THREE', 'nasalTextureOverlayIndices', compiled)(
      group, after, object, { nasalTextureWeights: weights }, { BufferAttribute }, sim.nasalTextureOverlayIndices);
    const refined = refineDisplaySurface(anchors, indices);
    const topologyBefore = refined.indices.slice();
    for (const sign of [-1, 1]) {
      const weights = refined.attribute(sim.nasalTextureDestinationWeights(anchors, {
        noseSymmetry: sign, noseSymmetryTexture: 1,
      }), 1);
      const objects = Array.from({ length: 6 }, () => {
        const geometry = new BufferGeometry();
        geometry.setIndex(new BufferAttribute(refined.indices.slice(), 1));
        return { geometry, userData: { originalIndices: refined.indices.slice() } };
      });
      for (const [i, object] of objects.entries()) {
        update(object, i < 3 ? after : before, weights);
        if (i < 3) {
          assert.ok(object.geometry.index.count < refined.indices.length);
          for (const id of object.geometry.index.array) assert.equal(weights[id], 0, 'ningún overlay tapa píxeles de destino nasal');
          update(object, after, undefined);
          assert.deepEqual(object.geometry.index.array, refined.indices, 'descartar/desactivar restaura los tres overlays');
        } else assert.deepEqual(object.geometry.index.array, refined.indices, 'los tres meshes de Antes permanecen intactos');
        object.geometry.dispose();
      }
      assert.deepEqual(refined.indices, topologyBefore, 'no mutación de topología');
    }
  });
  const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx');
  const file = ts.createSourceFile('viewer.tsx', viewer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = {};
  const names = ['proposeNasalChanges', 'confirmNasalProposal', 'discardNasalProposal', 'activeNasalProposal'];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(file))) callbacks[node.name.getText(file)] = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(Object.keys(callbacks).length, names.length);
  const javascript = expression => ts.transpileModule(`const callback = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const reduce = session.morphologySessionReducer;
  let state = session.initialMorphologySession(), proposal = null, comparison = 'after';
  const source = canvasFixture(), originalPhoto = pixels(source).slice();
  const originalGeometry = anchors.slice(), surface = { positions: anchors, uvs };
  const active = () => new Function('nasalProposal', 'parameters', 'symmetryDirection', 'surface', 'photo',
    `${javascript(callbacks.activeNasalProposal)}; return callback;`)(proposal, state.present.parameters, state.present.symmetryDirection, surface, source);
  const dispatch = action => { state = reduce(state, action); };
  const run = (name, ...args) => new Function('activeNasalProposal', 'previewParameters', 'parameters', 'symmetryDirection',
    'surface', 'photo', 'sanitizeSimulation', 'setComparison', 'setNasalProposal', 'dispatchMorphology', 'changeMorphology',
    `${javascript(callbacks[name])}; return callback;`)(active(), active()?.parameters ?? state.present.parameters,
    state.present.parameters, state.present.symmetryDirection, surface, source, sim.sanitizeSimulation,
    value => { comparison = value; }, value => { proposal = value; }, dispatch,
    (parameters, symmetryDirection) => dispatch({ type: 'change', parameters, symmetryDirection }))(...args);
  for (let frame = 1; frame <= 20; frame++) run('proposeNasalChanges', {
    noseSymmetry: -.8 * frame / 20, noseSymmetryTexture: 1, noseSymmetryRange: .7, noseSymmetryMargin: .3,
  }, -1);
  assert.equal(state.past.length, 0, '20 revisiones, ningún cambio confirmado');
  assert.equal(state.present.parameters.noseSymmetry, 0);
  assert.equal(comparison, 'split', 'propuesta comparada con el original');
  assert.equal(active().parameters.noseSymmetry, -.8);
  assert.notDeepEqual(sim.deformPositions(anchors, anchors, active().parameters), originalGeometry, 'preview geométrica real');
  assert.notDeepEqual(pixels(sim.composeNasalSymmetryTexture(source, uvs, anchors, active().parameters)), originalPhoto, 'preview canvas real');
  assert.deepEqual(pixels(source), originalPhoto);
  assert.deepEqual(anchors, originalGeometry, 'Antes no se modifica durante preview');
  run('discardNasalProposal');
  assert.equal(proposal, null);
  assert.equal(state.past.length, 0);
  assert.deepEqual(sim.deformPositions(anchors, anchors, state.present.parameters), originalGeometry);
  run('proposeNasalChanges', { noseSymmetry: .7, noseSymmetryTexture: 1 }, 1);
  const preview = active().parameters;
  run('confirmNasalProposal');
  assert.equal(proposal, null);
  assert.equal(state.past.length, 1, 'confirmación atómica');
  assert.deepEqual(state.present.parameters, preview);
  dispatch({ type: 'undo' });
  assert.equal(state.present.parameters.noseSymmetry, 0);
  assert.equal(state.present.parameters.noseSymmetryTexture, 0);
  dispatch({ type: 'redo' });
  assert.deepEqual(state.present.parameters, preview);
  run('proposeNasalChanges', { noseSymmetry: .2 });
  dispatch({ type: 'undo' });
  assert.equal(active(), null, 'una propuesta obsoleta no sobrevive al historial');
  assert.deepEqual(pixels(source), originalPhoto, 'Antes sigue inmutable tras confirmar/undo/redo');
});

test('textura nasal en superficie personal densa (~7000 v?rtices + refinado real): pesos por v?rtice, sin error ni desmontaje', () => {
  // Regresi?n QA real: 468 pesos frente a una superficie densa lanzaban
  // ?Atributo incompatible con el mallado original.? durante render.
  const coarse = refineDisplaySurface(Float32Array.from(atlas.surface.positions), Uint32Array.from(atlas.surface.triangles));
  const surface = { positions: coarse.positions, indices: coarse.indices,
    uvs: new Float32Array(coarse.positions.length / 3 * 2),
    projection: { cx: .5, cy: .5, k: 1, aspect: 1 } };
  for (let i = 0; i < surface.uvs.length / 2; i++) {
    surface.uvs[i * 2] = .5 + surface.positions[i * 3] * .30; surface.uvs[i * 2 + 1] = .5 - surface.positions[i * 3 + 1] * .25;
  }
  const vertexCount = surface.positions.length / 3;
  assert.ok(vertexCount >= 7000, `superficie personal densa realista (${vertexCount})`);
  // Mismo pipeline que el visor: createSimulationMesh ? refineDisplaySurface.
  const sourceMesh = sim.createSimulationMesh(surface);
  const refinement = refineDisplaySurface(sourceMesh.positions, sourceMesh.indices);
  assert.throws(() => refinement.attribute(sim.nasalTextureDestinationWeights(sourceMesh.anchors, { noseSymmetry: 1, noseSymmetryTexture: 1 }), 1),
    /Atributo incompatible/, 'reproduce la causa: 468 pesos no bastan');

  // Ejecuta el useMemo REAL del visor (extra?do del TSX).
  const viewer = read('../src/lab/faceSim/FacialSimulationViewer.tsx');
  const file = ts.createSourceFile('viewer.tsx', viewer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'nasalTextureOverlay') body = node.initializer.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(body, 'se ejecuta el c?lculo real de pesos del visor');
  const compiled = ts.transpileModule(`(${body})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const errors = [];
  const run = (prepared, signed, texture = 1) => new Function('nasalTexture', 'prepared', 'nasalTextureDestinationWeights', 'console',
    'noseSymmetry', 'noseSymmetryRange', 'noseSymmetryMargin', 'noseSymmetryTexture', `return ${compiled}`)(
    { canvas: {} }, prepared, sim.nasalTextureDestinationWeights, { error: (...args) => errors.push(args) },
    signed, .5, .5, texture)();
  const prepared = { sourceMesh, refinement };
  const t0 = performance.now();
  for (const sign of [-1, 1]) {
    const result = run(prepared, sign);
    assert.equal(result.error, undefined); assert.equal(errors.length, 0);
    assert.equal(result.weights.length, refinement.positions.length / 3, 'un peso por v?rtice refinado');
    let denseDestination = 0;
    for (let i = 468; i < vertexCount; i++) {
      const w = result.weights[i];
      assert.ok(w >= 0 && w <= 1 && Number.isFinite(w));
      const x = sim.toCanonicalPosition(at(sourceMesh.positions, i), sim.personalFaceFrame({ positions: sourceMesh.anchors })).x;
      if (w > 0) { denseDestination++; assert.ok(x * sign > 0, 'peso solo en destino, nunca en origen'); }
    }
    assert.ok(denseDestination > 20, `v?rtices densos de destino con peso (${denseDestination})`);
    // Overlays laterales reales (3 por mitad) retiran tri?ngulos densos del destino.
    const retained = sim.nasalTextureOverlayIndices(refinement.indices, result.weights);
    assert.ok(retained.length < refinement.indices.length);
    for (const id of retained) assert.equal(result.weights[id], 0);
  }
  assert.ok(performance.now() - t0 < 4000, 'c?lculo de pesos acotado');
  assert.equal(run(prepared, 1, 0).weights.every(w => w === 0), true, 'textura desactivada: sin pesos');
  // Un fallo nunca desmonta el editor: alerta en espa?ol y foto original.
  const broken = run({ sourceMesh, refinement: { attribute: () => { throw new Error('Atributo incompatible con el mallado original.'); } } }, 1);
  assert.equal(broken.weights, undefined); assert.match(broken.error, /No se pudo preparar la textura nasal/);
  assert.match(viewer, /tool === 'skin' \? skinTexture : nasalTextureWeights && nasalTexture\.canvas/);
});
