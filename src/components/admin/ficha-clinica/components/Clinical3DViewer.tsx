import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import {
  Loader2, AlertCircle, Upload
} from 'lucide-react';
import type { ReferenceLine, LineType } from './ReferenceLinePanel';
export type { ReferenceLine, LineType };

// ==========================================
// TIPOS COMPARTIDOS
// ==========================================

export const PATHOLOGIES = [
  { id: 'botox', name: 'Toxina Botulínica', color: '#06b6d4' },
  { id: 'filler', name: 'Relleno Dérmico', color: '#8b5cf6' },
  { id: 'thread', name: 'Hilos Tensores', color: '#f59e0b' },
  { id: 'melasma', name: 'Melasma / Pigmentación', color: '#10b981' },
  { id: 'acnescar', name: 'Cicatrices de Acné', color: '#ef4444' },
  { id: 'lesion', name: 'Lesión Cutánea', color: '#deb887' },
];

export type MarkerType = 'Puntual' | 'Zonal';

export interface Zone {
  id: string;
  name: string;
  center: { x: number; y: number; z: number };
  radius: number;
  rotation?: number[];
  scale?: { x: number; y: number };
  points?: { x: number; y: number; z: number }[];
}

export interface Marker3D {
  id?: string;
  type: MarkerType;
  pathologyId: string;
  position: { x: number; y: number; z: number };
  rotation: number[];
  normal: { x: number; y: number; z: number };
  zone: string;
  radius?: number;
  scale?: { x: number; y: number };
  points?: { x: number; y: number; z: number }[];
  isAddPointMode?: boolean;
}

export interface EditablePoint {
  id: string;
  type: 'intersection' | 'free';
  x: number;
  y: number;
  z: number;
  lineIds: string[];
  name?: string;
}

/** Posición 2D proyectada de un punto (para overlay de números) */
export interface ProjectedPosition {
  id: string;
  x: number;
  y: number;
}

// ==========================================
// NUEVOS TIPOS: HERRAMIENTAS HA
// ==========================================

export interface FreehandLine {
  id: string;
  /** Puntos 3D que forman la trayectoria (sobre la superficie del modelo) */
  points: { x: number; y: number; z: number }[];
  color: string;
  /** Grosor relativo: 1.0 = radio base 0.003 */
  thickness: number;
  label?: string;
  /** Agrupación de múltiples líneas (ej. Abanico, Malla, Helecho) */
  groupId?: string;
  /** Técnica HA pre-rellenada al generar la forma */
  technique_preset?: string;
}

export interface SurfaceShape {
  id: string;
  shapeType: 'circle' | 'rectangle';
  center: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  /** Para círculos: radio en unidades del modelo */
  radius?: number;
  /** Para rectángulos: ancho y alto en unidades del modelo */
  width?: number;
  height?: number;
  /** Tangente para orientar rectángulos en el plano de la superficie */
  tangent?: { x: number; y: number; z: number };
  color: string;
  opacity: number;
  thickness: number;
  label?: string;
}

export type DrawingTool =
  | 'none'
  | 'freehand-brush'   // mantener+arrastrar para pintar
  | 'freehand-poly'    // clic por vértice, doble-clic para cerrar
  | 'straight-line'    // drag A→B: línea recta sobre superficie
  | 'shape-circle'     // clic+arrastrar para definir radio
  | 'shape-rect'       // clic+arrastrar para definir tamaño
  | 'ha-fan'           // Abanico: clic centro + drag longitud
  | 'ha-grid'          // Malla: clic esquina1 + drag esquina2
  | 'ha-fern';         // Helecho: drag línea central

// ==========================================
// HELPERS DE MÓDULO (reutilizados en varios useEffects)
// ==========================================

/** Interpolación lineal de Z sobre concavidades profundas (cuencas oculares). */
const bridgeZ = (pts: THREE.Vector3[], threshold = 0.30): THREE.Vector3[] => {
  if (pts.length < 4) return pts;
  const out = pts.map(p => p.clone());
  let i = 1;
  while (i < out.length) {
    const zEntry = out[i - 1].z;
    if (zEntry - out[i].z > threshold) {
      let j = i + 1;
      while (j < out.length && out[j].z < zEntry - threshold * 0.5) j++;
      const exitIdx = Math.min(j, out.length - 1);
      const span = exitIdx - (i - 1);
      const zExit = out[exitIdx].z;
      for (let k = i; k < exitIdx; k++) {
        const t = (k - (i - 1)) / span;
        out[k].z = zEntry + t * (zExit - zEntry);
      }
      i = exitIdx + 1;
    } else {
      i++;
    }
  }
  return out;
};

/**
 * Crea un tubo 3D (TubeGeometry) o serie de esferas (dashed) que sigue los puntos dados.
 * Función pura — no usa ningún ref/closure.
 */
const buildSurfaceTube = (
  pts: THREE.Vector3[],
  color: THREE.Color,
  opacity = 1.0,
  radius = 0.003,
  dashed = false
): THREE.Group => {
  const grp = new THREE.Group();
  grp.renderOrder = 999;
  if (pts.length < 2) return grp;

  if (dashed) {
    const SPACING = 0.040;
    const DOT_R = radius * 1.5;
    const HALO_R = radius * 3;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = pts[i].distanceTo(pts[i - 1]);
      acc += seg;
      if (acc >= SPACING) {
        acc = 0;
        const haloGeo = new THREE.SphereGeometry(HALO_R, 6, 6);
        const haloMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 * opacity, depthTest: false, depthWrite: false });
        const halo = new THREE.Mesh(haloGeo, haloMat);
        halo.position.copy(pts[i]);
        halo.renderOrder = 999;
        grp.add(halo);
        const dotGeo = new THREE.SphereGeometry(DOT_R, 6, 6);
        const dotMat = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity });
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.copy(pts[i]);
        dot.renderOrder = 1000;
        grp.add(dot);
      }
    }
  } else {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    const tubeGeo = new THREE.TubeGeometry(curve, Math.max(pts.length * 2, 60), radius, 6, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity });
    const mesh = new THREE.Mesh(tubeGeo, tubeMat);
    mesh.renderOrder = 999;
    grp.add(mesh);
  }
  return grp;
};

/**
 * Barre la superficie del modelo en un eje fijo (X o Y) para obtener puntos de superficie.
 * Requiere una referencia al mesh y un raycaster ya creado.
 */
const sweepAxis = (
  faceMesh: THREE.Object3D,
  rc: THREE.Raycaster,
  axisFixed: 'x' | 'y',
  fixedValue: number,
  otherMin: number,
  otherMax: number,
  steps = 60
): THREE.Vector3[] => {
  const points: THREE.Vector3[] = [];
  const dir = new THREE.Vector3(0, 0, -1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const other = otherMin + t * (otherMax - otherMin);
    const origin = axisFixed === 'x'
      ? new THREE.Vector3(fixedValue, other, 50)
      : new THREE.Vector3(other, fixedValue, 50);
    rc.set(origin, dir);
    const hits = rc.intersectObject(faceMesh, true);
    if (hits.length > 0) points.push(hits[0].point.clone());
  }
  return bridgeZ(points, 0.30);
};

export const getFacialZone = (point: THREE.Vector3, registeredZones: Zone[] = []) => {
  if (registeredZones.length > 0) {
    let closestZone = null;
    let minDist = Infinity;
    for (const zone of registeredZones) {
      const zoneCenter = new THREE.Vector3(zone.center.x, zone.center.y, zone.center.z);
      const dist = point.distanceTo(zoneCenter);
      if (dist <= zone.radius * 2.0 && dist < minDist) {
        minDist = dist;
        closestZone = zone;
      }
    }
    if (closestZone) return closestZone.name;
  }
  const { y } = point;
  if (y > 4) return "Frente";
  if (y > 1) return "Glabela y Cejas";
  if (y > -1) return "Ojeras y Región Orbital";
  if (y > -4) return "Nariz y Surco Nasogeniano";
  if (y > -7) return "Arco Cigomático y Mejillas";
  if (y > -10) return "Región Perioral y Labios";
  return "Mandíbula, Mentón y Cuello";
};

// ==========================================
// PROPS DEL COMPONENTE
// ==========================================

