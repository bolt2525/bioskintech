import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { indexedGeometryBounds, updatePhotoFrustum, worldUnitsPerPixel } from '../src/components/admin/ficha-clinica/components/clinicalCamera.ts';

test('frontal ortográfica conserva proporciones XY aunque cambie la profundidad nasal', () => {
  for (const aspect of [0.35, 0.8, 1, 2.4]) {
    const bounds = new THREE.Box3(new THREE.Vector3(-2, -2.5, -4), new THREE.Vector3(2, 2.5, 1));
    const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 1000);
    updatePhotoFrustum(camera, bounds, aspect);
    camera.position.set(0, 0, 12); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const source = [new THREE.Vector3(-1.5, 0, -0.5), new THREE.Vector3(1.5, 0, -0.5),
      new THREE.Vector3(-0.2, 0.4, 1), new THREE.Vector3(0.2, 0.4, 1)];
    const project = p => { const q = p.clone().project(camera); return [q.x * aspect, q.y]; };
    const projected = source.map(project);
    const cheekWidth = projected[1][0] - projected[0][0];
    const noseWidth = projected[3][0] - projected[2][0];
    assert.ok(Math.abs(noseWidth / cheekWidth - 0.4 / 3) < 1e-10);
    const raisedNose = source[3].clone(); raisedNose.z = 5;
    assert.deepEqual(project(raisedNose), projected[3], 'sin magnificación extra por perspectiva');
    for (const x of [-2, 2]) for (const y of [-2.5, 2.5]) for (const z of [-4, 1]) {
      const q = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(q.x) < 1 && Math.abs(q.y) < 1, 'cabeza dentro del encuadre');
    }
    const point = new THREE.Vector3();
    const units = worldUnitsPerPixel(camera, point, 600);
    camera.zoom = 2;
    assert.equal(worldUnitsPerPixel(camera, point, 600), units / 2);
  }
});

test('encuadre del GLB ignora vértices sin índices y distingue cara de casquete', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -2, 0, 1, 2, 1, 0, 0, -4, 500, 500, 500], 3));
  geometry.setIndex([0, 1, 0]);
  assert.deepEqual(indexedGeometryBounds(geometry).max.toArray(), [1, 2, 1]);
  assert.deepEqual(indexedGeometryBounds(geometry).min.toArray(), [-1, -2, 0]);
  geometry.setIndex([0, 1, 2]);
  assert.equal(indexedGeometryBounds(geometry).min.z, -4);
  geometry.dispose();
});
