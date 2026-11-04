import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import { buildFaceRegionMap, buildFaceTriangleRegions } from '../src/lab/faceSim/faceRegions.ts';
import { buildRegionCells, regionCellPositions, regionPlanePositions } from '../src/lab/faceSim/regionMesh.ts';

// Superficie sintética elevada: las cuerdas del atlas quedan DENTRO de la piel.
// Cada cara tiene un plano diferente; levantar solo sus vértices sparse no basta.
const sparse = Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
const triangles = [0, 1, 2, 0, 2, 3];
const surface = {
  positions: Float32Array.of(...sparse, 0.5, 0.5, 0.2),
  triangles: Uint32Array.of(0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4),
};
const cell = triangle => ({ triangle, corners: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], label: 'Mejilla sintética' });
const mesh = (positions, indices) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (indices) geometry.setIndex([...indices]);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
};
const ray = (x, y, z = 2, direction = -1) => new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(0, 0, direction));
const area = positions => {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 9) {
    sum += ((positions[i + 3] - positions[i]) * (positions[i + 7] - positions[i + 1])
      - (positions[i + 4] - positions[i + 1]) * (positions[i + 6] - positions[i])) / 2;
  }
  return sum;
};
const dispose = object => { object.geometry.dispose(); object.material.dispose(); };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test('reproduce cuerda oculta y recorta el hover sobre TODAS las caras de la piel real', () => {
  const before = [...surface.positions];
  const old = mesh([0, 1].flatMap(i => regionCellPositions(cell(i), triangles, sparse)));
  const actual = mesh(surface.positions, surface.triangles);
  const fitted = [0, 1].flatMap(i => regionCellPositions(cell(i), triangles, sparse, surface));
  const overlay = mesh(fitted);
  close(area(fitted), 1);
  let hidden = 0;
  for (let x = 0.05; x < 1; x += 0.1) for (let y = 0.05; y < 1; y += 0.1) {
    const caster = ray(x, y), skin = caster.intersectObject(actual)[0], hover = caster.intersectObject(overlay)[0];
    assert.ok(skin && hover, `cobertura continua ${x}, ${y}`);
    close(hover.distance, skin.distance);
    if (caster.intersectObject(old)[0].distance > skin.distance + 0.01) hidden++;
  }
  assert.ok(hidden >= 80, `${hidden} muestras ocultas antes del fix`);
  assert.deepEqual([...surface.positions], before, 'no deforma la superficie fuente');
  for (const object of [old, actual, overlay]) dispose(object);
});

test('respeta límites semánticos y no cierra un agujero sin geometría', () => {
  const partial = { ...surface, triangles: surface.triangles.slice(0, 6) };
  const clipped = [0, 1].flatMap(i => regionCellPositions(cell(i), triangles, sparse, partial));
  close(area(clipped), 0.5);
  const object = mesh(clipped);
  assert.equal(ray(0.25, 0.75).intersectObject(object).length, 0, 'sin puente sobre cara ausente');
  assert.ok(ray(0.75, 0.25).intersectObject(object).length > 0);
  dispose(object);
  const quarter = { ...cell(0), corners: [[1, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5]] };
  const region = regionCellPositions(quarter, triangles, sparse, surface);
  close(area(region), 0.125);
  for (let i = 0; i < region.length; i += 3) {
    assert.ok(region[i] <= 0.5 + 1e-8 && region[i + 1] <= region[i] + 1e-8, 'no invade otra celda');
  }
});

test('caras posteriores/invertidas no generan región; el resultado conserva FrontSide', () => {
  const rear = { positions: surface.positions, triangles: Uint32Array.of(4, 1, 0, 4, 2, 1, 4, 3, 2, 4, 0, 3) };
  assert.deepEqual(regionCellPositions(cell(0), triangles, sparse, rear), []);
  const overlay = mesh([0, 1].flatMap(i => regionCellPositions(cell(i), triangles, sparse, surface)));
  assert.equal(ray(0.4, 0.4, -2, 1).intersectObject(overlay).length, 0, 'no muestra hemicara trasera');
  dispose(overlay);
});

