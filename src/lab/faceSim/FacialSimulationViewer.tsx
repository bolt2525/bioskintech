import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PersonalSurface } from './engine';
import { updatePhotoFrustum } from '../../components/admin/ficha-clinica/components/clinicalCamera';
import atlas from './genericFaceAtlas.json';
import { buildFaceRegionMap, buildFaceTriangleRegions, faceRegionColor } from './faceRegions';
import { buildRegionCells, regionCellPositions, regionPlanePositions, REGION_PLANES, type RegionPlane } from './regionMesh';
import { DEFAULT_HAIR, type EstimatedHairSettings, type PhotoHairPatch } from './estimatedHair';
import type { PhotoSurfacePatch } from './multiViewHead';
import type { AnatomicalReference } from './anatomicalReference';
import { ANATOMY_PLANES, anatomyBlend, loadDefaultLayers, registerLayers, type AnatomyPlane } from './defaultLayers';
import { NEUTRAL_SKIN_COSMETICS, SKIN_COSMETIC_CONTROLS, type SkinCosmeticParameters } from './skinAppearance';
import { composeSkinCosmeticTexture } from './skinSignalTexture';
import {
  buildCutPlane, buildSimulationLayers, createSimulationMesh, deformPositions, meshBounds,
  NEUTRAL_SIMULATION, SIMULATION_CONTROLS, SIMULATION_GROUPS, SIMULATION_LAYERS,
  type LayerId, type SimulationCut, type SimulationMesh, type SimulationParameters,
} from './simulation';
const SkinSignalPanel = lazy(() => import('./SkinSignalPanel'));
const AnatomicalReferencePanel = lazy(() => import('./AnatomicalReferencePanel'));

export interface FacialSimulationViewerProps {
  surface?: PersonalSurface;
  photo?: HTMLCanvasElement;
  showMesh?: boolean;
  plane?: RegionPlane;
  onMeshChange?: (visible: boolean) => void;
  onPlaneChange?: (plane: RegionPlane) => void;
  hair?: EstimatedHairSettings;
  hairPatches?: readonly PhotoHairPatch[];
  photoPatches?: readonly PhotoSurfacePatch[];
}

type View = 'front' | 'left' | 'right' | 'orbit';
type Comparison = 'after' | 'before' | 'split';
type InspectorTool = 'morphology' | 'skin' | 'layers' | 'cut';
type LayerSettings = Record<LayerId, { visible: boolean; opacity: number }>;
type SurfaceMaterial = THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
interface ViewerState {
  parameters: SimulationParameters;
  layers: LayerSettings;
  cut: SimulationCut;
  view: View;
  comparison: Comparison;
  showMesh: boolean;
  plane: RegionPlane;
  hair: EstimatedHairSettings;
  hairPatches?: readonly PhotoHairPatch[];
  photoPatches?: readonly PhotoSurfacePatch[];
  skinTexture?: HTMLCanvasElement;
  references: readonly AnatomicalReference[];
  anatomy: AnatomyPlane;
}
interface ViewerRuntime { update: (state: ViewerState) => void; dispose: () => void }

const initialLayers = (): LayerSettings => Object.fromEntries(
  SIMULATION_LAYERS.map(layer => [layer.id, { visible: true, opacity: layer.opacity }]),
) as LayerSettings;
const surfaceLayers = (): LayerSettings => Object.fromEntries(
  SIMULATION_LAYERS.map(layer => [layer.id, { visible: layer.id === 'skin', opacity: layer.id === 'skin' ? 1 : layer.opacity }]),
) as LayerSettings;
const INITIAL_CUT: SimulationCut = { scope: 'none', axis: 'x', position: 0.5, reverse: false };
const ANATOMY_TRANSITION_MS = 750;
const buttonClass = 'rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-100 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 aria-pressed:border-cyan-300 aria-pressed:bg-cyan-950';
const selectClass = 'rounded border border-slate-600 bg-slate-900 p-1 text-xs text-slate-100 focus-visible:outline-cyan-300';
const planeLayers = (plane: RegionPlane): LayerSettings => Object.fromEntries(SIMULATION_LAYERS.map(layer => [
  layer.id, { visible: plane === 'superficial' ? layer.id === 'skin'
    : plane === 'middle' ? layer.id === 'fat' || layer.id === 'nerves' : layer.id === 'muscle' || layer.id === 'vessels',
  opacity: layer.id === 'skin' ? 1 : layer.id === 'fat' ? 0.65 : layer.opacity },
])) as LayerSettings;
const canonicalRegions = buildFaceRegionMap(
  Array.from({ length: 468 }, (_, i) => ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] })),
  atlas.triangles, 1, atlas.positions,
);
const regionCells = buildRegionCells(canonicalRegions, buildFaceTriangleRegions(canonicalRegions, atlas.positions));

