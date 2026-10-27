import assert from 'node:assert/strict';
import test from 'node:test';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import { buildFaceRegionMap, buildFaceTriangleRegions } from '../src/lab/faceSim/faceRegions.ts';
import { buildRegionCells, regionCellAt, regionCellPositions, regionPlanePositions } from '../src/lab/faceSim/regionMesh.ts';
import { buildPhotoHairPatches } from '../src/lab/faceSim/estimatedHair.ts';
import { buildEstimatedHead } from '../src/lab/faceSim/estimatedHead.ts';
import { buildPersonalSurface, fitHairPhotoProjection } from '../src/lab/faceSim/engine.ts';

const map = buildFaceRegionMap(Array.from({ length: 468 }, (_, i) =>
  ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] })), atlas.triangles, 1, atlas.positions);
const labels = buildFaceTriangleRegions(map, atlas.positions), cells = buildRegionCells(map, labels);
const area = ([a, b, c]) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

test('subceldas conservan toda el área, sin salir del triángulo ni cambiar direcciones de registro', () => {
  const areas = new Array(labels.length).fill(0);
  for (const cell of cells) {
    for (const weights of cell.corners) {
      assert.equal(weights.reduce((a, b) => a + b), 1);
      assert.ok(weights.every(w => w >= 0 && w <= 1));
    }
    areas[cell.triangle] += area(cell.corners);
    const weights = [0, 1, 2].map(i => cell.corners.reduce((sum, p) => sum + p[i] / 3, 0));
    assert.equal(regionCellAt({ triangle: cell.triangle, weights }, cells), cell.label);
    const xyz = regionCellPositions(cell, atlas.triangles, atlas.positions);
    assert.equal(xyz.length, 9);
    assert.ok(xyz.every(Number.isFinite));
  }
  assert.ok(cells.length > labels.length * 2);
  assert.ok(areas.every(value => Math.abs(value - 0.5) < 1e-10), 'cobertura sin huecos ni solapamientos');
});

test('ojos/labios/nariz nunca salen de sus contornos topológicos al refinar', () => {
  const fixed = new Set(['Labio superior', 'Labio inferior', 'Comisuras', 'Dorso nasal', 'Contorno ocular (revisar)']);
  for (const cell of cells) {
    if (fixed.has(cell.label) || fixed.has(labels[cell.triangle])) assert.equal(cell.label, labels[cell.triangle]);
  }
  for (const ids of [[33, 246, 247], [263, 467, 466]]) {
    const triangle = labels.findIndex((_, i) => ids.every(id => atlas.triangles.slice(i * 3, i * 3 + 3).includes(id)));
    assert.ok(triangle >= 0);
    assert.equal(labels[triangle], 'Contorno ocular (revisar)');
  }
  assert.ok(cells.some(cell => cell.label === 'Frente'));
});

test('planos relativos desplazan geometría sin mutar el rostro ni inventar milímetros', () => {
  const original = [...atlas.positions], h = Math.abs(original[31] - original[457]);
  assert.deepEqual([...regionPlanePositions(original, atlas.triangles, 'superficial')], [...Float32Array.from(original)]);
  for (const [plane, factor] of [['middle', 0.012], ['deep', 0.027]]) {
    const shifted = regionPlanePositions(original, atlas.triangles, plane);
    let shiftedCount = 0;
    for (let id = 0; id < 468; id++) {
      const distance = Math.hypot(...[0, 1, 2].map(axis => shifted[id * 3 + axis] - original[id * 3 + axis]));
      assert.ok(distance <= h * factor + 1e-6);
      if (distance > 1e-6) { shiftedCount++; assert.ok(Math.abs(distance - h * factor) < 1e-6); }
    }
    assert.ok(shiftedCount > 450);
  }
  assert.deepEqual(atlas.positions, original);
});

test('cabello fotográfico utiliza la misma superficie, máscara y proyección sin inventar pelo posterior', () => {
  const landmarks = atlas.positions.reduce((all, _, i) => {
    if (i % 3 === 0) all.push({ x: (atlas.positions[i] + 2.5) / 5, y: (2.5 - atlas.positions[i + 1]) / 5, z: -atlas.positions[i + 2] / 5 });
    return all;
  }, []);
  const face = buildPersonalSurface(landmarks, 1, atlas.triangles), head = buildEstimatedHead(face);
  const before = head.positions.slice(), fit = fitHairPhotoProjection(face.positions, landmarks);
  assert.ok(fit && fit.error < 1e-6);
  assert.ok(fit.projection.towardCamera[2] > 0.99);
  const source = { label: 'Frontal sintética', width: 64, height: 64, mask: new Float32Array(64 * 64).fill(1), projection: fit.projection };
  const indices = head.indices.subarray(head.observedIndexCount);
  const patches = buildPhotoHairPatches(head.positions, indices, [source]);
  assert.equal(patches.length, 1);
  assert.ok(patches[0].indices.length > 0 && patches[0].indices.length < indices.length);
  assert.ok(patches[0].uvs.every(Number.isFinite));
  assert.deepEqual(head.positions, before, 'sin desplazamiento de geometría ni casquete externo');
  for (let i = 0; i < patches[0].indices.length; i += 3) {
    const ids = [...patches[0].indices.slice(i, i + 3)];
    const xyz = ids.map(id => [...head.positions.slice(id * 3, id * 3 + 3)]);
    const u = xyz[1].map((v, j) => v - xyz[0][j]), v = xyz[2].map((value, j) => value - xyz[0][j]);
    assert.ok(u[0] * v[1] - u[1] * v[0] > 0, 'la frontal nunca texturiza caras orientadas hacia atrás');
  }
  assert.deepEqual(buildPhotoHairPatches(head.positions, indices, [{ ...source, mask: source.mask.map(() => 0) }]), [], 'sin señal no se inventa cabello');
  assert.throws(() => buildPhotoHairPatches(head.positions, indices, [{ ...source, mask: new Float32Array(2) }]), /inválida/);
  assert.equal(fitHairPhotoProjection(new Float32Array(468 * 3), landmarks), null, 'proyección degenerada se rechaza');
  const profiles = [-0.8, 0.8].map(angle => ({
    ...source, label: `Perfil ${angle}`, projection: {
      u: [Math.cos(angle) * 0.1, 0, Math.sin(angle) * 0.1, 0.5], v: [0, -0.1, 0, 0.5],
      towardCamera: [-Math.sin(angle), 0, Math.cos(angle)],
    },
  }));
  assert.ok(buildPhotoHairPatches(head.positions, indices, [source, ...profiles]).length >= 2, 'perfiles aportan cobertura propia, no solo el color frontal');
});
