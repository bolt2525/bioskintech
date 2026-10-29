import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve('src/lab/faceSim'), cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
  const exports = {}; cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports, console, Float32Array, Uint32Array, Uint8Array, Uint8ClampedArray,
    require(name) {
      if (!name.startsWith('.')) return require(name);
      const base = path.resolve(path.dirname(file), name);
      const target = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p));
      if (!target) throw new Error(`Missing ${base}`);
      return load(target);
    },
  }, { filename: file });
  return exports;
}
const atlas = load(path.join(root, 'genericFaceAtlas.json'));
const { annotationUVs, buildAnnotationLayerView, bindingsOnLayer } = load(path.join(root, 'annotationLayerView.ts'));
const { ANATOMICAL_ZONES } = load(path.join(root, 'anatomicalZones.ts'));
const { personalFaceFrame, toCanonicalPosition, fromCanonicalPosition } = load(path.join(root, 'simulation.ts'));
const { buildReferenceGeometry } = load(path.join(root, 'referenceGeometry.ts'));
const uv = annotationUVs(atlas);
function canvas(alpha = 255) {
  const data = new Uint8ClampedArray(128 * 128 * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = alpha;
  return { width: 128, height: 128, getContext: () => ({ getImageData: () => ({ width: 128, height: 128, data }) }) };
}
const reference = (kind = 'muscle', alpha = 255) => ({
  kind, canvas: canvas(alpha), uvs: uv, depth: 0.02, opacity: 1, zones: ANATOMICAL_ZONES[kind],
});
const address = { triangle: 0, weights: [0.2, 0.3, 0.5] };

test('capas: geometría y puntos visuales no modifican buffers ni bindings canónicos', () => {
  const source = structuredClone(atlas.positions);
  const bindings = { mark: { kind: 'point', paths: [[address]] } }, before = structuredClone(bindings);
  const layer = buildAnnotationLayerView(reference(), atlas);
  const result = bindingsOnLayer(bindings, layer);
  assert.equal(result.mark, bindings.mark);
  assert.deepEqual(bindings, before); assert.deepEqual(atlas.positions, source);
  assert.equal(layer.accepts(address), true);
  assert.ok(Object.values(layer.point(address)).every(Number.isFinite));
  assert.equal(bindingsOnLayer(bindings), bindings);
});

test('capas: transparencia y hueco óseo rechazan marca aunque haya piel debajo', () => {
  const transparent = buildAnnotationLayerView(reference('vessels', 0), atlas);
  assert.equal(transparent.accepts(address), false);
  assert.equal(Object.keys(bindingsOnLayer({ mark: { kind: 'point', paths: [[address]] } }, transparent)).length, 0);
  const bone = buildAnnotationLayerView(reference('bone'), atlas);
  const keys = new Set();
  for (let i = 0; i < bone.indices.length; i += 3) keys.add(Array.from(bone.indices.slice(i, i + 3)).sort((a, b) => a - b).join(':'));
  let rejected = 0;
  for (let triangle = 0; triangle < atlas.triangles.length / 3; triangle++) {
    const key = atlas.triangles.slice(triangle * 3, triangle * 3 + 3).sort((a, b) => a - b).join(':');
    if (!keys.has(key)) {
      assert.equal(bone.accepts({ triangle, weights: [1 / 3, 1 / 3, 1 / 3] }), false);
      rejected++;
    }
  }
  assert.ok(rejected > 0, 'la ilustración ósea mantiene su apertura, no se marca anatomía inexistente');
});

test('capas: perfil personal vuelve al chart original del Clinical3DViewer, no queda en +Z canónico', () => {
  const angle = 0.8, positions = Float32Array.from(atlas.positions);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], z = positions[i + 2];
    positions[i] = x * Math.cos(angle) + z * Math.sin(angle) + 0.7;
    positions[i + 1] += 0.2; positions[i + 2] = -x * Math.sin(angle) + z * Math.cos(angle) - 0.4;
  }
  const surface = { positions, indices: Uint32Array.from(atlas.triangles), uvs: uv, projection: { cx: 0.5, cy: 0.5, k: 1, aspect: 1 } };
  const before = positions.slice(), ref = reference(), frame = personalFaceFrame(surface), canonical = positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    const p = toCanonicalPosition({ x: positions[i], y: positions[i + 1], z: positions[i + 2] }, frame);
    canonical.set([p.x, p.y, p.z], i);
  }
  const expected = buildReferenceGeometry(canonical, surface.indices, ref), layer = buildAnnotationLayerView(ref, atlas, surface);
  for (let i = 0; i < positions.length; i += 3) {
    const p = fromCanonicalPosition({ x: expected.positions[i], y: expected.positions[i + 1], z: expected.positions[i + 2] }, frame);
    assert.ok(Math.hypot(layer.positions[i] - p.x, layer.positions[i + 1] - p.y, layer.positions[i + 2] - p.z) < 1e-6);
  }
  assert.deepEqual(positions, before);
});
