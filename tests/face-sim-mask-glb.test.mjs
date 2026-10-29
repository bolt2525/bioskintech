import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import * as backing from '../src/lab/faceSim/maskAnatomy.ts';

const require = createRequire(import.meta.url);
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const surface = { positions: Float32Array.from(atlas.positions), indices: Uint32Array.from(atlas.triangles),
  uvs: Float32Array.from({ length: atlas.positions.length / 3 * 2 }, () => 0.5) };
let scene;
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lab/faceSim/personalSurfaceGlb.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports, ArrayBuffer,
  require: name => name === 'three' ? THREE : name === './maskAnatomy' ? backing
    : name.includes('GLTFExporter') ? { GLTFExporter: class { async parseAsync(group) { scene = group; return new ArrayBuffer(8); } } } : require(name),
});

test('GLB de máscara: cara frontal, cierre mate sin mapa y buffers originales intactos', async () => {
  const positions = surface.positions.slice();
  await exports.personalSurfaceToGlb(surface, { width: 10, height: 10 });
  assert.equal(scene.getObjectByName('PERSONAL_FACE_SURFACE').material.side, THREE.FrontSide);
  const back = scene.getObjectByName('MASK_NEUTRAL_BACKING');
  assert.ok(back);
  assert.equal(back.material.map, null);
  assert.equal(back.material.roughness, 1);
  assert.equal(back.material.color.getHexString(), '475569');
  assert.deepEqual(surface.positions, positions);
});

test('GLB multivista conserva la mezcla alfa de parches, no solo el triángulo ganador', async () => {
  const patch = { source: { texture: { width: 10, height: 10 } }, indices: surface.indices.slice(0, 3),
    blendIndices: surface.indices.slice(0, 6), uvs: surface.uvs, alpha: Float32Array.from({ length: surface.positions.length / 3 }, () => 0.4) };
  await exports.personalSurfaceToGlb(surface, { width: 10, height: 10 }, undefined, [], [patch]);
  const mesh = scene.getObjectByName('PERSONAL_FACE_SURFACE_0');
  assert.equal(mesh.geometry.index.count, 6);
  assert.equal(mesh.geometry.getAttribute('color').itemSize, 4);
  assert.ok(Math.abs(mesh.geometry.getAttribute('color').getW(0) - 0.4) < 1e-6);
  assert.equal(mesh.material.transparent, true);
  assert.equal(mesh.material.depthWrite, false);
});

test('la cabeza experimental no recibe otro cierre de máscara', async () => {
  await exports.personalSurfaceToGlb({ ...surface, observedIndexCount: surface.indices.length }, { width: 10, height: 10 });
  assert.equal(scene.getObjectByName('MASK_NEUTRAL_BACKING'), undefined);
});