function geometryFrom(data: ReturnType<typeof buildSimulationLayers>[number], mesh: SimulationMesh) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  if (data.id === 'skin' && mesh.observedIndexCount !== undefined) {
    geometry.addGroup(0, mesh.observedIndexCount, 0);
    geometry.addGroup(mesh.observedIndexCount, data.indices.length - mesh.observedIndexCount, 1);
  } else geometry.addGroup(0, data.indices.length, 0);
  if (data.id === 'skin' && mesh.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
  if (data.colors) geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Zona inferida: tono de cabello arriba y de piel bajo la línea de la nuca (≈ mitad trago–mentón). */
function inferredMaterial(mesh: SimulationMesh, extra: THREE.MeshStandardMaterialParameters = {}) {
  const material = new THREE.MeshStandardMaterial({ color: mesh.inferredColor ?? '#94a3b8', side: THREE.DoubleSide, roughness: 0.9, ...extra });
  if (!mesh.inferredSkinColor || !mesh.inferredColor) return material;
  const tragus = (mesh.anchors[234 * 3 + 1] + mesh.anchors[454 * 3 + 1]) / 2, chin = mesh.anchors[152 * 3 + 1];
  const uniforms = { uSkin: { value: new THREE.Color(mesh.inferredSkinColor) }, uNeck: { value: (tragus + chin) / 2 }, uBlend: { value: Math.abs(tragus - chin) * 0.12 } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float vInfY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInfY = position.y;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uSkin;\nuniform float uNeck;\nuniform float uBlend;\nvarying float vInfY;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(uSkin, diffuseColor.rgb, smoothstep(uNeck - uBlend, uNeck + uBlend, vInfY));');
  };
  return material;
}

/** Render bajo demanda, sin bucle RAF permanente ni recursos globales. */
function mountFacialSimulation(
  host: HTMLDivElement, mesh: SimulationMesh, photo: HTMLCanvasElement | undefined,
  onError: (message: string) => void,
  onHover: (zone: string | null) => void,
): ViewerRuntime {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setClearColor('#0f172a');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Simulación facial 3D. Arrastra para orbitar; flechas para girar; más y menos para acercar o alejar.');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.01, 1000);
  const bounds = meshBounds(mesh.positions, mesh.indices);
  const cameraBounds = new THREE.Box3(
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
  );
  const size = Math.max(bounds.max.x - bounds.min.x, bounds.height, bounds.max.z - bounds.min.z);
  const center = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
  const distance = size * 2.4;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enablePan = false;
  controls.minDistance = size * 0.7;
  controls.maxDistance = size * 6;
  controls.minZoom = 0.25;
  controls.maxZoom = 8;
  controls.enableDamping = false;
  scene.add(new THREE.HemisphereLight('#ffffff', '#64748b', 2.7));
  const keyLight = new THREE.DirectionalLight('#ffffff', 2.1);
  keyLight.position.set(-3, 5, 8); scene.add(keyLight);
  const rim = new THREE.DirectionalLight('#67e8f9', 1.1);
  rim.position.set(4, 1, -3); scene.add(rim);
  let texture: THREE.CanvasTexture | undefined;
  let signalTexture: THREE.CanvasTexture | undefined, previousSignal: HTMLCanvasElement | undefined;
  const referenceTextures: THREE.Texture[] = [];
  let previousReferences: readonly AnatomicalReference[] | undefined;
  let anatomy: { from: AnatomyPlane; to: AnatomyPlane; start: number } = { from: 'skin', to: 'skin', start: 0 };
  let observer: ResizeObserver | undefined;
  let disposed = false, failed = false, frame = 0;
  let state: ViewerState | undefined, previousView: View | undefined;
  let lastParameters: SimulationParameters | undefined;
  let viewportWidth = 1, viewportHeight = 1;
  const after = new THREE.Group(), before = new THREE.Group();
  scene.add(after, before);
  const referenceGroup = new THREE.Group(); after.add(referenceGroup);
  const photoGroup = new THREE.Group(), beforePhotoGroup = new THREE.Group();
  after.add(photoGroup); before.add(beforePhotoGroup);
  const photoTextures: THREE.Texture[] = [];
  let previousPhotoPatches: readonly PhotoSurfacePatch[] | undefined;
  const triangleKey = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(':');
  const observedTriangles = new Set<string>();
  for (let i = 0; i < (mesh.observedIndexCount ?? mesh.indices.length); i += 3) {
    observedTriangles.add(triangleKey(mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]));
  }
  const afterMeshes = new Map<LayerId, THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial[]>>();
  let beforeMesh: THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial[]> | undefined;
  const regionGeometry = new THREE.BufferGeometry();
  const regionMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, wireframe: true, transparent: true, opacity: 0.32,
    side: THREE.FrontSide, depthTest: false, depthWrite: false });
  const regionOverlay = new THREE.Mesh(regionGeometry, regionMaterial);
  regionOverlay.name = 'SIMULATION_REGION_MESH';
  regionOverlay.renderOrder = 8;
  after.add(regionOverlay);
  const highlightGeometry = new THREE.BufferGeometry();
  const highlightMaterial = new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.3,
    side: THREE.FrontSide, depthTest: false, depthWrite: false });
  const highlight = new THREE.Mesh(highlightGeometry, highlightMaterial);
  highlight.renderOrder = 9; after.add(highlight);
  let selectedZone: string | null = null;
  const selectZone = (zone: string | null) => {
    if (selectedZone === zone) return;
    selectedZone = zone;
    const positions: number[] = [];
    const buffer = regionGeometry.getAttribute('position');
    regionCells.forEach((cell, i) => { if (cell.label === zone) for (let j = 0; j < 3; j++) {
      positions.push(buffer.getX(i * 3 + j), buffer.getY(i * 3 + j), buffer.getZ(i * 3 + j));
    } });
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    highlightGeometry.computeBoundingSphere(); onHover(zone); requestRender();
  };
  const hoverRay = new THREE.Raycaster(), cursor = new THREE.Vector2();
  const leave = () => selectZone(null);
  const hover = (event: PointerEvent) => {
    if (!state?.showMesh || event.buttons || state.comparison === 'before') return leave();
    const rect = canvas.getBoundingClientRect();
    const left = state.comparison === 'split' ? rect.width / 2 : 0;
    const x = event.clientX - rect.left - left;
    if (x < 0) return leave();
    cursor.set(x / (rect.width - left) * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    hoverRay.setFromCamera(cursor, camera);
    const hit = hoverRay.intersectObject(regionOverlay)[0];
    const skin = afterMeshes.get('skin');
    const surfaceHit = skin && hoverRay.intersectObject(skin)[0];
    const isObserved = !surfaceHit || mesh.observedIndexCount === undefined || (surfaceHit.faceIndex ?? Infinity) * 3 < mesh.observedIndexCount;
    const clipped = hit && highlightMaterial.clippingPlanes?.some(plane => plane.distanceToPoint(hit.point) < 0);
    selectZone(hit && isObserved && !clipped ? regionCells[hit.faceIndex ?? -1]?.label ?? null : null);
  };
  const hairGroup = new THREE.Group(); scene.add(hairGroup);
  const hairTextures: THREE.Texture[] = [];
  let previousHair: EstimatedHairSettings | undefined;
  let previousPatches: readonly PhotoHairPatch[] | undefined;
  let previousPlane: RegionPlane | undefined;

  const drawView = (left: number, width: number, group: THREE.Group) => {
    after.visible = group === after; before.visible = group === before;
    if (state) hairGroup.visible = state.hair.enabled && state.plane === 'superficial' && (group === before || state.anatomy === 'skin' && state.layers.skin.visible && state.layers.skin.opacity > 0);
    updatePhotoFrustum(camera, cameraBounds, width / viewportHeight);
    renderer.setViewport(left, 0, width, viewportHeight);
    renderer.setScissor(left, 0, width, viewportHeight);
    renderer.render(scene, camera);
    canvas.dataset.renderedTriangles = String(renderer.info.render.triangles);
  };
  const setOpacity = (material: THREE.Material, opacity: number, forceTransparent = false) => {
    material.opacity = opacity;
    const transparent = forceTransparent || opacity < 1;
    // three.js compila OPAQUE (alfa = 1) en el shader: cambiar transparencia exige recompilar.
    if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
    material.depthWrite = !transparent;
  };
  /** Fundido entre planos: piel → fantasma, capa entrante emerge desde la profundidad de la saliente. */
  const applyAnatomy = (current: ViewerState) => {
    const depths: Partial<Record<AnatomyPlane, number>> = { skin: 0 };
    for (const object of referenceGroup.children) depths[object.userData.kind as AnatomyPlane] = object.userData.baseDepth;
    const blend = anatomyBlend(anatomy.from, anatomy.to, (performance.now() - anatomy.start) / ANATOMY_TRANSITION_MS, depths);
    for (const object of referenceGroup.children) if (object instanceof THREE.Mesh) {
      const layer = blend.layer(object.userData.kind);
      object.material.opacity = layer.opacity * object.userData.opacity;
      object.userData.uDepth.value = layer.depth;
      object.visible = object.material.opacity > 0.005;
    }
    const skinOpacity = current.layers.skin.opacity * blend.skin;
    const skin = afterMeshes.get('skin');
    if (skin) for (const material of skin.material) setOpacity(material, skinOpacity);
    for (const object of photoGroup.children) if (object instanceof THREE.Mesh) setOpacity(object.material, skinOpacity, object.userData.blended);
    return blend.done;
  };
  const render = () => {
    frame = 0;
    if (disposed || failed || !state) return;
    if (!applyAnatomy(state)) frame = requestAnimationFrame(render);
    try {
      renderer.setScissorTest(true);
      if (state.comparison === 'split') {
        const half = Math.floor(viewportWidth / 2);
        drawView(0, half, before); drawView(half, viewportWidth - half, after);
      } else drawView(0, viewportWidth, state.comparison === 'before' ? before : after);
      renderer.setScissorTest(false);
    } catch {
      failed = true;
      onError('No se pudo dibujar la escena 3D. Comprueba WebGL y vuelve a intentar.');
    }
  };
  const requestRender = () => { if (!frame && !disposed && !failed) frame = requestAnimationFrame(render); };
  const contextLost = (event: Event) => {
    event.preventDefault(); failed = true;
    onError('Se perdió el contexto WebGL. Pulsa «Reintentar visor» para recuperarlo.');
  };
  const keyboard = (event: KeyboardEvent) => {
    const angle = 0.10, offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (event.key === '+' || event.key === '=') camera.zoom = Math.min(controls.maxZoom, camera.zoom / 0.9);
    else if (event.key === '-') camera.zoom = Math.max(controls.minZoom, camera.zoom / 1.1);
    else if (controls.enableRotate && event.key === 'ArrowLeft') spherical.theta -= angle;
    else if (controls.enableRotate && event.key === 'ArrowRight') spherical.theta += angle;
    else if (controls.enableRotate && event.key === 'ArrowUp') spherical.phi -= angle;
    else if (controls.enableRotate && event.key === 'ArrowDown') spherical.phi += angle;
    else return;
    event.preventDefault();
    spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, 0.08, Math.PI - 0.08);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    controls.update(); requestRender();
  };
  const dispose = () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    controls.removeEventListener('change', requestRender);
    canvas.removeEventListener('webglcontextlost', contextLost);
    canvas.removeEventListener('keydown', keyboard);
    canvas.removeEventListener('pointermove', hover);
    canvas.removeEventListener('pointerleave', leave);
    controls.dispose();
    scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => material.dispose());
      }
    });
    texture?.dispose();
    signalTexture?.dispose();
    referenceTextures.forEach(texture => texture.dispose());
    hairTextures.forEach(texture => texture.dispose());
    photoTextures.forEach(texture => texture.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
  try {
    if (photo && mesh.source === 'personal' && photo.width > 0 && photo.height > 0) {
      texture = new THREE.CanvasTexture(photo);
      texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace;
    }
    const neutral = buildSimulationLayers(mesh, NEUTRAL_SIMULATION);
    for (const layer of SIMULATION_LAYERS) {
      const data = neutral.find(item => item.id === layer.id)!;
      const material: SurfaceMaterial = layer.id === 'skin' && texture ? new THREE.MeshBasicMaterial({
        map: texture, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      }) : new THREE.MeshStandardMaterial({
        color: layer.id === 'muscle' || (layer.id === 'skin' && texture) ? '#ffffff' : layer.color,
        map: layer.id === 'skin' ? texture : undefined,
        vertexColors: Boolean(data.colors),
        side: THREE.DoubleSide, roughness: 0.8, transparent: true, depthWrite: false,
      });
      const materials = [material];
      if (layer.id === 'skin' && mesh.observedIndexCount !== undefined) materials.push(inferredMaterial(mesh, { transparent: true, depthWrite: false }));
      const object = new THREE.Mesh(geometryFrom(data, mesh), materials);
      object.renderOrder = layer.id === 'skin' ? 5 : layer.id === 'fat' ? 4 : 2;
      after.add(object); afterMeshes.set(layer.id, object);
    }
    const skin = neutral.find(item => item.id === 'skin')!;
    const beforeMaterials: SurfaceMaterial[] = [texture ? new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({
      color: texture ? '#ffffff' : SIMULATION_LAYERS[0].color, map: texture,
      roughness: 0.8, side: THREE.DoubleSide,
    })];
    if (mesh.observedIndexCount !== undefined) beforeMaterials.push(inferredMaterial(mesh));
    beforeMesh = new THREE.Mesh(geometryFrom(skin, mesh), beforeMaterials);
    before.add(beforeMesh);
    controls.addEventListener('change', requestRender);
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('keydown', keyboard);
    canvas.addEventListener('pointermove', hover);
    canvas.addEventListener('pointerleave', leave);
    observer = new ResizeObserver(() => {
      viewportWidth = Math.max(2, Math.floor(host.clientWidth));
      viewportHeight = Math.max(2, Math.floor(host.clientHeight));
      renderer.setSize(viewportWidth, viewportHeight, false);
      requestRender();
    });
    observer.observe(host);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dispose,
    update(next) {
      if (disposed || failed) return;
      state = next;
      if (previousReferences !== next.references || next.parameters !== lastParameters) {
        for (const object of [...referenceGroup.children]) {
          if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
          referenceGroup.remove(object);
        }
        referenceTextures.forEach(texture => texture.dispose()); referenceTextures.length = 0;
        if (next.references.length) {
          const positions = deformPositions(mesh.positions, mesh.anchors, next.parameters);
          const base = new THREE.BufferGeometry();
          base.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          base.setIndex(new THREE.BufferAttribute(mesh.indices.slice(0, mesh.observedIndexCount ?? mesh.indices.length), 1));
          base.computeVertexNormals();
          const width = Math.abs(mesh.anchors[454 * 3] - mesh.anchors[234 * 3]);
          next.references.forEach(reference => {
            const padded = document.createElement('canvas');
            padded.width = reference.canvas.width + 4; padded.height = reference.canvas.height + 4;
            const context = padded.getContext('2d');
            if (!context) throw new Error('No se pudo preparar la referencia anatómica.');
            context.drawImage(reference.canvas, 2, 2);
            const map = new THREE.CanvasTexture(padded);
            map.flipY = false; map.colorSpace = THREE.SRGBColorSpace; referenceTextures.push(map);
            const geometry = base.clone();
            const uvs = Float32Array.from(reference.uvs, (value, i) => i % 2
              ? (value * reference.canvas.height + 2) / padded.height : (value * reference.canvas.width + 2) / padded.width);
            geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            geometry.computeBoundingSphere();
            const material = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, transparent: true, opacity: 0, alphaTest: 0.01, depthWrite: false });
            const uDepth = { value: width * reference.depth };
            // Profundidad como uniform: la transición entre planos hunde la capa sin recalcular geometría.
            material.onBeforeCompile = shader => {
              shader.uniforms.uDepth = uDepth;
              shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uDepth;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed -= normal * uDepth;');
              shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
                '#ifdef USE_MAP\nif (any(lessThan(vMapUv, vec2(0.0))) || any(greaterThan(vMapUv, vec2(1.0)))) discard;\n#endif\n#include <map_fragment>');
            };
            const object = new THREE.Mesh(geometry, material);
            object.name = 'ALIGNED_ANATOMICAL_REFERENCE'; object.renderOrder = 3;
            object.userData = { kind: reference.kind, opacity: reference.opacity, baseDepth: uDepth.value, uDepth };
            referenceGroup.add(object);
          });
          base.dispose();
        }
        previousReferences = next.references;
      }
      if (next.anatomy !== anatomy.to) anatomy = { from: anatomy.to, to: next.anatomy, start: performance.now() };
      if (previousSignal !== next.skinTexture) {
        signalTexture?.dispose(); signalTexture = undefined;
        if (next.skinTexture) {
          signalTexture = new THREE.CanvasTexture(next.skinTexture);
          signalTexture.flipY = false; signalTexture.colorSpace = THREE.SRGBColorSpace;
        }
        const material = afterMeshes.get('skin')?.material[0];
        if (material) { material.map = signalTexture ?? texture ?? null; material.needsUpdate = true; }
        previousSignal = next.skinTexture;
      }
      if (previousPhotoPatches !== next.photoPatches) {
        for (const group of [photoGroup, beforePhotoGroup]) {
          for (const object of [...group.children]) {
            if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
            group.remove(object);
          }
        }
        photoTextures.forEach(texture => texture.dispose()); photoTextures.length = 0;
        next.photoPatches?.forEach((patch, order) => {
          const map = new THREE.CanvasTexture(patch.source.texture);
          map.colorSpace = THREE.SRGBColorSpace; map.flipY = false; photoTextures.push(map);
          const blended = Boolean(patch.alpha && patch.blendIndices?.length);
          const indices = blended ? patch.blendIndices! : patch.indices;
          const observed: number[] = [], inferred: number[] = [];
          for (let i = 0; i < indices.length; i += 3) {
            const target = observedTriangles.has(triangleKey(indices[i], indices[i + 1], indices[i + 2])) ? observed : inferred;
            target.push(indices[i], indices[i + 1], indices[i + 2]);
          }
          for (const group of [photoGroup, beforePhotoGroup]) {
            const parts = group === beforePhotoGroup ? [{ indices, observed: false }]
              : [{ indices: Uint32Array.from(observed), observed: true }, { indices: Uint32Array.from(inferred), observed: false }];
            for (const part of parts) {
            if (!part.indices.length) continue;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(patch.uvs, 2));
            geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
            if (blended) geometry.setAttribute('color', new THREE.BufferAttribute(Float32Array.from({ length: patch.alpha!.length * 4 },
              (_, i) => i % 4 === 3 ? patch.alpha![i >> 2] : 1), 4));
            const object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
              map, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -1,
              vertexColors: blended, transparent: blended, depthWrite: !blended,
            }));
            object.userData.blended = blended;
            object.userData.observed = part.observed;
            // La mezcla «over» exige dibujar las vistas en el mismo orden en que se calcularon los alfas.
            object.name = 'MULTIVIEW_PHOTO_SURFACE'; object.renderOrder = 6 + order * 0.01; group.add(object);
            }
          }
        });
        previousPhotoPatches = next.photoPatches;
        lastParameters = undefined;
      }
      if (next.parameters !== lastParameters) {
        const geometries = buildSimulationLayers(mesh, next.parameters);
        for (const data of geometries) {
          const object = afterMeshes.get(data.id)!;
          const old = object.geometry;
          object.geometry = geometryFrom(data, mesh);
          old.dispose();
        }
        const deformed = deformPositions(mesh.positions, mesh.anchors, next.parameters);
        for (const object of photoGroup.children) if (object instanceof THREE.Mesh) {
          object.geometry.setAttribute('position', new THREE.BufferAttribute(deformed, 3));
          object.geometry.computeBoundingSphere();
        }
      }
      if (next.parameters !== lastParameters || next.plane !== previousPlane) {
        selectZone(null);
        const deformed = deformPositions(mesh.anchors, mesh.anchors, next.parameters);
        const plane = regionPlanePositions(deformed, atlas.triangles, next.plane);
        const positions: number[] = [], colors: number[] = [];
        for (const cell of regionCells) {
          positions.push(...regionCellPositions(cell, atlas.triangles, plane));
          const color = new THREE.Color(faceRegionColor(cell.label));
          for (let j = 0; j < 3; j++) colors.push(color.r, color.g, color.b);
        }
        regionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        regionGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        regionGeometry.computeBoundingSphere();
        previousPlane = next.plane;
      }
      lastParameters = next.parameters;
      regionOverlay.visible = next.showMesh && next.comparison !== 'before';
      highlight.visible = regionOverlay.visible;
      if (previousHair !== next.hair || previousPatches !== next.hairPatches) {
        for (const object of [...hairGroup.children]) {
          if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
          hairGroup.remove(object);
        }
        hairTextures.forEach(texture => texture.dispose()); hairTextures.length = 0;
        if (next.hair.enabled && mesh.observedIndexCount !== undefined) for (const patch of next.hairPatches ?? []) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
          geometry.setAttribute('uv', new THREE.BufferAttribute(patch.uvs, 2));
          geometry.setIndex(new THREE.BufferAttribute(patch.indices, 1)); geometry.computeVertexNormals();
          const map = new THREE.CanvasTexture(patch.source.texture), normal = new THREE.CanvasTexture(patch.source.normal);
          map.colorSpace = THREE.SRGBColorSpace; map.flipY = normal.flipY = false; hairTextures.push(map, normal);
          const object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
            color: '#ffffff', map, normalMap: normal, normalScale: new THREE.Vector2(next.hair.relief * 0.6, next.hair.relief * 0.6),
            alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -1,
          }));
          object.renderOrder = 6; object.name = 'PHOTO_HAIR_SURFACE'; hairGroup.add(object);
        }
        previousHair = next.hair;
        previousPatches = next.hairPatches;
      }
      const cut = buildCutPlane(bounds, next.cut);
      const plane = cut ? new THREE.Plane(new THREE.Vector3(cut.normal.x, cut.normal.y, cut.normal.z), cut.constant) : null;
      for (const object of referenceGroup.children) if (object instanceof THREE.Mesh) {
        object.material.clippingPlanes = plane && next.cut.scope === 'all' ? [plane] : [];
      }
      photoGroup.visible = next.layers.skin.visible && next.layers.skin.opacity > 0;
      for (const group of [photoGroup, beforePhotoGroup]) for (const object of group.children) if (object instanceof THREE.Mesh) {
        // El retoque reemplaza sólo la cara observada, nunca las fotos del cabello, orejas o cuello.
        object.visible = group === beforePhotoGroup || !next.skinTexture || !object.userData.observed;
        object.material.clippingPlanes = plane ? [plane] : [];
        object.material.opacity = group === photoGroup ? next.layers.skin.opacity : 1;
        const transparent = object.userData.blended || object.material.opacity < 1;
        // three.js compila OPAQUE (alfa = 1) en el shader: cambiar transparencia exige recompilar.
        if (object.material.transparent !== transparent) object.material.needsUpdate = true;
        object.material.transparent = transparent;
        object.material.depthWrite = !object.material.transparent;
      }
      regionMaterial.clippingPlanes = plane ? [plane] : [];
      highlightMaterial.clippingPlanes = plane ? [plane] : [];
      for (const object of hairGroup.children) if (object instanceof THREE.Mesh) object.material.clippingPlanes = plane ? [plane] : [];
      for (const [id, object] of afterMeshes) {
        object.visible = next.layers[id].visible && next.layers[id].opacity > 0
          && !(next.anatomy !== 'skin' && id !== 'skin');
        for (const material of object.material) {
          material.opacity = next.layers[id].opacity;
          const transparent = next.layers[id].opacity < 1;
          if (material.transparent !== transparent) {
            material.transparent = transparent;
            material.depthWrite = !transparent;
            material.needsUpdate = true;
          }
          const clipped = plane && (next.cut.scope === 'all' || id === 'skin');
          material.clippingPlanes = clipped ? [plane] : [];
        }
      }
      // Antes conserva originales; recibe el mismo corte para comparar sin ocultaciones engañosas.
      if (beforeMesh) for (const material of beforeMesh.material) material.clippingPlanes = plane ? [plane] : [];
      controls.enableRotate = true;
      if (previousView !== next.view) {
        const direction = next.view === 'left' ? new THREE.Vector3(-1, 0, 0)
          : next.view === 'right' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        camera.position.copy(center).addScaledVector(direction, distance);
        camera.up.set(0, 1, 0); camera.lookAt(center); controls.update();
        previousView = next.view;
      }
      requestRender();
    },
  };
}

