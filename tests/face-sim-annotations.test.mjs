import assert from 'node:assert/strict';
import test from 'node:test';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import { addressHasPhotoCoverage, anatomicalPhotoElements, annotationViews, bindAnatomicalPaths, shapeOutline } from '../src/lab/faceSim/anatomicalAnnotations.ts';
import { modelPoint, photoPoint } from '../src/lab/faceSim/faceTransfer.ts';
import { DEFAULT_FRAME, expandElems } from '../src/lab/faceSim/engine.ts';

const landmarks = Array.from({ length: 468 }, (_, i) => ({
  x: 0.5 + atlas.positions[i * 3] * 0.16,
  y: 0.5 - atlas.positions[i * 3 + 1] * 0.16,
}));
const address = { triangle: 0, weights: [0.2, 0.3, 0.5] };
const meta = { mode: 'toxina', dose: 3, zone: 'Zona manual', product: 'Producto de prueba' };

test('cobertura rechaza triángulos invertidos, colapsados y fuera de fotografía', () => {
  assert.equal(addressHasPhotoCoverage(address, landmarks, atlas), true);
  const ids = atlas.triangles.slice(0, 3);
  const inverted = structuredClone(landmarks);
  [inverted[ids[0]], inverted[ids[1]]] = [inverted[ids[1]], inverted[ids[0]]];
  assert.equal(addressHasPhotoCoverage(address, inverted, atlas), false);
  const collapsed = structuredClone(landmarks);
  ids.forEach(i => { collapsed[i] = { x: 0.5, y: 0.5 }; });
  assert.equal(addressHasPhotoCoverage(address, collapsed, atlas), false);
  const outside = structuredClone(landmarks);
  outside[ids[0]].x = -0.01;
  assert.equal(addressHasPhotoCoverage(address, outside, atlas), false);
});

test('trazos densificados se rechazan completos si atraviesan una zona sin reconstruir', () => {
  const line = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }];
  const binding = bindAnatomicalPaths([line], () => address, 'free', 0.1);
  assert.equal(binding.paths[0].length, 11);
  assert.equal(bindAnatomicalPaths([line], p => p.x > 0.4 && p.x < 0.6 ? null : address, 'free', 0.1), null);
  assert.equal(bindAnatomicalPaths([[{ x: NaN, y: 0, z: 0 }]], () => address, 'point'), null);
  assert.equal(bindAnatomicalPaths([line], () => address, 'free', 1e-8), null);
});

test('un mismo binding conserva metadatos y posición al generar modelo y foto', () => {
  const bindings = { mark: { kind: 'point', paths: [[address]] } };
  const marker = { id: 'mark', position: { x: 0, y: 0, z: 0 }, pathology: 'filler', color: '#ffffff' };
  const views = annotationViews([marker], [], [], bindings, atlas, a => modelPoint(a, atlas));
  assert.deepEqual(views.markers[0].position, modelPoint(address, atlas));
  assert.equal(views.markers[0].id, 'mark');
  const [element] = anatomicalPhotoElements(bindings, { mark: meta }, landmarks, atlas);
  assert.deepEqual(element.paths[0][0], photoPoint(address, landmarks, atlas));
  for (const key of Object.keys(meta)) assert.equal(element[key], meta[key]);
  assert.equal(annotationViews([marker], [], [], {}, atlas, a => modelPoint(a, atlas)).markers.length, 0);
});

test('área transferida usa su polígono real, sin recortarla otra vez a una elipse', () => {
  const boundary = [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.7 }, { x: 0.3, y: 0.7 }];
  const area = { ...meta, id: 'area', kind: 'circle', paths: [[{ x: 0.5, y: 0.5 }]], rx: 0.2, ry: 0.2 };
  const transferred = expandElems([{ ...area, boundary }], DEFAULT_FRAME, 1).derived;
  const original = expandElems([area], DEFAULT_FRAME, 1).derived;
  assert.ok(transferred.length > original.length);
  assert.ok(transferred.some(p => ((p.x - 0.5) / 0.2) ** 2 + ((p.y - 0.5) / 0.2) ** 2 > 1.2));
  assert.ok(transferred.every(p => p.x > 0.3 && p.x < 0.7 && p.y > 0.3 && p.y < 0.7));
});

test('contornos de formas respetan tangente, dimensiones y cierre', () => {
  const shape = { center: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 }, shapeType: 'rect', width: 2, height: 4 };
  const points = shapeOutline(shape);
  assert.deepEqual(points[0], points.at(-1));
  assert.equal(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)), 2);
  assert.equal(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)), 4);
  assert.ok(points.every(p => p.z === 1));
  assert.deepEqual(shapeOutline({ ...shape, normal: { x: 0, y: 0, z: 0 } }), []);
});
