import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '../../components/ui/Tooltip';
import type { P2 } from './engine';
import { SKIN_CANDIDATE_COLORS, SKIN_CANDIDATE_LABELS, skinSignalLayer, skinVisualCandidates, type SkinAppearanceResult, type SkinSignalChannel, type SkinVisualCandidate } from './skinAppearance';
import { analyzeSkinSignalCanvas, composeSkinCandidateTexture, composeSkinSignalTexture, createSkinSignalMask, skinSignalPreview, SKIN_SIGNAL_RESOLUTIONS, type SkinSignalResolution } from './skinSignalTexture';

export interface SkinSignalPanelProps {
  /** Imagen local estable. Si sus píxeles cambian, entrega una nueva instancia. */
  canvas: HTMLCanvasElement;
  /** Coordenadas MediaPipe normalizadas, en la misma orientación que el canvas. */
  landmarks?: readonly P2[];
  /** undefined restaura la textura original; nunca se entrega el canvas de entrada. */
  onTexture: (canvas: HTMLCanvasElement | undefined) => void;
}

const MODES = [
  { value: 'original', label: 'Original' },
  { value: 'redness', label: 'Rojeces' },
  { value: 'contrast', label: 'Pigmentación · contraste aparente' },
  { value: 'texture', label: 'Textura' },
  { value: 'poreCandidates', label: 'Poros-candidatos' },
  { value: 'redDots', label: 'Puntos-rojizos' },
  { value: 'visualCandidates', label: 'Candidatos visuales · cuadros' },
] as const;
type Mode = typeof MODES[number]['value'];
const WARNING = 'Señales visuales aproximadas de RGB, no diagnóstico. Los candidatos no confirman poros ni acné. No identifica acné, poros ni vasos reales, ni mide melanina. La resolución y la luz limitan la señal; maquillaje, ruido y compresión alteran el resultado. Más resolución no garantiza más detalle real. El contorno facial es aproximado: revisa que no incluya pelo ni fondo.';
const percent = new Intl.NumberFormat('es', { style: 'percent', maximumFractionDigits: 1 });

interface CachedAnalysis {
  source: HTMLCanvasElement;
  landmarks: readonly P2[] | undefined;
  sensitivity: number;
  resolution: SkinSignalResolution;
  base: HTMLCanvasElement;
  result: SkinAppearanceResult;
  visualCandidates?: SkinVisualCandidate[];
}

interface CandidateContext {
  source: HTMLCanvasElement;
  landmarks: readonly P2[] | undefined;
  sensitivity: number;
  resolution: SkinSignalResolution;
}
interface CandidateReview extends CandidateContext { ids: string[] }
interface CandidateSnapshot extends CandidateContext { items: SkinVisualCandidate[] }

function sameCandidateContext(a: CandidateContext | undefined, b: CandidateContext): boolean {
  return !!a && a.source === b.source && a.landmarks === b.landmarks
    && a.sensitivity === b.sensitivity && a.resolution === b.resolution;
}