/** API de integración: <FacialSimulationViewer surface={surface} photo={photo} /> */
export function FacialSimulationViewer({ surface, photo, showMesh, plane, onMeshChange, onPlaneChange, hair = DEFAULT_HAIR, hairPatches, photoPatches }: FacialSimulationViewerProps) {
  const id = useId(), host = useRef<HTMLDivElement>(null), runtime = useRef<ViewerRuntime | null>(null);
  const inspector = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<InspectorTool>('morphology');
  const [parameters, setParameters] = useState<SimulationParameters>({ ...NEUTRAL_SIMULATION });
  const [layers, setLayers] = useState<LayerSettings>(surfaceLayers);
  const [cut, setCut] = useState<SimulationCut>({ ...INITIAL_CUT });
  const [view, setView] = useState<View>('orbit');
  const [comparison, setComparison] = useState<Comparison>('after');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [attempt, setAttempt] = useState(0);
  const [localMesh, setLocalMesh] = useState(false);
  const [localPlane, setLocalPlane] = useState<RegionPlane>('superficial');
  const [hoveredZone, setHoveredZone] = useState<string | null>(null);
  const [signal, setSignal] = useState<{ source: HTMLCanvasElement; canvas: HTMLCanvasElement }>();
  const [cosmetics, setCosmetics] = useState<SkinCosmeticParameters>({ ...NEUTRAL_SKIN_COSMETICS });
  const [cosmeticTexture, setCosmeticTexture] = useState<{ source: HTMLCanvasElement; canvas: HTMLCanvasElement }>();
  const [cosmeticError, setCosmeticError] = useState<string | null>(null);
  const [cosmeticPending, setCosmeticPending] = useState(false);
  const [customReference, setCustomReference] = useState<AnatomicalReference>();
  const [defaultReferences, setDefaultReferences] = useState<AnatomicalReference[]>([]);
  const [anatomy, setAnatomy] = useState<AnatomyPlane>('skin');
  useEffect(() => {
    setDefaultReferences([]);
    if (!surface) return;
    let live = true;
    loadDefaultLayers().then(layers => { if (live) setDefaultReferences(registerLayers(layers, surface.uvs)); }).catch(() => undefined);
    return () => { live = false; };
  }, [surface]);
  const references = useMemo(() => customReference
    ? [...defaultReferences.filter(item => item.kind !== customReference.kind), customReference] : defaultReferences,
  [defaultReferences, customReference]);
  const onReference = useCallback((value: AnatomicalReference | undefined) => {
    setCustomReference(value);
    if (value) setAnatomy(value.kind);
  }, []);
  const onSignalTexture = useCallback((canvas: HTMLCanvasElement | undefined) => {
    setSignal(photo && canvas ? { source: photo, canvas } : undefined);
  }, [photo]);
  const signalTexture = signal?.source === photo ? signal?.canvas : undefined;
  const skinTexture = signalTexture ?? (cosmeticTexture?.source === photo ? cosmeticTexture?.canvas : undefined);
  const signalLandmarks = useMemo(() => surface
    ? Array.from({ length: 468 }, (_, i) => ({ x: surface.uvs[i * 2], y: surface.uvs[i * 2 + 1] })) : undefined, [surface]);
  useEffect(() => {
    setCosmeticTexture(undefined); setCosmeticError(null);
    if (!photo || !signalLandmarks || Object.values(cosmetics).every(value => value === 0)) {
      setCosmeticPending(false);
      return;
    }
    setCosmeticPending(true);
    // Agrupa el arrastre: no lee píxeles ni recompone mapas por cada evento del slider.
    const timer = window.setTimeout(() => {
      try { setCosmeticTexture({ source: photo, canvas: composeSkinCosmeticTexture(photo, signalLandmarks, cosmetics) }); }
      catch { setCosmeticError('No se pudo retocar la foto. Comprueba la imagen y las referencias faciales; el original se conserva.'); }
      finally { setCosmeticPending(false); }
    }, 160);
    return () => window.clearTimeout(timer);
  }, [photo, signalLandmarks, cosmetics]);
  const activePlane = plane ?? localPlane, meshVisible = showMesh ?? localMesh;
  const prepared = useMemo(() => {
    try { return { mesh: createSimulationMesh(surface), error: null }; }
    catch (cause) { return { mesh: null, error: cause instanceof Error ? cause.message : 'Superficie no válida.' }; }
  }, [surface]);
  const state = useMemo<ViewerState>(() => ({ parameters, layers, cut, view, comparison, showMesh: meshVisible, plane: activePlane, hair, hairPatches, photoPatches, skinTexture, references, anatomy }),
    [parameters, layers, cut, view, comparison, meshVisible, activePlane, hair, hairPatches, photoPatches, skinTexture, references, anatomy]);
  useEffect(() => { setLayers(planeLayers(activePlane)); }, [activePlane]);

  useEffect(() => {
    setError(null); setReady(false);
    if (!host.current || !prepared.mesh) return;
    try {
      runtime.current = mountFacialSimulation(host.current, prepared.mesh, photo, message => { setError(message); setReady(false); }, setHoveredZone);
      setReady(true);
    } catch {
      setError('No se pudo iniciar WebGL. Comprueba la aceleración gráfica del navegador.');
    }
    return () => { runtime.current?.dispose(); runtime.current = null; };
  }, [prepared, photo, attempt]);

  useEffect(() => {
    try { runtime.current?.update(state); }
    catch { setError('No se pudo actualizar la simulación 3D. Reinicia el visor.'); setReady(false); }
  }, [state, prepared, photo, attempt]);

  const reset = () => {
    setParameters({ ...NEUTRAL_SIMULATION }); setLayers(surfaceLayers());
    setCosmetics({ ...NEUTRAL_SKIN_COSMETICS }); setCosmeticTexture(undefined); setSignal(undefined);
    setCut({ ...INITIAL_CUT }); setView('front'); setComparison('after'); setAnatomy('skin');
    if (onPlaneChange) onPlaneChange('superficial'); else setLocalPlane('superficial');
    setHoveredZone(null);
    setAttempt(value => value + 1);
  };
  const failure = prepared.error || error;
  const setLayer = (key: LayerId, update: Partial<LayerSettings[LayerId]>) =>
    setLayers(current => ({ ...current, [key]: { ...current[key], ...update } }));

  return (
    <section aria-labelledby={`${id}-title`} data-face-editor className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-700 bg-slate-900 p-3 text-slate-100 lg:sticky lg:top-2 lg:h-[calc(100dvh-5rem)] lg:min-h-[560px]">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="text-sm font-semibold">Simulación morfológica 3D</h2>
          <p className="text-xs text-slate-300">Exploración visual · intensidades relativas, sin unidades clínicas.</p>
        </div>
        <button type="button" className={buttonClass} onClick={reset}>Restablecer todo</button>
      </header>
      <div className="flex shrink-0 flex-wrap justify-between gap-2 rounded-lg bg-slate-950/60 p-2">
        <div role="group" aria-label="Orientación del modelo" className="flex flex-wrap gap-1">
          {([['front', 'Frontal'], ['left', 'Perfil lado A'], ['right', 'Perfil lado B'], ['orbit', 'Orbitar']] as const).map(([key, label]) => (
            <button type="button" key={key} className={buttonClass} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>
          ))}
        </div>
        <div role="group" aria-label="Comparación morfológica" className="flex flex-wrap gap-1">
          {([['before', 'Antes'], ['after', 'Después'], ['split', 'Comparar 3D']] as const).map(([key, label]) => (
            <button type="button" key={key} className={buttonClass} aria-pressed={comparison === key} onClick={() => setComparison(key)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="relative min-h-64 flex-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
            <div ref={host} data-simulation-viewport className="h-[46dvh] min-h-64 w-full lg:h-full" />
            {comparison === 'split' && !failure ? (
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-2 text-center text-xs">
                <span className="border-r border-slate-400/50 pt-2">Antes · original</span><span className="pt-2">Después · capas</span>
              </div>
            ) : null}
            {failure ? (
              <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950 p-6 text-center text-sm">
                <p>{failure}</p>
                {!prepared.error ? <button type="button" className={buttonClass} onClick={() => setAttempt(value => value + 1)}>Reintentar visor</button> : null}
              </div>
            ) : !ready ? <p role="status" className="absolute inset-x-0 top-6 text-center text-sm">Preparando visor 3D…</p> : null}
          </div>
          <p role="status" className="min-h-5 truncate text-xs font-semibold text-sky-200">{hoveredZone ?? (meshVisible ? 'Pasa el cursor por una zona de la malla' : prepared.mesh?.source === 'personal' ? 'Superficie personal aproximada · zonas sin cobertura inferidas' : 'Cabeza genérica de referencia')}</p>
          <p id={`${id}-help`} className="text-[11px] text-slate-400">Arrastra o usa las flechas para girar · rueda, pinza o +/− para zoom. «Antes» conserva el original.</p>
          <details className="shrink-0 text-xs text-slate-400"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-cyan-300">Límites · no es un escaneo ni una predicción clínica</summary>
            <p className="max-h-24 overflow-y-auto py-2">La cabeza y el cabello son aproximaciones; las zonas ocultas proceden de una plantilla genérica. Las capas internas son ilustraciones, no anatomía detectada ni planos de inyección. Grasa: almohadillas; músculos: bandas; vasos y nervios: tubos de profundidad arbitraria. La textura sigue la deformación; no predice tratamientos.</p>
          </details>
        </div>
        <aside aria-label="Inspector de simulación" className="flex min-h-0 min-w-0 flex-col rounded-lg border border-slate-700 bg-slate-950/40">
          <nav aria-label="Herramientas de simulación" className="grid shrink-0 grid-cols-2 gap-1 border-b border-slate-700 p-2">
            {([['morphology', 'Morfología'], ['skin', 'Piel'], ['layers', 'Capas'], ['cut', 'Corte']] as const).map(([key, label]) =>
              <button type="button" key={key} aria-pressed={tool === key} aria-controls={`${id}-tool-${key}`}
                className={`${buttonClass} min-h-10`} onClick={() => { setTool(key); inspector.current?.scrollTo({ top: 0 }); }}>{label}</button>)}
          </nav>
          <div ref={inspector} data-simulation-inspector className="max-h-[48dvh] min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 lg:max-h-none lg:flex-1" aria-describedby={`${id}-help`}>
          <div id={`${id}-tool-morphology`} hidden={tool !== 'morphology'} className="space-y-3">
          <button type="button" className={buttonClass} onClick={() => { setLayers(surfaceLayers()); setAnatomy('skin'); }}>Mostrar superficie</button>
          {SIMULATION_GROUPS.map(group => (
            <fieldset key={group} className="space-y-2 rounded-lg border border-slate-700 p-2">
              <legend className="px-1 text-xs font-semibold">{group}</legend>
              {SIMULATION_CONTROLS.filter(control => control.group === group).map(control => (
                <label key={control.key} className="block text-xs" htmlFor={`${id}-${control.key}`}>
                  <span className="flex justify-between gap-2"><span>{control.label}</span><output>{Math.round(parameters[control.key] * 100)} %</output></span>
                  <input id={`${id}-${control.key}`} type="range" min="-1" max="1" step="0.01" value={parameters[control.key]}
                    aria-valuetext={`${Math.round(parameters[control.key] * 100)} por ciento de intensidad visual`}
                    onChange={event => setParameters(current => ({ ...current, [control.key]: Number(event.target.value) }))}
                    className="mt-1 block w-full accent-cyan-400 focus-visible:outline-cyan-300" />
                </label>
              ))}
              {group === 'Nariz' ? <p className="text-[11px] text-slate-400">− reduce / + aumenta · rotación + eleva la punta</p> : null}
            </fieldset>
          ))}
          </div>
          <div id={`${id}-tool-skin`} hidden={tool !== 'skin'} className="space-y-3">
              <fieldset disabled={!photo || !surface} aria-describedby={`${id}-cosmetic-help`} className="space-y-3 rounded-lg border border-slate-700 p-2 disabled:opacity-50">
                <legend className="px-1 text-xs font-semibold">Retoque cosmético visual · piel</legend>
                <p id={`${id}-cosmetic-help`} className="text-[11px] text-slate-300">
                  Retoque local de la cara, no del cabello ni del cuello. Intensidad visual, no eficacia clínica; no detecta manchas o arrugas ni elimina pliegues 3D.
                </p>
                {!photo || !surface ? <p className="text-xs text-amber-200">Necesita una foto con referencias faciales válidas.</p> : null}
                {SKIN_COSMETIC_CONTROLS.map(control => (
                  <label key={control.key} htmlFor={`${id}-cosmetic-${control.key}`} className="block text-xs">
                    <span className="flex justify-between gap-2"><span>{control.label}</span><output>{Math.round(cosmetics[control.key] * 100)}</output></span>
                    <input id={`${id}-cosmetic-${control.key}`} type="range" min={control.min} max="1" step="0.01" value={cosmetics[control.key]}
                      aria-valuetext={`${Math.round(cosmetics[control.key] * 100)} de intensidad visual, no eficacia clínica`}
                      onChange={event => setCosmetics(current => ({ ...current, [control.key]: Number(event.target.value) }))}
                      className="mt-1 block w-full accent-cyan-400 focus-visible:outline-cyan-300" />
                  </label>
                ))}
                <button type="button" className={buttonClass} onClick={() => setCosmetics({ ...NEUTRAL_SKIN_COSMETICS })}>Restablecer piel</button>
                <p role="status" className="text-[11px] text-slate-300">
                  {signalTexture ? 'El resaltado RGB tiene prioridad; vuelve a «Original» en los filtros para ver el retoque.'
                    : cosmeticPending ? 'Preparando retoque local…' : '«Antes» conserva la foto original. Retoque local hasta 768 px; no recupera detalle ausente.'}
                </p>
                {cosmeticError ? <p role="alert" className="text-xs text-amber-200">{cosmeticError}</p> : null}
              </fieldset>
              {photo && surface && <details className="rounded-lg border border-slate-600 p-2 text-sm">
                <summary className="cursor-pointer">Señales visuales de piel · RGB</summary>
                <Suspense fallback={<p role="status">Preparando filtros…</p>}>
                  <SkinSignalPanel canvas={photo} landmarks={signalLandmarks} onTexture={onSignalTexture} />
                </Suspense>
              </details>}
          </div>
          <div id={`${id}-tool-layers`} hidden={tool !== 'layers'} className="space-y-3">
            <div role="group" aria-label="Referencias ilustradas alineables" className="grid grid-cols-2 gap-1">
              {ANATOMY_PLANES.map(entry => {
                const available = entry.id === 'skin' || references.some(item => item.kind === entry.id);
                return <button type="button" key={entry.id} title={available ? entry.hint : `${entry.hint} · cargando…`} disabled={!available}
                  aria-pressed={anatomy === entry.id} className={`${buttonClass} min-h-10 disabled:opacity-40`} onClick={() => setAnatomy(entry.id)}>{entry.label}</button>;
              })}
            </div>
            <button type="button" className={buttonClass} onClick={() => { setLayers(initialLayers()); setAnatomy('skin'); }}>Ver volúmenes genéricos</button>
            <p className="text-xs text-amber-200">Capas genéricas · no anatomía interna del paciente</p>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={meshVisible} onChange={event => {
              if (onMeshChange) onMeshChange(event.target.checked); else setLocalMesh(event.target.checked);
            }} />Mostrar mallado de zonas</label>
            <label className="block text-xs">Plano visual
              <select aria-label="Plano visual de simulación" value={activePlane} className={`${selectClass} mt-1 w-full`} onChange={event => {
                const value = event.target.value as RegionPlane;
                if (onPlaneChange) onPlaneChange(value); else setLocalPlane(value);
              }}>{REGION_PLANES.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>
            </label>
      <fieldset className="rounded-lg border border-slate-700 p-2">
        <legend className="px-1 text-xs font-semibold">Capas simultáneas · visibilidad y opacidad</legend>
        <div className="space-y-4">
          {SIMULATION_LAYERS.map(layer => (
            <div key={layer.id} className="min-w-0 space-y-1">
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={layers[layer.id].visible} onChange={event => setLayer(layer.id, { visible: event.target.checked })} className="accent-cyan-400" />
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: layer.color }} />
                {layer.label}
              </label>
              <label className="block text-[11px] text-slate-300">
                Opacidad · {Math.round(layers[layer.id].opacity * 100)} %
                <input type="range" min="0" max="1" step="0.01" value={layers[layer.id].opacity}
                  aria-label={`Opacidad: ${layer.label}`} onChange={event => setLayer(layer.id, { opacity: Number(event.target.value) })}
                  className="block w-full accent-cyan-400" />
              </label>
            </div>
          ))}
        </div>
        {anatomy === 'skin' && SIMULATION_LAYERS.every(layer => !layers[layer.id].visible || layers[layer.id].opacity === 0) && comparison !== 'before'
          ? <p role="status" className="mt-2 text-xs text-amber-200">No hay capas visibles. Activa una capa o restablece el visor.</p> : null}
      </fieldset>
            {surface && <details className="rounded-lg border border-slate-600 p-2 text-sm">
              <summary className="cursor-pointer">Reemplazar capa · imagen propia</summary>
              <Suspense fallback={<p role="status">Preparando alineación…</p>}>
                <AnatomicalReferencePanel surfaceUVs={surface.uvs} onChange={onReference} />
              </Suspense>
            </details>}
          </div>
          <div id={`${id}-tool-cut`} hidden={tool !== 'cut'}>
      <fieldset className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 p-2">
        <legend className="px-1 text-xs font-semibold">Corte visual · recorte sin relleno interior</legend>
        <label className="flex items-center gap-2 text-xs">Aplicar a
          <select className={selectClass} value={cut.scope} onChange={event => setCut(current => ({ ...current, scope: event.target.value as SimulationCut['scope'] }))}>
            <option value="none">Sin corte</option><option value="skin">Sólo piel</option><option value="all">Todas las capas</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">Eje
          <select className={selectClass} disabled={cut.scope === 'none'} value={cut.axis} onChange={event => setCut(current => ({ ...current, axis: event.target.value as SimulationCut['axis'] }))}>
            <option value="x">Lateral</option><option value="y">Vertical</option><option value="z">Profundidad</option>
          </select>
        </label>
        <label className="min-w-36 flex-1 text-xs">Posición · {Math.round(cut.position * 100)} %
          <input type="range" min="0" max="1" step="0.01" disabled={cut.scope === 'none'} value={cut.position} onChange={event => setCut(current => ({ ...current, position: Number(event.target.value) }))} className="block w-full accent-cyan-400" />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" disabled={cut.scope === 'none'} checked={cut.reverse} onChange={event => setCut(current => ({ ...current, reverse: event.target.checked }))} className="accent-cyan-400" />Invertir corte
        </label>
      </fieldset>
          </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

export default FacialSimulationViewer;
