import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, ImagePlus, Trash2, Wand2, Undo2, FileJson, ScanFace } from 'lucide-react';
import injectablesCatalog from '../../components/admin/ficha-clinica/data/injectables.json';
import {
  DEFAULT_FRAME, MAX_EFFECTS, SIM_MODES, buildEffects, correctPoints, frameFromLandmarks, importInjectable,
  type FaceFrame, type SimMode, type SimPoint,
} from './engine';

const catalog = (cat: string) => (injectablesCatalog as { categoria: string; elemento: string }[])
  .filter(i => i.categoria === cat).map(i => i.elemento);
const ZONES = ['tercio_superior', 'tercio_medio', 'tercio_inferior'].flatMap(catalog);
const MAX_SIDE = 1400;

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
async function detectFrame(img: HTMLCanvasElement): Promise<FaceFrame | null> {
  try {
    const head = await fetch('/models/face/face_landmarker.task', { method: 'HEAD' });
    if (!head.ok) return null;
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    const lm = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/face/face_landmarker.task' }, runningMode: 'IMAGE', numFaces: 1,
    });
    const res = lm.detect(img); lm.close();
    return res.faceLandmarks[0] ? frameFromLandmarks(res.faceLandmarks[0]) : null;
  } catch { return null; }
}

const uid = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export default function FaceSimLab() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const dragRef = useRef<string | null>(null);
  const [aspect, setAspect] = useState(0.75);
  const [hasImage, setHasImage] = useState(false);
  const [frame, setFrame] = useState<FaceFrame>(DEFAULT_FRAME);
  const [points, setPoints] = useState<SimPoint[]>([]);
  const [history, setHistory] = useState<SimPoint[][]>([]);
  const [mode, setMode] = useState<SimMode>('toxina');
  const [zone, setZone] = useState('Frente');
  const [product, setProduct] = useState('');
  const [dose, setDose] = useState(SIM_MODES.toxina.defaultDose);
  const [intensity, setIntensity] = useState(1);
  const [split, setSplit] = useState(0);
  const [correct, setCorrect] = useState({ enabled: true, linear: true, mirror: true, tolerance: 0.02 });
  const [flipX, setFlipX] = useState(false);
  const [showPoints, setShowPoints] = useState(true);
  const [status, setStatus] = useState('Carga una foto frontal para comenzar.');
  const [importText, setImportText] = useState('');

  const corrected = useMemo(
    () => correctPoints(points, { ...correct, aspect, frame }),
    [points, correct, aspect, frame],
  );
  const stats = useMemo(() => {
    const fixed = corrected.filter(p => p.corrected);
    return { fixed: fixed.length, asis: corrected.length - fixed.length, mean: fixed.length ? fixed.reduce((s, p) => s + p.shift, 0) / fixed.length : 0 };
  }, [corrected]);

  // Render en tiempo real: cualquier cambio redibuja el shader.
  useEffect(() => {
    if (!hasImage || !rendererRef.current) return;
    const id = requestAnimationFrame(() => rendererRef.current?.draw(buildEffects(corrected, frame, aspect, intensity), aspect, split));
    return () => cancelAnimationFrame(id);
  }, [corrected, frame, aspect, intensity, split, hasImage]);
  useEffect(() => () => rendererRef.current?.dispose(), []);

  const commit = useCallback((next: SimPoint[]) => { setHistory(h => [...h.slice(-30), points]); setPoints(next); }, [points]);

  const loadFile = async (file: File) => {
    if (!file.type.startsWith('image/')) { setStatus('El archivo debe ser una imagen.'); return; }
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    imgRef.current = c;
    rendererRef.current?.dispose();
    try { rendererRef.current = createRenderer(glRef.current!, c); } catch (e) { setStatus(`WebGL: ${(e as Error).message}`); return; }
    if (!rendererRef.current) { setStatus('Este navegador no soporta WebGL.'); return; }
    setAspect(c.width / c.height); setHasImage(true); setPoints([]); setHistory([]);
    setStatus('Detectando rostro…');
    const f = await detectFrame(c);
    setFrame(f ?? DEFAULT_FRAME);
    setStatus(f ? 'Rostro detectado (MediaPipe, 478 landmarks). Haz clic en la foto para marcar.'
      : 'Marco facial manual (sin modelo MediaPipe: ejecuta npm run lab:face-assets). Ajusta el marco y marca.');
  };

  const toNorm = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const hit = (n: { x: number; y: number }) => points.find(p => Math.hypot((p.x - n.x) * aspect, p.y - n.y) < 0.02)?.id ?? null;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hasImage) return;
    const n = toNorm(e), id = hit(n);
    if (e.button === 2 || e.altKey) { if (id) commit(points.filter(p => p.id !== id)); return; }
    if (id) { dragRef.current = id; setHistory(h => [...h.slice(-30), points]); e.currentTarget.setPointerCapture(e.pointerId); return; }
    commit([...points, { id: uid(), mode, x: n.x, y: n.y, dose, zone, product: product || undefined }]);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const n = toNorm(e);
    setPoints(ps => ps.map(p => (p.id === dragRef.current ? { ...p, ...n } : p)));
  };

  const changeMode = (m: SimMode) => { setMode(m); setDose(SIM_MODES[m].defaultDose); setProduct(''); };
  const doImport = () => {
    try {
      const imported = importInjectable(importText, frame, flipX);
      if (!imported.length) { setStatus('No se encontraron puntos con coordenadas 3D en el JSON.'); return; }
      commit([...points, ...imported]); setStatus(`${imported.length} puntos importados desde la ficha de inyectables.`);
    } catch { setStatus('JSON inválido.'); }
  };
  const exportPng = () => {
    const c = glRef.current; if (!c) return;
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'simulacion-referencial.png'; a.click();
  };
  const updateFrame = (k: 'top' | 'bottom' | 'left' | 'right', v: number) => setFrame(f => {
    const n = { ...f, [k]: v, source: 'manual' as const };
    const mid = (n.left + n.right) / 2;
    return { ...n, axisTop: { x: mid, y: n.top }, axisBottom: { x: mid, y: n.bottom } };
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-3 py-3 text-sm font-semibold text-slate-700 hover:border-[#b8944d]">
          <ImagePlus className="h-4 w-4" aria-hidden="true" /> Cargar foto frontal
          <input type="file" accept="image/*" className="sr-only" onChange={e => e.target.files?.[0] && loadFile(e.target.files[0])} />
        </label>
        <p className="text-xs text-slate-500" role="status">{status}</p>

        <div>
          <span className="mb-1 block text-xs font-semibold uppercase text-slate-500">Inyectable</span>
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
          Dosis por punto: {dose} {SIM_MODES[mode].unit}
          <input type="range" min={0.05} max={mode === 'toxina' ? 20 : 2} step={mode === 'toxina' ? 0.5 : 0.05} value={dose}
            onChange={e => {
              const v = Number(e.target.value); setDose(v);
              if (dragRef.current === null && corrected.length) setPoints(ps => ps.map((p, i) => (i === ps.length - 1 && p.mode === mode ? { ...p, dose: v } : p)));
            }} className="w-full accent-[#b8944d]" />
          <span className="block text-[10px] font-normal normal-case text-slate-400">También ajusta el último punto marcado.</span>
        </label>
        <label className="block text-xs font-semibold uppercase text-slate-500">Efecto global: {Math.round(intensity * 100)}%
          <input type="range" min={0} max={1.5} step={0.05} value={intensity} onChange={e => setIntensity(Number(e.target.value))} className="w-full accent-[#b8944d]" />
        </label>
        <label className="block text-xs font-semibold uppercase text-slate-500">Antes | Después
          <input type="range" min={0} max={1} step={0.01} value={split} onChange={e => setSplit(Number(e.target.value))} className="w-full accent-[#b8944d]" />
        </label>

        <fieldset className="space-y-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
          <legend className="flex items-center gap-1 px-1 font-semibold uppercase text-slate-500"><Wand2 className="h-3.5 w-3.5" aria-hidden="true" /> Corrección estadística</legend>
          {([['enabled', 'Activar estimación robusta'], ['linear', 'Alinear marcas lineales (frente, mandíbula)'], ['mirror', 'Corregir por simetría (espejo)']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={correct[k]} onChange={e => setCorrect(c => ({ ...c, [k]: e.target.checked }))} />{l}</label>
          ))}
          <label className="block">Tolerancia: {(correct.tolerance * 100).toFixed(1)}% alto facial
            <input type="range" min={0.005} max={0.06} step={0.001} value={correct.tolerance} onChange={e => setCorrect(c => ({ ...c, tolerance: Number(e.target.value) }))} className="w-full accent-[#b8944d]" />
          </label>
          <p className="text-slate-500">Ajuste con biponderado de Tukey: los errores pequeños se corrigen; los atípicos (asimetrías reales) se simulan tal como se marcaron.
            Corregidos: <b>{stats.fixed}</b> · Tal cual: <b>{stats.asis}</b>{stats.fixed ? ` · desvío medio ${(stats.mean * 100).toFixed(2)}%` : ''}</p>
        </fieldset>

        <details className="rounded-xl bg-slate-50 p-3 text-xs">
          <summary className="flex cursor-pointer items-center gap-1 font-semibold uppercase text-slate-500"><ScanFace className="h-3.5 w-3.5" aria-hidden="true" /> Marco facial</summary>
          {(['top', 'bottom', 'left', 'right'] as const).map(k => (
            <label key={k} className="mt-2 block capitalize">{k}
              <input type="range" min={0} max={1} step={0.005} value={frame[k]} onChange={e => updateFrame(k, Number(e.target.value))} className="w-full accent-[#b8944d]" />
            </label>
          ))}
        </details>

        <details className="rounded-xl bg-slate-50 p-3 text-xs">
          <summary className="flex cursor-pointer items-center gap-1 font-semibold uppercase text-slate-500"><FileJson className="h-3.5 w-3.5" aria-hidden="true" /> Importar de Inyectables</summary>
          <p className="mt-2 text-slate-500">Pega el registro de inyectable (o su <code>mapping_data</code>) de la ficha clínica; los puntos 3D se proyectan al marco facial.</p>
          <textarea value={importText} onChange={e => setImportText(e.target.value)} rows={4} className="mt-2 w-full rounded border border-slate-300 p-1 font-mono text-[10px]" />
          <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={flipX} onChange={e => setFlipX(e.target.checked)} />Invertir eje X</label>
          <button type="button" onClick={doImport} className="mt-2 w-full rounded-lg bg-slate-800 px-2 py-1.5 font-semibold text-white">Importar puntos</button>
        </details>

        <div className="flex gap-2">
          <button type="button" disabled={!history.length} onClick={() => { setPoints(history.at(-1)!); setHistory(h => h.slice(0, -1)); }}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-semibold disabled:opacity-40"><Undo2 className="h-3.5 w-3.5" aria-hidden="true" />Deshacer</button>
          <button type="button" disabled={!points.length} onClick={() => commit([])}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-semibold disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Limpiar</button>
          <button type="button" disabled={!hasImage} onClick={exportPng}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-[#b8944d] px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-40"><Download className="h-3.5 w-3.5" aria-hidden="true" />PNG</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={showPoints} onChange={e => setShowPoints(e.target.checked)} />Mostrar puntos</label>
        <p className="text-[11px] text-slate-400">Clic: marcar · arrastrar: mover · clic derecho / Alt+clic: borrar. Simulación referencial, no garantiza resultado clínico. La foto no sale del navegador.</p>
      </aside>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 p-3">
        {!hasImage && <div className="flex h-[480px] items-center justify-center text-sm text-slate-400">Sin foto cargada</div>}
        <div ref={wrapRef} className={`relative mx-auto max-h-[78vh] touch-none select-none ${hasImage ? '' : 'hidden'}`}
          style={{ aspectRatio: String(aspect), maxWidth: `min(100%, calc(78vh * ${aspect}))` }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { dragRef.current = null; }} onContextMenu={e => e.preventDefault()}>
          <canvas ref={glRef} className="h-full w-full" aria-label="Simulación del rostro" />
          {split > 0 && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split * 100}%` }} />}
          {showPoints && corrected.map(p => (
            <span key={p.id} className="pointer-events-none absolute block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: SIM_MODES[p.mode].color, outline: p.corrected ? '2px solid #fff' : undefined }}
              title={`${p.zone} · ${p.dose} ${SIM_MODES[p.mode].unit}`} />
          ))}
          {showPoints && corrected.filter(p => p.corrected).map(p => (
            <div key={`raw-${p.id}`} className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50"
              style={{ left: `${p.rawX * 100}%`, top: `${p.rawY * 100}%` }} title="Marca original" />
          ))}
        </div>
      </section>
    </div>
  );
}
