import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent } from 'react';
import type { P2 } from './engine';
import { analyzeSkinAppearance } from './skinAppearance';
import { createSkinSignalMask, skinSignalPreview } from './skinSignalTexture';
import {
  applySkinRegionRgb, createSkinRegionMask, createSkinReviewRegion, isValidSkinPolygon,
  pointInValidatedSkinPolygon, SKIN_REVIEW_LABELS, type SkinReviewRegion,
} from './skinRegionReview';

interface SkinRegionEditorProps {
  canvas: HTMLCanvasElement;
  landmarks?: readonly P2[];
  onTexture: (canvas: HTMLCanvasElement | undefined) => void;
  onRegionsChange?: (regions: readonly SkinReviewRegion[]) => void;
}

type DrawMode = 'rectangle' | 'freehand';
interface AnalysisSnapshot {
  regionId: string;
  result: ReturnType<typeof analyzeSkinAppearance>;
  roiPixels: number;
}
interface DrawDraft {
  mode: DrawMode;
  start: P2;
  points: P2[];
}
interface SourceContext {
  canvas: HTMLCanvasElement;
  landmarks?: readonly P2[];
}

const GOLD_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';
const BUTTON = `rounded-md border border-amber-700/70 px-2.5 py-1.5 text-xs text-amber-100 transition hover:border-amber-400 hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-45 ${GOLD_FOCUS}`;
const numberFormat = new Intl.NumberFormat('es', { style: 'percent', maximumFractionDigits: 1 });
let nextRegionId = 0;

function cloneRegions(regions: readonly SkinReviewRegion[]): SkinReviewRegion[] {
  return regions.map(region => ({
    ...region,
    polygon: region.polygon.map(point => ({ ...point })),
    adjustments: { ...region.adjustments },
  }));
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const output = document.createElement('canvas');
  output.width = source.width;
  output.height = source.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('No se pudo preparar una copia local de la imagen.');
  context.drawImage(source, 0, 0);
  return output;
}

function drawRegionOutput(
  source: HTMLCanvasElement,
  base: HTMLCanvasElement,
  regions: readonly SkinReviewRegion[],
  landmarks?: readonly P2[],
): HTMLCanvasElement | undefined {
  const active = regions.filter(region => region.verified
    && Object.values(region.adjustments).some(value => Number.isFinite(value) && value !== 0));
  if (!active.length || !landmarks) return undefined;
  const baseContext = base.getContext('2d', { willReadFrequently: true });
  if (!baseContext) throw new Error('No se pudo revisar la imagen local.');
  const baseImage = baseContext.getImageData(0, 0, base.width, base.height);
  const safeMask = createSkinSignalMask(base.width, base.height, landmarks);
  const output = copyCanvas(source);
  const context = output.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No se pudo componer la vista previa local.');

  for (const region of active) {
    const mask = createSkinRegionMask(base.width, base.height, region.polygon, safeMask);
    if (!mask.some(Boolean)) continue;
    const edited = applySkinRegionRgb(baseImage, safeMask, [region]);
    const minX = Math.max(0, Math.floor(Math.min(...region.polygon.map(point => point.x)) * source.width));
    const minY = Math.max(0, Math.floor(Math.min(...region.polygon.map(point => point.y)) * source.height));
    const maxX = Math.min(source.width, Math.ceil(Math.max(...region.polygon.map(point => point.x)) * source.width));
    const maxY = Math.min(source.height, Math.ceil(Math.max(...region.polygon.map(point => point.y)) * source.height));
    const width = maxX - minX, height = maxY - minY;
    if (width < 1 || height < 1) continue;
    const crop = context.getImageData(minX, minY, width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const u = (minX + x + 0.5) / source.width, v = (minY + y + 0.5) / source.height;
      if (!pointInValidatedSkinPolygon(u, v, region.polygon)) continue;
      const baseX = Math.min(base.width - 1, Math.floor(u * base.width));
      const baseY = Math.min(base.height - 1, Math.floor(v * base.height));
      if (!safeMask[baseY * base.width + baseX]) continue;
      const from = (baseY * base.width + baseX) * 4;
      const to = (y * width + x) * 4;
      crop.data[to] = edited[from];
      crop.data[to + 1] = edited[from + 1];
      crop.data[to + 2] = edited[from + 2];
    }
    context.putImageData(crop, minX, minY);
  }
  return output;
}

