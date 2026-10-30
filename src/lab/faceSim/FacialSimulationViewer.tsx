import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PersonalSurface } from './engine';
import { updatePhotoFrustum } from '../../components/admin/ficha-clinica/components/clinicalCamera';
import atlas from './genericFaceAtlas.json';
import { buildFaceRegionMap, buildFaceTriangleRegions, faceRegionColor } from './faceRegions';
import { buildRegionCells, regionCellPositions, regionPlanePositions, type RegionPlane } from './regionMesh';
import { DEFAULT_HAIR, type EstimatedHairSettings, type PhotoHairPatch } from './estimatedHair';
import type { PhotoSurfacePatch } from './multiViewHead';
import type { AnatomicalReference } from './anatomicalReference';
import { ANATOMY_PLANES, buildCanonicalReferenceUVs, loadDefaultLayers, registerLayers, type AnatomyPlane } from './defaultLayers';
import { anatomicalZoneAt } from './anatomicalZones';
import { AnatomyLayerControls, chooseAnatomyDisplay, initialAnatomyDisplay, type AnatomyDisplayState } from './anatomyDisplay';
import { buildReferenceGeometry } from './referenceGeometry';
import { refineDisplaySurface } from './displaySurface';
import { buildMaskBacking, INITIAL_REVEAL, revealPlane, revealStage, type MaskReveal, type ReferenceKind } from './maskAnatomy';
import { NEUTRAL_SKIN_COSMETICS, SKIN_COSMETIC_CONTROLS, type SkinCosmeticParameters } from './skinAppearance';
import { composeSkinCosmeticTexture } from './skinSignalTexture';
import { applySkinRegionRelief, type SkinReviewRegion } from './skinRegionReview';
import { editorPanel } from './MarkingPanels';
import {
  buildCutPlane, buildSimulationLayers, buildSimulationReferenceSurface, createSimulationMesh, deformPositions, meshBounds,
  NEUTRAL_SIMULATION, SIMULATION_CONTROLS, SIMULATION_GROUPS, SIMULATION_LAYERS, vertexNormals,
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
  anatomyDisplay?: AnatomyDisplayState;
  onAnatomyDisplayChange?: (value: AnatomyDisplayState) => void;
}

type View = 'front' | 'left' | 'right' | 'orbit';
type Comparison = 'after' | 'before' | 'split';
type InspectorTool = 'morphology' | 'skin' | 'layers' | 'cut';
type LayerSettings = Record<LayerId, { visible: boolean; opacity: number }>;
type ReferenceSettings = Record<ReferenceKind, { visible: boolean; opacity: number }>;
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
  skinRegions: readonly SkinReviewRegion[];
  references: readonly AnatomicalReference[];
  anatomy: AnatomyPlane;
  referenceLayers: ReferenceSettings;
  overlay: boolean;
  reveal: MaskReveal;
  selection: string | null;
  marks: readonly string[];
}
interface ViewerRuntime { update: (state: ViewerState) => void; dispose: () => void }
interface PreparedSimulation {
  mesh: SimulationMesh | null;
  sourceMesh: SimulationMesh | null;
  refinement: ReturnType<typeof refineDisplaySurface> | null;
  error: string | null;
}
const EMPTY_PREPARED: PreparedSimulation = { mesh: null, sourceMesh: null, refinement: null, error: null };
const EMPTY_SKIN_REGIONS: readonly SkinReviewRegion[] = [];

