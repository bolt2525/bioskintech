import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lab/faceSim/multiViewHead.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { buildPhotoSurfacePatches } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
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
test('textura multivista asigna una sola foto frontal a cada triángulo visible y no pinta la cara posterior', () => {
  const surface = { positions: Float32Array.from([-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3, 0]),
    indices: Uint32Array.from([0, 1, 2, 2, 1, 0]), uvs: new Float32Array(6) };
  const patches = buildPhotoSurfacePatches(surface, sources);
  assert.equal(patches.length, 1); assert.equal(patches[0].source.label, 'frontal');
  assert.deepEqual(Array.from(patches[0].indices), [0, 1, 2]);
  assert.deepEqual(Array.from(surface.positions), [-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3, 0].map(Math.fround));
});

test('mezcla multivista: la frontal domina en zonas oblicuas y en la cara solo matizan las laterales', () => {
  const surface = { positions: Float32Array.from([-0.1, -0.3, -0.1, 0.1, -0.3, 0.1, 0, 0.3, 0]),
    indices: Uint32Array.from([0, 1, 2]), uvs: new Float32Array(6) };
  const patches = buildPhotoSurfacePatches(surface, sources);
  const front = patches.find(p => p.source.label === 'frontal'), side = patches.find(p => p.source.label === 'A');
  assert.ok(front && side, 'ambas vistas aportan textura');
  assert.ok(Array.from(front.alpha).slice(0, 3).every(a => a === 1));
  assert.ok(Array.from(side.alpha).slice(0, 3).every(a => a > 0 && a < 0.5), 'la lateral solo matiza');
  const facial = buildPhotoSurfacePatches(surface, sources, 3);
  assert.ok(facial.every(p => p.source.label !== 'frontal' && p.indices.length === 0), 'la cara conserva su textura frontal como base');
  const facialSide = facial.find(p => p.source.label === 'A');
  if (facialSide) assert.ok(Array.from(facialSide.alpha).slice(0, 3).every((a, i) => a < side.alpha[i]), 'en la cara la lateral se atenúa');
  const frontalFace = { positions: Float32Array.from([-0.1, -0.1, 0, 0.1, -0.1, 0, 0, 0.1, 0]), indices: Uint32Array.from([0, 1, 2]), uvs: new Float32Array(6) };
  assert.equal(buildPhotoSurfacePatches(frontalFace, sources, 3).length, 0, 'zona frontal de la cara: sin mezcla lateral');
});
