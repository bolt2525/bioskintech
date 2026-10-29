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

test('visibilidad: no proyecta piel de otra vista a través de una superficie oclusora', () => {
  const surface = {
    positions: Float32Array.from([-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3, 0,
      -0.3, -0.3, 0.2, 0.3, -0.3, 0.2, 0, 0.3, 0.2]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]), uvs: new Float32Array(12),
  };
  const patches = buildPhotoSurfacePatches(surface, [sources[0]]);
  assert.equal(patches.length, 1);
  assert.deepEqual(Array.from(patches[0].indices), [3, 4, 5]);
  assert.deepEqual(Array.from(patches[0].blendIndices), [3, 4, 5]);
  assert.deepEqual(Array.from(patches[0].alpha).slice(0, 3), [0, 0, 0]);
});

test('perfil: una superficie próxima oculta la mejilla lejana aunque ambas estén dentro de piel', () => {
  const surface = {
    positions: Float32Array.from([0, -0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3,
      -0.3, -0.3, -0.3, -0.3, 0.3, -0.3, -0.3, 0, 0.3]),
    indices: Uint32Array.from([0, 2, 1, 3, 5, 4]), uvs: new Float32Array(12),
  };
  const patches = buildPhotoSurfacePatches(surface, sources);
  const side = patches.find(p => p.source.label === 'A');
  assert.ok(side);
  assert.deepEqual(Array.from(side.indices), [3, 5, 4]);
  assert.deepEqual(Array.from(side.blendIndices), [3, 5, 4]);
  for (const id of [0, 1, 2]) assert.equal(side.alpha[id], 0);
});

test('rechaza triángulos con fondo en el centro aunque sus vértices tengan piel', () => {
  const surface = { positions: Float32Array.from([-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.6, 0]),
    indices: Uint32Array.from([0, 1, 2]), uvs: new Float32Array(6) };
  const source = { ...sources[0], mask: sources[0].mask.slice() };
  source.mask[64 * 128 + 64] = 0;
  assert.equal(buildPhotoSurfacePatches(surface, [source]).length, 0);
});

test('máscara abierta: laterales en sien/mejilla, sin fantasma ocular ni sustitución del centro', () => {
  const positions = new Float32Array(468 * 3);
  const put = (id, x, y, z = 0) => positions.set([x, y, z], id * 3);
  put(10, 0, 1); put(152, 0, -1); put(168, 0, 0.5);
  put(33, -0.4, 0.35); put(133, -0.2, 0.35);
  put(263, 0.4, 0.35); put(362, 0.2, 0.35);
  const triangle = (first, x, y) => {
    // Normal oblicua orientada a A, incluso en el centro: el gate anatómico debe protegerlo.
    put(first, x - 0.02, y - 0.02, 1.8 * (x - 0.02));
    put(first + 1, x + 0.02, y - 0.02, 1.8 * (x + 0.02));
    put(first + 2, x, y + 0.02, 1.8 * x);
    return [first, first + 1, first + 2];
  };
  const eye = triangle(400, -0.4, 0.35), temple = triangle(403, -0.7, 0.35);
  const cheek = triangle(406, -0.6, -0.25), center = triangle(409, 0, -0.15);
  const surface = { positions, indices: Uint32Array.from([...eye, ...temple, ...cheek, ...center]), uvs: new Float32Array(936) };
  const photos = sources.map(source => ({ ...source, mask: new Float32Array(128 * 128).fill(1) }));
  const patches = buildPhotoSurfacePatches(surface, photos, surface.indices.length);
  assert.ok(patches.length);
  const side = patches.find(p => p.source.label === 'A');
  assert.ok(side);
  for (const id of [...eye, ...center]) assert.equal(side.alpha[id], 0, `vértice protegido ${id}`);
  for (const id of [...temple, ...cheek]) assert.ok(side.alpha[id] > 0.65, `textura lateral útil ${id}: ${side.alpha[id]}`);
  assert.deepEqual(Array.from(side.blendIndices), [...temple, ...cheek]);
  assert.deepEqual(Array.from(side.indices), [...temple, ...cheek], 'exportación usa solo laterales dominantes');
  assert.ok(!patches.some(p => p.source.label === 'frontal'), 'la frontal es la base existente');
  assert.equal(surface.indices.length, 12, 'ningún cierre de cabeza ni abertura');
  assert.throws(() => buildPhotoSurfacePatches(surface, photos, 1), /triángulo/);
});
