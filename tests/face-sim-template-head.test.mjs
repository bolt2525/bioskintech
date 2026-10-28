import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { FaceLandmarker } from '@mediapipe/tasks-vision';

const compile = (path, replace = {}) => {
  let code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [from, to] of Object.entries(replace)) code = code.replaceAll(from, to);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
};
const headUrl = compile('../src/lab/faceSim/estimatedHead.ts');
const { buildTemplateHead } = await import(compile('../src/lab/faceSim/templateHead.ts', { "'./estimatedHead'": `'${headUrl}'` }));
const { buildPersonalSurface, trianglesFromEdges } = await import(compile('../src/lab/faceSim/engine.ts'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const data = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
const face = buildPersonalSurface(data.landmarks.map(([x, y, z]) => ({ x, y, z })), data.aspect, triangles, 1);
const template = { landmarks: atlas.positions, positions: atlas.surface.positions, triangles: atlas.surface.triangles };

function edgeUse(indices) {
  const use = new Map();
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = indices[i + j], b = indices[i + (j + 1) % 3], k = a < b ? `${a}:${b}` : `${b}:${a}`;
    use.set(k, (use.get(k) ?? 0) + 1);
  }
  return use;
}
const bounds = (p, from, to) => [0, 1, 2].map(a => {
  let lo = Infinity, hi = -Infinity;
  for (let i = from; i < to; i++) { lo = Math.min(lo, p[i * 3 + a]); hi = Math.max(hi, p[i * 3 + a]); }
  return [lo, hi];
});

test('plantilla ajustada: conserva la cara, cose el óvalo sin bordes libres y aporta cráneo con orejas', () => {
  assert.ok(face);
  const head = buildTemplateHead(face, template);
  const count = face.positions.length / 3;
  assert.deepEqual(Array.from(head.positions.subarray(0, count * 3)), Array.from(face.positions));
  assert.deepEqual(Array.from(head.indices.subarray(0, head.observedIndexCount)), Array.from(face.indices));
  const use = edgeUse(head.indices);
  assert.ok([...use.values()].every(n => n <= 2), 'sin aristas no manifold');
  const ovalFree = [...use.entries()].filter(([k, n]) => n === 1 && k.split(':').some(id => +id < count));
  // Solo quedan libres las aberturas de ojos/boca de la cara observada, nunca el óvalo.
  for (const [k] of ovalFree) assert.ok(k.split(':').every(id => +id < count), `costura abierta en ${k}`);
  const [fx, fy, fz] = bounds(head.positions, 0, 468), [hx, hy, hz] = bounds(head.positions, count, head.positions.length / 3);
  const faceH = fy[1] - fy[0];
  assert.ok(hz[0] < fz[0] - faceH * 0.5, 'la nuca queda detrás de la cara');
  assert.ok(hy[1] > fy[1], 'la bóveda sobrepasa la frente');
  assert.ok(hx[1] - hx[0] > (fx[1] - fx[0]) * 1.05, 'orejas/cráneo más anchos que el óvalo');
  assert.ok((hz[1] - hz[0]) < faceH * 2.2, 'sin cráneo inflado');
});

test('las siluetas ajustan el cráneo hacia la máscara observada', () => {
  const base = buildTemplateHead(face, template), count = face.positions.length / 3;
  const [, , bz] = bounds(base.positions, count, base.positions.length / 3);
  const [fx, fy, fz] = bounds(face.positions, 0, 468);
  // Cámara lateral ortográfica: u = −z (nuca a la derecha), v = −y.
  const width = 160, height = 160, back = bz[0] - (fz[1] - bz[0]) * 0.15;
  const scale = 0.6 / (fz[1] - back), cu = 0.2 + scale * fz[1], cv = 0.5 + scale * (fy[0] + fy[1]) / 2;
  const mask = Float32Array.from({ length: width * height }, (_, i) => {
    const u = (i % width + 0.5) / width, v = (Math.floor(i / width) + 0.5) / height;
    const z = -(u - cu) / scale, y = -(v - cv) / scale;
    return z < fz[1] && z > back && y < fy[1] + (fy[1] - fy[0]) * 0.3 && y > fy[0] - (fy[1] - fy[0]) * 0.3 ? 1 : 0;
  });
  const source = { label: 'lateral', width, height, mask, texture: {},
    projection: { u: [0, 0, -scale, cu], v: [0, -scale, 0, cv], towardCamera: [1, 0, 0] } };
  const fitted = buildTemplateHead(face, template, [source]);
  const occiput = h => { let z = Infinity; for (let i = count; i < h.positions.length / 3; i++) if (h.positions[i * 3 + 1] > (fy[0] + fy[1]) / 2) z = Math.min(z, h.positions[i * 3 + 2]); return z; };
  assert.ok(occiput(fitted) < occiput(base) - 0.02, 'el occipucio se desplaza hacia la silueta más profunda');
  assert.ok(fx[1] > fx[0]);
});
