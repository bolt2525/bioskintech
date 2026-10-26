import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, ImagePlus, Trash2, Wand2, Undo2, FileJson, ScanFace, Box, Image as ImageIcon } from 'lucide-react';
import injectablesCatalog from '../../components/admin/ficha-clinica/data/injectables.json';
import Clinical3DViewer, {
  type DrawingTool, type FreehandLine, type Marker3D, type SurfaceShape,
} from '../../components/admin/ficha-clinica/components/Clinical3DViewer';
import {
  AUTO_ZONE, MAX_EFFECTS, REGISTRATION_ANCHORS, SIM_MODES, autoRegistration, buildEffects, correctPoints, defaultFrame,
  elemsFrom3D, elemsFromPhoto, expandElems, fitAffineRegistration, frameFromLandmarks, importInjectable, isRegistrationAccepted, isWithinFace, projectModel,
  buildPersonalSurface, rebasePersonalPoint, refineDepthFromProfiles, registrationAnchorIndices, trianglesFromEdges, updateRegistrationAnchor,
  type AffineRegistration, type PersonalProjection, type CorrectedPoint, type Elem, type ElemKind, type FaceFrame, type Meta, type P2, type PhotoEl, type SimMode, type Vec3, type ViewKind,
} from './engine';

const catalog = (cat: string) => (injectablesCatalog as { categoria: string; elemento: string }[])
  .filter(i => i.categoria === cat).map(i => i.elemento);
const ZONES = ['tercio_superior', 'tercio_medio', 'tercio_inferior'].flatMap(catalog);
const MAX_SIDE = 1400;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;

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

interface Renderer { draw: (fx: ReturnType<typeof buildEffects>, aspect: number, split: number) => void; dispose: () => void }

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
async function detectFrame(img: HTMLCanvasElement): Promise<{ frame: FaceFrame | null; landmarks?: Landmark[]; pose?: number[]; reason: string }> {
  let landmarker: import('@mediapipe/tasks-vision').FaceLandmarker | null = null;
  try {
    const head = await fetch('/models/face/face_landmarker.task', { method: 'HEAD' });
    const contentType = head.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    // Content-Length puede faltar con compresión (br); el tipo HTML delata el fallback de la SPA.
    if (!head.ok || contentType === 'text/html') {
      return { frame: null, reason: `El modelo facial no está disponible o es inválido (HTTP ${head.status}).` };
    }
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/face/face_landmarker.task' }, runningMode: 'IMAGE', numFaces: 1,
      outputFacialTransformationMatrixes: true,
    });
    const result = landmarker.detect(img);
    const landmarks = result.faceLandmarks[0];
    return landmarks
      ? { frame: frameFromLandmarks(landmarks), landmarks: landmarks.map(({ x, y, z }) => ({ x, y, z })),
        pose: result.facialTransformationMatrixes[0]?.data, reason: '' }
      : { frame: null, reason: 'MediaPipe no encontró un rostro en esta imagen.' };
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    return { frame: null, reason: `Falló la inicialización o validación del detector facial.${detail}` };
  } finally {
    landmarker?.close();
  }
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
interface PersonalModel { view: ViewKind; canvas: HTMLCanvasElement; glb: ArrayBuffer; projection: PersonalProjection; depth: number; depthDetails: string }

const uid = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const VIEWS: { id: ViewKind; label: string }[] = [{ id: 'frontal', label: 'Frontal' }, { id: 'izquierda', label: 'Lateral izq.' }, { id: 'derecha', label: 'Lateral der.' }];
type WorkMode = '3d' | 'foto';
type Tool3D = 'navigate' | 'point' | Exclude<DrawingTool, 'none'>;
const TOOLS_3D: { id: Tool3D; label: string }[] = [
  { id: 'navigate', label: 'Rotar' }, { id: 'point', label: 'Punto' }, { id: 'freehand-brush', label: 'Pincel' },
  { id: 'freehand-poly', label: 'Polilínea' }, { id: 'straight-line', label: 'Línea' }, { id: 'shape-arrow', label: 'Flecha' },
  { id: 'shape-circle', label: 'Círculo' }, { id: 'shape-rect', label: 'Rectángulo' }, { id: 'ha-fan', label: 'Abanico' },
  { id: 'ha-grid', label: 'Malla' }, { id: 'ha-fern', label: 'Helecho' },
];
const TOOLS_PHOTO: { id: ElemKind; label: string }[] = [
  { id: 'point', label: 'Punto' }, { id: 'line', label: 'Línea' }, { id: 'arrow', label: 'Flecha' },
  { id: 'free', label: 'Libre' }, { id: 'circle', label: 'Círculo' }, { id: 'rect', label: 'Rectángulo' },
];
const HA_CONFIG = { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };

interface Slot {
  canvas: HTMLCanvasElement;
  aspect: number;
  frame: FaceFrame;
  landmarks?: Landmark[];
  pose?: number[];
  modelAnchors?: Vec3[];
  registration?: AffineRegistration;
  registrationFlip?: boolean;
  registrationSource?: 'auto' | 'manual';
}
interface Snapshot { markers: Marker3D[]; lines: FreehandLine[]; shapes: SurfaceShape[]; meta: Record<string, Meta>; photoEls: PhotoEl[] }

const segDist = (p: P2, a: P2, b: P2, k: number) => {
  const ax = (b.x - a.x) * k, ay = b.y - a.y, px = (p.x - a.x) * k, py = p.y - a.y, l2 = ax * ax + ay * ay;
  const t = l2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
  return Math.hypot(px - t * ax, py - t * ay);
};