function statusSummary(snapshot: AnalysisSnapshot): string {
  if (!snapshot.result.usable) return 'Sin sugerencia visual utilizable en esta zona. No indica presencia ni ausencia de una alteración.';
  const channels = Object.values(snapshot.result.channels);
  const visible = channels.filter(channel => channel.status === 'highlighted').length;
  return visible
    ? `${visible} variación(es) cromática(s)/textural(es) RGB visibles en el área revisada; son aproximaciones, no medidas clínicas.`
    : 'Sin sugerencia cromática o textural visible en este ROI. No indica ausencia de una alteración.';
}

export default function SkinRegionEditor({ canvas, landmarks, onTexture, onRegionsChange }: SkinRegionEditorProps) {
  const [context, setContext] = useState<SourceContext>(() => ({ canvas, landmarks }));
  const contextMatches = context.canvas === canvas && context.landmarks === landmarks;
  const [base, setBase] = useState<HTMLCanvasElement>();
  const [regions, setRegions] = useState<SkinReviewRegion[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [drawMode, setDrawMode] = useState<DrawMode>('rectangle');
  const [keyboardPoint, setKeyboardPoint] = useState<P2>({ x: 0.5, y: 0.5 });
  const [draft, setDraft] = useState<P2[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisSnapshot>();
  const [busy, setBusy] = useState(false);
  const [showBefore, setShowBefore] = useState(false);
  const [resetAcknowledged, setResetAcknowledged] = useState(false);
  const [message, setMessage] = useState('Delimita una zona de forma manual; el análisis solo se ejecuta al solicitarlo.');
  const [customLabel, setCustomLabel] = useState('');
  const previewRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<DrawDraft>();
  const pendingRef = useRef<ReturnType<typeof setTimeout>>();
  const generationRef = useRef(0);
  const textureCallback = useRef(onTexture);
  const regionsCallback = useRef(onRegionsChange);
  useEffect(() => { textureCallback.current = onTexture; }, [onTexture]);
  useEffect(() => { regionsCallback.current = onRegionsChange; }, [onRegionsChange]);
  const invalidateAnalysis = () => {
    generationRef.current++;
    clearTimeout(pendingRef.current);
    setBusy(false);
    setAnalysis(undefined);
  };

  useEffect(() => {
    if (!contextMatches) {
      generationRef.current++;
      clearTimeout(pendingRef.current);
      setContext({ canvas, landmarks });
      setRegions([]);
      setActiveId(undefined);
      setAnalysis(undefined);
      setDraft([]);
      setBusy(false);
      setShowBefore(false);
      setResetAcknowledged(false);
      drawingRef.current = undefined;
      setCustomLabel('');
      setMessage('Cambió la imagen o sus referencias: las zonas y revisiones anteriores se descartaron.');
      setBase(undefined);
      textureCallback.current(undefined);
      return;
    }
    try {
      const preview = skinSignalPreview(canvas, 768);
      setBase(preview);
      setMessage('Delimita una zona de forma manual; el análisis solo se ejecuta al solicitarlo.');
    } catch (error) {
      setBase(undefined);
      setMessage(error instanceof Error ? error.message : 'No se pudo preparar la imagen local.');
    }
  // `contextMatches` deliberately gates source changes without re-copying on state updates.
  }, [canvas, landmarks, contextMatches]);

  useEffect(() => {
    const target = previewRef.current, image = base;
    if (!target || !image) return;
    target.width = image.width;
    target.height = image.height;
    const context2d = target.getContext('2d');
    if (!context2d) return;
    context2d.drawImage(image, 0, 0);
    if (showBefore) return;
    const adjustedRegions = regions.filter(region => region.verified
      && Object.values(region.adjustments).some(value => Number.isFinite(value) && value !== 0));
    if (landmarks && adjustedRegions.length) {
      try {
        const imageData = context2d.getImageData(0, 0, image.width, image.height);
        const safeMask = createSkinSignalMask(image.width, image.height, landmarks);
        imageData.data.set(applySkinRegionRgb(imageData, safeMask, adjustedRegions));
        context2d.putImageData(imageData, 0, 0);
      } catch (error) {
        textureCallback.current(undefined);
        setMessage(error instanceof Error ? error.message : 'No se pudo aplicar el retoque de la zona.');
      }
    }
  }, [base, landmarks, regions, showBefore]);

  useEffect(() => {
    regionsCallback.current?.(showBefore || resetAcknowledged
      ? []
      : cloneRegions(regions.filter(region => region.verified)));
  }, [regions, resetAcknowledged, showBefore]);

  useEffect(() => {
    if (draft.length === 0) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      drawingRef.current = undefined;
      setDraft([]);
      setMessage('Trazado cancelado.');
    };
    window.addEventListener('keydown', cancelOnEscape);
    return () => window.removeEventListener('keydown', cancelOnEscape);
  }, [draft.length]);

  useEffect(() => {
    if (!base || !contextMatches || showBefore || !regions.some(region => region.verified)) {
      textureCallback.current(undefined);
      return;
    }
    // La vista de 768 px se actualiza sin demora; agrupa la copia de resolución original durante el arrastre.
    const timer = setTimeout(() => {
      try {
        textureCallback.current(drawRegionOutput(canvas, base, regions, landmarks));
      } catch (error) {
        textureCallback.current(undefined);
        setMessage(error instanceof Error ? error.message : 'No se pudo aplicar la vista previa local.');
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [base, canvas, contextMatches, landmarks, regions, showBefore]);

  const selected = regions.find(region => region.id === activeId);
  const selectedAnalysis = selected && analysis?.regionId === selected.id ? analysis : undefined;
  const pointsText = (points: readonly P2[]) => points.map(point => `${point.x},${point.y}`).join(' ');
  const getPoint = (event: PointerEvent<SVGSVGElement>): P2 => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };
  const beginDraw = (event: PointerEvent<SVGSVGElement>) => {
    if (!base || !contextMatches) return;
    invalidateAnalysis();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    drawingRef.current = { mode: drawMode, start: point, points: [point] };
    setDraft([point]);
  };
  const moveDraw = (event: PointerEvent<SVGSVGElement>) => {
    const current = drawingRef.current;
    if (!current) return;
    const point = getPoint(event);
    if (current.mode === 'rectangle') {
      setDraft([
        current.start, { x: point.x, y: current.start.y }, point,
        { x: current.start.x, y: point.y },
      ]);
    } else if (current.points.length < 510) {
      const previous = current.points[current.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.003) {
        current.points.push(point);
        setDraft([...current.points]);
      }
    }
  };
  const commitPolygon = (polygon: P2[]) => {
    if (!isValidSkinPolygon(polygon)) {
      setMessage('El trazado es demasiado pequeño o inválido. Intenta delimitarlo de nuevo.');
      return;
    }
    const replacingId = selected?.id;
    const previous = regions.find(region => region.id === replacingId);
    const id = replacingId ?? `zona-${Date.now()}-${++nextRegionId}`;
    const created = createSkinReviewRegion(id, polygon, previous?.label ?? '');
    setRegions(currentRegions => previous
      ? currentRegions.map(region => region.id === id ? { ...created, label: previous.label } : region)
      : [...currentRegions, created]);
    setActiveId(id);
    invalidateAnalysis();
    setCustomLabel(previous?.label === 'Otra' ? previous.label : '');
    setMessage('Zona delimitada. Elige una etiqueta y solicita el análisis local para revisarla.');
  };
  const finishDraw = (event: PointerEvent<SVGSVGElement>) => {
    const current = drawingRef.current;
    if (!current) return;
    const point = getPoint(event);
    const polygon = current.mode === 'rectangle'
      ? [current.start, { x: point.x, y: current.start.y }, point, { x: current.start.x, y: point.y }]
      : [...current.points, point];
    drawingRef.current = undefined;
    setDraft([]);
    commitPolygon(polygon);
  };
  const handleCanvasKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const step = event.shiftKey ? 0.05 : 0.02;
      setKeyboardPoint(point => ({
        x: Math.max(0.08, Math.min(0.92, point.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0))),
        y: Math.max(0.08, Math.min(0.92, point.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))),
      }));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const radius = 0.08;
      commitPolygon([
        { x: keyboardPoint.x - radius, y: keyboardPoint.y - radius },
        { x: keyboardPoint.x + radius, y: keyboardPoint.y - radius },
        { x: keyboardPoint.x + radius, y: keyboardPoint.y + radius },
        { x: keyboardPoint.x - radius, y: keyboardPoint.y + radius },
      ]);
    }
  };

  const chooseLabel = (label: string) => {
    if (!selected) return;
    invalidateAnalysis();
    setRegions(currentRegions => currentRegions.map(region => region.id === selected.id
      ? {
        ...region, label, verified: false,
        adjustments: { attenuation: 0, tone: 0, uniformity: 0, relief: 0 },
      } : region));
    setMessage('La etiqueta cambió; vuelve a analizar y validar manualmente esta zona.');
  };

  const labelIsReady = !!selected?.label.trim()
    && (selected.label !== 'Otra' || !!customLabel.trim());
  const analyzeSelected = () => {
    if (!selected || !base || !labelIsReady || !contextMatches) {
      setMessage('Delimita la zona y elige una etiqueta antes de analizar.');
      return;
    }
    generationRef.current++;
    const generation = generationRef.current;
    clearTimeout(pendingRef.current);
    const snapshotRegion = cloneRegions([selected])[0];
    setBusy(true);
    setAnalysis(undefined);
    setMessage('Analizando únicamente el ROI seleccionado en este dispositivo…');
    pendingRef.current = setTimeout(() => {
      if (generation !== generationRef.current) return;
      try {
        const context2d = base.getContext('2d', { willReadFrequently: true });
        if (!context2d) throw new Error('No se pudo leer la copia local de la imagen.');
        const image = context2d.getImageData(0, 0, base.width, base.height);
        const safeMask = landmarks ? createSkinSignalMask(base.width, base.height, landmarks) : undefined;
        const mask = createSkinRegionMask(base.width, base.height, snapshotRegion.polygon, safeMask);
        const roiPixels = mask.reduce((total, pixel) => total + pixel, 0);
        if (!roiPixels) {
          setAnalysis(undefined);
          setMessage('No hay píxeles seguros dentro del ROI. Revisa el trazado y evita ojos, labios y otras zonas excluidas.');
        } else {
          const result = analyzeSkinAppearance(image, mask, { sensitivity: 0.5 });
          setAnalysis({ regionId: snapshotRegion.id, result, roiPixels });
          setMessage('Análisis local terminado. Revisa la sugerencia y decide manualmente si validas esta zona.');
        }
      } catch (error) {
        setAnalysis(undefined);
        setMessage(error instanceof Error ? error.message : 'No se pudo analizar el ROI local.');
      } finally {
        if (generation === generationRef.current) setBusy(false);
      }
    }, 0);
  };

  const verifySelected = () => {
    if (!selected || !selectedAnalysis || !selected.label.trim()) return;
    setResetAcknowledged(false);
    setRegions(currentRegions => currentRegions.map(region => region.id === selected.id
      ? { ...region, verified: true } : region));
    setMessage('Zona revisada y validada manualmente. Los controles aplican solo dentro de este ROI.');
  };

  const updateAdjustment = (key: keyof SkinReviewRegion['adjustments'], value: number) => {
    if (!selected?.verified || !Number.isFinite(value)) return;
    setResetAcknowledged(false);
    setRegions(currentRegions => currentRegions.map(region => region.id === selected.id
      ? { ...region, adjustments: { ...region.adjustments, [key]: Math.max(-1, Math.min(1, value)) } }
      : region));
  };

  const discardSelected = () => {
    if (!selected) return;
    invalidateAnalysis();
    setRegions(currentRegions => currentRegions.filter(region => region.id !== selected.id));
    setActiveId(undefined);
    setAnalysis(undefined);
    setMessage('Zona descartada. La imagen original permanece intacta.');
  };

  const verifiedRegions = regions.filter(region => region.verified);
  const selectionPolygon = draft.length > 1 ? draft : selected?.polygon ?? [];
  const newZone = () => {
    invalidateAnalysis();
    setActiveId(undefined);
    setDraft([]);
    setMessage('Dibuja una nueva zona rectangular o a mano alzada.');
  };

  return <section aria-label="Revisión visual manual por zonas" className="min-w-0 space-y-3 rounded-xl border border-amber-800/60 bg-slate-950 p-3 text-sm text-slate-100 shadow-lg sm:p-4">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-semibold text-amber-200">Revisión visual por zonas</h3>
        <p className="mt-1 text-xs text-slate-300">Delimita · etiqueta · analiza ROI · revisa y valida manualmente.</p>
      </div>
      <span className="rounded-full border border-amber-800 px-2 py-1 text-[11px] text-amber-200">Local · sin guardar</span>
    </header>

    {regions.length > 0 && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Zonas independientes">
      {regions.map((region, index) => <button key={region.id} type="button" aria-pressed={region.id === activeId}
        onClick={() => {
          invalidateAnalysis(); setActiveId(region.id); setDraft([]);
          setCustomLabel(!SKIN_REVIEW_LABELS.includes(region.label as typeof SKIN_REVIEW_LABELS[number])
            ? region.label : '');
        }}
        className={`${BUTTON} ${region.id === activeId ? 'border-amber-300 bg-amber-400/15' : ''}`}>
        Zona {index + 1}{region.label ? ` · ${region.label}` : ' · sin etiqueta'}{region.verified ? ' · validada' : ''}
      </button>)}
      <button type="button" className={BUTTON} onClick={newZone}>+ Nueva zona</button>
    </div>}

    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-300">Trazado</span>
      <button type="button" aria-pressed={drawMode === 'rectangle'} className={`${BUTTON} ${drawMode === 'rectangle' ? 'border-amber-300 bg-amber-400/15' : ''}`}
        onClick={() => { invalidateAnalysis(); setDrawMode('rectangle'); }}>Rectángulo</button>
      <button type="button" aria-pressed={drawMode === 'freehand'} className={`${BUTTON} ${drawMode === 'freehand' ? 'border-amber-300 bg-amber-400/15' : ''}`}
        onClick={() => { invalidateAnalysis(); setDrawMode('freehand'); }}>Trazado libre</button>
      {selected && <button type="button" className={BUTTON} onClick={() => {
        drawingRef.current = undefined; setDraft([]); setAnalysis(undefined);
        invalidateAnalysis();
        setRegions(currentRegions => currentRegions.filter(region => region.id !== selected.id));
        setActiveId(undefined); setMessage('Trazado descartado. Puedes dibujarlo de nuevo.');
      }}>Corregir trazado</button>}
      {draft.length > 0 && <button type="button" className={BUTTON} onClick={() => {
        drawingRef.current = undefined; setDraft([]); setMessage('Trazado cancelado.');
      }}>Cancelar</button>}
    </div>

    {base && <div className="relative mx-auto w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-900"
      style={{ aspectRatio: `${base.width} / ${base.height}` }}>
      <canvas ref={previewRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Área para delimitar una zona de piel"
        aria-describedby="skin-region-keyboard-help" role="application" tabIndex={0} onKeyDown={handleCanvasKeyDown}
        className={`absolute inset-0 h-full w-full touch-none cursor-crosshair ${GOLD_FOCUS}`}
        onPointerDown={beginDraw} onPointerMove={moveDraw} onPointerUp={finishDraw}
        onPointerCancel={() => { drawingRef.current = undefined; setDraft([]); }}>
        {regions.map(region => <polygon key={region.id} points={pointsText(region.polygon)}
          fill={region.id === activeId ? 'rgba(222,184,135,0.2)' : 'rgba(148,163,184,0.12)'}
          stroke={region.verified ? '#86efac' : region.id === activeId ? '#deb887' : '#cbd5e1'}
          strokeWidth="0.003" vectorEffect="non-scaling-stroke" />)}
        {selectionPolygon.length > 2 && <polygon points={pointsText(selectionPolygon)}
          fill="rgba(251,191,36,0.15)" stroke="#fbbf24" strokeWidth="0.004"
          strokeDasharray="0.012 0.008" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>}
    <p id="skin-region-keyboard-help" className="text-[11px] text-slate-400">
      Ratón o tacto: arrastra para trazar. Teclado: enfoca la imagen, mueve el centro con flechas (Mayús = paso mayor) y pulsa Intro para crear un rectángulo.
    </p>

    {selected && <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <label className="text-xs text-slate-300">Etiqueta elegida por ti
        <select aria-label={`Etiqueta de ${selected.id}`} value={SKIN_REVIEW_LABELS.includes(selected.label as typeof SKIN_REVIEW_LABELS[number]) ? selected.label : selected.label ? 'Otra' : ''}
          onChange={event => {
            const value = event.target.value;
            setCustomLabel('');
            chooseLabel(value === 'Otra' ? 'Otra' : value);
          }} className={`mt-1 w-full rounded-md border border-slate-700 bg-slate-900 p-2 text-sm text-white ${GOLD_FOCUS}`}>
          <option value="">Elige una etiqueta…</option>
          {SKIN_REVIEW_LABELS.map(label => <option key={label} value={label}>{label}</option>)}
        </select>
      </label>
      {(selected.label === 'Otra' || !SKIN_REVIEW_LABELS.includes(selected.label as typeof SKIN_REVIEW_LABELS[number])) && <label className="text-xs text-slate-300">Especifica la etiqueta
        <input value={customLabel} onChange={event => {
          setCustomLabel(event.target.value);
          chooseLabel(event.target.value.trim() ? event.target.value : 'Otra');
        }} maxLength={60} className={`mt-1 w-full rounded-md border border-slate-700 bg-slate-900 p-2 text-sm text-white ${GOLD_FOCUS}`}
          placeholder="Escrita por ti" />
      </label>}
    </div>}

    {selected && <div className="flex flex-wrap gap-2">
      <button type="button" className={BUTTON} disabled={busy || !labelIsReady || !base || !contextMatches}
        onClick={analyzeSelected}>{busy ? 'Analizando ROI…' : 'Analizar solo esta zona'}</button>
      <button type="button" className={BUTTON} disabled={!selectedAnalysis || !labelIsReady}
        onClick={verifySelected}>Validar revisión manual</button>
      <button type="button" className={BUTTON} onClick={discardSelected}>Descartar zona</button>
    </div>}

    {selectedAnalysis && <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-2.5 text-xs" aria-label="Resultado de la revisión visual">
      <p className="font-medium text-amber-100">{statusSummary(selectedAnalysis)}</p>
      <p className="mt-1 text-slate-400">{selectedAnalysis.roiPixels} píxeles RGB locales revisados. La etiqueta es tuya; esto no es diagnóstico ni identifica relieve real.</p>
      {selectedAnalysis.result.warnings.length > 0 && <p className="mt-1 text-amber-200/80">{selectedAnalysis.result.warnings[0]}</p>}
    </div>}

    {selected?.verified && <fieldset className="grid gap-x-4 gap-y-2 rounded-lg border border-emerald-800/70 bg-emerald-950/30 p-2.5 sm:grid-cols-2">
      <legend className="px-1 text-xs font-medium text-emerald-200">Vista ilustrativa · solo dentro del ROI validado</legend>
      {([
        ['attenuation', 'Atenuación visual', 0, 1, 0.05],
        ['scarAttenuation', 'Atenuar apariencia de cicatriz', 0, 1, 0.05],
        ['uniformity', 'Uniformidad de textura', 0, 1, 0.05],
        ['tone', 'Tono RGB aparente', -1, 1, 0.05],
        ['relief', 'Relieve ilustrativo · sin medición', -1, 1, 0.05],
      ] as const).map(([key, label, min, max, step]) => <label key={key} className="text-xs text-slate-200">
        <span className="flex justify-between gap-2"><span>{label}</span><output>{numberFormat.format(selected.adjustments[key] ?? 0)}</output></span>
        <input aria-label={label} type="range" min={min} max={max} step={step} value={selected.adjustments[key] ?? 0}
          disabled={!landmarks} onChange={event => updateAdjustment(key, Number(event.target.value))}
          className="mt-1 block w-full accent-amber-300" />
      </label>)}
      <p className="text-[11px] text-slate-400 sm:col-span-2">Cicatriz: atenúa contraste y textura de la foto dentro de la zona validada. No elimina cicatrices físicas ni reconstruye su profundidad; el relieve se ajusta por separado.</p>
      {!landmarks && <p className="text-xs text-amber-200 sm:col-span-2">Se requieren referencias faciales para proteger ojos y labios; las sugerencias de ajuste están desactivadas.</p>}
      {verifiedRegions.some(region => Object.values(region.adjustments).some(value => value !== 0)) && <>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="button" aria-pressed={showBefore} className={BUTTON}
            onClick={() => setShowBefore(value => !value)}>{showBefore ? 'Ver después' : 'Ver antes'}</button>
          <button type="button" className={BUTTON} onClick={() => {
            setShowBefore(false);
            setResetAcknowledged(true);
            setRegions(currentRegions => currentRegions.map(region => ({
              ...region, adjustments: { attenuation: 0, scarAttenuation: 0, tone: 0, uniformity: 0, relief: 0 },
            })));
          }}>Restablecer · imagen original</button>
        </div>
      </>}
    </fieldset>}

    <p role="status" aria-live="polite" aria-busy={busy} className="text-xs text-slate-300">{message}</p>
    <p className="text-[11px] leading-relaxed text-slate-400">
      Sugerencias visuales RGB/textura solamente; no diagnostican, no detectan lesiones ni prometen relieve real.
      La foto original no se modifica. Los ojos y labios se excluyen si hay referencias faciales. Sin backend, base de datos ni subidas.
    </p>
  </section>;
}
