import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { PersonalSurface } from './engine';

/** Empaqueta la superficie personal con la foto como textura en un GLB en memoria (no sale del navegador). */
export async function personalSurfaceToGlb(surface: PersonalSurface, photo: HTMLCanvasElement): Promise<ArrayBuffer> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
  geometry.computeVertexNormals();
  const texture = new THREE.CanvasTexture(photo);
  // UV con origen arriba-izquierda, igual que la convención glTF.
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'PERSONAL_FACE_SURFACE';
  try {
    const result = await new GLTFExporter().parseAsync(mesh, { binary: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('El exportador no generó un GLB binario.');
    return result;
  } finally {
    geometry.dispose(); texture.dispose(); material.dispose();
  }
}
