import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { PersonalSurface } from './engine';
import type { EstimatedHeadSurface } from './estimatedHead';

/** Empaqueta la superficie personal con la foto como textura en un GLB en memoria (no sale del navegador). */
export async function personalSurfaceToGlb(surface: PersonalSurface | EstimatedHeadSurface, photo: HTMLCanvasElement): Promise<ArrayBuffer> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
  geometry.computeVertexNormals();
  const texture = new THREE.CanvasTexture(photo);
  // UV con origen arriba-izquierda, igual que la convención glTF.
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'PERSONAL_FACE_SURFACE';
  const group = new THREE.Group();
  group.add(mesh);
  let estimatedGeometry: THREE.BufferGeometry | undefined;
  let estimatedMaterial: THREE.MeshStandardMaterial | undefined;
  if ('observedIndexCount' in surface) {
    estimatedGeometry = geometry.clone();
    geometry.setIndex(new THREE.BufferAttribute(surface.indices.slice(0, surface.observedIndexCount), 1));
    estimatedGeometry.setIndex(new THREE.BufferAttribute(surface.indices.slice(surface.observedIndexCount), 1));
    estimatedMaterial = new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.9, side: THREE.DoubleSide });
    const estimated = new THREE.Mesh(estimatedGeometry, estimatedMaterial);
    estimated.name = 'ESTIMATED_HEAD_SURFACE';
    group.add(estimated);
  }
  try {
    const result = await new GLTFExporter().parseAsync(group, { binary: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('El exportador no generó un GLB binario.');
    return result;
  } finally {
    geometry.dispose(); texture.dispose(); material.dispose();
    estimatedGeometry?.dispose(); estimatedMaterial?.dispose();
  }
}