export default function FaceSimLab() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const dragRef = useRef<string | null>(null);
  const uploadRequestRef = useRef(0);
  const personalRequestRef = useRef(0);
  const [photos, setPhotos] = useState<Partial<Record<ViewKind, Slot>>>({});
  const [view, setView] = useState<ViewKind>('frontal');
  const [renderTick, setRenderTick] = useState(0);
  const [workMode, setWorkMode] = useState<WorkMode>('3d');
  const [tool3d, setTool3d] = useState<Tool3D>('point');
  const [toolPhoto, setToolPhoto] = useState<ElemKind>('point');
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
  const [dose, setDose] = useState(SIM_MODES.toxina.defaultDose);
  const [intensity, setIntensity] = useState(1);
  const [split, setSplit] = useState(0);
  const [correct, setCorrect] = useState({ enabled: false, linear: true, mirror: true, tolerance: 0.02 });
  const [flipX, setFlipX] = useState(false);
  const [showMarks, setShowMarks] = useState(true);
  const [status, setStatus] = useState('Marca en el modelo 3D o en la foto; la simulación se actualiza en tiempo real.');
  const [importText, setImportText] = useState('');
  const [modelKind, setModelKind] = useState<ModelKind>('generico');
  const [personal, setPersonal] = useState<PersonalModel | null>(null);
  const [depth, setDepth] = useState(1);
  const [buildingPersonal, setBuildingPersonal] = useState(false);

  const slot = photos[view];
  const personalActive = modelKind === 'personal' && !!personal;
  const personalProjection = personalActive && personal.view === view && personal.canvas === slot?.canvas ? personal.projection : undefined;
  const anchorIndices = registrationAnchorIndices(view);
  const anchorCount = anchorIndices.length;
  const anchorName = (index: number) => REGISTRATION_ANCHORS[anchorIndices[index]] ?? 'finalizando';
  const aspect = slot?.aspect ?? 0.75;
  const frame = slot?.frame ?? defaultFrame(view);
  const hasImage = !!slot;
  const curMeta = (): Meta => ({ mode, dose, zone, product: product || undefined });

  const elems = useMemo<Elem[]>(() => [
    ...(personalActive
      ? (personalProjection ? elemsFrom3D({ markers, lines, shapes, meta }, view, frame, aspect, false, undefined, personalProjection) : [])
      : slot?.registration && slot.registrationFlip === flipX
        ? elemsFrom3D({ markers, lines, shapes, meta }, view, frame, aspect, flipX, slot.registration)
        : []),
    ...elemsFromPhoto(photoEls.filter(e => e.view === view), aspect),
  ], [markers, lines, shapes, meta, photoEls, view, frame, aspect, flipX, slot?.registration, slot?.registrationFlip, personalActive, personalProjection]);
  const corrected = useMemo<CorrectedPoint[]>(() => {
    const { points, derived } = expandElems(elems, frame, aspect);
    const fixed = correctPoints(points, { ...correct, aspect, frame });
    return [
      ...fixed.map(p => isWithinFace({ x: p.x, y: p.y }, frame)
        ? p : { ...p, x: p.rawX, y: p.rawY, corrected: null, shift: 0 }),
      ...derived.map(d => ({ ...d, rawX: d.x, rawY: d.y, corrected: null, shift: 0 })),
    ];
  }, [elems, correct, aspect, frame]);
  const stats = useMemo(() => {
    const fixed = corrected.filter(p => p.corrected);
    return { fixed: fixed.length, asis: corrected.length - fixed.length, mean: fixed.length ? fixed.reduce((s, p) => s + p.shift, 0) / fixed.length : 0 };
  }, [corrected]);

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
      buildEffects(corrected.filter(p => isWithinFace({ x: p.x, y: p.y }, frame)), frame, aspect, intensity), aspect, split,
    ));
    return () => cancelAnimationFrame(id);
  }, [corrected, frame, aspect, intensity, split, renderTick]);

  const snap = useCallback(() => setHistory(h => [...h.slice(-30), { markers, lines, shapes, meta, photoEls }]), [markers, lines, shapes, meta, photoEls]);
  const undo = () => {
    const s = history.at(-1); if (!s) return;
    setMarkers(s.markers); setLines(s.lines); setShapes(s.shapes); setMeta(s.meta); setPhotoEls(s.photoEls); setHistory(h => h.slice(0, -1));
  };
  const clearAll = () => { snap(); setMarkers([]); setLines([]); setShapes([]); setMeta({}); setPhotoEls([]); };
  /** Las marcas 3D viven en coordenadas del modelo activo; al cambiar de malla dejan de tener sentido. */
  const resetModelMarks = () => {
    const had = markers.length + lines.length + shapes.length > 0;
    const ids = new Set([...markers.map(m => m.id), ...lines.map(l => l.id), ...shapes.map(s => s.id)]);
    setMarkers([]); setLines([]); setShapes([]); setHistory([]);
    setMeta(m => Object.fromEntries(Object.entries(m).filter(([id]) => !ids.has(id))));
    return had ? ' Se limpiaron las marcas 3D del modelo anterior (las marcas en foto se conservan).' : '';
  };
  const useGenericModel = () => {
    if (modelKind === 'generico') return;
    setModelKind('generico');
    setStatus(`Modelo genérico activo: la proyección a la foto vuelve a ser orientativa.${resetModelMarks()}`);
  };
  const activatePersonal = () => {
    setWorkMode('3d');
    if (modelKind === 'personal' && personalProjection) return;
    if (personal && personal.view === view && personal.canvas === slot?.canvas) {
      setModelKind('personal');
      setStatus(`Superficie 3D personal activa.${resetModelMarks()}`);
      return;
    }
    void buildPersonal();
  };
  const buildPersonal = async (nextDepth = depth) => {
    const source = slot;
    if (!source?.landmarks) {
      setStatus('Para la superficie personal carga una foto con el rostro detectado (landmarks MediaPipe).');
      return;
    }
    const requestId = ++personalRequestRef.current;
    setBuildingPersonal(true);
    setCalibrating(false);
    try {
      const profiles = view === 'frontal' ? VIEWS.filter(v => v.id !== 'frontal').flatMap(v => {
        const photo = photos[v.id];
        return photo?.landmarks ? [{ landmarks: photo.landmarks, aspect: photo.aspect, pose: photo.pose }] : [];
      }) : [];
      const refined = refineDepthFromProfiles({ landmarks: source.landmarks, aspect: source.aspect, pose: source.pose }, profiles);
      const depthDetails = [
        refined.used ? `Ajuste experimental de profundidad con ${refined.used} lateral(es).`
          : 'Profundidad monocular sin contrastar. Para mejorarla, carga frontal y laterales de la misma persona con expresión neutra y genera desde Frontal.',
        ...refined.rejected,
      ].join(' ');
      const surface = buildPersonalSurface(refined.landmarks, source.aspect, await faceTriangles(), nextDepth);
      if (!surface) throw new Error('Landmarks insuficientes para construir la malla.');
      const { personalSurfaceToGlb } = await import('./personalSurfaceGlb');
      const glb = await personalSurfaceToGlb(surface, source.canvas);
      if (requestId !== personalRequestRef.current) return;
      const replacing = modelKind !== 'personal' || !personal || personal.view !== view || personal.canvas !== source.canvas;
      const cleared = replacing ? resetModelMarks() : '';
      if (!replacing && personal) {
        const ratio = nextDepth / personal.depth, scale = surface.projection.k / personal.projection.k;
        const point = (p: Vec3) => rebasePersonalPoint(p, personal.projection, surface.projection, ratio);
        const direction = (p: Vec3, zScale: number) => {
          const length = Math.hypot(p.x, p.y, p.z * zScale) || 1;
          return { x: p.x / length, y: p.y / length, z: p.z * zScale / length };
        };
        const rebase = (s: Snapshot): Snapshot => ({
          ...s,
          markers: s.markers.map(m => ({ ...m, position: point(m.position), normal: direction(m.normal, 1 / ratio),
            ...(m.points ? { points: m.points.map(point) } : {}), ...(m.radius !== undefined ? { radius: m.radius * scale } : {}) })),
          lines: s.lines.map(l => ({ ...l, points: l.points.map(point), segments: l.segments?.map(path => path.map(point)) })),
          shapes: s.shapes.map(sh => ({ ...sh, center: point(sh.center), normal: direction(sh.normal, 1 / ratio),
            ...(sh.tangent ? { tangent: direction(sh.tangent, ratio) } : {}),
            ...(sh.radius !== undefined ? { radius: sh.radius * scale } : {}),
            ...(sh.width !== undefined ? { width: sh.width * scale } : {}),
            ...(sh.height !== undefined ? { height: sh.height * scale } : {}) })),
        });
        const rebased = rebase({ markers, lines, shapes, meta, photoEls });
        setMarkers(rebased.markers); setLines(rebased.lines); setShapes(rebased.shapes);
        setHistory(h => h.map(rebase));
      }
      setPersonal({ view, canvas: source.canvas, glb, projection: surface.projection, depth: nextDepth, depthDetails });
      setModelKind('personal');
      setStatus(`Superficie 3D personal generada desde la foto ${VIEWS.find(v => v.id === view)?.label ?? view} (${surface.indices.length / 3} triángulos). ${depthDetails}${cleared}`);
    } catch (error) {
      if (requestId !== personalRequestRef.current) return;
      setDepth(personal?.depth ?? 1);
      setStatus(`No se pudo generar la superficie personal: ${error instanceof Error ? error.message : 'error desconocido'}. Se mantiene el modelo anterior.`);
    } finally {
      if (requestId === personalRequestRef.current) setBuildingPersonal(false);
    }
  };

  const loadFile = async (file: File, target: ViewKind) => {
    personalRequestRef.current++;
    setBuildingPersonal(false);
    const requestId = ++uploadRequestRef.current;
    if (!file.type.startsWith('image/')) { setStatus('El archivo debe ser una imagen.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setStatus('La imagen supera el límite de 20 MiB.'); return; }
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
    if (requestId !== uploadRequestRef.current) return;
    const replacedPersonal = !!personal;
    if (replacedPersonal) { setPersonal(null); setModelKind('generico'); }
    const personalNote = replacedPersonal ? ` Se actualizaron las fotos; regenera la superficie personal para recalcular la profundidad.${resetModelMarks()}` : '';
    setPhotos(p => ({ ...p, [target]: { canvas: c, aspect: c.width / c.height, frame: defaultFrame(target) } }));
    setCalibrating(false);
    setPhotoAnchor(null);
    setView(target);
    setStatus(`Detectando rostro en la vista ${VIEWS.find(v => v.id === target)?.label ?? target}…`);
    const detected = await detectFrame(c);
    if (requestId !== uploadRequestRef.current) return;
    const label = VIEWS.find(v => v.id === target)?.label ?? target;
    if (!detected.frame) {
      setStatus(`${detected.reason} Sin rostro detectado no se proyectan las marcas 3D; usa una foto nítida con el rostro descubierto o marca directamente sobre la foto.${personalNote}`);
      return;
    }
    const auto = autoRegistration(target, detected.frame, c.width / c.height, flipX);
    const errorSummary = auto ? ` (RMS ${(auto.rmse * 100).toFixed(1)}%)` : '';
    const accepted = isRegistrationAccepted(auto);
    setPhotos(p => (p[target]?.canvas === c ? {
      ...p,
      [target]: {
        ...p[target]!, frame: detected.frame!, landmarks: detected.landmarks, pose: detected.pose, modelAnchors: undefined,
        ...(accepted ? { registration: auto, registrationFlip: flipX, registrationSource: 'auto' as const } : { registration: undefined }),
      },
    } : p));
    setStatus((accepted
      ? `Rostro detectado en vista ${label}; modelo 3D alineado automáticamente (RMS ${(auto.rmse * 100).toFixed(1)}%). Las marcas del modelo ya se proyectan en la foto. Para marcar sobre la anatomía real usa «Superficie 3D personal».`
      : `Rostro detectado en vista ${label}, pero la pose no coincide con el modelo${errorSummary}. Usa una foto ${target === 'frontal' ? 'frontal sin giro' : 'de perfil'}, «Alinear manualmente» o genera la «Superficie 3D personal».`) + personalNote);
  };
  const updateFrame = (k: 'top' | 'bottom' | 'left' | 'right', v: number) => setPhotos(p => {
    const s = p[view]; if (!s) return p;
    const { anchors: _anchors, outline: _outline, ...manualFrame } = s.frame;
    void _anchors; void _outline;
    const n = { ...manualFrame, [k]: v, source: 'manual' as const }, mid = (n.left + n.right) / 2;
    return { ...p, [view]: { ...s, registration: undefined, modelAnchors: undefined, frame: { ...n, axisTop: { x: mid, y: n.top }, axisBottom: { x: mid, y: n.bottom } } } };
  });

  // ── Marcación en modelo 3D ──
  const addMeta = (id: string) => setMeta(m => ({ ...m, [id]: curMeta() }));
  const onMarker = (m: Marker3D) => {
    if (tool3d !== 'point' || !m.id) return;
    if (calibrating) {
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
        setStatus(`Alineación manual rechazada: los anclajes de foto y modelo no coinciden lo suficiente.${fallback.registration ? ' Se mantiene la alineación automática.' : ' No se proyectarán las marcas 3D.'}`);
        return;
      }
      setPhotos(p => p[view]?.canvas === slot.canvas ? { ...p, [view]: { ...p[view]!, modelAnchors: next, registration, registrationFlip: flipX, registrationSource: 'manual' } } : p);
      setStatus(`Alineación manual aceptada; error de validación cruzada: RMS ${(registration.rmse * 100).toFixed(1)}%, máximo ${(registration.maxError * 100).toFixed(1)}% del alto facial. Proyección orientativa.`);
      return;
    }
    snap(); setMarkers(p => [...p, m]); addMeta(m.id);
  };
  const onLine = (l: FreehandLine) => { if (calibrating) return; snap(); setLines(p => [...p, l]); addMeta(l.id); };
  const onShape = (s: SurfaceShape) => { if (calibrating) return; snap(); setShapes(p => [...p, s]); addMeta(s.id); };

  // ── Marcación sobre la foto ──
  const toNorm = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const hitPhoto = (n: P2) => {
    let best: string | null = null, bd = 0.025;
    photoEls.filter(e => e.view === view).forEach(e => {
      const d = e.kind === 'point' ? Math.hypot((e.pts[0].x - n.x) * aspect, e.pts[0].y - n.y)
        : e.kind === 'circle' || e.kind === 'rect' ? Math.hypot((e.pts[0].x - n.x) * aspect, e.pts[0].y - n.y)
          : Math.min(...e.pts.slice(1).map((q, i) => segDist(n, e.pts[i], q, aspect)));
      if (d < bd) { bd = d; best = e.id; }
    });
    return best;
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (photoAnchor !== null && slot) {
      if (e.button !== 0) return;
      correctPhotoAnchor(toNorm(e));
      return;
    }
    if (!hasImage || workMode !== 'foto') return;
    const n = toNorm(e), id = hitPhoto(n);
    if (!isWithinFace(n, frame)) { setStatus('Marca dentro del contorno facial detectado o del marco manual.'); return; }
    if (e.button === 2 || e.altKey) { if (id) { snap(); removeEl(id); } return; }
    const hitEl = photoEls.find(p => p.id === id);
    if (hitEl?.kind === 'point') { snap(); dragRef.current = id; e.currentTarget.setPointerCapture(e.pointerId); return; }
    setDraft({ kind: toolPhoto, pts: [n] });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const correctPhotoAnchor = (point: P2) => {
    if (photoAnchor === null || !slot) return;
    const updated = updateRegistrationAnchor(view, frame, aspect, flipX, photoAnchor, point,
      slot.registrationSource === 'manual' ? slot.modelAnchors : undefined);
    if (!updated) {
      setStatus('Referencia rechazada: marca dentro del rostro y conserva la correspondencia anatómica. La alineación anterior no se modificó.');
      return;
    }
    setPhotos(p => p[view]?.canvas === slot.canvas ? {
      ...p, [view]: { ...p[view]!, ...updated, registrationFlip: flipX, registrationSource: slot.registrationSource ?? 'auto' },
    } : p);
    setStatus(`Referencia «${REGISTRATION_ANCHORS[photoAnchor]}» corregida en foto. Proyección recalculada; sigue siendo orientativa, no una medición clínica.`);
    setPhotoAnchor(null);
  };
  const onMove = (e: React.PointerEvent) => {
    const n = toNorm(e);
    if (!isWithinFace(n, frame)) {
      if (draft) setDraft(null);
      return;
    }
    if (dragRef.current) { setPhotoEls(ps => ps.map(p => (p.id === dragRef.current ? { ...p, pts: [n] } : p))); return; }
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
    if (!draft) return;
    const d = draft; setDraft(null);
    const ok = d.kind === 'point' || (d.pts.length >= 2 && Math.hypot((d.pts[1].x - d.pts[0].x) * aspect, d.pts[1].y - d.pts[0].y) > 0.01);
    if (!ok) return;
    snap();
    setPhotoEls(p => [...p, { ...curMeta(), id: uid(), view, kind: d.kind, pts: d.pts }]);
  };

  const removeEl = (id: string) => {
    setMarkers(p => p.filter(m => m.id !== id)); setLines(p => p.filter(l => l.id !== id)); setShapes(p => p.filter(s => s.id !== id));
    setPhotoEls(p => p.filter(e => e.id !== id)); setMeta(({ [id]: _x, ...rest }) => { void _x; return rest; });
  };
  const editDose = (id: string, v: number) => {
    if (meta[id]) setMeta(m => ({ ...m, [id]: { ...m[id], dose: v } }));
    else setPhotoEls(p => p.map(e => (e.id === id ? { ...e, dose: v } : e)));
  };

  const changeMode = (m: SimMode) => { setMode(m); setDose(SIM_MODES[m].defaultDose); setProduct(''); };
  const doImport = () => {
    try {
      const r = importInjectable(importText, ZONES);
      const n = r.markers.length + r.lines.length + r.shapes.length;
      if (!n) { setStatus('No se encontraron puntos, trazos ni formas con coordenadas 3D en el JSON.'); return; }
      snap();
      setMarkers(p => [...p, ...(r.markersFull as unknown as Marker3D[])]); setLines(p => [...p, ...(r.lines as unknown as FreehandLine[])]);
      setShapes(p => [...p, ...(r.shapes as unknown as SurfaceShape[])]); setMeta(m => ({ ...m, ...r.meta }));
      setStatus(`${n} elementos importados al modelo 3D.${slot?.registration ? ' La vista cuenta con alineación fotográfica revisada.' : ' La foto no mostrará esas marcas hasta completar y aprobar la alineación.'}`);
    } catch { setStatus('JSON inválido.'); }
  };
  const exportPng = () => {
    const c = glRef.current; if (!c) return;
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `simulacion-referencial-${view}.png`; a.click();
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
  const draftEl: Elem | null = draft ? elemsFromPhoto([{ ...curMeta(), id: 'draft', view, kind: draft.kind, pts: draft.pts }], aspect)[0] : null;

  const renderShapes = (list: Elem[], dashed = false) => list.filter(e => e.kind !== 'point').map(e => {
    const col = SIM_MODES[e.mode].color, common = { stroke: col, strokeWidth: 2, fill: 'none', vectorEffect: 'non-scaling-stroke' as const, strokeDasharray: dashed ? '5 4' : undefined };
    if (e.kind === 'circle') return <ellipse key={e.id} cx={e.paths[0][0].x} cy={e.paths[0][0].y} rx={e.rx} ry={e.ry} {...common} fill={col} fillOpacity={0.15} />;
    if (e.kind === 'rect') return <rect key={e.id} x={e.paths[0][0].x - (e.rx ?? 0)} y={e.paths[0][0].y - (e.ry ?? 0)} width={(e.rx ?? 0) * 2} height={(e.ry ?? 0) * 2} {...common} fill={col} fillOpacity={0.15} />;
    return (
      <g key={e.id}>
        {e.paths.map((p, i) => <polyline key={i} points={poly(p)} {...common} />)}
        {e.kind === 'arrow' && e.paths[0].length >= 2 && arrowHead(e.paths[0]).map((h, i) => <line key={i} x1={e.paths[0].at(-1)!.x} y1={e.paths[0].at(-1)!.y} x2={h.x} y2={h.y} {...common} />)}
      </g>
    );
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">Fotos del paciente</span>
          <div className="grid grid-cols-3 gap-1">
            {VIEWS.map(v => (
              <label key={v.id} className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center text-[11px] font-semibold ${view === v.id ? 'border-[#b8944d] bg-amber-50' : 'border-slate-200'} ${photos[v.id] ? 'text-slate-800' : 'text-slate-500'}`}>
                <ImagePlus className="h-4 w-4" aria-hidden="true" />{v.label}{photos[v.id] ? ' ✓' : ''}
                <input type="file" accept="image/*" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f, v.id); e.target.value = ''; }} />
              </label>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-3 gap-1">
            {VIEWS.map(v => <button key={v.id} type="button" disabled={!photos[v.id]} aria-pressed={view === v.id} onClick={() => { personalRequestRef.current++; setBuildingPersonal(false); setCalibrating(false); setPhotoAnchor(null); setView(v.id); }}
              className={`rounded px-1 py-1 text-[11px] ${view === v.id ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-40`}>Ver</button>)}
          </div>
        </div>
        <p className="text-xs text-slate-500" role="status">{status}</p>

        <fieldset className="space-y-2 rounded-xl border border-slate-200 p-3 text-xs">
          <legend className="px-1 font-semibold uppercase text-slate-500">Modelo 3D</legend>
          <div className="grid grid-cols-2 gap-1">
            <button type="button" disabled={buildingPersonal} aria-pressed={modelKind === 'generico'} onClick={useGenericModel}
              className={`rounded-lg px-2 py-1.5 font-semibold ${modelKind === 'generico' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>Genérico</button>
            <button type="button" aria-pressed={modelKind === 'personal'} disabled={buildingPersonal || !slot?.landmarks}
              onClick={activatePersonal}
              className={`rounded-lg px-2 py-1.5 font-semibold ${modelKind === 'personal' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-50`}>
              {buildingPersonal ? 'Generando…' : 'Personal (foto)'}
            </button>
          </div>
          {modelKind === 'personal' && personal ? (
            <>
              <label className="block text-slate-700">Relieve visual: {Math.round(depth * 100)}%
                <input type="range" min={0.75} max={1.25} step={0.05} value={depth} disabled={buildingPersonal || !personalProjection}
                  onChange={e => setDepth(Number(e.target.value))}
                  onPointerUp={e => buildPersonal(Number((e.target as HTMLInputElement).value))}
                  onKeyUp={e => { if (/^(Arrow|Home|End|Page)/.test(e.key)) buildPersonal(Number(e.currentTarget.value)); }}
                  className="w-full accent-[#b8944d]" />
              </label>
              <button type="button" disabled={buildingPersonal || depth === 1 || !personalProjection}
                onClick={() => { setDepth(1); void buildPersonal(1); }}
                className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Restablecer relieve calculado</button>
              <p className="text-amber-800">{personal.depthDetails} El control es una variación visual (75–125%), no una calibración clínica.</p>
              <p className="text-slate-500">La propia foto {VIEWS.find(v => v.id === personal.view)?.label.toLowerCase()} es la superficie 3D, sin cabeza genérica. Gírala para apreciar el relieve; de frente mantiene las proporciones de la foto. La miniatura permite comprobar las marcas. Solo cubre el óvalo facial y la profundidad es estimada, no un escaneo.</p>
              {personal.view !== view && <p className="font-semibold text-amber-700">Esta superficie pertenece a la vista {VIEWS.find(v => v.id === personal.view)?.label}; vuelve a esa vista para ver sus marcas en la foto.</p>}
            </>
          ) : (
            <p className="text-slate-500">{slot?.landmarks ? 'Genera una superficie 3D a partir de esta foto para marcar sobre la anatomía real del paciente.' : 'La superficie personal requiere una foto con rostro detectado.'}</p>
          )}
        </fieldset>

        <div>
          <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">Marcar sobre</span>
          <div className="grid grid-cols-2 gap-1">
            <button type="button" aria-pressed={workMode === '3d'} onClick={() => setWorkMode('3d')} className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold ${workMode === '3d' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}><Box className="h-3.5 w-3.5" aria-hidden="true" />Modelo 3D</button>
            <button type="button" disabled={calibrating} aria-pressed={workMode === 'foto'} onClick={() => setWorkMode('foto')} className={`flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold ${workMode === 'foto' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-50`}><ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />Foto</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {workMode === '3d'
              ? TOOLS_3D.map(t => <button key={t.id} type="button" disabled={calibrating && t.id !== 'point'} aria-pressed={tool3d === t.id} onClick={() => setTool3d(t.id)} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${tool3d === t.id ? 'bg-[#b8944d] text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-50`}>{t.label}</button>)
              : TOOLS_PHOTO.map(t => <button key={t.id} type="button" aria-pressed={toolPhoto === t.id} onClick={() => setToolPhoto(t.id)} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${toolPhoto === t.id ? 'bg-[#b8944d] text-white' : 'bg-slate-100 text-slate-600'}`}>{t.label}</button>)}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">Inyectable (aplica a lo que marques)</span>
          <div className="grid grid-cols-2 gap-1">
            {(Object.keys(SIM_MODES) as SimMode[]).map(m => (
              <button key={m} type="button" onClick={() => changeMode(m)} aria-pressed={mode === m}
                className={`rounded-lg px-2 py-1.5 text-xs font-semibold ${mode === m ? 'text-white' : 'bg-slate-100 text-slate-600'}`}
                style={mode === m ? { background: SIM_MODES[m].color } : undefined}>{SIM_MODES[m].label}</button>
            ))}
          </div>
        </div>
        <label className="block text-xs font-semibold uppercase text-slate-500">Zona
          <select value={zone} onChange={e => setZone(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm normal-case">
            <option value={AUTO_ZONE}>Auto (por posición en el rostro)</option>
            {ZONES.map(z => <option key={z}>{z}</option>)}
          </select>
        </label>
        <label className="block text-xs font-semibold uppercase text-slate-500">Producto
          <select value={product} onChange={e => setProduct(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm normal-case">
            <option value="">—</option>
            {catalog(SIM_MODES[mode].catalog).map(p => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="block text-xs font-semibold uppercase text-slate-500">
          Dosis: {dose} {SIM_MODES[mode].unit}
          <input type="range" min={0.05} max={mode === 'toxina' ? 20 : 2} step={mode === 'toxina' ? 0.5 : 0.05} value={dose}
            onChange={e => setDose(Number(e.target.value))} className="w-full accent-[#b8944d]" />
          <span className="block text-[10px] font-normal normal-case text-slate-400">Por punto; en líneas, flechas, patrones y áreas es la dosis total del trazo. Editable luego en la lista.</span>
        </label>
        <label className="block text-xs font-semibold uppercase text-slate-500">Efecto global: {Math.round(intensity * 100)}%
          <input type="range" min={0} max={1.5} step={0.05} value={intensity} onChange={e => setIntensity(Number(e.target.value))} className="w-full accent-[#b8944d]" />
        </label>
        <label className="block text-xs font-semibold uppercase text-slate-500">Antes | Después
          <input type="range" min={0} max={1} step={0.01} value={split} onChange={e => setSplit(Number(e.target.value))} className="w-full accent-[#b8944d]" />
        </label>

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

        <details className="rounded-xl bg-slate-50 p-3 text-xs">
          <summary className="flex cursor-pointer items-center gap-1 font-semibold uppercase text-slate-500"><ScanFace className="h-3.5 w-3.5" aria-hidden="true" /> Marco / alineación ({VIEWS.find(v => v.id === view)?.label})</summary>
          {slot?.frame.anchors && (
            <div className="mt-2 space-y-2">
              <p className="text-slate-600">Al detectar el rostro, el modelo se alinea automáticamente con los landmarks. Si la proyección no coincide, refínala marcando las referencias en el modelo.</p>
              <label className="block text-slate-700">Corregir referencia en foto
                <select aria-label="Corregir referencia en foto" value={photoAnchor ?? ''}
                  disabled={calibrating}
                  onChange={e => {
                    setDraft(null); dragRef.current = null;
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
                {slot.registration && slot.registrationFlip === flipX ? 'Refinar alineación manualmente' : 'Alinear manualmente'}
              </button>
              {calibrating && (
                <>
                  <p className="font-semibold text-amber-700">Marca {Math.min((slot.modelAnchors?.length ?? 0) + 1, anchorCount)}/{anchorCount} en el modelo: {anchorName(slot.modelAnchors?.length ?? 0)}.</p>
                  <button type="button" onClick={() => {
                    setCalibrating(false);
                    const auto = autoRegistration(view, frame, aspect, flipX);
                    const ok = isRegistrationAccepted(auto);
                    setPhotos(p => p[view] ? { ...p, [view]: { ...p[view]!, modelAnchors: undefined, ...(ok ? { registration: auto, registrationFlip: flipX, registrationSource: 'auto' as const } : { registration: undefined }) } } : p);
                    setStatus(ok ? 'Calibración cancelada; se mantiene la alineación automática.' : 'Calibración cancelada; no se proyectarán marcas 3D.');
                  }} className="w-full rounded border border-slate-300 px-2 py-1 text-slate-700">Cancelar alineación</button>
                </>
              )}
              {slot.registration && slot.registrationFlip === flipX && (
                <p className="text-emerald-700">Alineación {slot.registrationSource === 'manual' ? 'manual' : 'automática'} aceptada · validación cruzada RMS {(slot.registration.rmse * 100).toFixed(1)}% · máximo {(slot.registration.maxError * 100).toFixed(1)}% del alto facial.</p>
              )}
              <p className="text-slate-500">Las marcas del modelo 3D se proyectan solo con una alineación aceptada. Una marca hecha en foto permanece solo en la imagen.</p>
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
          }} />Invertir lado del modelo 3D</label>
        </details>

        <details className="rounded-xl bg-slate-50 p-3 text-xs">
          <summary className="flex cursor-pointer items-center gap-1 font-semibold uppercase text-slate-500"><FileJson className="h-3.5 w-3.5" aria-hidden="true" /> Importar de Inyectables</summary>
          <p className="mt-2 text-slate-500">Pega el registro de inyectable (o su <code>mapping_data</code>): puntos, líneas, flechas, patrones y formas pasan al modelo; la foto requiere alineación revisada.</p>
          <textarea value={importText} onChange={e => setImportText(e.target.value)} rows={4} className="mt-2 w-full rounded border border-slate-300 p-1 font-mono text-[10px]" />
          <button type="button" onClick={doImport} className="mt-2 w-full rounded-lg bg-slate-800 px-2 py-1.5 font-semibold text-white">Importar</button>
        </details>

        <div className="flex gap-2">
          <button type="button" disabled={!history.length} onClick={undo}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-semibold disabled:opacity-40"><Undo2 className="h-3.5 w-3.5" aria-hidden="true" />Deshacer</button>
          <button type="button" disabled={!elems.length && !markers.length && !lines.length && !shapes.length} onClick={clearAll}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-semibold disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Limpiar</button>
          <button type="button" disabled={!hasImage} onClick={exportPng}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-[#b8944d] px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-40"><Download className="h-3.5 w-3.5" aria-hidden="true" />PNG</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={showMarks} onChange={e => setShowMarks(e.target.checked)} />Mostrar marcas sobre la foto</label>
        <p className="text-[11px] text-slate-400">En foto: clic/arrastrar para marcar, arrastrar un punto para moverlo, clic derecho o Alt+clic para borrar. Simulación referencial, no garantiza resultado clínico. Las fotos no salen del navegador.</p>
      </aside>

      <div className={`grid min-w-0 content-start gap-4 ${workMode === '3d' && !personalActive ? 'xl:grid-cols-2' : ''}`}>
        {workMode === '3d' && (
          <section aria-label={personalActive ? 'Foto personal en 3D' : 'Modelo genérico 3D'} className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-900">
            {personalActive && <h2 className="px-3 pt-3 text-sm font-semibold text-white">Tu foto en 3D · arrastra con «Rotar» para ver el relieve</h2>}
            <Clinical3DViewer
              key={personalActive ? 'personal' : 'generico'}
              markers={markers}
              freehandLines={lines}
              surfaceShapes={shapes}
              selectedPathology="filler"
              skipConfirmation
              readOnly={false}
              onMarkerPlaced={onMarker}
              activeTool={tool3d === 'navigate' || tool3d === 'point' ? 'none' : tool3d}
              pendingBrushColor={color}
              pendingBrushThickness={1.5}
              onFreehandLineComplete={onLine}
              onShapeComplete={onShape}
              onFreehandLineUpdated={(id, points, segments) => setLines(p => p.map(l => (l.id === id ? { ...l, points, ...(segments !== undefined ? { segments } : {}) } : l)))}
              onSurfaceShapeUpdated={(id, u) => setShapes(p => p.map(s => (s.id === id ? { ...s, ...u } : s)))}
              haShapeConfig={HA_CONFIG}
              cameraPreset="face"
              modelData={personalActive && personal ? personal.glb : null}
              pointMarkerScale={0.7}
              height="clamp(380px, 78vh, 720px)"
              interactionHint={calibrating
                ? `Anclaje ${Math.min((slot?.modelAnchors?.length ?? 0) + 1, anchorCount)}/${anchorCount}: ${anchorName(slot?.modelAnchors?.length ?? 0)}`
                : tool3d === 'navigate' ? 'Arrastra para rotar'
                  : personalActive ? (personalProjection ? 'Superficie personal: correspondencia directa con la foto' : 'Superficie de otra vista: sus marcas no se proyectan aquí')
                    : slot?.registration ? 'Alineado con la foto; proyección orientativa' : 'Sin alineación: carga una foto con el rostro visible'}
            />
          </section>
        )}
        <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 p-3">
          {personalActive && workMode === '3d' && <h2 className="mb-2 text-center text-xs font-semibold text-slate-200">Vista previa {VIEWS.find(v => v.id === view)?.label.toLowerCase()} · comprobación de marcas</h2>}
          {!hasImage && <div className="flex h-[360px] items-center justify-center text-center text-sm text-slate-400">Carga la foto de la vista «{VIEWS.find(v => v.id === view)?.label}» para ver la simulación</div>}
          <div className={`relative mx-auto max-h-[78vh] touch-none select-none ${hasImage ? '' : 'hidden'} ${workMode === 'foto' ? 'cursor-crosshair' : ''}`}
            style={{ aspectRatio: String(aspect), maxWidth: personalActive && workMode === '3d' ? '220px' : `min(100%, calc(78vh * ${aspect}))` }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onContextMenu={e => e.preventDefault()}>
            <canvas ref={glRef} className="h-full w-full" aria-label="Simulación del rostro" />
            {split > 0 && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split * 100}%` }} />}
            {hasImage && frame.outline && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                <polygon points={poly(frame.outline)} fill="rgba(56,189,248,0.06)" stroke="#38bdf8" strokeWidth="0.0025" strokeDasharray="0.01 0.006" />
                <line x1={frame.axisTop.x} y1={frame.axisTop.y} x2={frame.axisBottom.x} y2={frame.axisBottom.y} stroke="#38bdf8" strokeWidth="0.002" strokeDasharray="0.008 0.006" />
                {frame.anchors?.map((point, index) => (
                  <g key={index}>
                    <circle cx={point.x} cy={point.y} r={photoAnchor === index ? '0.014' : '0.009'} fill={photoAnchor === index ? '#f59e0b' : '#38bdf8'} stroke="white" strokeWidth="0.002" />
                    <text x={point.x + 0.012} y={point.y - 0.01} fill="white" stroke="#0f172a" strokeWidth="0.004" paintOrder="stroke" fontSize="0.025" fontWeight="bold">{index + 1}</text>
                    <title>{REGISTRATION_ANCHORS[index]}</title>
                  </g>
                ))}
              </svg>
            )}
            {showMarks && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                {renderShapes(elems)}
                {draftEl && renderShapes([draftEl], true)}
              </svg>
            )}
            {showMarks && corrected.filter(p => !p.id.includes(':')).map(p => (
              <span key={p.id} className="pointer-events-none absolute block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: SIM_MODES[p.mode].color, outline: p.corrected ? '2px solid #fff' : undefined }}
                title={`${p.zone} · ${p.dose} ${SIM_MODES[p.mode].unit}`} />
            ))}
            {showMarks && corrected.filter(p => p.corrected).map(p => (
              <div key={`raw-${p.id}`} className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50"
                style={{ left: `${p.rawX * 100}%`, top: `${p.rawY * 100}%` }} title="Marca original" />
            ))}
          </div>
          {elems.length > 0 && (
            <ul className="mt-3 max-h-40 space-y-1 overflow-auto text-xs text-slate-200" aria-label="Elementos marcados">
              {elems.map(e => (
                <li key={e.id} className="flex items-center gap-2 rounded bg-white/5 px-2 py-1">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: SIM_MODES[e.mode].color }} />
                  <span className="flex-1 truncate">{e.kind} · {SIM_MODES[e.mode].label} · {e.zone === AUTO_ZONE ? 'auto' : e.zone}</span>
                  <input type="number" min={0.05} step={mode === 'toxina' ? 0.5 : 0.05} value={e.dose} aria-label={`Dosis ${e.kind}`}
                    onChange={ev => editDose(e.id, Math.max(0.05, Number(ev.target.value) || 0.05))} className="w-16 rounded bg-slate-800 px-1 py-0.5 text-right" />
                  <span className="w-5 text-slate-400">{SIM_MODES[e.mode].unit}</span>
                  <button type="button" onClick={() => { snap(); removeEl(e.id); }} aria-label="Eliminar elemento" className="text-slate-400 hover:text-white"><Trash2 className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