interface Clinical3DViewerProps {
  /** Marcadores a renderizar */
  markers: Marker3D[];
  /** Zonas registradas */
  zones?: Zone[];
  /** Patología activa para nuevas marcaciones */
  selectedPathology?: string;
  /** Callback cuando se hace click en la malla */
  onMarkerPlaced?: (data: any) => void;
  /** Altura CSS del contenedor (default: 400px) */
  height?: string;
  /** URL del modelo GLB (default: /models/clinical/male_head.glb) */
  modelUrl?: string;
  /** Modo solo lectura (sin clicks) */
  readOnly?: boolean;
  /** Saltar el diálogo interno de confirmación (el padre maneja su propio diálogo) */
  skipConfirmation?: boolean;
  // ── Líneas de referencia ─────────────────────────────────────────────────
  referenceLines?: ReferenceLine[];
  lineDrawingMode?: LineType | null;
  onLinePointAnchored?: (point: { x: number; y: number; z: number }, step: 'first' | 'second') => void;
  // ── Puntos editables (trazado de referencia) ──────────────────────────────
  editablePoints?: EditablePoint[];
  showEditablePoints?: boolean;
  pointMode?: 'none' | 'add' | 'delete';
  onEditablePointMoved?: (id: string, pos: { x: number; y: number; z: number }) => void;
  onEditablePointDeleted?: (id: string) => void;
  onEditablePointClicked?: (id: string) => void;
  onProjectedPositions?: (positions: ProjectedPosition[]) => void;
  tercioBoundaries?: { topY: number; bottomY: number; tercioMedioBottomY: number; tercioInferiorBottomY: number } | null;
  selectedPointId?: string;
  // ── Herramientas de dibujo libre (HA) ─────────────────────────────────────
  freehandLines?: FreehandLine[];
  surfaceShapes?: SurfaceShape[];
  activeTool?: DrawingTool;
  /** ID del elemento seleccionado (línea/forma/punto) para resaltarlo */
  selectedElementId?: string | null;
  /** Color del pincel activo para nuevas líneas/formas */
  pendingBrushColor?: string;
  /** Grosor relativo del pincel activo (1.0 = base) */
  pendingBrushThickness?: number;
  onFreehandLineComplete?: (line: FreehandLine) => void;
  onShapeComplete?: (shape: SurfaceShape) => void;
  /** Callback al seleccionar una línea/forma existente por clic. id=null → deseleccionar */
  onElementSelected?: (id: string | null, type: string | null) => void;
}

// ==========================================
// MOTOR 3D (Three.js vanilla)
// ==========================================

