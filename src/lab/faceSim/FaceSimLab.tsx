import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, ImagePlus, Trash2, Wand2, Undo2, FileJson, ScanFace, Box, Image as ImageIcon, Move3d, MousePointer2, Crosshair, Brush, Spline, Slash, ArrowUpRight, Circle, Square, Fan, Grid3x3, Leaf, Layers, Scissors, Columns2, Syringe, ListChecks, Eye, Sparkles, UserRound, Gauge, type LucideIcon } from 'lucide-react';
import injectablesCatalog from '../../components/admin/ficha-clinica/data/injectables.json';
import Clinical3DViewer, {
  type AnatomicalSurfaceOverlay, type DrawingTool, type FreehandLine, type Marker3D, type SurfaceShape,
} from '../../components/admin/ficha-clinica/components/Clinical3DViewer';
import {
  AUTO_ZONE, FACE_OVAL, LANDMARK_ANCHORS, MAX_EFFECTS, REGISTRATION_ANCHORS, SIM_MODES, autoRegistration, correctPoints, defaultFrame,
  elemsFromPhoto, expandElems, fitAffineRegistration, frameFromLandmarks, isRegistrationAccepted, isWithinFace, projectModel,
  buildPersonalSurface, projectPersonal, refineDepthFromProfiles, registrationAnchorIndices, trianglesFromEdges, fitHairPhotoProjection,
  type AffineRegistration, type DepthDiagnostic, type PersonalSurface, type PersonalProjection, type CorrectedPoint, type Elem, type ElemKind, type FaceFrame, type Meta, type P2, type PhotoEl, type SimMode, type Vec3, type ViewKind,
} from './engine';
import { moveFaceLandmark, refinePhotoContour, extendVisibleForehead, proposeForeheadBoundary, foreheadRatio, foreheadPointFromRatio } from './faceContour';
import { buildFaceRegionMap, buildFaceTriangleRegions, faceRegionColor, rasterizeFaceRegions, facialZoneAt, isOnObservedFace, faceAttentionColor, FACE_REGION_EDUCATION, FACE_REGION_SEEDS, type FaceRegionMap } from './faceRegions';
import { buildRegionCells, regionCellAt, regionCellPositions, regionPlanePositions, REGION_PLANES, type RegionPlane } from './regionMesh';
import { DEFAULT_HAIR, buildPhotoHairPatches, type EstimatedHairSettings, type PhotoHairPatch } from './estimatedHair';
import type { EstimatedHeadSurface } from './estimatedHead';
import type { PhotoSurfacePatch } from './multiViewHead';
import { assessFaceCapture, compareFaceGeometry } from './photoValidation';
import { DETECTION_RETRIES, detectionImage, refineLandmarksByCrop, restoreDetectionPoint } from './detection';
import { Tooltip } from '../../components/ui/Tooltip';
import type { SkinAppearanceVisualChannel, SkinAppearanceResult } from './skinAppearance';
import genericFaceAtlas from './genericFaceAtlas.json' with { type: 'json' };
import { locateModelPoint, locatePhotoPoint, modelPoint as tryModelPoint, photoPoint as tryPhotoPoint, surfacePoint as trySurfacePoint, type FaceAddress } from './faceTransfer';
import {
  addressHasPhotoCoverage, anatomicalPhotoElements, annotationViews, bindAnatomicalPaths, photoPatternPaths, requireMappedPoint, shapeOutline, surfaceNormal,
  type AnatomicalBinding, type AnatomicalBindings,
} from './anatomicalAnnotations';
import { annotationHistory, annotationLaterality, canonicalAnnotationPoint, mirrorAnnotation, transformAnnotation, translateAnnotation } from './annotationSymmetry';
import { annotationPhotoLayer, annotationUVs, bindingsOnLayer, buildAnnotationLayerView, type AnnotationLayerView } from './annotationLayerView';
import { loadDefaultLayers, registerLayers, ANATOMY_PLANES } from './defaultLayers';
import { AnatomyLayerControls, chooseAnatomyDisplay, initialAnatomyDisplay } from './anatomyDisplay';
import { initialQuickRecordSettings, type QuickRecordSettings } from './quickRecord';
import { EXTENDED_ZONE, ledgerRows, volumeTotals } from './markingModel';
import { CheckChip, CutControls, EditorTabs, EffectMixer, IconToggle, ModeCards, NO_CUT, PanelSection, PointLedger, SelectionInspector, ToolDock, VolumeDialog, VolumeHud, ZoneChip, ZoneView, createZoneStore, editorPanel, hudChip, type MarkingCut, type ZoneStore } from './MarkingPanels';
import { DEFAULT_PREVIEW, PREVIEW_DESCRIPTIONS, buildIllustrativeEffects, previewPixels, previewSurface } from './injectablePreview';
import { importLocalRecord, localRecord } from './injectableLocalRecord';

const modelPoint = (...args: Parameters<typeof tryModelPoint>): Vec3 => requireMappedPoint(tryModelPoint(...args));
const photoPoint = (...args: Parameters<typeof tryPhotoPoint>): P2 => requireMappedPoint(tryPhotoPoint(...args));
const surfacePoint = (...args: Parameters<typeof trySurfacePoint>): Vec3 => requireMappedPoint(trySurfacePoint(...args));
const patientZone = (label: string | null, address: FaceAddress): string | null => label
  ? `${label} · ${annotationLaterality({ paths: [[address]], kind: 'point' }, genericFaceAtlas)}` : null;
const catalog = (cat: string) => (injectablesCatalog as { categoria: string; elemento: string }[])
  .filter(i => i.categoria === cat).map(i => i.elemento);
const ZONES = [...new Set([...['tercio_superior', 'tercio_medio', 'tercio_inferior'].flatMap(catalog),
  'Labio superior', 'Labio inferior', 'Piel supralabial / filtrum'])];
const MAX_SIDE = 1400;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const FacialSimulationViewer = lazy(() => import('./FacialSimulationViewer'));
const FaceBoundaryReview = lazy(() => import('./FaceBoundaryReview'));

