import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '../../components/ui/Tooltip';
import type { P2 } from './engine';
import { skinSignalLayer, type SkinAppearanceResult, type SkinSignalChannel } from './skinAppearance';
import { analyzeSkinSignalCanvas, composeSkinSignalTexture, skinSignalPreview, SKIN_SIGNAL_RESOLUTIONS, type SkinSignalResolution } from './skinSignalTexture';

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
}

export default function SkinSignalPanel({ canvas, landmarks, onTexture }: SkinSignalPanelProps) {
  const [mode, setMode] = useState<Mode>('original');
  const [sensitivity, setSensitivity] = useState(50);
  const [resolution, setResolution] = useState<SkinSignalResolution>(384);
  const [confirmedSource, setConfirmedSource] = useState<HTMLCanvasElement>();
  const [message, setMessage] = useState('Imagen original. Selecciona una señal visual.');
  const [busy, setBusy] = useState(false);
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
      setMessage(error instanceof Error && error.name !== 'SecurityError'
        ? error.message : 'No se pudieron leer los píxeles. Usa una captura local sin restricciones de origen.');
    };
    callback.current(undefined);
    setBusy(false);
    if (cache.current?.source !== canvas || cache.current.landmarks !== landmarks || cache.current.resolution !== resolution) cache.current = undefined;
    try {
      const base = skinSignalPreview(canvas, resolution);
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
            const analysis = previous?.source === canvas && previous.landmarks === landmarks && previous.sensitivity === sensitivity && previous.resolution === resolution
              ? previous : { source: canvas, landmarks, sensitivity, resolution, base, result: analyzeSkinSignalCanvas(base, landmarks, sensitivity / 100) };
            cache.current = analysis;
            if (!analysis.result.usable) {
              setMessage(`${analysis.result.warnings[0]} Prueba una captura nítida con luz uniforme.`);
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
  }, [canvas, landmarks, mode, sensitivity, resolution, confirmedSource]);

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
        <select name="skin-signal-resolution" value={resolution} onChange={event => {
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
    <canvas ref={preview} aria-label={`Resultado visual: ${MODES.find(option => option.value === mode)?.label}`}
      className="mx-auto block h-auto max-h-64 max-w-full rounded-lg object-contain">
      Vista previa local de señales RGB; el resultado se describe debajo.
    </canvas>
    <p role="status" aria-live="polite" aria-busy={busy} className="text-xs text-slate-600">{message}</p>
    <p className="text-xs text-slate-500">Solo en memoria local · sin subidas ni guardado.</p>
  </section>;
}