test('el recorte conserva oclusión real por otro plano, no desplaza todo hacia cámara', () => {
  const overlay = mesh([0, 1].flatMap(i => regionCellPositions(cell(i), triangles, sparse, surface)));
  const blocker = mesh(Float32Array.of(0, 0, 0.5, 1, 0, 0.5, 1, 1, 0.5, 0, 1, 0.5), triangles);
  const hits = ray(0.6, 0.4).intersectObjects([overlay, blocker]);
  assert.equal(hits[0].object, blocker);
  assert.ok(hits.some(hit => hit.object === overlay), 'la región sigue detrás: depthTest debe conservarse');
  dispose(overlay); dispose(blocker);
});

test('celdas invertidas 2D mantienen geometría frontal y el legacy conserva planos internos', () => {
  const flipped = { ...cell(0), corners: [...cell(0).corners].reverse() };
  close(area(regionCellPositions(flipped, triangles, sparse, surface)), 0.5);
  const degenerate = { ...cell(0), corners: [[1, 0, 0], [1, 0, 0], [1, 0, 0]] };
  assert.deepEqual(regionCellPositions(degenerate, triangles, sparse, surface), []);
  // El atlas incluye los índices de altura facial que utilizan los planos.
  const face = new Float32Array(468 * 3);
  face.set(sparse); face[31] = 2; face[457] = -2;
  const middle = regionPlanePositions(face, triangles, 'middle');
  const deep = regionPlanePositions(face, triangles, 'deep');
  assert.ok(middle[2] < face[2] && deep[2] < middle[2]);
  assert.deepEqual(regionCellPositions(cell(0), triangles, middle), [...middle.slice(0, 9)], 'no snaps de capas profundas a piel');
});

test('atlas genérico no clínico: mejillas y mentón coinciden con la superficie GLB, sin islas ocultas', () => {
  const map = buildFaceRegionMap(Array.from({ length: 468 }, (_, i) =>
    ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] })), atlas.triangles, 1, atlas.positions);
  const cells = buildRegionCells(map, buildFaceTriangleRegions(map, atlas.positions))
    .filter(cell => /Mejillas|Mentón/.test(cell.label));
  const vertices = cells.flatMap(cell => regionCellPositions(cell, atlas.triangles, atlas.positions, atlas.surface));
  const overlay = mesh(vertices), target = mesh(atlas.surface.positions, atlas.surface.triangles);
  let samples = 0;
  for (let i = 0; i < vertices.length; i += 9 * 17) {
    const [x, y] = [0, 1].map(k => (vertices[i + k] + vertices[i + 3 + k] + vertices[i + 6 + k]) / 3);
    const caster = ray(x, y, 10), skin = caster.intersectObject(target)[0], hover = caster.intersectObject(overlay)[0];
    assert.ok(skin && hover);
    close(skin.distance, hover.distance);
    samples++;
  }
  assert.ok(samples > 150);
  dispose(overlay); dispose(target);
});

test('integración: solo observado en personal, etiquetas por cara emitida y relleno con profundidad', () => {
  const lab = readFileSync(new URL('../src/lab/faceSim/FaceSimLab.tsx', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx', import.meta.url), 'utf8');
  assert.match(lab, /personal\.renderSurface\.observedIndexCount/);
  assert.match(lab, /xyz\.length \/ 9; i\+\+\) zones\.push\(zone\)/);
  assert.match(lab, /colors: Float32Array\.from\(personalColors\), labels: personalLabels/);
  assert.match(lab, /depthTest: regionPlane === 'superficial'/);
  const highlight = viewer.slice(viewer.indexOf('const highlightMaterial ='), viewer.indexOf('const highlight ='));
  assert.doesNotMatch(highlight, /wireframe:/, 'el hover no puede volver a ser únicamente líneas');
  assert.match(highlight, /depthTest: anatomicalOverlay\.depthTest \?\? true/);
  assert.match(highlight, /side: THREE\.FrontSide/);
  assert.doesNotMatch(viewer.slice(viewer.indexOf('const highlightMaterial ='), viewer.indexOf('const raycaster = new THREE.Raycaster(), cursor')),
    /wireframe:\s*true/, 'no reintroducir retícula que filtra caras posteriores');
});