const INITIAL_CUT: SimulationCut = { scope: 'none', axis: 'x', position: 0.5, reverse: false };
const buttonClass = 'min-h-9 rounded-lg border border-white/15 bg-black/20 px-2.5 py-1.5 text-xs text-stone-200 hover:border-gold/50 hover:bg-gold/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold aria-pressed:border-gold aria-pressed:bg-gold/20 aria-pressed:text-gold';
const selectClass = 'min-h-9 rounded-lg border border-white/20 bg-stone-950 p-1.5 text-xs text-stone-100 focus-visible:outline-gold';
const canonicalRegions = buildFaceRegionMap(
  Array.from({ length: 468 }, (_, i) => ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] })),
  atlas.triangles, 1, atlas.positions,
);
const regionCells = buildRegionCells(canonicalRegions, buildFaceTriangleRegions(canonicalRegions, atlas.positions));
let anatomyCells: ReturnType<typeof buildRegionCells> | undefined;
const getAnatomyCells = () => anatomyCells ??= buildRegionCells(canonicalRegions, buildFaceTriangleRegions(canonicalRegions, atlas.positions), 3);
const genericReferenceUVs = buildCanonicalReferenceUVs(atlas.positions);

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
  host: HTMLDivElement, mesh: SimulationMesh, sourceMesh: SimulationMesh, photo: HTMLCanvasElement | undefined,
  onError: (message: string) => void,
  onHover: (zone: string | null) => void,
  onSelect: (zone: string | null) => void,
  onReady: () => void,
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
  const referenceTextures = new Map<HTMLCanvasElement, THREE.Texture>();
  let previousReferences: readonly AnatomicalReference[] | undefined;
  let observer: ResizeObserver | undefined;
  let disposed = false, failed = false, frame = 0;
  let state: ViewerState | undefined, previousView: View | undefined;
  let lastParameters: SimulationParameters | undefined;
  let lastSkinRegions: readonly SkinReviewRegion[] | undefined;
  let morphologyPositions = mesh.positions;
  let morphologyNormals: Float32Array | undefined;
  let deformedPositions = mesh.positions;
  let referenceParameters: SimulationParameters | undefined;
  let regionState: ViewerState | undefined;
  let announcedReady = false;
  let viewportWidth = 1, viewportHeight = 1;
  const after = new THREE.Group(), before = new THREE.Group();
  scene.add(after, before);
  const referenceGroup = new THREE.Group(); after.add(referenceGroup);
  // Morph de capas: misma topología por capa (superficie hundida por profundidad); se interpolan vértices y opacidad.
  type LayerMotion = { shown?: number; morph?: { from: Float32Array; to: Float32Array; start: number }; displaced?: boolean };
  const layerMotion = new Map<ReferenceKind, LayerMotion>();
  let skinShown: number | undefined, animating = false, lastStep = 0;
  const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const photoGroup = new THREE.Group(), beforePhotoGroup = new THREE.Group();
  after.add(photoGroup); before.add(beforePhotoGroup);
  const photoTextures: THREE.Texture[] = [];
  let afterBacking: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
  let beforeBacking: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
  const backingGeometry = (positions: Float32Array, thicknessRatio = 0.11) => {
    const data = buildMaskBacking(positions, mesh.indices, thicknessRatio);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    return geometry;
  };
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
  let cellLabels: (string | null)[] = regionCells.map(cell => cell.label);
  let activeCells = regionCells;
  const selectZone = (zone: string | null, force = false) => {
    if (!force && selectedZone === zone) return;
    selectedZone = zone;
    const positions: number[] = [];
    const buffer = regionGeometry.getAttribute('position');
    activeCells.forEach((_, i) => { if (cellLabels[i] === zone && zone) for (let j = 0; j < 3; j++) {
      positions.push(buffer.getX(i * 3 + j), buffer.getY(i * 3 + j), buffer.getZ(i * 3 + j));
    } });
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    highlightGeometry.computeBoundingSphere(); onHover(zone); requestRender();
  };
  const hoverRay = new THREE.Raycaster(), cursor = new THREE.Vector2();
  let pointerInside = false, previousAnatomy: AnatomyPlane | undefined;
  const leave = () => { pointerInside = false; selectZone(state?.selection ?? null); };
  let pointerStart: { x: number; y: number } | undefined;
  const pointerDown = (event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY }; };
  const pointerUp = (event: PointerEvent) => {
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 5 && state?.showMesh) onSelect(selectedZone);
    pointerStart = undefined;
  };
  const hover = (event: PointerEvent) => {
    pointerInside = true;
    if (!state?.showMesh || event.buttons || state.comparison === 'before') return leave();
    if (state.selection) return selectZone(state.selection);
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
    const covered = state.anatomy !== 'skin' && !state.overlay && surfaceHit && hit && surfaceHit.distance < hit.distance - 1e-5
      && state.layers.skin.visible && state.layers.skin.opacity >= 0.99
      && !afterMeshes.get('skin')?.material[0].clippingPlanes?.some(plane => plane.distanceToPoint(surfaceHit.point) < 0);
    let label = hit ? cellLabels[hit.faceIndex ?? -1] ?? null : null;
    const inspectedKind = state.anatomy;
    const reference = state.references.find(item => item.kind === inspectedKind);
    const referenceMesh = referenceGroup.children.find(object => object.userData.kind === inspectedKind);
    if (reference?.zones && referenceMesh) {
      const uv = hoverRay.intersectObject(referenceMesh)[0]?.uv;
      label = uv ? anatomicalZoneAt(reference.zones,
        (uv.x * (reference.canvas.width + 4) - 2) / reference.canvas.width,
        (uv.y * (reference.canvas.height + 4) - 2) / reference.canvas.height) : null;
    }
    selectZone(hit && isObserved && !clipped && !covered ? label : null);
  };
  const hairGroup = new THREE.Group(); scene.add(hairGroup);
  const hairTextures: THREE.Texture[] = [];
  let previousHair: EstimatedHairSettings | undefined;
  let previousPatches: readonly PhotoHairPatch[] | undefined;

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
  /** Referencias opacas/translúcidas reales o superposición explícita; el corte solo retira el plano saliente. */
  const applyAnatomy = (current: ViewerState, time: number) => {
    const stage = revealStage(current.reveal);
    const freeCut = buildCutPlane(bounds, current.cut);
    const freePlane = freeCut ? new THREE.Plane(new THREE.Vector3(freeCut.normal.x, freeCut.normal.y, freeCut.normal.z), freeCut.constant) : null;
    const outgoing = stage?.from === 'skin' ? afterMeshes.get('skin')
      : referenceGroup.children.find(object => object.userData.kind === stage?.from);
    let slice: THREE.Plane | undefined;
    if (stage && outgoing instanceof THREE.Mesh) {
      outgoing.geometry.computeBoundingBox();
      const box = outgoing.geometry.boundingBox!;
      const data = revealPlane(box.min.z, box.max.z, stage.fraction);
      slice = new THREE.Plane(new THREE.Vector3(0, 0, -1), data.constant);
    }
    const visible = (kind: AnatomyPlane) => stage
      ? kind === stage.to || kind === stage.from && stage.fraction < 1
        || kind === 'vessels' && current.referenceLayers.vessels.visible && (stage.to === 'muscle' || stage.from === 'muscle' && stage.fraction < 1)
      : kind === 'skin' ? current.layers.skin.visible : current.referenceLayers[kind].visible;
    const clips = (kind: AnatomyPlane) => stage
      ? kind === stage.from || kind === 'vessels' && stage.from === 'muscle' ? slice ? [slice] : [] : []
      : freePlane && (current.cut.scope === 'all' || kind === 'skin') ? [freePlane] : [];
    // El desvelado por profundidad responde al slider sin retardo; fuera de él, cambiar de capa es un morph.
    const instant = reduceMotion || Boolean(stage);
    const k = instant ? 1 : 1 - Math.exp(-(animating ? Math.max(0, time - lastStep) : 16) / 90);
    lastStep = time;
    let busy = false;
    type ReferenceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const entries = referenceGroup.children.filter((object): object is ReferenceMesh => object instanceof THREE.Mesh).map(object => {
      const kind = object.userData.kind as ReferenceKind;
      const motion = layerMotion.get(kind) ?? {};
      layerMotion.set(kind, motion);
      const target = visible(kind) ? current.referenceLayers[kind].opacity * (current.references.find(item => item.kind === kind)?.opacity ?? 1) : 0;
      return { object, kind, motion, target, before: motion.shown ?? target };
    });
    const attribute = (object: ReferenceMesh) => object.geometry.getAttribute('position') as THREE.BufferAttribute;
    const place = (object: ReferenceMesh, values: Float32Array) => { (attribute(object).array as Float32Array).set(values); attribute(object).needsUpdate = true; };
    const snapshot = (object: ReferenceMesh) => Float32Array.from(attribute(object).array as Float32Array);
    if (instant) {
      for (const { object, motion } of entries) if (motion.morph || motion.displaced) {
        place(object, object.userData.target); motion.morph = undefined; motion.displaced = false;
      }
    } else {
      const entering = entries.filter(entry => entry.before < 0.05 && entry.target > 0.05);
      const outgoing = entries.filter(entry => entry.before > 0.05 && entry.target <= 0.05).sort((a, b) => b.before - a.before);
      const sameSize = (a: ReferenceMesh, b: ReferenceMesh) => attribute(a).array.length === attribute(b).array.length;
      for (const entry of entries) {
        const { object, motion } = entry;
        if (entering.includes(entry)) {
          // Nace de la capa saliente o, si venía la piel, de la superficie cutánea y se hunde hasta su plano.
          const donor = outgoing.find(other => sameSize(other.object, object));
          motion.morph = { from: donor ? snapshot(donor.object) : object.userData.surface, to: object.userData.target, start: time };
        } else if (entry.target > 0.05 && (motion.displaced || motion.morph && motion.morph.to !== object.userData.target)) {
          motion.morph = { from: snapshot(object), to: object.userData.target, start: time };
        }
      }
      for (const { object, motion } of outgoing) {
        // La saliente acompaña a la entrante o, al volver a piel, asciende hasta la superficie.
        const into = entering.find(other => sameSize(other.object, object))?.object.userData.target as Float32Array | undefined;
        const restart = into ? motion.morph?.to !== into : !motion.displaced && (!motion.morph || motion.morph.to === object.userData.target);
        if (restart) motion.morph = { from: snapshot(object), to: into ?? object.userData.surface, start: time };
      }
    }
    for (const { object, kind, motion, target, before } of entries) {
      let shown = before + (target - before) * k;
      if (Math.abs(target - shown) < 0.004) shown = target; else busy = true;
      motion.shown = shown;
      object.material.opacity = shown;
      object.visible = shown > 0.004;
      if (motion.morph) {
        const t = Math.min(1, Math.max(0, time - motion.morph.start) / 520);
        const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
        const array = attribute(object).array as Float32Array, { from, to } = motion.morph;
        for (let i = 0; i < array.length; i++) array[i] = from[i] + (to[i] - from[i]) * eased;
        attribute(object).needsUpdate = true;
        if (t >= 1) { motion.displaced = to !== object.userData.target; motion.morph = undefined; } else busy = true;
      }
      if (!motion.morph && motion.displaced && !object.visible) { place(object, object.userData.target); motion.displaced = false; }
      object.material.depthTest = stage ? true : !current.overlay;
      object.renderOrder = !stage && current.overlay ? 7 : kind === 'bone' ? 1 : kind === 'muscle' ? 2 : 3;
      object.material.clippingPlanes = clips(kind);
    }
    const skinTarget = visible('skin') ? current.layers.skin.opacity : 0;
    let skinOpacity = (skinShown ?? skinTarget) + (skinTarget - (skinShown ?? skinTarget)) * k;
    if (Math.abs(skinTarget - skinOpacity) < 0.004) skinOpacity = skinTarget; else busy = true;
    skinShown = skinOpacity;
    const skin = afterMeshes.get('skin');
    if (skin) {
      skin.visible = skinOpacity > 0.004;
      for (const material of skin.material) { setOpacity(material, skinOpacity); material.clippingPlanes = clips('skin'); }
    }
    photoGroup.visible = skinOpacity > 0.004;
    for (const object of photoGroup.children) if (object instanceof THREE.Mesh) {
      setOpacity(object.material, skinOpacity, object.userData.blended); object.material.clippingPlanes = clips('skin');
    }
    regionMaterial.clippingPlanes = highlightMaterial.clippingPlanes = clips(current.anatomy);
    regionMaterial.depthTest = highlightMaterial.depthTest = current.anatomy !== 'skin' && !current.overlay;
    regionOverlay.visible = current.showMesh && visible(current.anatomy) && current.comparison !== 'before'
      && !(current.anatomy !== 'skin' && layerMotion.get(current.anatomy)?.morph);
    highlight.visible = regionOverlay.visible;
    animating = busy;
    return busy;
  };
  const render = (time = performance.now()) => {
    frame = 0;
    if (disposed || failed || !state) return;
    try {
      const busy = applyAnatomy(state, time);
      renderer.setScissorTest(true);
      if (state.comparison === 'split') {
        const half = Math.floor(viewportWidth / 2);
        drawView(0, half, before); drawView(half, viewportWidth - half, after);
      } else drawView(0, viewportWidth, state.comparison === 'before' ? before : after);
      renderer.setScissorTest(false);
      if (!announcedReady) { announcedReady = true; canvas.dataset.ready = 'true'; onReady(); }
      if (busy) requestRender();
    } catch (cause) {
      failed = true;
      console.error('[FacialSimulationViewer] Render', cause);
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
    canvas.removeEventListener('pointerdown', pointerDown);
    canvas.removeEventListener('pointerup', pointerUp);
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
      const side = mesh.source === 'personal' && mesh.observedIndexCount === undefined ? THREE.FrontSide : THREE.DoubleSide;
      const material: SurfaceMaterial = texture ? new THREE.MeshBasicMaterial({
        map: texture, side, transparent: true, depthWrite: false,
      }) : new THREE.MeshStandardMaterial({
        color: layer.color,
        vertexColors: Boolean(data.colors),
        side, roughness: 0.8, transparent: true, depthWrite: false,
      });
      const materials = [material];
      if (layer.id === 'skin' && mesh.observedIndexCount !== undefined) materials.push(inferredMaterial(mesh, { transparent: true, depthWrite: false }));
      const object = new THREE.Mesh(geometryFrom(data, mesh), materials);
      object.name = 'MORPHOLOGY_SKIN_AFTER';
      object.renderOrder = 5;
      after.add(object); afterMeshes.set(layer.id, object);
    }
    const skin = neutral.find(item => item.id === 'skin')!;
    const beforeSide = mesh.source === 'personal' && mesh.observedIndexCount === undefined ? THREE.FrontSide : THREE.DoubleSide;
    const beforeMaterials: SurfaceMaterial[] = [texture ? new THREE.MeshBasicMaterial({ map: texture, side: beforeSide }) : new THREE.MeshStandardMaterial({
      color: texture ? '#ffffff' : SIMULATION_LAYERS[0].color, map: texture,
      roughness: 0.8, side: beforeSide,
    })];
    if (mesh.observedIndexCount !== undefined) beforeMaterials.push(inferredMaterial(mesh));
    beforeMesh = new THREE.Mesh(geometryFrom(skin, mesh), beforeMaterials);
    beforeMesh.name = 'MORPHOLOGY_SKIN_BEFORE';
    before.add(beforeMesh);
    if (mesh.source === 'personal' && mesh.observedIndexCount === undefined) {
      const material = new THREE.MeshStandardMaterial({ color: '#475569', roughness: 1, side: THREE.DoubleSide });
      afterBacking = new THREE.Mesh(backingGeometry(mesh.positions), material);
      beforeBacking = new THREE.Mesh(backingGeometry(mesh.positions), material.clone());
      afterBacking.name = beforeBacking.name = 'MASK_NEUTRAL_BACKING';
      after.add(afterBacking); before.add(beforeBacking);
    }
    controls.addEventListener('change', requestRender);
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('keydown', keyboard);
    canvas.addEventListener('pointermove', hover);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointerup', pointerUp);
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
      const parametersChanged = next.parameters !== lastParameters;
      if (parametersChanged) {
        morphologyPositions = deformPositions(mesh.positions, mesh.anchors, next.parameters);
        morphologyNormals = undefined;
      }
      const geometryChanged = parametersChanged || next.skinRegions !== lastSkinRegions;
      if (geometryChanged) {
        const hasRelief = mesh.uvs && next.skinRegions.some(region => region.verified && region.adjustments.relief !== 0);
        if (hasRelief && mesh.uvs) {
          morphologyNormals ??= vertexNormals(morphologyPositions, mesh.indices);
          deformedPositions = applySkinRegionRelief(morphologyPositions, mesh.uvs, next.skinRegions, morphologyNormals);
        } else deformedPositions = morphologyPositions;
      }
      const referencesChanged = previousReferences !== next.references;
      const needsReferences = next.anatomy !== 'skin' || Boolean(revealStage(next.reveal))
        || Object.values(next.referenceLayers).some(layer => layer.visible && layer.opacity > 0);
      if (needsReferences && (referencesChanged || next.parameters !== referenceParameters)) {
        for (const object of [...referenceGroup.children]) {
          if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
          referenceGroup.remove(object);
        }
        // Textura con margen cacheada por canvas: mover un slider de morfología solo rehace la geometría.
        const liveCanvases = new Set(next.references.map(reference => reference.canvas));
        for (const [canvas, cached] of referenceTextures) if (!liveCanvases.has(canvas)) { cached.dispose(); referenceTextures.delete(canvas); }
        if (next.references.length) {
          const positions = mesh.source === 'personal' ? morphologyPositions : deformPositions(mesh.anchors, mesh.anchors, next.parameters);
          const observedIndices = mesh.source === 'personal' ? mesh.indices.slice(0, mesh.observedIndexCount ?? mesh.indices.length) : Uint32Array.from(atlas.triangles);
          const sourceReference = mesh.source === 'personal' ? buildSimulationReferenceSurface(sourceMesh, next.parameters) : null;
          next.references.forEach(reference => {
            let map = referenceTextures.get(reference.canvas);
            if (!map) {
              const padded = document.createElement('canvas');
              padded.width = reference.canvas.width + 4; padded.height = reference.canvas.height + 4;
              const context = padded.getContext('2d');
              if (!context) throw new Error('No se pudo preparar la referencia anatómica.');
              context.drawImage(reference.canvas, 2, 2);
              map = new THREE.CanvasTexture(padded);
              map.flipY = false; map.colorSpace = THREE.SRGBColorSpace; referenceTextures.set(reference.canvas, map);
            }
            const padded = { width: reference.canvas.width + 4, height: reference.canvas.height + 4 };
            const data = buildReferenceGeometry(positions, observedIndices, reference);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
            const uvs = Float32Array.from(reference.uvs, (value, i) => i % 2
              ? (value * reference.canvas.height + 2) / padded.height : (value * reference.canvas.width + 2) / padded.width);
            geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            geometry.computeBoundingSphere();
            const material = new THREE.MeshBasicMaterial({ map, side: THREE.FrontSide, transparent: true, opacity: 1, alphaTest: 0.01, depthWrite: false });
            material.onBeforeCompile = shader => {
              shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
                '#ifdef USE_MAP\nif (any(lessThan(vMapUv, vec2(0.0))) || any(greaterThan(vMapUv, vec2(1.0)))) discard;\n#endif\n#include <map_fragment>');
            };
            const object = new THREE.Mesh(geometry, material);
            object.name = 'ALIGNED_ANATOMICAL_REFERENCE'; object.renderOrder = 3;
            const semanticIndices = sourceReference ? buildReferenceGeometry(sourceReference.positions, sourceReference.indices,
              { ...reference, uvs: reference.uvs.slice(0, sourceReference.positions.length / 3 * 2) }).indices : data.indices;
            object.userData = { kind: reference.kind, semanticIndices, surface: positions, target: data.positions.slice() };
            const motion = layerMotion.get(reference.kind);
            // Geometría nueva (slider de morfología): el morph en curso ya no aplica a estos vértices.
            if (motion) { motion.morph = undefined; motion.displaced = false; }
            referenceGroup.add(object);
          });
        }
        previousReferences = next.references;
        referenceParameters = next.parameters;
      }
      if (previousSignal !== next.skinTexture) {
        if (next.skinTexture) {
          if (signalTexture) { signalTexture.image = next.skinTexture; signalTexture.needsUpdate = true; }
          else {
            signalTexture = new THREE.CanvasTexture(next.skinTexture);
            signalTexture.flipY = false; signalTexture.colorSpace = THREE.SRGBColorSpace;
          }
        } else { signalTexture?.dispose(); signalTexture = undefined; }
        const material = afterMeshes.get('skin')?.material[0];
        if (material) {
          const map = signalTexture ?? texture ?? null;
          if (Boolean(material.map) !== Boolean(map)) material.needsUpdate = true;
          material.map = map;
        }
        previousSignal = next.skinTexture;
      }
      const photoPatchesChanged = previousPhotoPatches !== next.photoPatches;
      if (photoPatchesChanged) {
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
      }
      if (geometryChanged) {
        const geometry = afterMeshes.get('skin')!.geometry;
        (geometry.getAttribute('position').array as Float32Array).set(deformedPositions);
        geometry.getAttribute('position').needsUpdate = true;
        geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      }
      if (geometryChanged || photoPatchesChanged) {
        for (const object of photoGroup.children) if (object instanceof THREE.Mesh) {
          (object.geometry.getAttribute('position').array as Float32Array).set(deformedPositions);
          object.geometry.getAttribute('position').needsUpdate = true;
          object.geometry.computeBoundingSphere();
        }
      }
      if (afterBacking && (geometryChanged || referencesChanged && needsReferences)) {
        const thickness = Math.max(0.11, ...next.references.map(reference => reference.depth + 0.025));
        afterBacking.geometry.dispose();
        afterBacking.geometry = backingGeometry(deformedPositions, thickness);
      }
      if (next.showMesh && (!regionState || regionState.parameters !== next.parameters || regionState.anatomy !== next.anatomy
        || regionState.plane !== next.plane || regionState.references !== next.references || regionState.marks !== next.marks)) {
        const referenceObject = referenceGroup.children.find(object => object.userData.kind === next.anatomy);
        const retained: Uint32Array | undefined = referenceObject?.userData.semanticIndices;
        const triangles = retained ? new Set(Array.from({ length: retained.length / 3 }, (_, i) =>
          triangleKey(retained[i * 3], retained[i * 3 + 1], retained[i * 3 + 2]))) : null;
        activeCells = next.anatomy === 'skin' ? regionCells : getAnatomyCells().filter(cell => {
          const ids = atlas.triangles.slice(cell.triangle * 3, cell.triangle * 3 + 3);
          return triangles?.has(triangleKey(ids[0], ids[1], ids[2])) ?? false;
        });
        const deformed = deformPositions(mesh.anchors, mesh.anchors, next.parameters);
        const reference = next.references.find(item => item.kind === next.anatomy);
        const referenceMesh = referenceGroup.children.find(object => object.userData.kind === next.anatomy);
        const plane = referenceMesh instanceof THREE.Mesh
          ? referenceMesh.userData.target as Float32Array
          : regionPlanePositions(deformed, atlas.triangles, next.plane);
        cellLabels = activeCells.map(cell => {
          if (next.anatomy === 'skin') return cell.label;
          if (!reference?.zones) return null;
          const ids = atlas.triangles.slice(cell.triangle * 3, cell.triangle * 3 + 3);
          const uv = [0, 1].map(axis => cell.corners.reduce((sum, weights) =>
            sum + ids.reduce((value, id, j) => value + reference.uvs[id * 2 + axis] * weights[j], 0) / 3, 0));
          return anatomicalZoneAt(reference.zones, uv[0], uv[1]);
        });
        const positions: number[] = [], colors: number[] = [];
        for (const [i, cell] of activeCells.entries()) {
          positions.push(...regionCellPositions(cell, atlas.triangles, plane));
          const color = new THREE.Color(next.marks.includes(`${next.anatomy}:${cellLabels[i]}`) ? '#fbbf24'
            : next.anatomy === 'skin' ? faceRegionColor(cell.label) : cellLabels[i] ? '#67e8f9' : '#334155');
          for (let j = 0; j < 3; j++) colors.push(color.r, color.g, color.b);
        }
        regionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        regionGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        regionGeometry.computeBoundingSphere();
        regionState = next;
      }
      const highlighted = next.showMesh ? next.selection ?? (pointerInside && previousAnatomy === next.anatomy ? selectedZone : null) : null;
      selectZone(highlighted, next.showMesh && regionState === next);
      previousAnatomy = next.anatomy;
      lastParameters = next.parameters;
      lastSkinRegions = next.skinRegions;
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
export function FacialSimulationViewer({ surface, photo, showMesh, plane, onMeshChange, onPlaneChange, hair = DEFAULT_HAIR, hairPatches, photoPatches, anatomyDisplay, onAnatomyDisplayChange }: FacialSimulationViewerProps) {
  const id = useId(), host = useRef<HTMLDivElement>(null), runtime = useRef<ViewerRuntime | null>(null);
  const inspector = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLElement>(null);
  // Escritorio: el editor ocupa la pantalla al abrirse (visor + inspector visibles sin desplazar la página).
  useEffect(() => {
    if (window.matchMedia?.('(min-width: 1024px)').matches) editor.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, []);
  const [tool, setTool] = useState<InspectorTool>('morphology');
  const [skinOpened, setSkinOpened] = useState(false);
  const [referenceEditorOpened, setReferenceEditorOpened] = useState(false);
  const [skinReviewVersion, setSkinReviewVersion] = useState(0);
  const [parameters, setParameters] = useState<SimulationParameters>({ ...NEUTRAL_SIMULATION });
  const [symmetryDirection, setSymmetryDirection] = useState<1 | -1>(1);
  const [localDisplay, setLocalDisplay] = useState(initialAnatomyDisplay);
  const lastEmittedDisplay = useRef<AnatomyDisplayState>();
  const display = anatomyDisplay ?? localDisplay;
  const changeDisplay = useCallback((value: AnatomyDisplayState) => {
    lastEmittedDisplay.current = value;
    if (anatomyDisplay === undefined) setLocalDisplay(value);
    onAnatomyDisplayChange?.(value);
  }, [anatomyDisplay, onAnatomyDisplayChange]);
  const { anatomy, references: referenceLayers, overlay } = display;
  const layers = useMemo<LayerSettings>(() => ({ skin: display.skin }), [display.skin]);
  const [cut, setCut] = useState<SimulationCut>({ ...INITIAL_CUT });
  const [view, setView] = useState<View>('orbit');
  const [comparison, setComparison] = useState<Comparison>('after');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [attempt, setAttempt] = useState(0);
  const [localMesh, setLocalMesh] = useState(false);
  const [localPlane, setLocalPlane] = useState<RegionPlane>('superficial');
  const [hoveredZone, setHoveredZone] = useState<string | null>(null);
  const [signal, setSignal] = useState<{ source: HTMLCanvasElement; canvas: HTMLCanvasElement }>();
  const [skinReview, setSkinReview] = useState<{ source: HTMLCanvasElement; regions: readonly SkinReviewRegion[] }>();
  const [cosmetics, setCosmetics] = useState<SkinCosmeticParameters>({ ...NEUTRAL_SKIN_COSMETICS });
  const [cosmeticTexture, setCosmeticTexture] = useState<{ source: HTMLCanvasElement; canvas: HTMLCanvasElement }>();
  const [cosmeticError, setCosmeticError] = useState<string | null>(null);
  const [cosmeticPending, setCosmeticPending] = useState(false);
  const referenceUVs = surface?.uvs ?? genericReferenceUVs;
  const [customReference, setCustomReference] = useState<{ uvs: Float32Array; reference: AnatomicalReference }>();
  const [defaultReferences, setDefaultReferences] = useState<{ uvs: Float32Array; attempt: number; references: AnatomicalReference[] }>();
  const [reveal, setReveal] = useState<MaskReveal>({ ...INITIAL_REVEAL });
  useEffect(() => {
    if (anatomyDisplay && anatomyDisplay !== lastEmittedDisplay.current) {
      setReveal({ ...INITIAL_REVEAL }); setCut({ ...INITIAL_CUT }); setSelection(null);
    }
  }, [anatomyDisplay]);
  const [selection, setSelection] = useState<string | null>(null);
  const [marks, setMarks] = useState<string[]>([]);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [referenceAttempt, setReferenceAttempt] = useState(0);
  const needsReferences = anatomy !== 'skin' || tool === 'layers' || tool === 'cut'
    || Object.values(referenceLayers).some(layer => layer.visible && layer.opacity > 0);
  useEffect(() => {
    if (!needsReferences || defaultReferences?.uvs === referenceUVs && defaultReferences.attempt === referenceAttempt) return;
    setReferenceError(null); setSelection(null);
    let live = true;
    loadDefaultLayers().then(layers => {
      if (live) setDefaultReferences({ uvs: referenceUVs, attempt: referenceAttempt, references: registerLayers(layers, referenceUVs) });
    }).catch(cause => {
      if (live) setReferenceError(cause instanceof Error ? cause.message : 'No se pudieron cargar las referencias anatómicas.');
    });
    return () => { live = false; };
  }, [referenceUVs, referenceAttempt, needsReferences, defaultReferences]);
  const references = useMemo(() => {
    // No entrega UV de una superficie anterior al renderer mientras se registra la nueva.
    const defaults = defaultReferences?.uvs === referenceUVs ? defaultReferences.references : [];
    const custom = customReference?.uvs === referenceUVs ? customReference.reference : undefined;
    return custom ? [...defaults.filter(item => item.kind !== custom.kind), custom] : defaults;
  }, [defaultReferences, customReference, referenceUVs]);
  const onReference = useCallback((value: AnatomicalReference | undefined) => {
    setCustomReference(value ? { uvs: referenceUVs, reference: value } : undefined);
    if (value) {
      setSelection(null);
      setReveal({ ...INITIAL_REVEAL }); setCut({ ...INITIAL_CUT });
      setMarks(current => current.filter(mark => !mark.startsWith(`${value.kind}:`)));
      changeDisplay({
        ...display, anatomy: value.kind, skin: { visible: true, opacity: 0.15 },
        references: { ...display.references, [value.kind]: { ...display.references[value.kind], visible: true } },
      });
    }
  }, [display, changeDisplay, referenceUVs]);
  const onSignalTexture = useCallback((canvas: HTMLCanvasElement | undefined) => {
    setSignal(photo && canvas ? { source: photo, canvas } : undefined);
    setCosmetics(current => Object.values(current).some(value => value !== 0) ? { ...NEUTRAL_SKIN_COSMETICS } : current);
    setCosmeticTexture(undefined);
  }, [photo]);
  const onSkinRegions = useCallback((regions: readonly SkinReviewRegion[]) => {
    setSkinReview(photo ? { source: photo, regions } : undefined);
  }, [photo]);
  const skinRegions = skinReview?.source === photo ? skinReview?.regions ?? EMPTY_SKIN_REGIONS : EMPTY_SKIN_REGIONS;
  const signalTexture = signal?.source === photo ? signal?.canvas : undefined;
  const skinTexture = signalTexture ?? (cosmeticTexture?.source === photo ? cosmeticTexture?.canvas : undefined);
  const signalLandmarks = useMemo(() => surface
    ? Array.from({ length: 468 }, (_, i) => ({ x: surface.uvs[i * 2], y: surface.uvs[i * 2 + 1] })) : undefined, [surface]);
  useEffect(() => {
    setCosmeticError(null);
    if (!photo || !signalLandmarks || Object.values(cosmetics).every(value => value === 0)) {
      setCosmeticTexture(undefined);
      setCosmeticPending(false);
      return;
    }
    setCosmeticPending(true);
    const frame = requestAnimationFrame(() => {
      try { setCosmeticTexture({ source: photo, canvas: composeSkinCosmeticTexture(photo, signalLandmarks, cosmetics) }); }
      catch (cause) { console.error('[FacialSimulationViewer] Retoque', cause); setCosmeticError('No se pudo retocar la foto. Comprueba la imagen y las referencias faciales; el original se conserva.'); }
      finally { setCosmeticPending(false); }
    });
    return () => cancelAnimationFrame(frame);
  }, [photo, signalLandmarks, cosmetics]);
  const activePlane = plane ?? localPlane, meshVisible = showMesh ?? localMesh;
  const [preparedState, setPreparedState] = useState<{ source: typeof surface; value: PreparedSimulation }>();
  const prepared = preparedState && preparedState.source === surface ? preparedState.value : EMPTY_PREPARED;
  useEffect(() => {
    setReady(false);
    // Dos frames permiten pintar el indicador antes del trabajo de geometría.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      try {
        const base = createSimulationMesh(surface), refinement = refineDisplaySurface(base.positions, base.indices);
        const mesh: SimulationMesh = { ...base, positions: refinement.positions, indices: refinement.indices,
          uvs: base.uvs && refinement.attribute(base.uvs, 2),
          observedIndexCount: base.observedIndexCount === undefined ? undefined : base.observedIndexCount * refinement.indexMultiplier };
        setPreparedState({ source: surface, value: { mesh, sourceMesh: base, refinement, error: null } });
      } catch (cause) {
        console.error('[FacialSimulationViewer] Geometría', cause);
        setPreparedState({ source: surface, value: { ...EMPTY_PREPARED, error: cause instanceof Error ? cause.message : 'Superficie no válida.' } });
      }
    }); });
    return () => cancelAnimationFrame(frame);
  }, [surface]);
  const displayReferences = useMemo(() => prepared.mesh?.source === 'personal' && prepared.refinement
    ? references.map(reference => ({ ...reference, uvs: prepared.refinement!.attribute(reference.uvs, 2) }))
    : references, [prepared, references]);
  const displayHair = useMemo(() => prepared.refinement && hairPatches?.map(patch => ({ ...patch,
    indices: prepared.refinement!.indicesFor(patch.indices), uvs: prepared.refinement!.attribute(patch.uvs, 2),
  })), [prepared, hairPatches]);
  const displayPhotos = useMemo(() => prepared.refinement && photoPatches?.map(patch => ({ ...patch,
    indices: prepared.refinement!.indicesFor(patch.indices), uvs: prepared.refinement!.attribute(patch.uvs, 2),
    blendIndices: patch.blendIndices && prepared.refinement!.indicesFor(patch.blendIndices),
    alpha: patch.alpha && prepared.refinement!.attribute(patch.alpha, 1),
  })), [prepared, photoPatches]);
  const state = useMemo<ViewerState>(() => ({ parameters, layers, cut, view, comparison, showMesh: meshVisible, plane: activePlane, hair,
    hairPatches: displayHair ?? undefined, photoPatches: displayPhotos ?? undefined, skinTexture, skinRegions, references: displayReferences, anatomy,
    referenceLayers, overlay, reveal, selection, marks }),
    [parameters, layers, cut, view, comparison, meshVisible, activePlane, hair, displayHair, displayPhotos, skinTexture, skinRegions, displayReferences, anatomy, referenceLayers, overlay, reveal, selection, marks]);

  useEffect(() => {
    setError(null); setReady(false);
    if (!host.current || !prepared.mesh || !prepared.sourceMesh) return;
    try {
      runtime.current = mountFacialSimulation(host.current, prepared.mesh, prepared.sourceMesh, photo,
        message => { setError(message); setReady(false); }, setHoveredZone, setSelection, () => setReady(true));
    } catch (cause) {
      console.error('[FacialSimulationViewer] Inicio', cause);
      setError('No se pudo iniciar WebGL. Comprueba la aceleración gráfica del navegador.');
    }
    return () => { runtime.current?.dispose(); runtime.current = null; };
  }, [prepared, photo, attempt]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try { runtime.current?.update(state); }
      catch (cause) { console.error('[FacialSimulationViewer] Actualización', cause); setError('No se pudo actualizar la simulación 3D. Reinicia el visor.'); setReady(false); }
    });
    return () => cancelAnimationFrame(frame);
  }, [state, prepared, photo, attempt]);

  const reset = () => {
    setParameters({ ...NEUTRAL_SIMULATION }); setSymmetryDirection(1); changeDisplay(initialAnatomyDisplay());
    setCosmetics({ ...NEUTRAL_SKIN_COSMETICS }); setCosmeticTexture(undefined); setSignal(undefined);
    setSkinReview(undefined);
    setSkinReviewVersion(value => value + 1);
    setCut({ ...INITIAL_CUT }); setView('front'); setComparison('after');
    setReveal({ ...INITIAL_REVEAL }); setSelection(null); setMarks([]);
    if (onPlaneChange) onPlaneChange('superficial'); else setLocalPlane('superficial');
    setHoveredZone(null);
    if (error) setAttempt(value => value + 1);
  };
  const failure = prepared.error || error;
  const chooseAnatomy = (kind: AnatomyPlane) => {
    changeDisplay(chooseAnatomyDisplay(display, kind));
    setSelection(null); setReveal({ ...INITIAL_REVEAL }); setCut({ ...INITIAL_CUT });
    if (onMeshChange) onMeshChange(true); else setLocalMesh(true);
  };
  const zones = anatomy === 'skin' ? [...new Set(regionCells.map(cell => cell.label))]
    : references.find(reference => reference.kind === anatomy)?.zones?.map(zone => zone.label) ?? [];
  const stage = revealStage(reveal);

  return (
    <section ref={editor} aria-labelledby={`${id}-title`} data-face-editor className={`${editorPanel} flex min-w-0 scroll-mt-2 flex-col gap-3 p-3 text-stone-100 lg:sticky lg:top-2 lg:h-[calc(100dvh-5rem)] lg:min-h-[560px]`}>
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="text-sm font-semibold text-gold">Simulación morfológica 3D</h2>
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
            <div ref={host} data-simulation-viewport data-ready={ready} aria-busy={!ready && !failure} className="h-[46dvh] min-h-64 w-full lg:h-full" />
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
            ) : !ready ? <div role="status" aria-live="polite" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-950/90 p-6 text-center text-sm">
              <span aria-hidden="true" className="h-9 w-9 animate-spin rounded-full border-2 border-gold/20 border-t-gold motion-reduce:animate-none" />
              <strong className="text-gold">{prepared.mesh ? 'Preparando primer render…' : 'Preparando geometría 3D…'}</strong>
              <span className="text-xs text-stone-400">El indicador desaparece cuando el modelo se ha dibujado.</span>
            </div> : null}
          </div>
          <p role="status" className="min-h-5 truncate text-xs font-semibold text-gold">{hoveredZone ? `${selection ? 'Selección fija' : 'Zona de referencia'}: ${hoveredZone}` : meshVisible ? 'Cursor resalta · clic fija la zona ilustrativa' : prepared.mesh?.source === 'personal' ? 'Máscara facial aproximada' : 'Cabeza genérica de referencia'}</p>
          {referenceError ? <div role="alert" className="text-xs text-amber-200">
            <p>{referenceError}</p><button type="button" className={buttonClass} onClick={() => setReferenceAttempt(value => value + 1)}>Reintentar referencias</button>
          </div> : needsReferences && (!references.length || anatomy !== 'skin' && !references.some(reference => reference.kind === anatomy))
            ? <p role="status" className="text-xs text-slate-300">Preparando referencias ilustrativas sobre {surface ? 'la superficie facial' : 'el modelo genérico'}…</p> : null}
          <p id={`${id}-help`} className="text-[11px] text-slate-400">Arrastra o usa las flechas para girar · rueda, pinza o +/− para zoom. «Antes» conserva el original.</p>
          <details className="shrink-0 text-xs text-slate-400"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-cyan-300">Límites · no es un escaneo ni una predicción clínica</summary>
            <p className="max-h-24 overflow-y-auto py-2">La máscara conserva una profundidad aproximada. El reverso es un cierre mate, no una cabeza reconstruida. Músculos, arterias y huesos son ilustraciones genéricas: sus zonas están autoradas sobre las imágenes, no detectadas en el paciente. Corte y separación son visuales, no espesores anatómicos ni planos de inyección. No predice tratamientos ni diagnostica lesiones.</p>
          </details>
        </div>
        <aside aria-label="Inspector de simulación" className="flex min-h-0 min-w-0 flex-col rounded-xl border border-white/10 bg-black/30">
          <nav aria-label="Herramientas de simulación" className="grid shrink-0 grid-cols-2 gap-1 border-b border-slate-700 p-2">
            {([['morphology', 'Morfología'], ['skin', 'Piel'], ['layers', 'Capas'], ['cut', 'Corte']] as const).map(([key, label]) =>
              <button type="button" key={key} aria-pressed={tool === key} aria-controls={`${id}-tool-${key}`}
                className={`${buttonClass} min-h-10`} onClick={() => { setTool(key); if (key === 'skin') setSkinOpened(true); inspector.current?.scrollTo({ top: 0 }); }}>{label}</button>)}
          </nav>
          <div ref={inspector} data-simulation-inspector className="max-h-[48dvh] min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 lg:max-h-none lg:flex-1" aria-describedby={`${id}-help`}>
          <div id={`${id}-tool-morphology`} hidden={tool !== 'morphology'} className="space-y-3">
          <button type="button" className={buttonClass} onClick={() => chooseAnatomy('skin')}>Mostrar superficie</button>
          {SIMULATION_GROUPS.map(group => (
            <fieldset key={group} className="space-y-2 rounded-lg border border-slate-700 p-2">
              <legend className="px-1 text-xs font-semibold">{group}</legend>
              {SIMULATION_CONTROLS.filter(control => control.group === group).map(control => (
                <label key={control.key} className="block text-xs" htmlFor={`${id}-${control.key}`}>
                  <span className="flex justify-between gap-2"><span>{control.label}</span><output>{Math.round(parameters[control.key] * 100)} %</output></span>
                  <input id={`${id}-${control.key}`} type="range" min="-1" max="1" step="0.01" value={parameters[control.key]}
                    aria-valuetext={`${Math.round(parameters[control.key] * 100)} por ciento de intensidad visual`}
                    onChange={event => setParameters(current => ({ ...current, [control.key]: Number(event.target.value) }))}
                    className="mt-1 block w-full accent-gold focus-visible:outline-gold" />
                </label>
              ))}
              {group === 'Nariz' ? <div className="space-y-2 border-t border-slate-700 pt-2">
                <p className="text-[11px] text-slate-400">− reduce / + aumenta · rotación + eleva la punta</p>
                <label className="block text-xs">Simetría nasal · lado de origen del paciente
                  <select className={`${selectClass} mt-1 w-full`} value={symmetryDirection}
                    onChange={event => {
                      const direction = Number(event.target.value) as 1 | -1;
                      setSymmetryDirection(direction);
                      setParameters(current => ({ ...current, noseSymmetry: Math.abs(current.noseSymmetry) * direction }));
                    }}>
                    <option value="1">Derecha → izquierda del paciente</option>
                    <option value="-1">Izquierda → derecha del paciente</option>
                  </select>
                </label>
                <label className="block text-xs">Intensidad de simetría nasal · {Math.round(Math.abs(parameters.noseSymmetry) * 100)} %
                  <input type="range" min="0" max="1" step="0.01" value={Math.abs(parameters.noseSymmetry)}
                    onChange={event => setParameters(current => ({ ...current, noseSymmetry: Number(event.target.value) * symmetryDirection }))}
                    className="block w-full accent-gold focus-visible:outline-gold" />
                </label>
                <div className="flex flex-wrap gap-1">
                  <button type="button" className={buttonClass} onClick={() => setParameters(current => ({ ...current, noseSymmetry: symmetryDirection }))}>Replicar mitad (100 %)</button>
                  <button type="button" className={buttonClass} onClick={() => setParameters(current => ({ ...current, noseSymmetry: 0 }))}>Restaurar simetría</button>
                  <button type="button" className={buttonClass} onClick={() => setParameters(current => ({
                    ...current, ...Object.fromEntries(SIMULATION_CONTROLS.filter(control => control.group === 'Nariz').map(control => [control.key, 0])), noseSymmetry: 0,
                  }))}>Restaurar nariz</button>
                </div>
                <p className="text-[11px] text-slate-400">Replica el hemimallado del lado elegido (alas, altura y relieve denso) sobre el otro, con transición suave en la línea media para evitar costuras. No espeja la foto ni estima un resultado clínico.</p>
              </div> : null}
            </fieldset>
          ))}
          </div>
          <div id={`${id}-tool-skin`} hidden={tool !== 'skin'} className="space-y-3">
              {skinOpened && photo && surface ? <Suspense fallback={<p role="status" className="text-xs text-gold">Preparando revisión por zonas…</p>}>
                <SkinSignalPanel key={skinReviewVersion} canvas={photo} landmarks={signalLandmarks} onTexture={onSignalTexture} onRegionsChange={onSkinRegions} />
              </Suspense> : !photo || !surface ? <p className="text-xs text-amber-200">La revisión por zonas necesita una foto con referencias faciales válidas.</p> : null}
              <details className="rounded-lg border border-white/15 p-2 text-sm">
                <summary className="cursor-pointer text-gold">Retoque global de la piel</summary>
              <fieldset disabled={!photo || !surface || !!signalTexture} aria-describedby={`${id}-cosmetic-help`} className="space-y-3 rounded-lg border border-slate-700 p-2 disabled:opacity-50">
                <legend className="px-1 text-xs font-semibold">Retoque cosmético visual · piel</legend>
                <p id={`${id}-cosmetic-help`} className="text-[11px] text-slate-300">
                  Retoque local de la cara, no del cabello ni del cuello. Intensidad visual, no eficacia clínica; los candidatos RGB se revisan aparte y no identifican lesiones ni eliminan pliegues 3D.
                </p>
                {!photo || !surface ? <p className="text-xs text-amber-200">Necesita una foto con referencias faciales válidas.</p> : null}
                {SKIN_COSMETIC_CONTROLS.map(control => (
                  <label key={control.key} htmlFor={`${id}-cosmetic-${control.key}`} className="block text-xs">
                    <span className="flex justify-between gap-2"><span>{control.label}</span><output>{Math.round(cosmetics[control.key] * 100)}</output></span>
                    <input id={`${id}-cosmetic-${control.key}`} type="range" min={control.min} max="1" step="0.01" value={cosmetics[control.key]}
                      aria-valuetext={`${Math.round(cosmetics[control.key] * 100)} de intensidad visual, no eficacia clínica`}
                      onChange={event => setCosmetics(current => ({ ...current, [control.key]: Number(event.target.value) }))}
                      className="mt-1 block w-full accent-gold focus-visible:outline-gold" />
                  </label>
                ))}
                <button type="button" className={buttonClass} onClick={() => setCosmetics({ ...NEUTRAL_SKIN_COSMETICS })}>Restablecer piel</button>
                <p role="status" className="text-[11px] text-slate-300">
                  {signalTexture ? 'La revisión por zonas o el análisis RGB tiene prioridad. Restablece ese resultado antes de usar el retoque global.'
                    : cosmeticPending ? 'Preparando retoque local…' : '«Antes» conserva la foto original. Retoque local hasta 768 px; no recupera detalle ausente.'}
                </p>
                {cosmeticError ? <p role="alert" className="text-xs text-amber-200">{cosmeticError}</p> : null}
              </fieldset>
              </details>
          </div>
          <div id={`${id}-tool-layers`} hidden={tool !== 'layers'} className="space-y-3">
            <AnatomyLayerControls value={display} showMesh={meshVisible}
              onMeshChange={visible => { if (onMeshChange) onMeshChange(visible); else setLocalMesh(visible); }}
              onChange={value => {
                changeDisplay(value); setSelection(null);
                if (value.anatomy !== anatomy || value.skin !== display.skin && value.references !== display.references
                  || value.overlay !== overlay || value.skin.visible !== display.skin.visible
                  || value.references.muscle.visible !== referenceLayers.muscle.visible
                  || value.references.bone.visible !== referenceLayers.bone.visible) {
                  setReveal({ ...INITIAL_REVEAL }); setCut({ ...INITIAL_CUT });
                }
              }} />
            {reveal.mode !== 'none' ? <p className="text-[11px] text-slate-300">El corte controla los planos visibles. Las opacidades siguen activas; cambiar de capa rápida, visibilidad o superposición vuelve al modo manual.</p> : null}
        {anatomy === 'skin' && SIMULATION_LAYERS.every(layer => !layers[layer.id].visible || layers[layer.id].opacity === 0) && comparison !== 'before'
          ? <p role="status" className="mt-2 text-xs text-amber-200">No hay capas visibles. Activa una capa o restablece el visor.</p> : null}
            <fieldset className="space-y-2 rounded-lg border border-slate-700 p-2">
              <legend className="px-1 text-xs">Zonas de referencia · resaltado ilustrativo</legend>
              <label className="block text-xs">Inspeccionar
                <select className={`${selectClass} mt-1 w-full`} value={anatomy} onChange={event => { changeDisplay({ ...display, anatomy: event.target.value as AnatomyPlane }); setSelection(null); }}>
                  {ANATOMY_PLANES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label className="block text-xs">Seleccionar zona ilustrativa
                <select className={`${selectClass} mt-1 w-full`} value={selection ?? ''} onChange={event => setSelection(event.target.value || null)}>
                  <option value="">Pasar cursor / sin selección fija</option>
                  {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
                </select>
              </label>
              {!zones.length ? <p className="text-xs text-amber-200">Esta imagen no tiene zonas registradas. Una imagen propia no hereda etiquetas de otra ilustración.</p> : null}
              <button type="button" disabled={!selection} className={`${buttonClass} disabled:opacity-40`} onClick={() => {
                if (selection) setMarks(current => [...new Set([...current, `${anatomy}:${selection}`])]);
              }}>Resaltar zona seleccionada</button>
              <button type="button" className={buttonClass} onClick={() => setSelection(null)}>Liberar selección</button>
              <ul className="space-y-1 text-xs">{marks.map(mark => <li key={mark} className="flex items-start justify-between gap-2">
                <span>{mark.slice(mark.indexOf(':') + 1)}</span><button type="button" className={buttonClass} aria-label={`Retirar marca ${mark.slice(mark.indexOf(':') + 1)}`}
                  onClick={() => setMarks(current => current.filter(item => item !== mark))}>Retirar</button>
              </li>)}</ul>
              <p className="text-[11px] text-slate-400">Cursor resalta; clic fija. Estos resaltados no son marcas de inyección y permanecen solo en este visor. Las posiciones vasculares reales varían.</p>
            </fieldset>
            {surface && <details className="rounded-lg border border-slate-600 p-2 text-sm" onToggle={event => {
              if (event.currentTarget.open) setReferenceEditorOpened(true);
            }}>
              <summary className="cursor-pointer">Reemplazar capa · imagen propia</summary>
              {referenceEditorOpened && <Suspense fallback={<p role="status">Preparando alineación…</p>}>
                <AnatomicalReferencePanel surfaceUVs={surface.uvs} onChange={onReference} />
              </Suspense>}
            </details>}
          </div>
          <div id={`${id}-tool-cut`} hidden={tool !== 'cut'}>
            <fieldset className="mb-3 space-y-3 rounded-lg border border-slate-700 p-2">
              <legend className="px-1 text-xs">Descubrir referencias desde la punta nasal</legend>
              <label className="block text-xs">Modo de corte
                <select className={`${selectClass} mt-1 w-full`} value={reveal.mode} disabled={!references.some(item => item.kind === 'muscle') || !references.some(item => item.kind === 'bone')}
                  onChange={event => {
                    setReveal(current => ({ ...current, mode: event.target.value as MaskReveal['mode'], progress: 0 }));
                    setCut({ ...INITIAL_CUT }); changeDisplay({ ...display, skin: initialAnatomyDisplay().skin, overlay: false, anatomy: 'muscle' }); setSelection(null);
                  }}>
                  <option value="none">Sin desvelado</option><option value="progressive">Progresivo: piel → músculo → hueso</option><option value="compare">Comparar dos capas</option>
                </select>
              </label>
              {reveal.mode === 'compare' ? <div className="grid gap-2">
                <label className="text-xs">Retirar
                  <select className={`${selectClass} ml-2`} value={reveal.from} onChange={event => setReveal(current => ({
                    ...current, from: event.target.value as MaskReveal['from'], to: event.target.value === 'muscle' ? 'bone' : current.to,
                  }))}><option value="skin">Piel</option><option value="muscle">Músculo</option></select>
                </label>
                <label className="text-xs">Revelar
                  <select className={`${selectClass} ml-2`} value={reveal.to} onChange={event => { setReveal(current => ({ ...current, to: event.target.value as MaskReveal['to'] })); changeDisplay({ ...display, anatomy: event.target.value as AnatomyPlane }); }}>
                    {reveal.from === 'skin' ? <option value="muscle">Músculo</option> : null}<option value="bone">Hueso</option>
                  </select>
                </label>
              </div> : null}
              <label className="block text-xs">Avance desde punta nasal · {Math.round(reveal.progress * 100)} %
                <input type="range" min="0" max="1" step="0.005" disabled={reveal.mode === 'none'} value={reveal.progress}
                  onChange={event => {
                    const value = Number(event.target.value), next = { ...reveal, progress: value };
                    setReveal(next); changeDisplay({ ...display, anatomy: revealStage(next)?.to ?? 'skin' }); setSelection(null);
                  }} className="block w-full accent-cyan-400" />
              </label>
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={referenceLayers.vessels.visible}
                onChange={event => changeDisplay({ ...display, references: { ...display.references, vessels: { ...display.references.vessels, visible: event.target.checked } } })} />Arterias sobre la referencia muscular</label>
              <p role="status" className="text-xs text-slate-300">{stage ? `${ANATOMY_PLANES.find(item => item.id === stage.from)?.label} → ${ANATOMY_PLANES.find(item => item.id === stage.to)?.label}` : 'Máscara sin desvelado progresivo.'}</p>
              <p className="text-[11px] text-amber-200">Planos ilustrativos separados visualmente, no anatomía individual ni espesores medidos. Las arterias no forman un estrato uniforme.</p>
            </fieldset>
            <details className="rounded-lg border border-slate-700 p-2"><summary className="cursor-pointer text-xs">Corte libre avanzado</summary>
      <fieldset className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 p-2">
        <legend className="px-1 text-xs font-semibold">Plano de recorte libre</legend>
        <label className="flex items-center gap-2 text-xs">Aplicar a
          <select className={selectClass} value={cut.scope} onChange={event => { setReveal({ ...INITIAL_REVEAL }); setCut(current => ({ ...current, scope: event.target.value as SimulationCut['scope'] })); }}>
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
            </details>
          </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

export default FacialSimulationViewer;
