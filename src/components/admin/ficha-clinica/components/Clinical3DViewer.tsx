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
  /** Puntos 3D ancla (extremos para handles) — o todos los puntos si no hay segments */
  points: { x: number; y: number; z: number }[];
  /** Sub-trayectorias de formas compuestas (flecha, abanico, helecho, malla) */
  segments?: { x: number; y: number; z: number }[][];
  color: string;
  /** Grosor relativo: 1.0 = radio base 0.003 */
  thickness: number;
  label?: string;
  /** Agrupación de múltiples líneas (legado — ya no se usa para nuevas formas) */
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
  | 'shape-arrow'      // drag A→B: flecha con cabeza en B
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
    // Hitbox invisible para cada punto dashed (radio 4× más grande para raycasting)
    const HIT_R = radius * 4;
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
        // Hitbox invisible
        const hitGeo = new THREE.SphereGeometry(HIT_R, 6, 6);
        const hitMat = new THREE.MeshBasicMaterial({ visible: false });
        const hitMesh = new THREE.Mesh(hitGeo, hitMat);
        hitMesh.position.copy(pts[i]);
        hitMesh.userData.isHitbox = true;
        grp.add(hitMesh);
      }
    }
  } else {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    const segments = Math.max(pts.length * 2, 60);
    // Tubo visual
    const tubeGeo = new THREE.TubeGeometry(curve, segments, radius, 6, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity });
    const mesh = new THREE.Mesh(tubeGeo, tubeMat);
    mesh.renderOrder = 999;
    grp.add(mesh);
    // Tubo hitbox invisible (radio 4× para raycasting confiable sobre tubos finos)
    const hitGeo = new THREE.TubeGeometry(curve, segments, radius * 4, 6, false);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitMesh = new THREE.Mesh(hitGeo, hitMat);
    hitMesh.userData.isHitbox = true;
    grp.add(hitMesh);
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
  /** Callback cuando el usuario mueve un endpoint de una línea freehand (resize/move) */
  onFreehandLineUpdated?: (id: string, points: { x: number; y: number; z: number }[], segments?: { x: number; y: number; z: number }[][]) => void;
  /** Callback cuando el usuario mueve o redimensiona una forma en superficie */
  onSurfaceShapeUpdated?: (id: string, update: { center?: { x: number; y: number; z: number }; normal?: { x: number; y: number; z: number }; tangent?: { x: number; y: number; z: number }; radius?: number; width?: number; height?: number }) => void;
  onGridStepChange?: (step: number) => void;
  /** Callback cuando el cursor snap a un punto en una línea (imán); null = sin snap */
  onSnapPointChange?: (pt: { x: number; y: number; z: number } | null) => void;
  /** Configuración de formas HA (abanico, malla, helecho) */
  haShapeConfig?: { fanLines: number; fanAngle: number; gridCells: number; fernBranches: number };
  /** IDs de puntos sin zona clasificada → se renderizan en celeste hasta completarlos */
  incompletePointIds?: string[];
  /** IDs de puntos resaltados (seleccion masiva) → escala naranja */
  highlightedPointIds?: string[];
  /** Callback cuando el cursor entra/sale de un punto editable en modo sin herramienta */
  onEditablePointHovered?: (id: string | null) => void;
  /** Callback cuando el usuario hace clic en el fondo vacío (sin malla) */
  onBackgroundClick?: () => void;
  /** Escala multiplicadora del tamaño de marcaciones puntuales (1.0 = default) */
  pointMarkerScale?: number;
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
  pointMarkerScale?: number;
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
  onFreehandLineUpdated?: (id: string, points: { x: number; y: number; z: number }[], segments?: { x: number; y: number; z: number }[][]) => void;
  onSurfaceShapeUpdated?: (id: string, update: { center?: { x: number; y: number; z: number }; normal?: { x: number; y: number; z: number }; tangent?: { x: number; y: number; z: number }; radius?: number; width?: number; height?: number }) => void;
  onGridStepChange?: (step: number) => void;
  /** Callback cuando el cursor snap a un punto en una línea (imán); null = sin snap */
  onSnapPointChange?: (pt: { x: number; y: number; z: number } | null) => void;
  /** Configuración de formas HA (abanico, malla, helecho) */
  haShapeConfig?: { fanLines: number; fanAngle: number; gridCells: number; fernBranches: number };
  incompletePointIds?: string[];
  highlightedPointIds?: string[];
  onEditablePointHovered?: (id: string | null) => void;
  onBackgroundClick?: () => void;
}> = ({
  modelSource, markers, zones, onMeshClick, onLoaded, onError, readOnly,
  referenceLines = [], lineDrawingMode, onLinePointAnchored,
  editablePoints = [], showEditablePoints = true, pointMode = 'none',
  onEditablePointMoved, onEditablePointDeleted, onEditablePointClicked,
  onProjectedPositions, tercioBoundaries = null, selectedPointId,
  freehandLines = [], surfaceShapes = [],
  activeTool = 'none', selectedElementId = null,
  pendingBrushColor = '#8b5cf6', pendingBrushThickness = 1.0,
  onFreehandLineComplete, onShapeComplete, onElementSelected, onFreehandLineUpdated, onSurfaceShapeUpdated, onGridStepChange, onSnapPointChange,
  haShapeConfig = { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 },
  incompletePointIds = [],
  highlightedPointIds = [],
  onEditablePointHovered,
  onBackgroundClick,
  pointMarkerScale = 1.0,
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
  // Handles de edición de líneas seleccionadas (resize + move)
  const handlesGroupRef = useRef<THREE.Group | null>(null);
  // Indicador visual del snap point (imán)
  const snapIndicatorRef = useRef<THREE.Mesh | null>(null);
  // Increments each time the model finishes loading so the markers effect re-runs
  const [modelVersion, setModelVersion] = useState(0);
  // Track two-point step inside engine for cursor feedback
  const twoPointStepRef = useRef<0 | 1>(0);

  const callbacks = useRef({
    onMeshClick, onLoaded, onError, zones, readOnly, lineDrawingMode, onLinePointAnchored,
    pointMode, onEditablePointMoved, onEditablePointDeleted, onEditablePointClicked, onProjectedPositions,
    activeTool, selectedElementId, pendingBrushColor, pendingBrushThickness,
    onFreehandLineComplete, onShapeComplete, onElementSelected, onFreehandLineUpdated, onSurfaceShapeUpdated, onGridStepChange, onSnapPointChange,
    haShapeConfig, freehandLines, surfaceShapes, incompletePointIds, highlightedPointIds, onEditablePointHovered, onBackgroundClick,
  });
  useEffect(() => {
    callbacks.current = {
      onMeshClick, onLoaded, onError, zones, readOnly, lineDrawingMode, onLinePointAnchored,
      pointMode, onEditablePointMoved, onEditablePointDeleted, onEditablePointClicked, onProjectedPositions,
      activeTool, selectedElementId, pendingBrushColor, pendingBrushThickness,
      onFreehandLineComplete, onShapeComplete, onElementSelected, onFreehandLineUpdated, onSurfaceShapeUpdated, onGridStepChange, onSnapPointChange,
      haShapeConfig, freehandLines, surfaceShapes, incompletePointIds, highlightedPointIds, onEditablePointHovered, onBackgroundClick,
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

    const handlesGroup = new THREE.Group();
    handlesGroupRef.current = handlesGroup;
    scene.add(handlesGroup);

    // Indicador visual del snap point (estrella/punto pulsante para imán)
    const snapGeo = new THREE.SphereGeometry(0.025, 10, 10);
    const snapMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0 });
    const snapMesh = new THREE.Mesh(snapGeo, snapMat);
    snapMesh.renderOrder = 1005;
    snapIndicatorRef.current = snapMesh;
    scene.add(snapMesh);

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

    // ── Handle drag (resize/move de líneas/formas seleccionadas) ──────────────────
    let handleDragRole: 'start' | 'end' | 'body' | 'shape-body' | 'shape-scale' | null = null;
    let handleDragLineId: string | null = null;
    let handleBodyStartSurface: THREE.Vector3 | null = null;
    let handleBodyOriginalPoints: { x: number; y: number; z: number }[] | null = null;
    let handleBodyOriginalSegments: { x: number; y: number; z: number }[][] | null = null;
    let handleBodyShapeStartSurface: THREE.Vector3 | null = null;
    let handleBodyOriginalShapeCenter: { x: number; y: number; z: number } | null = null;
    let handleBodyOriginalShapeData: SurfaceShape | null = null;

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

    // ── Grid 3-step state ─────────────────────────────────────────────────
    let gridStep = 0; // 0=esperando 1er clic, 1=arrastrando ancho, 2=arrastrando largo
    let gridAnchorA: THREE.Vector3 | null = null;
    let gridDirMain: THREE.Vector3 | null = null;   // dirección principal (primer click → segundo)
    let gridDirPerp: THREE.Vector3 | null = null;   // dirección perpendicular (para el ancho)
    let gridHalfWidth = 0;
    let gridLen = 0;

    // ── Estado snap / imán ────────────────────────────────────────────────
    let currentSnapPt: THREE.Vector3 | null = null; // punto snap activo
    let snapPtIsVertex = false; // true si es un vértice/intersección
    let snapFrameCount = 0;

    const clearSnap = () => {
      if (currentSnapPt) {
        currentSnapPt = null;
        snapPtIsVertex = false;
        if (snapIndicatorRef.current) (snapIndicatorRef.current.material as THREE.MeshBasicMaterial).opacity = 0;
        callbacks.current.onSnapPointChange?.(null);
      }
    };

    /** Encuentra el punto más cercano de un conjunto de segmentos al cursor 3D */
    const closestPointOnSegments = (
      pts: { x: number; y: number; z: number }[],
      query: THREE.Vector3,
      vertexSnapDist: number,
      lineDist: number
    ): { pt: THREE.Vector3; isVertex: boolean } | null => {
      if (pts.length < 2) return null;
      let bestPt: THREE.Vector3 | null = null;
      let bestDist = Infinity;
      let bestIsVertex = false;
      const q = query;
      // Check vertices first (stronger magnet)
      for (const raw of pts) {
        const v = new THREE.Vector3(raw.x, raw.y, raw.z);
        const d = v.distanceTo(q);
        if (d < vertexSnapDist && d < bestDist) {
          bestDist = d;
          bestPt = v.clone();
          bestIsVertex = true;
        }
      }
      if (bestPt) return { pt: bestPt, isVertex: true };
      // Check segments
      for (let i = 0; i < pts.length - 1; i++) {
        const a = new THREE.Vector3(pts[i].x, pts[i].y, pts[i].z);
        const b = new THREE.Vector3(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        const ab = b.clone().sub(a);
        const abLen = ab.length();
        if (abLen < 0.0001) continue;
        const t = Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / (abLen * abLen)));
        const closest = a.clone().addScaledVector(ab, t);
        const d = closest.distanceTo(q);
        if (d < lineDist && d < bestDist) {
          bestDist = d;
          bestPt = closest.clone();
          bestIsVertex = false;
        }
      }
      return bestPt ? { pt: bestPt, isVertex: bestIsVertex } : null;
    };

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

    // ── Proyectar punto 3D sobre la superficie real del modelo ─────────────
    const projectToSurface = (pt: THREE.Vector3): THREE.Vector3 => {
      if (!faceMeshRef.current) return pt;
      const rc = new THREE.Raycaster();
      const candidates: THREE.Vector3[] = [];

      // Dir 1: desde la cámara hacia el punto
      if (cameraRef.current) {
        const dir = pt.clone().sub(cameraRef.current.position).normalize();
        rc.set(cameraRef.current.position, dir);
        const h = rc.intersectObject(faceMeshRef.current, true);
        if (h.length > 0) candidates.push(h[0].point.clone());
      }
      // Dir 2: sweep frontal Z→-Z
      rc.set(new THREE.Vector3(pt.x, pt.y, 12), new THREE.Vector3(0, 0, -1));
      const h2 = rc.intersectObject(faceMeshRef.current, true);
      if (h2.length > 0) candidates.push(h2[0].point.clone());
      // Dir 3: sweep trasero -Z→Z
      rc.set(new THREE.Vector3(pt.x, pt.y, -12), new THREE.Vector3(0, 0, 1));
      const h3 = rc.intersectObject(faceMeshRef.current, true);
      if (h3.length > 0) candidates.push(h3[0].point.clone());
      // Dir 4: desde arriba Y→-Y
      rc.set(new THREE.Vector3(pt.x, 12, pt.z), new THREE.Vector3(0, -1, 0));
      const h4 = rc.intersectObject(faceMeshRef.current, true);
      if (h4.length > 0) candidates.push(h4[0].point.clone());
      // Dir 5: desde abajo -Y→Y
      rc.set(new THREE.Vector3(pt.x, -12, pt.z), new THREE.Vector3(0, 1, 0));
      const h5 = rc.intersectObject(faceMeshRef.current, true);
      if (h5.length > 0) candidates.push(h5[0].point.clone());

      if (candidates.length === 0) return pt;
      // Devolver el candidato más cercano al punto original
      return candidates.reduce((best, c) => c.distanceTo(pt) < best.distanceTo(pt) ? c : best);
    };

    // Genera N puntos interpolados entre from y to, todos proyectados a la piel
    const surfaceLine = (from: THREE.Vector3, to: THREE.Vector3, steps = 14): THREE.Vector3[] => {
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s <= steps; s++) {
        pts.push(projectToSurface(from.clone().lerp(to, s / steps)));
      }
      return bridgeZ(pts, 0.20);
    };

    // ── Hover highlight — variables de estado puro (no React) ─────────────
    const hoverMouse = new THREE.Vector2(-999, -999);
    let prevHoveredId: string | null = null;  // ID en vez de ref (evita ref stale)
    let prevHoveredEpId: string | null = null; // hover sobre puntos editables
    let hoverFrameCount = 0;

    /** Aumenta opacidad y marca `hoverBase` en los meshes del grupo */
    const applyHover = (lineGrp: THREE.Object3D) => {
      lineGrp.traverse((c: any) => {
        // Nunca afectar los hitbox invisibles
        if (c.isMesh && c.material && !c.userData.isHitbox) {
          if (c.userData.hoverBase === undefined) c.userData.hoverBase = c.material.opacity ?? 1;
          c.material.opacity = Math.min(1.0, (c.userData.hoverBase) * 1.6 + 0.2);
          c.material.needsUpdate = true;
        }
      });
    };

    /** Restaura opacidad original del grupo */
    const restoreHover = (lineGrp: THREE.Object3D) => {
      lineGrp.traverse((c: any) => {
        if (c.isMesh && c.material && c.userData.hoverBase !== undefined && !c.userData.isHitbox) {
          c.material.opacity = c.userData.hoverBase;
          c.material.needsUpdate = true;
          delete c.userData.hoverBase;
        }
      });
    };

    /** Restaura hover del grupo que tiene el ID dado (busca en la escena viva) */
    const restoreHoverById = (id: string) => {
      [freehandGroupRef.current, shapesGroupRef.current, linesGroupRef.current].forEach(ref => {
        ref?.children.forEach((child: any) => {
          const cId = child.userData.freehandId || child.userData.shapeId || child.userData.lineId;
          if (cId === id) restoreHover(child);
        });
      });
    };
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

      // ── Prioridad 0: handle drag (resize/move de línea seleccionada) ───────
      if (handlesGroupRef.current && handlesGroupRef.current.children.length > 0 && cameraRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        // Cada "handle" es ahora un Group (visual + hitbox); colectar todos los meshes
        const handleMeshes: THREE.Object3D[] = [];
        handlesGroupRef.current.children.forEach(grpH => grpH.traverse(c => { if ((c as THREE.Mesh).isMesh) handleMeshes.push(c); }));
        const handleHits = raycaster.intersectObjects(handleMeshes, false);
        if (handleHits.length > 0) {
          // Subir al Group del handle para obtener role y lineId
          let hitGrp: THREE.Object3D | null = handleHits[0].object;
          while (hitGrp && !hitGrp.userData.handleRole) hitGrp = hitGrp.parent;
          if (hitGrp?.userData.handleRole) {
            handleDragRole = hitGrp.userData.handleRole;
            handleDragLineId = hitGrp.userData.handleLineId;
            handleBodyStartSurface = null;
            handleBodyOriginalPoints = null;
            handleBodyOriginalSegments = null;
            handleBodyShapeStartSurface = null;
            handleBodyOriginalShapeCenter = null;
            handleBodyOriginalShapeData = null;
            // Pre-capturar estado de compound shapes y shapes para cualquier tipo de handle drag
            const precLine = callbacks.current.freehandLines?.find((l: FreehandLine) => l.id === handleDragLineId);
            if (precLine?.segments) {
              handleBodyOriginalPoints = [...precLine.points];
              handleBodyOriginalSegments = precLine.segments.map(s => [...s]);
            }
            const precShape = callbacks.current.surfaceShapes?.find((s: SurfaceShape) => s.id === handleDragLineId);
            if (precShape) {
              handleBodyOriginalShapeCenter = { ...precShape.center };
              handleBodyOriginalShapeData = { ...precShape };
            }
            if (controlsRef.current) controlsRef.current.enabled = false;
            isDragging = false;
            return;
          }
        }
      }

      // ── Modo freehand brush ────────────────────────────────────────────────
      if (tool === 'freehand-brush' || tool === 'straight-line' || tool === 'shape-arrow' || tool === 'ha-fan' || tool === 'ha-fern') {
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
      // ── Grid 3-step: preview en tiempo real ───────────────────────────────
      if (gridStep > 0 && faceMeshRef.current && cameraRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const gridHovHits = raycaster.intersectObject(faceMeshRef.current, true);
        if (gridHovHits.length > 0 && brushPreviewGroupRef.current) {
          const hoverPt = gridHovHits[0].point.clone();
          clearBrushPreview();
          const col = new THREE.Color(callbacks.current.pendingBrushColor || '#8b5cf6');
          const th = (callbacks.current.pendingBrushThickness || 1.0) * 0.003;
          if (gridStep === 1 && gridAnchorA) {
            // Preview: línea de ancho (dirección perpendicular)
            brushPreviewGroupRef.current.add(buildSurfaceTube(
              surfaceLine(gridAnchorA, hoverPt, 6), col, 0.45, th, false
            ));
          } else if (gridStep === 2 && gridAnchorA && gridDirPerp && gridDirMain) {
            // Preview: mallado completo con ancho fijado y nuevo largo
            const cfg = callbacks.current.haShapeConfig || { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };
            const N = cfg.gridCells;
            const rawLen = hoverPt.clone().sub(gridAnchorA).dot(gridDirMain);
            const previewLen = Math.abs(rawLen);
            if (previewLen > 0.05) {
              const dirM = gridDirMain.clone().multiplyScalar(rawLen > 0 ? 1 : -1);
              for (let i = 0; i <= N; i++) {
                const base = gridAnchorA.clone().addScaledVector(gridDirPerp, ((i / N) - 0.5) * gridHalfWidth * 2);
                brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(base, base.clone().addScaledVector(dirM, previewLen), 8), col, 0.4, th, false));
              }
              for (let j = 0; j <= N; j++) {
                const base = gridAnchorA.clone().addScaledVector(dirM, (j / N) * previewLen);
                const p1 = base.clone().addScaledVector(gridDirPerp, -gridHalfWidth);
                const p2 = base.clone().addScaledVector(gridDirPerp, gridHalfWidth);
                brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(p1, p2, 8), col, 0.4, th, false));
              }
            }
          }
        }
        return;
      }

      // ── Handle drag en línea seleccionada ─────────────────────────────────
      if (handleDragRole && handleDragLineId && faceMeshRef.current && cameraRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const hits = raycaster.intersectObject(faceMeshRef.current, true);
        if (hits.length > 0) {
          const surfPt = hits[0].point;
          if (handleDragRole === 'start' || handleDragRole === 'end') {
            if (handleBodyOriginalSegments && handleBodyOriginalPoints) {
              // Forma compuesta: escalar+rotar desde ancla opuesta (no trasladar)
              const draggedOrigIdx = handleDragRole === 'start' ? 0 : handleBodyOriginalPoints.length - 1;
              const fixedOrigIdx = handleDragRole === 'start' ? handleBodyOriginalPoints.length - 1 : 0;
              const ptFixed = handleBodyOriginalPoints[fixedOrigIdx];
              const ptDragged = handleBodyOriginalPoints[draggedOrigIdx];
              const ptFixedV = new THREE.Vector3(ptFixed.x, ptFixed.y, ptFixed.z);
              const ptDraggedV = new THREE.Vector3(ptDragged.x, ptDragged.y, ptDragged.z);
              const origLen = ptDraggedV.distanceTo(ptFixedV);
              if (origLen > 0.01) {
                const newLen = surfPt.distanceTo(ptFixedV);
                const scale = newLen / origLen;
                const origDir = ptDraggedV.clone().sub(ptFixedV).normalize();
                const newDir = surfPt.clone().sub(ptFixedV).normalize();
                const q = newDir.lengthSq() > 0.001 ? new THREE.Quaternion().setFromUnitVectors(origDir, newDir) : new THREE.Quaternion();
                // Mover todos los handles por la transformación
                handlesGroupRef.current?.children.forEach((h: any) => {
                  const hOrigIdx = h.userData.handleRole === 'start' ? 0 : h.userData.handleRole === 'end' ? handleBodyOriginalPoints!.length - 1 : Math.floor(handleBodyOriginalPoints!.length / 2);
                  const hOrig = handleBodyOriginalPoints![hOrigIdx];
                  const v = new THREE.Vector3(hOrig.x, hOrig.y, hOrig.z).sub(ptFixedV).applyQuaternion(q).multiplyScalar(scale);
                  h.position.copy(ptFixedV.clone().add(v));
                });
                clearBrushPreview();
                const dLine = callbacks.current.freehandLines?.find((l: FreehandLine) => l.id === handleDragLineId);
                if (dLine && brushPreviewGroupRef.current) {
                  const col = new THREE.Color(dLine.color);
                  const th = (dLine.thickness || 1.0) * 0.003;
                  handleBodyOriginalSegments.forEach(seg => {
                    const moved = seg.map(p => {
                      const v = new THREE.Vector3(p.x, p.y, p.z).sub(ptFixedV).applyQuaternion(q).multiplyScalar(scale);
                      return ptFixedV.clone().add(v);
                    });
                    brushPreviewGroupRef.current!.add(buildSurfaceTube(moved, col, 0.5, th, false));
                  });
                }
              }
            } else {
              // Línea simple: mover el handle y previsualizar entre los dos extremos
              const handle = handlesGroupRef.current?.children.find(
                (h: any) => h.userData.handleRole === handleDragRole && h.userData.handleLineId === handleDragLineId
              );
              if (handle) handle.position.copy(surfPt);
              const startH = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'start');
              const endH = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'end');
              if (startH && endH) {
                clearBrushPreview();
                const line = callbacks.current.freehandLines?.find((l: FreehandLine) => l.id === handleDragLineId);
                if (line) {
                  const col = new THREE.Color(line.color);
                  const th = (line.thickness || 1.0) * 0.003;
                  const previewPts = surfaceLine(startH.position.clone(), endH.position.clone(), 10);
                  if (brushPreviewGroupRef.current) {
                    brushPreviewGroupRef.current.add(buildSurfaceTube(previewPts, col, 0.5, th, false));
                  }
                }
              }
            }
          } else if (handleDragRole === 'body') {
            // Capturar el punto de inicio del body drag
            if (!handleBodyStartSurface) {
              handleBodyStartSurface = surfPt.clone();
              const line = callbacks.current.freehandLines?.find((l: FreehandLine) => l.id === handleDragLineId);
              handleBodyOriginalPoints = line ? [...line.points] : null;
              handleBodyOriginalSegments = line?.segments ? line.segments.map(s => [...s]) : null;
            }
            if (handleBodyOriginalPoints && handleBodyStartSurface) {
              const offset = surfPt.clone().sub(handleBodyStartSurface);
              // Mover todos los handles por el offset
              handlesGroupRef.current?.children.forEach((h: any) => {
                const role = h.userData.handleRole;
                const origIdx = role === 'start' ? 0 : role === 'end' ? handleBodyOriginalPoints!.length - 1 : Math.floor(handleBodyOriginalPoints!.length / 2);
                const orig = handleBodyOriginalPoints![origIdx];
                h.position.set(orig.x + offset.x, orig.y + offset.y, orig.z + offset.z);
              });
              // Preview en tiempo real de la línea/forma desplazada
              clearBrushPreview();
              const line = callbacks.current.freehandLines?.find((l: FreehandLine) => l.id === handleDragLineId);
              if (line && brushPreviewGroupRef.current) {
                const col = new THREE.Color(line.color);
                const th = (line.thickness || 1.0) * 0.003;
                if (handleBodyOriginalSegments) {
                  // Forma compuesta: mover todos los segmentos
                  handleBodyOriginalSegments.forEach(seg => {
                    const movedSeg = seg.map(p => new THREE.Vector3(p.x + offset.x, p.y + offset.y, p.z + offset.z));
                    brushPreviewGroupRef.current!.add(buildSurfaceTube(movedSeg, col, 0.5, th, false));
                  });
                } else {
                  // Línea simple
                  const movedPts = handleBodyOriginalPoints.map(p =>
                    new THREE.Vector3(p.x + offset.x, p.y + offset.y, p.z + offset.z)
                  );
                  brushPreviewGroupRef.current.add(buildSurfaceTube(movedPts, col, 0.5, th, false));
                }
              }
            }
          } else if (handleDragRole === 'shape-body') {
            // Arrastrar una forma (SurfaceShape) — mover su centro
            if (!handleBodyShapeStartSurface) {
              handleBodyShapeStartSurface = surfPt.clone();
              const shape = callbacks.current.surfaceShapes?.find((s: SurfaceShape) => s.id === handleDragLineId);
              handleBodyOriginalShapeCenter = shape ? { ...shape.center } : null;
            }
            if (handleBodyOriginalShapeCenter && handleBodyShapeStartSurface) {
              const bodyHandle = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'shape-body');
              if (bodyHandle) bodyHandle.position.copy(surfPt);
            }
          } else if (handleDragRole === 'shape-scale') {
            // Arrastrar handle de escala — mover handle visualmente
            const scaleHandle = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'shape-scale');
            if (scaleHandle) scaleHandle.position.copy(surfPt);
          }
          isDragging = true;
        }
        return;
      }

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
          const isSnap = tool === 'straight-line' || tool === 'shape-arrow' || tool === 'ha-fan' || tool === 'ha-grid' || tool === 'ha-fern';
          if (moved || isSnap) {
            if (isSnap) {
              if (brushPoints.length === 1) brushPoints.push(hits[0].point.clone());
              else brushPoints[brushPoints.length - 1] = hits[0].point.clone();
            } else {
              brushPoints.push(hits[0].point.clone());
              brushLastScreenPos = { x: e.clientX, y: e.clientY };
            }

            clearBrushPreview();
            const ptA = brushPoints[0];
            const ptB = brushPoints[brushPoints.length - 1];
            if (ptA && ptB && brushPreviewGroupRef.current) {
              const col = new THREE.Color(callbacks.current.pendingBrushColor || '#8b5cf6');
              const th = (callbacks.current.pendingBrushThickness || 1.0) * 0.003;
              const cfg = callbacks.current.haShapeConfig || { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };

              if (tool === 'freehand-brush') {
                // Brush: mostrar todos los puntos acumulados
                if (brushPoints.length >= 2) {
                  brushPreviewGroupRef.current.add(buildSurfaceTube(brushPoints, col, 0.6, th, false));
                }
              } else if (tool === 'straight-line') {
                // Línea recta proyectada a la superficie
                brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(ptA, ptB), col, 0.55, th, false));
              } else if (tool === 'shape-arrow') {
                // Flecha: línea + cabeza de flecha
                brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(ptA, ptB), col, 0.55, th, false));
                const dir = ptB.clone().sub(ptA).normalize();
                const len = ptA.distanceTo(ptB);
                const arrowLen = Math.max(0.05, len * 0.25);
                let perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
                if (perp.lengthSq() < 0.01) perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, 1)).normalize();
                const tL = ptB.clone().addScaledVector(dir, -arrowLen).addScaledVector(perp, arrowLen * 0.5);
                const tR = ptB.clone().addScaledVector(dir, -arrowLen).addScaledVector(perp, -arrowLen * 0.5);
                brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(ptB, tL, 6), col, 0.55, th, false));
                brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(ptB, tR, 6), col, 0.55, th, false));
              } else if (tool === 'ha-fan') {
                // Ghost completo del abanico
                const dir = ptB.clone().sub(ptA).normalize();
                const len = ptA.distanceTo(ptB);
                const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
                const N = cfg.fanLines;
                for (let i = 0; i < N; i++) {
                  const t = N === 1 ? 0 : (i / (N - 1) - 0.5) * 2;
                  const rad = (t * cfg.fanAngle * Math.PI) / 180;
                  const fanDir = dir.clone().addScaledVector(perp, Math.tan(rad)).normalize();
                  const endPt = ptA.clone().addScaledVector(fanDir, len);
                  brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(ptA, endPt, 10), col, 0.45, th, false));
                }
              } else if (tool === 'ha-grid') {
                // Ghost completo de la malla — perpendicular correcta en 3D
                const dir = ptB.clone().sub(ptA);
                const dirNorm = dir.clone().normalize();
                let perp = new THREE.Vector3().crossVectors(dirNorm, new THREE.Vector3(0, 1, 0)).normalize();
                if (perp.lengthSq() < 0.001) perp = new THREE.Vector3().crossVectors(dirNorm, new THREE.Vector3(0, 0, 1)).normalize();
                const lenDir = dir.length();
                const lenPerp = lenDir * 0.65;
                const N = cfg.gridCells;
                // Líneas paralelas a `dir`
                for (let i = 0; i <= N; i++) {
                  const base = ptA.clone().addScaledVector(perp, (i / N - 0.5) * lenPerp);
                  brushPreviewGroupRef.current!.add(buildSurfaceTube(surfaceLine(base, base.clone().addScaledVector(dirNorm, lenDir), 8), col, 0.45, th, false));
                }
                // Líneas paralelas a `perp`
                for (let j = 0; j <= N; j++) {
                  const base = ptA.clone().addScaledVector(dirNorm, (j / N) * lenDir);
                  const p1 = base.clone().addScaledVector(perp, -lenPerp / 2);
                  const p2 = base.clone().addScaledVector(perp, lenPerp / 2);
                  brushPreviewGroupRef.current!.add(buildSurfaceTube(surfaceLine(p1, p2, 8), col, 0.45, th, false));
                }
              } else if (tool === 'ha-fern') {
                // Ghost completo del helecho
                const dir = ptB.clone().sub(ptA);
                const len = dir.length();
                const perp = new THREE.Vector3(-dir.normalize().y, dir.normalize().x, 0).normalize();
                brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(ptA, ptB, 12), col, 0.5, th, false));
                const N = cfg.fernBranches;
                for (let i = 1; i <= N; i++) {
                  const t = i / (N + 1);
                  const base = ptA.clone().addScaledVector(dir.clone().normalize(), len * t);
                  const branchLen = len * 0.25 * (1 - t * 0.5);
                  const sign = i % 2 === 0 ? 1 : -1;
                  const tip = base.clone().addScaledVector(perp, sign * branchLen);
                  brushPreviewGroupRef.current.add(buildSurfaceTube(surfaceLine(base, tip, 7), col, 0.35, th * 0.7, false));
                }
              }
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
          const rc = new THREE.Raycaster();
          if (tool === 'shape-circle') {
            const N = 48;
            const bitangent = new THREE.Vector3().crossVectors(shapeAnchor.normal, shapeAnchor.tangent).normalize();
            const circlePts: THREE.Vector3[] = [];
            for (let i = 0; i <= N; i++) {
              const a = (i / N) * Math.PI * 2;
              const wp = shapeAnchor.point.clone()
                .addScaledVector(shapeAnchor.tangent, Math.cos(a) * r)
                .addScaledVector(bitangent, Math.sin(a) * r);
              const origin = wp.clone().add(shapeAnchor.normal.clone().multiplyScalar(2));
              rc.set(origin, shapeAnchor.normal.clone().negate());
              const hits2 = rc.intersectObject(faceMeshRef.current!, true);
              circlePts.push(hits2.length > 0 ? hits2[0].point.clone() : wp);
            }
            if (circlePts.length >= 2) {
              brushPreviewGroupRef.current.add(buildSurfaceTube(circlePts, col, 0.7, th, false));
            }
          } else {
            // Rectángulo: previsualizar con 4 lados separados (sin Catmull-Rom en esquinas)
            const bitangent = new THREE.Vector3().crossVectors(shapeAnchor.normal, shapeAnchor.tangent).normalize();
            const hw = shapeCurrentW / 2, hh = shapeCurrentH / 2;
            const rectCorners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
            const corners3DPrev = rectCorners.map(([u, v]) => {
              const wp = shapeAnchor!.point.clone()
                .addScaledVector(shapeAnchor!.tangent, u)
                .addScaledVector(bitangent, v);
              const origin = wp.clone().addScaledVector(shapeAnchor!.normal, 2);
              rc.set(origin, shapeAnchor!.normal.clone().negate());
              const hits2 = rc.intersectObject(faceMeshRef.current!, true);
              return hits2.length > 0 ? hits2[0].point.clone() : wp;
            });
            for (let i = 0; i < 4; i++) {
              const a3 = corners3DPrev[i];
              const b3 = corners3DPrev[(i + 1) % 4];
              const sidePrev: THREE.Vector3[] = [];
              for (let s = 0; s <= 8; s++) {
                const wp = a3.clone().lerp(b3, s / 8);
                const origin = wp.clone().addScaledVector(shapeAnchor!.normal, 2);
                rc.set(origin, shapeAnchor!.normal.clone().negate());
                const hits2 = rc.intersectObject(faceMeshRef.current!, true);
                sidePrev.push(hits2.length > 0 ? hits2[0].point.clone() : wp);
              }
              if (sidePrev.length >= 2)
                brushPreviewGroupRef.current.add(buildSurfaceTube(sidePrev, col, 0.7, th, false));
            }
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
      // ── Finalizar handle drag ──────────────────────────────────────────────
      if (handleDragRole && handleDragLineId) {
        const role = handleDragRole;
        const lineId = handleDragLineId;
        handleDragRole = null;
        handleDragLineId = null;
        if (controlsRef.current) controlsRef.current.enabled = true;
        clearBrushPreview(); // limpiar preview en tiempo real
        isDragging = true;

        // ── shape-body: mover el centro de una SurfaceShape + re-proyectar ───────────────
        if (role === 'shape-body') {
          const bodyHandle = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'shape-body');
          if (bodyHandle) {
            const projCenter = projectToSurface(bodyHandle.position.clone());
            const update: Record<string, any> = { center: { x: projCenter.x, y: projCenter.y, z: projCenter.z } };
            // Re-estimar normal/tangent en el nuevo centro para que la forma se pegue correctamente
            if (faceMeshRef.current) {
              const rc2 = new THREE.Raycaster();
              rc2.set(new THREE.Vector3(projCenter.x, projCenter.y, 12), new THREE.Vector3(0, 0, -1));
              const fHits2 = rc2.intersectObject(faceMeshRef.current, true);
              if (fHits2.length > 0 && fHits2[0].face) {
                const n2 = fHits2[0].face.normal.clone().transformDirection(fHits2[0].object.matrixWorld).normalize();
                const up2 = new THREE.Vector3(0, 1, 0);
                let t2 = new THREE.Vector3().crossVectors(n2, up2).normalize();
                if (t2.lengthSq() < 0.01) t2 = new THREE.Vector3().crossVectors(n2, new THREE.Vector3(1, 0, 0)).normalize();
                update.normal = { x: n2.x, y: n2.y, z: n2.z };
                update.tangent = { x: t2.x, y: t2.y, z: t2.z };
              }
            }
            callbacks.current.onSurfaceShapeUpdated?.(lineId, update);
          }
          handleBodyShapeStartSurface = null;
          handleBodyOriginalShapeCenter = null;
          handleBodyOriginalShapeData = null;
          return;
        }

        // ── shape-scale: redimensionar radio/ancho/alto de una SurfaceShape ───────────
        if (role === 'shape-scale') {
          const scaleHandle = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'shape-scale');
          const origShape = handleBodyOriginalShapeData;
          if (scaleHandle && origShape) {
            const center = new THREE.Vector3(origShape.center.x, origShape.center.y, origShape.center.z);
            const newDist = scaleHandle.position.distanceTo(center);
            if (origShape.shapeType === 'circle') {
              callbacks.current.onSurfaceShapeUpdated?.(lineId, { radius: Math.max(0.05, newDist) });
            } else {
              const sNorm = new THREE.Vector3(origShape.normal.x, origShape.normal.y, origShape.normal.z).normalize();
              const sTan = origShape.tangent
                ? new THREE.Vector3(origShape.tangent.x, origShape.tangent.y, origShape.tangent.z).normalize()
                : new THREE.Vector3().crossVectors(sNorm, new THREE.Vector3(0, 1, 0)).normalize();
              const sBi = new THREE.Vector3().crossVectors(sNorm, sTan).normalize();
              const sv = scaleHandle.position.clone().sub(center);
              callbacks.current.onSurfaceShapeUpdated?.(lineId, {
                width: Math.max(0.1, Math.abs(sv.dot(sTan)) * 2),
                height: Math.max(0.1, Math.abs(sv.dot(sBi)) * 2),
              });
            }
          }
          handleBodyShapeStartSurface = null;
          handleBodyOriginalShapeCenter = null;
          handleBodyOriginalShapeData = null;
          return;
        }

        const line = callbacks.current.freehandLines?.find((l: FreehandLine) => l.id === lineId);
        if (!line) return;

        if (role === 'start' || role === 'end') {
          if (line.segments && handleBodyOriginalPoints && handleBodyOriginalSegments) {
            // Forma compuesta: escalar+rotar desde ancla opuesta + re-proyectar a superficie
            const handle = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === role);
            if (handle) {
              const draggedOrigIdx = role === 'start' ? 0 : handleBodyOriginalPoints.length - 1;
              const fixedOrigIdx = role === 'start' ? handleBodyOriginalPoints.length - 1 : 0;
              const ptFixed = handleBodyOriginalPoints[fixedOrigIdx];
              const ptDragged = handleBodyOriginalPoints[draggedOrigIdx];
              const ptFixedV = new THREE.Vector3(ptFixed.x, ptFixed.y, ptFixed.z);
              const ptDraggedV = new THREE.Vector3(ptDragged.x, ptDragged.y, ptDragged.z);
              const origLen = ptDraggedV.distanceTo(ptFixedV);
              if (origLen > 0.01) {
                const newLen = handle.position.distanceTo(ptFixedV);
                const scale = newLen / origLen;
                const origDir = ptDraggedV.clone().sub(ptFixedV).normalize();
                const newDir = handle.position.clone().sub(ptFixedV).normalize();
                const q = newDir.lengthSq() > 0.001 ? new THREE.Quaternion().setFromUnitVectors(origDir, newDir) : new THREE.Quaternion();
                const transformPt = (p: { x: number; y: number; z: number }): THREE.Vector3 => {
                  const v = new THREE.Vector3(p.x, p.y, p.z).sub(ptFixedV).applyQuaternion(q).multiplyScalar(scale);
                  return ptFixedV.clone().add(v);
                };
                const newPoints = handleBodyOriginalPoints.map(p => {
                  const proj = projectToSurface(transformPt(p));
                  return { x: proj.x, y: proj.y, z: proj.z };
                });
                const newSegs = handleBodyOriginalSegments.map(seg => {
                  const movedA = projectToSurface(transformPt(seg[0]));
                  const movedB = projectToSurface(transformPt(seg[seg.length - 1]));
                  return surfaceLine(movedA, movedB, Math.max(seg.length, 8)).map(p => ({ x: p.x, y: p.y, z: p.z }));
                });
                callbacks.current.onFreehandLineUpdated?.(lineId, newPoints, newSegs);
              }
            }
            handleBodyStartSurface = null;
            handleBodyOriginalPoints = null;
            handleBodyOriginalSegments = null;
          } else if (!line.segments) {
            // Línea simple: re-proyectar entre los nuevos extremos
            const handle = handlesGroupRef.current?.children.find(
              (h: any) => h.userData.handleRole === role
            );
            if (handle) {
              const newPos = handle.position;
              const isStart = role === 'start';
              const otherPt = isStart
                ? new THREE.Vector3(line.points[line.points.length - 1].x, line.points[line.points.length - 1].y, line.points[line.points.length - 1].z)
                : new THREE.Vector3(line.points[0].x, line.points[0].y, line.points[0].z);
              const newPts = isStart
                ? surfaceLine(newPos.clone(), otherPt)
                : surfaceLine(otherPt, newPos.clone());
              callbacks.current.onFreehandLineUpdated?.(lineId, newPts.map(p => ({ x: p.x, y: p.y, z: p.z })));
            }
          }
        } else if (role === 'body' && handleBodyOriginalPoints && handleBodyStartSurface) {
          if (handleBodyOriginalSegments) {
            // Forma compuesta: traducir + re-proyectar cada segmento a la superficie
            const startH = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'start');
            const bodyH = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'body');
            if (startH && bodyH) {
              const offset = new THREE.Vector3(
                startH.position.x - handleBodyOriginalPoints[0].x,
                startH.position.y - handleBodyOriginalPoints[0].y,
                startH.position.z - handleBodyOriginalPoints[0].z,
              );
              const newPoints = handleBodyOriginalPoints.map(p => {
                const proj = projectToSurface(new THREE.Vector3(p.x + offset.x, p.y + offset.y, p.z + offset.z));
                return { x: proj.x, y: proj.y, z: proj.z };
              });
              const newSegments = handleBodyOriginalSegments.map(seg => {
                const movedA = projectToSurface(new THREE.Vector3(seg[0].x + offset.x, seg[0].y + offset.y, seg[0].z + offset.z));
                const movedB = projectToSurface(new THREE.Vector3(seg[seg.length-1].x + offset.x, seg[seg.length-1].y + offset.y, seg[seg.length-1].z + offset.z));
                return surfaceLine(movedA, movedB, Math.max(seg.length, 8)).map(p => ({ x: p.x, y: p.y, z: p.z }));
              });
              callbacks.current.onFreehandLineUpdated?.(lineId, newPoints, newSegments);
            }
          } else {
            // Línea simple: re-proyectar entre handles extremos desplazados
            const startHandle = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'start');
            const endHandle = handlesGroupRef.current?.children.find((h: any) => h.userData.handleRole === 'end');
            if (startHandle && endHandle) {
              const newPts = surfaceLine(startHandle.position.clone(), endHandle.position.clone());
              callbacks.current.onFreehandLineUpdated?.(lineId, newPts.map(p => ({ x: p.x, y: p.y, z: p.z })));
            }
          }
          handleBodyStartSurface = null;
          handleBodyOriginalPoints = null;
          handleBodyOriginalSegments = null;
        }
        return;
      }

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

        // Línea recta (straight-line): proyectada a superficie
        if (tool === 'straight-line' && ptA && ptB) {
          const pts = surfaceLine(ptA, ptB);
          callbacks.current.onFreehandLineComplete?.({
            id: `fh-${Date.now()}`,
            points: pts.map(p => ({ x: p.x, y: p.y, z: p.z })),
            color: col,
            thickness: th,
          });
        }
        // Flecha (shape-arrow): forma compuesta de un solo FreehandLine con segments
        else if (tool === 'shape-arrow' && ptA && ptB) {
          const shaftPts = surfaceLine(ptA, ptB);
          const dir = ptB.clone().sub(ptA).normalize();
          const len = ptA.distanceTo(ptB);
          const arrowLen = Math.max(0.05, len * 0.25);
          let perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
          if (perp.lengthSq() < 0.01) perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, 1)).normalize();
          const tL = ptB.clone().addScaledVector(dir, -arrowLen).addScaledVector(perp, arrowLen * 0.5);
          const tR = ptB.clone().addScaledVector(dir, -arrowLen).addScaledVector(perp, -arrowLen * 0.5);
          callbacks.current.onFreehandLineComplete?.({
            id: `fh-${Date.now()}-arrow`,
            points: [ptA, ptB].map(p => ({ x: p.x, y: p.y, z: p.z })),
            segments: [
              shaftPts.map(p => ({ x: p.x, y: p.y, z: p.z })),
              surfaceLine(ptB, tL, 8).map(p => ({ x: p.x, y: p.y, z: p.z })),
              surfaceLine(ptB, tR, 8).map(p => ({ x: p.x, y: p.y, z: p.z })),
            ],
            color: col, thickness: th, technique_preset: 'Flecha',
          });
        }
        // Abanico (fan): forma compuesta de un solo FreehandLine con segments
        else if (tool === 'ha-fan' && ptA && ptB) {
          const cfg = callbacks.current.haShapeConfig || { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };
          const dir = ptB.clone().sub(ptA).normalize();
          const len = ptA.distanceTo(ptB);
          if (len > 0.05) {
            const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
            const N = cfg.fanLines;
            const fanSegs: { x: number; y: number; z: number }[][] = [];
            for (let i = 0; i < N; i++) {
              const t = N === 1 ? 0 : (i / (N - 1) - 0.5) * 2;
              const rad = (t * cfg.fanAngle * Math.PI) / 180;
              const fanDir = dir.clone().addScaledVector(perp, Math.tan(rad)).normalize();
              const endPt = ptA.clone().addScaledVector(fanDir, len);
              fanSegs.push(surfaceLine(ptA, endPt).map(p => ({ x: p.x, y: p.y, z: p.z })));
            }
            callbacks.current.onFreehandLineComplete?.({
              id: `fh-${Date.now()}-fan`,
              points: [ptA, ptB].map(p => ({ x: p.x, y: p.y, z: p.z })),
              segments: fanSegs,
              color: col, thickness: th, technique_preset: 'Abanico',
            });
          }
        }
        // Malla (grid): forma compuesta de un solo FreehandLine con segments
        else if (tool === 'ha-grid' && ptA && ptB) {
          const cfg = callbacks.current.haShapeConfig || { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };
          const dir = ptB.clone().sub(ptA);
          const dirNorm = dir.clone().normalize();
          let perp = new THREE.Vector3().crossVectors(dirNorm, new THREE.Vector3(0, 1, 0)).normalize();
          if (perp.lengthSq() < 0.001) perp = new THREE.Vector3().crossVectors(dirNorm, new THREE.Vector3(0, 0, 1)).normalize();
          const lenDir = dir.length();
          const lenPerp = lenDir * 0.65;
          const N = cfg.gridCells;
          const gridSegs: { x: number; y: number; z: number }[][] = [];
          for (let i = 0; i <= N; i++) {
            const base = ptA.clone().addScaledVector(perp, (i / N - 0.5) * lenPerp);
            gridSegs.push(surfaceLine(base, base.clone().addScaledVector(dirNorm, lenDir), 12).map(p => ({x:p.x,y:p.y,z:p.z})));
          }
          for (let j = 0; j <= N; j++) {
            const base = ptA.clone().addScaledVector(dirNorm, (j / N) * lenDir);
            gridSegs.push(surfaceLine(base.clone().addScaledVector(perp, -lenPerp/2), base.clone().addScaledVector(perp, lenPerp/2), 12).map(p => ({x:p.x,y:p.y,z:p.z})));
          }
          callbacks.current.onFreehandLineComplete?.({
            id: `fh-${Date.now()}-grid`,
            points: [ptA, ptB].map(p => ({ x: p.x, y: p.y, z: p.z })),
            segments: gridSegs,
            color: col, thickness: th, technique_preset: 'Malla',
          });
        }
        // Helecho (fern): forma compuesta de un solo FreehandLine con segments
        else if (tool === 'ha-fern' && ptA && ptB) {
          const cfg = callbacks.current.haShapeConfig || { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };
          const dir = ptB.clone().sub(ptA);
          const len = dir.length();
          if (len > 0.05) {
            const fernSegs: { x: number; y: number; z: number }[][] = [];
            fernSegs.push(surfaceLine(ptA, ptB).map(p => ({ x: p.x, y: p.y, z: p.z })));
            const perp = new THREE.Vector3(-dir.normalize().y, dir.normalize().x, 0).normalize();
            const N = cfg.fernBranches;
            for (let i = 1; i <= N; i++) {
              const t = i / (N + 1);
              const base = ptA.clone().addScaledVector(dir.clone().normalize(), len * t);
              const branchLen = len * 0.25 * (1 - t * 0.5);
              const sign = i % 2 === 0 ? 1 : -1;
              const tip = base.clone().addScaledVector(perp, sign * branchLen);
              fernSegs.push(surfaceLine(base, tip, 8).map(p => ({ x: p.x, y: p.y, z: p.z })));
            }
            callbacks.current.onFreehandLineComplete?.({
              id: `fh-${Date.now()}-fern`,
              points: [ptA, ptB].map(p => ({ x: p.x, y: p.y, z: p.z })),
              segments: fernSegs,
              color: col, thickness: th, technique_preset: 'Helecho',
            });
          }
        }
        // Freehand brush normal
        else if (tool === 'freehand-brush' && brushPoints.length >= 2) {
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

      // ── Modo brush/shape/straight/ha (excepto ha-grid que usa click): ignorar onClick ──
      if (tool === 'freehand-brush' || tool === 'shape-circle' || tool === 'shape-rect'
        || tool === 'straight-line' || tool === 'shape-arrow' || tool === 'ha-fan' || tool === 'ha-fern') return;

      // ── ha-grid: flujo 3-step basado en clicks ─────────────────────────────
      if (tool === 'ha-grid') {
        if (!faceMeshRef.current || !cameraRef.current) return;
        const rect2 = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect2.left) / rect2.width) * 2 - 1;
        mouse.y = -((event.clientY - rect2.top) / rect2.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const gridHits = raycaster.intersectObject(faceMeshRef.current, true);
        if (gridHits.length === 0) return;
        const clickPt = gridHits[0].point.clone();

        if (gridStep === 0) {
          // 1er clic: fijar esquina A
          gridAnchorA = clickPt;
          gridStep = 1;
          callbacks.current.onGridStepChange?.(1);
        } else if (gridStep === 1 && gridAnchorA) {
          // 2do clic: fijar dirección y ancho
          const raw = clickPt.clone().sub(gridAnchorA);
          gridDirPerp = raw.clone().normalize(); // perpendicular al grid (ancho)
          gridHalfWidth = raw.length() / 2;
          // La dirección principal es perpendicular al ancho
          let mainDir = new THREE.Vector3().crossVectors(gridDirPerp, new THREE.Vector3(0, 1, 0)).normalize();
          if (mainDir.lengthSq() < 0.001) mainDir = new THREE.Vector3().crossVectors(gridDirPerp, new THREE.Vector3(0, 0, 1)).normalize();
          gridDirMain = mainDir;
          gridStep = 2;
          callbacks.current.onGridStepChange?.(2);
        } else if (gridStep === 2 && gridAnchorA && gridDirMain && gridDirPerp) {
          // 3er clic: fijar longitud y generar el grid
          const rawLen = clickPt.clone().sub(gridAnchorA);
          gridLen = rawLen.dot(gridDirMain);
          if (Math.abs(gridLen) < 0.05) { gridStep = 0; return; }
          const lenSign = gridLen > 0 ? 1 : -1;
          gridLen = Math.abs(gridLen);
          const ptA = gridAnchorA;
          const dirM = gridDirMain.clone().multiplyScalar(lenSign);

          const cfg = callbacks.current.haShapeConfig || { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };
          const N = cfg.gridCells;
          const col = callbacks.current.pendingBrushColor || '#8b5cf6';
          const th = callbacks.current.pendingBrushThickness || 1.0;
          const gridSegs3: { x: number; y: number; z: number }[][] = [];

          // Líneas a lo largo de dirM (N+1 líneas)
          for (let i = 0; i <= N; i++) {
            const t = i / N;
            const base = ptA.clone().addScaledVector(gridDirPerp, (t - 0.5) * gridHalfWidth * 2);
            gridSegs3.push(surfaceLine(base, base.clone().addScaledVector(dirM, gridLen), 12).map(p => ({x:p.x,y:p.y,z:p.z})));
          }
          // Líneas a lo largo de gridDirPerp (N+1 líneas)
          for (let j = 0; j <= N; j++) {
            const t = j / N;
            const base = ptA.clone().addScaledVector(dirM, t * gridLen);
            const p1 = base.clone().addScaledVector(gridDirPerp, -gridHalfWidth);
            const p2 = base.clone().addScaledVector(gridDirPerp, gridHalfWidth);
            gridSegs3.push(surfaceLine(p1, p2, 12).map(p => ({x:p.x,y:p.y,z:p.z})));
          }
          callbacks.current.onFreehandLineComplete?.({
            id: `fh-${Date.now()}-grid3`,
            points: [ptA, ptA.clone().addScaledVector(dirM, gridLen)].map(p => ({x:p.x,y:p.y,z:p.z})),
            segments: gridSegs3,
            color: col, thickness: th, technique_preset: 'Malla',
          });
          // Reset
          gridStep = 0;
          gridAnchorA = null;
          gridDirMain = null;
          gridDirPerp = null;
          gridHalfWidth = 0;
          gridLen = 0;
          clearBrushPreview();
          callbacks.current.onGridStepChange?.(0);
        }
        return;
      }

      // ── Selección de elementos existentes — desactivada en modo "añadir punto" ─
      if ((tool === 'none' || tool === 'freehand-poly') && callbacks.current.pointMode !== 'add') {
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
      if (intersects.length === 0) {
        callbacks.current.onBackgroundClick?.();
        return;
      }
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

      // ── Modo añadir punto libre (con snap/imán si hay punto activo) ──────
      if (callbacks.current.pointMode === 'add') {
        // Si hay un snap point activo sobre una línea, usar ese punto
        const usePt = currentSnapPt ? currentSnapPt.clone() : point;
        const nAdd = intersect.face ? intersect.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(intersect.object.matrixWorld)).normalize() : new THREE.Vector3(0, 1, 0);
        const ptAdd = usePt.clone().addScaledVector(nAdd, 0.03);
        callbacks.current.onMeshClick({
          position: { x: ptAdd.x, y: ptAdd.y, z: ptAdd.z },
          rotation: [0, 0, 0],
          normal: { x: nAdd.x, y: nAdd.y, z: nAdd.z },
          zone: '',
          radius: 0.3,
          isAddPointMode: true,
          snappedToLine: currentSnapPt !== null,
          isVertex: snapPtIsVertex,
        });
        return;
      }

      // ── Modo marcación normal (snap al hacer clic libre sobre el modelo) ──
      if (callbacks.current.readOnly) return;
      // Usar snap point si está activo
      const finalPoint = currentSnapPt ? currentSnapPt.clone() : point;
      const n = intersect.face ? intersect.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      const nTransform = new THREE.Matrix3().getNormalMatrix(intersect.object.matrixWorld);
      n.applyMatrix3(nTransform).normalize();

      const dummy = new THREE.Object3D();
      dummy.position.copy(finalPoint);
      dummy.lookAt(finalPoint.clone().add(n));

      callbacks.current.onMeshClick({
        position: { x: finalPoint.x, y: finalPoint.y, z: finalPoint.z },
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

    // Hover mouse tracking (sin pointerEvents pesados — solo posición)
    const onHoverMouseMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      hoverMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      hoverMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    const onHoverMouseLeave = () => {
      hoverMouse.set(-999, -999);
      if (prevHoveredId) { restoreHoverById(prevHoveredId); prevHoveredId = null; }
      if (prevHoveredEpId) {
        editablePointsGroupRef.current?.children.forEach((g: THREE.Object3D) => {
          if (g.userData.editableId === prevHoveredEpId) {
            const isHL = callbacks.current.highlightedPointIds?.includes(prevHoveredEpId!);
            g.scale.setScalar(selectedEditableId === prevHoveredEpId ? 1.8 : isHL ? 1.5 : 1.0);
          }
        });
        callbacks.current.onEditablePointHovered?.(null);
        prevHoveredEpId = null;
      }
      clearSnap();
      if (renderer.domElement) renderer.domElement.style.cursor = 'crosshair';
    };
    renderer.domElement.addEventListener('mousemove', onHoverMouseMove);
    renderer.domElement.addEventListener('mouseleave', onHoverMouseLeave);

    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        // ── Hover detection cada 2 frames (sin overhead significativo) ─────
        hoverFrameCount++;
        if (hoverFrameCount % 2 === 0 && !brushActive && !shapeAnchor) {
          const hoverRc = new THREE.Raycaster();
          hoverRc.setFromCamera(hoverMouse, cameraRef.current);
          const hoverMeshes: THREE.Object3D[] = [];
          // Recopilar meshes de los 3 grupos con su parent group
          const meshToLineGrp = new Map<THREE.Object3D, THREE.Object3D>();
          const addGroup = (ref: typeof freehandGroupRef) => {
            ref.current?.children.forEach(lineGrp => {
              lineGrp.traverse(c => {
                if ((c as THREE.Mesh).isMesh) {
                  hoverMeshes.push(c);
                  meshToLineGrp.set(c, lineGrp);
                }
              });
            });
          };
          addGroup(freehandGroupRef);
          addGroup(shapesGroupRef);
          addGroup(linesGroupRef);

          let newHoveredId: string | null = null;
          let newHoveredGroup: THREE.Object3D | null = null;
          if (hoverMeshes.length > 0) {
            const hoverHits = hoverRc.intersectObjects(hoverMeshes, false);
            if (hoverHits.length > 0) {
              const lineGrp = meshToLineGrp.get(hoverHits[0].object);
              if (lineGrp) {
                newHoveredId = lineGrp.userData.freehandId || lineGrp.userData.shapeId || lineGrp.userData.lineId || null;
                newHoveredGroup = lineGrp;
              }
            }
          }

          if (newHoveredId !== prevHoveredId) {
            if (prevHoveredId) restoreHoverById(prevHoveredId);
            if (newHoveredGroup) applyHover(newHoveredGroup);
            prevHoveredId = newHoveredId;
            if (!newHoveredId) clearSnap();
            // Cambiar cursor
            if (renderer.domElement) {
              renderer.domElement.style.cursor = newHoveredId ? 'pointer' : 'crosshair';
            }
          }

          // ── Hover sobre puntos editables (solo cuando no hay herramienta activa) ──
          const canHoverEp = callbacks.current.pointMode === 'none' && callbacks.current.activeTool === 'none';
          if (canHoverEp) {
            const epMeshes: THREE.Object3D[] = [];
            const meshToEpGrp = new Map<THREE.Object3D, THREE.Object3D>();
            editablePointsGroupRef.current?.children.forEach(epGrp => {
              epGrp.traverse(c => {
                if ((c as THREE.Mesh).isMesh) { epMeshes.push(c); meshToEpGrp.set(c, epGrp); }
              });
            });
            let newHoveredEpId: string | null = null;
            if (epMeshes.length > 0) {
              const epHits = hoverRc.intersectObjects(epMeshes, false);
              if (epHits.length > 0) {
                const epGrp = meshToEpGrp.get(epHits[0].object);
                newHoveredEpId = epGrp?.userData.editableId ?? null;
              }
            }
            if (newHoveredEpId !== prevHoveredEpId) {
              if (prevHoveredEpId) {
                editablePointsGroupRef.current?.children.forEach((g: THREE.Object3D) => {
                  if (g.userData.editableId === prevHoveredEpId) {
                    const isHL = callbacks.current.highlightedPointIds?.includes(prevHoveredEpId!);
                    g.scale.setScalar(selectedEditableId === prevHoveredEpId ? 1.8 : isHL ? 1.5 : 1.0);
                  }
                });
              }
              if (newHoveredEpId) {
                editablePointsGroupRef.current?.children.forEach((g: THREE.Object3D) => {
                  if (g.userData.editableId === newHoveredEpId)
                    g.scale.setScalar(selectedEditableId === newHoveredEpId ? 1.8 : 1.5);
                });
              }
              prevHoveredEpId = newHoveredEpId;
              callbacks.current.onEditablePointHovered?.(newHoveredEpId);
              if (!newHoveredId) {
                if (renderer.domElement)
                  renderer.domElement.style.cursor = newHoveredEpId ? 'pointer' : 'crosshair';
              }
            }
          } else if (prevHoveredEpId) {
            // Si se activó una herramienta, limpiar hover de puntos
            editablePointsGroupRef.current?.children.forEach((g: THREE.Object3D) => {
              if (g.userData.editableId === prevHoveredEpId)
                g.scale.setScalar(selectedEditableId === prevHoveredEpId ? 1.8 : 1.0);
            });
            callbacks.current.onEditablePointHovered?.(null);
            prevHoveredEpId = null;
          }

          // ── Snap / imán: SOLO cuando el usuario está en modo "añadir punto" ──
          // Si no hay herramienta activa → el hover es para EDICIÓN, no snap
          const canSnap = callbacks.current.pointMode === 'add';
          if (canSnap && prevHoveredId && cameraRef.current) {
            // Proyectar hoverMouse al punto 3D en la malla
            const snapRc = new THREE.Raycaster();
            snapRc.setFromCamera(hoverMouse, cameraRef.current);
            const snapFaceHit = faceMeshRef.current
              ? snapRc.intersectObject(faceMeshRef.current, true)
              : [];
            if (snapFaceHit.length > 0) {
              const query3D = snapFaceHit[0].point;
              // Buscar la línea iluminada en freehandLines
              const snapLine = callbacks.current.freehandLines?.find((l: FreehandLine) =>
                l.id === prevHoveredId
              );
              if (snapLine && snapLine.points.length >= 2) {
                const VERTEX_DIST = 0.25; // distancia de snap a vértice
                const LINE_DIST   = 0.18; // distancia de snap a segmento
                const result = closestPointOnSegments(snapLine.points, query3D, VERTEX_DIST, LINE_DIST);
                if (result) {
                  currentSnapPt = result.pt;
                  snapPtIsVertex = result.isVertex;
                  if (snapIndicatorRef.current) {
                    const mat = snapIndicatorRef.current.material as THREE.MeshBasicMaterial;
                    snapIndicatorRef.current.position.copy(result.pt);
                    mat.color.setHex(result.isVertex ? 0xffff00 : 0x00ffff);
                    mat.opacity = result.isVertex ? 0.9 : 0.7;
                    snapIndicatorRef.current.scale.setScalar(result.isVertex ? 1.4 : 1.0);
                  }
                  callbacks.current.onSnapPointChange?.({ x: result.pt.x, y: result.pt.y, z: result.pt.z });
                } else {
                  clearSnap();
                }
              } else {
                clearSnap();
              }
            }
          } else if (!canSnap) {
            clearSnap();
          }
        }

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
        dom.removeEventListener('mousemove', onHoverMouseMove);
        dom.removeEventListener('mouseleave', onHoverMouseLeave);
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

      // ponytail: scale first, then offset — wrong order breaks body model (center at y=90)
      const maxDim = Math.max(size.x, size.y, size.z);
      const scaleFactor = 5 / (maxDim || 1);
      model.scale.setScalar(scaleFactor);
      model.position.set(-center.x * scaleFactor, -center.y * scaleFactor, -center.z * scaleFactor);

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
        const coreGeo = new THREE.SphereGeometry(0.06 * pointMarkerScale, 12, 12);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        markerGroup.add(new THREE.Mesh(coreGeo, coreMat));

        const outerGeo = new THREE.SphereGeometry(0.12 * pointMarkerScale, 16, 16);
        const outerMat = new THREE.MeshPhysicalMaterial({
          color, emissive: color, emissiveIntensity: 1.5,
          transparent: true, opacity: 0.8, roughness: 0, transmission: 0.9, thickness: 0.5,
        });
        markerGroup.add(new THREE.Mesh(outerGeo, outerMat));
        group.add(markerGroup);

      } else if (marker.type === 'Zonal') {
        // Esfera grande semi-transparente — más robusta que DecalGeometry para cualquier modelo
        const markerGroup = new THREE.Group();
        markerGroup.position.copy(pos);
        markerGroup.userData.markerId = marker.id ?? `m-${Date.now()}`;

        const radius = marker.radius || 0.22;

        const haloGeo = new THREE.SphereGeometry(radius, 18, 18);
        const haloMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.28, depthWrite: false, depthTest: false,
        });
        markerGroup.add(new THREE.Mesh(haloGeo, haloMat));

        const ringGeo = new THREE.TorusGeometry(radius, radius * 0.06, 8, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color, depthWrite: false, depthTest: false });
        markerGroup.add(new THREE.Mesh(ringGeo, ringMat));

        const coreGeo = new THREE.SphereGeometry(radius * 0.18, 8, 8);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
        markerGroup.add(new THREE.Mesh(coreGeo, coreMat));

        group.add(markerGroup);
      }
    });
  }, [markers, modelVersion, pointMarkerScale]);

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
      const isIncomplete = incompletePointIds.includes(pt.id);
      // Incompleto (solo volumen, sin zona) → celeste; normal → cyan/amarillo según tipo
      const sphereColor = isIncomplete
        ? new THREE.Color(0x56cffc)
        : (isIntersection ? new THREE.Color(0x00eeff) : new THREE.Color(0xffdd00));

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
      outerMesh.userData.baseEmissive = sphereColor.clone(); // para restaurar tras highlight
      ptGroup.add(outerMesh);

      group.add(ptGroup);
    });
  }, [editablePoints, incompletePointIds, modelVersion]);

  // 4c. Visibilidad de puntos editables
  useEffect(() => {
    if (editablePointsGroupRef.current) {
      editablePointsGroupRef.current.visible = showEditablePoints;
    }
  }, [showEditablePoints]);

  // 4d. Resaltar punto seleccionado (escala) y puntos en seleccion masiva (naranja)
  useEffect(() => {
    const group = editablePointsGroupRef.current;
    if (!group) return;
    group.children.forEach(child => {
      const epId = child.userData.editableId;
      const isSelected = !!selectedPointId && epId === selectedPointId;
      const isHighlighted = highlightedPointIds.includes(epId);
      child.scale.setScalar(isSelected ? 1.8 : isHighlighted ? 1.5 : 1.0);
      child.traverse((c: any) => {
        if (c.isMesh && c.userData.baseEmissive !== undefined && c.material?.emissive !== undefined) {
          if (isHighlighted && !isSelected) {
            c.material.emissive.set(0xff6600);
            c.material.emissiveIntensity = 1.1;
          } else {
            c.material.emissive.copy(c.userData.baseEmissive);
            c.material.emissiveIntensity = 0.7;
          }
          c.material.needsUpdate = true;
        }
      });
    });
  }, [selectedPointId, highlightedPointIds, editablePoints]);

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
      const col = new THREE.Color(line.color);
      const r = (line.thickness || 1.0) * 0.003;
      const isSelected = selectedElementId === line.id;

      if (line.segments && line.segments.length > 0) {
        // Forma compuesta: un grupo maestro con sub-grupos por segmento
        const masterGrp = new THREE.Group();
        masterGrp.userData.freehandId = line.id;
        line.segments.forEach(segPts => {
          if (segPts.length < 2) return;
          const pts3 = segPts.map(p => new THREE.Vector3(p.x, p.y, p.z));
          const segGrp = buildSurfaceTube(pts3, col, 1.0, r, false);
          segGrp.traverse((c: any) => { if (c.isMesh) c.userData.freehandId = line.id; });
          if (isSelected) {
            segGrp.traverse((c: any) => {
              if (c.isMesh && c.material && !c.userData.isHitbox) {
                c.material = c.material.clone();
                c.material.color = new THREE.Color(line.color).addScalar(0.3);
              }
            });
          }
          masterGrp.add(segGrp);
        });
        grp.add(masterGrp);
      } else {
        // Línea simple
        if (line.points.length < 2) return;
        const pts = line.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
        const lineGrp = buildSurfaceTube(pts, col, 1.0, r, false);
        lineGrp.userData.freehandId = line.id;
        lineGrp.traverse(c => { if ((c as THREE.Mesh).isMesh) c.userData.freehandId = line.id; });
        if (isSelected) {
          lineGrp.traverse((c: any) => {
            if (c.isMesh && c.material) {
              c.material = c.material.clone();
              c.material.color = new THREE.Color(line.color).addScalar(0.3);
            }
          });
        }
        grp.add(lineGrp);
      }
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

      if (shape.shapeType === 'circle') {
        const radius = shape.radius || 0.3;
        const N = 64;
        let circlePts: THREE.Vector3[] = [];
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2;
          const wp = center.clone()
            .addScaledVector(tangent, Math.cos(a) * radius)
            .addScaledVector(bitangent, Math.sin(a) * radius);
          const origin = wp.clone().addScaledVector(normal, 2);
          rc.set(origin, normal.clone().negate());
          if (faceMesh) {
            const hits = rc.intersectObject(faceMesh, true);
            circlePts.push(hits.length > 0 ? hits[0].point.clone() : wp);
          } else {
            circlePts.push(wp);
          }
        }
        circlePts = bridgeZ(circlePts, 0.20);
        const shapeGrp = buildSurfaceTube(circlePts, col, shape.opacity || 0.85, r, false);
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
      } else {
        // Rectángulo: 4 lados separados para evitar esquinas redondeadas por Catmull-Rom
        const hw = (shape.width || 0.4) / 2;
        const hh = (shape.height || 0.25) / 2;
        const cornerOffsets: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
        // Proyectar las 4 esquinas a la superficie
        const corners3D = cornerOffsets.map(([u, v]) => {
          const wp = center.clone().addScaledVector(tangent, u).addScaledVector(bitangent, v);
          const origin = wp.clone().addScaledVector(normal, 2);
          rc.set(origin, normal.clone().negate());
          if (faceMesh) {
            const hits = rc.intersectObject(faceMesh, true);
            return hits.length > 0 ? hits[0].point.clone() : wp;
          }
          return wp;
        });
        const rectGrp = new THREE.Group();
        rectGrp.userData.shapeId = shape.id;
        const SIDE_STEPS = 10;
        for (let i = 0; i < 4; i++) {
          const a3 = corners3D[i];
          const b3 = corners3D[(i + 1) % 4];
          // Proyectar puntos intermedios del lado a la superficie (línea recta proyectada)
          const sidePts: THREE.Vector3[] = [];
          for (let s = 0; s <= SIDE_STEPS; s++) {
            const wp = a3.clone().lerp(b3, s / SIDE_STEPS);
            const origin = wp.clone().addScaledVector(normal, 2);
            rc.set(origin, normal.clone().negate());
            if (faceMesh) {
              const hits = rc.intersectObject(faceMesh, true);
              sidePts.push(hits.length > 0 ? hits[0].point.clone() : wp);
            } else {
              sidePts.push(wp);
            }
          }
          const sideGrp = buildSurfaceTube(sidePts, col, shape.opacity || 0.85, r, false);
          sideGrp.traverse((c: any) => { if (c.isMesh) c.userData.shapeId = shape.id; });
          if (selectedElementId === shape.id) {
            sideGrp.traverse((c: any) => {
              if (c.isMesh && c.material && !c.userData.isHitbox) {
                c.material = c.material.clone();
                c.material.color = new THREE.Color(shape.color).addScalar(0.25);
              }
            });
          }
          rectGrp.add(sideGrp);
        }
        grp.add(rectGrp);
      }
    });
  }, [surfaceShapes, selectedElementId, modelVersion]);

  // 4g. Handles de edición para el elemento seleccionado (línea freehand o shape)
  useEffect(() => {
    const grp = handlesGroupRef.current;
    if (!grp) return;
    // Limpiar handles previos
    while (grp.children.length > 0) {
      const c = grp.children[0] as any;
      grp.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
    if (!selectedElementId) return;

    const makeHandle = (color: number, role: string, pt: { x: number; y: number; z: number }, lineId: string) => {
      const grp2 = new THREE.Group();
      grp2.position.set(pt.x, pt.y, pt.z);
      grp2.userData.handleRole = role;
      grp2.userData.handleLineId = lineId;
      // Esfera visual
      const geo = new THREE.SphereGeometry(0.018, 10, 10);
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.92 });
      const vis = new THREE.Mesh(geo, mat);
      vis.renderOrder = 1003;
      grp2.add(vis);
      // Hitbox invisible para facilitar el click
      const hGeo = new THREE.SphereGeometry(0.06, 8, 8);
      const hMat = new THREE.MeshBasicMaterial({ visible: false });
      const hit = new THREE.Mesh(hGeo, hMat);
      hit.userData.isHitbox = true;
      grp2.add(hit);
      return grp2;
    };

    // Verificar si es una forma SurfaceShape
    const shape = surfaceShapes.find(s => s.id === selectedElementId);
    if (shape) {
      // Handle cuerpo (naranja): mover la forma
      grp.add(makeHandle(0xf59e0b, 'shape-body', shape.center, shape.id));
      // Handle de escala (cyan): en el borde para redimensionar
      const sNormal = new THREE.Vector3(shape.normal.x, shape.normal.y, shape.normal.z).normalize();
      const sTangent = shape.tangent
        ? new THREE.Vector3(shape.tangent.x, shape.tangent.y, shape.tangent.z).normalize()
        : new THREE.Vector3().crossVectors(sNormal, new THREE.Vector3(0, 1, 0)).normalize();
      let scalePt: { x: number; y: number; z: number };
      if (shape.shapeType === 'circle') {
        const r = shape.radius || 0.3;
        scalePt = { x: shape.center.x + sTangent.x * r, y: shape.center.y + sTangent.y * r, z: shape.center.z + sTangent.z * r };
      } else {
        const hw = (shape.width || 0.4) / 2;
        const sBitangent = new THREE.Vector3().crossVectors(sNormal, sTangent).normalize();
        const hh = (shape.height || 0.25) / 2;
        scalePt = { x: shape.center.x + sTangent.x * hw + sBitangent.x * hh, y: shape.center.y + sTangent.y * hw + sBitangent.y * hh, z: shape.center.z + sTangent.z * hw + sBitangent.z * hh };
      }
      grp.add(makeHandle(0x06b6d4, 'shape-scale', scalePt, shape.id));
      return;
    }

    // Verificar si es una línea freehand
    const line = freehandLines.find(l => l.id === selectedElementId);
    if (!line || line.points.length < 2) return;

    if (line.segments && line.segments.length > 0) {
      // Forma compuesta: handle cuerpo en el punto medio del primer segmento (sobre la superficie)
      const firstSeg = line.segments[0];
      const bodyPt = firstSeg[Math.floor(firstSeg.length / 2)] || line.points[0];
      grp.add(makeHandle(0xf59e0b, 'body', bodyPt, line.id));
      // Handles de extremo en los puntos ancla
      grp.add(makeHandle(0x22c55e, 'start', line.points[0], line.id));
      grp.add(makeHandle(0x3b82f6, 'end', line.points[line.points.length - 1], line.id));
    } else {
      // Línea simple: handles de inicio, fin y cuerpo
      grp.add(makeHandle(0x22c55e, 'start', line.points[0], line.id));
      grp.add(makeHandle(0x3b82f6, 'end', line.points[line.points.length - 1], line.id));
      const midIdx = Math.floor(line.points.length / 2);
      grp.add(makeHandle(0xf59e0b, 'body', line.points[midIdx], line.id));
    }
  }, [selectedElementId, freehandLines, surfaceShapes, modelVersion]);

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
  onFreehandLineUpdated,
  onSurfaceShapeUpdated,
  onGridStepChange,
  onSnapPointChange,
  haShapeConfig = { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 },
  incompletePointIds = [],
  highlightedPointIds = [],
  onEditablePointHovered,
  onBackgroundClick,
  pointMarkerScale = 1.0,
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
            onFreehandLineUpdated={onFreehandLineUpdated}
            onSurfaceShapeUpdated={onSurfaceShapeUpdated}
            onGridStepChange={onGridStepChange}
            onSnapPointChange={onSnapPointChange}
            haShapeConfig={haShapeConfig}
            incompletePointIds={incompletePointIds}
            highlightedPointIds={highlightedPointIds}
            onEditablePointHovered={onEditablePointHovered}
            onBackgroundClick={onBackgroundClick}
            pointMarkerScale={pointMarkerScale}
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