export default function SkinSignalPanel({ canvas, landmarks, onTexture }: SkinSignalPanelProps) {
  const [mode, setMode] = useState<Mode>('original');
  const [sensitivity, setSensitivity] = useState(50);
  const [resolution, setResolution] = useState<SkinSignalResolution>(384);
  const [confirmedSource, setConfirmedSource] = useState<HTMLCanvasElement>();
  const [message, setMessage] = useState('Imagen original. Selecciona una señal visual.');
  const [busy, setBusy] = useState(false);
  const [viewerBoxes, setViewerBoxes] = useState(false);
  const [review, setReview] = useState<CandidateReview>();
  const [snapshot, setSnapshot] = useState<CandidateSnapshot>();
  const isCandidates = mode === 'visualCandidates';
  const analysisResolution = isCandidates ? 384 : resolution;
  const candidateContext: CandidateContext = { source: canvas, landmarks, sensitivity, resolution: analysisResolution };
  const dismissed = sameCandidateContext(review, candidateContext) ? review!.ids : [];
  const candidates = isCandidates && sameCandidateContext(snapshot, candidateContext)
    ? snapshot!.items.filter(item => !dismissed.includes(item.id)) : [];
  const preview = useRef<HTMLCanvasElement>(null);
  const cache = useRef<CachedAnalysis>();
  const callback = useRef(onTexture);
  useEffect(() => { callback.current = onTexture; }, [onTexture]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = (source: HTMLCanvasElement, base: HTMLCanvasElement) => {
      const target = preview.current;
      if (!target) return;
      target.width = base.width; target.height = base.height;
      const context = target.getContext('2d');
      if (!context) throw new Error('No se pudo mostrar la vista previa. Vuelve a abrir el panel.');
      context.drawImage(source, 0, 0, target.width, target.height);
    };
    const fail = (error: unknown) => {
      setBusy(false);
      setSnapshot(undefined);
      setMessage(error instanceof Error && error.name !== 'SecurityError'
        ? error.message : 'No se pudieron leer los píxeles. Usa una captura local sin restricciones de origen.');
    };
    callback.current(undefined);
    setBusy(false);
    if (review && !sameCandidateContext(review, { source: canvas, landmarks, sensitivity, resolution: analysisResolution })) setReview(undefined);
    if (cache.current?.source !== canvas || cache.current.landmarks !== landmarks || cache.current.resolution !== analysisResolution) cache.current = undefined;
    try {
      const base = skinSignalPreview(canvas, analysisResolution);
      draw(base, base);
      if (mode === 'original') {
        setMessage('Imagen original. Selecciona una señal visual.');
      } else if (!landmarks && confirmedSource !== canvas) {
        setMessage('Añade referencias faciales o confirma que el recorte contiene solo piel visible.');
      } else {
        setBusy(true);
        setMessage('Calculando señales locales…');
        // Agrupa cambios del deslizador; cambiar de canal reutiliza el análisis.
        timer = setTimeout(() => {
          try {
            const previous = cache.current;
            const analysis: CachedAnalysis = previous?.source === canvas && previous.landmarks === landmarks && previous.sensitivity === sensitivity && previous.resolution === analysisResolution
              ? previous : { source: canvas, landmarks, sensitivity, resolution: analysisResolution, base, result: analyzeSkinSignalCanvas(base, landmarks, sensitivity / 100) };
            cache.current = analysis;
            if (!analysis.result.usable) {
              setSnapshot(undefined);
              setMessage(`${analysis.result.warnings[0]} Prueba una captura nítida con luz uniforme.`);
            } else if (mode === 'visualCandidates') {
              const context = { source: canvas, landmarks, sensitivity, resolution: analysisResolution };
              const items = analysis.visualCandidates ??= skinVisualCandidates(analysis.result,
                createSkinSignalMask(base.width, base.height, landmarks), base.width, base.height);
              const ids = sameCandidateContext(review, context) ? review!.ids : [];
              const visible = items.filter(item => !ids.includes(item.id));
              draw(composeSkinCandidateTexture(analysis.base, visible), analysis.base);
              if (viewerBoxes && visible.length) callback.current(composeSkinCandidateTexture(canvas, visible));
              setSnapshot({ ...context, items });
              setMessage(`${visible.length} candidatos visuales visibles; ${items.length - visible.length} descartados. `
                + 'Máximo 24 cuadros; se omiten señales extensas o sin soporte. No indica presencia ni ausencia de alteraciones.');
            } else {
              const channel: SkinSignalChannel = mode;
              const layer = skinSignalLayer(analysis.result, channel);
              const output = composeSkinSignalTexture(canvas, analysis.base, analysis.result, channel);
              draw(output, analysis.base);
              setMessage(layer.status === 'highlighted'
                ? `${percent.format(layer.coverage)} del área seleccionada resaltada; no es una medida clínica.`
                : 'Sin señal visual resaltada con esta sensibilidad; no indica ausencia de alteraciones.');
              callback.current(output);
            }
            setBusy(false);
          } catch (error) { cache.current = undefined; fail(error); }
        }, 120);
      }
    } catch (error) {
      cache.current = undefined;
      if (preview.current) { preview.current.width = 0; preview.current.height = 0; }
      fail(error);
    }
    return () => { clearTimeout(timer); callback.current(undefined); };
  }, [canvas, landmarks, mode, sensitivity, analysisResolution, confirmedSource, review, viewerBoxes]);

  return <section aria-label="Señales visuales aproximadas de piel" className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Señales de piel · RGB local</h3>
      <Tooltip content={WARNING} position="bottom">
        <button type="button" className="admin-focus-ring rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100">Límites · no diagnóstico</button>
      </Tooltip>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="min-w-0">Vista
        <select name="skin-signal-mode" value={mode} onChange={event => {
          const value = event.target.value;
          if (MODES.some(option => option.value === value)) setMode(value as Mode);
        }} className="admin-focus-ring mt-1 w-full rounded border border-slate-300 bg-white p-2 text-slate-800">
          {MODES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label>Sensibilidad · {sensitivity}%
        <input name="skin-signal-sensitivity" type="range" min={0} max={100} step={5} value={sensitivity} disabled={mode === 'original'}
          onChange={event => setSensitivity(Number(event.target.value))}
          className="admin-focus-ring mt-3 block w-full accent-slate-800" />
      </label>
      <label className="min-w-0 sm:col-span-2">Resolución de análisis · sin ampliar
        <select name="skin-signal-resolution" value={analysisResolution} disabled={isCandidates} onChange={event => {
          const value = Number(event.target.value);
          const option = SKIN_SIGNAL_RESOLUTIONS.find(item => item.value === value);
          if (option) setResolution(option.value);
        }} className="admin-focus-ring mt-1 w-full rounded border border-slate-300 bg-white p-2 text-slate-800">
          {SKIN_SIGNAL_RESOLUTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
    {!landmarks && <label className="flex items-start gap-2 text-xs">
      <input type="checkbox" checked={confirmedSource === canvas} onChange={event => setConfirmedSource(event.target.checked ? canvas : undefined)}
        className="admin-focus-ring mt-0.5" />
      El recorte contiene solo piel visible, sin ojos, labios, pelo ni fondo.
    </label>}
    <label className="flex items-start gap-2">
      <input name="skin-candidates-enabled" type="checkbox" checked={isCandidates}
        onChange={event => setMode(event.target.checked ? 'visualCandidates' : 'original')}
        className="admin-focus-ring mt-0.5" />
      Activar cuadros de candidatos visuales
    </label>
    {isCandidates && <div className="space-y-2">
      <p className="text-xs text-slate-700">Análisis local limitado a 384 px. Sombras, barba y reflejos pueden generar cuadros falsos; ruido, maquillaje y compresión también. Los cuadros no son diagnósticos ni identifican lesiones.</p>
      <label className="flex items-start gap-2 text-xs">
        <input name="skin-candidates-viewer" type="checkbox" checked={viewerBoxes}
          onChange={event => setViewerBoxes(event.target.checked)} className="admin-focus-ring mt-0.5" />
        Mostrar también los cuadros en el visor (copia temporal)
      </label>
      {candidates.length > 0 && <ol aria-label="Candidatos visuales para revisión manual" className="max-h-48 space-y-1 overflow-y-auto">
        {candidates.map((candidate, index) => <li key={candidate.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span><span aria-hidden="true" className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: SKIN_CANDIDATE_COLORS[candidate.channel] }} />{index + 1}. {SKIN_CANDIDATE_LABELS[candidate.channel]} · posición {Math.round(candidate.x * 100)}%, {Math.round(candidate.y * 100)}%</span>
          <button type="button" aria-label={`Descartar candidato ${index + 1}: ${SKIN_CANDIDATE_LABELS[candidate.channel]}`}
            onClick={() => setReview(previous => ({
              ...candidateContext,
              ids: [...(sameCandidateContext(previous, candidateContext) ? previous!.ids : []), candidate.id],
            }))} className="admin-focus-ring rounded border border-slate-300 px-2 py-1 hover:bg-slate-100">Descartar</button>
        </li>)}
      </ol>}
      {dismissed.length > 0 && <button type="button" onClick={() => setReview(undefined)}
        className="admin-focus-ring rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">Restablecer descartados</button>}
      <p className="text-xs text-slate-600">El descarte es temporal para esta imagen, referencias y sensibilidad; al cambiarlas se inicia otra revisión.</p>
    </div>}
    <canvas ref={preview} role="img" aria-label={`Resultado visual: ${MODES.find(option => option.value === mode)?.label}`}
      className="mx-auto block h-auto max-h-64 max-w-full rounded-lg object-contain">
      Vista previa local de señales RGB; el resultado se describe debajo.
    </canvas>
    <p role="status" aria-live="polite" aria-busy={busy} className="text-xs text-slate-600">{message}</p>
    <p className="text-xs text-slate-500">Solo en memoria local · sin subidas ni guardado.</p>
  </section>;
}
