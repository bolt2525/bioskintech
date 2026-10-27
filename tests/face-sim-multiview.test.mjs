import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lab/faceSim/multiViewHead.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { constrainHeadToPhotos, buildPhotoSurfacePatches } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function photo(label, u, v, towardCamera) {
  const width = 128, height = 128;
  const mask = Float32Array.from({ length: width * height }, (_, i) => {
    const x = (i % width + 0.5) / width, y = (Math.floor(i / width) + 0.5) / height;
    return ((x - 0.5) / 0.36) ** 2 + ((y - 0.5) / 0.45) ** 2 < 1 ? 1 : 0;
  });
  return { label, width, height, mask, texture: {}, projection: { u, v, towardCamera } };
}
const sources = [
  photo('frontal', [0.2, 0, 0, 0.5], [0, -0.2, 0, 0.5], [0, 0, 1]),
  photo('A', [0, 0, 0.2, 0.68], [0, -0.2, 0, 0.5], [-1, 0, 0]),
  photo('B', [0, 0, -0.2, 0.32], [0, -0.2, 0, 0.5], [1, 0, 0]),
];
function head() {
  const positions = new Float32Array((468 + 4) * 3);
  for (let id = 0; id < 468; id++) positions.set([Math.sin(id) * 0.7, Math.cos(id) * 1.5, 0.1], id * 3);
  positions.set([-2, 2.8, -3, 2, 2.8, -3, -1.5, -1.7, -3.2, 1.5, -1.7, -3.2], 468 * 3);
  return { positions, indices: Uint32Array.from([0, 1, 2, 468, 469, 470]), uvs: new Float32Array(472 * 2),
    projection: {}, observedIndexCount: 3, preservedOpenings: 0 };
}
test('siluetas bilaterales limitan bóveda/posterior sin alterar máscara facial, UV ni topología', () => {
  const input = head(), before = input.positions.slice(), result = constrainHeadToPhotos(input, sources);
  assert.deepEqual(input.positions, before);
  assert.deepEqual(result.positions.subarray(0, 468 * 3), before.subarray(0, 468 * 3));
  assert.equal(result.uvs, input.uvs); assert.equal(result.indices, input.indices);
  assert.ok(result.positions.every(Number.isFinite));
  assert.ok(Math.max(...result.positions.filter((_, i) => i % 3 === 1)) < 2.8);
  assert.ok(Math.min(...result.positions.filter((_, i) => i % 3 === 2)) > -3);
  const face = before.subarray(0, 468 * 3), extent = axis => {
    const values = face.filter((_, i) => i % 3 === axis); return [Math.min(...values), Math.max(...values)];
  };
  const [minY, maxY] = extent(1), height = maxY - minY;
  assert.ok(Math.min(...result.positions.filter((_, i) => i % 3 === 1)) >= minY - height * 0.035 - 1e-6,
    'el cuello segmentado no alarga la cabeza');
  const width = extent(0)[1] - extent(0)[0], [minZ, maxZ] = extent(2);
  const limit = Math.min(minZ - height * 0.04, maxZ - Math.max(width * 1.35, height * 1.15));
  assert.ok(Math.min(...result.positions.filter((_, i) => i % 3 === 2)) >= limit - 1e-6,
    'la profundidad facial no se suma de nuevo a un cráneo completo');
});
test('sin cobertura o máscara inválida no devuelve una cabeza con forma inventada', () => {
  assert.throws(() => constrainHeadToPhotos(head(), sources.slice(0, 2)), /frontal y dos/);
  assert.throws(() => constrainHeadToPhotos(head(), sources.map(s => ({ ...s, mask: s.mask.map(() => 0) }))), /no concuerdan/);
  assert.throws(() => constrainHeadToPhotos(head(), sources.map(s => ({ ...s, mask: new Float32Array(1) }))), /inválida/);
});
test('el ajuste conserva también los diez landmarks de iris sin tratarlos como cráneo', () => {
  const input = head(), positions = new Float32Array(input.positions.length + 30);
  positions.set(input.positions.subarray(0, 468 * 3));
  positions.set(new Float32Array(30).fill(0.13), 468 * 3);
  positions.set(input.positions.subarray(468 * 3), 478 * 3);
  const full = { ...input, positions, observedVertexCount: 478, uvs: new Float32Array(482 * 2),
    indices: input.indices.map(id => id >= 468 ? id + 10 : id) };
  const result = constrainHeadToPhotos(full, sources);
  assert.deepEqual(result.positions.subarray(0, 478 * 3), positions.subarray(0, 478 * 3));
});
test('textura multivista asigna una sola foto frontal a cada triángulo visible y no pinta la cara posterior', () => {
  const surface = { positions: Float32Array.from([-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3, 0]),
    indices: Uint32Array.from([0, 1, 2, 2, 1, 0]), uvs: new Float32Array(6) };
  const patches = buildPhotoSurfacePatches(surface, sources);
  assert.equal(patches.length, 1); assert.equal(patches[0].source.label, 'frontal');
  assert.deepEqual(Array.from(patches[0].indices), [0, 1, 2]);
  assert.deepEqual(Array.from(surface.positions), [-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3, 0].map(Math.fround));
});