const ThreeEngine: React.FC<{
  modelSource: { type: 'url' | 'buffer'; data: string | ArrayBuffer };
  markers: Marker3D[];
  zones: Zone[];
  onMeshClick: (data: any) => void;
  onLoaded: () => void;
  onError: (msg: string) => void;
  readOnly: boolean;
  referenceLines?: ReferenceLine[];
  lineDrawingMode?: LineType | null;
  onLinePointAnchored?: (point: { x: number; y: number; z: number }, step: 'first' | 'second') => void;
  editablePoints?: EditablePoint[];
  showEditablePoints?: boolean;
  pointMode?: 'none' | 'add' | 'delete';
  onEditablePointMoved?: (id: string, pos: { x: number; y: number; z: number }) => void;
  onEditablePointDeleted?: (id: string) => void;
  onEditablePointClicked?: (id: string) => void;
  onProjectedPositions?: (positions: ProjectedPosition[]) => void;
  tercioBoundaries?: { topY: number; bottomY: number; tercioMedioBottomY: number; tercioInferiorBottomY: number } | null;
  selectedPointId?: string;
  // ── Herramientas de dibujo libre (HA) ──────────────────────────────────
  freehandLines?: FreehandLine[];
  surfaceShapes?: SurfaceShape[];
  activeTool?: DrawingTool;
  selectedElementId?: string | null;
  pendingBrushColor?: string;
  pendingBrushThickness?: number;
  onFreehandLineComplete?: (line: FreehandLine) => void;
  onShapeComplete?: (shape: SurfaceShape) => void;
  onElementSelected?: (id: string | null, type: string | null) => void;
}> = ({
  modelSource, markers, zones, onMeshClick, onLoaded, onError, readOnly,
  referenceLines = [], lineDrawingMode, onLinePointAnchored,
  editablePoints = [], showEditablePoints = true, pointMode = 'none',
  onEditablePointMoved, onEditablePointDeleted, onEditablePointClicked,
  onProjectedPositions, tercioBoundaries = null, selectedPointId,
  freehandLines = [], surfaceShapes = [],
  activeTool = 'none', selectedElementId = null,
  pendingBrushColor = '#8b5cf6', pendingBrushThickness = 1.0,
  onFreehandLineComplete, onShapeComplete, onElementSelected,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const faceMeshRef = useRef<THREE.Object3D | null>(null);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const linesGroupRef = useRef<THREE.Group | null>(null);
  const boundariesGroupRef = useRef<THREE.Group | null>(null);
  const editablePointsGroupRef = useRef<THREE.Group | null>(null);
  // Nuevos grupos para herramientas HA
  const freehandGroupRef = useRef<THREE.Group | null>(null);
  const shapesGroupRef = useRef<THREE.Group | null>(null);
  const brushPreviewGroupRef = useRef<THREE.Group | null>(null);
  // Increments each time the model finishes loading so the markers effect re-runs
  const [modelVersion, setModelVersion] = useState(0);
  // Track two-point step inside engine for cursor feedback
  const twoPointStepRef = useRef<0 | 1>(0);

  const callbacks = useRef({
    onMeshClick, onLoaded, onError, zones, readOnly, lineDrawingMode, onLinePointAnchored,
    pointMode, onEditablePointMoved, onEditablePointDeleted, onEditablePointClicked, onProjectedPositions,
    activeTool, selectedElementId, pendingBrushColor, pendingBrushThickness,
    onFreehandLineComplete, onShapeComplete, onElementSelected,
  });
  useEffect(() => {
    callbacks.current = {
      onMeshClick, onLoaded, onError, zones, readOnly, lineDrawingMode, onLinePointAnchored,
      pointMode, onEditablePointMoved, onEditablePointDeleted, onEditablePointClicked, onProjectedPositions,
      activeTool, selectedElementId, pendingBrushColor, pendingBrushThickness,
      onFreehandLineComplete, onShapeComplete, onElementSelected,
    };
  });

  // 1. Initialize scene once
  useEffect(() => {
    if (!mountRef.current) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color('#1e293b');

    const markersGroup = new THREE.Group();
    markersGroupRef.current = markersGroup;
    scene.add(markersGroup);

    const linesGroup = new THREE.Group();
    linesGroupRef.current = linesGroup;
    scene.add(linesGroup);

    const boundariesGroup = new THREE.Group();
    boundariesGroupRef.current = boundariesGroup;
    scene.add(boundariesGroup);

    const editablePointsGroup = new THREE.Group();
    editablePointsGroupRef.current = editablePointsGroup;
    scene.add(editablePointsGroup);

    // Grupos para herramientas de dibujo libre (HA)
    const freehandGroup = new THREE.Group();
    freehandGroupRef.current = freehandGroup;
    scene.add(freehandGroup);

    const shapesGroup = new THREE.Group();
    shapesGroupRef.current = shapesGroup;
    scene.add(shapesGroup);

    const brushPreviewGroup = new THREE.Group();
    brushPreviewGroupRef.current = brushPreviewGroup;
    scene.add(brushPreviewGroup);

    const camera = new THREE.PerspectiveCamera(35, mountRef.current.clientWidth / mountRef.current.clientHeight, 0.1, 1000);
    camera.position.set(0, 0, 12);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 100;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    controlsRef.current = controls;

    // Lighting
    scene.add(new THREE.AmbientLight(0xf0f5ff, 0.3));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(15, 20, 15);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.bias = -0.0001;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.9);
    fillLight.position.set(-15, 5, 10);
    scene.add(fillLight);
    const rimLight = new THREE.SpotLight(0xe0e7ff, 1.5, 0, 0.8, 1);
    rimLight.position.set(0, -5, -20);
    scene.add(rimLight);

    // Raycasting
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let startPos = { x: 0, y: 0 };

    // ── Estado drag de puntos editables ────────────────────────────────────
    let draggedEditableId: string | null = null;
    let draggedEditableGroup: THREE.Group | null = null;
    let dragMoved = false;

    // ── Estado dibujo libre (HA) ───────────────────────────────────────────
    let brushActive = false;
    let brushPoints: THREE.Vector3[] = [];
    let brushLastScreenPos = { x: 0, y: 0 };
    const BRUSH_SAMPLE_PX = 6; // píxeles mínimos entre muestras

    let polyActive = false;
    let polyPoints: THREE.Vector3[] = [];
    let polyLastClickTime = 0;
    const DOUBLE_CLICK_MS = 350;

    let shapeAnchor: { point: THREE.Vector3; normal: THREE.Vector3; tangent: THREE.Vector3 } | null = null;
    let shapeCurrentRadius = 0;
    let shapeCurrentW = 0;
    let shapeCurrentH = 0;

    const clearBrushPreview = () => {
      const grp = brushPreviewGroupRef.current;
      if (!grp) return;
      while (grp.children.length > 0) {
        const child = grp.children[0] as any;
        grp.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose());
          else child.material.dispose();
        }
      }
    };

    // ── Anillo de selección ────────────────────────────────────────────────
    let selectedEditableId: string | null = null;
    let selectionRingMesh: THREE.Mesh | null = null;

    const clearSelectionRing = () => {
      if (selectionRingMesh) {
        const grp = selectionRingMesh.parent;
        if (grp) {
          grp.traverse((c: any) => {
            if (c.isMesh && c !== selectionRingMesh) {
              if (c.userData.selBaseEmissive !== undefined) {
                c.material.emissive?.setHex(c.userData.selBaseEmissive);
                delete c.userData.selBaseEmissive;
              }
              if (c.userData.selBaseEmissiveInt !== undefined) {
                c.material.emissiveIntensity = c.userData.selBaseEmissiveInt;
                delete c.userData.selBaseEmissiveInt;
              }
              if (c.material?.needsUpdate !== undefined) c.material.needsUpdate = true;
            }
          });
          grp.remove(selectionRingMesh);
        }
        selectionRingMesh.geometry.dispose();
        (selectionRingMesh.material as THREE.Material).dispose();
        selectionRingMesh = null;
      }
      selectedEditableId = null;
    };

    const addSelectionRing = (group: THREE.Group) => {
      clearSelectionRing();
      // Resalte neón: solo cambia el color/intensidad emissive del halo, sin tocar geometría ni opacidad
      group.traverse((c: any) => {
        if (c.isMesh && c.material?.emissive !== undefined && c.material?.transmission !== undefined) {
          // Es la esfera exterior translúcida
          c.userData.selBaseEmissive = c.material.emissive.getHex();
          c.userData.selBaseEmissiveInt = c.material.emissiveIntensity;
          c.material.emissive.setHex(0xffffff); // blanco neón
          c.material.emissiveIntensity = 1.4;
          c.material.needsUpdate = true;
        }
      });
      // Marcador invisible para rastrear grupo seleccionado
      const dummyGeo = new THREE.SphereGeometry(0.001, 3, 3);
      const dummyMat = new THREE.MeshBasicMaterial({ visible: false });
      const dummy = new THREE.Mesh(dummyGeo, dummyMat);
      group.add(dummy);
      selectionRingMesh = dummy;
      selectedEditableId = group.userData.editableId ?? null;
    };

    const onPointerDown = (e: MouseEvent) => {
      startPos = { x: e.clientX, y: e.clientY };
      const tool = callbacks.current.activeTool;

      // ── Modo freehand brush ────────────────────────────────────────────────
      if (tool === 'freehand-brush' || tool === 'straight-line' || tool === 'ha-fan' || tool === 'ha-grid' || tool === 'ha-fern') {
        if (!faceMeshRef.current || !cameraRef.current) return;
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const hits = raycaster.intersectObject(faceMeshRef.current, true);
        if (hits.length > 0) {
          brushActive = true;
          brushPoints = [hits[0].point.clone()];
          brushLastScreenPos = { x: e.clientX, y: e.clientY };
          if (controlsRef.current) controlsRef.current.enabled = false;
        }
        return;
      }

      // ── Modo shape (circle / rectangle) ───────────────────────────────────
      if (tool === 'shape-circle' || tool === 'shape-rect') {
        if (!faceMeshRef.current || !cameraRef.current) return;
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const hits = raycaster.intersectObject(faceMeshRef.current, true);
        if (hits.length > 0) {
          const h = hits[0];
          const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() : new THREE.Vector3(0, 0, 1);
          const up = new THREE.Vector3(0, 1, 0);
          let tangent = new THREE.Vector3().crossVectors(normal, up).normalize();
          if (tangent.lengthSq() < 0.01) tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
          shapeAnchor = { point: h.point.clone(), normal, tangent };
          shapeCurrentRadius = 0;
          shapeCurrentW = 0;
          shapeCurrentH = 0;
          if (controlsRef.current) controlsRef.current.enabled = false;
        }
        return;
      }

      // ── En modo 'add', el clic siempre va al modelo (no interactúa con puntos)
      if (callbacks.current.pointMode === 'add') {
        isDragging = false;
        return;
      }
      // En readOnly (p.ej. modal de capturas), no iniciar drag de puntos:
      if (callbacks.current.readOnly) {
        isDragging = false;
        return;
      }
      // Detectar hit sobre punto editable
      if (editablePointsGroupRef.current && cameraRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const epMeshes: THREE.Object3D[] = [];
        editablePointsGroupRef.current.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) epMeshes.push(c); }));
        const hits = raycaster.intersectObjects(epMeshes, false);
        if (hits.length > 0) {
          let obj: THREE.Object3D | null = hits[0].object;
          while (obj && !obj.userData.isEditablePoint) obj = obj.parent;
          if (obj && obj.userData.isEditablePoint) {
            if (callbacks.current.pointMode === 'delete') {
              callbacks.current.onEditablePointDeleted?.(obj.userData.editableId);
              return;
            }
            // Iniciar drag
            draggedEditableId = obj.userData.editableId;
            draggedEditableGroup = obj as THREE.Group;
            if (controlsRef.current) controlsRef.current.enabled = false;
            isDragging = false;
            dragMoved = false;
            startPos = { x: e.clientX, y: e.clientY };
            return;
          }
        }
      }
      clearSelectionRing();
      isDragging = false;
      startPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: MouseEvent) => {
      // ── Modo brush / straight-line / HA shapes: recopilar posición ─────────
      if (brushActive && faceMeshRef.current && cameraRef.current) {
        const tool = callbacks.current.activeTool;
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const hits = raycaster.intersectObject(faceMeshRef.current, true);
        if (hits.length > 0) {
          const dx = e.clientX - brushLastScreenPos.x;
          const dy = e.clientY - brushLastScreenPos.y;
          const moved = Math.sqrt(dx * dx + dy * dy) >= BRUSH_SAMPLE_PX;
          // Straight-line / HA shapes: siempre actualizar el último punto (punto B)
          const isSnap = tool === 'straight-line' || tool === 'ha-fan' || tool === 'ha-grid' || tool === 'ha-fern';
          if (moved || isSnap) {
            if (isSnap) {
              // Mantener solo ptA y reemplazar ptB
              if (brushPoints.length === 1) brushPoints.push(hits[0].point.clone());
              else brushPoints[brushPoints.length - 1] = hits[0].point.clone();
            } else {
              brushPoints.push(hits[0].point.clone());
              brushLastScreenPos = { x: e.clientX, y: e.clientY };
            }
            // Preview: línea entre ptA y ptB (snap) o todos los puntos (brush)
            clearBrushPreview();
            const previewPts = isSnap ? [brushPoints[0], brushPoints[brushPoints.length - 1]] : brushPoints;
            if (previewPts.length >= 2 && brushPreviewGroupRef.current) {
              const col = new THREE.Color(callbacks.current.pendingBrushColor || '#8b5cf6');
              const th = (callbacks.current.pendingBrushThickness || 1.0) * 0.003;
              const preview = buildSurfaceTube(previewPts, col, 0.6, th, false);
              brushPreviewGroupRef.current.add(preview);
            }
          }
        }
        return;
      }

      // ── Modo shape: preview de círculo o rectángulo ────────────────────────
      if (shapeAnchor && faceMeshRef.current && cameraRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        const dx = e.clientX - rect.left - rect.width / 2;
        const dy = e.clientY - rect.top - rect.height / 2;
        // Estimar radio en unidades del modelo desde distancia en pantalla
        const screenDist = Math.sqrt(
          (e.clientX - (rect.left + rect.width / 2 + shapeAnchor.point.x * 50)) ** 2 +
          (e.clientY - (rect.top + rect.height / 2 - shapeAnchor.point.y * 50)) ** 2
        );
        // Conversión aproximada: la cámara está a ~12 unidades, FOV=35°
        const camDist = cameraRef.current.position.distanceTo(shapeAnchor.point);
        const fovRad = (cameraRef.current.fov * Math.PI) / 180;
        const unitsPerPx = (2 * camDist * Math.tan(fovRad / 2)) / rect.height;
        const rawDist = Math.sqrt(
          (e.clientX - startPos.x) ** 2 + (e.clientY - startPos.y) ** 2
        ) * unitsPerPx;
        const r = Math.max(0.05, rawDist);
        shapeCurrentRadius = r;
        shapeCurrentW = r * 1.6;
        shapeCurrentH = r;

        // Limpiar preview anterior
        clearBrushPreview();
        if (brushPreviewGroupRef.current && r > 0.05) {
          const col = new THREE.Color(callbacks.current.pendingBrushColor || '#8b5cf6');
          const th = (callbacks.current.pendingBrushThickness || 1.0) * 0.003;
          const tool = callbacks.current.activeTool;
          let previewPts: THREE.Vector3[] = [];
          const rc = new THREE.Raycaster();
          const dir = new THREE.Vector3(0, 0, -1);
          if (tool === 'shape-circle') {
            const N = 48;
            const bitangent = new THREE.Vector3().crossVectors(shapeAnchor.normal, shapeAnchor.tangent).normalize();
            for (let i = 0; i <= N; i++) {
              const a = (i / N) * Math.PI * 2;
              const wp = shapeAnchor.point.clone()
                .addScaledVector(shapeAnchor.tangent, Math.cos(a) * r)
                .addScaledVector(bitangent, Math.sin(a) * r);
              const origin = wp.clone().add(shapeAnchor.normal.clone().multiplyScalar(2));
              rc.set(origin, dir.clone().negate().add(shapeAnchor.normal.clone().negate()));
              rc.set(origin, new THREE.Vector3(0, 0, -1));
              const hits2 = rc.intersectObject(faceMeshRef.current!, true);
              previewPts.push(hits2.length > 0 ? hits2[0].point.clone() : wp);
            }
          } else {
            const bitangent = new THREE.Vector3().crossVectors(shapeAnchor.normal, shapeAnchor.tangent).normalize();
            const hw = shapeCurrentW / 2, hh = shapeCurrentH / 2;
            const corners = [
              [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]
            ];
            for (const [u, v] of corners) {
              const wp = shapeAnchor.point.clone()
                .addScaledVector(shapeAnchor.tangent, u)
                .addScaledVector(bitangent, v);
              const origin = wp.clone().addScaledVector(shapeAnchor.normal, 2);
              rc.set(origin, new THREE.Vector3(0, 0, -1));
              const hits2 = rc.intersectObject(faceMeshRef.current!, true);
              previewPts.push(hits2.length > 0 ? hits2[0].point.clone() : wp);
            }
          }
          if (previewPts.length >= 2) {
            const preview = buildSurfaceTube(previewPts, col, 0.7, th, false);
            brushPreviewGroupRef.current.add(preview);
          }
        }
        return;
      }

      // Drag de punto editable sobre superficie
      if (draggedEditableGroup && faceMeshRef.current && cameraRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const meshObjs: THREE.Object3D[] = [];
        faceMeshRef.current.traverse(o => { if ((o as THREE.Mesh).isMesh) meshObjs.push(o); });
        const hits = raycaster.intersectObjects(meshObjs, false);
        if (hits.length > 0) {
          const hit = hits[0];
          if (hit.face) {
            const nf = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
            draggedEditableGroup.position.copy(hit.point).addScaledVector(nf, 0.03);
          } else {
            draggedEditableGroup.position.copy(hit.point);
          }
          dragMoved = true;
        }
        return;
      }
      if (Math.abs(e.clientX - startPos.x) > 6 || Math.abs(e.clientY - startPos.y) > 6) {
        isDragging = true;
      }
    };

    const onPointerUp = (e: MouseEvent) => {
      // ── Finalizar brush / straight-line / formas HA ───────────────────────
      if (brushActive) {
        const tool = callbacks.current.activeTool;
        brushActive = false;
        clearBrushPreview();
        if (controlsRef.current) controlsRef.current.enabled = true;
        const col = callbacks.current.pendingBrushColor || '#8b5cf6';
        const th = callbacks.current.pendingBrushThickness || 1.0;
        const ptA = brushPoints[0];
        const ptB = brushPoints[brushPoints.length - 1];

        // Línea recta (straight-line): solo 2 puntos — inicio y fin
        if (tool === 'straight-line' && ptA && ptB) {
          callbacks.current.onFreehandLineComplete?.({
            id: `fh-${Date.now()}`,
            points: [
              { x: ptA.x, y: ptA.y, z: ptA.z },
              { x: ptB.x, y: ptB.y, z: ptB.z },
            ],
            color: col,
            thickness: th,
          });
        }
        // Abanico (fan): N líneas divergentes desde ptA hacia ptB + ángulo de apertura
        else if (tool === 'ha-fan' && ptA && ptB) {
          const groupId = `fan-${Date.now()}`;
          const N = 5;
          const halfAngle = 25; // grados
          const dir = ptB.clone().sub(ptA);
          const len = dir.length();
          if (len > 0.05) {
            dir.normalize();
            // Eje perpendicular en el plano XY
            const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
            for (let i = 0; i < N; i++) {
              const t = N === 1 ? 0 : (i / (N - 1) - 0.5) * 2; // -1 a 1
              const angleDeg = t * halfAngle;
              const rad = (angleDeg * Math.PI) / 180;
              const fanDir = dir.clone().addScaledVector(perp, Math.tan(rad)).normalize();
              const endPt = ptA.clone().addScaledVector(fanDir, len);
              callbacks.current.onFreehandLineComplete?.({
                id: `fh-${Date.now()}-${i}`,
                points: [
                  { x: ptA.x, y: ptA.y, z: ptA.z },
                  { x: endPt.x, y: endPt.y, z: endPt.z },
                ],
                color: col,
                thickness: th,
                groupId,
                technique_preset: 'Abanico',
              });
            }
          }
        }
        // Malla (grid): N líneas horizontales + M verticales en bounding box
        else if (tool === 'ha-grid' && ptA && ptB) {
          const groupId = `grid-${Date.now()}`;
          const N = 4; // líneas en cada dirección
          const dir = ptB.clone().sub(ptA);
          const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
          const len = dir.length();
          const perpLen = len * 0.6;
          for (let i = 0; i <= N; i++) {
            const t = i / N;
            const base = ptA.clone().addScaledVector(dir, t);
            const p1 = base.clone().addScaledVector(perp, -perpLen / 2);
            const p2 = base.clone().addScaledVector(perp, perpLen / 2);
            callbacks.current.onFreehandLineComplete?.({
              id: `fh-${Date.now()}-h${i}`,
              points: [{ x: p1.x, y: p1.y, z: p1.z }, { x: p2.x, y: p2.y, z: p2.z }],
              color: col, thickness: th, groupId, technique_preset: 'Malla',
            });
          }
          for (let j = 0; j <= N; j++) {
            const t = j / N;
            const base = ptA.clone().addScaledVector(perp, (t - 0.5) * perpLen);
            const p1 = base.clone();
            const p2 = base.clone().addScaledVector(dir, len);
            callbacks.current.onFreehandLineComplete?.({
              id: `fh-${Date.now()}-v${j}`,
              points: [{ x: p1.x, y: p1.y, z: p1.z }, { x: p2.x, y: p2.y, z: p2.z }],
              color: col, thickness: th, groupId, technique_preset: 'Malla',
            });
          }
        }
        // Helecho (fern): línea central + ramificaciones alternadas
        else if (tool === 'ha-fern' && ptA && ptB) {
          const groupId = `fern-${Date.now()}`;
          const dir = ptB.clone().sub(ptA);
          const len = dir.length();
          if (len > 0.05) {
            // Línea central
            callbacks.current.onFreehandLineComplete?.({
              id: `fh-${Date.now()}-c`,
              points: [{ x: ptA.x, y: ptA.y, z: ptA.z }, { x: ptB.x, y: ptB.y, z: ptB.z }],
              color: col, thickness: th, groupId, technique_preset: 'Helecho',
            });
            const N = 5;
            const perp = new THREE.Vector3(-dir.normalize().y, dir.normalize().x, 0).normalize();
            for (let i = 1; i <= N; i++) {
              const t = i / (N + 1);
              const base = ptA.clone().addScaledVector(dir.clone().normalize(), len * t);
              const branchLen = len * 0.25 * (1 - t * 0.5);
              const sign = i % 2 === 0 ? 1 : -1;
              const tip = base.clone().addScaledVector(perp, sign * branchLen);
              callbacks.current.onFreehandLineComplete?.({
                id: `fh-${Date.now()}-b${i}`,
                points: [{ x: base.x, y: base.y, z: base.z }, { x: tip.x, y: tip.y, z: tip.z }],
                color: col, thickness: th * 0.7, groupId, technique_preset: 'Helecho',
              });
            }
          }
        }
        // Freehand brush normal
        else if ((tool === 'freehand-brush') && brushPoints.length >= 2) {
          callbacks.current.onFreehandLineComplete?.({
            id: `fh-${Date.now()}`,
            points: brushPoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
            color: col,
            thickness: th,
          });
        }
        brushPoints = [];
        isDragging = true;
        return;
      }

      // ── Finalizar shape (circle / rectangle) ──────────────────────────────
      if (shapeAnchor) {
        const anchor = shapeAnchor;
        shapeAnchor = null;
        clearBrushPreview();
        if (controlsRef.current) controlsRef.current.enabled = true;
        const tool = callbacks.current.activeTool;
        const screenDist = Math.sqrt(
          (e.clientX - startPos.x) ** 2 + (e.clientY - startPos.y) ** 2
        );
        if (screenDist >= 8 && (shapeCurrentRadius > 0.05 || shapeCurrentW > 0.05)) {
          const id = `sh-${Date.now()}`;
          const col = callbacks.current.pendingBrushColor || '#8b5cf6';
          const th = callbacks.current.pendingBrushThickness || 1.0;
          const shape: SurfaceShape = {
            id,
            shapeType: tool === 'shape-circle' ? 'circle' : 'rectangle',
            center: { x: anchor.point.x, y: anchor.point.y, z: anchor.point.z },
            normal: { x: anchor.normal.x, y: anchor.normal.y, z: anchor.normal.z },
            tangent: { x: anchor.tangent.x, y: anchor.tangent.y, z: anchor.tangent.z },
            radius: shapeCurrentRadius,
            width: shapeCurrentW,
            height: shapeCurrentH,
            color: col,
            opacity: 0.85,
            thickness: th,
          };
          callbacks.current.onShapeComplete?.(shape);
        }
        isDragging = true;
        return;
      }

      if (draggedEditableId && draggedEditableGroup) {
        const relId = draggedEditableId;
        const relGroup = draggedEditableGroup;
        draggedEditableId = null;
        draggedEditableGroup = null;
        if (controlsRef.current) controlsRef.current.enabled = true;
        isDragging = true; // Prevenir que onClick dispare el flujo de marcación
        if (dragMoved) {
          const pos = relGroup.position;
          callbacks.current.onEditablePointMoved?.(relId, { x: pos.x, y: pos.y, z: pos.z });
        } else {
          // Clic simple sobre punto → anillo de selección + notificar al padre
          if (selectedEditableId === relId) {
            clearSelectionRing();
          } else {
            addSelectionRing(relGroup);
          }
          callbacks.current.onEditablePointClicked?.(relId);
        }
        dragMoved = false;
      }
    };

    const onClick = (event: MouseEvent) => {
      if (isDragging || !faceMeshRef.current || !cameraRef.current) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, cameraRef.current);

      const tool = callbacks.current.activeTool;

      // ── Modo brush/shape/straight/ha: ignorar onClick (ya manejado en pointerUp) ──
      if (tool === 'freehand-brush' || tool === 'shape-circle' || tool === 'shape-rect'
        || tool === 'straight-line' || tool === 'ha-fan' || tool === 'ha-grid' || tool === 'ha-fern') return;

      // ── Selección de elementos existentes (freehand, shapes, reference lines) ─
      if (tool === 'none' || tool === 'freehand-poly') {
        // Raycast contra freehand group
        const fhMeshes: THREE.Object3D[] = [];
        freehandGroupRef.current?.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) fhMeshes.push(c); }));
        if (fhMeshes.length > 0) {
          const fhHits = raycaster.intersectObjects(fhMeshes, false);
          if (fhHits.length > 0) {
            let obj: THREE.Object3D | null = fhHits[0].object;
            while (obj && !obj.userData.freehandId) obj = obj.parent;
            if (obj?.userData.freehandId) {
              callbacks.current.onElementSelected?.(obj.userData.freehandId, 'freehand');
              return;
            }
          }
        }
        // Raycast contra shapes group
        const shMeshes: THREE.Object3D[] = [];
        shapesGroupRef.current?.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) shMeshes.push(c); }));
        if (shMeshes.length > 0) {
          const shHits = raycaster.intersectObjects(shMeshes, false);
          if (shHits.length > 0) {
            let obj: THREE.Object3D | null = shHits[0].object;
            while (obj && !obj.userData.shapeId) obj = obj.parent;
            if (obj?.userData.shapeId) {
              callbacks.current.onElementSelected?.(obj.userData.shapeId, 'shape');
              return;
            }
          }
        }
        // Raycast contra reference lines
        const lineMeshes: THREE.Object3D[] = [];
        linesGroupRef.current?.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) lineMeshes.push(c); }));
        if (lineMeshes.length > 0) {
          const lineHits = raycaster.intersectObjects(lineMeshes, false);
          if (lineHits.length > 0) {
            let obj: THREE.Object3D | null = lineHits[0].object;
            while (obj && !obj.userData.lineId) obj = obj.parent;
            if (obj?.userData.lineId) {
              callbacks.current.onElementSelected?.(obj.userData.lineId, 'reference-line');
              return;
            }
          }
        }
        // Clic en espacio vacío → deseleccionar (solo en tool=none)
        if (tool === 'none' && (fhMeshes.length > 0 || shMeshes.length > 0 || lineMeshes.length > 0)) {
          callbacks.current.onElementSelected?.(null, null);
        }
      }

      const intersects = raycaster.intersectObject(faceMeshRef.current, true);
      if (intersects.length === 0) return;
      const intersect = intersects[0];
      const point = intersect.point;

      // ── Modo polilínea ────────────────────────────────────────────────────
      if (tool === 'freehand-poly') {
        const now = Date.now();
        const isDouble = now - polyLastClickTime < DOUBLE_CLICK_MS && polyPoints.length >= 2;
        polyLastClickTime = now;
        if (isDouble) {
          // Finalizar polilínea
          const id = `fh-${Date.now()}`;
          const col = callbacks.current.pendingBrushColor || '#8b5cf6';
          const th = callbacks.current.pendingBrushThickness || 1.0;
          if (polyPoints.length >= 2) {
            callbacks.current.onFreehandLineComplete?.({
              id,
              points: polyPoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
              color: col,
              thickness: th,
            });
          }
          polyPoints = [];
          polyActive = false;
          clearBrushPreview();
        } else {
          polyPoints.push(point.clone());
          polyActive = true;
          clearBrushPreview();
          if (polyPoints.length >= 2 && brushPreviewGroupRef.current) {
            const col = new THREE.Color(callbacks.current.pendingBrushColor || '#8b5cf6');
            const th = (callbacks.current.pendingBrushThickness || 1.0) * 0.003;
            const preview = buildSurfaceTube(polyPoints, col, 0.6, th, false);
            brushPreviewGroupRef.current.add(preview);
          }
        }
        return;
      }

      // ── Modo línea de referencia ─────────────────────────────────────
      const lineMode = callbacks.current.lineDrawingMode;
      if (lineMode) {
        const anchorPt = { x: point.x, y: point.y, z: point.z };
        if (lineMode === 'two-points') {
          const step = twoPointStepRef.current === 0 ? 'first' : 'second';
          callbacks.current.onLinePointAnchored?.(anchorPt, step);
          twoPointStepRef.current = twoPointStepRef.current === 0 ? 1 : 0;
        } else {
          callbacks.current.onLinePointAnchored?.(anchorPt, 'first');
        }
        return;
      }

      // ── Modo añadir punto libre ────────────────────────────────────────
      if (callbacks.current.pointMode === 'add') {
        const nAdd = intersect.face ? intersect.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(intersect.object.matrixWorld)).normalize() : new THREE.Vector3(0, 1, 0);
        const ptAdd = point.clone().addScaledVector(nAdd, 0.03);
        callbacks.current.onMeshClick({
          position: { x: ptAdd.x, y: ptAdd.y, z: ptAdd.z },
          rotation: [0, 0, 0],
          normal: { x: nAdd.x, y: nAdd.y, z: nAdd.z },
          zone: '',
          radius: 0.3,
          isAddPointMode: true,
        });
        return;
      }

      // ── Modo marcación normal ────────────────────────────────────────
      if (callbacks.current.readOnly) return;
      const n = intersect.face ? intersect.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      const nTransform = new THREE.Matrix3().getNormalMatrix(intersect.object.matrixWorld);
      n.applyMatrix3(nTransform).normalize();

      const dummy = new THREE.Object3D();
      dummy.position.copy(point);
      dummy.lookAt(point.clone().add(n));

      callbacks.current.onMeshClick({
        position: { x: point.x, y: point.y, z: point.z },
        rotation: [dummy.rotation.x, dummy.rotation.y, dummy.rotation.z],
        normal: { x: n.x, y: n.y, z: n.z },
        zone: '',
        radius: 0.3,
      });
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('click', onClick);

    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        // Project point positions to 2D for unit-number overlay
        if (callbacks.current.onProjectedPositions) {
          const projected: ProjectedPosition[] = [];
          const cam = cameraRef.current;
          const canvas = rendererRef.current.domElement;
          const w = canvas.clientWidth;
          const h = canvas.clientHeight;
          const projectGroup = (group: THREE.Object3D, id: string) => {
            const wp = new THREE.Vector3();
            group.getWorldPosition(wp);
            const ndc = wp.clone().project(cam);
            projected.push({ id, x: (ndc.x * 0.5 + 0.5) * w, y: (-ndc.y * 0.5 + 0.5) * h });
          };
          markersGroupRef.current?.children.forEach(c => {
            const id = (c as THREE.Group).userData.markerId;
            if (id) projectGroup(c, id);
          });
          editablePointsGroupRef.current?.children.forEach(c => {
            const id = (c as THREE.Group).userData.editableId;
            if (id) projectGroup(c, id);
          });
          // Sentinel: encode camera distance so parent can scale the number labels
          if (controlsRef.current) {
            const camDist = cam.position.distanceTo(controlsRef.current.target);
            projected.push({ id: '__zoom__', x: camDist, y: 0 });
          }
          callbacks.current.onProjectedPositions(projected);
        }
      }
    };
    animate();

    const onResize = () => {
      if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      if (w === 0 || h === 0) return;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    // ResizeObserver: detecta cambios de tamaño del contenedor (ej. modal con animación
    // flex donde height puede resolverse después del montaje inicial)
    const ro = new ResizeObserver(onResize);
    if (mountRef.current) ro.observe(mountRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      if (rendererRef.current && rendererRef.current.domElement) {
        const dom = rendererRef.current.domElement;
        dom.removeEventListener('pointerdown', onPointerDown);
        dom.removeEventListener('pointermove', onPointerMove);
        dom.removeEventListener('pointerup', onPointerUp);
        dom.removeEventListener('click', onClick);
      }
      cancelAnimationFrame(animationFrameId);
      if (mountRef.current && rendererRef.current) {
        try { mountRef.current.removeChild(rendererRef.current.domElement); } catch (_) {}
      }
      if (rendererRef.current) rendererRef.current.dispose();
    };
  }, []);

  // 2. Load model when source changes
  useEffect(() => {
    if (!sceneRef.current || !modelSource) return;

    if (faceMeshRef.current) {
      sceneRef.current.remove(faceMeshRef.current);
      faceMeshRef.current = null;
    }

    const loader = new GLTFLoader();

    const handleLoadedModel = (gltf: any) => {
      const model = gltf.scene;
      if (!model) {
        callbacks.current.onError("El archivo no contiene una malla 3D válida.");
        return;
      }

      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      model.position.x -= center.x;
      model.position.y -= center.y;
      model.position.z -= center.z;

      const pivotGroup = new THREE.Group();
      pivotGroup.add(model);
      sceneRef.current?.add(pivotGroup);
      faceMeshRef.current = pivotGroup;

      model.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          child.material = new THREE.MeshPhysicalMaterial({
            color: 0xfae3db,
            roughness: 0.45,
            metalness: 0.05,
            clearcoat: 0.15,
            clearcoatRoughness: 0.3,
            side: THREE.DoubleSide,
          });
        }
      });

      const maxDim = Math.max(size.x, size.y, size.z);
      // targetSize=5 para coincidir exactamente con Clinical3D.tsx y que las
      // coordenadas del JSON (generadas en ese viewer) sean directamente compatibles.
      const scaleFactor = 5 / (maxDim || 1);
      model.scale.setScalar(scaleFactor);

      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }

      setModelVersion(v => v + 1);
      callbacks.current.onLoaded();
    };

    const handleLoadError = (_error: any) => {
      if (modelSource.type === 'buffer' && !modelSource.data) return;
      callbacks.current.onError("No se pudo cargar el modelo 3D.");
    };

    try {
      if (modelSource.type === 'buffer') {
        if (modelSource.data && (modelSource.data instanceof ArrayBuffer || typeof modelSource.data === 'string')) {
          loader.parse(modelSource.data, '', handleLoadedModel, handleLoadError);
        }
      } else if (modelSource.type === 'url') {
        if (!modelSource.data) return;
        loader.load(modelSource.data as string, handleLoadedModel, undefined, handleLoadError);
      }
    } catch (err) {
      handleLoadError(err);
    }
  }, [modelSource]);

  // 3. Render markers
  useEffect(() => {
    const group = markersGroupRef.current;
    const faceMesh = faceMeshRef.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      // @ts-ignore
      if (child.geometry) child.geometry.dispose();
      // @ts-ignore
      if (child.material) {
        // @ts-ignore
        if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose());
        // @ts-ignore
        else child.material.dispose();
      }
    }

    markers.forEach((marker) => {
      const pathology = PATHOLOGIES.find(p => p.id === marker.pathologyId);
      const colorHex = pathology?.color || '#ffffff';
      const color = new THREE.Color(colorHex);
      const pos = new THREE.Vector3(marker.position.x, marker.position.y, marker.position.z);

      if (marker.type === 'Puntual') {
        const markerGroup = new THREE.Group();
        markerGroup.position.copy(pos);
        markerGroup.userData.markerId = marker.id ?? `m-${Date.now()}`;
        const coreGeo = new THREE.SphereGeometry(0.06, 12, 12);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        markerGroup.add(new THREE.Mesh(coreGeo, coreMat));

        const outerGeo = new THREE.SphereGeometry(0.12, 16, 16);
        const outerMat = new THREE.MeshPhysicalMaterial({
          color, emissive: color, emissiveIntensity: 1.5,
          transparent: true, opacity: 0.8, roughness: 0, transmission: 0.9, thickness: 0.5,
        });
        markerGroup.add(new THREE.Mesh(outerGeo, outerMat));
        group.add(markerGroup);

      } else if (marker.type === 'Zonal' && faceMesh) {
        let targetMesh: THREE.Mesh | null = null;
        if (faceMesh.type === 'Group' || faceMesh.type === 'Scene') {
          faceMesh.traverse((child) => {
            if (child instanceof THREE.Mesh && !targetMesh) targetMesh = child;
          });
        } else if (faceMesh instanceof THREE.Mesh) {
          targetMesh = faceMesh;
        }
        if (!targetMesh) return;

        let width = marker.scale?.x || marker.radius || 0.3;
        let height = marker.scale?.y || marker.radius || 0.3;
        const euler = new THREE.Euler(marker.rotation[0], marker.rotation[1], marker.rotation[2]);
        const depth = Math.max(width, height) * 1.5;
        const size = new THREE.Vector3(width, height, depth);

        const decalGeo = new DecalGeometry(targetMesh, pos, euler, size);
        const decalMat = new THREE.MeshPhysicalMaterial({
          color, transparent: true, opacity: 0.6, roughness: 0.2, clearcoat: 1,
          polygonOffset: true, polygonOffsetFactor: -1,
        });
        const decalMesh = new THREE.Mesh(decalGeo, decalMat);
        group.add(decalMesh);
      }
    });
  }, [markers, modelVersion]);

  // 4b. Renderizar puntos editables (trazado de referencia)
  useEffect(() => {
    const group = editablePointsGroupRef.current;
    if (!group) return;

    // Limpiar
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      child.traverse((m: any) => {
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mt: any) => mt.dispose());
          else m.material.dispose();
        }
      });
    }

    editablePoints.forEach((pt) => {
      const ptGroup = new THREE.Group();
      ptGroup.position.set(pt.x, pt.y, pt.z);
      ptGroup.userData.isEditablePoint = true;
      ptGroup.userData.editableId = pt.id;
      ptGroup.userData.lineIds = pt.lineIds ?? [];
      ptGroup.userData.epType = pt.type;
      ptGroup.userData.pointName = pt.name ?? 'Punto libre';

      const isIntersection = pt.type === 'intersection';
      const sphereColor = isIntersection ? new THREE.Color(0x00eeff) : new THREE.Color(0xffdd00);

      // Núcleo sólido blanco
      const coreGeo = new THREE.SphereGeometry(0.02, 12, 12);
      const coreMesh = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      coreMesh.renderOrder = 1001;
      ptGroup.add(coreMesh);

      // Halo exterior translúcido (igual que Clinical3D.tsx)
      const outerGeo = new THREE.SphereGeometry(0.04, 16, 16);
      const outerMat = new THREE.MeshPhysicalMaterial({
        color: sphereColor,
        emissive: sphereColor,
        emissiveIntensity: 0.7,
        transparent: true,
        opacity: 0.35,
        roughness: 0,
        transmission: 0.98,
        thickness: 0.3,
        ior: 1.5,
        clearcoat: 1.0,
        clearcoatRoughness: 0,
        depthTest: false,
      });
      const outerMesh = new THREE.Mesh(outerGeo, outerMat);
      outerMesh.renderOrder = 1001;
      ptGroup.add(outerMesh);

      group.add(ptGroup);
    });
  }, [editablePoints, modelVersion]);

  // 4c. Visibilidad de puntos editables
  useEffect(() => {
    if (editablePointsGroupRef.current) {
      editablePointsGroupRef.current.visible = showEditablePoints;
    }
  }, [showEditablePoints]);

  // 4d. Resaltar el punto editable seleccionado (escala mayor + color)
  useEffect(() => {
    const group = editablePointsGroupRef.current;
    if (!group) return;
    group.children.forEach(child => {
      const isSelected = selectedPointId && child.userData.editableId === selectedPointId;
      child.scale.setScalar(isSelected ? 1.8 : 1.0);
    });
  }, [selectedPointId, editablePoints]);

  // 4e. Renderizar líneas freehand (dibujo libre HA) — continuas, sobre superficie
  useEffect(() => {
    const grp = freehandGroupRef.current;
    if (!grp) return;
    // Limpiar
    while (grp.children.length > 0) {
      const child = grp.children[0] as any;
      grp.remove(child);
      child.traverse((m: any) => {
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mt: any) => mt.dispose());
          else m.material.dispose();
        }
      });
    }
    freehandLines.forEach(line => {
      if (line.points.length < 2) return;
      const pts = line.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
      const col = new THREE.Color(line.color);
      const r = (line.thickness || 1.0) * 0.003;
      const lineGrp = buildSurfaceTube(pts, col, 1.0, r, false);
      lineGrp.userData.freehandId = line.id;
      // También propagar el id a todos los meshes hijos (para raycast de selección)
      lineGrp.traverse(c => { if ((c as THREE.Mesh).isMesh) c.userData.freehandId = line.id; });
      // Highlight del elemento seleccionado
      if (selectedElementId === line.id) {
        lineGrp.traverse((c: any) => {
          if (c.isMesh && c.material) {
            c.material = c.material.clone();
            c.material.color = new THREE.Color(line.color).addScalar(0.3);
          }
        });
      }
      grp.add(lineGrp);
    });
  }, [freehandLines, selectedElementId, modelVersion]);

  // 4f. Renderizar shapes en superficie (círculos y rectángulos)
  useEffect(() => {
    const grp = shapesGroupRef.current;
    const faceMesh = faceMeshRef.current;
    if (!grp) return;
    // Limpiar
    while (grp.children.length > 0) {
      const child = grp.children[0] as any;
      grp.remove(child);
      child.traverse((m: any) => {
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mt: any) => mt.dispose());
          else m.material.dispose();
        }
      });
    }
    const rc = new THREE.Raycaster();
    surfaceShapes.forEach(shape => {
      const center = new THREE.Vector3(shape.center.x, shape.center.y, shape.center.z);
      const normal = new THREE.Vector3(shape.normal.x, shape.normal.y, shape.normal.z).normalize();
      const tangent = shape.tangent
        ? new THREE.Vector3(shape.tangent.x, shape.tangent.y, shape.tangent.z).normalize()
        : new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
      const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
      const col = new THREE.Color(shape.color);
      const r = (shape.thickness || 1.0) * 0.003;

      let pts: THREE.Vector3[] = [];

      if (shape.shapeType === 'circle') {
        const radius = shape.radius || 0.3;
        const N = 64;
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2;
          const wp = center.clone()
            .addScaledVector(tangent, Math.cos(a) * radius)
            .addScaledVector(bitangent, Math.sin(a) * radius);
          const origin = wp.clone().addScaledVector(normal, 2);
          rc.set(origin, new THREE.Vector3(0, 0, -1));
          if (faceMesh) {
            const hits = rc.intersectObject(faceMesh, true);
            pts.push(hits.length > 0 ? hits[0].point.clone() : wp);
          } else {
            pts.push(wp);
          }
        }
        pts = bridgeZ(pts, 0.20);
      } else {
        // Rectangle
        const hw = (shape.width || 0.4) / 2;
        const hh = (shape.height || 0.25) / 2;
        const corners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
        for (const [u, v] of corners) {
          const wp = center.clone()
            .addScaledVector(tangent, u)
            .addScaledVector(bitangent, v);
          const origin = wp.clone().addScaledVector(normal, 2);
          rc.set(origin, new THREE.Vector3(0, 0, -1));
          if (faceMesh) {
            const hits = rc.intersectObject(faceMesh, true);
            pts.push(hits.length > 0 ? hits[0].point.clone() : wp);
          } else {
            pts.push(wp);
          }
        }
      }

      if (pts.length >= 2) {
        const shapeGrp = buildSurfaceTube(pts, col, shape.opacity || 0.85, r, false);
        shapeGrp.userData.shapeId = shape.id;
        shapeGrp.traverse(c => { if ((c as THREE.Mesh).isMesh) c.userData.shapeId = shape.id; });
        if (selectedElementId === shape.id) {
          shapeGrp.traverse((c: any) => {
            if (c.isMesh && c.material) {
              c.material = c.material.clone();
              c.material.color = new THREE.Color(shape.color).addScalar(0.25);
            }
          });
        }
        grp.add(shapeGrp);
      }
    });
  }, [surfaceShapes, selectedElementId, modelVersion]);

  // 4. Renderizar líneas de referencia sobre la superficie del modelo
  useEffect(() => {
    const group = linesGroupRef.current;
    const faceMesh = faceMeshRef.current;
    if (!group || !faceMesh) return;

    // Limpiar líneas previas
    while (group.children.length > 0) {
      const child = group.children[0] as any;
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose());
        else child.material.dispose();
      }
    }

    // Construir raycaster interno para muestreo de superficie
    const sweepRaycaster = new THREE.Raycaster();

    /** Sweep vertical limitado entre yMin e yMax */
    const sweepVerticalLimited = (fixedX: number, yMin: number, yMax: number, steps = 80): THREE.Vector3[] => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= steps; i++) {
        const y = yMin + (i / steps) * (yMax - yMin);
        sweepRaycaster.set(new THREE.Vector3(fixedX, y, 50), new THREE.Vector3(0, 0, -1));
        const hits = sweepRaycaster.intersectObject(faceMesh, true);
        if (hits.length > 0) pts.push(hits[0].point.clone());
      }
      return bridgeZ(pts, 0.30);
    };

    referenceLines.forEach(line => {
      if (!line.visible) return;
      const color = new THREE.Color(line.color);
      const isDashed = line.dashed === true;
      const baseRadius = (line.thickness || 1.0) * 0.003;
      let pts: THREE.Vector3[] = [];

      if (line.type === 'vertical') {
        const xVal = line.anchor.x + line.offset;
        pts = (line.yMin !== undefined && line.yMax !== undefined)
          ? sweepVerticalLimited(xVal, line.yMin, line.yMax, 80)
          : sweepAxis(faceMesh, sweepRaycaster, 'x', xVal, -12, 8, 60);
      } else if (line.type === 'horizontal') {
        const yVal = line.anchor.y + line.offset;
        pts = sweepAxis(faceMesh, sweepRaycaster, 'y', yVal, -8, 8, 80);
      } else if (line.type === 'two-points' && line.anchors && line.anchors.length === 2) {
        const a = new THREE.Vector3(line.anchors[0].x, line.anchors[0].y, line.anchors[0].z);
        const b = new THREE.Vector3(line.anchors[1].x, line.anchors[1].y, line.anchors[1].z);
        const steps2 = 60;
        for (let i = 0; i <= steps2; i++) {
          const t = i / steps2;
          sweepRaycaster.set(new THREE.Vector3(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), 50), new THREE.Vector3(0, 0, -1));
          const hits = sweepRaycaster.intersectObject(faceMesh, true);
          if (hits.length > 0) pts.push(hits[0].point.clone());
        }
        pts = bridgeZ(pts, 0.30);
      }

      if (pts.length < 2) return;
      const lineGrp = buildSurfaceTube(pts, color, 1.0, baseRadius, isDashed);
      lineGrp.userData.lineId = line.id;
      lineGrp.traverse(c => { if ((c as THREE.Mesh).isMesh) c.userData.lineId = line.id; });
      group.add(lineGrp);
    });
  }, [referenceLines, modelVersion]);

  // 5. Renderizar líneas de límite de tercios (muy sutiles, casi imperceptibles)
  useEffect(() => {
    const group = boundariesGroupRef.current;
    const faceMesh = faceMeshRef.current;
    if (!group || !faceMesh) return;

    // Limpiar límites previos
    while (group.children.length > 0) {
      const child = group.children[0] as any;
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose());
        else child.material.dispose();
      }
    }

    if (!tercioBoundaries) return;

    const sweepRaycaster = new THREE.Raycaster();
    const sweepHoriz = (yVal: number): THREE.Vector3[] => {
      const pts: THREE.Vector3[] = [];
      const steps = 200; // más pasos → segmentos más cortos → interpolación más precisa
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = -8 + t * 16;
        const origin = new THREE.Vector3(x, yVal, 50);
        const dir = new THREE.Vector3(0, 0, -1);
        sweepRaycaster.set(origin, dir);
        const hits = sweepRaycaster.intersectObject(faceMesh, true);
        if (hits.length > 0) pts.push(hits[0].point.clone());
      }
      // Corregir hundimientos en cuencas oculares y nasales (igual que referenceLines)
      if (pts.length < 4) return pts;
      const out = pts.map(p => p.clone());
      let i = 1;
      const THRESHOLD = 0.30;
      while (i < out.length) {
        const zEntry = out[i - 1].z;
        if (zEntry - out[i].z > THRESHOLD) {
          let j = i + 1;
          while (j < out.length && out[j].z < zEntry - THRESHOLD * 0.5) j++;
          const exitIdx = Math.min(j, out.length - 1);
          const zExit = out[exitIdx].z;
          const span = exitIdx - (i - 1);
          for (let k = i; k < exitIdx; k++) {
            const t2 = (k - (i - 1)) / span;
            out[k].z = zEntry + t2 * (zExit - zEntry);
          }
          i = exitIdx + 1;
        } else {
          i++;
        }
      }
      return out;
    };

    // Todas las líneas de tercio en gris opaco, mismo estilo que las líneas de referencia punteadas
    const BOUNDARY_COLOR  = new THREE.Color('#aaaaaa');
    const BOUNDARY_RADIUS = 0.003;   // igual que makeSurfaceTube dashed
    // Spacing con while+lerp: coloca múltiples dots por segmento → densidad real igual a ref lines
    const BOUNDARY_SPACING = 0.040;  // igual que makeSurfaceTube dashed (ceja a ceja)
    const BOUNDARY_DOT_R  = BOUNDARY_RADIUS * 1.5;
    const BOUNDARY_HALO_R = BOUNDARY_RADIUS * 3;

    const boundaries = [
      tercioBoundaries.topY,
      tercioBoundaries.bottomY,
      tercioBoundaries.tercioMedioBottomY,
      tercioBoundaries.tercioInferiorBottomY,
    ];

    const makeDottedBoundary = (pts: THREE.Vector3[]) => {
      const subGroup = new THREE.Group();
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const segLen = pts[i].distanceTo(pts[i - 1]);
        acc += segLen;
        // while + lerp: coloca TODOS los dots que caben en el segmento actual
        while (acc >= BOUNDARY_SPACING) {
          acc -= BOUNDARY_SPACING;
          // posición interpolada dentro del segmento (misma densidad que ref lines)
          const t = segLen > 0 ? 1 - acc / segLen : 1;
          const pos = pts[i - 1].clone().lerp(pts[i], Math.max(0, Math.min(1, t)));
          // Halo exterior (igual que ref lines dashed)
          const haloGeo = new THREE.SphereGeometry(BOUNDARY_HALO_R, 6, 6);
          const haloMat = new THREE.MeshBasicMaterial({ color: BOUNDARY_COLOR, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false });
          const halo = new THREE.Mesh(haloGeo, haloMat);
          halo.position.copy(pos);
          halo.renderOrder = 999;
          subGroup.add(halo);
          // Núcleo opaco
          const dotGeo = new THREE.SphereGeometry(BOUNDARY_DOT_R, 6, 6);
          const dotMat = new THREE.MeshBasicMaterial({ color: BOUNDARY_COLOR, depthTest: false, depthWrite: false });
          const dot = new THREE.Mesh(dotGeo, dotMat);
          dot.position.copy(pos);
          dot.renderOrder = 1000;
          subGroup.add(dot);
        }
      }
      return subGroup;
    };

    for (const yVal of boundaries) {
      const pts = sweepHoriz(yVal);
      if (pts.length < 2) continue;
      group.add(makeDottedBoundary(pts));
    }
  }, [tercioBoundaries, modelVersion]);

  return <div ref={mountRef} className="absolute inset-0 w-full h-full cursor-crosshair" />;
};

