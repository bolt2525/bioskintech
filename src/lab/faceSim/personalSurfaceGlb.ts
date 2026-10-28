import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { PersonalSurface } from './engine';
import type { EstimatedHeadSurface } from './estimatedHead';
import type { EstimatedHairSettings, PhotoHairPatch } from './estimatedHair';
import type { PhotoSurfacePatch } from './multiViewHead';

/** GLB local con foto y cabello observado; no cambia los buffers originales. */
export async function personalSurfaceToGlb(surface: PersonalSurface | EstimatedHeadSurface, photo: HTMLCanvasElement,
  hair?: EstimatedHairSettings, hairPatches: readonly PhotoHairPatch[] = [], photoPatches: readonly PhotoSurfacePatch[] = []): Promise<ArrayBuffer> {
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [], textures: THREE.Texture[] = [];
  const group = new THREE.Group();
  const textureFrom = (canvas: HTMLCanvasElement, color = true) => {
    const texture = new THREE.CanvasTexture(canvas); texture.flipY = false;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    textures.push(texture); return texture;
  };
  const geometryFrom = (indices: Uint32Array, uvs = surface.uvs) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals(); geometries.push(geometry); return geometry;
  };
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material) => {
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material); mesh.name = name; group.add(mesh);
  };
  try {
    const observed = 'observedIndexCount' in surface ? surface.indices.slice(0, surface.observedIndexCount) : surface.indices;
    add('PERSONAL_FACE_SURFACE', geometryFrom(observed), new THREE.MeshBasicMaterial({ map: textureFrom(photo), side: THREE.DoubleSide }));
    const observedTriangles = new Set(Array.from({ length: observed.length / 3 }, (_, i) =>
      Array.from(observed.subarray(i * 3, i * 3 + 3)).join(':')));
    photoPatches.forEach((patch, i) => {
      const face: number[] = [], head: number[] = [];
      for (let j = 0; j < patch.indices.length; j += 3) {
        const ids = Array.from(patch.indices.subarray(j, j + 3));
        (observedTriangles.has(ids.join(':')) ? face : head).push(...ids);
      }
      for (const [prefix, indices] of [['PERSONAL_FACE_SURFACE', face], ['ESTIMATED_HEAD_SURFACE_PHOTO', head]] as const) {
        if (!indices.length) continue;
        add(`${prefix}_${i}`, geometryFrom(Uint32Array.from(indices), patch.uvs), new THREE.MeshBasicMaterial({
          map: textureFrom(patch.source.texture), side: THREE.FrontSide,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -1,
        }));
      }
    });
    if ('observedIndexCount' in surface) {
      add('ESTIMATED_HEAD_SURFACE', geometryFrom(surface.indices.slice(surface.observedIndexCount)),
        new THREE.MeshStandardMaterial({ color: surface.inferredColor ?? '#94a3b8', roughness: 0.9, side: THREE.DoubleSide }));
      if (hair?.enabled) hairPatches.forEach((patch, i) => {
        add(`PHOTO_HAIR_SURFACE_${i}`, geometryFrom(patch.indices, patch.uvs), new THREE.MeshStandardMaterial({
          color: '#ffffff', map: textureFrom(patch.source.texture), normalMap: textureFrom(patch.source.normal, false),
          normalScale: new THREE.Vector2(hair.relief * 0.6, hair.relief * 0.6), alphaTest: 0.4,
          roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -1,
        }));
      });
    }
    const result = await new GLTFExporter().parseAsync(group, { binary: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('El exportador no generó un GLB binario.');
    return result;
  } finally {
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
  }
}
