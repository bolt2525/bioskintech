import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { refineDisplaySurface } from '../src/lab/faceSim/displaySurface.ts';

const source = readFileSync(new URL('../src/lab/faceSim/FacialSimulationViewer.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compile = text => ts.transpileModule(text, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const updateStart = source.indexOf('    update(next) {') + '    update(next) {'.length;
const updateBody = source.slice(updateStart, source.indexOf('\n    },\n  };\n}', updateStart));

test('runtime: slider reutiliza buffers, deforma una sola vez y omite capas/zonas ocultas', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const attribute = { array: positions.slice(), needsUpdate: false };
  let normals = 0, deformations = 0, renders = 0;
  const geometry = { getAttribute: () => attribute, computeVertexNormals: () => normals++, computeBoundingSphere() {} };
  const material = { transparent: false };
  const skin = { geometry, material: [material] };
  const hair = { enabled: false };
  const references = [];
  const fail = () => { throw new Error('No debe reconstruir geometría oculta'); };
  const context = {
    disposed: false, failed: false, state: undefined, lastParameters: undefined, lastSkinRegions: undefined, referenceParameters: undefined,
    previousReferences: undefined, previousSignal: undefined, previousPhotoPatches: undefined, previousHair: hair, previousPatches: undefined,
    previousView: 'orbit', previousAnatomy: 'skin', pointerInside: false, selectedZone: null,
    morphologyPositions: positions, morphologyNormals: undefined,
    deformedPositions: positions, regionState: undefined, mesh: { positions, indices: new Uint32Array([0, 1, 2]), anchors: positions },
    afterMeshes: new Map([['skin', skin]]), afterBacking: undefined, beforeMesh: undefined,
    referenceGroup: { children: [] }, photoGroup: { children: [] }, beforePhotoGroup: { children: [] },
    hairGroup: { children: [] }, regionOverlay: {}, highlight: {}, regionMaterial: {}, highlightMaterial: {},
    signalTexture: undefined, texture: undefined,
    controls: { enableRotate: false, mouseButtons: {}, touches: {} }, bounds: {}, THREE: {
      Mesh: class {}, MOUSE: { PAN: 2, ROTATE: 0 }, TOUCH: { PAN: 1, ROTATE: 0, DOLLY_PAN: 2 },
    },
    deformPositions: (original, _anchors, parameters) => { deformations++; return Float32Array.from(original, v => v + parameters.noseTip); },
    revealStage: () => null, buildCutPlane: () => null, selectZone() {},
    getAnatomyCells: fail, buildReferenceGeometry: fail, buildSimulationLayers: fail,
    regionCellPositions: fail, requestRender: () => renders++,
  };
  vm.createContext(context);
  vm.runInContext(compile(`function update(next) {${updateBody}\n}`), context);
  const state = {
    parameters: { noseTip: 0.1 }, references, referenceLayers: { muscle: { visible: false, opacity: 1 } },
    layers: { skin: { visible: true, opacity: 1 } }, anatomy: 'skin', showMesh: false,
    hair, skinRegions: [], plane: 'superficial', cut: { scope: 'none' }, view: 'orbit', reveal: {},
  };
  context.update(state);
  assert.equal(deformations, 1);
  assert.equal(normals, 1);
  assert.equal(skin.geometry, geometry);
  assert.equal(geometry.getAttribute('position'), attribute);
  assert.ok(Math.abs(attribute.array[0] - 0.1) < 1e-6);
  context.update({ ...state, cut: { scope: 'skin', position: 0.4 } });
  assert.equal(deformations, 1, 'corte no recalcula morfología');
  context.update({ ...state, parameters: { noseTip: 0.7 } });
  assert.equal(deformations, 2);
  assert.equal(normals, 2);
  assert.equal(geometry.getAttribute('position'), attribute);
  assert.ok(Math.abs(attribute.array[0] - 0.7) < 1e-6, 'evalúa desde el original, sin acumular');
  assert.equal(renders, 3);
  assert.equal(context.controls.enableRotate, true);
  context.update({ ...state, parameters: context.lastParameters, navigation: 'pan' });
  assert.equal(context.controls.mouseButtons.LEFT, 2);
  assert.equal(context.controls.touches.ONE, 1);
  assert.equal(deformations, 2, 'navegar no vuelve a calcular la geometría');
  context.THREE.CanvasTexture = class { constructor(image) { this.image = image; } dispose() {} };
  const withTexture = { ...state, parameters: context.lastParameters, skinTexture: { width: 10 } };
  context.update(withTexture);
  const map = material.map;
  material.needsUpdate = false;
  context.update({ ...withTexture, skinTexture: { width: 10 } });
  assert.equal(material.map, map, 'el retoque reutiliza la textura GPU');
  assert.equal(material.needsUpdate, false, 'no recompila por cambiar los píxeles');
  assert.equal(deformations, 2, 'el retoque RGB no recalcula morfología');
  context.mesh.uvs = new Float32Array(6);
  context.vertexNormals = () => positions.slice();
  context.applySkinRegionRelief = base => Float32Array.from(base, value => value + 0.02);
  context.update({ ...withTexture, skinRegions: [{ verified: true, adjustments: { relief: 0.5 } }] });
  assert.ok(Math.abs(attribute.array[0] - 0.72) < 1e-6);
  context.update({ ...withTexture, skinRegions: [] });
  assert.ok(Math.abs(attribute.array[0] - 0.7) < 1e-6, 'antes/restablecer retira relieve sin perder morfología');
  assert.equal(deformations, 2);
  const backingAttribute = { array: positions.slice(), needsUpdate: false };
  const backingGeometry = { userData: { originalPositions: positions.slice() },
    getAttribute: () => backingAttribute, computeVertexNormals() {}, computeBoundingSphere() {},
    dispose() { throw new Error('El slider no debe reconstruir el reverso'); } };
  context.afterBacking = { geometry: backingGeometry };
  context.backingThickness = 0.11;
  context.update({ ...withTexture, parameters: { noseTip: 0.8 }, skinRegions: [] });
  assert.equal(context.afterBacking.geometry, backingGeometry);
  assert.ok(Math.abs(backingAttribute.array[0] - 0.8) < 1e-6);
  assert.deepEqual(Array.from(backingGeometry.userData.originalPositions), Array.from(positions));
});

test('carga: listo solo después de dibujar; un error no anuncia éxito', () => {
  const start = source.indexOf('  const render = (time = performance.now()) => {') + '  const render = (time = performance.now()) => {'.length;
  const body = source.slice(start, source.indexOf('\n  const requestRender =', start)).replace(/\n  };$/, '');
  const make = broken => {
    let ready = 0, draws = 0;
    const context = {
      frame: 1, disposed: false, failed: false, state: { comparison: 'after' }, announcedReady: false,
      performance, canvas: { dataset: {} }, renderer: { setScissorTest() {} }, viewportWidth: 100,
      before: {}, after: {}, applyAnatomy: () => false, requestRender() {}, console: { error() {} },
      drawView() { if (broken) throw new Error('WebGL'); draws++; },
      onReady() { assert.ok(draws > 0); ready++; }, onError() {},
    };
    vm.createContext(context);
    vm.runInContext(`function render(time) {${body}\n}`, context);
    context.render(0); context.render(16);
    return { context, ready, draws };
  };
  assert.equal(make(false).ready, 1);
  const failure = make(true);
  assert.equal(failure.ready, 0);
  assert.equal(failure.context.failed, true);
  assert.equal(failure.context.canvas.dataset.ready, undefined);
});

test('simetría densa: poda espacial conserva exactamente el resultado y reduce búsquedas', () => {
  const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
  const simulation = readFileSync(new URL('../src/lab/faceSim/simulation.ts', import.meta.url), 'utf8');
  const unbounded = simulation.replace(/else if \(p\.x >= nasalSupport\.left[\s\S]*?p\.z <= nasalSupport\.front\) \{/, 'else {');
  assert.notEqual(unbounded, simulation);
  const load = text => {
    let calls = 0;
    const math = Object.create(Math);
    math.hypot = (...values) => { calls++; return Math.hypot(...values); };
    const context = { exports: {}, require: () => ({ default: atlas }), Math: math };
    vm.runInNewContext(compile(text), context);
    calls = 0;
    return { api: context.exports, calls: () => calls };
  };
  const fast = load(simulation), full = load(unbounded);
  const dense = refineDisplaySurface(Float32Array.from(atlas.positions), Uint32Array.from(atlas.triangles));
  for (const parameters of [{ noseSymmetry: 1 }, { noseSymmetry: -0.5, noseTip: 0.7, chinProjection: 0.4 }]) {
    assert.deepEqual(Array.from(fast.api.deformPositions(dense.positions, atlas.positions, parameters)),
      Array.from(full.api.deformPositions(dense.positions, atlas.positions, parameters)));
  }
  assert.ok(fast.calls() < full.calls() * 0.6, `${fast.calls()} frente a ${full.calls()} búsquedas`);
});
