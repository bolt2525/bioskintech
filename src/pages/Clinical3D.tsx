import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { 
  Activity, Save, Layers, Crosshair, 
  CheckCircle2, AlertCircle, X, Loader2, Database, Upload,
  RotateCw, RotateCcw, Move, MousePointer2, ZoomIn, ZoomOut, Maximize, Scan,
  Eye, EyeOff, Upload
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import ReferenceLinePanel from '../components/admin/ficha-clinica/components/ReferenceLinePanel';
import type { ReferenceLine, LineType, LinePreset } from '../components/admin/ficha-clinica/components/ReferenceLinePanel';

// ==========================================
// CONFIGURACIÓN Y CONSTANTES
// ==========================================

const PATHOLOGIES = [
  { id: 'botox', name: 'Toxina Botulínica', color: '#06b6d4' }, // Cian
  { id: 'filler', name: 'Relleno Dérmico', color: '#8b5cf6' }, // Violeta
  { id: 'thread', name: 'Hilos Tensores', color: '#f59e0b' }, // Ámbar
  { id: 'melasma', name: 'Melasma / Pigmentación', color: '#10b981' }, // Esmeralda
  { id: 'acnescar', name: 'Cicatrices de Acné', color: '#ef4444' }, // Rojo
];

// Función heurística para estimar las zonas faciales
// AHORA: Sistema dinámico basado en zonas registradas o fallback por defecto.
const getFacialZone = (point: THREE.Vector3, registeredZones: Zone[] = []) => {
  // 1. Intentar encontrar zona registrada cercana (Prioridad)
  if (registeredZones.length > 0) {
      let closestZone = null;
      let minDist = Infinity;

      for (const zone of registeredZones) {
          const zoneCenter = new THREE.Vector3(zone.center.x, zone.center.y, zone.center.z);
          const dist = point.distanceTo(zoneCenter);
          // AUMENTAR TOLERANCIA DE DETECCIÓN (x1.5)
          // El radio visual se redujo (x0.8) para que el decal no se saliera, 
          // pero el radio de detección debe ser mayor para que el click "agarre" la zona.
          if (dist <= zone.radius * 2.0 && dist < minDist) {
              minDist = dist;
              closestZone = zone;
          }
      }
      
      if (closestZone) return closestZone.name;
  }

  // 2. Fallback Heurístico (Si no hay zonas o no coincide ninguna)
  const { y } = point;
  if (y > 4) return "Frente";
  if (y > 1) return "Glabela y Cejas";
  if (y > -1) return "Ojeras y Región Orbital";
  if (y > -4) return "Nariz y Surco Nasogeniano";
  if (y > -7) return "Arco Cigomático y Mejillas";
  if (y > -10) return "Región Perioral y Labios";
  return "Mandíbula, Mentón y Cuello";
};

type MarkerType = 'Puntual' | 'Zonal';

interface Zone {
  id: string;
  name: string;
  center: { x: number, y: number, z: number };
  radius: number;
  rotation?: number[];
  scale?: { x: number, y: number };
  points?: { x: number, y: number, z: number }[]; // NUEVO: Coordenadas del polígono irregular
}

interface Marker {
  id?: string;
  type: MarkerType;
  pathologyId: string;
  position: { x: number; y: number; z: number };
  rotation: number[];
  normal: { x: number; y: number; z: number };
  zone: string;
  radius?: number; // Para zonas
  scale?: { x: number, y: number };
  points?: { x: number, y: number, z: number }[]; // NUEVO
}

// Base de datos asíncrona simulada
const mockDB = {
  data: [] as Marker[],
  zones: [] as Zone[], // Nueva colección para zonas
  save: async (marker: Marker) => {
    return new Promise<{ success: boolean; marker: Marker }>(resolve => {
      setTimeout(() => {
        const savedMarker = { ...marker, id: Date.now().toString() };
        mockDB.data.push(savedMarker);
        resolve({ success: true, marker: savedMarker });
      }, 800);
    });
  },
  saveZone: async (zone: Zone) => {
      return new Promise<{ success: boolean; zone: Zone }>(resolve => {
        setTimeout(() => {
          mockDB.zones.push(zone);
          resolve({ success: true, zone });
        }, 500);
      });
  },
  load: async () => {
    return new Promise<{ markers: Marker[], zones: Zone[] }>(resolve => {
      setTimeout(() => {
        resolve({ markers: [...mockDB.data], zones: [...mockDB.zones] });
      }, 1200);
    });
  }
};

// ==========================================
// MOTOR 3D VANILLA (THREE.JS)
// ==========================================

const ThreeScene = ({ modelSource, markers, zones, onMeshClick, onLoaded, onError, isZoneEditMode, zoneSelectionMode, referenceLines = [], lineDrawingMode = null, onLinePointAnchored, hairlineTopY = 4.8, hairlineBottomY = -2.0, tercioMedioBottomY = -5.5, tercioInferiorBottomY = -9.0, showHairline = true, showIntersections = true, onIntersectionsCalculated = (_pts: any[]) => {}, onMarkerMoved = (_id: string, _pos: any) => {}, editablePoints = [], onEditablePointMoved = (_id: string, _pos: any) => {}, onEditablePointDeleted = (_id: string) => {}, onEditablePointAdded = (_pos: any) => {}, onEditablePointRestored = (_pt: any) => {}, pointMode = 'none', deletedIntersectionIds = [] }: any) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const faceMeshRef = useRef<THREE.Object3D | null>(null);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const linesGroupRef = useRef<THREE.Group | null>(null);
  const editablePointsGroupRef = useRef<THREE.Group | null>(null);
  // Rutas barridas de cada línea (para constrain drag)
  const linePathsRef = useRef<{ lineId: string; pts: THREE.Vector3[] }[]>([]);
  const twoPointStepRef = useRef<0 | 1>(0);
  const [modelVersion, setModelVersion] = useState(0);
  // Tooltip de marcadores al hover
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  // Indicador de punto editable seleccionado (teclado)
  const [selectedPointName, setSelectedPointName] = useState<string | null>(null);
  
  // Ref para polígonos
  const polygonPointsRef = useRef<THREE.Vector3[]>([]);
  const polygonGroupRef = useRef<THREE.Group | null>(null);
  const [polygonPointCount, setPolygonPointCount] = useState(0);

  const clearPolygon = useCallback(() => {
    polygonPointsRef.current = [];
    if (polygonGroupRef.current) {
        // Limpiar hijos
        while(polygonGroupRef.current.children.length > 0){ 
            const child = polygonGroupRef.current.children[0];
            polygonGroupRef.current.remove(child);
            // @ts-ignore
            if (child.geometry) child.geometry.dispose();
             // @ts-ignore
            if (child.material) child.material.dispose();
        }
    }
    setPolygonPointCount(0);
  }, []);

  const addPolygonPoint = useCallback((point: THREE.Vector3) => {
    polygonPointsRef.current.push(point);
    setPolygonPointCount(prev => prev + 1);
    
    // Dibujar punto COMO DECAL (Pegatina en la malla) en lugar de esfera flotante
    if (!polygonGroupRef.current) {
        polygonGroupRef.current = new THREE.Group();
        if(sceneRef.current) sceneRef.current.add(polygonGroupRef.current);
    } else if (sceneRef.current && !sceneRef.current.children.includes(polygonGroupRef.current)) {
        sceneRef.current.add(polygonGroupRef.current);
    }
    
    // Necesitamos la normal y el objeto para proyectar el decal del punto
    // Para simplificar, haremos un Raycaster rápido aquí mismo para obtener la normal exacta en este punto
    // O mejor, pasamos la normal desde el evento de click (requiere cambiar firma de addPolygonPoint)
    // Como no queremos cambiar todo el flujo ahora:
    // Usaremos una pequeña esfera PERO pegada a la superficie (la posición ya es la intersección)
    // Para que parezca un decal, usamos un disco muy plano orientado a la normal.
    // O mejor aún: Cambiamos addPolygonPoint para recibir la normal.

    // 1. Esfera muy pequeña (punto de control)
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 16, 16), 
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true })
    );
    sphere.position.copy(point);
    sphere.renderOrder = 999; 
    polygonGroupRef.current.add(sphere);

    // 2. DECAL VISUAL (Feedback de superficie)
    // Intentamos encontrar la malla para proyectar un pequeño decal rojo/amarillo
    const faceMesh = faceMeshRef.current;
    if (faceMesh) {
         let targetMesh: THREE.Mesh | null = null;
         if (faceMesh.type === 'Group' || faceMesh.type === 'Scene') {
             faceMesh.traverse((child: any) => {
                 if (child.isMesh && !targetMesh) targetMesh = child;
             });
         } else if ((faceMesh as any).isMesh) {
             targetMesh = faceMesh as THREE.Mesh;
         }

         if (targetMesh) {
             // Calcular normal aproximada (desde el centro 0,0,0 hacia el punto)
             // Esto es suficiente para cabezas centradas
             const n = point.clone().normalize();
             const dummy = new THREE.Object3D();
             dummy.position.copy(point);
             dummy.lookAt(point.clone().add(n));

             const decalSize = new THREE.Vector3(0.1, 0.1, 0.2); // Pequeño decal de 10cm
             const decalGeo = new DecalGeometry(targetMesh, point, dummy.rotation, decalSize);
             const decalMat = new THREE.MeshBasicMaterial({ 
                 color: 0xeab308, // Amarillo
                 depthTest: false, // Siempre visible encima
                 transparent: true,
                 opacity: 0.8
             });
             const decalMesh = new THREE.Mesh(decalGeo, decalMat);
             polygonGroupRef.current.add(decalMesh);
         }
    }
    
    // Línea conectora
    const points = polygonPointsRef.current;
    if (points.length > 1) {
        const geometry = new THREE.BufferGeometry().setFromPoints([
            points[points.length - 2],
            points[points.length - 1]
        ]);
        const line = new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({ color: 0xeab308, depthTest: false, transparent: true, linewidth: 2 })
        );
        line.renderOrder = 999;
        polygonGroupRef.current.add(line);
    }
  }, []);

  const finishPolygon = useCallback(() => {
      const points = polygonPointsRef.current;
      if (points.length < 1) return;
      
      // Proyección Simplificada: Bounding Box
      const box = new THREE.Box3().setFromPoints(points);
      
      // Calcular dimensiones y centro
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      
      // La "normal" aproximada es el promedio de la dirección desde el origen al punto
      // Como no las guardamos, usamos la normal del vector Posición->Cámara o (0,1,0) genérico
      
      // FIX CRITICO: CALCULO DE NORMAL Y ROTACIÓN
      // El problema es que pasábamos rotation: [0,0,0]. El Decal necesita estar orientado hacia la cara.
      // Si el decal no mira a la superficie, se corta o sale "volando".
      
      // 1. Calcular la Normal Promedio
      // Usamos el vector desde el centro (0,0,0) hacia el punto central de la zona.
      // En una esfera/cabeza centrada, la normal es simplemente normalize(center).
      const normal = center.clone().normalize();
      
      // 2. Calcular rotación (LookAt)
      // Creamos un objeto dummy para calcular la rotación necesaria para que el eje Z mire en la dirección de la normal
      const dummy = new THREE.Object3D();
      dummy.position.copy(center);
      dummy.lookAt(center.clone().add(normal));
      
      // FIX CRÍTICO: PRESERVAR RELACIÓN DE ASPECTO (RECTÁNGULOS VS CUADRADOS)
      // El usuario quiere que si selecciona una zona rectangular (ej. nariz), se guarde rectangular.
      
      // Tenemos 'size' del bounding box global, pero necesitamos las dimensiones en el plano del decal.
      // Vamos a proyectar todos los puntos al plano local del decal para encontrar el ancho/alto real relativo a la rotación.
      
      let minLocalX = Infinity, maxLocalX = -Infinity;
      let minLocalY = Infinity, maxLocalY = -Infinity;
      
      // Matriz inversa del decal para transformar puntos globales a locales
      dummy.updateMatrixWorld();
      const inverseMatrix = dummy.matrixWorld.clone().invert();
      
      points.forEach(p => {
          const localP = p.clone().applyMatrix4(inverseMatrix);
          if (localP.x < minLocalX) minLocalX = localP.x;
          if (localP.x > maxLocalX) maxLocalX = localP.x;
          if (localP.y < minLocalY) minLocalY = localP.y;
          if (localP.y > maxLocalY) maxLocalY = localP.y;
      });
      
      const realWidth = maxLocalX - minLocalX;
      const realHeight = maxLocalY - minLocalY;
      
      // Guardamos dimensiones explícitas en el objeto zone
      // radius se mantiene como fallback o para cálculos de proximidad (usando la dimensión mayor)
      const radius = Math.max(realWidth, realHeight) / 2; // Radio de detección

      // USAR REF CALLBACKS PARA EVITAR STALE CLOSURES
      if (callbacks.current && callbacks.current.onMeshClick) {
        callbacks.current.onMeshClick({
            position: { x: center.x, y: center.y, z: center.z },
            rotation: [dummy.rotation.x, dummy.rotation.y, dummy.rotation.z],
            normal: { x: normal.x, y: normal.y, z: normal.z },
            zone: "Zona Poligonal",
            radius: radius,
            // NUEVO: Enviamos dimensiones específicas
            scale: { x: realWidth, y: realHeight },
            // NUEVO: Guardamos los puntos originales del polígono para reconstrucción visual
            points: points.map(p => ({ x: p.x, y: p.y, z: p.z }))
        });
      }
      
      if (clearPolygon) clearPolygon();
  }, [clearPolygon]); // Dependencia clearPolygon es estable (useCallback)
  const [interactionMode, setInteractionMode] = useState<'rotate' | 'pan'>('rotate');
  
  // Estado para funcionalidad de dibujo de zonas
  const [isDrawing, setIsDrawing] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{start: {x: number, y: number}, end: {x: number, y: number}} | null>(null);

  // Funciones de control de cámara manual
  const handleManualRotate = (direction: 'left' | 'right' | 'up' | 'down') => {
      // @ts-ignore
      const controls = window.clinical3d_controls; // Hack para acceso global temporal
      if (!controls) return;
      
      const angle = Math.PI / 8; // 22.5 grados
      const camera = controls.object;
      
      // Moveremos la cámara en coordenadas esféricas relativas al target
      const position = camera.position.clone().sub(controls.target);
      let r = position.length();
      let theta = Math.atan2(position.x, position.z); // horizontal
      let phi = Math.acos(position.y / r); // vertical
      
      if (direction === 'left') theta += angle;
      if (direction === 'right') theta -= angle;
      if (direction === 'up') phi = Math.max(0.1, phi - angle);
      if (direction === 'down') phi = Math.min(Math.PI - 0.1, phi + angle);
      
      const newX = r * Math.sin(phi) * Math.sin(theta);
      const newY = r * Math.cos(phi);
      const newZ = r * Math.sin(phi) * Math.cos(theta);
      
      camera.position.set(newX + controls.target.x, newY + controls.target.y, newZ + controls.target.z);
      controls.update();
  };

  const handleZoom = (zoomIn: boolean) => {
      // @ts-ignore
      const controls = window.clinical3d_controls;
      if (!controls) return;
      
      const camera = controls.object;
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      
      const distance = zoomIn ? 5 : -5;
      camera.position.add(direction.multiplyScalar(distance));
      controls.update();  
  };

  // Ref para callbacks que permite acceder a las funciones más recientes dentro del closure de Three.js
  const callbacks = useRef({ onMeshClick, onLoaded, onError, zones, isZoneEditMode, zoneSelectionMode, addPolygonPoint, finishPolygon, lineDrawingMode, onLinePointAnchored, onMarkerMoved, onEditablePointMoved, onEditablePointDeleted, onEditablePointAdded, onEditablePointRestored, pointMode, deletedIntersectionIds, editablePoints });
  
  // Actualizar refs de callbacks en cada render
  useEffect(() => {
    callbacks.current = { onMeshClick, onLoaded, onError, zones, isZoneEditMode, zoneSelectionMode, addPolygonPoint, finishPolygon, lineDrawingMode, onLinePointAnchored, onMarkerMoved, onEditablePointMoved, onEditablePointDeleted, onEditablePointAdded, onEditablePointRestored, pointMode, deletedIntersectionIds, editablePoints };
    
    // Limpiar polígono si salimos del modo edición o cambiamos de herramienta
    if (!isZoneEditMode || zoneSelectionMode !== 'polygon') {
         // No limpiar automáticamente aquí, puede causar loop si no se maneja bien
         // Mejor dejar que el usuario limpie o limpie al cambiar de modo explícitamente
         // Pero para evitar estados inconsistentes:
         if (polygonPointsRef.current.length > 0) clearPolygon();
    }
  });

  // 1. Inicializar la Escena Básica (Solo se ejecuta una vez)
  useEffect(() => {
    if (!mountRef.current) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color('#0f172a');
    scene.fog = new THREE.Fog('#0f172a', 40, 100);

    const markersGroup = new THREE.Group();
    markersGroupRef.current = markersGroup;
    scene.add(markersGroup);

    const linesGroup = new THREE.Group();
    linesGroupRef.current = linesGroup;
    scene.add(linesGroup);

    const editablePointsGroup = new THREE.Group();
    editablePointsGroupRef.current = editablePointsGroup;
    scene.add(editablePointsGroup);

    const camera = new THREE.PerspectiveCamera(35, mountRef.current.clientWidth / mountRef.current.clientHeight, 0.1, 1000);
    camera.position.set(0, 0, 18);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = true; // Permitir mover el modelo con click derecho
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 5;
    controls.maxDistance = 100;
    // Eliminamos restricciones de ángulo para libertad total
    controls.minPolarAngle = 0; 
    controls.maxPolarAngle = Math.PI; 
    controlsRef.current = controls;

    // Exponer controles globalmente para los botones de UI (solución rápida)
    // @ts-ignore
    window.clinical3d_controls = controls;

    // Iluminación
    const ambientLight = new THREE.AmbientLight(0xf0f5ff, 0.3);
    scene.add(ambientLight);

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

    // Raycasting y Lógica de Interacción
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let startPos = { x: 0, y: 0 };
    
    // Estado local para drag de marcadores clínicos
    let draggedMarkerId: string | null = null;
    let draggedMarkerGroup: THREE.Group | null = null;
    // Estado local para drag de puntos editables (interseccion + libre)
    let draggedEditableId: string | null = null;
    let draggedEditableGroup: THREE.Group | null = null;
    let draggedEditableLineIds: string[] = [];
    let dragMoved = false; // ¿el drag actual tuvo movimiento real?
    let dragStartEditablePos: { x: number; y: number; z: number } | null = null; // Posición antes del drag (para undo)

    // ── Undo stack (máx 30 acciones) ──────────────────────────────────────
    type UndoEntry =
      | { type: 'move'; id: string; prevPos: { x: number; y: number; z: number } }
      | { type: 'delete'; point: any };
    const MAX_UNDO = 30;
    const undoStack: UndoEntry[] = [];

    // Selección de punto editable para navegación por teclado
    const selectedEditableRef = { id: null as string | null, group: null as THREE.Group | null, lineIds: [] as string[] };
    const selectionRingRef = { mesh: null as THREE.Mesh | null };

    const clearSelectionRing = () => {
      if (selectionRingRef.mesh) {
        const parent = selectionRingRef.mesh.parent;
        if (parent) parent.remove(selectionRingRef.mesh);
        selectionRingRef.mesh.geometry.dispose();
        (selectionRingRef.mesh.material as THREE.Material).dispose();
        selectionRingRef.mesh = null;
      }
    };

    const addSelectionRing = (group: THREE.Group) => {
      clearSelectionRing();
      const ringGeo = new THREE.TorusGeometry(0.07, 0.008, 8, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.renderOrder = 1002;
      // Orientar el aro perpendicular a la superficie: el eje Z del toro apunta
      // a lo largo de la normal del polígono que hay debajo del punto.
      if (faceMeshRef.current) {
        const rc = new THREE.Raycaster();
        const orig = new THREE.Vector3(group.position.x, group.position.y, 50);
        rc.set(orig, new THREE.Vector3(0, 0, -1));
        const meshes: THREE.Object3D[] = [];
        faceMeshRef.current.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
        const hits = rc.intersectObjects(meshes, false);
        if (hits.length > 0 && hits[0].face) {
          const n = hits[0].face.normal.clone()
            .transformDirection(hits[0].object.matrixWorld)
            .normalize();
          ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        }
      }
      group.add(ring);
      selectionRingRef.mesh = ring;
    };

    // Variables locales para dibujo (además del estado React) para acceso síncrono en eventos
    let localIsDrawing = false;
    let drawingStartPos = { x: 0, y: 0 };

    const onPointerDown = (e: MouseEvent) => {
      if (callbacks.current.isZoneEditMode) {
          if (controlsRef.current) controlsRef.current.enabled = false;
          localIsDrawing = true;
          const rect = renderer.domElement.getBoundingClientRect();
          const relX = e.clientX - rect.left;
          const relY = e.clientY - rect.top;
          drawingStartPos = { x: relX, y: relY };
          setIsDrawing(true);
          setSelectionBox({ start: { x: relX, y: relY }, end: { x: relX, y: relY } });
      }

      // Intentar detectar clic sobre un punto editable
      if (!callbacks.current.isZoneEditMode && !callbacks.current.lineDrawingMode && editablePointsGroupRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        if (cameraRef.current) {
          raycaster.setFromCamera(mouse, cameraRef.current);
          const epMeshes: THREE.Object3D[] = [];
          editablePointsGroupRef.current.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) epMeshes.push(c); }));
          const hits = raycaster.intersectObjects(epMeshes, false);
          if (hits.length > 0) {
            let obj: THREE.Object3D | null = hits[0].object;
            while (obj && !obj.userData.isEditablePoint) obj = obj.parent;
            if (obj && obj.userData.isEditablePoint) {
              if (callbacks.current.pointMode === 'delete') {
                // Eliminar la esfera del scene de forma imperativa (sin esperar ciclo React)
                obj.traverse((m: any) => {
                  if ((m as THREE.Mesh).geometry) (m as THREE.Mesh).geometry.dispose();
                  if ((m as THREE.Mesh).material) {
                    const mat = (m as THREE.Mesh).material;
                    if (Array.isArray(mat)) mat.forEach((m2: THREE.Material) => m2.dispose());
                    else (mat as THREE.Material).dispose();
                  }
                });
                editablePointsGroupRef.current?.remove(obj as THREE.Object3D);
                // Notificar al padre para actualizar estado React
                callbacks.current.onEditablePointDeleted(obj.userData.editableId);
                return;
              }
              // Iniciar drag de punto editable
              draggedEditableId = obj.userData.editableId;
              draggedEditableGroup = obj as THREE.Group;
              draggedEditableLineIds = obj.userData.lineIds || [];
              // Capturar posición antes del drag → para undo
              dragStartEditablePos = { x: (obj as THREE.Group).position.x, y: (obj as THREE.Group).position.y, z: (obj as THREE.Group).position.z };
              if (controlsRef.current) controlsRef.current.enabled = false;
              isDragging = false;
              dragMoved = false;
              startPos = { x: e.clientX, y: e.clientY };
              return;
            }
          }
        }
      }

      // Intentar detectar clic sobre un marcador para iniciar drag
      if (!callbacks.current.isZoneEditMode && !callbacks.current.lineDrawingMode && markersGroupRef.current) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        if (cameraRef.current) {
          raycaster.setFromCamera(mouse, cameraRef.current);
          const markerMeshes: THREE.Object3D[] = [];
          markersGroupRef.current.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) markerMeshes.push(c); }));
          const hits = raycaster.intersectObjects(markerMeshes, false);
          if (hits.length > 0) {
            // Encontrar el grupo padre con isMarker
            let obj: THREE.Object3D | null = hits[0].object;
            while (obj && !obj.userData.isMarker) obj = obj.parent;
            if (obj && obj.userData.isMarker) {
              draggedMarkerId = obj.userData.markerId;
              draggedMarkerGroup = obj as THREE.Group;
              if (controlsRef.current) controlsRef.current.enabled = false; // Suspender órbita
              isDragging = false; // No contar como drag de cámara
              dragMoved = false;
              startPos = { x: e.clientX, y: e.clientY };
              return; // No iniciar lógica de órbita
            }
          }
        }
      }

      isDragging = false;
      startPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();

      // ── Drag CONSTRAINED de punto editable (a lo largo de sus líneas) ──
      if (draggedEditableGroup && faceMeshRef.current && cameraRef.current) {
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const meshObjects2: THREE.Object3D[] = [];
        faceMeshRef.current.traverse(o => { if ((o as THREE.Mesh).isMesh) meshObjects2.push(o); });
        const hits = raycaster.intersectObjects(meshObjects2, false);
        if (hits.length > 0) {
          const mouseWorld = hits[0].point;
          // Proyección sobre el segmento más cercano de cada línea → movimiento continuo y fluido.
          // El punto puede soltarse en cualquier posición de la línea, no solo en intersecciones.
          const paths = linePathsRef.current.filter(lp => draggedEditableLineIds.includes(lp.lineId));
          if (paths.length > 0) {
            let bestPt: THREE.Vector3 | null = null;
            let bestDist = Infinity;
            paths.forEach(lp => {
              for (let i = 0; i < lp.pts.length - 1; i++) {
                const a = lp.pts[i];
                const b = lp.pts[i + 1];
                const ab = b.clone().sub(a);
                const lenSq = ab.dot(ab);
                if (lenSq < 1e-10) continue;
                const t = Math.max(0, Math.min(1, mouseWorld.clone().sub(a).dot(ab) / lenSq));
                const proj = a.clone().addScaledVector(ab, t);
                const d = proj.distanceTo(mouseWorld);
                if (d < bestDist) { bestDist = d; bestPt = proj; }
              }
            });
            if (bestPt) {
              const bp = bestPt as THREE.Vector3; // TypeScript pierde narrowing en closures de forEach
              // Snap a la superficie real en (bp.x, bp.y) para que el punto
              // no se hunda en zonas cóncavas (el path interpolado puede pasar por dentro del mesh)
              const snapOrig = new THREE.Vector3(bp.x, bp.y, 50);
              raycaster.set(snapOrig, new THREE.Vector3(0, 0, -1));
              const snapHits = raycaster.intersectObjects(meshObjects2, false);
              if (snapHits.length > 0 && snapHits[0].face) {
                const sn = snapHits[0].face.normal.clone()
                  .transformDirection(snapHits[0].object.matrixWorld)
                  .normalize();
                draggedEditableGroup!.position.copy(snapHits[0].point).addScaledVector(sn, 0.02);
                // Actualizar orientación del aro en tiempo real durante el drag
                if (selectionRingRef.mesh && draggedEditableId === selectedEditableRef.id) {
                  selectionRingRef.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sn);
                }
              } else {
                draggedEditableGroup!.position.copy(bp);
              }
            }
          } else {
            // Sin restricción de línea (punto libre): offset sobre la superficie para evitar enterrarse
            const hitFree = hits[0];
            if (hitFree.face) {
              const nFree = hitFree.face.normal.clone().transformDirection(hitFree.object.matrixWorld).normalize();
              draggedEditableGroup.position.copy(hitFree.point).addScaledVector(nFree, 0.03);
              // Actualizar orientación del aro en tiempo real durante el drag
              if (selectionRingRef.mesh && draggedEditableId === selectedEditableRef.id) {
                selectionRingRef.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nFree);
              }
            } else {
              draggedEditableGroup.position.copy(mouseWorld);
            }
          }
          dragMoved = true;
        }
        setTooltip(null);
        return;
      }

      // ── Drag de marcador clínico ──────────────────────────────────
      if (draggedMarkerGroup && faceMeshRef.current && cameraRef.current) {
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);
        const meshObjects: THREE.Object3D[] = [];
        faceMeshRef.current.traverse(o => { if ((o as THREE.Mesh).isMesh) meshObjects.push(o); });
        const hits = raycaster.intersectObjects(meshObjects, false);
        if (hits.length > 0) {
          const hitM = hits[0];
          if (hitM.face) {
            const nM = hitM.face.normal.clone().transformDirection(hitM.object.matrixWorld).normalize();
            draggedMarkerGroup.position.copy(hitM.point).addScaledVector(nM, 0.03);
          } else {
            draggedMarkerGroup.position.copy(hitM.point);
          }
          dragMoved = true;
        }
        setTooltip(null);
        return;
      }

      // 1. Lógica de Dibujo de Zona
      if (localIsDrawing && callbacks.current.isZoneEditMode) {
          const relX = e.clientX - rect.left;
          const relY = e.clientY - rect.top;
          setSelectionBox({ start: drawingStartPos, end: { x: relX, y: relY } });
          return;
      }

      // 2. Detectar hover sobre puntos editables o marcadores (tooltip)
      if (!callbacks.current.isZoneEditMode && !callbacks.current.lineDrawingMode && cameraRef.current) {
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, cameraRef.current);

        // Comprobar puntos editables primero
        if (editablePointsGroupRef.current) {
          const epMeshes: THREE.Object3D[] = [];
          editablePointsGroupRef.current.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) epMeshes.push(c); }));
          const hits = raycaster.intersectObjects(epMeshes, false);
          if (hits.length > 0) {
            let obj: THREE.Object3D | null = hits[0].object;
            while (obj && !obj.userData.isEditablePoint) obj = obj.parent;
            if (obj?.userData?.pointName) {
              setTooltip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 10, text: obj.userData.pointName });
              return;
            }
          }
        }

        // Hover sobre marcadores clínicos
        if (markersGroupRef.current) {
          const markerMeshes: THREE.Object3D[] = [];
          markersGroupRef.current.children.forEach(g => g.traverse(c => { if ((c as THREE.Mesh).isMesh) markerMeshes.push(c); }));
          const hits = raycaster.intersectObjects(markerMeshes, false);
          if (hits.length > 0) {
            let obj: THREE.Object3D | null = hits[0].object;
            while (obj && !obj.userData.isMarker) obj = obj.parent;
            if (obj?.userData?.markerName) {
              setTooltip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 10, text: obj.userData.markerName });
              return;
            }
          }
        }
        setTooltip(null);
      }

      // 3. Lógica estándar de rotación
      if (Math.abs(e.clientX - startPos.x) > 2 || Math.abs(e.clientY - startPos.y) > 2) {
        isDragging = true;
        setTooltip(null);
      }
    };

    const onPointerUp = (e: MouseEvent) => {
        // ── Soltar punto editable ──────────────────────────────────
        // ── Soltar punto editable ────────────────────────────────────
        if (draggedEditableId && draggedEditableGroup) {
          const relId = draggedEditableId;
          const relGroup = draggedEditableGroup;
          const relLineIds = [...draggedEditableLineIds];
          draggedEditableId = null;
          draggedEditableGroup = null;
          draggedEditableLineIds = [];
          if (controlsRef.current) controlsRef.current.enabled = true;
          isDragging = true; // Evitar que onClick dispare el modal de confirmación

          if (dragMoved) {
            // Fue un arrastre real: guardar nueva posición + apilar undo
            const pos = relGroup.position;
            if (dragStartEditablePos) {
              undoStack.push({ type: 'move', id: relId, prevPos: dragStartEditablePos });
              if (undoStack.length > MAX_UNDO) undoStack.shift();
            }
            dragStartEditablePos = null;
            callbacks.current.onEditablePointMoved(relId, { x: pos.x, y: pos.y, z: pos.z });
          } else {
            // Fue un clic sin movimiento: toggle selección del punto
            if (selectedEditableRef.id === relId) {
              clearSelectionRing();
              selectedEditableRef.id = null;
              selectedEditableRef.group = null;
              selectedEditableRef.lineIds = [];
              setSelectedPointName(null);
            } else {
              clearSelectionRing();
              selectedEditableRef.id = relId;
              selectedEditableRef.group = relGroup;
              selectedEditableRef.lineIds = relLineIds;
              addSelectionRing(relGroup);
              setSelectedPointName(relGroup.userData.pointName || 'Punto');
            }
          }
          dragMoved = false;
          return;
        }

        // ── Soltar marcador arrastrado ─────────────────────────────
        if (draggedMarkerId && draggedMarkerGroup) {
          const pos = draggedMarkerGroup.position;
          callbacks.current.onMarkerMoved(draggedMarkerId, { x: pos.x, y: pos.y, z: pos.z });
          draggedMarkerId = null;
          draggedMarkerGroup = null;
          dragMoved = false;
          if (controlsRef.current) controlsRef.current.enabled = true;
          isDragging = true; // Evitar que onClick dispare el modal de confirmación
          return;
        }

        if (localIsDrawing && callbacks.current.isZoneEditMode) {
            // Finalizar dibujo
            localIsDrawing = false;
            setIsDrawing(false);
            if (controlsRef.current) controlsRef.current.enabled = true; // Reactivar controles

            // Calcular geometría de la selección
            const rect = renderer.domElement.getBoundingClientRect();
            const relX = e.clientX - rect.left;
            const relY = e.clientY - rect.top;
            
            // Coordenadas del cuadro de selección (YA SON RELATIVAS)
            const x1 = Math.min(drawingStartPos.x, relX);
            const x2 = Math.max(drawingStartPos.x, relX);
            const y1 = Math.min(drawingStartPos.y, relY);
            const y2 = Math.max(drawingStartPos.y, relY);
            
            const width = x2 - x1;
            const height = y2 - y1;

            // Si es un click muy pequeño, ignorar como dibujo y dejar pasar como click normal (si se desea)
            // Pero como hemos desactivado controles, mejor tratamos como "click puntual" si es muy pequeño
            if (width < 5 && height < 5) {
                setSelectionBox(null);
                // Permitir que el evento 'click' maneje esto si es necesario, pero aquí ya consumimos el evento
                // Podríamos llamar a onClick manualmente si quisiéramos seleccionar un punto
                // De momento, reseteamos.
                return;
            }

            setSelectionBox(null);

            // CALCULAR EL CENTRO Y RADIO EN 3D
            const centerX = x1 + width / 2;
            const centerY = y1 + height / 2;

            // Convertir centro 2D RELATIVO a coordenadas normalizadas (-1 a 1) para Raycaster
            mouse.x = (centerX / rect.width) * 2 - 1;
            mouse.y = -(centerY / rect.height) * 2 + 1;

            if (!cameraRef.current || !faceMeshRef.current) return;

            raycaster.setFromCamera(mouse, cameraRef.current);
            const intersects = raycaster.intersectObject(faceMeshRef.current, true);

            if (intersects.length > 0) {
                const intersect = intersects[0];
                const centerPoint = intersect.point;
                // Distancia a la cámara para el cálculo del radio proyectado
                const distance = cameraRef.current.position.distanceTo(centerPoint);
                const fov = THREE.MathUtils.degToRad(cameraRef.current.fov);

                // Radio aproximado en píxeles (usamos la dimensión más grande)
                // Antes dividíamos por 2, pero para abarcar visualmente la zona dibujada,
                // la esfera debería tener el diámetro completo de la selección
                const radiusPx = Math.max(width, height);
                
                // AJUSTE DE ESCALA DEL RADIO: Aumentar factor para que cubra mejor el área visual
                // 1.0 = conversión matemática estricta. 1.1 = un poco de holgura.
                const adjustmentFactor = 1.0; 

                // Fórmula de proyección inversa: (radiusPx / screenHeight) * (visibleHeightAtDistance)
                // visibleHeightAtDistance = 2 * distance * tan(fov / 2)
                const screenHeight = rect.height;
                const visibleHeight = 2 * distance * Math.tan(fov / 2);
                const projectedRadius = ((radiusPx / screenHeight) * visibleHeight) * adjustmentFactor;

                // Llamar al callback con la nueva zona
                callbacks.current.onMeshClick({
                    position: { x: centerPoint.x, y: centerPoint.y, z: centerPoint.z },
                    rotation: [0, 0, 0], // Irrelevante para zona esférica
                    normal: { x: 0, y: 1, z: 0 }, // Irrelevante
                    zone: "Nueva Zona", // Placeholder
                    radius: projectedRadius // Pasamos el radio calculado
                });
            }
        }
    };


    // Funciones para UI de controles (Zoom y Rotación) deben ser accesibles
    const handleManualRotate = (direction: 'left' | 'right' | 'up' | 'down') => {
      // @ts-ignore
      const controls = window.clinical3d_controls;
      if (!controls) return;

      const camera = controls.object;
      const r = camera.position.distanceTo(controls.target);
      
      let phi = Math.acos( (camera.position.y - controls.target.y) / r );
      let theta = Math.atan2( camera.position.z - controls.target.z, camera.position.x - controls.target.x );
      
      const speed = 0.5; // Radianes
      
      if (direction === 'left') theta += speed;
      if (direction === 'right') theta -= speed;
      if (direction === 'up') phi = Math.max(0.1, phi - speed);
      if (direction === 'down') phi = Math.min(Math.PI - 0.1, phi + speed);
      
      const newX = r * Math.sin(phi) * Math.cos(theta);
      const newY = r * Math.cos(phi);
      const newZ = r * Math.sin(phi) * Math.sin(theta); // Corregido cos -> sin para Z en esféricas estándar
      
      camera.position.set(newX + controls.target.x, newY + controls.target.y, newZ + controls.target.z);
      controls.update();
  };

  const handleZoom = (zoomIn: boolean) => {
      // @ts-ignore
      const controls = window.clinical3d_controls;
      if (!controls) return;
      
      const camera = controls.object;
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      
      const distance = zoomIn ? 5 : -5;
      camera.position.add(direction.multiplyScalar(distance));
      controls.update();  
  };
    
    const onClick = (event: MouseEvent) => {
      // 0. Depuración básica
      console.log("Click en canvas", { isDragging, hasMesh: !!faceMeshRef.current, hasCam: !!cameraRef.current, editMode: callbacks.current.isZoneEditMode });

      // Si hubo arrastre de cámara o de marcador, ignorar click
      if (isDragging || draggedMarkerId !== null || draggedEditableId !== null || !faceMeshRef.current || !cameraRef.current) return;
      
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      // Actualizar raycaster
      raycaster.setFromCamera(mouse, cameraRef.current);
      
      // IMPORTANTE: recursive = true para que atraviese el Grupo Pivot y llegue a la Malla real
      const intersects = raycaster.intersectObject(faceMeshRef.current, true);
      
      console.log("Intersecciones:", intersects.length);

      // CASO ESPECIAL: MODO POLÍGONO (Agregar puntos)
      if (callbacks.current.isZoneEditMode && callbacks.current.zoneSelectionMode === 'polygon') {
          if (intersects.length > 0) {
              callbacks.current.addPolygonPoint(intersects[0].point);
          }
          // Ignorar el resto de la lógica (no queremos seleccionar zona ni dibujar rectángulo)
          return;
      }
      
      // Si estamos en modo edición ZONA RECTÁNGULO, el click puntual se ignora (se usa drag)
      if (callbacks.current.isZoneEditMode) {
          console.log("Click ignorado por modo edición (esperando drag)");
          return; 
      }
      
      // Lógica de dibujo de líneas de referencia
      if (callbacks.current.lineDrawingMode && callbacks.current.onLinePointAnchored && intersects.length > 0) {
        const point = intersects[0].point;
        callbacks.current.onLinePointAnchored(point);
        return;
      }

      // Modo "add-point": agregar punto libre en la superficie
      if (callbacks.current.pointMode === 'add' && intersects.length > 0) {
        const hitAdd = intersects[0];
        const nAdd = hitAdd.face ? hitAdd.face.normal.clone().transformDirection(hitAdd.object.matrixWorld).normalize() : new THREE.Vector3(0, 1, 0);
        const pt = hitAdd.point.clone().addScaledVector(nAdd, 0.03);
        callbacks.current.onEditablePointAdded({ x: pt.x, y: pt.y, z: pt.z });
        return;
      }

      // Lógica estándar de click puntual (Marcadores Clínicos)
      
      if (intersects.length > 0) {
        const intersect = intersects[0];
        const point = intersect.point;
        
        console.log("Click válido en malla:", point);

        // Calcular normal en coordenadas mundiales
        const n = intersect.face ? intersect.face.normal.clone() : new THREE.Vector3(0,1,0);
        // Usar la matriz del objeto interceptado (la malla específica), no del grupo contenedor
        const nTransform = new THREE.Matrix3().getNormalMatrix(intersect.object.matrixWorld);
        n.applyMatrix3(nTransform).normalize();

        // Offset sobre la superficie para que las esferas no se entierren en zonas cóncavas (ojos, etc.)
        const offsetPoint = point.clone().addScaledVector(n, 0.03);

        const dummy = new THREE.Object3D();
        dummy.position.copy(offsetPoint);
        dummy.lookAt(offsetPoint.clone().add(n));

        const zoneDetectedName = getFacialZone(offsetPoint, callbacks.current.zones);
        const registeredZone = callbacks.current.zones.find((z: any) => z.name === zoneDetectedName);
        
        console.log("Zona detectada:", zoneDetectedName, "Registrada:", !!registeredZone);

        let finalRadius = 0.6;
        let finalRotation = [dummy.rotation.x, dummy.rotation.y, dummy.rotation.z];
        
        if (registeredZone) {
            // Usar escala rectangular guardada
            // @ts-ignore (Si scale no existe en la definición antigua, usar radius como cuadrado)
            const zoneScale = registeredZone.scale || { x: registeredZone.radius, y: registeredZone.radius };
            
            console.log("Usando zona registrada:", registeredZone.name, zoneScale);

            callbacks.current.onMeshClick({
              position: { x: offsetPoint.x, y: offsetPoint.y, z: offsetPoint.z },
              rotation: finalRotation,
              normal: { x: n.x, y: n.y, z: n.z },
              zone: zoneDetectedName,
              radius: finalRadius,
              scale: zoneScale // Pasar escala al preview
            });
            return; // Salir temprano para no ejecutar el onMeshClick de abajo
        }

        console.log("Usando zona detectada (fallback)");

        callbacks.current.onMeshClick({
          position: { x: offsetPoint.x, y: offsetPoint.y, z: offsetPoint.z },
          rotation: finalRotation,
          normal: { x: n.x, y: n.y, z: n.z },
          zone: zoneDetectedName,
          radius: finalRadius // Pasamos el radio correcto desde el inicio
        });
      }
    };

    // ── Teclado: mover punto seleccionado con flechas, borrar, deshacer ──────────────────────
    const onKeyDown = (e: KeyboardEvent) => {
      // ── Ctrl+Z / Cmd+Z: deshacer última acción (funciona sin selección activa) ──
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        const action = undoStack.pop();
        if (!action) return;
        if (action.type === 'move') {
          // Restaurar posición anterior del punto
          callbacks.current.onEditablePointMoved(action.id, action.prevPos);
          // También actualizar la malla 3D directamente para respuesta inmediata
          const grp = editablePointsGroupRef.current?.children.find(
            g => g.userData.editableId === action.id
          ) as THREE.Group | undefined;
          if (grp) grp.position.set(action.prevPos.x, action.prevPos.y, action.prevPos.z);
          // Si el punto borrado era el seleccionado, actualizar anillo
          if (selectedEditableRef.id === action.id && grp) {
            clearSelectionRing();
            addSelectionRing(grp);
          }
        } else if (action.type === 'delete') {
          // Restaurar punto borrado: actualizar React state Y recrear la esfera en el scene
          callbacks.current.onEditablePointRestored(action.point);
          // Recrear el grupo Three.js directamente para respuesta inmediata
          if (editablePointsGroupRef.current) {
            const pt = action.point;
            const ptGroup = new THREE.Group();
            ptGroup.userData.isEditablePoint = true;
            ptGroup.userData.editableId = pt.id;
            ptGroup.userData.lineIds = pt.lineIds ?? [];
            ptGroup.userData.epType = pt.type ?? 'free';
            ptGroup.userData.pointName = pt.name ?? 'Punto libre';
            ptGroup.position.set(pt.x, pt.y, pt.z);
            const isIntersection = pt.type === 'intersection';
            const sphereColor = isIntersection ? 0x00eeff : 0xffdd00;
            const coreGeo  = new THREE.SphereGeometry(0.02, 12, 12);
            const coreMesh = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
            coreMesh.renderOrder = 1000;
            ptGroup.add(coreMesh);
            const outerGeo = new THREE.SphereGeometry(0.04, 16, 16);
            const outerMat = new THREE.MeshPhysicalMaterial({
              color: new THREE.Color(sphereColor),
              emissive: new THREE.Color(sphereColor),
              emissiveIntensity: 0.6,
              transparent: true,
              opacity: 0.35,
              roughness: 0,
              transmission: 0.98,
              thickness: 0.3,
              ior: 1.5,
              clearcoat: 1.0,
              clearcoatRoughness: 0,
            });
            const outerMesh = new THREE.Mesh(outerGeo, outerMat);
            outerMesh.renderOrder = 1000;
            ptGroup.add(outerMesh);
            editablePointsGroupRef.current.add(ptGroup);
          }
        }
        return;
      }

      // ── Escape: deseleccionar punto ────────────────────────────────────
      if (e.key === 'Escape') {
        e.preventDefault();
        if (selectedEditableRef.id) {
          clearSelectionRing();
          selectedEditableRef.id = null;
          selectedEditableRef.group = null;
          selectedEditableRef.lineIds = [];
          setSelectedPointName(null);
        }
        return;
      }

      // ── Delete / Backspace: borrar punto seleccionado ──────────────────
      // Se llama e.preventDefault() ANTES del guard para que el navegador no
      // interprete Backspace como "volver atrás" aunque no haya punto seleccionado
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const id = selectedEditableRef.id;
        if (!id) return; // Nada seleccionado
        const grp = selectedEditableRef.group;
        const pos = grp ? grp.position : { x: 0, y: 0, z: 0 };
        // Apilar acción de borrado para undo (guarda todos los datos del punto)
        undoStack.push({
          type: 'delete',
          point: {
            id,
            x: pos.x, y: pos.y, z: pos.z,
            lineIds: grp ? (grp.userData.lineIds || []) : [],
            type: (grp ? grp.userData.epType : null) || 'free',
            name: (grp ? grp.userData.pointName : null) || 'Punto libre',
          }
        });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        // Limpiar selección en la malla 3D
        clearSelectionRing();
        selectedEditableRef.id = null;
        selectedEditableRef.group = null;
        selectedEditableRef.lineIds = [];
        setSelectedPointName(null);
        // Eliminar el grupo Three.js del scene DIRECTAMENTE — sin esperar el ciclo
        // React/useEffect (los puntos de intersección solo se limpian cuando las
        // líneas se recalculan, por lo que sin esto la esfera queda flotando).
        if (grp && editablePointsGroupRef.current) {
          grp.traverse((m: any) => {
            if ((m as THREE.Mesh).geometry) (m as THREE.Mesh).geometry.dispose();
            if ((m as THREE.Mesh).material) {
              const mat = (m as THREE.Mesh).material;
              if (Array.isArray(mat)) mat.forEach(m2 => m2.dispose());
              else (mat as THREE.Material).dispose();
            }
          });
          editablePointsGroupRef.current.remove(grp);
        }
        // Notificar al padre para actualizar estado React
        callbacks.current.onEditablePointDeleted(id);
        return;
      }

      // ── Arrow keys: mover punto (requieren selección con grupo válido) ──
      if (!selectedEditableRef.id || !selectedEditableRef.group) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();

      const camera = cameraRef.current;
      if (!camera) return;

      const step = e.shiftKey ? 0.02 : 0.005;
      const group = selectedEditableRef.group;

      // Capturar posición ANTES del movimiento para undo (solo si no se está repitiendo la tecla)
      if (!e.repeat) {
        undoStack.push({ type: 'move', id: selectedEditableRef.id, prevPos: { x: group.position.x, y: group.position.y, z: group.position.z } });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
      }

      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();

      const delta = new THREE.Vector3();
      if (e.key === 'ArrowLeft')  delta.copy(right).multiplyScalar(-step);
      if (e.key === 'ArrowRight') delta.copy(right).multiplyScalar(step);
      if (e.key === 'ArrowUp')    delta.copy(up).multiplyScalar(step);
      if (e.key === 'ArrowDown')  delta.copy(up).multiplyScalar(-step);

      const newPos = group.position.clone().add(delta);

      // Restringir a líneas de referencia si el punto está asociado a ellas
      const paths = linePathsRef.current.filter(lp => selectedEditableRef.lineIds.includes(lp.lineId));
      if (paths.length > 0) {
        let bestPt: THREE.Vector3 | null = null;
        let bestDist = Infinity;
        paths.forEach(lp => {
          for (let i = 0; i < lp.pts.length - 1; i++) {
            const a = lp.pts[i];
            const b = lp.pts[i + 1];
            const ab = b.clone().sub(a);
            const lenSq = ab.dot(ab);
            if (lenSq < 1e-10) continue;
            const t = Math.max(0, Math.min(1, newPos.clone().sub(a).dot(ab) / lenSq));
            const proj = a.clone().addScaledVector(ab, t);
            const d = proj.distanceTo(newPos);
            if (d < bestDist) { bestDist = d; bestPt = proj; }
          }
        });
        if (bestPt) group.position.copy(bestPt);
      } else {
        group.position.copy(newPos);
      }

      const pos = group.position;
      callbacks.current.onEditablePointMoved(selectedEditableRef.id, { x: pos.x, y: pos.y, z: pos.z });
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp); // Agregar listener
    renderer.domElement.addEventListener('click', onClick);
    // Usar capture:true para que el handler reciba las teclas ANTES que cualquier elemento hijo
    // (evita que stopPropagation en inputs u otros componentes bloquee nuestro handler)
    document.addEventListener('keydown', onKeyDown, true);

    // Bucle de Animación
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    // Redimensionamiento
    const onResize = () => {
      if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
      cameraRef.current.aspect = mountRef.current.clientWidth / mountRef.current.clientHeight;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKeyDown, true);
      if (rendererRef.current && rendererRef.current.domElement) {
        const dom = rendererRef.current.domElement;
        dom.removeEventListener('pointerdown', onPointerDown);
        dom.removeEventListener('pointermove', onPointerMove);
        dom.removeEventListener('pointerup', onPointerUp);
        dom.removeEventListener('click', onClick);
      }
      cancelAnimationFrame(animationFrameId);
      if (mountRef.current && rendererRef.current) {
        mountRef.current.removeChild(rendererRef.current.domElement);
      }
      if (rendererRef.current) rendererRef.current.dispose();
    };
  }, []); // Dependencias vacías: Solo se inicializa una vez

  // 2. Lógica de Carga del Modelo (Se ejecuta cuando modelSource cambia)
  useEffect(() => {
    if (!sceneRef.current || !modelSource) return;

    // Remover modelo anterior si existe
    if (faceMeshRef.current) {
      sceneRef.current.remove(faceMeshRef.current);
      // @ts-ignore
      if (faceMeshRef.current.geometry) faceMeshRef.current.geometry.dispose();
      // @ts-ignore
      if (faceMeshRef.current.material) faceMeshRef.current.material.dispose();
      faceMeshRef.current = null;
    }

    const loader = new GLTFLoader();

    const handleLoadedModel = (gltf: any) => {

      // Normalizar la escena completa, no solo la malla
      const model = gltf.scene;

      if (model) {
        // ===== ALGORITMO DE CENTRADO ABSOLUTO V3 (CONSOLIDADO) =====
        
        // 1. Resetear transformaciones previas del contenedor
        model.updateMatrixWorld(true);
        
        // 2. Calcular Bounding Box de TODO el modelo (incluyendo hijos)
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        // 3. CENTRADO: Mover todo el grupo para que el centro visual esté en (0,0,0)
        // Usamos la posición del grupo contenedor
        model.position.x -= center.x;
        model.position.y -= center.y;
        model.position.z -= center.z;

        // 4. CORRECCIÓN DE ROTACIÓN (Detectar Z-up)
        // Algunos modelos vienen con Z como eje vertical.
        // Si la profundidad (Z) es mucho mayor que la altura (Y), probablemente esté "acostado".
        // Sin embargo, para evitar falsos positivos, rotaremos basado en inputs del usuario si es necesario.
        // Por defecto, asumimos Y-up que es el estándar de WebGL.
        
        // Si el usuario reporta que no gira sobre el eje vertical, es probable que la malla interna tenga una rotación extraña.
        // Vamos a encapsular el modelo en un Grupo Pivot para tener control total.
        const pivotGroup = new THREE.Group();
        pivotGroup.add(model);
        
        // Asignar el pivotGroup como el objeto principal a manipular
        // Esto permite que OrbitControls rote alrededor del (0,0,0) donde está el pivot
        sceneRef.current?.add(pivotGroup);
        faceMeshRef.current = pivotGroup; // Usamos la referencia para limpieza
        
        // Encontrar la malla principal para asignarle material (recursivo)
        model.traverse((child: any) => {
             if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                // DoubleSide: rellena el depth buffer desde ambas caras.
                // Sin esto las esferas del frente son visibles al rotar 180° porque
                // las caras traseras del modelo no escriben en el buffer de profundidad.
                child.material = new THREE.MeshPhysicalMaterial({
                  color: 0xfae3db,
                  roughness: 0.45,
                  metalness: 0.05,
                  clearcoat: 0.15,
                  clearcoatRoughness: 0.3,
                  side: THREE.DoubleSide
                });
             }
        });

        // 5. ESCALADO
        const maxDim = Math.max(size.x, size.y, size.z);
        const targetSize = 5;
        const scaleFactor = targetSize / (maxDim || 1);
        model.scale.setScalar(scaleFactor); // Escalamos el modelo interno, no el grupo

        // 6. ENFOQUE
        if (controlsRef.current) {
            controlsRef.current.target.set(0, 0, 0);
            controlsRef.current.update();
        }

        setModelVersion(v => v + 1);
        callbacks.current.onLoaded();
      } else {

        callbacks.current.onError("El archivo no contiene una malla 3D válida.");
      }
    };

    const handleLoadError = (error: any) => {
      console.warn("Carga fallida:", error);
      // Evitar propagar error si es un buffer inicial vacío
      if (modelSource.type === 'buffer' && (!modelSource.data)) return;
      callbacks.current.onError("No se pudo cargar el modelo automáticamente por seguridad del entorno. Por favor, súbelo manualmente.");
    };

    try {
      if (modelSource.type === 'buffer') {
        // Aseguramos que sea un ArrayBuffer válido antes de parsear
        if (modelSource.data && (modelSource.data instanceof ArrayBuffer || typeof modelSource.data === 'string')) {
             loader.parse(modelSource.data, '', handleLoadedModel, handleLoadError);
        }
      } else if (modelSource.type === 'url') {
        // Ignorar si la URL está vacía para evitar error prematuro
        if (!modelSource.data) return;

        // Evitar explícitamente fetch en entornos blob con URLs relativas
        const isBlobEnvironment = window.location.href.startsWith('blob:');
        const isRelativeUrl = !modelSource.data.startsWith('http') && !modelSource.data.startsWith('data:') && !modelSource.data.startsWith('blob:');
        
        if (isBlobEnvironment && isRelativeUrl) {
          throw new Error("Peticiones fetch relativas no permitidas.");
        }

        loader.load(modelSource.data, handleLoadedModel, undefined, handleLoadError);
      }
    } catch (err) {
      handleLoadError(err);
    }

  }, [modelSource]); // Se eliminan onLoaded y onError de aquí para evitar bucles infinitos

  // 3. Lógica de Actualización de Marcadores
  useEffect(() => {
    const group = markersGroupRef.current;
    const faceMesh = faceMeshRef.current;
    if (!group) return;

    // Limpiar marcadores antiguos
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      // @ts-ignore
      if (child.geometry) child.geometry.dispose();
      // @ts-ignore
      if (child.material) {
        // @ts-ignore
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        // @ts-ignore
        else child.material.dispose();
      }
    }

    // Renderizar nuevos marcadores
    markers.forEach((marker: Marker) => {
      const pathology = PATHOLOGIES.find(p => p.id === marker.pathologyId);
      const colorHex = pathology?.color || '#ffffff';
      const color = new THREE.Color(colorHex);
      const pos = new THREE.Vector3(marker.position.x, marker.position.y, marker.position.z);

      if (marker.type === 'Puntual') {
        const markerGroup = new THREE.Group();
        markerGroup.position.copy(pos);
        // Etiquetar para drag/hover
        markerGroup.userData.markerId = marker.id;
        markerGroup.userData.markerName = `${pathology?.name ?? 'Punto'} · ${marker.zone || ''}`;
        markerGroup.userData.isMarker = true;

        // Núcleo sólido blanco — depthTest:true: mitad interna ocluida por el modelo.
        // renderOrder:1000 > tubes(999) → siempre encima de las líneas tubulares.
        const coreGeo = new THREE.SphereGeometry(0.02, 12, 12);
        const coreMesh = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
        coreMesh.renderOrder = 1000;
        markerGroup.add(coreMesh);

        // Envolvente cristalina de vidrio — transmission alta + ior para refracción real.
        // renderOrder:1000 garantiza que se pinte después de los tubes (renderOrder:999).
        const outerGeo = new THREE.SphereGeometry(0.04, 16, 16);
        const outerMat = new THREE.MeshPhysicalMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.6,
          transparent: true,
          opacity: 0.35,
          roughness: 0,
          transmission: 0.98,
          thickness: 0.3,
          ior: 1.5,
          clearcoat: 1.0,
          clearcoatRoughness: 0,
        });
        const outerMesh = new THREE.Mesh(outerGeo, outerMat);
        outerMesh.renderOrder = 1000;
        markerGroup.add(outerMesh);

        group.add(markerGroup);

      } else if (marker.type === 'Zonal' && faceMesh) {
        
        // Encontrar la malla objetivo real (ya que faceMesh puede ser un Grupo Pivote)
        let targetMesh: THREE.Mesh | null = null;
        if (faceMesh.type === 'Group' || faceMesh.type === 'Scene') {
          faceMesh.traverse((child) => {
            if (child instanceof THREE.Mesh && !targetMesh) {
              targetMesh = child;
            }
          });
        } else if (faceMesh instanceof THREE.Mesh) {
          targetMesh = faceMesh as THREE.Mesh;
        }

        if (!targetMesh) return;

        // ACTUALIZACIÓN: Soporte para escala rectangular (width/height independientes)
        let width = 0.6;
        let height = 0.6;
        
        if (marker.scale) {
            width = marker.scale.x;
            height = marker.scale.y;
        } else if (marker.radius) {
            width = marker.radius; // Fallback cuadrado
            height = marker.radius;
        }
        
        const euler = new THREE.Euler(marker.rotation[0], marker.rotation[1], marker.rotation[2]);
        
        // CORRECCIÓN DE PROFUNDIDAD (Z-FIGHTING Y DISTORSIÓN)
        // Solución v3: Aumentar DRASTICAMENTE la profundidad (User request: "aun no es suficiente el volumen")
        // Aumentamos a 1.5x el tamaño para asegurar que atraviese la nariz completa o pómulos prominentes
        const depth = Math.max(width, height) * 1.5; 
        
        const size = new THREE.Vector3(width, height, depth);
        
        // DecalGeometry requiere una malla con geometría válida
        const decalGeo = new DecalGeometry(targetMesh, pos, euler, size);
        
        // GENERACIÓN DE TEXTURA PARA POLÍGONOS IRREGULARES
        let decalMap = null;
        if (marker.points && marker.points.length > 2) {
            // Crear canvas para dibujar el polígono
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 512;
            const ctx = canvas.getContext('2d');
            
            if (ctx) {
                ctx.fillStyle = 'white'; // El color vendrá del material, esto es alpha map
                // Como es alpha map: blanco = visible, transparente = invisible
                // PERO: Si usamos map con transparent:true, necesitamos color + alpha.
                // Mejor usar una textura blanca con forma y dejar que el material ponga el color.
                
                // 1. Proyectar puntos al espacio 2D del canvas (0-512)
                // Necesitamos transformar los puntos mundiales al espacio local del decal
                // El espacio local es -size/2 a +size/2.
                
                // Reconstruir matriz inversa
                const dummy = new THREE.Object3D();
                dummy.position.copy(pos);
                dummy.rotation.set(marker.rotation[0], marker.rotation[1], marker.rotation[2]);
                dummy.updateMatrixWorld();
                const inverseMatrix = dummy.matrixWorld.clone().invert();
                
                // Dibujar
                ctx.beginPath();
                marker.points.forEach((p, i) => {
                    const vec = new THREE.Vector3(p.x, p.y, p.z);
                    vec.applyMatrix4(inverseMatrix);
                    
                    // Transformar de local coords a canvas coords
                    // local X range: [-width/2, width/2] -> [0, 512]
                    // local Y range: [-height/2, height/2] -> [0, 512] (.y invertido en canvas)
                    
                    const u = (vec.x / width) + 0.5;
                    const v = (vec.y / height) + 0.5;
                    
                    const px = u * 512;
                    const py = (1 - v) * 512; // Invertir Y para canvas
                    
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                });
                ctx.closePath();
                ctx.fill();
                
                // Difuminado suave en bordes (opcional)
                ctx.shadowColor = "white";
                ctx.shadowBlur = 20;
                ctx.stroke(); // Stroke para suavizar borde

                decalMap = new THREE.CanvasTexture(canvas);
            }
        }

        const decalMat = new THREE.MeshPhysicalMaterial({
          color: color,
          transparent: true,
          opacity: 0.6,
          roughness: 0.2,
          clearcoat: 1,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          // Si tenemos polígono, usamos alphaMap para recortar la forma
          alphaMap: decalMap,
          alphaTest: 0.05 // Recorte limpio
        });
        
        const decalMesh = new THREE.Mesh(decalGeo, decalMat);
        group.add(decalMesh);
      }
    });
  }, [markers]);

  // === Renderizado de Líneas de Referencia ===
  useEffect(() => {
    const linesGroup = linesGroupRef.current;
    const faceMesh = faceMeshRef.current;
    if (!linesGroup) return;

    // Limpiar líneas previas
    while (linesGroup.children.length > 0) {
      const child = linesGroup.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if ((child as THREE.Mesh).material) {
        const mat = (child as THREE.Mesh).material as THREE.Material;
        mat.dispose();
      }
      linesGroup.remove(child);
    }

    if (!faceMesh) return;

    const raycaster = new THREE.Raycaster();
    const meshObjects: THREE.Object3D[] = [];
    faceMesh.traverse((o: THREE.Object3D) => {
      if ((o as THREE.Mesh).isMesh) meshObjects.push(o);
    });

    // Raycast un punto en (x, y) sobre la superficie del modelo
    const raycastPoint = (x: number, y: number): THREE.Vector3 | null => {
      const origin = new THREE.Vector3(x, y, 50);
      raycaster.set(origin, new THREE.Vector3(0, 0, -1));
      const hits = raycaster.intersectObjects(meshObjects, false);
      return hits.length > 0 ? hits[0].point.clone() : null;
    };

    // Sweep vertical LIMITADO entre hairlineBottomY y hairlineTopY
    const sweepVerticalLimited = (fixedX: number, maxY: number, minY: number = -15, steps = 100): THREE.Vector3[] => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= steps; i++) {
        const y = -15 + (i / steps) * 30;
        if (y < minY) continue; // No bajar del límite inferior
        if (y > maxY) break;    // No superar límite superior
        const origin = new THREE.Vector3(fixedX, y, 50);
        raycaster.set(origin, new THREE.Vector3(0, 0, -1));
        const hits = raycaster.intersectObjects(meshObjects, false);
        if (hits.length > 0) pts.push(hits[0].point.clone());
      }
      return pts;
    };

    // Para líneas horizontales: corregir hundimientos en zonas cóncavas profundas (socket ocular ~2-3u).
    // Valley-bridge: detecta valles completos (como el socket ocular) con puntero doble.
    // Un solo pase es suficiente para saltar concavidades de cualquier ancho.
    // threshold: caída de Z desde el punto de entrada que se considera valle.
    const bridgeConcavities = (pts: THREE.Vector3[], threshold = 0.30): THREE.Vector3[] => {
      if (pts.length < 4) return pts;
      const out = pts.map(p => p.clone());
      let i = 1;
      while (i < out.length) {
        const zEntry = out[i - 1].z;
        if (zEntry - out[i].z > threshold) {
          // Buscar salida del valle: Z recupera a menos de threshold/2 por debajo de entrada
          let j = i + 1;
          while (j < out.length && out[j].z < zEntry - threshold * 0.5) j++;
          const exitIdx = Math.min(j, out.length - 1);
          const zExit  = out[exitIdx].z;
          const span   = exitIdx - (i - 1);
          // Interpolar linealmente Z a través de todo el valle
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

    const sweepSurface = (fixedVal: number, isVertical: boolean, steps = 80): THREE.Vector3[] => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = -1 + (i / steps) * 2;
        const origin = isVertical
          ? new THREE.Vector3(fixedVal, t * 15, 50)
          : new THREE.Vector3(t * 15, fixedVal, 50);
        raycaster.set(origin, new THREE.Vector3(0, 0, -1));
        const hits = raycaster.intersectObjects(meshObjects, false);
        if (hits.length > 0) pts.push(hits[0].point.clone());
      }
      // Horizontales: corregir hundimiento en socket ocular (valley-bridge, threshold 0.30)
      if (!isVertical) return bridgeConcavities(pts, 0.30);
      return pts;
    };

    const sweepDiagonal = (
      anchor1: { x: number; y: number; z: number },
      anchor2: { x: number; y: number; z: number },
      steps = 80
    ): THREE.Vector3[] => {
      const pts: THREE.Vector3[] = [];
      const a1 = new THREE.Vector3(anchor1.x, anchor1.y, anchor1.z);
      const a2 = new THREE.Vector3(anchor2.x, anchor2.y, anchor2.z);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const interpolated = a1.clone().lerp(a2, t);
        const origin = new THREE.Vector3(interpolated.x, interpolated.y, 50);
        raycaster.set(origin, new THREE.Vector3(0, 0, -1));
        const hits = raycaster.intersectObjects(meshObjects, false);
        if (hits.length > 0) pts.push(hits[0].point.clone());
      }
      return pts;
    };

    const makeSurfaceTube = (pts: THREE.Vector3[], color: string, opacity = 1.0, radius = 0.007, dashed = false) => {
      if (pts.length < 2) return;
      if (dashed) {
        // Modo PUNTOS: esferas equidistantes + halo negro para visibilidad contra la malla.
        const DOT_R   = radius * 1.5;   // radio esfera coloreada
        const HALO_R  = radius * 3.0;   // radio halo negro (contorno)
        const SPACING = 0.040;           // distancia entre centros: ~25 puntos por unidad de path
        const dotMat  = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), depthTest: false, depthWrite: false });
        const haloMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
        const dotGeo  = new THREE.SphereGeometry(DOT_R,  6, 6);
        const haloGeo = new THREE.SphereGeometry(HALO_R, 6, 6);
        const placeDot = (pos: THREE.Vector3) => {
          const halo = new THREE.Mesh(haloGeo, haloMat);
          halo.position.copy(pos);
          halo.renderOrder = 997;
          linesGroup.add(halo);
          const dot = new THREE.Mesh(dotGeo, dotMat);
          dot.position.copy(pos);
          dot.renderOrder = 999;
          linesGroup.add(dot);
        };
        let acc = 0;
        let nextDot = 0;
        placeDot(pts[0]);
        nextDot = SPACING;
        for (let k = 1; k < pts.length; k++) {
          const segLen = pts[k].distanceTo(pts[k - 1]);
          if (segLen < 1e-6) continue;
          while (acc + segLen >= nextDot) {
            const t = (nextDot - acc) / segLen;
            placeDot(pts[k - 1].clone().lerp(pts[k], Math.min(1, t)));
            nextDot += SPACING;
          }
          acc += segLen;
        }
        return;
      }
      // Línea continua: tubo negro de contorno (realce) + tubo coloreado encima
      const curve = new THREE.CatmullRomCurve3(pts);
      const segs  = pts.length * 2;
      const outlineGeo = new THREE.TubeGeometry(curve, segs, radius * 3.5, 8, false);
      const outlineMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false });
      const outlineTube = new THREE.Mesh(outlineGeo, outlineMat);
      outlineTube.renderOrder = 997;
      linesGroup.add(outlineTube);
      const geo = new THREE.TubeGeometry(curve, segs, radius, 8, false);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
      });
      const tube = new THREE.Mesh(geo, mat);
      tube.renderOrder = 999;
      linesGroup.add(tube);
    };

    // ── Hairline limit lines ──
    if (showHairline) {
      // Línea superior (hairlineTopY) — hairline
      const hlTopPts = sweepSurface(hairlineTopY, false, 80);
      makeSurfaceTube(hlTopPts, '#ff6b9d', 0.75, 0.002);
      // Límite superior/medio (hairlineBottomY)
      const hlBotPts = sweepSurface(hairlineBottomY, false, 80);
      makeSurfaceTube(hlBotPts, '#f97316', 0.75, 0.002);
      // Límite medio/inferior
      const hlMidBotPts = sweepSurface(tercioMedioBottomY, false, 80);
      makeSurfaceTube(hlMidBotPts, '#a78bfa', 0.75, 0.002);
      // Límite inferior del tercio inferior (mentón)
      const hlInfBotPts = sweepSurface(tercioInferiorBottomY, false, 80);
      makeSurfaceTube(hlInfBotPts, '#34d399', 0.75, 0.002);
    }

    // ── Líneas de referencia ──
    if (!referenceLines || referenceLines.length === 0) {
      onIntersectionsCalculated([]);
      linePathsRef.current = [];
      return;
    }

    const newLinePaths: { lineId: string; pts: THREE.Vector3[] }[] = [];

    referenceLines.forEach((line: ReferenceLine) => {
      if (!line.visible) return;
      // Las líneas punteadas usan 5× más pasos de muestreo para que los trazos
      // sean densos y suaves (sin "huecos vacíos" entre puntos de la malla)
      const isDashed = !!(line as any).dashed;
      const extraSteps = isDashed ? 5 : 1;
      if (line.type === 'vertical') {
        const rawPts = sweepVerticalLimited(line.offset ?? 0, hairlineTopY, hairlineBottomY, 100 * extraSteps);
        // Corregir hundimientos en el socket ocular (umbral 0.30 para verticales, 16 pasadas)
        const pts = bridgeConcavities(rawPts, 0.30);
        makeSurfaceTube(pts, line.color, 1.0, 0.002, isDashed);
        newLinePaths.push({ lineId: line.id, pts });
      } else if (line.type === 'horizontal') {
        const pts = sweepSurface(line.offset ?? 0, false, 80 * extraSteps);
        makeSurfaceTube(pts, line.color, 1.0, 0.002, isDashed);
        newLinePaths.push({ lineId: line.id, pts });
      } else if (line.type === 'two-points') {
        const anchors = line.anchors;
        if (anchors && anchors.length >= 2) {
          const rawPtsDiag = sweepDiagonal(anchors[0], anchors[1], 80 * extraSteps);
          const pts = bridgeConcavities(rawPtsDiag, 0.30);
          makeSurfaceTube(pts, line.color, 1.0, 0.002, isDashed);
          newLinePaths.push({ lineId: line.id, pts });
        }
      }
    });

    linePathsRef.current = newLinePaths;

    // ── Cálculo de intersecciones: TODOS los tipos de líneas ──────────────────
    const visibleLines = referenceLines.filter((l: ReferenceLine) => l.visible);
    const calcIntersections: { id: string; x: number; y: number; z: number; lineIds: string[] }[] = [];

    // Helper: par de puntos más cercano entre dos paths
    const findClosestPair = (pathA: THREE.Vector3[], pathB: THREE.Vector3[]) => {
      let bestDist = Infinity;
      let bestMid: THREE.Vector3 | null = null;
      for (const p1 of pathA) {
        for (const p2 of pathB) {
          const d = p1.distanceTo(p2);
          if (d < bestDist) {
            bestDist = d;
            bestMid = p1.clone().add(p2).multiplyScalar(0.5);
          }
        }
      }
      return { bestDist, bestMid };
    };

    const THRESHOLD = 0.40; // unidades 3D

    for (let i = 0; i < visibleLines.length; i++) {
      for (let j = i + 1; j < visibleLines.length; j++) {
        const lineA = visibleLines[i];
        const lineB = visibleLines[j];
        // Omitir pares paralelos del mismo tipo que nunca se cruzan
        if (lineA.type === lineB.type && (lineA.type === 'vertical' || lineA.type === 'horizontal')) continue;
        const pathA = newLinePaths.find(lp => lp.lineId === lineA.id)?.pts ?? [];
        const pathB = newLinePaths.find(lp => lp.lineId === lineB.id)?.pts ?? [];
        if (pathA.length === 0 || pathB.length === 0) continue;
        const { bestDist, bestMid } = findClosestPair(pathA, pathB);
        if (bestMid && bestDist < THRESHOLD) {
          calcIntersections.push({
            id: `int-${lineA.id}-${lineB.id}`,
            x: bestMid.x, y: bestMid.y, z: bestMid.z,
            lineIds: [lineA.id, lineB.id],
          });
        }
      }
    }

    // ── Renderizar esferas de intersección DIRECTAMENTE en editablePointsGroupRef ──
    // (imperativo, sin pasar por el ciclo React de estado→prop→useEffect)
    if (editablePointsGroupRef.current) {
      const epGroup = editablePointsGroupRef.current;
      // Eliminar solo las esferas de tipo 'intersection' (preservar puntos libres)
      const toRemove = [...epGroup.children].filter(c => c.userData.epType === 'intersection');
      toRemove.forEach(c => {
        c.traverse((m: any) => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
        epGroup.remove(c);
      });

      if (showIntersections) {
        calcIntersections.forEach(ipt => {
          // Saltar puntos que el usuario borró explícitamente
          if (callbacks.current.deletedIntersectionIds?.includes(ipt.id)) return;

          // Solo usar la posición guardada si el usuario ARRASTRÓ este punto manualmente (flag userMoved).
          // Si no fue arrastrado, siempre se usa la posición geométrica recalculada para que
          // los puntos sigan a las líneas cuando estas se desplazan.
          const storedPt = (callbacks.current.editablePoints as any[])?.find((ep: any) => ep.id === ipt.id);
          const isUserMoved = storedPt?.userMoved === true;
          const px = isUserMoved ? storedPt.x : ipt.x;
          const py = isUserMoved ? storedPt.y : ipt.y;
          const pz = isUserMoved ? storedPt.z : ipt.z;
          const pointName = storedPt?.name || 'Intersección';

          const ptGroup = new THREE.Group();
          ptGroup.userData.isEditablePoint = true;
          ptGroup.userData.editableId = ipt.id;
          ptGroup.userData.lineIds = ipt.lineIds;
          ptGroup.userData.epType = 'intersection';
          ptGroup.userData.pointName = pointName;
          ptGroup.position.set(px, py, pz);
          // Núcleo sólido — renderOrder:1000 → encima de los tubes (999)
          const iCoreGeo = new THREE.SphereGeometry(0.02, 12, 12);
          const iCoreMesh = new THREE.Mesh(iCoreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
          iCoreMesh.renderOrder = 1000;
          ptGroup.add(iCoreMesh);
          // Envolvente cristal cian
          const geo = new THREE.SphereGeometry(0.04, 16, 16);
          const mat = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(0x00eeff),
            emissive: new THREE.Color(0x00eeff),
            emissiveIntensity: 0.6,
            transparent: true,
            opacity: 0.35,
            roughness: 0,
            transmission: 0.98,
            thickness: 0.3,
            ior: 1.5,
            clearcoat: 1.0,
            clearcoatRoughness: 0,
          });
          const sphere = new THREE.Mesh(geo, mat);
          sphere.renderOrder = 1000;
          ptGroup.add(sphere);
          epGroup.add(ptGroup);
        });
      }
    }

    // Notificar al padre los puntos calculados (para JSON export / React state)
    onIntersectionsCalculated(calcIntersections);

  }, [referenceLines, modelVersion, showHairline, hairlineTopY, hairlineBottomY, tercioMedioBottomY, tercioInferiorBottomY, showIntersections]);

  // ── useEffect: solo PUNTOS LIBRES (los de intersección se renderizan directamente en el lines useEffect) ──
  useEffect(() => {
    if (!editablePointsGroupRef.current) return;
    const group = editablePointsGroupRef.current;
    // Eliminar solo puntos libres (preservar los de intersección que maneja el lines useEffect)
    const toRemove = [...group.children].filter(c => c.userData.epType === 'free');
    toRemove.forEach(c => {
      c.traverse((m: any) => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
      group.remove(c);
    });

    const freePoints = editablePoints.filter((pt: any) => pt.type === 'free');
    freePoints.forEach((pt: any) => {
      const ptGroup = new THREE.Group();
      ptGroup.userData.isEditablePoint = true;
      ptGroup.userData.editableId = pt.id;
      ptGroup.userData.lineIds = [];
      ptGroup.userData.epType = 'free';
      ptGroup.userData.pointName = pt.name || 'Punto libre';
      ptGroup.position.set(pt.x, pt.y, pt.z);
      // Núcleo sólido — renderOrder:1000 → encima de los tubes (999)
      const fCoreGeo = new THREE.SphereGeometry(0.02, 12, 12);
      const fCoreMesh = new THREE.Mesh(fCoreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      fCoreMesh.renderOrder = 1000;
      ptGroup.add(fCoreMesh);
      // Envolvente cristal amarillo
      const geo = new THREE.SphereGeometry(0.04, 16, 16);
      const mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(0xffdd00),
        emissive: new THREE.Color(0xffdd00),
        emissiveIntensity: 0.6,
        transparent: true,
        opacity: 0.35,
        roughness: 0,
        transmission: 0.98,
        thickness: 0.3,
        ior: 1.5,
        clearcoat: 1.0,
        clearcoatRoughness: 0,
      });
      const sphere = new THREE.Mesh(geo, mat);
      sphere.renderOrder = 1000;
      ptGroup.add(sphere);
      group.add(ptGroup);
    });
  }, [editablePoints]);

  return (
    <div className="relative w-full h-full">
        {/* Contenedor 3D: React nunca debe actualizar sus hijos para no borrar el Canvas */}
        <div ref={mountRef} className="absolute inset-0 w-full h-full cursor-crosshair" />

        {/* ── LEYENDA DE LÍNEAS (esquina superior izquierda) ── */}
        {(referenceLines.length > 0 || showHairline) && (
          <div className="absolute top-3 left-3 z-20 flex flex-col gap-1 pointer-events-none">
            {showHairline && (
              <>
                <div className="flex items-center gap-1.5 bg-slate-900/70 backdrop-blur-sm rounded px-2 py-1 border border-slate-700/50">
                  <span className="w-4 h-0.5 rounded-full shrink-0" style={{ backgroundColor: '#ff6b9d', boxShadow: '0 0 4px #ff6b9d' }} />
                  <span className="text-[10px] text-slate-300 font-medium leading-none">Hairline (sup.)</span>
                </div>
                <div className="flex items-center gap-1.5 bg-slate-900/70 backdrop-blur-sm rounded px-2 py-1 border border-slate-700/50">
                  <span className="w-4 h-0.5 rounded-full shrink-0" style={{ backgroundColor: '#f97316', boxShadow: '0 0 4px #f97316' }} />
                  <span className="text-[10px] text-slate-300 font-medium leading-none">Límite sup./med.</span>
                </div>
                <div className="flex items-center gap-1.5 bg-slate-900/70 backdrop-blur-sm rounded px-2 py-1 border border-slate-700/50">
                  <span className="w-4 h-0.5 rounded-full shrink-0" style={{ backgroundColor: '#a78bfa', boxShadow: '0 0 4px #a78bfa' }} />
                  <span className="text-[10px] text-slate-300 font-medium leading-none">Límite med./inf.</span>
                </div>
                <div className="flex items-center gap-1.5 bg-slate-900/70 backdrop-blur-sm rounded px-2 py-1 border border-slate-700/50">
                  <span className="w-4 h-0.5 rounded-full shrink-0" style={{ backgroundColor: '#34d399', boxShadow: '0 0 4px #34d399' }} />
                  <span className="text-[10px] text-slate-300 font-medium leading-none">Límite inf. tercio inf.</span>
                </div>
              </>
            )}
            {referenceLines.filter((l: ReferenceLine) => l.visible).map((line: ReferenceLine) => (
              <div key={line.id} className="flex items-center gap-1.5 bg-slate-900/70 backdrop-blur-sm rounded px-2 py-1 border border-slate-700/50">
                <span className="w-4 h-0.5 shrink-0" style={
                  (line as any).dashed
                    ? { background: `repeating-linear-gradient(to right, ${line.color} 0px, ${line.color} 3px, transparent 3px, transparent 5px)`, boxShadow: `0 0 4px ${line.color}` }
                    : { backgroundColor: line.color, borderRadius: '9999px', boxShadow: `0 0 4px ${line.color}` }
                } />
                <span className="text-[10px] text-slate-200 font-medium leading-none truncate max-w-[140px]">{line.label}</span>
              </div>
            ))}
          </div>
        )}
        
        {/* Capa de UI Overlay: React gestiona esto libremente sin afectar al canvas */}
        {selectionBox && (
            <div 
                style={{
                    position: 'absolute',
                    left: Math.min(selectionBox.start.x, selectionBox.end.x),
                    top: Math.min(selectionBox.start.y, selectionBox.end.y),
                    width: Math.abs(selectionBox.end.x - selectionBox.start.x),
                    height: Math.abs(selectionBox.end.y - selectionBox.start.y),
                    border: '2px dashed #eab308', // yellow-500
                    background: 'rgba(234, 179, 8, 0.2)',
                    pointerEvents: 'none',
                    zIndex: 50
                }}
            />
        )}

        {/* ── TOOLTIP DE MARCADORES ── */}
        {tooltip && (
          <div
            className="absolute z-30 pointer-events-none bg-slate-900/90 backdrop-blur-sm border border-slate-600/60 text-slate-200 text-[11px] font-medium px-2.5 py-1.5 rounded-lg shadow-xl whitespace-nowrap"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            {tooltip.text}
          </div>
        )}

        {/* ── INDICADOR DE PUNTO SELECCIONADO (navegación por teclado) ── */}
        {selectedPointName && (
          <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-30 pointer-events-none bg-slate-900/92 backdrop-blur-sm border border-cyan-500/60 px-3 py-2 rounded-xl shadow-xl flex flex-col items-center gap-0.5">
            <span className="text-cyan-300 text-[11px] font-semibold">● {selectedPointName} seleccionado</span>
            <span className="text-slate-400 text-[10px]">↑↓←→ mover · Shift+flecha = paso grande · Del = borrar · Ctrl+Z = deshacer · Esc o clic para deseleccionar</span>
          </div>
        )}

        {/* UI Flotante para Modo Polígono - MOVIDO ABAJO PARA EVITAR SOLAPAMIENTO */}
        {isZoneEditMode && zoneSelectionMode === 'polygon' && (
            <div className="absolute top-[160px] left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-900/90 border border-yellow-500/50 p-2 rounded-xl backdrop-blur-md shadow-xl z-50 pointer-events-auto">
                <span className="text-yellow-400 font-bold px-2 text-sm flex items-center gap-2">
                    <Maximize className="w-4 h-4" />
                    {polygonPointCount} Puntos
                </span>
                <div className="h-6 w-px bg-slate-700 mx-1" />
                <button 
                    onClick={clearPolygon}
                    disabled={polygonPointCount === 0}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors disabled:opacity-50"
                >
                    Limpiar
                </button>
                <button 
                    onClick={finishPolygon}
                    disabled={polygonPointCount < 3}
                    className="px-4 py-1.5 text-xs font-bold bg-yellow-500 hover:bg-yellow-400 text-slate-900 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-yellow-500/20"
                >
                    Finalizar Zona
                </button>
            </div>
        )}
    </div>
  );
};