const VERT = `attribute vec2 p;varying vec2 uv;void main(){uv=p*0.5+0.5;uv.y=1.0-uv.y;gl_Position=vec4(p,0.0,1.0);}`;
const FRAG = `precision highp float;
#define N ${MAX_EFFECTS}
varying vec2 uv;uniform sampler2D tex;uniform vec2 res;uniform float aspect;uniform int count;uniform float split;
uniform vec4 A[N];uniform vec4 B[N];uniform vec4 C[N];
float wgt(vec2 q,vec4 a){float d=length((q-a.xy)*vec2(aspect,1.0));return exp(-(d*d)/(a.z*a.z*0.5));}
void main(){
  if(uv.x<split){gl_FragColor=texture2D(tex,uv);return;}
  vec2 src=uv;float sm=0.0,gl=0.0;
  for(int i=0;i<N;i++){if(i>=count)break;
    vec4 a=A[i],b=B[i];float w=wgt(uv,a)*a.w;
    src-=(uv-a.xy)*b.x*w; src-=vec2(b.y/aspect,b.z)*w;
  }
  for(int i=0;i<N;i++){if(i>=count)break;
    vec4 a=A[i],b=B[i],c=C[i];float w=wgt(src,a)*a.w;sm+=b.w*w;gl+=c.x*w;
  }
  sm=clamp(sm,0.0,1.0);vec3 col=texture2D(tex,src).rgb;
  if(sm>0.01){
    vec3 acc=col;float ws=1.0;float rad=(2.0+6.0*sm)/res.y;
    for(int k=0;k<16;k++){float ang=float(k)*0.3927;float rr=rad*(0.5+0.5*mod(float(k),2.0));
      vec3 s=texture2D(tex,src+vec2(cos(ang)/aspect,sin(ang))*rr).rgb;
      float dd=length(s-col);float ww=exp(-dd*dd/0.012);acc+=s*ww;ws+=ww;}
    col=mix(col,acc/ws,sm);
  }
  gl=clamp(gl,0.0,1.0);float l=dot(col,vec3(0.299,0.587,0.114));
  col+=gl*(0.05+0.12*smoothstep(0.35,0.9,l))*vec3(1.0,0.98,0.94);
  col=mix(vec3(l),col,1.0+0.1*gl);
  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

interface Renderer { draw: (fx: ReturnType<typeof buildIllustrativeEffects>, aspect: number, split: number) => void; dispose: () => void }

function createRenderer(canvas: HTMLCanvasElement, img: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  canvas.width = img.width; canvas.height = img.height; gl.viewport(0, 0, img.width, img.height);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  return {
    draw: (fx, aspect, split) => {
      gl.uniform2f(u('res'), img.width, img.height); gl.uniform1f(u('aspect'), aspect);
      gl.uniform1i(u('count'), fx.count); gl.uniform1f(u('split'), split);
      gl.uniform4fv(u('A[0]'), fx.a); gl.uniform4fv(u('B[0]'), fx.b); gl.uniform4fv(u('C[0]'), fx.c);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose: () => { gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteProgram(prog); },
  };
}

/** Detecta landmarks con MediaPipe si el modelo local existe (npm run lab:face-assets). */
async function detectFrame(img: HTMLCanvasElement): Promise<{
  frame: FaceFrame | null; landmarks?: Landmark[]; detectedLandmarks?: Landmark[]; contourAdjusted?: number;
  regionMap?: FaceRegionMap; pose?: number[]; reason: string; captureWarnings?: string[];
}> {
  let landmarker: import('@mediapipe/tasks-vision').FaceLandmarker | null = null;
  let relaxed = false;
  try {
    const shared = await sharedLandmarker();
    if (typeof shared === 'string') return { frame: null, reason: shared };
    landmarker = shared;
    let result = landmarker.detect(img);
    let detectedLandmarks = result.faceLandmarks[0]?.map(({ x, y, z }) => ({ x, y, z }));
    let retried = false;
    let rotated = false;
    if (!detectedLandmarks) {
      await landmarker.setOptions({ minFaceDetectionConfidence: 0.25, minFacePresenceConfidence: 0.35 });
      relaxed = true;
      for (const transform of [{ angle: 0, scale: 1, enhanced: false }, ...DETECTION_RETRIES]) {
        const input = detectionImage(img, transform);
        result = landmarker.detect(input);
        const candidate = result.faceLandmarks[0];
        if (candidate) {
          detectedLandmarks = candidate.map(point => restoreDetectionPoint(point, img.width, img.height, transform));
          retried = true; rotated = transform.angle !== 0;
          break;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    if (!detectedLandmarks) return { frame: null, reason: 'No se obtuvo una malla fiable tras reintentar encuadre, contraste y giro. La foto queda como referencia; para generar 3D añade una toma a tres cuartos (30–60°), con nariz y mentón completos.' };
    if (!rotated) detectedLandmarks = refineLandmarksByCrop(landmarker, img, detectedLandmarks) ?? detectedLandmarks;
    const context = img.getContext('2d');
    if (!context) throw new Error('No se pudieron leer los píxeles para revisar el contorno.');
    const pixels = context.getImageData(0, 0, img.width, img.height);
    const quality = assessFaceCapture(pixels, detectedLandmarks, result.faceLandmarks.length);
    if (!quality.accepted) return { frame: null, reason: quality.reasons.join(' ') };
    const triangles = await faceTriangles();
    const contour = refinePhotoContour(detectedLandmarks, FACE_OVAL, triangles, pixels);
    return {
      frame: frameFromLandmarks(contour.landmarks), landmarks: contour.landmarks, detectedLandmarks,
      contourAdjusted: contour.adjusted, regionMap: buildFaceRegionMap(contour.landmarks, triangles, img.width / img.height, genericFaceAtlas.positions),
      pose: rotated ? undefined : result.facialTransformationMatrixes[0]?.data, reason: '',
      captureWarnings: [...quality.warnings, ...(retried ? ['Detección recuperada: revisa contorno y referencias antes de fusionar. Los puntos ocultos de un perfil son estimaciones.'] : [])],
    };
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    return { frame: null, reason: `Falló la inicialización o validación del detector facial.${detail}` };
  } finally {
    // El detector se reutiliza entre fotos; solo se restauran los umbrales.
    if (landmarker && relaxed) await landmarker.setOptions({ minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5 }).catch(() => undefined);
  }
}

let landmarkerPromise: Promise<import('@mediapipe/tasks-vision').FaceLandmarker | string> | null = null;
/** Un solo FaceLandmarker por pestaña: evita recargar WASM + modelo en cada foto. */
function sharedLandmarker() {
  landmarkerPromise ??= (async () => {
    const head = await fetch('/models/face/face_landmarker.task', { method: 'HEAD' });
    const contentType = head.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    // Content-Length puede faltar con compresión (br); el tipo HTML delata el fallback de la SPA.
    if (!head.ok || contentType === 'text/html') return `El modelo facial no está disponible o es inválido (HTTP ${head.status}).`;
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/face/face_landmarker.task' }, runningMode: 'IMAGE', numFaces: 2,
      outputFacialTransformationMatrixes: true,
    });
  })();
  const pending = landmarkerPromise;
  // Un fallo (red o modelo ausente) no queda cacheado: el siguiente intento reintenta.
  pending.then(value => { if (typeof value === 'string' && landmarkerPromise === pending) landmarkerPromise = null; },
    () => { if (landmarkerPromise === pending) landmarkerPromise = null; });
  return pending;
}

type Landmark = { x: number; y: number; z: number };
let tessellationCache: number[] | null = null;
/** Triángulos de la malla canónica MediaPipe (468/478 vértices), derivados de su teselación oficial. */
async function faceTriangles(): Promise<number[]> {
  if (!tessellationCache) {
    const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
    tessellationCache = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
  }
  return tessellationCache;
}
type ModelKind = 'generico' | 'personal';
interface PersonalModel {
  view: ViewKind; canvas: HTMLCanvasElement; glb: ArrayBuffer; projection: PersonalProjection; depth: number; depthDetails: string;
  diagnostics: (DepthDiagnostic & { label: string })[];
  surface: PersonalSurface;
  renderSurface: PersonalSurface | EstimatedHeadSurface;
  regionMap: FaceRegionMap;
  closedHead: boolean;
  photoPatches?: PhotoSurfacePatch[];
}

const uid = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const VIEWS: { id: ViewKind; label: string }[] = [{ id: 'frontal', label: 'Frontal' }, { id: 'izquierda', label: 'Ángulo A' }, { id: 'derecha', label: 'Ángulo B' }];
type PhotoSlotId = ViewKind | 'extra_a' | 'extra_b';
const PHOTO_SLOTS: { id: PhotoSlotId; label: string }[] = [...VIEWS, { id: 'extra_a', label: 'Foto 4' }, { id: 'extra_b', label: 'Foto 5' }];
type WorkMode = '3d' | 'foto';
type Tool3D = 'navigate' | 'select' | 'point' | Exclude<DrawingTool, 'none'>;
const TOOLS_3D: { id: Tool3D; label: string; icon: LucideIcon }[] = [
  { id: 'navigate', label: 'Mover cámara', icon: Move3d }, { id: 'select', label: 'Seleccionar / editar', icon: MousePointer2 },
  { id: 'point', label: 'Punto', icon: Crosshair }, { id: 'freehand-brush', label: 'Pincel', icon: Brush },
  { id: 'freehand-poly', label: 'Polilínea', icon: Spline }, { id: 'straight-line', label: 'Línea', icon: Slash }, { id: 'shape-arrow', label: 'Flecha', icon: ArrowUpRight },
  { id: 'shape-circle', label: 'Círculo', icon: Circle }, { id: 'shape-rect', label: 'Rectángulo', icon: Square }, { id: 'ha-fan', label: 'Abanico', icon: Fan },
  { id: 'ha-grid', label: 'Malla', icon: Grid3x3 }, { id: 'ha-fern', label: 'Helecho', icon: Leaf },
];
const TOOLS_PHOTO: { id: ElemKind; label: string; icon: LucideIcon }[] = [
  { id: 'point', label: 'Punto', icon: Crosshair }, { id: 'line', label: 'Línea', icon: Slash }, { id: 'arrow', label: 'Flecha', icon: ArrowUpRight },
  { id: 'free', label: 'Libre', icon: Brush }, { id: 'circle', label: 'Círculo', icon: Circle }, { id: 'rect', label: 'Rectángulo', icon: Square },
  { id: 'pattern', label: 'Patrón', icon: Fan },
];
const HA_CONFIG = { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };
/** El editor ocupa una pantalla: visor, herramientas y listado sin scroll de página en escritorio. */
const VIEWER_HEIGHT = 'clamp(360px, calc(100dvh - 15rem), 760px)';
/** Color estable por zona anatómica para el mallado (RGB 0–1). */
function zoneTint(label: string): [number, number, number] {
  let hash = 0;
  for (const char of label.split(' · ')[0]) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const h = (hash % 360) / 60, c = 0.62, x = c * (1 - Math.abs(h % 2 - 1)), m = 0.33;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

interface Slot {
  canvas: HTMLCanvasElement;
  aspect: number;
  frame: FaceFrame;
  landmarks?: Landmark[];
  detectedLandmarks?: Landmark[];
  contourAdjusted?: number;
  regionMap?: FaceRegionMap;
  pose?: number[];
  detectionError?: string;
  captureWarnings?: string[];
  captureConfirmed?: boolean;
  foreheadReviewed?: boolean;
  previewUrl?: string;
  modelAnchors?: Vec3[];
  registration?: AffineRegistration;
  registrationFlip?: boolean;
  registrationSource?: 'auto' | 'manual';
}
interface Snapshot { markers: Marker3D[]; lines: FreehandLine[]; shapes: SurfaceShape[]; meta: Record<string, Meta>; photoEls: PhotoEl[]; bindings: AnatomicalBindings; quickRecord: QuickRecordSettings }
interface SkinReview {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  landmarks: Landmark[];
  result: SkinAppearanceResult;
  urls: Record<SkinAppearanceVisualChannel, string>;
}

function pixelsUrl(pixels: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No se pudo preparar la capa visual.');
  const image = context.createImageData(width, height);
  image.data.set(pixels); context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

const segDist = (p: P2, a: P2, b: P2, k: number) => {
  const ax = (b.x - a.x) * k, ay = b.y - a.y, px = (p.x - a.x) * k, py = p.y - a.y, l2 = ax * ax + ay * ay;
  const t = l2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
  return Math.hypot(px - t * ax, py - t * ay);
};

export default function FaceSimLab() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const dragRef = useRef<string | null>(null);
  const uploadRequestRef = useRef<Partial<Record<PhotoSlotId, number>>>({});
  const personalRequestRef = useRef(0);
  const detectionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [photos, setPhotos] = useState<Partial<Record<PhotoSlotId, Slot>>>({});
  const [pendingPhotos, setPendingPhotos] = useState<Partial<Record<PhotoSlotId, boolean>>>({});
  const [view, setView] = useState<ViewKind>('frontal');
  const [renderTick, setRenderTick] = useState(0);
  const [workMode, setWorkMode] = useState<WorkMode>('3d');
  const [splitAnnotations, setSplitAnnotations] = useState(false);
  const [tool3d, setTool3d] = useState<Tool3D>('navigate');
  const [toolPhoto, setToolPhoto] = useState<ElemKind>('point');
  const [photoPattern, setPhotoPattern] = useState<'fan' | 'grid' | 'fern'>('fan');
  const [markers, setMarkers] = useState<Marker3D[]>([]);
  const [lines, setLines] = useState<FreehandLine[]>([]);
  const [shapes, setShapes] = useState<SurfaceShape[]>([]);
  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [photoEls, setPhotoEls] = useState<PhotoEl[]>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [draft, setDraft] = useState<{ kind: ElemKind; pts: P2[] } | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [photoAnchor, setPhotoAnchor] = useState<number | null>(null);
  const [mode, setMode] = useState<SimMode>('toxina');
  const [zone, setZone] = useState(AUTO_ZONE);
  const [product, setProduct] = useState('');
  const [dose, setDose] = useState(0);
  const [preview, setPreview] = useState({ ...DEFAULT_PREVIEW, after: false });
  const [split, setSplit] = useState(0);
  const [correct, setCorrect] = useState({ enabled: false, linear: true, mirror: true, tolerance: 0.02 });
  const [flipX, setFlipX] = useState(false);
  const [showMarks, setShowMarks] = useState(true);
  const [status, setStatus] = useState('Laboratorio local. Revisa las capturas o abre Simular y marcar para usar el modelo genérico.');
  const [importText, setImportText] = useState('');
  const [modelKind, setModelKind] = useState<ModelKind>('generico');
  const [personal, setPersonal] = useState<PersonalModel | null>(null);
  const [depth, setDepth] = useState(1);
  const [buildingPersonal, setBuildingPersonal] = useState(false);
  const [contourIndex, setContourIndex] = useState<number | null>(null);
  const [bindings, setBindings] = useState<AnatomicalBindings>({});
  const [overlayMode, setOverlayMode] = useState<'none' | 'regions' | 'attention'>('regions');
  const [foreheadPreview, setForeheadPreview] = useState<{ canvas: HTMLCanvasElement; point: P2; confirmed: boolean; reason: string } | null>(null);
  const [pickingForehead, setPickingForehead] = useState(false);
  const [skinReview, setSkinReview] = useState<SkinReview | null>(null);
  const [skinChannel, setSkinChannel] = useState<SkinAppearanceVisualChannel>('contrast');
  const [analyzingSkin, setAnalyzingSkin] = useState(false);
  // Cola de fotos por revisar límites; la primera con landmarks se muestra en el modal.
  const [boundaryReview, setBoundaryReview] = useState<PhotoSlotId[]>([]);
  // Altura de frente confirmada (normalizada glabela→mentón); la frontal tiene prioridad.
  const [foreheadReference, setForeheadReference] = useState<{ ratio: number; slot: PhotoSlotId } | null>(null);
  const hoverStoreRef = useRef<ZoneStore | null>(null);
  if (!hoverStoreRef.current) hoverStoreRef.current = createZoneStore();
  const hoverStore = hoverStoreRef.current;
  const setHoveredZone = hoverStore.set;
  const [markTab, setMarkTab] = useState<'inyectable' | 'capas' | 'revisar'>('inyectable');
  const [workspace, setWorkspace] = useState<'capture' | 'simulate'>('capture');
  const [editorGroup, setEditorGroup] = useState<'annotations' | 'appearance'>('annotations');
  const [appearanceOpened, setAppearanceOpened] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bilateral, setBilateral] = useState(false);
  const [anatomyDisplay, setAnatomyDisplay] = useState(initialAnatomyDisplay);
  const [quickRecord, setQuickRecord] = useState(initialQuickRecordSettings);
  const [askVolume, setAskVolume] = useState(true);
  const [pendingVolume, setPendingVolume] = useState<string[] | null>(null);
  const [cut, setCut] = useState<MarkingCut>(NO_CUT);
  const [extendedZone, setExtendedZone] = useState(false);
  const [outsideHint, setOutsideHint] = useState(false);
  const hasQuickEntries = Object.keys(quickRecord.entries).length > 0;
  const hasLocalRecord = Object.keys(bindings).length > 0 || markers.length > 0 || hasQuickEntries;
  useEffect(() => {
    if (!hasLocalRecord) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [hasLocalRecord]);
  const [defaultLayers, setDefaultLayers] = useState<Awaited<ReturnType<typeof loadDefaultLayers>>>([]);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [layerAttempt, setLayerAttempt] = useState(0);
  const [photoInteraction, setPhotoInteraction] = useState<'draw' | 'select'>('draw');
  const [skinOpacity, setSkinOpacity] = useState(0.65);
  const [skinRegion, setSkinRegion] = useState<'all' | 'tzone' | 'cheeks'>('all');
  const [appearanceGlb, setAppearanceGlb] = useState<{ personal: PersonalModel; buffer: ArrayBuffer } | null>(null);
  const [genericPreviewGlb, setGenericPreviewGlb] = useState<ArrayBuffer | null>(null);
  const [genericPreviewAfter, setGenericPreviewAfter] = useState<boolean | null>(null);
  const [meshVisible, setMeshVisible] = useState(true);
  const [regionPlane, setRegionPlane] = useState<RegionPlane>('superficial');
  const [hair, setHair] = useState<EstimatedHairSettings>({ ...DEFAULT_HAIR });
  const [hairAnalysis, setHairAnalysis] = useState<{ personal: PersonalModel; patches: PhotoHairPatch[] } | null>(null);
  const [hairBusy, setHairBusy] = useState(false);
  const hairRequest = useRef(0);
  const genericSelected = useRef(false);
  const hairPatches = hairAnalysis?.personal === personal ? hairAnalysis?.patches : undefined;
  useEffect(() => { setHairAnalysis(null); }, [personal]);
  const activePhotoRef = useRef<HTMLCanvasElement>();
  const showRegions = meshVisible && overlayMode !== 'none';
  const toggleMesh = (visible: boolean) => {
    setMeshVisible(visible);
    if (visible && overlayMode === 'none') setOverlayMode('regions');
  };

  const slot = photos[view];
  activePhotoRef.current = slot?.canvas;
  const currentForeheadPreview = foreheadPreview?.canvas === slot?.canvas ? foreheadPreview : null;
  const reviewId = boundaryReview.find(id => photos[id]?.landmarks);
  const reviewSlot = reviewId ? photos[reviewId] : undefined;
  const reviewReference = useMemo(() => {
    if (!reviewSlot?.landmarks || !foreheadReference || foreheadReference.slot === reviewId) return null;
    return foreheadPointFromRatio(reviewSlot.detectedLandmarks ?? reviewSlot.landmarks, foreheadReference.ratio, reviewSlot.aspect);
  }, [reviewSlot, reviewId, foreheadReference]);
  const rememberForehead = (target: PhotoSlotId, source: Slot, point: P2) => {
    const ratio = foreheadRatio(source.detectedLandmarks ?? source.landmarks ?? [], point, source.aspect);
    if (!ratio) return;
    setForeheadReference(current => !current || target === 'frontal' || current.slot !== 'frontal' ? { ratio, slot: target } : current);
    // Las demás fotos aún sin revisar vuelven a la cola con la altura trasladada como alternativa.
    if (target === 'frontal') setBoundaryReview(queue => [...queue, ...PHOTO_SLOTS.map(v => v.id)
      .filter(id => id !== target && !queue.includes(id) && photos[id]?.landmarks && !photos[id]?.foreheadReviewed)]);
  };
  const currentSkinReview = skinReview?.canvas === slot?.canvas && skinReview?.landmarks === slot?.landmarks ? skinReview : null;
  const personalActive = !!personal;
  const personalProjection = personalActive && personal.view === view && personal.canvas === slot?.canvas ? personal.projection : undefined;
  const anchorIndices = registrationAnchorIndices(view);
  const anchorCount = anchorIndices.length;
  const anchorName = (index: number) => REGISTRATION_ANCHORS[anchorIndices[index]] ?? 'finalizando';
  const aspect = slot?.aspect ?? 0.75;
  const frame = slot?.frame ?? defaultFrame(view);
  const regionMap = personalProjection ? personal?.regionMap : slot?.regionMap;
  const locateSkinAnnotation = useCallback((source: 'generico' | 'personal' | 'foto', p: Vec3): FaceAddress | null => {
    let address: FaceAddress | null;
    if (source === 'generico') address = locateModelPoint(p, genericFaceAtlas);
    else if (source === 'personal') {
      if (!personal || !isOnObservedFace(p, personal.surface, personal.regionMap)) return null;
      address = locatePhotoPoint(projectPersonal(p, personal.projection), personal.regionMap.landmarks, genericFaceAtlas);
    } else address = slot?.landmarks ? locatePhotoPoint(p, slot.landmarks, genericFaceAtlas) : null;
    const landmarks = source === 'personal' ? personal?.regionMap.landmarks : source === 'foto' ? slot?.landmarks : undefined;
    return address && tryModelPoint(address, genericFaceAtlas)
      && (!landmarks || addressHasPhotoCoverage(address, landmarks, genericFaceAtlas)) ? address : null;
  }, [personal, slot?.landmarks]);
  const previewModeKey = JSON.stringify(Object.fromEntries(Object.entries(meta).map(([id, entry]) => [id, entry.mode])));
  const previewModes = useMemo<Record<string, SimMode>>(() => JSON.parse(previewModeKey), [previewModeKey]);
  useEffect(() => {
    let active = true;
    setAppearanceGlb(null);
    if (!personal) return;
    const source = personal, review = currentSkinReview?.result.usable && currentSkinReview.canvas === personal.canvas ? currentSkinReview : null;
    const previewActive = workspace === 'simulate' && preview.after && Object.keys(bindings).length > 0;
    if (!review && !previewActive && !(personal.closedHead && hair.enabled && hairPatches?.length)) return;
    void (async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = source.canvas.width; canvas.height = source.canvas.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No se pudo preparar la textura RGB.');
        context.drawImage(source.canvas, 0, 0);
        if (review) {
          const overlay = document.createElement('canvas');
          overlay.width = review.width; overlay.height = review.height;
          const overlayContext = overlay.getContext('2d');
          if (!overlayContext) throw new Error('No se pudo preparar el canal RGB.');
          const pixels = overlayContext.createImageData(overlay.width, overlay.height);
          pixels.data.set(review.result.channels[skinChannel].rgba); overlayContext.putImageData(pixels, 0, 0);
          context.globalAlpha = skinOpacity; context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
        }
        const visualMeta = Object.fromEntries(Object.entries(previewModes).map(([id, mode]) => [id, { mode, dose: 0, zone: AUTO_ZONE }]));
        const samples = anatomicalPhotoElements(bindings, visualMeta, source.regionMap.landmarks, genericFaceAtlas)
          .flatMap(element => element.paths.flatMap(path => path.filter((_, i) => i % Math.max(1, Math.ceil(path.length / 8)) === 0)
            .map(point => ({ ...point, mode: element.mode }))));
        if (previewActive) {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const coverage = rasterizeFaceRegions(source.regionMap, canvas.width, canvas.height, () => '#ffffff');
          const mask = Uint8Array.from({ length: canvas.width * canvas.height }, (_, i) => coverage[i * 4 + 3] ? 1 : 0);
          pixels.data.set(previewPixels(pixels.data, canvas.width, canvas.height, samples, preview, mask));
          context.putImageData(pixels, 0, 0);
        }
        const original = source.renderSurface;
        const positions = previewActive
          ? previewSurface(original.positions, original.uvs, samples, preview, source.canvas.width / source.canvas.height,
            undefined, source.surface.positions.length / 3).positions : original.positions;
        const surface = { ...original, positions };
        // Cada parche conserva su foto y sus UV; no se tapa el preview con RGB original.
        const patches = previewActive ? source.photoPatches?.map(patch => {
          const texture = document.createElement('canvas'), maskCanvas = document.createElement('canvas');
          const scale = Math.min(1, 512 / Math.max(patch.source.texture.width, patch.source.texture.height));
          texture.width = maskCanvas.width = Math.max(1, Math.round(patch.source.texture.width * scale));
          texture.height = maskCanvas.height = Math.max(1, Math.round(patch.source.texture.height * scale));
          const ctx = texture.getContext('2d'), maskContext = maskCanvas.getContext('2d');
          if (!ctx || !maskContext) throw new Error('No se pudo preparar el preview RGB multivista.');
          ctx.drawImage(patch.source.texture, 0, 0, texture.width, texture.height);
          const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: patch.uvs[i * 2], y: patch.uvs[i * 2 + 1] }));
          const projected = Object.entries(bindings).flatMap(([id, binding]) => {
            const mode = previewModes[id];
            return mode ? binding.paths.flatMap(path => path.filter((_, i) => i % Math.max(1, Math.ceil(path.length / 8)) === 0)
              .flatMap(address => {
                const p = tryPhotoPoint(address, landmarks, genericFaceAtlas);
                return p ? [{ ...p, mode }] : [];
              })) : [];
          });
          maskContext.fillStyle = '#fff';
          for (let i = 0; i < patch.indices.length; i += 3) {
            const ids = Array.from(patch.indices.subarray(i, i + 3));
            if (ids.some(id => id >= 468)) continue;
            maskContext.beginPath();
            ids.forEach((id, j) => maskContext[j ? 'lineTo' : 'moveTo'](landmarks[id].x * texture.width, landmarks[id].y * texture.height));
            maskContext.closePath(); maskContext.fill();
          }
          const rgba = ctx.getImageData(0, 0, texture.width, texture.height);
          const coverage = maskContext.getImageData(0, 0, texture.width, texture.height).data;
          const mask = Uint8Array.from({ length: texture.width * texture.height }, (_, i) => coverage[i * 4 + 3] ? 1 : 0);
          rgba.data.set(previewPixels(rgba.data, texture.width, texture.height, projected, preview, mask));
          ctx.putImageData(rgba, 0, 0);
          return { ...patch, source: { ...patch.source, texture } };
        }) : source.photoPatches;
        const { personalSurfaceToGlb } = await import('./personalSurfaceGlb');
        const buffer = await personalSurfaceToGlb(surface, canvas, hair, hairPatches, review ? [] : patches);
        if (active) setAppearanceGlb({ personal: source, buffer });
      } catch (error) {
        if (active) setStatus(`No se pudo actualizar la apariencia 3D: ${error instanceof Error ? error.message : 'error desconocido'}. Se conserva la textura original.`);
      }
    })();
    return () => { active = false; };
  }, [personal, currentSkinReview, skinChannel, skinOpacity, hair, hairPatches, workspace, preview, bindings, previewModes]);
  const canonicalRegionMap = useMemo(() => buildFaceRegionMap(
    Array.from({ length: 468 }, (_, i) => ({ x: genericFaceAtlas.positions[i * 3], y: -genericFaceAtlas.positions[i * 3 + 1] })),
    genericFaceAtlas.triangles, 1, genericFaceAtlas.positions,
  ), []);
  useEffect(() => {
    let active = true;
    setLayerError(null);
    loadDefaultLayers().then(layers => { if (active) setDefaultLayers(layers); })
      .catch(error => { if (active) setLayerError(error instanceof Error ? error.message : 'No se pudieron cargar las capas.'); });
    return () => { active = false; };
  }, [layerAttempt]);
  const annotationLayers = useMemo(() => {
    let error: string | null = null;
    // Cada fuente falla por separado: un error en la foto no apaga las capas del modelo.
    const build = (uvs: Float32Array, surface?: PersonalSurface) => {
      try {
        return registerLayers(defaultLayers, uvs).map(reference => buildAnnotationLayerView(reference, genericFaceAtlas, surface));
      } catch (cause) {
        error ??= cause instanceof Error ? cause.message : 'Referencia no disponible.';
        return [];
      }
    };
    const generic = build(annotationUVs(genericFaceAtlas));
    const personalLayers = personal ? build(personal.surface.uvs, personal.surface) : [];
    const photo = slot?.landmarks ? build(Float32Array.from(slot.landmarks.flatMap(p => [p.x, p.y]))) : [];
    return { generic, personal: personalLayers, photo, error };
  }, [defaultLayers, personal, slot?.landmarks]);
  const activeLayer = (source: 'generico' | 'personal' | 'foto'): AnnotationLayerView | undefined =>
    (source === 'generico' ? annotationLayers.generic : source === 'personal' ? annotationLayers.personal : annotationLayers.photo)
      .find(layer => layer.reference.kind === anatomyDisplay.anatomy);
  const layerIsVisible = anatomyDisplay.anatomy === 'skin'
    ? anatomyDisplay.skin.visible && anatomyDisplay.skin.opacity > 0
    : anatomyDisplay.references[anatomyDisplay.anatomy].visible && anatomyDisplay.references[anatomyDisplay.anatomy].opacity > 0
      && (anatomyDisplay.overlay || !anatomyDisplay.skin.visible || anatomyDisplay.skin.opacity < 0.99);
  const genericLayer = annotationLayers.generic.find(layer => layer.reference.kind === anatomyDisplay.anatomy);
  const personalLayer = annotationLayers.personal.find(layer => layer.reference.kind === anatomyDisplay.anatomy);
  const photoLayer = annotationLayers.photo.find(layer => layer.reference.kind === anatomyDisplay.anatomy);
  const photoLayerImages = useMemo(() => {
    if (!slot?.landmarks) return [];
    return annotationLayers.photo.map(layer => ({ kind: layer.reference.kind,
      url: annotationPhotoLayer(layer, slot.landmarks!, genericFaceAtlas) }));
  }, [annotationLayers.photo, slot?.landmarks]);
  const triangleRegions = useMemo(() => buildFaceTriangleRegions(canonicalRegionMap, genericFaceAtlas.positions), [canonicalRegionMap]);
  const regionCells = useMemo(() => buildRegionCells(canonicalRegionMap, triangleRegions), [canonicalRegionMap, triangleRegions]);
  const planePositions = useMemo(() => ({
    generic: regionPlanePositions(genericFaceAtlas.positions, genericFaceAtlas.triangles, regionPlane),
    personal: personal && regionPlanePositions(personal.surface.positions, genericFaceAtlas.triangles, regionPlane),
  }), [regionPlane, personal]);
  const regionOverlays = useMemo(() => {
    const positions: number[] = [], personalPositions: number[] = [], colors: number[] = [], labels: string[] = [];
    for (const cell of regionCells) {
      const label = cell.label;
      const weights = [0, 1, 2].map(axis => cell.corners.reduce((sum, corner) => sum + corner[axis] / 3, 0)) as [number, number, number];
      labels.push(patientZone(label, { triangle: cell.triangle, weights })!);
      positions.push(...regionCellPositions(cell, genericFaceAtlas.triangles, planePositions.generic));
      if (planePositions.personal) personalPositions.push(...regionCellPositions(cell, genericFaceAtlas.triangles, planePositions.personal));
      for (let j = 0; j < 3; j++) {
        const color = overlayMode === 'attention' ? faceAttentionColor(label) : faceRegionColor(label);
        const rgb = [1, 3, 5].map(k => parseInt(color.slice(k, k + 2), 16) / 255);
        colors.push(...rgb);
      }
    }
    return {
      generic: { positions: Float32Array.from(positions), colors: Float32Array.from(colors), labels, wireframe: true, opacity: showRegions ? 0.32 : 0, onHover: setHoveredZone, highlight: 'mesh' as const,
        depthTest: false, zoneAt: (point: Vec3) => {
          const address = locateModelPoint(point, genericFaceAtlas);
          return address ? patientZone(regionCellAt(address, regionCells), address) : null;
        } },
      personal: personal ? { positions: Float32Array.from(personalPositions), colors: Float32Array.from(colors), labels, wireframe: true, opacity: showRegions ? 0.32 : 0, onHover: setHoveredZone, highlight: 'mesh' as const,
        depthTest: regionPlane === 'superficial', zoneAt: (point: Vec3) => {
          if (!isOnObservedFace(point, personal.surface, personal.regionMap)) return null;
          const address = locatePhotoPoint(projectPersonal(point, personal.projection), personal.regionMap.landmarks, genericFaceAtlas);
          return address ? patientZone(regionCellAt(address, regionCells), address) : null;
        } } : undefined,
    } satisfies { generic: AnatomicalSurfaceOverlay; personal?: AnatomicalSurfaceOverlay };
  }, [showRegions, overlayMode, regionCells, planePositions, regionPlane, personal, setHoveredZone]);
  const renderLayerSettings = useMemo(() => {
    const build = (available: AnnotationLayerView[]) => ({
      references: available.filter(layer => anatomyDisplay.references[layer.reference.kind].visible)
        .map(layer => ({ positions: layer.positions, indices: layer.indices, uvs: layer.reference.uvs, canvas: layer.reference.canvas,
          opacity: anatomyDisplay.references[layer.reference.kind].opacity })),
      skin: anatomyDisplay.skin, referenceOverlay: anatomyDisplay.overlay,
    });
    return { generic: build(annotationLayers.generic), personal: build(annotationLayers.personal) };
  }, [annotationLayers, anatomyDisplay]);
  const annotationOverlays = useMemo(() => {
    const build = (source: 'generico' | 'personal'): AnatomicalSurfaceOverlay => {
      const available = source === 'generico' ? annotationLayers.generic : annotationLayers.personal;
      const active = available.find(layer => layer.reference.kind === anatomyDisplay.anatomy);
      const base = source === 'generico' ? regionOverlays?.generic : regionOverlays?.personal;
      const positions: number[] = [], colors: number[] = [], labels: string[] = [];
      if (active) for (const cell of regionCells) {
        const weights = [0, 1, 2].map(axis => cell.corners.reduce((sum, corner) => sum + corner[axis] / 3, 0)) as [number, number, number];
        const label = active.zone({ triangle: cell.triangle, weights });
        if (!label) continue;
        labels.push(label);
        for (const corner of cell.corners) {
          const point = active.point({ triangle: cell.triangle, weights: [corner[0], corner[1], corner[2]] });
          positions.push(point.x, point.y, point.z); colors.push(...zoneTint(label));
        }
      }
      return {
        ...(active ? { positions: Float32Array.from(positions), colors: Float32Array.from(colors), labels,
          wireframe: true, opacity: showRegions && layerIsVisible ? 0.32 : 0, onHover: setHoveredZone, highlight: 'mesh' as const,
          zoneAt: (point: Vec3) => {
            const address = locateSkinAnnotation(source, point);
            return address && layerIsVisible ? active.zone(address) : null;
          },
        } : base ?? { positions: new Float32Array(), colors: new Float32Array() }),
        ...(source === 'generico' ? renderLayerSettings.generic : renderLayerSettings.personal),
        depthTest: !anatomyDisplay.overlay,
      };
    };
    return { generic: build('generico'), personal: build('personal') };
  }, [annotationLayers, anatomyDisplay, regionOverlays, regionCells, showRegions, layerIsVisible, locateSkinAnnotation, renderLayerSettings, setHoveredZone]);
  const photoRegionOverlay = useMemo(() => {
    if (!regionMap || !slot?.landmarks) return null;
    if (photoLayer && !layerIsVisible) return null;
    const groups = new Map<string, string[]>();
    for (const cell of regionCells) {
      if (!addressHasPhotoCoverage({ triangle: cell.triangle, weights: [1 / 3, 1 / 3, 1 / 3] }, slot.landmarks, genericFaceAtlas)) continue;
      const ids = genericFaceAtlas.triangles.slice(cell.triangle * 3, cell.triangle * 3 + 3);
      const weights = [0, 1, 2].map(axis => cell.corners.reduce((sum, corner) => sum + corner[axis] / 3, 0)) as [number, number, number];
      const label = photoLayer ? photoLayer.zone({ triangle: cell.triangle, weights })
        : patientZone(cell.label, { triangle: cell.triangle, weights });
      if (!label) continue;
      const path = `M${cell.corners.map(weights => `${ids.reduce((sum, id, j) => sum + slot.landmarks![id].x * weights[j], 0)},${ids.reduce((sum, id, j) => sum + slot.landmarks![id].y * weights[j], 0)}`).join('L')}Z`;
      const paths = groups.get(label) ?? [];
      paths.push(path); groups.set(label, paths);
    }
    return [...groups].map(([label, paths]) => ({ label, path: paths.join('') }));
  }, [regionMap, regionCells, slot?.landmarks, photoLayer, layerIsVisible]);
  const hasImage = !!slot;
  const loadedPhotos = PHOTO_SLOTS.filter(v => photos[v.id]);
  const readyPhotos = PHOTO_SLOTS.filter(v => photos[v.id]?.landmarks);
  const unreviewedPhotos = readyPhotos.filter(v => !photos[v.id]?.captureConfirmed);
  // Solo contra la frontal: comparar dos perfiles opuestos entre sí mide sobre todo la malla oculta inferida.
  const photoChecks = useMemo(() => {
    const blocking: string[] = [], warnings: string[] = [];
    const reference = PHOTO_SLOTS.find(v => photos[v.id]?.landmarks && v.id === 'frontal') ?? PHOTO_SLOTS.find(v => photos[v.id]?.landmarks);
    const x = reference && photos[reference.id];
    if (!reference || !x?.landmarks) return { blocking, warnings };
    for (const b of PHOTO_SLOTS) {
      const y = photos[b.id];
      if (b.id === reference.id || !y?.landmarks) continue;
      const check = compareFaceGeometry(
        { landmarks: x.detectedLandmarks ?? x.landmarks, aspect: x.aspect },
        { landmarks: y.detectedLandmarks ?? y.landmarks, aspect: y.aspect });
      if (!check.compatible) (check.blocking ? blocking : warnings).push(`${reference.label} / ${b.label}: ${check.reason}`);
    }
    return { blocking, warnings };
  }, [photos]);
  const incompatiblePhotos = photoChecks.blocking;
  const captureBlocked = unreviewedPhotos.length > 0 || incompatiblePhotos.length > 0;
  const hasPendingPhotos = Object.values(pendingPhotos).some(Boolean);
  const captureSource = photos.frontal?.landmarks ? 'frontal' : photos[view]?.landmarks ? view : VIEWS.find(v => photos[v.id]?.landmarks)?.id;
  const curMeta = (): Meta => ({ mode, dose, zone, product: product || undefined });

  const photoBindings = useMemo(() => slot?.landmarks ? Object.fromEntries(Object.entries(bindings).filter(([, binding]) =>
    binding.paths.flat().every(a => addressHasPhotoCoverage(a, slot.landmarks!, genericFaceAtlas)))) : {},
  [bindings, slot?.landmarks]);
  const surfaceBindings = useMemo(() => personal ? Object.fromEntries(Object.entries(bindings).filter(([, binding]) =>
    binding.paths.flat().every(a => addressHasPhotoCoverage(a, personal.regionMap.landmarks, genericFaceAtlas)))) : {},
  [bindings, personal]);
  const elems = useMemo<Elem[]>(() => slot?.landmarks
    ? anatomicalPhotoElements(bindingsOnLayer(photoBindings, photoLayer), meta, slot.landmarks, genericFaceAtlas) : [],
  [photoBindings, meta, slot?.landmarks, photoLayer]);
  const genericAnnotations = useMemo(() => annotationViews(markers, lines, shapes, bindingsOnLayer(bindings, genericLayer), genericFaceAtlas,
    genericLayer ? genericLayer.point : a => modelPoint(a, genericFaceAtlas)), [markers, lines, shapes, bindings, genericLayer]);
  const personalAnnotations = useMemo(() => personal
    ? annotationViews(markers, lines, shapes, bindingsOnLayer(surfaceBindings, personalLayer), genericFaceAtlas,
      personalLayer ? personalLayer.point : a => surfacePoint(a, personal.surface, genericFaceAtlas))
    : { markers: [], lines: [] }, [markers, lines, shapes, surfaceBindings, personal, personalLayer]);
  const transferStats = useMemo(() => {
    if (!slot?.landmarks) return { count: 0, max: 0 };
    const addresses = Object.values(photoBindings).flatMap(b => b.paths.flatMap(path => path.filter((_, i) => i % 4 === 0)));
    const height = Math.abs(genericFaceAtlas.positions[10 * 3 + 1] - genericFaceAtlas.positions[152 * 3 + 1]);
    let max = 0;
    for (const address of addresses) {
      const q = photoPoint(address, slot.landmarks, genericFaceAtlas), round = locatePhotoPoint(q, slot.landmarks, genericFaceAtlas);
      if (!round) return { count: addresses.length, max: Infinity };
      const a = tryModelPoint(address, genericFaceAtlas), b = tryModelPoint(round, genericFaceAtlas);
      if (!a || !b) return { count: addresses.length, max: Infinity };
      max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / height * 100);
    }
    return { count: addresses.length, max };
  }, [photoBindings, slot?.landmarks]);
  const corrected = useMemo<CorrectedPoint[]>(() => {
    const { points, derived } = expandElems(elems, frame, aspect, regionMap ? p => facialZoneAt(p, regionMap) : undefined);
    const fixed = correctPoints(points, { ...correct, aspect, frame });
    return [
      ...fixed.map(p => isWithinFace({ x: p.x, y: p.y }, frame)
        ? p : { ...p, x: p.rawX, y: p.rawY, corrected: null, shift: 0 }),
      ...derived.map(d => ({ ...d, rawX: d.x, rawY: d.y, corrected: null, shift: 0 })),
    ];
  }, [elems, correct, aspect, frame, regionMap]);
  const stats = useMemo(() => {
    const fixed = corrected.filter(p => p.corrected);
    return { fixed: fixed.length, asis: corrected.length - fixed.length, mean: fixed.length ? fixed.reduce((s, p) => s + p.shift, 0) / fixed.length : 0 };
  }, [corrected]);
  const previewSamples = useMemo(() => elems.flatMap(element => element.paths.flatMap(path =>
    path.filter((_, i) => i % Math.max(1, Math.ceil(path.length / 8)) === 0).map(p => ({ ...p, mode: element.mode })))),
  [elems]);
  // El atlas genérico es la misma referencia usada por los bindings.
  useEffect(() => {
    let active = true;
    if (workspace !== 'simulate' && !calibrating || workMode !== '3d' || modelKind !== 'generico' && !splitAnnotations) return;
    void (async () => {
      try {
        const THREE = await import('three');
        const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
        const positions = Float32Array.from(genericFaceAtlas.positions);
        const xs = positions.filter((_, i) => i % 3 === 0), ys = positions.filter((_, i) => i % 3 === 1);
        const left = Math.min(...xs), right = Math.max(...xs), top = Math.max(...ys), bottom = Math.min(...ys);
        const uvs = Float32Array.from(Array.from(positions).flatMap((_, i) => i % 3 === 0
          ? [(positions[i] - left) / (right - left), (top - positions[i + 1]) / (top - bottom)] : []));
        const samples = Object.entries(bindings).flatMap(([id, binding]) => {
          const mode = previewModes[id];
          if (!mode) return [];
          return binding.paths.flatMap(path => path.filter((_, i) => i % Math.max(1, Math.ceil(path.length / 8)) === 0)
            .map(address => {
              const p = modelPoint(address, genericFaceAtlas);
              return { mode, x: (p.x - left) / (right - left), y: (top - p.y) / (top - bottom) };
            }));
        });
        const rgb = Float32Array.from({ length: positions.length }, (_, i) => [0.65, 0.47, 0.37][i % 3]);
        const result = previewSurface(positions, uvs, samples, preview, (right - left) / (top - bottom), rgb);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(result.rgb!, 3));
        geometry.setIndex(genericFaceAtlas.triangles); geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.FrontSide });
        const mesh = new THREE.Mesh(geometry, material); mesh.name = 'PERSONAL_FACE_SURFACE_GENERIC';
        // El visor conserva coordenadas/materiales de superficies locales con este contrato.
        const group = new THREE.Group(); group.name = 'PERSONAL_FACE_SURFACE'; group.add(mesh);
        try {
          const buffer = await new GLTFExporter().parseAsync(group, { binary: true });
          if (active && buffer instanceof ArrayBuffer) {
            setGenericPreviewGlb(buffer); setGenericPreviewAfter(preview.after);
          }
        } finally { geometry.dispose(); material.dispose(); }
      } catch (error) {
        if (active) setStatus(`No se pudo preparar el preview genérico: ${error instanceof Error ? error.message : 'error WebGL'}.`);
      }
    })();
    return () => { active = false; };
  }, [workspace, workMode, modelKind, splitAnnotations, bindings, previewModes, preview, calibrating]);

  // Renderer por foto activa
  useEffect(() => {
    rendererRef.current?.dispose(); rendererRef.current = null;
    if (!slot || !glRef.current) return;
    try { rendererRef.current = createRenderer(glRef.current, slot.canvas); } catch (e) { setStatus(`WebGL: ${(e as Error).message}`); return; }
    if (!rendererRef.current) setStatus('Este navegador no soporta WebGL.');
    setRenderTick(t => t + 1);
  }, [slot?.canvas]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => rendererRef.current?.dispose(), []);
  // Render en tiempo real
  useEffect(() => {
    if (!rendererRef.current) return;
    const id = requestAnimationFrame(() => rendererRef.current?.draw(
      buildIllustrativeEffects(previewSamples, { ...preview, after: workspace === 'simulate' && preview.after }, aspect, MAX_EFFECTS),
      aspect, preview.after ? split : 1,
    ));
    return () => cancelAnimationFrame(id);
  }, [previewSamples, preview, workspace, aspect, split, renderTick]);

  const snap = useCallback(() => setHistory(h => annotationHistory(h, { markers, lines, shapes, meta, photoEls, bindings, quickRecord })), [markers, lines, shapes, meta, photoEls, bindings, quickRecord]);
  const undo = () => {
    const s = history.at(-1); if (!s) return;
    setMarkers(s.markers); setLines(s.lines); setShapes(s.shapes); setMeta(s.meta); setPhotoEls(s.photoEls); setBindings(s.bindings);
    setQuickRecord(s.quickRecord); setSelectedId(id => id && s.bindings[id] ? id : null); setHistory(h => h.slice(0, -1));
  };
  const clearAll = () => { snap(); setMarkers([]); setLines([]); setShapes([]); setMeta({}); setPhotoEls([]); setBindings({}); setQuickRecord(initialQuickRecordSettings()); };
  const activateGenericModel = () => {
    genericSelected.current = true;
    personalRequestRef.current++;
    setBuildingPersonal(false);
    setWorkMode('3d');
    setModelKind('generico');
    setStatus('Modelo original seleccionado. Las marcaciones anatómicas se conservan y se comparten con superficie y foto.');
  };
  const activatePersonal = () => {
    setWorkMode('3d');
    if (modelKind === 'personal' && personalProjection) return;
    if (personal && personal.view === view && personal.canvas === slot?.canvas) {
      setModelKind('personal');
      genericSelected.current = false;
      setStatus('Superficie 3D personal activa; se conservan todas las marcaciones anatómicas.');
      return;
    }
    void buildPersonal();
  };
  const buildPersonal = async (nextDepth = depth, sourceView = view, closeHead = personal?.closedHead ?? false) => {
    if (closeHead) sourceView = 'frontal';
    if (hasPendingPhotos) {
      setStatus('Espera a que termine la detección de las fotos antes de calcular la superficie.');
      return;
    }
    if (captureBlocked) {
      setStatus(incompatiblePhotos.length ? incompatiblePhotos.join(' ') : 'Revisa y confirma cada captura antes de fusionar. La compatibilidad geométrica no verifica identidad.');
      return;
    }
    const source = photos[sourceView];
    if (!source?.landmarks) {
      setStatus('Para la superficie personal carga una foto con el rostro detectado (landmarks MediaPipe).');
      return;
    }
    const requestId = ++personalRequestRef.current;
    setBuildingPersonal(true);
    setStatus(closeHead ? 'Calculando cabeza estimada con las referencias disponibles…' : 'Calculando superficie facial…');
    setCalibrating(false);
    try {
      const profiles = PHOTO_SLOTS.filter(v => v.id !== sourceView).flatMap(v => {
        const photo = photos[v.id];
        return photo?.landmarks ? [{ label: v.label, landmarks: photo.landmarks, aspect: photo.aspect, pose: photo.pose }] : [];
      });
      const refined = refineDepthFromProfiles({ landmarks: source.landmarks, aspect: source.aspect, pose: source.pose }, profiles, { preserveLips: !closeHead });
      const diagnostics = refined.diagnostics.map(d => ({ ...d, label: profiles[d.index].label }));
      if (closeHead && (refined.used < 2 || refined.coverage !== 'bilateral')) {
        throw new Error('La cabeza estimada requiere al menos tres fotos útiles que cubran ambos lados. Revisa «Concordancia por foto».');
      }
      const depthDetails = [
        refined.used ? `Cálculo con ${refined.used + 1} fotos útiles. ${refined.coverage === 'bilateral'
          ? 'Ambos lados aportan profundidad.' : 'La profundidad está contrastada principalmente desde un lado; añade una vista del lado opuesto.'}`
          : 'Cálculo rápido con una foto: profundidad monocular sin contrastar. Añade otra foto con un ángulo diferente para contrastar nariz y labios.',
        diagnostics.some(d => d.status !== 'used') ? 'Hay referencias de aporte limitado o no utilizables; revisa el detalle por foto.' : '',
        closeHead ? 'Cabeza de plantilla anatómica (cráneo y orejas) deformada a los puntos faciales y ajustada a las siluetas de las tres vistas; cuello acotado. Aproximación, no escaneo.' : '',
      ].join(' ');
      const triangles = await faceTriangles();
      const baseSurface = buildPersonalSurface(refined.landmarks, source.aspect, triangles, nextDepth);
      if (!baseSurface) throw new Error('Landmarks insuficientes para construir la malla.');
      let observedSurface = baseSurface, profileDetails = '';
      let photoPatches: PhotoSurfacePatch[] | undefined;
      const skippedCameras: string[] = [];
      const inputs = [...PHOTO_SLOTS].sort((a, b) => Number(b.id === sourceView) - Number(a.id === sourceView)).flatMap(entry => {
        const photo = photos[entry.id];
        if (!photo?.landmarks || (entry.id !== sourceView && !diagnostics.some(d => d.label === entry.label && d.status !== 'rejected' && d.weight > 0))) return [];
        const fit = fitHairPhotoProjection(baseSurface.positions, photo.landmarks);
        if (!fit || fit.error > 0.08) {
          if (closeHead) throw new Error(`La cámara de ${entry.label} no concuerda con la superficie facial.`);
          skippedCameras.push(entry.label);
          return [];
        }
        return [{ label: entry.label, canvas: photo.canvas, projection: fit.projection }];
      });
      let sources: Awaited<ReturnType<typeof import('./photoHead')['segmentPhotoHeads']>> = [];
      if (inputs.length > 1) {
        setStatus(closeHead ? 'Ajustando siluetas, piel, orejas y cabello de las tres vistas…' : 'Contrastando la silueta de los perfiles…');
        const [{ segmentPhotoHeads }, { refineProfileDepth }] = await Promise.all([import('./photoHead'), import('./multiViewHead')]);
        try { sources = await segmentPhotoHeads(inputs); } catch (error) {
          if (closeHead) throw error;
          profileDetails = ` Sin ajuste por siluetas ni textura lateral: ${error instanceof Error ? error.message : 'falló la segmentación local'}. Se conserva la superficie basada en referencias.`;
        }
        if (requestId !== personalRequestRef.current) return;
        // El ajuste por silueta nasal modifica Z sin arrastrar XY frontal ni los labios.
        const profile = refineProfileDepth(baseSurface.positions, sources);
        if (profile) {
          observedSurface = { ...baseSurface, positions: profile.positions };
          profileDetails = ` Perfil nasal: ${profile.points} referencias contrastadas con la silueta lateral, sin modificar XY frontal ni labios.`;
        } else if (!profileDetails) profileDetails = ' No se aplicó silueta nasal: no hubo un perfil suficientemente lateral y estable.';
      }
      if (skippedCameras.length) profileDetails += ` Sin textura de ${skippedCameras.join(', ')} por registro de cámara insuficiente.`;
      let surface: PersonalSurface | EstimatedHeadSurface = observedSurface;
      if (closeHead) {
        const [{ sampleScalpColor, sampleColorAt }, { buildTemplateHead }] = await Promise.all([
          import('./multiViewHead'), import('./templateHead'),
        ]);
        surface = {
          ...buildTemplateHead(observedSurface, {
            landmarks: genericFaceAtlas.positions, positions: genericFaceAtlas.surface.positions, triangles: genericFaceAtlas.surface.triangles,
          }, sources),
          inferredColor: sampleScalpColor(sources, observedSurface.positions.subarray(30, 33)),
          inferredSkinColor: sampleColorAt(sources[0], [151, 50, 280].map(i => observedSurface.positions.subarray(i * 3, i * 3 + 3))),
        };
      }
      if (sources.length > 1) {
        const { buildPhotoSurfacePatches } = await import('./multiViewHead');
        photoPatches = buildPhotoSurfacePatches(surface, sources, observedSurface.indices.length);
        if (!photoPatches.length) throw new Error('Las vistas no ofrecen textura proyectable sobre la superficie.');
      }
      const openingDetails = 'preservedOpenings' in surface && Number(surface.preservedOpenings) > 0
        ? ` ${surface.preservedOpenings} abertura(s) de labios/párpados cerrados conservadas sin tapa artificial; el contorno craneal sí se completa.` : '';
      const regions = buildFaceRegionMap(refined.landmarks, triangles, source.aspect, genericFaceAtlas.positions);
      const { personalSurfaceToGlb } = await import('./personalSurfaceGlb');
      const glb = await personalSurfaceToGlb(surface, source.canvas, undefined, [], photoPatches);
      if (requestId !== personalRequestRef.current) return;
      setPersonal({ view: sourceView, canvas: source.canvas, glb, projection: surface.projection, depth: nextDepth, depthDetails: depthDetails + profileDetails + openingDetails, diagnostics,
        surface: observedSurface, renderSurface: surface, regionMap: regions, closedHead: closeHead, photoPatches });
      genericSelected.current = false;
      setModelKind('personal');
      setStatus(`Superficie 3D personal generada desde la foto ${VIEWS.find(v => v.id === sourceView)?.label ?? sourceView} (${surface.indices.length / 3} triángulos). ${depthDetails}${profileDetails}${openingDetails} Las marcaciones anatómicas se conservan.`);
    } catch (error) {
      if (requestId !== personalRequestRef.current) return;
      setDepth(personal?.depth ?? 1);
      setStatus(`No se pudo generar la superficie personal: ${error instanceof Error ? error.message : 'error desconocido'}. Se mantiene el modelo anterior.`);
    } finally {
      if (requestId === personalRequestRef.current) setBuildingPersonal(false);
    }
  };
  const analyzeHair = async () => {
    const surface = personal?.renderSurface;
    if (!personal?.closedHead || !surface || !('observedIndexCount' in surface)) {
      setStatus('Calcula primero la cabeza estimada con cobertura bilateral para proyectar el cabello visible.');
      return;
    }
    const source = personal, revision = personalRequestRef.current, request = ++hairRequest.current;
    setHairBusy(true); setHairAnalysis(null);
    setStatus('Segmentando cabello localmente; las fotografías no salen del navegador.');
    try {
      const skipped: string[] = [];
      const inputs = PHOTO_SLOTS.flatMap(slot => {
        const photo = photos[slot.id];
        if (!photo?.landmarks || !photo.captureConfirmed) return [];
        if (slot.id !== source.view && !source.diagnostics.some(d => d.label === slot.label && d.status === 'used')) return [];
        const fit = fitHairPhotoProjection(source.surface.positions, photo.landmarks);
        if (!fit || fit.error > 0.08) { skipped.push(`${slot.label}: proyección insuficiente`); return []; }
        return [{ label: slot.label, canvas: photo.canvas, projection: fit.projection }];
      });
      if (!inputs.length) throw new Error('Ninguna captura tiene una proyección capilar compatible.');
      const { segmentPhotoHair } = await import('./photoHair');
      const sources = await segmentPhotoHair(inputs);
      if (request !== hairRequest.current || revision !== personalRequestRef.current) return;
      const patches = buildPhotoHairPatches(surface.positions, surface.indices.subarray(surface.observedIndexCount), sources);
      setHairAnalysis({ personal: source, patches });
      setHair(current => ({ ...current, enabled: true }));
      setStatus(patches.length
        ? `Cabello de ${patches.length} vista(s) proyectado sobre la misma superficie craneal, sin volumen añadido. Relieve visual de textura, no profundidad medida. Las zonas sin cobertura siguen grises. ${skipped.join('. ')}`
        : 'No se encontró cabello visible con cobertura suficiente sobre el cráneo. No se añade pelo ficticio. Revisa encuadre, iluminación y límites.');
    } catch (error) {
      if (request === hairRequest.current && revision === personalRequestRef.current) setStatus(`No se pudo proyectar el cabello: ${error instanceof Error ? error.message : 'error desconocido'}. No se añade un casquete genérico.`);
    } finally { if (request === hairRequest.current) setHairBusy(false); }
  };

  const loadFile = async (file: File, target: PhotoSlotId) => {
    if (!file.type.startsWith('image/')) { setStatus('El archivo debe ser una imagen.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setStatus('La imagen supera el límite de 20 MiB.'); return; }
    personalRequestRef.current++;
    setBuildingPersonal(false);
    const requestId = (uploadRequestRef.current[target] ?? 0) + 1;
    uploadRequestRef.current[target] = requestId;
    const targetView = target === 'extra_a' || target === 'extra_b' ? 'frontal' : target;
    setPendingPhotos(p => ({ ...p, [target]: true }));
    try {
      let bmp: ImageBitmap | null = null;
      let c: HTMLCanvasElement;
      try {
        bmp = await createImageBitmap(file);
        if (bmp.width * bmp.height > MAX_IMAGE_PIXELS) { setStatus('La imagen supera el límite de 40 megapíxeles.'); return; }
        const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        const context = c.getContext('2d');
        if (!context) { setStatus('No se pudo preparar la imagen en este navegador.'); return; }
        context.drawImage(bmp, 0, 0, c.width, c.height);
      } catch {
        setStatus('No se pudo decodificar la imagen. Selecciona otra fotografía.');
        return;
      } finally {
        bmp?.close();
      }
      if (requestId !== uploadRequestRef.current[target]) return;
      const replacedPersonal = !!personal;
      if (replacedPersonal) { setPersonal(null); setModelKind('generico'); }
      const personalNote = replacedPersonal ? ' Se actualizaron las fotos; regenera la superficie. Las marcaciones anatómicas se conservan para revisar su transferencia al nuevo rostro.' : '';
      setPhotos(p => ({ ...p, [target]: { canvas: c, aspect: c.width / c.height, frame: defaultFrame(targetView), previewUrl: c.toDataURL('image/jpeg', 0.6) } }));
      setCalibrating(false);
      setPhotoAnchor(null);
      setContourIndex(null);
      setPickingForehead(false); setForeheadPreview(null); setSkinReview(null);
      if (target !== 'extra_a' && target !== 'extra_b') setView(target);
      const label = PHOTO_SLOTS.find(v => v.id === target)?.label ?? target;
      let release!: () => void;
      const previous = detectionQueueRef.current;
      detectionQueueRef.current = new Promise<void>(resolve => { release = resolve; });
      await previous;
      let detected: Awaited<ReturnType<typeof detectFrame>>;
      try {
        if (requestId !== uploadRequestRef.current[target]) return;
        setStatus(`Detectando rostro en ${label}…`);
        detected = await detectFrame(c);
      } finally {
        release();
      }
      if (requestId !== uploadRequestRef.current[target]) return;
      if (!detected.frame) {
        setPhotos(p => p[target]?.canvas === c ? { ...p, [target]: { ...p[target]!, detectionError: detected.reason } } : p);
        setStatus(`${detected.reason} Sin rostro detectado no se permite marcar ni proyectar sobre esta foto. Usa una foto nítida con el rostro descubierto.${personalNote}`);
        return;
      }
      const auto = target === 'extra_a' || target === 'extra_b' ? null : autoRegistration(target, detected.frame, c.width / c.height, flipX);
      const accepted = isRegistrationAccepted(auto);
      const previewUrl = c.toDataURL('image/jpeg', 0.6);
      setPhotos(p => (p[target]?.canvas === c ? {
        ...p,
        [target]: {
          ...p[target]!, frame: detected.frame!, landmarks: detected.landmarks, detectedLandmarks: detected.detectedLandmarks,
          contourAdjusted: detected.contourAdjusted, regionMap: detected.regionMap, pose: detected.pose, modelAnchors: undefined,
          captureWarnings: detected.captureWarnings, captureConfirmed: false,
          previewUrl,
          ...(accepted ? { registration: auto, registrationFlip: flipX, registrationSource: 'auto' as const } : { registration: undefined }),
        },
      } : p));
      if (uploadRequestRef.current[target] === requestId) setBoundaryReview(queue => [...queue.filter(id => id !== target), target]);
      setStatus(`Rostro detectado en ${label}. Revisa el límite de la frente propuesto y confirma la captura.`
        + ` Contorno: ${detected.contourAdjusted ?? 0} referencias ajustadas por borde visible; revisa mentón y sienes en «Editar contorno».` + personalNote);
    } catch (error) {
      if (requestId !== uploadRequestRef.current[target]) return;
      console.error('[FaceSimLab] No se pudo analizar la foto', error);
      const reason = `No se pudo analizar la foto: ${error instanceof Error ? error.message : 'error desconocido'}. Puedes volver a cargarla.`;
      setPhotos(p => p[target] ? { ...p, [target]: { ...p[target]!, detectionError: reason } } : p);
      setStatus(reason);
    } finally {
      if (requestId === uploadRequestRef.current[target]) {
        setPendingPhotos(p => ({ ...p, [target]: false }));
      }
    }
  };

  const removePhoto = (id: PhotoSlotId) => {
    uploadRequestRef.current[id] = (uploadRequestRef.current[id] ?? 0) + 1;
    personalRequestRef.current++;
    setBuildingPersonal(false);
    setPendingPhotos(p => ({ ...p, [id]: false }));
    setBoundaryReview(queue => queue.filter(q => q !== id));
    setForeheadReference(current => current?.slot === id ? null : current);
    setPhotos(p => {
      const next = { ...p };
      delete next[id];
      return next;
    });
    setPersonal(null); setModelKind('generico');
    setCalibrating(false); setPhotoAnchor(null); setContourIndex(null);
    setStatus(`Se retiró ${PHOTO_SLOTS.find(v => v.id === id)?.label}. Recalcula la superficie con las fotos restantes. Las marcaciones anatómicas se conservan.`);
  };
  const updateFrame = (k: 'top' | 'bottom' | 'left' | 'right', v: number) => setPhotos(p => {
    const s = p[view]; if (!s) return p;
    const { anchors: _anchors, outline: _outline, ...manualFrame } = s.frame;
    void _anchors; void _outline;
    const n = { ...manualFrame, [k]: v, source: 'manual' as const }, mid = (n.left + n.right) / 2;
    return { ...p, [view]: { ...s, registration: undefined, modelAnchors: undefined, frame: { ...n, axisTop: { x: mid, y: n.top }, axisBottom: { x: mid, y: n.bottom } } } };
  });

  // ── Marcación en modelo 3D ──
  const acceptsAddress = (source: 'generico' | 'personal' | 'foto', address: FaceAddress): boolean => {
    const landmarks = source === 'personal' ? personal?.regionMap.landmarks : source === 'foto' ? slot?.landmarks : undefined;
    if (source !== 'generico' && (!landmarks || !addressHasPhotoCoverage(address, landmarks, genericFaceAtlas))) return false;
    return layerIsVisible && (anatomyDisplay.anatomy === 'skin' || !!activeLayer(source)?.accepts(address));
  };
  const locateAnnotation = (source: 'generico' | 'personal' | 'foto', p: Vec3): FaceAddress | null => {
    const address = locateSkinAnnotation(source, p);
    return address && acceptsAddress(source, address) ? address : null;
  };
  const blockedMark = () => setStatus('Marcación rechazada: falta cobertura facial observada o anatomía visible en la capa activa (puede haber un hueco). No se marcan orejas, nuca, reverso ni superficies inferidas. Se conservan las marcas anteriores.');
  const makeBinding = (paths: Vec3[][], source: 'generico' | 'personal' | 'foto', kind: ElemKind, skinOnly = false) =>
    bindAnatomicalPaths(paths, p => skinOnly ? locateSkinAnnotation(source, p) : locateAnnotation(source, p), kind, source === 'foto' ? 0.004 : 0.035);
  const commitBinding = (
    id: string, value: AnatomicalBinding, source: 'generico' | 'personal' | 'foto',
    updating = false, properties = meta[id] ?? curMeta(),
  ): boolean => {
    const binding = { ...value, illustrativePlane: value.illustrativePlane ?? anatomyDisplay.anatomy };
    const entries: [string, AnatomicalBinding][] = [[id, binding]];
    if (!updating && bilateral) {
      const mirrored = mirrorAnnotation(binding, genericFaceAtlas, address => acceptsAddress(source, address));
      if (!mirrored) { blockedMark(); return false; }
      entries.push([uid(), mirrored]);
    }
    // Validación completa ANTES de tomar un único snapshot, también para ambos lados.
    snap();
    const ids = new Set(entries.map(([key]) => key));
    setMarkers(current => [
      ...current.filter(marker => !marker.id || !ids.has(marker.id)),
      ...entries.filter(([, entry]) => entry.kind === 'point').map(([key, entry]): Marker3D => {
        const address = entry.paths[0][0];
        return { id: key, type: 'Puntual', pathologyId: 'filler', zone: '', rotation: [0, 0, 0],
          position: modelPoint(address, genericFaceAtlas), normal: surfaceNormal(address, genericFaceAtlas, a => modelPoint(a, genericFaceAtlas)) };
      }),
    ]);
    setLines(current => [
      ...current.filter(line => !ids.has(line.id)),
      ...entries.filter(([, entry]) => entry.kind !== 'point').map(([key, entry]): FreehandLine => {
        const paths = entry.paths.map(path => path.map(address => modelPoint(address, genericFaceAtlas)));
        const previous = current.find(line => line.id === key);
        return { ...previous, id: key, points: paths[0], segments: paths.length > 1 ? paths : undefined,
          color: SIM_MODES[properties.mode].color, thickness: previous?.thickness ?? 1.5,
          ...(entry.kind === 'arrow' ? { technique_preset: 'Flecha' } : {}) };
      }),
    ]);
    // Los contornos se editan como su polígono real, no como una segunda copia.
    setShapes(current => current.filter(shape => !ids.has(shape.id)));
    setBindings(current => ({ ...current, ...Object.fromEntries(entries) }));
    setMeta(current => ({ ...current, ...Object.fromEntries(entries.map(([key]) => [key, { ...properties }])) }));
    setSelectedId(id);
    if (!updating && askVolume) setPendingVolume(entries.map(([key]) => key));
    return true;
  };
  /** Marca solo en la cabeza completa (cuello, cuero cabelludo): sin binding, no se transfiere. */
  const commitExtendedPoint = (m: Marker3D) => {
    snap();
    const id = m.id ?? uid();
    setMarkers(current => [...current, { ...m, id }]);
    setMeta(current => ({ ...current, [id]: { ...curMeta(), zone: EXTENDED_ZONE } }));
    setSelectedId(id);
    if (askVolume) setPendingVolume([id]);
    setStatus('Punto en zona extendida: solo existe en el modelo 3D completo y se exporta igual.');
  };
  const isOutsideMask = (p: Vec3) => !locateSkinAnnotation('generico', p);
  const mirrorSelected = () => {
    if (!selectedId || !bindings[selectedId] || !meta[selectedId]) return;
    const source = workMode === 'foto' ? 'foto' : modelKind;
    const mirrored = mirrorAnnotation(bindings[selectedId], genericFaceAtlas, address => acceptsAddress(source, address));
    if (!mirrored) { blockedMark(); return; }
    // updating=true impide que el modo bilateral cree un tercer elemento.
    if (commitBinding(uid(), mirrored, source, true, meta[selectedId])) setStatus('Espejo creado; original y registro conservados. Deshacer revierte toda la acción.');
  };
  const transformSelected = (change: { scale?: number; degrees?: number }) => {
    if (!selectedId || !bindings[selectedId]) return;
    const source = workMode === 'foto' ? 'foto' : modelKind;
    const next = transformAnnotation(bindings[selectedId], change, genericFaceAtlas, address => acceptsAddress(source, address));
    if (!next) { blockedMark(); return; }
    if (commitBinding(selectedId, next, source, true)) setStatus('Figura ajustada sobre la superficie; registro y volumen conservados.');
  };
  const onMarker = (m: Marker3D, source: 'generico' | 'personal') => {
    if (workspace !== 'simulate' && !calibrating) return;
    if (preview.after && !calibrating) return;
    if (tool3d !== 'point' || !m.id) return;
    if (calibrating && source === 'generico') {
      const current = slot?.modelAnchors ?? [];
      if (!slot || current.length >= anchorCount) return;
      const next = [...current, m.position];
      if (next.length < anchorCount) {
        setPhotos(p => p[view]?.canvas === slot.canvas ? { ...p, [view]: { ...p[view]!, modelAnchors: next } } : p);
        setStatus(`Anclaje ${next.length}/${anchorCount} guardado. Ahora marca en el modelo: ${anchorName(next.length)}.`);
        return;
      }
      const source = next.map(position => projectModel(position, view, frame, flipX, aspect))
        .map(point => point ?? { x: Number.NaN, y: Number.NaN });
      const targets = anchorIndices.map(index => frame.anchors?.[index]).filter((point): point is P2 => !!point);
      const registration = fitAffineRegistration(source, targets, aspect, frame.bottom - frame.top);
      setCalibrating(false);
      if (!isRegistrationAccepted(registration)) {
        const auto = autoRegistration(view, frame, aspect, flipX);
        const fallback = isRegistrationAccepted(auto) ? { registration: auto, registrationFlip: flipX, registrationSource: 'auto' as const } : { registration: undefined };
        setPhotos(p => p[view]?.canvas === slot.canvas ? { ...p, [view]: { ...p[view]!, modelAnchors: undefined, ...fallback } } : p);
        setStatus('Prueba afín rechazada: los anclajes no coinciden lo suficiente. La transferencia anatómica sigue usando el atlas denso y no se modifica.');
        return;
      }
      setPhotos(p => p[view]?.canvas === slot.canvas ? { ...p, [view]: { ...p[view]!, modelAnchors: next, registration, registrationFlip: flipX, registrationSource: 'manual' } } : p);
      setStatus(`Prueba afín aceptada; RMS ${(registration.rmse * 100).toFixed(1)}%, máximo ${(registration.maxError * 100).toFixed(1)}%. Es un diagnóstico independiente: no modifica la transferencia por atlas denso.`);
      return;
    }
    const binding = makeBinding([[m.position]], source, 'point');
    if (!binding) {
      if (source === 'generico' && extendedZone && isOutsideMask(m.position)) { commitExtendedPoint(m); return; }
      blockedMark(); return;
    }
    if (!commitBinding(m.id, binding, source)) return;
    setStatus('Marcación anatómica compartida entre modelo original, superficie y foto. Cambiar de vista no la elimina.');
  };
  const onLine = (l: FreehandLine, source: 'generico' | 'personal', updating = false) => {
    if (workspace !== 'simulate' || preview.after || tool3d === 'navigate' || calibrating) return;
    const previous = updating ? bindings[l.id] : undefined;
    if (previous?.center && (previous.kind === 'circle' || previous.kind === 'rect')) {
      // El visor edita líneas abiertas: un contorno cerrado NO se debe convertir
      // en la cuerda entre extremos coincidentes. Trasladar el polígono completo.
      const address = l.points[0] && locateAnnotation(source, l.points[0]);
      if (!address) { blockedMark(); return; }
      const from = canonicalAnnotationPoint(previous.paths[0][0], genericFaceAtlas);
      const to = canonicalAnnotationPoint(address, genericFaceAtlas);
      const moved = translateAnnotation(previous, { x: to.x - from.x, y: to.y - from.y }, genericFaceAtlas,
        point => acceptsAddress(source, point));
      if (!moved) { blockedMark(); return; }
      if (commitBinding(l.id, moved, source, true)) setStatus('Contorno completo trasladado. Centro, registro y cantidad conservados; no se convierte en una línea.');
      return;
    }
    const binding = makeBinding(l.segments?.length ? l.segments : [l.points], source,
      previous?.kind ?? (l.technique_preset === 'Flecha' ? 'arrow' : l.segments?.length ? 'pattern' : tool3d === 'straight-line' ? 'line' : 'free'));
    if (!binding) { blockedMark(); return; }
    if (previous?.center) {
      const points = l.points;
      const center = points.reduce((c, p) => ({ x: c.x + p.x / points.length, y: c.y + p.y / points.length, z: c.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
      const address = locateAnnotation(source, center);
      if (!address) { blockedMark(); return; }
      binding.center = address;
    }
    if (previous?.illustrativePlane) binding.illustrativePlane = previous.illustrativePlane;
    if (!commitBinding(l.id, binding, source, updating)) return;
    setStatus('Trazo anatómico compartido actualizado. Se conserva al cambiar modelo, superficie o foto.');
  };
  const onShape = (s: SurfaceShape, source: 'generico' | 'personal') => {
    if (workspace !== 'simulate' || preview.after || tool3d === 'navigate' || calibrating) return;
    const binding = makeBinding([shapeOutline(s)], source, s.shapeType === 'circle' ? 'circle' : 'rect');
    const center = locateAnnotation(source, s.center);
    if (!binding || !center) { blockedMark(); return; }
    if (!commitBinding(s.id, { ...binding, center }, source)) return;
    setStatus('Contorno anatómico compartido entre modelo, superficie y foto; revisa su cobertura completa.');
  };

  // ── Marcación sobre la foto ──
  const toNorm = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const hitPhoto = (n: P2) => {
    let best: string | null = null, bd = 0.025;
    elems.forEach(e => {
      const path = e.boundary ?? e.paths[0];
      const d = e.kind === 'point' ? Math.hypot((path[0].x - n.x) * aspect, path[0].y - n.y)
        : Math.min(...path.slice(1).map((q, i) => segDist(n, path[i], q, aspect)));
      if (d < bd) { bd = d; best = e.id; }
    });
    return best;
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pickingForehead && slot?.landmarks && e.button === 0) {
      setForeheadPreview({ canvas: slot.canvas, point: toNorm(e), confirmed: false, reason: 'Límite elegido manualmente. Confirma que el punto está sobre piel visible, no sobre cabello ni fondo.' });
      setPickingForehead(false);
      return;
    }
    if (contourIndex !== null && slot) {
      if (e.button === 0) void correctLandmark(contourIndex, toNorm(e));
      return;
    }
    if (photoAnchor !== null && slot) {
      if (e.button !== 0) return;
      correctPhotoAnchor(toNorm(e));
      return;
    }
    if (workspace !== 'simulate' || !hasImage || workMode !== 'foto') return;
    const n = toNorm(e), id = hitPhoto(n);
    if (e.button !== 0 && e.button !== 2) return;
    setSelectedId(id);
    if (preview.after) return;
    if (photoInteraction === 'select') return;
    if (!locateAnnotation('foto', { ...n, z: 0 })) { blockedMark(); return; }
    if (e.button === 2 || e.altKey) { if (id) { snap(); removeEl(id); } return; }
    const hitEl = elems.find(p => p.id === id);
    if (hitEl?.kind === 'point') { snap(); dragRef.current = id; e.currentTarget.setPointerCapture(e.pointerId); return; }
    setDraft({ kind: toolPhoto, pts: [n] });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const applyLandmarks = (landmarks: Landmark[], triangles: number[], contourAdjusted = slot?.contourAdjusted, foreheadReviewed = slot?.foreheadReviewed, target: PhotoSlotId = view) => {
    const source = photos[target];
    if (!source) return;
    const nextFrame = frameFromLandmarks(landmarks);
    const registration = target === 'extra_a' || target === 'extra_b' ? null : autoRegistration(target, nextFrame, source.aspect, flipX);
    personalRequestRef.current++;
    setBuildingPersonal(false);
    setPersonal(null); setModelKind('generico');
    setPhotos(p => p[target]?.canvas === source.canvas ? {
      ...p, [target]: { ...p[target]!, landmarks, contourAdjusted, foreheadReviewed, frame: nextFrame, regionMap: buildFaceRegionMap(landmarks, triangles, source.aspect, genericFaceAtlas.positions),
        modelAnchors: undefined, registration: isRegistrationAccepted(registration) ? registration : undefined,
        registrationFlip: flipX, registrationSource: 'auto' },
    } : p);
    setStatus('Geometría, contorno y referencias actualizados juntos. Recalcula la superficie personal. Las marcaciones anatómicas se conservan; revisa su nueva correspondencia.');
    setPhotoAnchor(null); setContourIndex(null);
  };
  const suggestForehead = () => {
    if (!slot?.landmarks) return;
    const context = slot.canvas.getContext('2d');
    if (!context) { setStatus('No se pudieron leer los píxeles para revisar la frente.'); return; }
    const suggestion = proposeForeheadBoundary(slot.landmarks, context.getImageData(0, 0, slot.canvas.width, slot.canvas.height));
    setStatus(suggestion.reason);
    setForeheadPreview(suggestion.point ? { canvas: slot.canvas, point: suggestion.point, confirmed: false, reason: suggestion.reason } : null);
    if (suggestion.point) setWorkMode('foto');
  };
  const confirmForehead = async () => {
    if (!slot?.landmarks || !currentForeheadPreview?.confirmed) return;
    const source = slot, request = personalRequestRef.current, point = currentForeheadPreview.point;
    try {
      const triangles = await faceTriangles();
      if (request !== personalRequestRef.current) return;
      const landmarks = extendVisibleForehead(source.landmarks!, point, source.aspect, triangles);
      if (!landmarks) { setStatus('No se aplicó el límite frontal: desplazamiento excesivo, referencias insuficientes o malla inválida. Elige un punto más próximo sobre piel visible.'); return; }
      applyLandmarks(landmarks, triangles, source.contourAdjusted, true);
      rememberForehead(view, source, point);
      setForeheadPreview(null); setPickingForehead(false);
      setStatus('Banda frontal ampliada hasta el límite revisado de piel visible. Ceja y ojos se conservan; recalcula la superficie. No reconstruye piel oculta bajo el cabello.');
    } catch (error) {
      console.error('[FaceSimLab] No se pudo revisar la frente', error);
      setStatus(`No se pudo actualizar la frente: ${error instanceof Error ? error.message : 'error desconocido'}. Se conserva la geometría anterior.`);
    }
  };
  const analyzeAppearance = async () => {
    if (!slot?.landmarks || !slot.regionMap || !slot.captureConfirmed) {
      setStatus('Confirma primero una captura facial válida antes del análisis de apariencia.');
      return;
    }
    const source = slot;
    setAnalyzingSkin(true);
    try {
      const { analyzeSkinAppearance } = await import('./skinAppearance');
      if (activePhotoRef.current !== source.canvas) return;
      const scale = Math.min(1, 384 / Math.max(source.canvas.width, source.canvas.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.canvas.width * scale)); canvas.height = Math.max(1, Math.round(source.canvas.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No se pudieron leer los píxeles de la captura.');
      context.drawImage(source.canvas, 0, 0, canvas.width, canvas.height);
      const regions = source.regionMap!;
      const rgba = rasterizeFaceRegions(regions, canvas.width, canvas.height, () => '#ffffff', triangle => {
        const labels = regions.triangles.slice(triangle * 3, triangle * 3 + 3).map(i => regions.labels[i]);
        return !labels.some(label => /ocular|labio|comisura|ceja|patas|ojeras|filtrum|sin zona/i.test(label))
          && (skinRegion === 'all' || labels.every(label => skinRegion === 'tzone' ? /frente|glabela|nasal|mentón/i.test(label) : /mejillas|pómulos/i.test(label)));
      });
      const mask = Uint8Array.from({ length: canvas.width * canvas.height }, (_, i) => rgba[i * 4 + 3] ? 1 : 0);
      const result = analyzeSkinAppearance(context.getImageData(0, 0, canvas.width, canvas.height), mask);
      const urls = {
        contrast: pixelsUrl(result.channels.contrast.rgba, canvas.width, canvas.height),
        redness: pixelsUrl(result.channels.redness.rgba, canvas.width, canvas.height),
        texture: pixelsUrl(result.channels.texture.rgba, canvas.width, canvas.height),
        shine: pixelsUrl(result.channels.shine.rgba, canvas.width, canvas.height),
      };
      setSkinReview({ canvas: source.canvas, width: canvas.width, height: canvas.height, landmarks: source.landmarks!, result, urls });
      setStatus(result.usable ? 'Apariencia RGB calculada localmente: variaciones visuales, no lesiones ni vasos identificados.' : `Análisis RGB no disponible: ${result.warnings.join(' ')}`);
    } catch (error) {
      console.error('[FaceSimLab] No se pudo analizar la apariencia', error);
      setStatus(`No se pudo analizar la apariencia: ${error instanceof Error ? error.message : 'error desconocido'}. No se generan resultados ficticios.`);
    } finally { setAnalyzingSkin(false); }
  };
  const correctLandmark = async (index: number, point: P2, references?: readonly number[]) => {
    if (!slot?.landmarks) return;
    const source = slot;
    const requestId = personalRequestRef.current;
    try {
      const triangles = await faceTriangles();
      const landmarks = moveFaceLandmark(source.landmarks!, index, point, aspect, triangles, references);
      if (requestId !== personalRequestRef.current) return;
      if (!landmarks) {
        setStatus('Corrección rechazada: desplaza menos la referencia y evita invertir o comprimir los triángulos. La geometría anterior se conserva.');
        return;
      }
      applyLandmarks(landmarks, triangles);
    } catch (error) {
      setStatus(`No se pudo corregir la referencia: ${error instanceof Error ? error.message : 'error desconocido'}.`);
    }
  };
  const correctPhotoAnchor = (point: P2) => {
    if (photoAnchor === null || !slot?.landmarks) return;
    const references = LANDMARK_ANCHORS[photoAnchor];
    void correctLandmark(references[0], point, references);
  };
  const onMove = (e: React.PointerEvent) => {
    if (workspace !== 'simulate' || preview.after || workMode !== 'foto') return;
    const n = toNorm(e);
    const address = locateAnnotation('foto', { ...n, z: 0 });
    if (!address) {
      if (draft) setDraft(null);
      return;
    }
    if (dragRef.current) {
      const id = dragRef.current;
      setBindings(p => ({ ...p, [id]: { ...p[id], kind: 'point', paths: [[address]] } }));
      setMarkers(p => p.map(m => m.id === id ? { ...m, position: modelPoint(address, genericFaceAtlas),
        normal: surfaceNormal(address, genericFaceAtlas, a => modelPoint(a, genericFaceAtlas)) } : m));
      setStatus('Punto actualizado sobre la foto y transferido al modelo original y a la superficie personal.');
      return;
    }
    setDraft(d => {
      if (!d || d.kind === 'point') return d;
      if (d.kind === 'free') {
        const l = d.pts[d.pts.length - 1];
        return Math.hypot((n.x - l.x) * aspect, n.y - l.y) > 0.008 ? { ...d, pts: [...d.pts, n] } : d;
      }
      return { ...d, pts: [d.pts[0], n] };
    });
  };
  const onUp = () => {
    dragRef.current = null;
    if (workspace !== 'simulate' || preview.after) { setDraft(null); return; }
    if (!draft) return;
    const d = draft; setDraft(null);
    const ok = d.kind === 'point' || (d.pts.length >= 2 && Math.hypot((d.pts[1].x - d.pts[0].x) * aspect, d.pts[1].y - d.pts[0].y) > 0.01);
    if (!ok) return;
    const id = uid(), center = d.pts[0];
    let path = d.pts;
    if (d.kind === 'circle') {
      const end = d.pts[1], radius = Math.hypot((end.x - center.x) * aspect, end.y - center.y);
      path = Array.from({ length: 49 }, (_, i) => ({ x: center.x + Math.cos(i * Math.PI / 24) * radius / aspect, y: center.y + Math.sin(i * Math.PI / 24) * radius }));
    } else if (d.kind === 'rect') {
      const end = d.pts[1];
      path = [center, { x: end.x, y: center.y }, end, { x: center.x, y: end.y }, center];
    }
    const paths = d.kind === 'pattern' ? photoPatternPaths(center, d.pts[1], aspect, photoPattern) : [path];
    const binding = makeBinding(paths.map(points => points.map(p => ({ ...p, z: 0 }))), 'foto', d.kind);
    if (!binding) { blockedMark(); return; }
    if (d.kind === 'circle' || d.kind === 'rect') {
      const c = d.kind === 'rect' ? { x: (center.x + d.pts[1].x) / 2, y: (center.y + d.pts[1].y) / 2 } : center;
      const address = locateAnnotation('foto', { ...c, z: 0 });
      if (!address) { blockedMark(); return; }
      binding.center = address;
    }
    if (!commitBinding(id, binding, 'foto')) return;
    setStatus('Marcación creada desde la foto y compartida con modelo original y superficie personal.');
  };

  const removeEl = (id: string) => {
    setMarkers(p => p.filter(m => m.id !== id)); setLines(p => p.filter(l => l.id !== id)); setShapes(p => p.filter(s => s.id !== id));
    setPhotoEls(p => p.filter(e => e.id !== id)); setMeta(({ [id]: _x, ...rest }) => { void _x; return rest; });
    setBindings(({ [id]: _x, ...rest }) => { void _x; return rest; });
  };
  const editDose = (id: string, v: number) => {
    if (!Number.isFinite(v) || v < 0) return;
    snap();
    if (meta[id]) setMeta(m => ({ ...m, [id]: { ...m[id], dose: v } }));
    else setPhotoEls(p => p.map(e => (e.id === id ? { ...e, dose: v } : e)));
  };

  const changeMode = (m: SimMode) => { setMode(m); setDose(0); setProduct(''); };
  const doImport = () => {
    try {
      const r = importLocalRecord(importText, ZONES);
      const incomingQuick = r.quickRecord?.entries ?? {};
      if (Object.keys(incomingQuick).some(key => Object.prototype.hasOwnProperty.call(quickRecord.entries, key))) {
        setStatus('Importación rechazada completa: ya existen cantidades para ese producto/vial. Exporta el registro actual y limpia o renombra el vial antes de importar. No se sobrescribieron cantidades ni marcas.');
        return;
      }
      const incomingHasAmounts = Object.keys(incomingQuick).length > 0;
      const n = r.markers.length + r.lines.length + r.shapes.length;
      if (!n && !incomingHasAmounts) { setStatus('No se encontraron puntos, trazos, formas ni totales por zona en el JSON.'); return; }
      const importedMarkers = r.markersFull as unknown as Marker3D[];
      const importedLines = r.lines as unknown as FreehandLine[];
      const importedShapes = r.shapes as unknown as SurfaceShape[];
      const mapped: AnatomicalBindings = {};
      const freeImported = new Set<string>();
      const keepMarkers = importedMarkers.filter(m => {
        if (!m.id) return false;
        const binding = makeBinding([[m.position]], 'generico', 'point', true);
        if (binding) mapped[m.id] = binding;
        else if (r.meta[m.id] && isOutsideMask(m.position)) freeImported.add(m.id);
        return !!binding || freeImported.has(m.id);
      });
      const keepLines = importedLines.filter(l => {
        const binding = makeBinding(l.segments?.length ? l.segments : [l.points], 'generico',
          r.kinds[l.id] ?? (l.technique_preset === 'Flecha' ? 'arrow' : l.segments?.length ? 'pattern' : 'free'), true);
        if (binding && r.centers[l.id]) {
          const center = locateSkinAnnotation('generico', r.centers[l.id]);
          if (!center) return false;
          binding.center = center;
        }
        if (binding) mapped[l.id] = binding;
        return !!binding;
      });
      const keepShapes = importedShapes.filter(s => {
        const binding = makeBinding([shapeOutline(s)], 'generico', s.shapeType === 'circle' ? 'circle' : 'rect', true);
        const center = locateSkinAnnotation('generico', s.center);
        if (binding && center) mapped[s.id] = { ...binding, center };
        return !!binding && !!center;
      });
      const accepted = keepMarkers.length + keepLines.length + keepShapes.length;
      if (!accepted && !incomingHasAmounts) { setStatus(`No se trasladaron los ${n} elementos: no corresponden a la superficie facial observada del modelo original. No se modificaron las marcas existentes.`); return; }
      for (const [id, binding] of Object.entries(mapped)) binding.illustrativePlane = r.illustrativePlanes[id] ?? 'skin';
      snap();
      setMarkers(p => [...p, ...keepMarkers]); setLines(p => [...p, ...keepLines]);
      setShapes(p => [...p, ...keepShapes]); setBindings(p => ({ ...p, ...mapped }));
      setMeta(m => ({ ...m, ...Object.fromEntries(Object.entries(r.meta).filter(([id]) => mapped[id] || freeImported.has(id))
        .map(([id, item]) => [id, freeImported.has(id) ? { ...item, zone: EXTENDED_ZONE } : item])) }));
      if (incomingHasAmounts) setQuickRecord(current => ({ ...current, entries: { ...current.entries, ...incomingQuick } }));
      setStatus(`${accepted}/${n} elementos trasladados por correspondencia anatómica. ${n - accepted} sin correspondencia o fuera de cobertura, no importados. ${incomingHasAmounts ? 'Totales por zona conservados sin repartirlos entre marcas. ' : ''}No se modificó la BD.`);
    } catch (error) { setStatus(`No se pudo importar: ${error instanceof Error ? error.message : 'JSON o geometría inválidos'}. Las marcas anteriores se conservan.`); }
  };
  const exportPng = () => {
    const c = glRef.current; if (!c) return;
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `simulacion-referencial-${view}.png`; a.click();
  };
  const exportJson = () => {
    const kinds = Object.fromEntries(Object.entries(bindings).map(([id, binding]) => [id, binding.kind]));
    const centers = Object.fromEntries(Object.entries(bindings).flatMap(([id, binding]) =>
      binding.center ? [[id, modelPoint(binding.center, genericFaceAtlas)]] : []));
    const illustrativePlanes = Object.fromEntries(Object.entries(bindings).map(([id, binding]) => [id, binding.illustrativePlane ?? 'skin']));
    const url = URL.createObjectURL(new Blob([JSON.stringify(localRecord(markers, lines, shapes, meta, kinds, centers, quickRecord, illustrativePlanes), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'marcaciones-inyectables-local.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const beginEditing = () => {
    setPreview(p => p.after ? { ...p, after: false } : p);
    setDraft(null); dragRef.current = null;
    setStatus('Marcación y edición sobre Antes (geometría original). Después es solo inspección: así la posición visible coincide con el registro común.');
  };
  const comparePreview = (after: boolean) => {
    setPreview(p => ({ ...p, after })); setDraft(null); dragRef.current = null;
    if (after) {
      setTool3d('navigate'); setPhotoInteraction('select');
      setStatus('Después · solo cámara/inspección. Elige una herramienta de dibujo o edición para volver a Antes sin alterar dosis ni posiciones registradas.');
    }
  };

  const color = SIM_MODES[mode].color;
  const photoEls2 = photoEls.filter(e => e.view === view);
  void photoEls2;
  const arrowHead = (path: P2[]) => {
    const b = path[path.length - 1], a = path[Math.max(0, path.length - 2)];
    const dx = (b.x - a.x) * aspect, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n, L = 0.03;
    const pt = (ang: number): P2 => ({ x: b.x - (ux * Math.cos(ang) - uy * Math.sin(ang)) * L / aspect, y: b.y - (uy * Math.cos(ang) + ux * Math.sin(ang)) * L });
    return [pt(0.5), pt(-0.5)];
  };
  const poly = (pts: P2[]) => pts.map(p => `${p.x},${p.y}`).join(' ');
  const draftEl: Elem | null = draft ? draft.kind === 'pattern' && draft.pts.length > 1
    ? { ...curMeta(), id: 'draft', kind: 'pattern', paths: photoPatternPaths(draft.pts[0], draft.pts[1], aspect, photoPattern) }
    : elemsFromPhoto([{ ...curMeta(), id: 'draft', view, kind: draft.kind, pts: draft.pts }], aspect)[0] : null;

  const freeMarkerIds = useMemo(() => markers.flatMap(m => m.id && !bindings[m.id] ? [m.id] : []), [markers, bindings]);
  const rows = useMemo(() => ledgerRows(meta, bindings, freeMarkerIds), [meta, bindings, freeMarkerIds]);
  const totals = useMemo(() => volumeTotals(rows), [rows]);
  const clipping = cut.scope === 'none' ? null : { ...cut, scope: cut.scope };
  const editableBySource = useMemo(() => {
    const build = (original: boolean) => [...(original ? genericAnnotations : personalAnnotations).markers,
      ...(original ? markers.filter(m => m.id && !bindings[m.id]) : [])]
      .flatMap(marker => marker.id ? [{ id: marker.id, type: 'free' as const, ...marker.position, lineIds: [],
        name: meta[marker.id]?.zone, color: meta[marker.id] ? SIM_MODES[meta[marker.id].mode].color : undefined }] : []);
    return { generico: build(true), personal: build(false) };
  }, [genericAnnotations, personalAnnotations, markers, bindings, meta]);
  const highlightedIds = useMemo(() => selectedId ? [selectedId] : [], [selectedId]);
  const selectedRow = selectedId ? rows.find(r => r.id === selectedId) : undefined;

  const renderViewer = (source: 'generico' | 'personal') => {
    const original = source === 'generico';
    const annotations = original ? genericAnnotations : personalAnnotations;
    // Visor dividido: SIEMPRE la cabeza GLB completa sin deformar como referencia.
    // Vista única: Antes = cabeza completa; Después/calibración = cara del atlas deformable.
    const splitHead = original && splitAnnotations && workspace === 'simulate' && !calibrating;
    const fullHead = splitHead || original && workspace === 'simulate' && !calibrating && !preview.after;
    const ready = fullHead || (original ? !!genericPreviewGlb && (calibrating || genericPreviewAfter === preview.after) : !!personal);
    return <section key={source} aria-label={original ? 'Modelo genérico 3D' : 'Foto personal en 3D'}
      onPointerDownCapture={() => { if (splitAnnotations) setModelKind(source); }}
      onFocusCapture={() => { if (splitAnnotations) setModelKind(source); }}
      className="relative min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-[0_0_40px_-20px_rgba(34,211,238,0.6)]">
      <h2 className="flex items-center gap-2 px-3 py-2.5 text-xs font-bold uppercase tracking-[0.16em] text-slate-200">
        {original ? <Box className="h-4 w-4 text-cyan-300" aria-hidden="true" /> : <UserRound className="h-4 w-4 text-fuchsia-300" aria-hidden="true" />}
        <span className="flex-1">{original ? fullHead ? 'Cabeza completa · genérico' : 'Atlas facial · genérico' : 'Máscara del paciente'}</span>
        {!original && freeMarkerIds.length > 0 && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-300"
          title="Marcas de zona extendida: solo en el modelo completo">{freeMarkerIds.length} fuera de máscara</span>}
      </h2>
      {overlayMode === 'attention' && <p className="bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-950">SIMULACIÓN · No detecta vasos ni certifica zonas seguras.</p>}
      {ready ? <Clinical3DViewer
        key={`${source}-${preview.after && !calibrating && !splitHead ? 'after' : 'before'}-${splitHead ? 'split' : fullHead ? 'head' : 'atlas'}`}
        markers={[]} freehandLines={annotations.lines} surfaceShapes={[]}
        editablePoints={editableBySource[source]}
        pointMode="none" selectedPointId={selectedId ?? undefined}
        onEditablePointClicked={id => { setSelectedId(id); beginEditing(); }}
        onEditablePointMoved={(id, point) => {
          if (original && !bindings[id] && markers.some(m => m.id === id)) {
            if (!isOutsideMask(point)) { blockedMark(); return; }
            snap(); setMarkers(current => current.map(m => m.id === id ? { ...m, position: point } : m));
            return;
          }
          const binding = makeBinding([[point]], source, 'point');
          if (!binding) { blockedMark(); return; }
          binding.illustrativePlane = bindings[id]?.illustrativePlane;
          if (commitBinding(id, binding, source, true)) setStatus('Punto movido. Mismo registro, sin duplicados.');
        }}
        selectedPathology="filler" skipConfirmation readOnly={workMode !== '3d' || tool3d === 'navigate' || preview.after && !calibrating || workspace !== 'simulate' && !calibrating}
        occludeAnnotations={!anatomyDisplay.overlay && anatomyDisplay.skin.visible && anatomyDisplay.skin.opacity >= 0.99
          && (!original || anatomyDisplay.anatomy !== 'skin')} showMarkerLabels={false}
        anatomicalOverlay={original ? annotationOverlays.generic : annotationOverlays.personal}
        clipping={workspace === 'simulate' ? clipping : null}
        surfaceConstraint={workMode === '3d' && tool3d !== 'navigate' ? {
          accepts: p => !!locateAnnotation(source, p) || original && extendedZone && tool3d === 'point' && isOutsideMask(p),
          onRejected: () => { blockedMark(); if (original && !extendedZone && tool3d === 'point') setOutsideHint(true); },
        } : undefined}
        onEstimatedSurfaceInteraction={blockedMark}
        selectedElementId={selectedId}
        onElementSelected={id => { setSelectedId(id); if (id) beginEditing(); }}
        highlightedPointIds={highlightedIds}
        onMarkerPlaced={(m: Marker3D) => onMarker(m, source)}
        activeTool={workspace !== 'simulate' || preview.after || workMode !== '3d' || tool3d === 'navigate' || tool3d === 'select' || tool3d === 'point' ? 'none' : tool3d}
        pendingBrushColor={color} pendingBrushThickness={1.5}
        onFreehandLineComplete={l => onLine(l, source)}
        onShapeComplete={s => onShape(s, source)}
        onFreehandLineUpdated={(id, points, segments) => {
          const current = annotations.lines.find(l => l.id === id);
          if (current) onLine({ ...current, points, segments }, source, true);
        }}
        haShapeConfig={HA_CONFIG} cameraPreset={splitHead ? 'default' : fullHead ? 'face' : 'face-surface'}
        modelData={original ? fullHead ? null : genericPreviewGlb : personal ? preview.after && appearanceGlb?.personal === personal ? appearanceGlb.buffer : personal.glb : null}
        pointMarkerScale={0.55} height={VIEWER_HEIGHT}
        interactionHint={tool3d === 'navigate' || workMode === 'foto' ? 'Arrastra para rotar'
          : calibrating && original ? `Referencia ${anchorName(slot?.modelAnchors?.length ?? 0)}`
            : extendedZone && original ? 'Rostro + zona extendida' : 'Solo rostro observado'}
      /> : <div role="status" className="flex min-h-[340px] items-center justify-center px-6 text-center text-sm text-slate-300">{original
        ? 'Preparando geometría del atlas…' : buildingPersonal ? 'Calculando máscara personal…' : 'Prepara la máscara desde una foto en Capturas.'}</div>}
      {original && outsideHint && !extendedZone && <div role="alert" className="absolute inset-x-3 bottom-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/40       bg-slate-950/95 p-2 text-xs text-amber-100 backdrop-blur">
        <span className="flex-1">Fuera de la máscara facial (cuello, cuero cabelludo, orejas).</span>
        <button type="button" onClick={() => { setExtendedZone(true); setOutsideHint(false); }}
          className="admin-focus-ring min-h-9 rounded-lg bg-amber-400 px-3 font-bold text-slate-950">Activar zona extendida</button>
        <button type="button" aria-label="Cerrar aviso" onClick={() => setOutsideHint(false)} className="admin-focus-ring min-h-9 rounded-lg px-2 text-amber-200">✕</button>
      </div>}
    </section>;
  };

  const renderShapes = (list: Elem[], dashed = false) => list.filter(e => e.kind !== 'point').map(e => {
    const col = selectedId === e.id ? '#fbbf24' : SIM_MODES[e.mode].color, common = { stroke: col, strokeWidth: selectedId === e.id ? 3 : 2, fill: 'none', vectorEffect: 'non-scaling-stroke' as const, strokeDasharray: dashed ? '5 4' : undefined };
    if (e.boundary) return <polygon key={e.id} points={poly(e.boundary)} {...common} fill={col} fillOpacity={0.15} />;
    if (e.kind === 'circle') return <ellipse key={e.id} cx={e.paths[0][0].x} cy={e.paths[0][0].y} rx={e.rx} ry={e.ry} {...common} fill={col} fillOpacity={0.15} />;
    if (e.kind === 'rect') return <rect key={e.id} x={e.paths[0][0].x - (e.rx ?? 0)} y={e.paths[0][0].y - (e.ry ?? 0)} width={(e.rx ?? 0) * 2} height={(e.ry ?? 0) * 2} {...common} fill={col} fillOpacity={0.15} />;
    return (
      <g key={e.id}>
        {e.paths.map((p, i) => <polyline key={i} points={poly(p)} {...common} />)}
        {e.kind === 'arrow' && e.paths[0].length >= 2 && arrowHead(e.paths[0]).map((h, i) => <line key={i} x1={e.paths[0].at(-1)!.x} y1={e.paths[0].at(-1)!.y} x2={h.x} y2={h.y} {...common} />)}
      </g>
    );
  });
  const photoUsesPreview = (!preview.after || workspace === 'capture') && !!slot?.previewUrl;
  const photoSkinOpacity = workspace === 'simulate' ? anatomyDisplay.skin.visible ? anatomyDisplay.skin.opacity : 0 : 1;
  const photoLayerOverlay = workspace === 'simulate' ? photoLayerImages.map(({ kind, url }) => anatomyDisplay.references[kind].visible && <img
    key={kind} src={url} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full"
    style={{ opacity: anatomyDisplay.references[kind].opacity }} />) : null;

  const photoInput = (v: (typeof PHOTO_SLOTS)[number]) => (
    <div key={v.id} className="min-w-0">
      <label className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center text-[11px] font-semibold focus-within:ring-2 focus-within:ring-amber-400 ${view === v.id ? 'border-[#b8944d] bg-amber-50' : 'border-slate-200'} ${photos[v.id] ? 'text-slate-800' : 'text-slate-500'}`}>
        <ImagePlus className="h-4 w-4" aria-hidden="true" />
        {v.label}{pendingPhotos[v.id] ? ' …' : photos[v.id]?.landmarks ? ' ✓' : photos[v.id] ? ' !' : ''}
        <input type="file" accept="image/*" aria-label={`Cargar ${v.label}`} className="sr-only"
          onChange={e => { const f = e.target.files?.[0]; if (f) void loadFile(f, v.id); e.target.value = ''; }} />
      </label>
      {(photos[v.id] || pendingPhotos[v.id]) && (
        <button type="button" onClick={() => removePhoto(v.id)} aria-label={`Retirar ${v.label}`}
          className="mt-1 flex w-full items-center justify-center gap-1 rounded px-1 py-1 text-[10px] text-slate-500 hover:bg-slate-100">
          <Trash2 className="h-3 w-3" aria-hidden="true" />Retirar
        </button>
      )}
      {photos[v.id]?.detectionError && <p className="mt-1 break-words text-[10px] text-amber-800">{photos[v.id]?.detectionError}</p>}
      {photos[v.id]?.previewUrl && <img src={photos[v.id]?.previewUrl} alt={`Revisar captura ${v.label}`} className="mt-1 h-20 w-full rounded object-contain bg-slate-100" />}
      {photos[v.id]?.landmarks && <label className="mt-2 flex items-start gap-1 text-[10px] text-slate-700">
        <input type="checkbox" aria-label={`Confirmar captura ${v.label}`} checked={!!photos[v.id]?.captureConfirmed} onChange={e => {
          const checked = e.target.checked;
          personalRequestRef.current++; setBuildingPersonal(false); setPersonal(null); setModelKind('generico');
          setPhotos(p => p[v.id] ? { ...p, [v.id]: { ...p[v.id]!, captureConfirmed: checked } } : p);
          setStatus('Revisión de captura actualizada. Recalcula la superficie; las marcaciones se conservan. Esta confirmación no verifica identidad automáticamente.');
        }} />
        Captura y persona confirmadas.
      </label>}
      {photos[v.id]?.captureWarnings?.map(w => <p key={w} className="mt-1 text-[10px] text-amber-800">{w}</p>)}
    </div>
  );

  return (
    <div className={`grid min-w-0 gap-4 ${workspace === 'simulate' && editorGroup === 'annotations'
      ? 'lg:grid-cols-[264px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)_300px]' : 'lg:grid-cols-[260px_minmax(0,1fr)]'}`}>
      <header className="col-span-full space-y-2">
        <nav aria-label="Espacios del laboratorio" className="flex flex-wrap gap-2">
          {([['capture', 'Capturas'], ['simulate', 'Simular y marcar']] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={workspace === id} onClick={() => {
              setWorkspace(id); setDraft(null); dragRef.current = null;
              setCalibrating(false); setPhotoAnchor(null); setContourIndex(null); setPickingForehead(false);
              if (id === 'simulate') setMeshVisible(false);
            }} className={`admin-focus-ring min-h-11 rounded-lg px-4 text-sm font-semibold ${workspace === id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}>{label}</button>)}
        </nav>
        {workspace === 'simulate' && <nav aria-label="Grupos del editor" className="flex flex-wrap gap-2">
          {([['annotations', 'Marcaciones e inyectables'], ['appearance', 'Morfología, piel y capas']] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={editorGroup === id} onClick={() => {
              setEditorGroup(id); if (id === 'appearance') setAppearanceOpened(true);
              setDraft(null); dragRef.current = null;
            }} className="admin-focus-ring min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-semibold aria-pressed:border-sky-700 aria-pressed:bg-sky-50 aria-pressed:text-sky-900">{label}</button>)}
        </nav>}
        <p className="text-sm text-slate-600">{workspace === 'capture'
          ? 'Carga y revisa fotos o calibra la superficie. Aquí no se registran tratamientos.'
          : 'Elige una superficie y una herramienta. El registro es común; la dosis no controla el efecto visual.'}</p>
        <p className="text-xs text-slate-600" role="status">{status}</p>
      </header>
      {reviewId && reviewSlot?.landmarks && <Suspense fallback={<p role="status">Abriendo revisión de límites…</p>}>
        <FaceBoundaryReview key={`${reviewId}-${reviewSlot.previewUrl?.length}`} canvas={reviewSlot.canvas} landmarks={reviewSlot.landmarks}
          title={PHOTO_SLOTS.find(v => v.id === reviewId)?.label} reference={reviewReference}
          triangles={genericFaceAtlas.triangles} onClose={() => setBoundaryReview(queue => queue.filter(id => id !== reviewId))}
          onApply={(landmarks, reviewed, point) => {
            applyLandmarks(landmarks, [...genericFaceAtlas.triangles], reviewSlot.contourAdjusted, reviewed, reviewId);
            if (point) rememberForehead(reviewId, reviewSlot, point);
          }} />
      </Suspense>}
      {(workspace === 'capture' || editorGroup === 'annotations') && <aside aria-label={workspace === 'capture' ? 'Revisión de capturas' : 'Herramientas de marcación'} className={`min-w-0 space-y-4 rounded-2xl border p-3 shadow-sm lg:self-start ${workspace === 'simulate' ? `${editorPanel} lg:sticky lg:top-4` : 'border-slate-200 bg-white'}`}>
        {workspace === 'simulate' && <div className="flex min-h-0 flex-col gap-3 lg:max-h-[calc(100dvh-7rem)]">
          <EditorTabs idBase="marcacion" value={markTab} onChange={setMarkTab} tabs={[
            { id: 'inyectable', label: 'Inyectable', step: 1, icon: Syringe, done: !!product.trim() },
            { id: 'capas', label: 'Capas y corte', step: 2, icon: Layers, done: rows.length > 0 },
            { id: 'revisar', label: 'Revisar', step: 3, icon: ListChecks },
          ]} />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 [scrollbar-color:rgba(222,184,135,.35)_transparent] [scrollbar-width:thin]">
            <div role="tabpanel" id="marcacion-panel-inyectable" aria-labelledby="marcacion-tab-inyectable" hidden={markTab !== 'inyectable'} className="space-y-3">
              <PanelSection title="Tipo" icon={Syringe}><ModeCards value={mode} onChange={changeMode} /></PanelSection>
              <PanelSection title="Producto y volumen" icon={Gauge}>
                <label className="block text-[11px] font-semibold text-stone-400">Producto / vial
                  <input list="face-annotation-products" value={product} onChange={e => setProduct(e.target.value)} placeholder="Ej. nombre comercial"
                    className="admin-focus-ring mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-stone-900 px-2 text-sm text-stone-100 placeholder:text-stone-500" />
                </label>
                <CheckChip label="Pedir volumen al marcar" icon={Gauge} checked={askVolume} onChange={setAskVolume}>Volumen al marcar</CheckChip>
                {!askVolume && <label className="flex items-center gap-2 text-[11px] text-stone-400">Dosis fija
                  <input aria-label="Dosis para nuevas marcas" type="number" min={0} step="any" value={dose}
                    onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0) setDose(n); }}
                    className="admin-focus-ring min-h-10 w-24 rounded-lg border border-white/10 bg-stone-900 px-2 text-sm text-stone-100" />{SIM_MODES[mode].unit}
                </label>}
              </PanelSection>
              <p className="rounded-xl border border-gold/20 bg-gold/5 p-2.5 text-[11px] leading-relaxed text-stone-300">
                Elige una herramienta en la barra <b className="text-gold">Marcar</b> sobre el visor y haz clic en el rostro. Cada punto pide su volumen.
              </p>
            </div>
            <div role="tabpanel" id="marcacion-panel-capas" aria-labelledby="marcacion-tab-capas" hidden={markTab !== 'capas'} className="space-y-3">
              <PanelSection title="Capa anatómica" icon={Layers}>
                <AnatomyLayerControls value={anatomyDisplay} onChange={value => {
                  setAnatomyDisplay(value); setHoveredZone(null); setDraft(null);
                }} showMesh={showRegions} onMeshChange={toggleMesh} />
                {(layerError || annotationLayers.error) ? <div role="alert" className="flex items-center gap-2 text-xs text-rose-300">
                  <span className="flex-1">{layerError ?? annotationLayers.error}</span>
                  <button type="button" onClick={() => setLayerAttempt(n => n + 1)} className="admin-focus-ring min-h-10 rounded-lg border border-rose-400/40 px-2 font-semibold">Reintentar capas</button>
                </div> : !defaultLayers.length && <p role="status" className="text-xs text-stone-400">Cargando capas anatómicas…</p>}
                {!layerIsVisible && <p role="status" className="text-xs font-semibold text-amber-300">Capa activa oculta: muéstrala para marcar.</p>}
              </PanelSection>
              {workMode === '3d' && <PanelSection title="Corte" icon={Scissors}
                aside={cut.scope !== 'none' && <span className="rounded-full bg-gold/20 px-2 text-[10px] normal-case tracking-normal text-gold">activo</span>}>
                <CutControls value={cut} onChange={setCut} />
              </PanelSection>}
              <PanelSection title={`Zona ${zone === AUTO_ZONE ? 'automática' : 'manual'}`} icon={Crosshair}>
                <select aria-label="Zona" value={zone} onChange={e => setZone(e.target.value)}
                  className="admin-focus-ring min-h-10 w-full rounded-lg border border-white/10 bg-stone-900 px-2 text-xs text-stone-100">
                  <option value={AUTO_ZONE}>Auto (mapa anatómico facial)</option>
                  {ZONES.map(z => <option key={z}>{z}</option>)}
                </select>
              </PanelSection>
            </div>
            <div role="tabpanel" id="marcacion-panel-revisar" aria-labelledby="marcacion-tab-revisar" hidden={markTab !== 'revisar'} className="space-y-3">
              <PanelSection title="Antes / después" icon={Eye}>
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/40 p-1">{([false, true] as const).map(after => <button key={String(after)} type="button" aria-pressed={preview.after === after}
                  onClick={() => comparePreview(after)} className="admin-focus-ring min-h-9 rounded-lg text-xs font-bold text-stone-400 aria-pressed:bg-stone-800 aria-pressed:text-gold">{after ? 'Después' : 'Antes'}</button>)}</div>
                {workMode === 'foto' && <label className="flex items-center gap-2 text-[11px] text-stone-400"><Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <input aria-label="Comparación dividida · solo foto" type="range" min={0} max={1} step={0.01} value={split} onChange={e => setSplit(Number(e.target.value))} className="flex-1 accent-gold" />
                </label>}
                <p className="text-[11px] leading-relaxed text-stone-500">Los filtros se aplican sobre la máscara personal y la foto en «Después». Marcar se pausa mientras lo ves.</p>
              </PanelSection>
              <PanelSection title="Filtros por inyectable" icon={Sparkles}><EffectMixer value={preview} onChange={setPreview} /></PanelSection>
              <PanelSection title="Exportar" icon={FileJson}>
                <div className="grid grid-cols-3 gap-1.5">
                  <IconToggle label="Exportar JSON de Inyectables" icon={FileJson} disabled={!hasLocalRecord} onClick={exportJson}>JSON</IconToggle>
                  <IconToggle label="PNG" icon={Download} disabled={!hasImage} onClick={exportPng}>PNG</IconToggle>
                  <IconToggle label="Limpiar" icon={Trash2} disabled={!hasQuickEntries && !elems.length && !markers.length && !lines.length && !shapes.length} onClick={clearAll}>Limpiar</IconToggle>
                </div>
                <details className="rounded-xl border border-white/10 bg-black/30 p-2 text-xs">
                  <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 font-bold text-stone-300"><FileJson className="h-4 w-4 text-gold" aria-hidden="true" />Importar de Inyectables</summary>
                  <textarea aria-label="JSON de Inyectables" value={importText} onChange={e => setImportText(e.target.value)} rows={4}
                    className="admin-focus-ring mt-2 w-full rounded-lg border border-white/10 bg-stone-900 p-2 font-mono text-[10px] text-stone-100" />
                  <button type="button" onClick={doImport} className="admin-focus-ring mt-2 min-h-10 w-full rounded-lg bg-gold font-bold text-stone-950">Importar</button>
                </details>
                {workMode === 'foto' && <CheckChip label="Mostrar marcas sobre la foto" icon={Eye} checked={showMarks} onChange={setShowMarks}>Marcas en foto</CheckChip>}
              </PanelSection>
            </div>
          </div>
          <p className="text-[10px] leading-relaxed text-stone-500" title={PREVIEW_DESCRIPTIONS[mode]}>Simulación ilustrativa · no recomienda puntos ni dosis · exporta antes de salir.</p>
        </div>}
        {workspace === 'capture' && <>
        <div>
          <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">Fotos del paciente</span>
          <div className="grid grid-cols-3 gap-1">
            {VIEWS.map(photoInput)}
          </div>
          <div className="mt-1 grid grid-cols-3 gap-1">
            {VIEWS.map(v => <button key={v.id} type="button" disabled={!photos[v.id]} aria-pressed={view === v.id} onClick={() => { personalRequestRef.current++; setBuildingPersonal(false); setCalibrating(false); setPhotoAnchor(null); setContourIndex(null); setPickingForehead(false); setView(v.id); }}
              className={`rounded px-1 py-1 text-[11px] ${view === v.id ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-40`}>Ver</button>)}
          </div>
          <details className="mt-2 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold">Añadir fotos 4 y 5 (opcional)</summary>
            <div className="mt-2 grid grid-cols-2 gap-1">{PHOTO_SLOTS.slice(3).map(photoInput)}</div>
          </details>
          <p className="mt-2 text-xs text-slate-600" aria-live="polite">
            {loadedPhotos.length} de 5 fotos cargadas · {readyPhotos.length} con rostro detectado{hasPendingPhotos ? ' · Detectando…' : ''}
          </p>
          <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">Guía de captura y privacidad</summary><p className="mt-1">
            1: cálculo rápido. 2: contrasta profundidad de nariz y labios. 3: recomendado para cubrir ambos lados.
            Las fotos 4 y 5 añaden referencias. Usa la misma persona; se compensan diferencias de giro, altura y encuadre.
            Ángulos A/B son orientativos: no necesitan ser perfiles exactos.
          </p>
          <p className="mt-2">Una detección facial no prueba que sea una captura directa ni la misma persona. Excluye documentos, memes, otras personas y filtros deformantes. Revisa las miniaturas: los controles geométricos no detectan todos esos casos ni verifican identidad.</p></details>
          {unreviewedPhotos.length > 0 && <p className="mt-2 text-xs font-semibold text-amber-800">Confirma {unreviewedPhotos.length} captura(s) pendiente(s) antes del cálculo.</p>}
          {incompatiblePhotos.map(message => <p key={message} role="alert" className="mt-2 text-xs font-semibold text-red-800">{message}</p>)}
          {photoChecks.warnings.map(message => <p key={message} role="status" className="mt-2 text-xs font-semibold text-amber-800">{message}</p>)}
          <button type="button" disabled={buildingPersonal || hasPendingPhotos || captureBlocked || !captureSource}
            onClick={() => {
              if (!captureSource) { setStatus('Carga al menos una foto principal con el rostro detectado para calcular la superficie.'); return; }
              const sourceView = captureSource;
              setView(sourceView); setWorkMode('3d'); setPhotoAnchor(null); setContourIndex(null);
              void buildPersonal(depth, sourceView);
            }}
            className="mt-2 w-full rounded-lg bg-slate-800 px-2 py-2 text-xs font-semibold text-white disabled:opacity-40">
            {buildingPersonal ? 'Calculando…' : `Calcular superficie con ${readyPhotos.length} foto(s)`}
          </button>
        </div>
        {slot?.landmarks && <button type="button" onClick={() => setBoundaryReview(queue => [view, ...queue.filter(id => id !== view)])}
          className="admin-focus-ring w-full rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold">Revisar frente, sienes y mentón</button>}
        {slot?.landmarks && <details className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
          <summary className="cursor-pointer font-semibold">Frente y línea del cabello · revisar cobertura</summary>
          <p>{slot.foreheadReviewed ? 'Límite superior revisado manualmente.' : 'Se propone el nacimiento del cabello como fin de la piel visible; confírmalo en «Revisar frente». No presupongas que toda la frente está reconstruida.'}</p>
          {foreheadReference && <p>Altura de referencia confirmada en {PHOTO_SLOTS.find(v => v.id === foreheadReference.slot)?.label}; se ofrece en las demás vistas cuando su borde no es claro.</p>}
          <p>Amplía solo sobre piel realmente visible. Si el cabello o el encuadre la ocultan, usa otra captura con la frente descubierta; el modelo no puede certificar esa zona ni un plano de tratamiento.</p>
          <button type="button" disabled={buildingPersonal || hasPendingPhotos} onClick={suggestForehead} className="rounded border border-amber-400 px-2 py-1">Proponer borde visible</button>
          <button type="button" disabled={buildingPersonal || hasPendingPhotos} aria-pressed={pickingForehead} onClick={() => {
            setPickingForehead(p => !p); setWorkMode('foto'); setPhotoAnchor(null); setContourIndex(null); setCalibrating(false); setDraft(null);
            setStatus('Selecciona en la foto el centro del límite superior de piel visible, justo antes del cabello o borde visible. Este clic no añade un tratamiento.');
          }} className="ml-1 rounded border border-amber-400 px-2 py-1">Elegir límite en foto</button>
          {currentForeheadPreview && <div className="space-y-2">
            <p>{currentForeheadPreview.reason}</p>
            <label className="flex items-start gap-2"><input type="checkbox" checked={currentForeheadPreview.confirmed} aria-label="Confirmar piel visible en frente"
              onChange={e => { const checked = e.target.checked; setForeheadPreview(p => p?.canvas === slot.canvas ? { ...p, confirmed: checked } : p); }} />
              Confirmo que el límite incluye solo piel visible y no cabello, fondo o anatomía oculta.
            </label>
            <button type="button" disabled={!currentForeheadPreview.confirmed || buildingPersonal || hasPendingPhotos} onClick={() => void confirmForehead()} className="rounded bg-slate-800 px-2 py-1 text-white disabled:opacity-40">Aplicar frente revisada</button>
          </div>}
        </details>}
        <details className="space-y-2 rounded-xl border border-slate-200 p-3 text-xs">
          <summary className="cursor-pointer font-semibold">Apariencia de piel RGB · experimental</summary>
          <Tooltip content="Contraste, rojez y microtextura visibles; no confirma lesiones, poros individuales ni vasos internos. Usa luz blanca uniforme, sin filtros; RGB no sustituye UV o polarización."><button type="button" className="admin-focus-ring rounded border px-2 py-1">Alcance de los filtros</button></Tooltip>
          <label className="block">Área de análisis
            <select value={skinRegion} disabled={analyzingSkin} onChange={e => {
              const next = e.target.value;
              if (next === 'all' || next === 'tzone' || next === 'cheeks') { setSkinRegion(next); setSkinReview(null); }
            }} className="admin-focus-ring mt-1 w-full rounded border px-2 py-1">
              <option value="all">Piel visible</option><option value="tzone">Zona T · región geométrica</option><option value="cheeks">Mejillas y pómulos</option>
            </select>
          </label>
          <button type="button" disabled={!slot?.landmarks || !slot.captureConfirmed || analyzingSkin} onClick={() => void analyzeAppearance()} className="rounded bg-slate-800 px-2 py-1 text-white disabled:opacity-40">{analyzingSkin ? 'Analizando…' : 'Analizar apariencia localmente'}</button>
          <label className="block">Capa de apariencia
            <select aria-label="Capa de apariencia" value={skinChannel} onChange={e => {
              const v = e.target.value;
              if (v === 'contrast' || v === 'redness' || v === 'texture' || v === 'shine') setSkinChannel(v);
            }} className="mt-1 w-full rounded border border-slate-300 px-2 py-1">
              <option value="contrast">Manchas · contraste cromático</option><option value="redness">Rojez relativa</option><option value="texture">Textura · detalle superficial</option><option value="shine">Brillo aparente</option>
            </select>
          </label>
          <label className="block">Intensidad de capa: {Math.round(skinOpacity * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={skinOpacity} onChange={e => setSkinOpacity(Number(e.target.value))} className="w-full accent-sky-600" />
          </label>
          {currentSkinReview && <>
            <details><summary className="cursor-pointer">Condiciones y límites</summary>{currentSkinReview.result.warnings.map(w => <p key={w} className="mt-1 text-amber-800">{w}</p>)}</details>
            {currentSkinReview.result.usable && <p role="status">{currentSkinReview.result.channels[skinChannel].status === 'no-signal'
              ? 'Sin señal destacada en este canal; no implica ausencia de alteraciones.'
              : currentSkinReview.result.channels[skinChannel].status === 'unavailable' ? 'Canal no disponible: revisa iluminación y cobertura.'
                : `${currentSkinReview.result.channels[skinChannel].coverage * 100 < 0.01 ? '<0,01' : (currentSkinReview.result.channels[skinChannel].coverage * 100).toFixed(2)}% del área analizada resaltada; no es severidad.`}</p>}
            <button type="button" onClick={() => setSkinReview(null)} className="rounded border border-slate-300 px-2 py-1">Quitar análisis de apariencia</button>
          </>}
        </details>
        <fieldset className="space-y-2 rounded-xl border border-slate-200 p-3 text-xs">
          <legend className="px-1 font-semibold text-slate-600">Correspondencia anatómica</legend>
          <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={showRegions} onChange={e => toggleMesh(e.target.checked)} />Mostrar mallado de zonas</label>
          <label className="block">Plano visual
            <select aria-label="Plano visual" value={regionPlane} onChange={e => setRegionPlane(e.target.value as RegionPlane)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1">
              {REGION_PLANES.map(plane => <option key={plane.id} value={plane.id}>{plane.label}</option>)}
            </select>
          </label>
          <p className="text-slate-500">Planos genéricos de simulación; no profundidades medidas ni planos de inyección.</p>
          <p>Un registro común · {Object.keys(bindings).length} elementos. Cambiar foto/modelo, superficie o relieve no borra las marcas.</p>
          <label className="block">Capa de referencia
            <select aria-label="Capa de referencia" value={overlayMode} onChange={e => {
              const value = e.target.value;
              if (value === 'none' || value === 'regions' || value === 'attention') setOverlayMode(value);
            }} className="mt-1 w-full rounded border border-slate-300 px-2 py-1">
              <option value="none">Sin capa</option>
              <option value="regions">Malla y zonas anatómicas</option>
              <option value="attention">Referencias anatómicas · simulación</option>
            </select>
          </label>
          {overlayMode === 'regions' && <details>
            <summary className="cursor-pointer font-semibold">Leyenda de zonas · límites aproximados</summary>
            <ul className="mt-2 grid grid-cols-2 gap-1">
              {FACE_REGION_SEEDS.map(entry => <li key={entry.zone}><button type="button" onPointerEnter={() => setHoveredZone(entry.zone)} onPointerLeave={() => setHoveredZone(null)}
                onFocus={() => setHoveredZone(entry.zone)} onBlur={() => setHoveredZone(null)} onClick={() => setHoveredZone(entry.zone)}
                className="admin-focus-ring flex items-center gap-1 rounded px-1 text-left"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: faceRegionColor(entry.zone) }} />{entry.zone}</button></li>)}
            </ul>
            <p className="mt-1">Pasa el cursor por la malla para resaltar una zona. Límites aproximados.</p>
          </details>}
          <p>Ida y vuelta modelo → foto → modelo: {transferStats.count} muestras · error máximo {Number.isFinite(transferStats.max) ? `${transferStats.max.toExponential(2)}% del alto del modelo` : 'no verificable; revisar referencias'}.</p>
          <p className="text-slate-500">Mide consistencia matemática, no precisión anatómica ni clínica. La detección del labio y los contornos debe revisarse visualmente.</p>
          {Object.keys(bindings).length > Object.keys(photoBindings).length && <p className="font-semibold text-amber-800">{Object.keys(bindings).length - Object.keys(photoBindings).length} elementos sin cobertura válida en esta foto: se conservan en el modelo, pero no se proyectan.</p>}
        </fieldset>
        {overlayMode === 'attention' && <section aria-label="Referencia anatómica de simulación" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <h3 className="font-semibold">Referencia de simulación, no detección vascular</h3>
          <p>Ámbar: regiones seleccionadas para estudio. Gris: resto del rostro, NO zonas seguras. Estos colores no representan un nivel de riesgo ni la posición de un vaso.</p>
          <p>La foto y el relieve no localizan arterias, venas, nervios ni su profundidad. La anatomía cambia entre personas; el atlas no sustituye evaluación profesional ni estudios de imagen cuando estén indicados.</p>
          <details>
            <summary className="cursor-pointer font-semibold">Estructuras de referencia por región</summary>
            <ul className="mt-2 space-y-2">
              {FACE_REGION_EDUCATION.map(entry => <li key={entry.zones[0]}><strong>{entry.zones.join(' / ')}:</strong> {entry.structures}</li>)}
            </ul>
          </details>
          <p>No se calculan distancias a vasos, «zonas de confort», puntos ideales, planos de inyección ni dosis recomendadas.</p>
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC9067448/" target="_blank" rel="noopener noreferrer" className="underline">Fuente: anatomía arterial individual mediante angiografía y validación ecográfica (2022)</a>
        </section>}

        {slot?.landmarks && <details className="rounded-xl border border-slate-200 p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-slate-700">Editar contorno · mentón y sienes</summary>
          <p className="mt-2 text-slate-600">El borde detectado puede quedar dentro de la piel. Se han ajustado {slot.contourAdjusted ?? 0} referencias por contraste local. Si falta mentón o sien, selecciona un punto y haz clic en el borde real. Se modifica también la malla, no solo el dibujo.</p>
          <label className="mt-2 block">Punto del contorno
            <select aria-label="Punto del contorno" value={contourIndex ?? ''} disabled={buildingPersonal || hasPendingPhotos}
              onChange={e => {
                const index = e.target.value === '' ? null : Number(e.target.value);
                setContourIndex(index); setPhotoAnchor(null); setCalibrating(false); setDraft(null);
                dragRef.current = null;
                if (index !== null) { setWorkMode('foto'); setStatus('Haz clic sobre el límite real de la piel o ajusta sus coordenadas. Este clic no añade un tratamiento.'); }
              }} className="mt-1 w-full rounded border border-slate-300 px-2 py-1">
              <option value="">Seleccionar punto…</option>
              {FACE_OVAL.map((index, i) => <option key={index} value={index}>{i + 1}. {index === 152 ? 'Centro del mentón' : i > 12 && i < 24 ? 'Mandíbula / mentón' : i > 4 && i < 10 || i > 26 && i < 32 ? 'Sien / mejilla' : 'Frente / lateral'} ({index})</option>)}
            </select>
          </label>
          {contourIndex !== null && <form key={contourIndex} className="mt-2 space-y-2" onSubmit={e => {
            e.preventDefault(); const data = new FormData(e.currentTarget);
            void correctLandmark(contourIndex, { x: Number(data.get('x')) / 100, y: Number(data.get('y')) / 100 });
          }}>
            <div className="grid grid-cols-2 gap-2">
              {(['x', 'y'] as const).map(axis => <label key={axis}>Coordenada {axis.toUpperCase()} (%)
                <input name={axis} type="number" required min="0" max="100" step="0.01"
                  defaultValue={Number((slot.landmarks![contourIndex][axis] * 100).toFixed(2))}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1" />
              </label>)}
            </div>
            <button type="submit" className="rounded border border-slate-300 px-2 py-1">Aplicar contorno</button>
            <button type="button" onClick={() => setContourIndex(null)} className="ml-2 rounded border border-slate-300 px-2 py-1">Cancelar</button>
          </form>}
          <button type="button" disabled={!slot.detectedLandmarks || buildingPersonal || hasPendingPhotos}
            onClick={async () => {
              const requestId = personalRequestRef.current;
              try {
                const triangles = await faceTriangles();
                if (requestId === personalRequestRef.current && slot.detectedLandmarks) applyLandmarks(slot.detectedLandmarks, triangles, 0);
              } catch (error) { setStatus(`No se pudo restaurar el contorno: ${error instanceof Error ? error.message : 'error desconocido'}.`); }
            }} className="mt-2 rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Restablecer detección original</button>
          <p className="mt-2 text-slate-500">Sin un borde claro se conserva la detección. Al recalcular se conservan las marcas por su triángulo anatómico; revisa su nueva ubicación.</p>
        </details>}

        <details className="rounded-xl border border-slate-200 p-2 text-xs">
          <summary className="cursor-pointer font-semibold">Opciones de superficie y cabeza experimental</summary>
        <fieldset className="mt-2 space-y-2 p-1 text-xs">
          <legend className="px-1 font-semibold uppercase text-slate-500">Modelo 3D</legend>
          <div className="grid grid-cols-2 gap-1">
            <button type="button" disabled={buildingPersonal} aria-pressed={modelKind === 'generico'} onClick={activateGenericModel}
              className={`rounded-lg px-2 py-1.5 font-semibold ${modelKind === 'generico' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>Genérico</button>
            <button type="button" aria-pressed={modelKind === 'personal'} disabled={buildingPersonal || hasPendingPhotos || captureBlocked || !slot?.landmarks}
              onClick={activatePersonal}
              className={`rounded-lg px-2 py-1.5 font-semibold ${modelKind === 'personal' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-50`}>
              {buildingPersonal ? 'Generando…' : 'Personal (foto)'}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button type="button" disabled={buildingPersonal || hasPendingPhotos || captureBlocked || !captureSource}
              aria-pressed={personalActive && !personal?.closedHead}
              onClick={() => { if (captureSource) { setView(captureSource); setWorkMode('3d'); void buildPersonal(depth, captureSource, false); } }}
              className="rounded-lg border border-slate-300 px-2 py-1.5 aria-pressed:border-sky-600 aria-pressed:bg-sky-100 aria-pressed:font-semibold disabled:opacity-40">Superficie facial</button>
          </div>
          <details className="rounded border border-amber-200 p-2">
            <summary className="cursor-pointer text-amber-800">Cabeza completa · experimental (no recomendada)</summary>
            <p className="my-2 text-amber-800">Con tres fotos no se reconstruyen de forma fiable cráneo, cabello ni zonas ocultas. La herramienta principal es la máscara facial.</p>
            <button type="button" disabled={buildingPersonal || hasPendingPhotos || captureBlocked || readyPhotos.length < 3 || !photos.frontal?.landmarks}
              aria-pressed={personalActive && !!personal?.closedHead}
              onClick={() => { setView('frontal'); setWorkMode('3d'); void buildPersonal(depth, 'frontal', true); }}
              className="rounded-lg border border-slate-300 px-2 py-1.5 aria-pressed:border-sky-600 aria-pressed:bg-sky-100 aria-pressed:font-semibold disabled:opacity-40">Cabeza estimada · 3+ fotos</button>
          </details>
          <p role="status" className="font-semibold text-sky-800">{modelKind === 'generico' ? 'Vista activa: cabeza genérica' : personal ? personal.closedHead ? 'Vista activa: cabeza estimada' : 'Vista activa: superficie facial abierta' : 'Sin superficie personal calculada'}</p>
          <p className="text-slate-500">Frontal + ambos laterales: máscara aproximada, perfil nasal y textura lateral de la piel. No reconstruye cabello ni una cabeza completa.</p>
          {personal?.closedHead ? <>
          <label className="flex items-center gap-2"><input type="checkbox" checked={hair.enabled} onChange={e => setHair(current => ({ ...current, enabled: e.target.checked }))} />Relieve adicional del cabello · misma superficie</label>
          {hair.enabled && <div className="space-y-2">
            <button type="button" disabled={hairBusy || buildingPersonal || !personal?.closedHead} onClick={() => void analyzeHair()} className="w-full rounded-lg border border-slate-300 px-2 py-2 font-semibold disabled:opacity-40">{hairBusy ? 'Segmentando cabello…' : 'Analizar relieve del cabello'}</button>
            <label className="block">Relieve visual del cabello
              <input aria-label="Relieve visual del cabello" type="range" min="0" max="1" step="0.05" value={hair.relief} onChange={e => setHair(current => ({ ...current, relief: Number(e.target.value) }))} className="w-full" />
            </label>
            <p className="text-slate-500">{hairPatches?.length ? `${hairPatches.length} vista(s) con cobertura.` : 'La cabeza multivista ya conserva el cabello visible; este análisis añade detalle de iluminación.'} Sin casquete sobresaliente; relieve visual, no geometría medida.</p>
          </div>}</> : null}
          {modelKind === 'personal' && personal ? (
            <>
              <label className="block text-slate-700">Relieve visual: {Math.round(depth * 100)}%
                <input type="range" min={0.75} max={1.25} step={0.05} value={depth} disabled={buildingPersonal || hasPendingPhotos || !personalProjection}
                  onChange={e => setDepth(Number(e.target.value))}
                  onPointerUp={e => buildPersonal(Number((e.target as HTMLInputElement).value))}
                  onKeyUp={e => { if (/^(Arrow|Home|End|Page)/.test(e.key)) buildPersonal(Number(e.currentTarget.value)); }}
                  className="w-full accent-[#b8944d]" />
              </label>
              <button type="button" disabled={buildingPersonal || hasPendingPhotos || depth === 1 || !personalProjection}
                onClick={() => { setDepth(1); void buildPersonal(1); }}
                className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Restablecer relieve calculado</button>
              <p className="text-amber-800">{personal.depthDetails} El control es una variación visual (75–125%), no una calibración clínica.</p>
              {personal.diagnostics.length > 0 && (
                <details className="rounded border border-slate-200 p-2">
                  <summary className="cursor-pointer font-semibold text-slate-700">Concordancia por foto</summary>
                  <ul className="mt-2 space-y-2">
                    {personal.diagnostics.map(d => (
                      <li key={d.index} className="text-slate-600">
                        <strong>{d.label}: {d.status === 'used' ? 'aporta' : d.status === 'limited' ? 'aporte limitado' : 'sin aporte geométrico'}</strong>
                        <p>{d.reason}</p>
                        <p>{d.referenceCount} referencias útiles · peso {Math.round(d.weight * 100)}%
                          {d.normalizedError !== null ? ` · desajuste ${(d.normalizedError * 100).toFixed(1)}% del alto facial` : ''}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10px] text-slate-500">Compatibilidad geométrica, no verificación de identidad ni precisión clínica. Una foto con poco aporte puede permanecer cargada.</p>
                </details>
              )}
              <p className="text-slate-500">La foto {VIEWS.find(v => v.id === personal.view)?.label.toLowerCase()} define la superficie personal de la derecha; las marcas se trasladan por anatomía también a la foto de abajo. {personal.closedHead ? 'El casquete gris es estimado, no observado.' : 'La superficie abierta solo cubre el óvalo facial.'} La profundidad no es un escaneo.</p>
              {personal.view !== view && <p className="font-semibold text-amber-700">La superficie procede de {VIEWS.find(v => v.id === personal.view)?.label}; abajo se muestra otra foto mediante sus referencias anatómicas. Revisa diferencias de pose y expresión.</p>}
            </>
          ) : (
            <p className="text-slate-500">{slot?.landmarks ? 'Genera una superficie 3D a partir de esta foto para marcar sobre la anatomía real del paciente.' : 'La superficie personal requiere una foto con rostro detectado.'}</p>
          )}
        </fieldset>
        </details>

        </>}
        {workspace === 'capture' && <>
        <details className="rounded-xl border border-slate-200 p-2 text-xs">
          <summary className="cursor-pointer font-semibold">Diagnóstico estadístico opcional</summary>
        <fieldset className="space-y-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
          <legend className="flex items-center gap-1 px-1 font-semibold uppercase text-slate-500"><Wand2 className="h-3.5 w-3.5" aria-hidden="true" /> Corrección estadística (puntos)</legend>
          {([['enabled', 'Activar estimación robusta'], ['linear', 'Alinear marcas lineales (frente, mandíbula)'], ['mirror', 'Corregir por simetría (espejo)']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={correct[k]} onChange={e => setCorrect(c => ({ ...c, [k]: e.target.checked }))} />{l}</label>
          ))}
          <label className="block">Tolerancia: {(correct.tolerance * 100).toFixed(1)}% alto facial
            <input type="range" min={0.005} max={0.06} step={0.001} value={correct.tolerance} onChange={e => setCorrect(c => ({ ...c, tolerance: Number(e.target.value) }))} className="w-full accent-[#b8944d]" />
          </label>
          <p className="text-slate-500">Biponderado de Tukey: los errores pequeños se corrigen; los atípicos (asimetrías reales) se simulan tal como se marcaron.
            Corregidos: <b>{stats.fixed}</b> · Tal cual: <b>{stats.asis}</b>{stats.fixed ? ` · desvío medio ${(stats.mean * 100).toFixed(2)}%` : ''}</p>
        </fieldset>
        </details>

        <details className="rounded-xl bg-slate-50 p-3 text-xs">
          <summary className="flex cursor-pointer items-center gap-1 font-semibold uppercase text-slate-500"><ScanFace className="h-3.5 w-3.5" aria-hidden="true" /> Marco / alineación ({VIEWS.find(v => v.id === view)?.label})</summary>
          {slot?.frame.anchors && (
            <div className="mt-2 space-y-2">
              <p className="text-slate-600">La transferencia usa el atlas denso del modelo original. Corregir referencias en la foto sí actualiza su malla. La prueba afín de abajo es solo diagnóstica: no desplaza las marcas compartidas.</p>
              <label className="block text-slate-700">Corregir referencia en foto
                <select aria-label="Corregir referencia en foto" value={photoAnchor ?? ''}
                  disabled={calibrating}
                  onChange={e => {
                    setDraft(null); dragRef.current = null;
                    setContourIndex(null);
                    const index = e.target.value === '' ? null : Number(e.target.value);
                    setPhotoAnchor(index);
                    if (index !== null) setStatus(`Haz clic en la foto sobre «${REGISTRATION_ANCHORS[index]}». Este clic corrige la referencia; no añade una marca de tratamiento.`);
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5">
                  <option value="">Seleccionar referencia…</option>
                  {REGISTRATION_ANCHORS.map((name, index) => (
                    <option key={name} value={index} disabled={slot.registrationSource === 'manual' && !anchorIndices.includes(index)}>{index + 1}. {name}</option>
                  ))}
                </select>
              </label>
              {photoAnchor !== null && <form key={photoAnchor} className="space-y-2" onSubmit={e => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                correctPhotoAnchor({ x: Number(data.get('x')) / 100, y: Number(data.get('y')) / 100 });
              }}>
                <p className="text-slate-600">Haz clic en la foto o ajusta las coordenadas (% de imagen) con el teclado.</p>
                <div className="grid grid-cols-2 gap-2">
                  {(['x', 'y'] as const).map(axis => <label key={axis}>Coordenada {axis.toUpperCase()} (%)
                    <input name={axis} type="number" required min="0" max="100" step="0.01"
                      defaultValue={Number(((frame.anchors?.[photoAnchor][axis] ?? 0) * 100).toFixed(2))}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1" />
                  </label>)}
                </div>
                <button type="submit" className="w-full rounded border border-slate-300 px-2 py-1 font-semibold">Aplicar coordenadas</button>
              </form>}
              {photoAnchor !== null && <button type="button" onClick={() => {
                setPhotoAnchor(null); setStatus('Corrección de referencia cancelada; se conserva la alineación.');
              }} className="w-full rounded border border-slate-300 px-2 py-1 text-slate-700">Cancelar corrección en foto</button>}
              <button
                type="button"
                disabled={calibrating || modelKind === 'personal'}
                onClick={() => {
                  setPhotos(p => p[view]?.canvas === slot.canvas
                    ? { ...p, [view]: { ...p[view]!, modelAnchors: [], registration: undefined } }
                    : p);
                  setCalibrating(true);
                  setPhotoAnchor(null);
                  setTool3d('point');
                  setWorkMode('3d');
                  setStatus(`Calibración manual: marca en el modelo «${REGISTRATION_ANCHORS[0]}» (${anchorCount} referencias).`);
                }}
                className="w-full rounded-lg bg-slate-800 px-2 py-1.5 font-semibold text-white disabled:opacity-50"
              >
                Prueba afín manual (diagnóstico)
              </button>
              {calibrating && (
                <>
                  <p className="font-semibold text-amber-700">Marca {Math.min((slot.modelAnchors?.length ?? 0) + 1, anchorCount)}/{anchorCount} en el modelo: {anchorName(slot.modelAnchors?.length ?? 0)}.</p>
                  <button type="button" onClick={() => {
                    setCalibrating(false);
                    const auto = autoRegistration(view, frame, aspect, flipX);
                    const ok = isRegistrationAccepted(auto);
                    setPhotos(p => p[view] ? { ...p, [view]: { ...p[view]!, modelAnchors: undefined, ...(ok ? { registration: auto, registrationFlip: flipX, registrationSource: 'auto' as const } : { registration: undefined }) } } : p);
                    setStatus('Prueba afín cancelada. El atlas anatómico y las marcas compartidas no cambian.');
                  }} className="w-full rounded border border-slate-300 px-2 py-1 text-slate-700">Cancelar alineación</button>
                </>
              )}
              {slot.registration && slot.registrationFlip === flipX && (
                <p className="text-slate-600">Diagnóstico afín {slot.registrationSource === 'manual' ? 'manual' : 'automático'} · RMS {(slot.registration.rmse * 100).toFixed(1)}% · máximo {(slot.registration.maxError * 100).toFixed(1)}%. No mide el error de la transferencia anatómica.</p>
              )}
              <p className="text-slate-500">Modelo, superficie y foto comparten las marcas mediante triángulos y coordenadas baricéntricas; las zonas sin correspondencia se bloquean.</p>
            </div>
          )}
          {(['top', 'bottom', 'left', 'right'] as const).map(k => (
            <label key={k} className="mt-2 block capitalize">{k}
              <input type="range" min={0} max={1} step={0.005} value={frame[k]} disabled={!slot} onChange={e => { setPhotoAnchor(null); updateFrame(k, Number(e.target.value)); }} className="w-full accent-[#b8944d]" />
            </label>
          ))}
          <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={flipX} onChange={e => {
            setCalibrating(false);
            setPhotoAnchor(null);
            const nextFlip = e.target.checked;
            setFlipX(nextFlip);
            const auto = slot ? autoRegistration(view, frame, aspect, nextFlip) : null;
            const ok = isRegistrationAccepted(auto);
            setPhotos(p => p[view] ? { ...p, [view]: { ...p[view]!, modelAnchors: undefined, ...(ok ? { registration: auto, registrationFlip: nextFlip, registrationSource: 'auto' as const } : { registration: undefined }) } } : p);
          }} />Invertir lado en diagnóstico afín</label>
        </details>

        </>}
      </aside>}

      <div className={`min-w-0 space-y-4 ${workspace === 'simulate' && editorGroup === 'appearance' ? 'lg:col-span-2' : ''}`}>
        {appearanceOpened && <div hidden={workspace !== 'simulate' || editorGroup !== 'appearance'} data-face-appearance-group>
          <Suspense fallback={<p role="status">Preparando morfología, piel y capas…</p>}>
            {modelKind === 'personal' && !personal ? <p role="status" className="rounded-xl border p-4">
              {buildingPersonal ? 'Calculando superficie fotografiada…' : 'Calcula la superficie personal en Capturas o selecciona el modelo genérico.'}
            </p> : <FacialSimulationViewer
              surface={modelKind === 'personal' ? personal?.renderSurface : undefined}
              photo={modelKind === 'personal' ? personal?.canvas : undefined}
              photoPatches={modelKind === 'personal' ? personal?.photoPatches : undefined}
              showMesh={showRegions} plane={regionPlane} onPlaneChange={setRegionPlane} onMeshChange={toggleMesh}
              anatomyDisplay={anatomyDisplay} onAnatomyDisplayChange={setAnatomyDisplay}
              hair={hair} hairPatches={modelKind === 'personal' ? hairPatches : undefined}
            />}
          </Suspense>
        </div>}
        <div hidden={workspace === 'simulate' && editorGroup !== 'annotations'} className="space-y-4" data-face-annotations-group>
        {workspace === 'simulate' && <div role="toolbar" aria-label="Marcar" className={`${editorPanel} flex flex-wrap items-center gap-2 p-2`}>
          <span className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-gold/15 px-2.5 text-[11px] font-black uppercase tracking-[0.14em] text-gold">
            <span aria-hidden="true" className="grid h-4 w-4 place-items-center rounded-full bg-gold text-[9px] text-stone-950">✓</span>Marcar
          </span>
          <div role="group" aria-label="Superficie de marcación" className="flex gap-1 rounded-xl bg-black/40 p-1">
            {([['generico', 'Genérico', Box], ['personal', 'Personal', UserRound], ['foto', 'Foto', ImageIcon]] as const).map(([id, label, Icon]) => {
              const active = id === 'foto' ? workMode === 'foto' : workMode === '3d' && modelKind === id;
              return <button key={id} type="button" aria-pressed={active}
                disabled={id === 'foto' ? calibrating : id === 'personal' && !personal && (!captureSource || captureBlocked || buildingPersonal)}
                onClick={() => {
                  setDraft(null);
                  if (id === 'foto') { setWorkMode('foto'); setPhotoInteraction('draw'); beginEditing(); return; }
                  setWorkMode('3d'); if (id === 'generico') activateGenericModel(); else activatePersonal();
                }}
                className="admin-focus-ring flex min-h-9 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs font-bold text-stone-400 transition aria-pressed:bg-stone-800 aria-pressed:text-gold disabled:opacity-30">
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}</button>;
            })}
          </div>
          {workMode === '3d' && <CheckChip label="Visor dividido · genérico y máscara" icon={Columns2} checked={splitAnnotations}
            onChange={checked => { setSplitAnnotations(checked); setDraft(null); }}>Dividido</CheckChip>}
          {workMode === '3d' && (splitAnnotations || modelKind === 'personal') && !personal && <button type="button" disabled={buildingPersonal || hasPendingPhotos || captureBlocked || !captureSource}
            onClick={activatePersonal} title={!captureSource ? 'Carga y revisa una foto en Capturas' : undefined}
            className="admin-focus-ring min-h-10 whitespace-nowrap rounded-lg border border-gold/40 bg-gold/10 px-2.5 text-xs font-bold text-gold disabled:opacity-40">
            {buildingPersonal ? 'Calculando máscara personal…' : 'Preparar máscara personal'}</button>}
          {workMode === 'foto' && <>
            <select aria-label="Foto activa" value={view} onChange={e => { setView(e.target.value as ViewKind); setDraft(null); }}
              className="admin-focus-ring min-h-10 rounded-lg border border-white/10 bg-stone-900 px-2 text-xs text-stone-100">
              {VIEWS.map(v => <option key={v.id} value={v.id} disabled={!photos[v.id]}>{v.label}</option>)}
            </select>
            <IconToggle label="Seleccionar sin dibujar" icon={MousePointer2} pressed={photoInteraction === 'select'} onClick={() => {
              setPhotoInteraction(p => p === 'select' ? 'draw' : 'select'); setDraft(null); dragRef.current = null;
            }} />
          </>}
          <span aria-hidden="true" className="hidden h-8 w-px bg-white/10 sm:block" />
          {workMode === '3d'
            ? <ToolDock label="Herramientas de marcación" items={TOOLS_3D} value={tool3d} accent={SIM_MODES[mode].color}
              disabled={id => calibrating && id !== 'point'} onSelect={id => { setTool3d(id); if (id !== 'navigate') beginEditing(); }} />
            : <ToolDock label="Herramientas de marcación" items={TOOLS_PHOTO} value={photoInteraction === 'draw' ? toolPhoto : null} accent={SIM_MODES[mode].color}
              onSelect={id => { setToolPhoto(id); setPhotoInteraction('draw'); beginEditing(); }} />}
          {workMode === 'foto' && toolPhoto === 'pattern' && <select aria-label="Patrón ilustrativo" value={photoPattern} onChange={e => setPhotoPattern(e.target.value as typeof photoPattern)}
            className="admin-focus-ring min-h-10 rounded-lg border border-white/10 bg-stone-900 px-2 text-xs text-stone-100">
            <option value="fan">Abanico</option><option value="grid">Malla</option><option value="fern">Helecho</option>
          </select>}
          <span aria-hidden="true" className="hidden h-8 w-px bg-white/10 sm:block" />
          <CheckChip label="Modo bilateral · crear ambos lados en una acción" icon={Sparkles} checked={bilateral} onChange={setBilateral}>Bilateral</CheckChip>
          {workMode === '3d' && <CheckChip label="Zona extendida (cuello/cuero cabelludo)" icon={Move3d} checked={extendedZone}
            onChange={checked => { setExtendedZone(checked); setOutsideHint(false); }}>Extendida</CheckChip>}
          <IconToggle label="Deshacer" icon={Undo2} disabled={!history.length} onClick={undo} />
        </div>}
        {workspace === 'simulate' && <div className="flex flex-wrap items-center gap-1.5">
          <ZoneChip store={hoverStore} color={SIM_MODES[mode].color} />
          <span className={hudChip} title="Capa activa (lateralidad del paciente)"><Layers className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
            {ANATOMY_PLANES.find(plane => plane.id === anatomyDisplay.anatomy)?.label}</span>
          {preview.after && <button type="button" onClick={() => comparePreview(false)} className={`${hudChip} border-gold/50 text-gold`}>
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />Vista «Después» · volver a marcar</button>}
          <span className="ml-auto" />
          {totals.length ? <VolumeHud totals={totals} /> : <span className={`${hudChip} text-stone-400`}><Gauge className="h-3.5 w-3.5" aria-hidden="true" />0 {SIM_MODES[mode].unit}</span>}
        </div>}
      <div className={`grid min-w-0 content-start gap-4 ${workspace === 'simulate' && workMode === '3d' && splitAnnotations ? 'lg:grid-cols-2' : ''}`}>
        {workspace === 'simulate' && workMode === '3d' && (splitAnnotations
          ? <>{renderViewer('generico')}{renderViewer('personal')}</>
          : renderViewer(modelKind))}
        {workspace === 'capture' && calibrating && renderViewer('generico')}
        <section className={`min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 p-3 ${workspace === 'simulate' && workMode !== 'foto' ? 'hidden' : ''}`}>
          <h2 className="mb-2 text-center text-sm font-semibold text-slate-200">Foto referencial {VIEWS.find(v => v.id === view)?.label.toLowerCase()} · registro compartido</h2>
          {overlayMode === 'attention' && <p className="mb-2 rounded bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-950">SIMULACIÓN · No detecta vasos ni certifica zonas seguras.</p>}
          {!hasImage && <div className="flex h-[360px] items-center justify-center text-center text-sm text-slate-400">Carga la foto de la vista «{VIEWS.find(v => v.id === view)?.label}» para ver la simulación</div>}
          <div className={`relative mx-auto max-h-[78vh] touch-none select-none ${hasImage ? '' : 'hidden'} ${workMode === 'foto' ? 'cursor-crosshair' : ''}`}
            style={{ aspectRatio: String(aspect), maxWidth: `min(100%, calc(70vh * ${aspect}))` }}
            onPointerDown={onDown} onPointerMove={e => {
              onMove(e);
              if (!e.buttons && slot?.landmarks) {
                const address = locatePhotoPoint(toNorm(e), slot.landmarks, genericFaceAtlas);
                setHoveredZone(address && layerIsVisible ? photoLayer ? photoLayer.zone(address)
                  : patientZone(regionCellAt(address, regionCells), address) : null);

              }
            }} onPointerLeave={() => setHoveredZone(null)} onPointerUp={onUp}
            onPointerCancel={() => { setDraft(null); dragRef.current = null; }} onContextMenu={e => e.preventDefault()}>
            {!anatomyDisplay.overlay && photoLayerOverlay}
            <canvas ref={glRef} className="relative h-full w-full" aria-label="Simulación del rostro"
              style={{ opacity: photoUsesPreview ? 0 : photoSkinOpacity }} />
            {(!preview.after || workspace === 'capture') && slot?.previewUrl && <img src={slot.previewUrl} alt="" aria-hidden="true"
              style={{ opacity: photoSkinOpacity }}
              className="pointer-events-none absolute inset-0 h-full w-full" />}
            {anatomyDisplay.overlay && photoLayerOverlay}
            {photoRegionOverlay && <ZoneView store={hoverStore}>{hoveredZone => <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
              {photoRegionOverlay.map(({ label, path }) => <path key={label} d={path}
                fill={hoveredZone === label ? photoLayer ? '#38bdf8' : faceRegionColor(label) : 'none'} fillOpacity={0.3}
                stroke={overlayMode === 'attention' ? faceAttentionColor(label) : '#7dd3fc'} strokeOpacity={hoveredZone === label ? 0.9 : showRegions ? 0.35 : 0} strokeWidth="0.0008" />)}
            </svg>}</ZoneView>}
            {currentSkinReview?.result.usable && <img src={currentSkinReview.urls[skinChannel]} alt="" aria-hidden="true" style={{ opacity: skinOpacity }} className="pointer-events-none absolute inset-0 h-full w-full" />}
            {currentForeheadPreview && <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
              <line x1={Math.max(0, currentForeheadPreview.point.x - 0.12)} x2={Math.min(1, currentForeheadPreview.point.x + 0.12)} y1={currentForeheadPreview.point.y} y2={currentForeheadPreview.point.y} stroke="#f59e0b" strokeWidth="0.003" strokeDasharray="0.008 0.005" />
              <circle cx={currentForeheadPreview.point.x} cy={currentForeheadPreview.point.y} r="0.008" fill="#f59e0b" stroke="white" strokeWidth="0.002" />
            </svg>}
            {split > 0 && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split * 100}%` }} />}
            {hasImage && frame.outline && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                <polygon points={poly(frame.outline)} fill="rgba(56,189,248,0.06)" stroke="#38bdf8" strokeWidth="0.0025" strokeDasharray="0.01 0.006" />
                <line x1={frame.axisTop.x} y1={frame.axisTop.y} x2={frame.axisBottom.x} y2={frame.axisBottom.y} stroke="#38bdf8" strokeWidth="0.002" strokeDasharray="0.008 0.006" />
                {contourIndex !== null && FACE_OVAL.map((index, i) => {
                  const point = slot?.landmarks?.[index];
                  return point && <g key={`contour-${index}`}>
                    <circle cx={point.x} cy={point.y} r={index === contourIndex ? '0.012' : '0.005'} fill={index === contourIndex ? '#f59e0b' : '#38bdf8'} stroke="white" strokeWidth="0.0015" />
                    <text x={point.x + 0.008} y={point.y} fill="white" stroke="#0f172a" strokeWidth="0.002" paintOrder="stroke" fontSize="0.018">{i + 1}</text>
                  </g>;
                })}
                {(workspace === 'capture' || photoAnchor !== null) && frame.anchors?.map((point, index) => (
                  <g key={index}>
                    <circle cx={point.x} cy={point.y} r={photoAnchor === index ? '0.014' : '0.009'} fill={photoAnchor === index ? '#f59e0b' : '#38bdf8'} stroke="white" strokeWidth="0.002" />
                    <text x={point.x + 0.012} y={point.y - 0.01} fill="white" stroke="#0f172a" strokeWidth="0.004" paintOrder="stroke" fontSize="0.025" fontWeight="bold">{index + 1}</text>
                    <title>{REGISTRATION_ANCHORS[index]}</title>
                  </g>
                ))}
              </svg>
            )}
            {workspace === 'simulate' && showMarks && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                {renderShapes(elems)}
                {draftEl && renderShapes([draftEl], true)}
              </svg>
            )}
            {workspace === 'simulate' && showMarks && corrected.filter(p => !p.id.includes(':')).map(p => (
              <span key={p.id} className={`pointer-events-none absolute block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ${selectedId === p.id ? 'ring-4 ring-amber-400' : ''}`}
                style={{ left: `${p.rawX * 100}%`, top: `${p.rawY * 100}%`, background: SIM_MODES[p.mode].color }}
                title={`${p.zone} · ${p.dose} ${SIM_MODES[p.mode].unit}`} />
            ))}
            {workspace === 'simulate' && showMarks && corrected.filter(p => p.corrected).map(p => (
              <div key={`raw-${p.id}`} className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50"
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} title="Simulación de corrección; no modifica la marcación anatómica" />
            ))}
          </div>
        </section>
      </div>
      </div>
      </div>
      {workspace === 'simulate' && editorGroup === 'annotations' && <div className="flex min-w-0 flex-col lg:col-span-2 xl:sticky xl:top-4 xl:col-span-1 xl:h-[calc(100dvh-7rem)] xl:self-start">
        <PointLedger rows={rows} selectedId={selectedId}
          onSelect={row => {
            setSelectedId(row.id); beginEditing();
            const binding = bindings[row.id];
            const layer = activeLayer(workMode === 'foto' ? 'foto' : modelKind);
            if (binding && (!layerIsVisible || layer && !binding.paths.flat().every(layer.accepts))) {
              setAnatomyDisplay(current => chooseAnatomyDisplay(current, binding.illustrativePlane ?? 'skin'));
            }
          }}
          onHover={row => setHoveredZone(row ? `${row.zone} · ${row.side}` : null)}
          onDose={editDose} onDelete={id => { snap(); removeEl(id); }}
          onPlane={(ids, plane) => { snap(); setMeta(m => ({ ...m, ...Object.fromEntries(ids.filter(id => m[id]).map(id => [id, { ...m[id], plane: plane || undefined }])) })); }}
          header={selectedRow && meta[selectedRow.id] && <SelectionInspector row={selectedRow} onDose={editDose}
            onDelete={id => { snap(); removeEl(id); setSelectedId(null); }} onMirror={mirrorSelected} mirrorDisabled={preview.after || !bindings[selectedRow.id]}
            onTransform={bindings[selectedRow.id] && !preview.after ? transformSelected : undefined}>
            <details className="rounded-lg border border-white/10 bg-black/30 p-2">
              <summary className="flex min-h-8 cursor-pointer list-none items-center text-[11px] font-bold text-stone-300">Editar categoría, zona y producto</summary>
              <form key={selectedRow.id} aria-label="Editar marca seleccionada" className="mt-2 grid gap-2" onSubmit={e => {
                e.preventDefault();
                const data = new FormData(e.currentTarget), nextMode = data.get('mode') as SimMode, id = selectedRow.id;
                snap(); setMeta(m => ({ ...m, [id]: { ...m[id], mode: nextMode,
                  zone: String(data.get('zone')), product: String(data.get('product')) || undefined } }));
                setStatus('Marca actualizada.');
              }}>
                <label className="text-[11px] text-stone-400">Categoría
                  <select name="mode" defaultValue={meta[selectedRow.id].mode} className="admin-focus-ring mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-stone-950 px-2 text-xs text-stone-100">
                    {(Object.keys(SIM_MODES) as SimMode[]).map(m => <option key={m} value={m}>{SIM_MODES[m].label}</option>)}
                  </select>
                </label>
                <label className="text-[11px] text-stone-400">Zona registrada
                  <input name="zone" defaultValue={meta[selectedRow.id].zone} className="admin-focus-ring mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-stone-950 px-2 text-xs text-stone-100" />
                </label>
                <label className="text-[11px] text-stone-400">Producto registrado
                  <input name="product" list="face-annotation-products" defaultValue={meta[selectedRow.id].product ?? ''} className="admin-focus-ring mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-stone-950 px-2 text-xs text-stone-100" />
                </label>
                <button type="submit" className="admin-focus-ring min-h-10 rounded-lg bg-gold px-3 text-xs font-bold text-stone-950">Guardar cambios de marca</button>
              </form>
            </details>
          </SelectionInspector>} />
      </div>}
      {workspace === 'simulate' && pendingVolume && meta[pendingVolume[0]] && <VolumeDialog open mode={meta[pendingVolume[0]].mode} count={pendingVolume.length}
        place={rows.find(r => r.id === pendingVolume[0]) ? `${meta[pendingVolume[0]].zone} · ${rows.find(r => r.id === pendingVolume[0])!.side}` : meta[pendingVolume[0]].zone}
        initialDose={dose}
        onSave={(value, plane) => {
          const ids = pendingVolume;
          setMeta(m => ({ ...m, ...Object.fromEntries(ids.filter(id => m[id]).map(id => [id, { ...m[id], dose: value, plane: plane || undefined }])) }));
          setDose(value); setPendingVolume(null);
          setStatus(`${ids.length} punto(s) · ${value} ${SIM_MODES[meta[ids[0]].mode].unit} registrados.`);
        }}
        onDiscard={() => { setPendingVolume(null); undo(); setStatus('Punto descartado.'); }} />}
    </div>
  );
}
