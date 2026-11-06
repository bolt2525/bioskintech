import assert from 'node:assert/strict';
import test from 'node:test';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import {
  assertSessionAtlas, base64ToBuffer, bufferToBase64, restoreSurface, storeSurface,
} from '../src/lab/faceSim/facialSimulationSession.ts';

const surface = () => ({
  positions: Float32Array.from(atlas.positions),
  indices: Uint32Array.from(atlas.triangles),
  uvs: Float32Array.from(atlas.positions.flatMap((_, i) => i % 3 ? [] : [.5, .5])),
  projection: { cx: .5, cy: .5, k: .2, aspect: .75 },
});

test('superficie editable: JSON roundtrip conserva exactamente buffers y proyección', t => {
  const original = surface(), started = performance.now();
  const json = JSON.stringify(storeSurface(original));
  const restored = restoreSurface(JSON.parse(json));
  assert.deepEqual(restored, original);
  assert.notEqual(restored.positions, original.positions);
  t.diagnostic(JSON.stringify({ fixture: 'atlas468', jsonBytes: Buffer.byteLength(json),
    roundtripMs: performance.now() - started, maxPositionError: 0 }));
});

test('cabeza estimada: mantiene cobertura observada y colores, no inventa nueva geometría', () => {
  const original = { ...surface(), observedIndexCount: 6, observedVertexCount: 468,
    preservedOpenings: 2, inferredColor: '#112233', inferredSkinColor: '#665544' };
  assert.deepEqual(restoreSurface(JSON.parse(JSON.stringify(storeSurface(original)))), original);
});

test('buffers GLB se conservan byte a byte; truncados/versiones ajenas se rechazan', () => {
  const glb = new ArrayBuffer(16), view = new DataView(glb);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, 16, true);
  assert.deepEqual(base64ToBuffer(bufferToBase64(glb)), glb);
  view.setUint32(8, 15, true);
  assert.throws(() => base64ToBuffer(bufferToBase64(glb)), /incompleto/);
  assert.throws(() => base64ToBuffer('data:model/gltf-binary;base64,abc'), /válido/);
});

test('un atlas diferente o slots duplicados nunca desplazan lesiones silenciosamente', () => {
  const state = { version: 1, atlas: { modelId: atlas.modelId, version: 1, glbSha256: atlas.provenance.glbSha256 }, photos: [], marks: [] };
  assert.doesNotThrow(() => assertSessionAtlas(state));
  assert.throws(() => assertSessionAtlas({ ...state, atlas: { modelId: 'other', version: 1 } }), /atlas/);
  assert.throws(() => assertSessionAtlas({ ...state, atlas: { ...state.atlas, glbSha256: 'changed' } }), /atlas/);
  assert.throws(() => assertSessionAtlas({ ...state, photos: [{ slot: 'frontal' }, { slot: 'frontal' }] }), /atlas/);
});

test('malla corrupta o no finita no se carga como éxito', () => {
  const stored = storeSurface(surface());
  for (const patch of [
    { positions: [NaN, 0, 0] }, { indices: [-1, 0, 1] }, { uvs: [0] },
    { projection: { ...stored.projection, k: 0 } }, { observedIndexCount: 999999, preservedOpenings: 0 },
  ]) assert.throws(() => restoreSurface({ ...stored, ...patch }));
});