// ==========================================
// COMPONENTE PRINCIPAL DE LA APLICACIÓN
// ==========================================

export default function Clinical3D() {
  const navigate = useNavigate();
  const [selectedPathology, setSelectedPathology] = useState(PATHOLOGIES[0].id);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [pendingMarker, setPendingMarker] = useState<any>(null);
  
  // Nuevo Estado: Editor de Zonas
  const [isZoneEditMode, setIsZoneEditMode] = useState(false);
  const [zoneSelectionMode, setZoneSelectionMode] = useState<'rectangle' | 'polygon'>('rectangle');
  const [pendingZone, setPendingZone] = useState<any>(null);
  const [newZoneName, setNewZoneName] = useState("");
  
  // Estado para manejar el origen del modelo 3D
  const [modelSource, setModelSource] = useState<{ type: 'url' | 'buffer'; data: string | ArrayBuffer }>({ 
    type: 'url', 
    data: '/models/clinical/male_head.glb'
  });
  const [modelError, setModelError] = useState(false);
  const [dbLoaded, setDbLoaded] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notification, setNotification] = useState<{message: string, type: 'success' | 'error' | 'info'} | null>(null);

  // === Estados para Líneas de Referencia ===
  const [referenceLines, setReferenceLines] = useState<ReferenceLine[]>([]);
  const [activeLineType, setActiveLineType] = useState<LineType | null>(null);
  const [pendingLineMeta, setPendingLineMeta] = useState<{ label: string; color: string; dashed?: boolean; preset?: LinePreset } | null>(null);
  const [firstLineAnchor, setFirstLineAnchor] = useState<{ x: number; y: number; z: number } | null>(null);
  const [twoPointStep, setTwoPointStep] = useState<0 | 1 | 2>(0);
  const [activeTab, setActiveTab] = useState<'lines' | 'marking'>('marking');

  // === Líneas de límite del tercio superior ===
  // hairlineTopY: frente / nacimiento del cabello (arriba)
  // hairlineBottomY: debajo del ojo / inicio del tercio medio (abajo)
  const [hairlineTopY, setHairlineTopY] = useState(4.8);
  const [hairlineBottomY, setHairlineBottomY] = useState(-2.0);
  const [tercioMedioBottomY, setTercioMedioBottomY] = useState(-5.5);
  const [tercioInferiorBottomY, setTercioInferiorBottomY] = useState(-9.0);
  const [showHairline, setShowHairline] = useState(true);

  // === Puntos de intersección entre líneas ===
  const [intersectionPoints, setIntersectionPoints] = useState<{ id: string; x: number; y: number; z: number; lineIds: string[] }[]>([]);
  const [showIntersections, setShowIntersections] = useState(true);

  // === Puntos editables (intersecciones + libres) ===
  const [editablePoints, setEditablePoints] = useState<Array<{ id: string; x: number; y: number; z: number; lineIds: string[]; type: 'intersection' | 'free'; name?: string }>>([]);
  const [pointMode, setPointMode] = useState<'none' | 'add' | 'delete'>('none');

  // === IDs de intersecciones borradas explícitamente por el usuario ===
  // Persiste entre recálculos de líneas para evitar que los puntos borrados reaparezcan
  const [deletedIntersectionIds, setDeletedIntersectionIds] = useState<string[]>([]);

  const isLoading = !(dbLoaded && modelLoaded) && !modelError;

  // Inicializar base de datos
  useEffect(() => {
    const initializeData = async () => {
      const data = await mockDB.load();
      setMarkers(data.markers);
      setZones(data.zones);
      setDbLoaded(true);
    };
    initializeData();
  }, []);

  const showNotification = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  // Manejador para la subida de archivos manual
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // 1. Resetear estados inmediatamente para mostrar carga
      setModelError(false);
      setModelLoaded(false); 
      setNotification(null); // Limpiar notificaciones previas

      const reader = new FileReader();
      
      reader.onload = (e) => {
        if (e.target?.result) {
          // 2. Establecer fuente del modelo
          const buffer = e.target.result;
          setModelSource({ type: 'buffer', data: buffer });
          showNotification('Procesando archivo...', 'info');
        }
      };
      
      reader.onerror = () => {
        setModelError(true);
        showNotification('Error al leer el archivo local.', 'error');
      };

      reader.readAsArrayBuffer(file);
    }
    // 3. Resetear input para permitir subir el mismo archivo si falla
    event.target.value = '';
  };

    const handleMeshClick = (interactionData: any) => {
        if (isZoneEditMode) {
            // AL CREAR ZONA (MODO REGISTRO): Guardamos posición y radio exactos del dibujo
            setPendingZone({
                center: interactionData.position, // Mapear position -> center
                radius: interactionData.radius,
                rotation: interactionData.rotation,
                scale: interactionData.scale, // Guardar escala rectangular Este ratio viene del cálculo del polígono
                points: interactionData.points // Guardar puntos del polígono irregular
            });
            setNewZoneName("");
        } else {
            console.log("Setting pending marker:", interactionData);
            setPendingMarker({
                ...interactionData,
                pathologyId: selectedPathology,
            });
        }
    };

  const handleSaveZone = async () => {
    if (!pendingZone || !newZoneName.trim()) return;
    setIsSaving(true);
    
    const newZone: Zone = {
        id: Date.now().toString(),
        name: newZoneName,
        center: pendingZone.center,
        radius: pendingZone.radius || 0.6,
        // rotation: pendingZone.rotation, // Duplicated property removed
        scale: pendingZone.scale || { x: 0.6, y: 0.6 }, // Guardar escala.4,
        // NUEVO: Guardar rotación si existe (para polígonos orientados)
        rotation: pendingZone.rotation 
    };
    
    await mockDB.saveZone(newZone);
    setZones(prev => [...prev, newZone]);
    setPendingZone(null);
    showNotification(`Zona "${newZoneName}" registrada correctamente`, 'success');
    setIsSaving(false);
  };

  const handleConfirmMarker = async (type: MarkerType) => {
    if (!pendingMarker) return;
    setIsSaving(true);
    
    // Si la marcación es ZONAL, intentamos recuperar el radio registrad (fallback)
    let markerToSave = { ...pendingMarker, type };
    if (type === 'Zonal' && pendingMarker.zone) {
        const zoneName = pendingMarker.zone;
        const registeredZone = zones.find(z => z.name === zoneName);
        
        if (registeredZone) {
            // Si encontramos la zona registrada, usamos sus datos para replicar
            // la visualización exacta que se definió al crearla.
            markerToSave = {
                ...markerToSave,
                radius: registeredZone.radius, // Usar tamaño registrado
                // CLAVE: Usar la posición central registrada y la rotación registrada
                // Si no, el marcador se dibuja donde hicimos click (p.ej en el borde) en lugar del centro de la zona
                position: registeredZone.center, 
                // Usar rotación guardada si existe, sino recalcular (pero preferimos la guardada porque ya estaba bien orientada)
                rotation: registeredZone.rotation || markerToSave.rotation,
                scale: registeredZone.scale // IMPORTANTE: Usar la forma rectangular registrada
            };
        } else {
             // Si no hay zona registrada (es una zona autodetectada genérica), usamos un radio default
             // Ya hemos bajado el default a 0.6 en la visualización, pero podemos ser explícitos aquí
             markerToSave = { ...markerToSave, radius: 0.6 };
        }
    }

    const response = await mockDB.save(markerToSave);
    
    if (response.success) {
      setMarkers(prev => [...prev, response.marker]);
      setPendingMarker(null);
      showNotification('Marcador clínico mapeado y guardado con éxito.', 'success');
    }
    setIsSaving(false);
  };

  // Funciones para UI de controles (Zoom y Rotación) deben ser accesibles
  const handleManualRotate = (direction: 'left' | 'right' | 'up' | 'down') => {
      // @ts-ignore
      const controls = window.clinical3d_controls;
      if (!controls) return;

      const camera = controls.object;
      const r = camera.position.distanceTo(controls.target);
      
      let phi = Math.acos( (camera.position.y - controls.target.y) / r );
      let theta = Math.atan2( camera.position.z - controls.target.z, camera.position.x - controls.target.x );
      
      const speed = 0.5; // Radianes
      
      if (direction === 'left') theta += speed;
      if (direction === 'right') theta -= speed;
      if (direction === 'up') phi = Math.max(0.1, phi - speed);
      if (direction === 'down') phi = Math.min(Math.PI - 0.1, phi + speed);
      
      const newX = r * Math.sin(phi) * Math.cos(theta);
      const newY = r * Math.cos(phi);
      const newZ = r * Math.sin(phi) * Math.sin(theta); // Corregido cos -> sin para Z en esféricas estándar
      
      camera.position.set(newX + controls.target.x, newY + controls.target.y, newZ + controls.target.z);
      controls.update();
  };

  const handleZoom = (zoomIn: boolean) => {
      // @ts-ignore
      const controls = window.clinical3d_controls;
      if (!controls) return;
      
      const camera = controls.object;
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      
      const distance = zoomIn ? 5 : -5;
      camera.position.add(direction.multiplyScalar(distance));
      controls.update();  
  };

  // === Handlers de Líneas de Referencia ===
  const handleSelectPreset = (preset: LinePreset) => {
    if (preset.type === 'two-points') {
      // Línea diagonal: requiere seleccionar dos puntos en el modelo
      setActiveLineType('two-points');
      setPendingLineMeta({ label: preset.label, color: preset.color, dashed: preset.dashed });
      setTwoPointStep(1);
      setFirstLineAnchor(null);
      showNotification('Haz clic en el primer punto de la línea diagonal', 'info');
      return;
    }
    // Vertical/horizontal: creación inmediata con offset 0 (ajustable con el slider)
    const newLine: ReferenceLine = {
      id: `line-${Date.now()}`,
      type: preset.type,
      label: preset.label,
      color: preset.color,
      dashed: preset.dashed,
      visible: true,
      offset: 0,
    };
    setReferenceLines(prev => [...prev, newLine]);
    setActiveLineType(null);
    setPendingLineMeta(null);
  };

  const handleStartManualLine = (type: LineType, label: string, color: string) => {
    setActiveLineType(type);
    setPendingLineMeta({ label, color });
    setTwoPointStep(type === 'two-points' ? 1 : 0);
    setFirstLineAnchor(null);
    showNotification(type === 'two-points' ? 'Haz clic en el primer punto de la línea' : 'Haz clic en el modelo para anclar la línea', 'info');
  };

  const handleCancelLine = () => {
    setActiveLineType(null);
    setPendingLineMeta(null);
    setFirstLineAnchor(null);
    setTwoPointStep(0);
  };

  const handleLinePointAnchored = (point: { x: number; y: number; z: number }) => {
    if (!activeLineType || !pendingLineMeta) return;

    if (activeLineType === 'two-points') {
      if (twoPointStep === 1) {
        setFirstLineAnchor(point);
        setTwoPointStep(2);
        showNotification('Haz clic en el segundo punto de la línea', 'info');
      } else if (twoPointStep === 2 && firstLineAnchor) {
        const newLine: ReferenceLine = {
          id: `line-${Date.now()}`,
          type: 'two-points',
          label: pendingLineMeta.label,
          color: pendingLineMeta.color,
          dashed: pendingLineMeta.dashed,
          visible: true,
          offset: 0,
          anchors: [firstLineAnchor, point],
        };
        setReferenceLines(prev => [...prev, newLine]);
        setActiveLineType(null);
        setPendingLineMeta(null);
        setFirstLineAnchor(null);
        setTwoPointStep(0);
        showNotification('Línea de referencia creada', 'success');
      }
    } else {
      const offset = activeLineType === 'vertical' ? point.x : point.y;
      const newLine: ReferenceLine = {
        id: `line-${Date.now()}`,
        type: activeLineType,
        label: pendingLineMeta.label,
        color: pendingLineMeta.color,
        visible: true,
        offset,
      };
      setReferenceLines(prev => [...prev, newLine]);
      setActiveLineType(null);
      setPendingLineMeta(null);
      setTwoPointStep(0);
      showNotification('Línea de referencia creada', 'success');
    }
  };

  const handleToggleLineVisibility = (id: string) => {
    setReferenceLines(prev => prev.map(l => l.id === id ? { ...l, visible: !l.visible } : l));
  };

  const handleLineOffsetChange = (id: string, offset: number) => {
    setReferenceLines(prev => prev.map(l => l.id === id ? { ...l, offset } : l));
  };

  const handleRemoveLine = (id: string) => {
    setReferenceLines(prev => prev.filter(l => l.id !== id));
  };

  const handleLineLabelChange = (id: string, label: string) => {
    setReferenceLines(prev => prev.map(l => l.id === id ? { ...l, label } : l));
  };

  // === Mover marcador arrastrado ===
  const handleMarkerMoved = (markerId: string, newPosition: { x: number; y: number; z: number }) => {
    setMarkers(prev => prev.map(m => m.id === markerId ? { ...m, position: newPosition } : m));
    mockDB.data = mockDB.data.map(m => m.id === markerId ? { ...m, position: newPosition } : m);
  };

  // === Importar JSON ===
  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string);
        if (data.referenceLines) {
          setReferenceLines(data.referenceLines.map((l: any) => ({ ...l, visible: l.visible ?? true })));
        }
        if (data.hairline) {
          if (data.hairline.topY !== undefined) setHairlineTopY(data.hairline.topY);
          if (data.hairline.bottomY !== undefined) setHairlineBottomY(data.hairline.bottomY);
          if (data.hairline.tercioMedioBottomY !== undefined) setTercioMedioBottomY(data.hairline.tercioMedioBottomY);
          if (data.hairline.tercioInferiorBottomY !== undefined) setTercioInferiorBottomY(data.hairline.tercioInferiorBottomY);
        }
        if (data.markers && Array.isArray(data.markers)) {
          setMarkers(data.markers);
          mockDB.data = data.markers;
        }
        if (data.editablePoints && Array.isArray(data.editablePoints)) {
          setEditablePoints(data.editablePoints);
        }
        // Restaurar IDs de intersecciones borradas para que no reaparezcan al recalcular líneas
        if (data.deletedIntersectionIds && Array.isArray(data.deletedIntersectionIds)) {
          setDeletedIntersectionIds(data.deletedIntersectionIds);
        } else {
          setDeletedIntersectionIds([]);
        }
        const importedTotal = (data.editablePoints as any[])?.length ?? 0;
        const importedInters = (data.editablePoints as any[])?.filter((p: any) => p.type === 'intersection').length ?? 0;
        const importedFree = (data.editablePoints as any[])?.filter((p: any) => p.type === 'free').length ?? 0;
        showNotification(`JSON importado: ${data.referenceLines?.length ?? 0} líneas, ${importedTotal} pts (${importedInters} intersecciones · ${importedFree} libres)`, 'success');
      } catch {
        showNotification('Error al parsear el JSON', 'error');
      }
    };
    reader.readAsText(file);
    // Resetear input para permitir reimportar el mismo archivo
    e.target.value = '';
  };

  const handleSaveJson = () => {
    const data = {
      version: '1.0',
      model: 'male_head',
      generatedAt: new Date().toISOString(),
      hairline: {
        topY: hairlineTopY,
        bottomY: hairlineBottomY,
        tercioMedioBottomY,
        tercioInferiorBottomY,
        labelTop: 'Hairline / Nacimiento del cabello',
        labelBottom: 'Límite inferior tercio superior',
        labelMedioBottom: 'Límite inferior tercio medio',
        labelInferiorBottom: 'Límite inferior tercio inferior',
        colorTop: '#ff6b9d',
        colorBottom: '#f97316',
        colorMedioBottom: '#a78bfa',
        colorInferiorBottom: '#34d399',
      },
      markers: markers.map((m: Marker) => ({ ...m })),
      referenceLines: referenceLines.map((l: ReferenceLine) => ({
        id: l.id,
        type: l.type,
        label: l.label,
        color: l.color,
        visible: l.visible,
        offset: l.offset,
        ...(l.dashed ? { dashed: l.dashed } : {}),
        ...(l.anchors ? { anchors: l.anchors } : {}),
      })),
      // Usar editablePoints filtrado como fuente de verdad — intersectionPoints puede estar
      // desactualizado si el usuario borró puntos sin mover líneas (linesEffect no se re-ejecuta)
      intersectionPoints: editablePoints
        .filter((pt: any) => pt.type === 'intersection')
        .map((pt: any) => ({
          id: pt.id,
          x: parseFloat(pt.x.toFixed(4)),
          y: parseFloat(pt.y.toFixed(4)),
          z: parseFloat(pt.z.toFixed(4)),
          lineIds: pt.lineIds,
        })),
      editablePoints: editablePoints.map((pt: any) => ({
        id: pt.id,
        type: pt.type,
        x: parseFloat(pt.x.toFixed(4)),
        y: parseFloat(pt.y.toFixed(4)),
        z: parseFloat(pt.z.toFixed(4)),
        lineIds: pt.lineIds,
        ...(pt.name ? { name: pt.name } : {}),
        // Persistir flag de desplazamiento manual para restaurar posición al importar
        ...(pt.userMoved ? { userMoved: true } : {}),
      })),
      // IDs de intersecciones borradas — permite restaurar el estado exacto al importar
      deletedIntersectionIds,
      summary: {
        totalLines: referenceLines.length,
        verticalLines: referenceLines.filter((l: ReferenceLine) => l.type === 'vertical').length,
        horizontalLines: referenceLines.filter((l: ReferenceLine) => l.type === 'horizontal').length,
        diagonalLines: referenceLines.filter((l: ReferenceLine) => l.type === 'two-points').length,
        totalIntersections: editablePoints.filter((p: any) => p.type === 'intersection').length,
      },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trazado-referencia-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const savedIntersCount = editablePoints.filter((p: any) => p.type === 'intersection').length;
    const savedFreeCount = editablePoints.filter((p: any) => p.type === 'free').length;
    showNotification(`JSON generado: ${referenceLines.length} líneas, ${editablePoints.length} pts (${savedIntersCount} intersecciones · ${savedFreeCount} libres)`, 'success');
  };

  return (
    <div className="w-full h-screen bg-slate-950 flex overflow-hidden font-sans text-slate-100 relative">
      
      {/* Botón Volver */}
      <div className="absolute top-4 left-4 z-50 flex items-center gap-3">
        <button 
          onClick={() => navigate('/admin')}
          className="px-4 py-2 bg-slate-800/80 hover:bg-slate-700 backdrop-blur-md rounded-lg text-white text-sm font-medium border border-slate-700 transition-colors"
        >
          ← Volver al Panel
        </button>
        
        {/* Toggle para Modo Registro de Zonas */}
        <button 
          onClick={() => setIsZoneEditMode(!isZoneEditMode)}
          className={`px-4 py-2 rounded-lg text-sm font-bold border transition-all flex items-center gap-2 ${
            isZoneEditMode 
              ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400' 
              : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:text-white'
          }`}
          title={isZoneEditMode ? "Salir de Registro" : "Registrar Zonas Anatómicas"}
        >
          <Database className="w-4 h-4" />
          {isZoneEditMode ? 'Finalizar Registro' : 'Configurar Zonas'}
        </button>
      </div>

        {/* Controles Visuales (Overlay en el lienzo 3D) */}
        {!modelError && modelLoaded && (
        <div className="absolute right-6 top-6 flex flex-col gap-2 z-20 pointer-events-auto">
            <div className="bg-slate-900/80 backdrop-blur-md p-2 rounded-xl border border-slate-700 shadow-xl flex flex-col gap-2">
                <span className="text-[10px] uppercase font-bold text-center text-slate-500 mb-1">Cámara</span>
                
                <div className="grid grid-cols-3 gap-1">
                    <div />
                    <button onClick={() => {
                        // @ts-ignore
                        if (window.clinical3d_controls) {
                            // @ts-ignore
                            window.clinical3d_controls.object.position.y += 5; 
                            // @ts-ignore
                            window.clinical3d_controls.update();
                        }
                    }} className="p-2 bg-slate-800 hover:bg-cyan-600 rounded-lg transition-colors text-white" title="Mover Arriba">
                        <Move className="w-4 h-4 rotate-180" />
                    </button>
                    <div />
                    
                    <button onClick={() => handleManualRotate('left')} className="p-2 bg-slate-800 hover:bg-cyan-600 rounded-lg transition-colors text-white" title="Rotar Izquierda">
                        <RotateCcw className="w-4 h-4" />
                    </button>
                    <div className="flex items-center justify-center">
                        <Move className="w-4 h-4 text-slate-500" />
                    </div>
                    <button onClick={() => handleManualRotate('right')} className="p-2 bg-slate-800 hover:bg-cyan-600 rounded-lg transition-colors text-white" title="Rotar Derecha">
                        <RotateCw className="w-4 h-4" />
                    </button>

                    <div />
                    <button onClick={() => {
                         // @ts-ignore
                         if (window.clinical3d_controls) {
                             // @ts-ignore
                             window.clinical3d_controls.object.position.y -= 5; 
                             // @ts-ignore
                             window.clinical3d_controls.update();
                         }
                    }} className="p-2 bg-slate-800 hover:bg-cyan-600 rounded-lg transition-colors text-white" title="Mover Abajo">
                        <Move className="w-4 h-4" />
                    </button>
                    <div />
                </div>

                <div className="h-px bg-slate-700 my-1" />

                <div className="flex justify-between gap-2">
                    <button onClick={() => handleZoom(false)} className="flex-1 p-2 bg-slate-800 hover:bg-cyan-600 rounded-lg transition-colors text-white flex justify-center" title="Alejar">
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleZoom(true)} className="flex-1 p-2 bg-slate-800 hover:bg-cyan-600 rounded-lg transition-colors text-white flex justify-center" title="Acercar">
                        <ZoomIn className="w-4 h-4" />
                    </button>
                </div>

                <button 
                  onClick={() => {
                        // Resetear vista
                        // @ts-ignore
                        const c = window.clinical3d_controls;
                        if(c) {
                            c.target.set(0,0,0);
                            c.object.position.set(0,0,40); // Posición inicial hardcodeada
                            c.update();
                        }
                  }}
                  className="mt-2 text-xs text-center text-cyan-400 hover:text-cyan-300 py-1"
                >
                    Resetear Vista
                </button>
            </div>

            <div className="bg-slate-900/80 backdrop-blur-md p-3 rounded-xl border border-slate-700 shadow-xl pointer-events-none">
                 <p className="text-xs text-slate-400 mb-2">
                    <strong className="text-white">Click Izquierdo:</strong> Rotar<br/>
                    <strong className="text-white">Click Derecho:</strong> Mover (Pan)<br/>
                    <strong className="text-white">Rueda:</strong> Zoom
                 </p>
            </div>
        </div>
        )}

      {/* ÁREA DEL LIENZO 3D */}
      <div className="flex-1 relative h-full bg-gradient-to-br from-slate-900 to-slate-950 flex items-center justify-center">
        
        {/* Renderizador de Escena */}
        <div className="absolute inset-0 z-0">
          {!modelError && (
              <ThreeScene 
                modelSource={modelSource} 
                markers={markers}
                zones={zones} 
                isZoneEditMode={isZoneEditMode}
                zoneSelectionMode={zoneSelectionMode}
                referenceLines={referenceLines}
                lineDrawingMode={activeLineType}
                onLinePointAnchored={handleLinePointAnchored}
                onMarkerMoved={handleMarkerMoved}
                hairlineTopY={hairlineTopY}
                hairlineBottomY={hairlineBottomY}
                tercioMedioBottomY={tercioMedioBottomY}
                tercioInferiorBottomY={tercioInferiorBottomY}
                showHairline={showHairline}
                showIntersections={showIntersections}
                editablePoints={editablePoints}
                pointMode={pointMode}
                deletedIntersectionIds={deletedIntersectionIds}
                onEditablePointMoved={(id: string, pos: any) => {
                  // Marcar el punto como desplazado manualmente para que su posición
                  // se preserve incluso cuando las líneas se recalculan.
                  setEditablePoints(prev => prev.map((p: any) => p.id === id ? { ...p, x: pos.x, y: pos.y, z: pos.z, userMoved: true } : p));
                }}
                onEditablePointDeleted={(id: string) => {
                  // Los IDs de intersecciones siempre empiezan con 'int-'
                  // Registrarlos para que no reaparezcan al recalcular líneas
                  if (id.startsWith('int-')) {
                    setDeletedIntersectionIds((prev: string[]) => prev.includes(id) ? prev : [...prev, id]);
                    // Sincronizar intersectionPoints para que la UI y el JSON reflejen el conteo real
                    setIntersectionPoints(prev => prev.filter(p => p.id !== id));
                  }
                  setEditablePoints((prev: any[]) => prev.filter((p: any) => p.id !== id));
                }}
                onEditablePointAdded={(pos: any) => {
                  const newPt = { id: `free-${Date.now()}`, x: pos.x, y: pos.y, z: pos.z, lineIds: [], type: 'free' as const, name: 'Punto libre' };
                  setEditablePoints(prev => [...prev, newPt]);
                }}
                onEditablePointRestored={(pt: any) => {
                  // Ctrl+Z: restaurar punto borrado — sacarlo del set de borrados si era intersección
                  if (pt.id?.startsWith('int-') || pt.type === 'intersection') {
                    setDeletedIntersectionIds((prev: string[]) => prev.filter((id: string) => id !== pt.id));
                    // Sincronizar intersectionPoints al restaurar
                    setIntersectionPoints(prev => {
                      const exists = prev.find(p => p.id === pt.id);
                      return exists ? prev : [...prev, { id: pt.id, x: pt.x, y: pt.y, z: pt.z, lineIds: pt.lineIds || [] }];
                    });
                  }
                  setEditablePoints((prev: any[]) => {
                    const exists = prev.find((p: any) => p.id === pt.id);
                    return exists ? prev : [...prev, pt];
                  });
                }}
                onIntersectionsCalculated={(pts: any[]) => {
                  // Filtrar intersecciones borradas explícitamente por el usuario
                  const active = pts.filter((p: any) => !deletedIntersectionIds.includes(p.id));
                  setIntersectionPoints(active);
                  // Actualizar editablePoints: preservar puntos libres y posiciones movidas, ignorar borrados
                  setEditablePoints(prev => {
                    const freePoints = prev.filter((p: any) => p.type === 'free');
                    const merged = active.map((np: any) => {
                      const existing = prev.find((p: any) => p.id === np.id && p.type === 'intersection');
                      return existing ?? { ...np, type: 'intersection' as const };
                    });
                    return [...merged, ...freePoints];
                  });
                }}
                onMeshClick={handleMeshClick}
                onLoaded={() => {
                  console.log("Modelo cargado correctamente");
                  setModelLoaded(true);
                  setModelError(false);
                }}
                onError={(msg: string) => {
                  console.error("Error cargando modelo:", msg);
                  setModelError(true);
                  // Solo mostramos notificación si no es el error inicial forzado
                  if (msg !== "No se pudo cargar el modelo automáticamente por seguridad del entorno. Por favor, súbelo manualmente.") {
                      showNotification(msg, 'error');
                  }
                }}
              />
          )}
        </div>

        {/* MODO EDICIÓN ZONAS: UI de Control */}
        {isZoneEditMode && modelLoaded && (
             <div className="absolute top-20 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 z-50">
                <div className="bg-yellow-500/90 text-slate-900 px-6 py-2 rounded-full backdrop-blur-md shadow-lg font-bold border-2 border-yellow-400 animate-pulse text-sm">
                    MODO REGISTRO DE ZONAS
                </div>
                
                {/* Selector de Herramienta */}
                <div className="flex bg-slate-900/90 backdrop-blur-md p-1 rounded-xl border border-slate-700 shadow-xl">
                    <button
                        onClick={() => setZoneSelectionMode('rectangle')}
                        className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all ${
                            zoneSelectionMode === 'rectangle' 
                                ? 'bg-yellow-500 text-slate-900 shadow-md' 
                                : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                    >
                        <Scan className="w-4 h-4" />
                        Rectángulo
                    </button>
                    <button
                        onClick={() => setZoneSelectionMode('polygon')}
                        className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all ${
                            zoneSelectionMode === 'polygon' 
                                ? 'bg-yellow-500 text-slate-900 shadow-md' 
                                : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                    >
                        <MousePointer2 className="w-4 h-4" />
                        Puntos (Polígono)
                    </button>
                </div>
             </div>
        )}

        {/* MODAL CREAR ZONA */}
        {isZoneEditMode && pendingZone && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
                <div className="bg-slate-900/90 border border-yellow-500/50 p-6 rounded-2xl w-[350px] shadow-2xl relative">
                    <button onClick={() => setPendingZone(null)} className="absolute top-2 right-2 text-slate-400 hover:text-white"><X className="w-5 h-5"/></button>
                    
                    <h3 className="text-lg font-bold text-yellow-400 mb-4 flex items-center gap-2">
                        <Database className="w-5 h-5" /> Registrar Nueva Zona
                    </h3>
                    
                    <div className="mb-4">
                        <label className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-2 block">Nombre de la Zona</label>
                        <input 
                            autoFocus
                            type="text" 
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-yellow-500 outline-none"
                            placeholder="Ej: Frente Central, Pómulo Izq..."
                            value={newZoneName}
                            onChange={(e) => setNewZoneName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveZone()}
                        />
                         <p className="text-xs text-slate-500 mt-2">
                            Se registrará el punto seleccionado como el centro de esta zona anatómica.
                         </p>
                    </div>

                    <button 
                        disabled={!newZoneName.trim() || isSaving}
                        onClick={handleSaveZone}
                        className="w-full py-3 bg-yellow-500 hover:bg-yellow-400 text-slate-900 font-bold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isSaving ? 'Guardando...' : 'Guardar Zona'}
                    </button>
                </div>
            </div>
        )}

        {/* PANTALLA DE CARGA */}
        {isLoading && !modelError && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/90 backdrop-blur-md transition-opacity duration-300">
              <Loader2 className="w-12 h-12 text-cyan-400 animate-spin mb-6" />
              <h2 className="text-xl font-light tracking-[0.2em] text-cyan-100">INICIALIZANDO MÓDULO 3D</h2>
              <p className="text-xs text-slate-500 mt-2 tracking-wide">Procesando geometría facial...</p>
          </div>
        )}

        {/* MENSAJE DE ERROR Y SUBIDA MANUAL EN EL CENTRO */}
        {modelError && (
          <div className="z-20 flex flex-col items-center p-8 bg-slate-900/90 border border-slate-700 rounded-2xl backdrop-blur-md shadow-2xl text-center max-w-md absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <AlertCircle className="w-12 h-12 text-rose-400 mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">Se requiere carga manual</h2>
            <p className="text-sm text-slate-400 mb-6">
              Por razones de seguridad del entorno virtual, no se pudo leer automáticamente el archivo. Por favor, selecciona tu archivo <strong>.glb</strong> manualmente para continuar.
            </p>
            <label className="flex items-center justify-center gap-2 w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl cursor-pointer transition-colors shadow-lg font-medium">
              <Upload className="w-5 h-5" />
              Subir Modelo 3D (.glb)
              <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleFileUpload} />
            </label>
          </div>
        )}

        {/* MODAL DE CONFIRMACIÓN (Glassmorphic) */}
        {pendingMarker && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-slate-900/80 border border-slate-700 shadow-2xl rounded-2xl p-6 w-[400px] backdrop-blur-xl">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h3 className="text-xl font-medium text-white flex items-center gap-2">
                    <Crosshair className="w-5 h-5 text-cyan-400" />
                    Confirmar Ubicación
                  </h3>
                  <p className="text-sm text-slate-400 mt-1">Selecciona el tipo de mapeo anatómico.</p>
                </div>
                <button 
                  onClick={() => setPendingMarker(null)}
                  className="p-1 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="bg-slate-800/50 rounded-xl p-4 mb-6 border border-slate-700/50">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Zona Detectada</span>
                  <span className="text-sm font-medium text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded-full">
                    {pendingMarker.zone}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Coordenadas</span>
                  <span className="text-xs font-mono text-slate-400">
                    X:{pendingMarker.position.x.toFixed(2)} Y:{pendingMarker.position.y.toFixed(2)} Z:{pendingMarker.position.z.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => handleConfirmMarker('Puntual')}
                  disabled={isSaving}
                  className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-slate-700 bg-slate-800/50 hover:bg-cyan-500/20 hover:border-cyan-500/50 transition-all group disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-full border-2 border-cyan-400 relative flex items-center justify-center group-hover:scale-110 transition-transform">
                    <div className="w-3 h-3 bg-cyan-400 rounded-full shadow-[0_0_10px_rgba(34,211,238,0.8)]" />
                  </div>
                  <span className="font-medium text-sm">Puntual</span>
                  <span className="text-xs text-slate-400 text-center">Punto de inyección o lesión específica</span>
                </button>

                <button
                  onClick={() => handleConfirmMarker('Zonal')}
                  disabled={isSaving}
                  className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-slate-700 bg-slate-800/50 hover:bg-violet-500/20 hover:border-violet-500/50 transition-all group disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-400/40 to-violet-600/40 border border-violet-400/50 group-hover:scale-110 transition-transform" />
                  <span className="font-medium text-sm">Zonal</span>
                  <span className="text-xs text-slate-400 text-center">Área de superficie o región de tratamiento</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* NOTIFICACIÓN TOAST */}
        {notification && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 rounded-full bg-slate-800/90 border border-slate-700 shadow-xl backdrop-blur-md animate-in slide-in-from-top-4">
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            ) : (
              <AlertCircle className="w-5 h-5 text-rose-400" />
            )}
            <span className="text-sm font-medium">{notification.message}</span>
          </div>
        )}
      </div>

      {/* PANEL LATERAL UI (Clínico Glassmorphic) */}
      <div className="w-[340px] flex flex-col bg-slate-900/95 backdrop-blur-2xl border-l border-slate-800 shadow-[-10px_0_30px_rgba(0,0,0,0.5)] z-30">
        
        {/* Cabecera */}
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg shadow-lg">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Mapa Estético</h1>
          </div>
          <p className="text-sm text-slate-400">Módulo Interactivo de Patología 3D</p>
        </div>

        {/* Subir archivo manual (Alternativa Lateral) */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/20">
          <label className="flex items-center justify-center gap-2 w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg cursor-pointer transition-colors text-xs font-medium">
            <Upload className="w-4 h-4" />
            Cargar nuevo modelo 3D (.glb)
            <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-slate-800">
          <button
            onClick={() => setActiveTab('marking')}
            className={`flex-1 py-3 text-xs font-semibold uppercase tracking-widest transition-colors ${
              activeTab === 'marking'
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-slate-800/30'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Marcación
          </button>
          <button
            onClick={() => setActiveTab('lines')}
            className={`flex-1 py-3 text-xs font-semibold uppercase tracking-widest transition-colors ${
              activeTab === 'lines'
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-slate-800/30'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Líneas
          </button>
        </div>

        {/* Tab: Marcación */}
        {activeTab === 'marking' && (
          <>
            {/* Sección de Herramientas */}
            <div className="p-6 border-b border-slate-800">
              <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Herramienta Activa</h2>
              
              <div className="space-y-3">
                {PATHOLOGIES.map((pathology) => {
                  const isActive = selectedPathology === pathology.id;
                  return (
                    <button
                      key={pathology.id}
                      onClick={() => setSelectedPathology(pathology.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                        isActive 
                          ? 'bg-slate-800 border border-slate-600 shadow-md' 
                          : 'hover:bg-slate-800/50 border border-transparent text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <div 
                        className="w-3 h-3 rounded-full shadow-sm" 
                        style={{ 
                          backgroundColor: pathology.color,
                          boxShadow: isActive ? `0 0 10px ${pathology.color}80` : 'none' 
                        }} 
                      />
                      <span className={`text-sm font-medium ${isActive ? 'text-white' : ''}`}>
                        {pathology.name}
                      </span>
                      {isActive && <CheckCircle2 className="w-4 h-4 ml-auto text-slate-400" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sección de Historial / Datos */}
            <div className="flex-1 p-6 overflow-y-auto custom-scrollbar">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Registros del Paciente</h2>
                <div className="flex items-center gap-1 text-xs font-medium text-slate-400 bg-slate-800 px-2 py-1 rounded-md">
                  <Database className="w-3 h-3" />
                  {markers.length} mapeados
                </div>
              </div>

              <div className="space-y-3">
                {markers.length === 0 ? (
                  <div className="text-center p-6 border border-dashed border-slate-700 rounded-xl text-slate-500 text-sm">
                    No hay marcadores anatómicos registrados. Haz clic en el modelo 3D para comenzar.
                  </div>
                ) : (
                  [...markers].reverse().map((marker) => {
                    const pathology = PATHOLOGIES.find(p => p.id === marker.pathologyId);
                    return (
                      <div key={marker.id} className="bg-slate-800/40 border border-slate-700/50 p-3 rounded-xl flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div 
                              className={`w-2 h-2 rounded-full ${marker.type === 'Puntual' ? 'opacity-100' : 'opacity-50'}`}
                              style={{ backgroundColor: pathology?.color }}
                            />
                            <span className="text-sm font-medium">{pathology?.name}</span>
                          </div>
                          <span className="text-[10px] uppercase font-bold text-slate-500 bg-slate-800 px-2 py-0.5 rounded-sm">
                            {marker.type}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 flex items-center gap-1.5">
                          <Layers className="w-3 h-3" />
                          {marker.zone}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Acciones de pie de página - Marcación */}
            <div className="p-6 border-t border-slate-800 bg-slate-900">
              <button className="w-full py-3 bg-white text-slate-900 rounded-xl font-medium text-sm flex items-center justify-center gap-2 hover:bg-slate-200 transition-colors shadow-lg">
                <Save className="w-4 h-4" />
                Guardar en Expediente
              </button>
            </div>
          </>
        )}

        {/* Tab: Líneas de Referencia */}
        {activeTab === 'lines' && (
          <>
            {/* Controles de Hairline e Intersecciones */}
            <div className="px-4 py-3 border-b border-slate-800 bg-slate-800/30 flex flex-col gap-3">

              {/* Hairline Superior */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#ff6b9d' }} />
                    <span className="text-xs text-slate-300 font-medium">Hairline Superior</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-slate-400">Y={hairlineTopY.toFixed(2)}</span>
                    <button
                      onClick={() => setShowHairline(v => !v)}
                      className={`p-1.5 rounded-lg transition-colors ${showHairline ? 'bg-pink-500/20 text-pink-400' : 'text-slate-600 hover:text-slate-400'}`}
                    >
                      {showHairline ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <input
                  type="range" min="-2" max="8" step="0.1"
                  value={hairlineTopY}
                  onChange={e => setHairlineTopY(parseFloat(e.target.value))}
                  className="w-full h-1 accent-pink-500 cursor-pointer"
                />
              </div>

              {/* Hairline Inferior (sup/med) */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#f97316' }} />
                    <span className="text-xs text-slate-300 font-medium">Límite Sup./Med. (ojo)</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">Y={hairlineBottomY.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="-8" max="4" step="0.1"
                  value={hairlineBottomY}
                  onChange={e => setHairlineBottomY(parseFloat(e.target.value))}
                  className="w-full h-1 accent-orange-500 cursor-pointer"
                />
              </div>

              {/* Límite Medio/Inferior */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#a78bfa' }} />
                    <span className="text-xs text-slate-300 font-medium">Límite Med./Inf. (nariz)</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">Y={tercioMedioBottomY.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="-12" max="2" step="0.1"
                  value={tercioMedioBottomY}
                  onChange={e => setTercioMedioBottomY(parseFloat(e.target.value))}
                  className="w-full h-1 accent-violet-400 cursor-pointer"
                />
              </div>

              {/* Límite Inferior del Tercio Inferior */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#34d399' }} />
                    <span className="text-xs text-slate-300 font-medium">Límite Inf. Tercio Inf. (mentón)</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">Y={tercioInferiorBottomY.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="-16" max="-2" step="0.1"
                  value={tercioInferiorBottomY}
                  onChange={e => setTercioInferiorBottomY(parseFloat(e.target.value))}
                  className="w-full h-1 accent-emerald-400 cursor-pointer"
                />
              </div>

              {/* Intersecciones */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-white" />
                  <span className="text-xs text-slate-300 font-medium">
                    Intersecciones ({editablePoints.filter((p: any) => p.type === 'intersection').length})
                  </span>
                </div>
                <button
                  onClick={() => setShowIntersections(v => !v)}
                  className={`p-1.5 rounded-lg transition-colors ${showIntersections ? 'bg-white/20 text-white' : 'text-slate-600 hover:text-slate-400'}`}
                >
                  {showIntersections ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
              </div>

              {/* Modo de puntos editables */}
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Puntos ({editablePoints.length})
                </p>
                <div className="flex gap-1">
                  {(['none', 'add', 'delete'] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setPointMode(p => p === mode ? 'none' : mode)}
                      className={`flex-1 py-1.5 text-[10px] rounded-lg font-medium transition-colors ${
                        pointMode === mode
                          ? mode === 'add' ? 'bg-cyan-600 text-white' : mode === 'delete' ? 'bg-red-600 text-white' : 'bg-slate-600 text-white'
                          : 'bg-slate-700/60 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {mode === 'none' ? 'Selec.' : mode === 'add' ? '+ Punto' : '🗑 Borrar'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <ReferenceLinePanel
                lines={referenceLines}
                activeType={activeLineType}
                pendingTwoPointStep={twoPointStep as 0 | 1 | 2}
                pendingLabel={pendingLineMeta?.label ?? ''}
                onSelectPreset={handleSelectPreset}
                onStartManual={handleStartManualLine}
                onCancel={handleCancelLine}
                onToggleVisibility={handleToggleLineVisibility}
                onOffsetChange={handleLineOffsetChange}
                onRemove={handleRemoveLine}
                onLabelChange={handleLineLabelChange}
              />
            </div>

            {/* Acciones de pie de página - Líneas */}
            <div className="p-4 border-t border-slate-800 bg-slate-900 flex flex-col gap-2">
              {editablePoints.length > 0 && (
                <div className="text-xs text-slate-500 text-center pb-1">
                  ✓ {editablePoints.filter((p: any) => p.type === 'intersection').length} intersecciones · {editablePoints.filter((p: any) => p.type === 'free').length} puntos libres
                </div>
              )}
              <button
                onClick={handleSaveJson}
                disabled={referenceLines.length === 0 && markers.length === 0}
                className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors shadow-lg"
              >
                <Save className="w-4 h-4" />
                Guardar JSON ({referenceLines.length} líneas · {editablePoints.length} pts)
              </button>
              {/* Importar JSON */}
              <label className="w-full py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer border border-slate-600">
                <Upload className="w-4 h-4" />
                Importar JSON
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleImportJson}
                />
              </label>
            </div>
          </>
        )}


      </div>
    </div>
  );
}