// ==========================================
// COMPONENTE PÚBLICO: Clinical3DViewer
// ==========================================

export default function Clinical3DViewer({
  markers,
  zones = [],
  selectedPathology = 'botox',
  onMarkerPlaced,
  height = '400px',
  modelUrl = '/models/clinical/male_head.glb',
  readOnly = false,
  skipConfirmation = false,
  referenceLines = [],
  lineDrawingMode = null,
  onLinePointAnchored,
  editablePoints = [],
  showEditablePoints = true,
  pointMode = 'none',
  onEditablePointMoved,
  onEditablePointDeleted,
  onEditablePointClicked,
  onProjectedPositions,
  tercioBoundaries = null,
  selectedPointId,
  // Nuevas props HA
  freehandLines = [],
  surfaceShapes = [],
  activeTool = 'none',
  selectedElementId = null,
  pendingBrushColor = '#8b5cf6',
  pendingBrushThickness = 1.0,
  onFreehandLineComplete,
  onShapeComplete,
  onElementSelected,
}: Clinical3DViewerProps) {
  const [modelSource, setModelSource] = useState<{ type: 'url' | 'buffer'; data: string | ArrayBuffer }>({
    type: 'url',
    data: modelUrl,
  });
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [pendingMarker, setPendingMarker] = useState<any>(null);
  const [pendingZoneText, setPendingZoneText] = useState('');

  const handleMeshClick = (data: any) => {
    if (readOnly) return;
    if (skipConfirmation) {
      // Directly call onMarkerPlaced without internal dialog
      const marker: Marker3D = { ...data, pathologyId: selectedPathology, type: 'Puntual' as MarkerType, zone: '', id: Date.now().toString() };
      onMarkerPlaced?.(marker);
      return;
    }
    setPendingMarker({ ...data, pathologyId: selectedPathology });
    setPendingZoneText('');
  };

  const confirmMarker = (type: MarkerType) => {
    if (!pendingMarker) return;
    const marker: Marker3D = { ...pendingMarker, type, zone: pendingZoneText.trim() || 'Sin especificar', id: Date.now().toString() };
    onMarkerPlaced?.(marker);
    setPendingMarker(null);
    setPendingZoneText('');
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setModelError(false);
    setModelLoaded(false);
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        setModelSource({ type: 'buffer', data: e.target.result });
      }
    };
    reader.onerror = () => setModelError(true);
    reader.readAsArrayBuffer(file);
    event.target.value = '';
  };

  const isLoading = !modelLoaded && !modelError;

  return (
    <div className="relative rounded-xl overflow-hidden border border-gray-200" style={{ height }}>
      {/* 3D Canvas */}
      <div className="absolute inset-0">
        {!modelError && (
          <ThreeEngine
            modelSource={modelSource}
            markers={markers}
            zones={zones}
            readOnly={readOnly}
            onMeshClick={handleMeshClick}
            onLoaded={() => { setModelLoaded(true); setModelError(false); }}
            onError={() => setModelError(true)}
            referenceLines={referenceLines}
            lineDrawingMode={lineDrawingMode}
            onLinePointAnchored={onLinePointAnchored}
            editablePoints={editablePoints}
            showEditablePoints={showEditablePoints}
            pointMode={pointMode}
            onEditablePointMoved={onEditablePointMoved}
            onEditablePointDeleted={onEditablePointDeleted}
            onEditablePointClicked={onEditablePointClicked}
            onProjectedPositions={onProjectedPositions}
            tercioBoundaries={tercioBoundaries}
            selectedPointId={selectedPointId}
            freehandLines={freehandLines}
            surfaceShapes={surfaceShapes}
            activeTool={activeTool}
            selectedElementId={selectedElementId}
            pendingBrushColor={pendingBrushColor}
            pendingBrushThickness={pendingBrushThickness}
            onFreehandLineComplete={onFreehandLineComplete}
            onShapeComplete={onShapeComplete}
            onElementSelected={onElementSelected}
          />
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-800/90">
          <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mb-3" />
          <span className="text-sm text-slate-300">Cargando modelo 3D...</span>
        </div>
      )}

      {/* Error / Upload fallback */}
      {modelError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-800/90 p-4">
          <AlertCircle className="w-8 h-8 text-rose-400 mb-2" />
          <p className="text-sm text-slate-300 mb-3 text-center">No se pudo cargar el modelo. Sube el archivo manualmente.</p>
          <label className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg cursor-pointer text-sm">
            <Upload className="w-4 h-4" />
            Subir .glb
            <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>
      )}

      {/* Pending marker confirmation */}
      {pendingMarker && !readOnly && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-xl p-4 w-72 shadow-xl">
            <h4 className="font-semibold text-gray-800 mb-1 text-sm">Confirmar Marcación</h4>
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">Zona (escribir):</label>
              <input
                type="text"
                className="w-full p-1.5 border border-gray-200 rounded-lg text-xs focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50"
                placeholder="Ej: Glabela, Frente, Labio superior..."
                value={pendingZoneText}
                onChange={e => setPendingZoneText(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => confirmMarker('Puntual')}
                className="p-2 rounded-lg border border-gray-200 hover:bg-cyan-50 hover:border-cyan-300 text-center text-xs font-medium"
              >
                <div className="w-4 h-4 mx-auto mb-1 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.6)]" />
                Puntual
              </button>
              <button
                onClick={() => confirmMarker('Zonal')}
                className="p-2 rounded-lg border border-gray-200 hover:bg-violet-50 hover:border-violet-300 text-center text-xs font-medium"
              >
                <div className="w-4 h-4 mx-auto mb-1 rounded-full bg-gradient-to-br from-violet-300 to-violet-500" />
                Zonal
              </button>
            </div>
            <button onClick={() => setPendingMarker(null)} className="w-full mt-2 text-xs text-gray-400 hover:text-gray-600">
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
