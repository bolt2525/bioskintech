import * as THREE from 'three';

export type ClinicalCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/** El chart MediaPipe ya contiene la perspectiva de la foto: no proyectarla dos veces. */
export function updatePhotoFrustum(camera: THREE.OrthographicCamera, bounds: THREE.Box3, aspect: number) {
  const diameter = bounds.getSize(new THREE.Vector3()).length() * 1.08;
  const height = diameter / Math.min(1, aspect);
  camera.left = -height * aspect / 2;
  camera.right = height * aspect / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.updateProjectionMatrix();
}

export function worldUnitsPerPixel(camera: ClinicalCamera, point: THREE.Vector3, height: number): number {
  return camera instanceof THREE.OrthographicCamera
    ? (camera.top - camera.bottom) / camera.zoom / height
    : 2 * camera.position.distanceTo(point) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom / height;
}

/** Los atributos GLB pueden contener vértices sin usar (iris o el otro grupo). */
export function indexedGeometryBounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  const bounds = new THREE.Box3(), position = geometry.getAttribute('position'), point = new THREE.Vector3();
  const index = geometry.getIndex();
  for (let i = 0; i < (index?.count ?? position.count); i++) {
    point.fromBufferAttribute(position, index ? index.getX(i) : i);
    bounds.expandByPoint(point);
  }
  return bounds;
}
