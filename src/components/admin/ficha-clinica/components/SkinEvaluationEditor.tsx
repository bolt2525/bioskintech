import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Grid3X3, Images } from 'lucide-react';
import { Dialog } from '../../../ui/Dialog';
import Clinical3DViewer from './Clinical3DViewer';
import Skin3DBoundary from './Skin3DBoundary';
import type { Marker3D } from './Clinical3DViewer';
import LESION_CATALOG from '../../../../data/skin-lesion-catalog.json';
import { locateSurfacePoint, surfacePoint } from '../../../../lab/faceSim/faceTransfer';
import type { PersonalSurface } from '../../../../lab/faceSim/faceTransfer';
import type { SkinPhotoSource } from '../../../../lab/faceSim/skinMultiView';
import recordsFetch from '../../../../utils/recordsFetch';
import { SkinRequestScope, parseSkinAnalysis, parseSkinStatus, prepareSkinPhoto, validBox } from './skinVisualAI';
import type { NormalizedBox, PhotoReference, SkinContext, SkinStatus } from './skinVisualAI';
import {
  anchorForPhoto, bestPhotoForAnchor, cropToOriginal, photoForAnchor, skinRequestContext, validateEvaluationGroup,
} from './skinEvaluation';
import type { EvaluationMark } from './skinEvaluation';
import { skinAnatomicalOverlay, skinZoneAt } from './skinAnatomy';
import SkinPhotoViewport from './SkinPhotoViewport';

export type { EvaluationMark } from './skinEvaluation';

export interface SkinEvaluationEditorProps {
  sources: SkinPhotoSource[];
  surface?: PersonalSurface;
  modelData?: ArrayBuffer;
  recordId?: number;
  value: EvaluationMark[];
  onChange: (marks: EvaluationMark[]) => void;
  context: SkinContext;
  photoReferences?: Record<string, PhotoReference>;
  disabled?: boolean;
  onRequestPhoto?: () => void;
  presentation?: 'comparison' | 'mask-first';
  referenceView?: ReactNode;
  viewMode?: 'mask' | 'split';
  aiAllowed?: boolean;
  migration?: { ids: string[]; skipped: number };
}

const button = 'admin-focus-ring min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-50 aria-pressed:border-gold-ink aria-pressed:bg-gold-light aria-pressed:text-gold-ink aria-pressed:ring-1 aria-pressed:ring-gold-ink';
const field = 'admin-focus-ring w-full rounded-lg border border-gray-300 bg-white p-2 text-sm text-gray-900';
const full: NormalizedBox = { x: 0, y: 0, width: 1, height: 1 };

function CanvasImage({ image, crop = full, label }: { image: CanvasImageSource; crop?: NormalizedBox; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = 'width' in image ? Number(image.width) : 0;
    const height = 'height' in image ? Number(image.height) : 0;
    if (!width || !height) return;
    const scale = Math.min(1, 800 / Math.max(width * crop.width, height * crop.height));
    canvas.width = Math.max(1, Math.round(width * crop.width * scale));
    canvas.height = Math.max(1, Math.round(height * crop.height * scale));
    canvas.getContext('2d')?.drawImage(image, crop.x * width, crop.y * height, crop.width * width, crop.height * height,
      0, 0, canvas.width, canvas.height);
  }, [image, crop.x, crop.y, crop.width, crop.height]);
  return <canvas ref={ref} role="img" aria-label={label} className="block h-auto w-full" />;
}

async function json(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
    ? data.error : `Error HTTP ${response.status}.`);
  return data;
}

function pointBox(x: number, y: number): NormalizedBox {
  const size = 0.04;
  return { x: Math.max(0, Math.min(1 - size, x - size / 2)), y: Math.max(0, Math.min(1 - size, y - size / 2)), width: size, height: size };
}

export default function SkinEvaluationEditor({
  sources, surface, modelData, recordId, value, onChange, context, photoReferences, disabled = false, onRequestPhoto, presentation = 'comparison',
  referenceView, viewMode = 'mask', aiAllowed = true, migration,
}: SkinEvaluationEditorProps) {
  const [selectedId, setSelectedId] = useState('');
  const source = sources.find(s => s.id === selectedId) ?? sources[0];
  const [bitmap, setBitmap] = useState<{ source: Blob; image: ImageBitmap } | null>(null);
  const [bitmapError, setBitmapError] = useState('');
  const image = source?.original ? bitmap?.source === source.original ? bitmap.image : null : source?.canvas;
  const [crop, setCrop] = useState<NormalizedBox>({ x: .25, y: .25, width: .5, height: .5 });
  const [view, setView] = useState<'photo' | '3d'>('photo');
  const [status, setStatus] = useState<SkinStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusVersion, setStatusVersion] = useState(0);
  const [cropOpen, setCropOpen] = useState(false);
  const [interaction, setInteraction] = useState<'manual' | 'assisted' | 'observation'>('manual');
  const [selectedMark, setSelectedMark] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [group, setGroup] = useState<string[]>([]);
  const [included, setIncluded] = useState<string[]>([]);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [showZones, setShowZones] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [relocating, setRelocating] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationDraft, setMigrationDraft] = useState<EvaluationMark[] | null>(null);
  const [comparisonSide, setComparisonSide] = useState<'mask' | 'reference'>('mask');
  const migrationShown = useRef(false);
  const overlay = useMemo(() => showZones && surface ? skinAnatomicalOverlay(surface) : undefined, [showZones, surface]);
  const request = useRef(new SkinRequestScope());
  const statusRequest = useRef(new SkinRequestScope());
  const latest = useRef(value);
  latest.current = value;
  const activeMarks = migrationDraft ?? value;
  const currentMarks = useRef(activeMarks);
  currentMarks.current = activeMarks;
  function updateMarks(marks: EvaluationMark[]) {
    if (migrationDraft) setMigrationDraft(marks);
    else onChange(marks);
  }
  useEffect(() => {
    if (!migrationShown.current && migration?.ids.length) {
      migrationShown.current = true; setMigrationDraft(value); setMigrationOpen(true);
    }
  }, [migration, value]);

  useLayoutEffect(() => {
    request.current.cancel(); setBusy(false); setConsent(false); setCropOpen(false);
    setGroup([]); setIncluded([]); setSelectedId(''); setSelectedMark(null); setError(''); setNotice('');
  }, [recordId]);

  useEffect(() => {
    let active = true;
    let opened: ImageBitmap | null = null;
    setBitmap(null); setBitmapError('');
    if (source?.original) createImageBitmap(source.original).then(result => {
      if (!active) { result.close(); return; }
      opened = result; setBitmap({ source: source.original!, image: result });
    }).catch(() => { if (active) setBitmapError('No se pudo abrir la foto original.'); });
    return () => { active = false; opened?.close(); };
  }, [source?.id, source?.original]);

  useEffect(() => {
    if (!aiAllowed) { statusRequest.current.cancel(); setStatus(null); setStatusError(''); setStatusLoading(false); setInteraction('manual'); return; }
    const scope = statusRequest.current, task = scope.start();
    setStatusLoading(true); setStatusError(''); setStatus(null);
    recordsFetch('/api/ai-consultation?action=skinVisualStatus', { signal: task.signal })
      .then(json).then(parseSkinStatus).then(result => {
        if (!task.current()) return;
        setStatus(result);
        if (!result.enabled) { setInteraction('manual'); setCropOpen(false); setConsent(false); }
      })
      .catch(e => { if (task.current()) setStatusError(e instanceof Error ? e.message : 'No se pudo consultar el permiso.'); })
      .finally(() => { if (task.current()) setStatusLoading(false); });
    return () => scope.cancel();
  }, [recordId, statusVersion, aiAllowed]);

  useEffect(() => {
    const scope = request.current;
    scope.cancel(); setBusy(false); setConsent(false); if (!aiAllowed) setCropOpen(false);
    return () => scope.cancel();
  }, [source?.id, source?.original, source?.canvas, recordId, aiAllowed]);

  function selectPhoto(id: string) {
    request.current.cancel(); setBusy(false); setConsent(false); setError(''); setSelectedId(id);
  }
  function chooseRegion(box: NormalizedBox, selected = source, anchor = selected && anchorForPhoto(box, selected, surface)) {
    if (!selected || disabled) return;
    if (relocating && selectedMark) {
      const mark = currentMarks.current.find(item => item.id === selectedMark);
      if (!mark) return;
      if (mark.crop && mark.sourceId !== selected.id) {
        setError('Reubica esta marca desde su foto original para conservar la evidencia del análisis.'); return;
      }
      updateMarks(currentMarks.current.map(item => item.id === mark.id ? { ...item, sourceId: selected.id, box,
        anchor, observations: undefined, status: 'pending', reviewedAt: undefined,
        source: item.source.provider === 'edited' ? item.source : { provider: 'edited', original: item.source } } : item));
      setRelocating(false); setNotice('Ubicación actualizada. Confirma cuando termines de revisar.'); return;
    }
    if (interaction === 'observation') {
      const mark = latest.current.find(item => item.id === selectedMark);
      if (!mark || mark.sourceId === selected.id) { setError('Selecciona una región de otra foto antes de vincular su observación.'); return; }
      edit(mark.id, { observations: [...(mark.observations ?? []).filter(item => item.sourceId !== selected.id),
        { sourceId: selected.id, box }] });
      setInteraction('manual'); setDetailOpen(true); setNotice('Observación vinculada a la misma región; revisa y valida el cambio.');
      return;
    }
    if (interaction === 'manual') { addManual(box, selected, anchor); return; }
    if (!status?.enabled) { setError('La búsqueda asistida no está disponible.'); return; }
    const width = .35, height = .35;
    setCrop({ x: Math.max(0, Math.min(1 - width, box.x + box.width / 2 - width / 2)),
      y: Math.max(0, Math.min(1 - height, box.y + box.height / 2 - height / 2)), width, height });
    setConsent(false); setCropOpen(true);
  }
  function addManual(box: NormalizedBox, selected = source, anchor = selected && anchorForPhoto(box, selected, surface)) {
    if (!selected || disabled) return;
    if (migrationOpen) { setNotice('Selecciona una marca y pulsa Reubicar para cambiar su posición.'); return; }
    const mark: EvaluationMark = { id: crypto.randomUUID(), sourceId: selected.id, category: 'other',
      label: 'Lesión', note: anchor ? skinZoneAt(anchor) ?? '' : '', box, status: 'pending', source: { provider: 'manual' }, ...(anchor ? { anchor } : {}) };
    onChange([...latest.current, mark]); setSelectedMark(mark.id); setDetailOpen(true);
  }
  function on3D(marker: Marker3D) {
    if (!surface || !marker.isAddPointMode) return;
    // pointMode adds 0.03 along the hit normal before invoking onMarkerPlaced.
    const p = { x: marker.position.x - marker.normal.x * .03, y: marker.position.y - marker.normal.y * .03,
      z: marker.position.z - marker.normal.z * .03 };
    const found = locateSurfacePoint(p, surface, undefined, { normal: marker.normal, minFacing: .12 });
    if (!found) { setError('El punto no corresponde a una región observada de la máscara.'); return; }
    const anchor = { version: 1 as const, ...found };
    const best = bestPhotoForAnchor(anchor, sources, surface);
    if (!best) { setError('No hay una fotografía con correspondencia visible para este punto.'); return; }
    // Use the same round-trip and visibility checks as view selection.
    const point = photoForAnchor(anchor, best, surface);
    if (!point) return;
    selectPhoto(best.id); chooseRegion(pointBox(point.x, point.y), best, anchor);
    if (!relocating) setNotice(`Vista elegida: ${best.label}, según orientación y detalle (estimación). Puedes cambiarla manualmente.`);
  }
  function edit(id: string, patch: Partial<EvaluationMark>) {
    updateMarks(currentMarks.current.map(mark => {
      if (mark.id !== id) return mark;
      const original = mark.source.provider === 'edited' ? mark.source.original : mark.source;
      const markPhoto = sources.find(item => item.id === mark.sourceId);
      return { ...mark, ...patch, status: 'pending', reviewedAt: undefined,
        source: original.provider === 'google-gemini' || mark.status === 'validated' || mark.source.provider === 'edited'
          ? { provider: 'edited', original } : original,
        ...(patch.box ? { anchor: markPhoto && anchorForPhoto(patch.box, markPhoto, surface) } : {}) };
    }));
  }
  async function analyze() {
    if (!aiAllowed || !source || !image || !validBox(crop) || !status?.enabled || status.remainingUsd <= 0 || !consent || busy || disabled) return;
    const task = request.current.start();
    const requestId = crypto.randomUUID(), consentedAt = new Date().toISOString();
    const width = image.width, height = image.height;
    const x = Math.floor(crop.x * width), y = Math.floor(crop.y * height);
    const right = Math.min(width, Math.ceil((crop.x + crop.width) * width));
    const bottom = Math.min(height, Math.ceil((crop.y + crop.height) * height));
    const actual = { x: x / width, y: y / height, width: (right - x) / width, height: (bottom - y) / height };
    setBusy(true); setError(''); setNotice(''); setConsent(false);
    try {
      const sentContext = skinRequestContext(context);
      const canvas = document.createElement('canvas'), scale = Math.min(1, 4000 / Math.max(right - x, bottom - y));
      canvas.width = Math.max(1, Math.round((right - x) * scale)); canvas.height = Math.max(1, Math.round((bottom - y) * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No se pudo preparar el recorte.');
      ctx.drawImage(image, x, y, right - x, bottom - y, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .95));
      if (!blob) throw new Error('No se pudo preparar el recorte.');
      const prepared = await prepareSkinPhoto(blob, task.signal);
      const result = parseSkinAnalysis(await json(await recordsFetch('/api/ai-consultation?action=analyzeSkinVisual', {
        method: 'POST', signal: task.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(recordId ? { recordId } : { temporary: true }), imageBase64: prepared.base64,
          mimeType: 'image/jpeg', consent: true, context: sentContext, requestId }),
      })));
      if (!task.current()) return;
      const marks: EvaluationMark[] = result.proposals.map(proposal => {
        const box = cropToOriginal(proposal.box, actual);
        return { id: crypto.randomUUID(), sourceId: source.id, category: proposal.category, label: proposal.label,
          note: proposal.note, box, status: 'pending', anchor: anchorForPhoto(box, source, surface),
          crop: { box: actual, sourceWidth: width, sourceHeight: height },
          source: { provider: 'google-gemini', analysisId: result.analysisId, model: result.model, requestId,
            analyzedAt: new Date().toISOString(), consentedAt, imageWidth: prepared.width, imageHeight: prepared.height,
            proposal, summary: result.summary, limitations: result.limitations, context: sentContext } };
      });
      onChange([...latest.current, ...marks]); setGroup(marks.map(m => m.id)); setIncluded(marks.map(m => m.id)); setCropOpen(false);
      setStatus(previous => previous ? { ...previous, ...result.usage } : previous);
      setNotice(marks.length ? 'Revisa las propuestas; ninguna está validada todavía.' : 'No se recibieron propuestas. Esto no descarta lesiones.');
    } catch (e) {
      if (task.current()) { setError(e instanceof Error ? e.message : 'No se pudo analizar.'); setStatusVersion(v => v + 1); }
    } finally { if (task.current()) setBusy(false); }
  }
  const visible = source ? activeMarks.flatMap(mark => {
    if (mark.sourceId === source.id) return [{ mark, box: mark.box, projected: false }];
    const observation = mark.observations?.find(item => item.sourceId === source.id);
    if (observation) return [{ mark, box: observation.box, projected: false }];
    const point = mark.anchor && photoForAnchor(mark.anchor, source, surface);
    return point ? [{ mark, box: pointBox(point.x, point.y), projected: true }] : [];
  }) : [];
  const points = surface ? activeMarks.flatMap(mark => {
    const p = mark.anchor && surfacePoint(mark.anchor, surface);
    return p ? [{ id: mark.id, type: 'free' as const, lineIds: [], ...p, color: mark.status === 'validated' ? '#15803d' : '#b45309', name: mark.label }] : [];
  }) : [];
  const maskPane = <div className="min-w-0 overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
    <div className="flex min-h-[76px] flex-wrap items-center justify-between gap-2 px-3 py-2 text-white">
      <div><h4 className="text-sm font-semibold">Máscara del paciente</h4>
        <p className="text-xs text-slate-300">Marca sobre la superficie · gira para explorar</p></div>
      <button type="button" className={`admin-focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-xs ${showZones ? 'border-gold bg-gold-light text-gray-900' : 'border-slate-500 text-white hover:bg-slate-800'}`}
        aria-pressed={showZones} onClick={() => setShowZones(current => !current)}><Grid3X3 size={16} aria-hidden="true" />{showZones ? 'Ocultar zonas' : 'Mostrar zonas'}</button>
    </div>
    {surface && modelData ? <Skin3DBoundary onPhoto={() => { setView('photo'); setPhotosOpen(true); }}><Clinical3DViewer modelData={modelData} markers={[]} editablePoints={points}
      pointMode={disabled || (migrationOpen && !relocating) ? 'none' : 'add'} anatomicalOverlay={overlay}
      onMarkerPlaced={on3D} onEditablePointClicked={id => {
        setSelectedMark(id);
        if (!migrationOpen) setDetailOpen(true);
        const mark = currentMarks.current.find(item => item.id === id);
        if (mark && sources.some(item => item.id === mark.sourceId)) selectPhoto(mark.sourceId);
      }} selectedPointId={selectedMark ?? undefined} skipConfirmation cameraPreset="face-surface"
      height={presentation === 'mask-first' ? 'min(62dvh,560px)' : '420px'} occludeAnnotations /></Skin3DBoundary> :
      <p className="bg-white p-4 text-sm text-gray-700">Máscara 3D no disponible; puedes continuar en la fotografía 2D.</p>}
  </div>;
  const photoPane = source && <div className="grid min-w-0 items-start gap-3 md:grid-cols-[112px_minmax(0,1fr)]">
    <div className="flex flex-wrap gap-2 md:flex-col" aria-label="Fotografías disponibles">
      {sources.map(item => <button key={item.id} type="button" className={`${button} !p-2`}
        aria-pressed={source.id === item.id} onClick={() => selectPhoto(item.id)}>
        <span className="mb-1 block max-h-24 w-16 overflow-hidden rounded-lg md:w-20"><CanvasImage image={item.canvas} label={`Miniatura de ${item.label}`} /></span>
        {item.label}{!item.confirmed ? ' · sin confirmar' : ''}</button>)}
      {onRequestPhoto && <button type="button" className={button} disabled={disabled} onClick={onRequestPhoto}>Solicitar foto</button>}
    </div>
    <div className="min-w-0 space-y-2"><SkinPhotoViewport source={source} surface={surface} showZones={showZones} marks={visible} selectedMark={selectedMark}
      onToggleZones={() => setShowZones(current => !current)} disabled={disabled} onChoose={(x, y) => chooseRegion(pointBox(x, y))} onSelect={id => { setSelectedMark(id); if (!migrationOpen) setDetailOpen(true); }} />
    <button type="button" className={button} disabled={disabled} onClick={() => chooseRegion(pointBox(.5, .5))}>
      {interaction === 'manual' ? 'Añadir marca en el centro' : interaction === 'observation' ? 'Vincular observación central' : 'Seleccionar zona central'}</button>
    {value.some(mark => mark.id === selectedMark) && !visible.some(item => item.mark.id === selectedMark) &&
      <p role="status" className="text-sm">La región seleccionada no tiene correspondencia fiable en esta vista. No se proyectó; puedes vincular una observación manual.</p>}</div>
  </div>;
  const comparisonPane = <div className="space-y-2">
    {referenceView && <div role="group" aria-label="Vista de comparación móvil" className="flex gap-2 md:hidden">
      <button type="button" className={button} aria-pressed={comparisonSide === 'mask'} onClick={() => setComparisonSide('mask')}>Máscara</button>
      <button type="button" className={button} aria-pressed={comparisonSide === 'reference'} onClick={() => setComparisonSide('reference')}>Referencia</button>
    </div>}
    <div className={`grid items-stretch gap-3 ${referenceView ? 'md:grid-cols-2' : ''}`}>
      <div className={`min-w-0 ${comparisonSide === 'reference' && referenceView ? 'hidden md:block' : ''}`}>{maskPane}</div>
      {referenceView && <div className={`min-w-0 ${comparisonSide === 'mask' ? 'hidden md:block' : ''}`}>{referenceView}</div>}
    </div>
  </div>;

  return <section aria-label="Editor de evaluación de piel" className="min-w-0 space-y-4 text-gray-900">
    {!source ? <div className="space-y-2"><p>No hay fotografías disponibles.</p>{onRequestPhoto && <button type="button" className={button} disabled={disabled} onClick={onRequestPhoto}>Solicitar foto</button>}</div> :
      <>
        {presentation === 'comparison' && <div className="flex gap-2 lg:hidden">
          <button type="button" className={button} aria-pressed={view === 'photo'} onClick={() => setView('photo')}>Foto</button>
          <button type="button" className={button} aria-pressed={view === '3d'} onClick={() => setView('3d')}>3D</button>
        </div>}
        <div className={`flex flex-wrap gap-2 ${presentation === 'mask-first' && !status?.enabled && !value.some(mark => mark.id === selectedMark && mark.sourceId !== source.id) ? 'hidden' : ''}`}>
          <button type="button" className={button} aria-pressed={interaction === 'manual'} disabled={disabled}
            onClick={() => setInteraction('manual')}>Marcar manual</button>
          {value.some(mark => mark.id === selectedMark && mark.sourceId !== source.id) && <button type="button" className={button}
            aria-pressed={interaction === 'observation'} disabled={disabled} onClick={() => setInteraction('observation')}>
            Vincular observación a la región seleccionada</button>}
          {aiAllowed && status?.enabled && <button type="button" className={button} aria-pressed={interaction === 'assisted'} disabled={disabled}
            onClick={() => setInteraction('assisted')}>Buscar asistido</button>}
        </div>
        {presentation === 'mask-first' ? <>
          <div role="group" aria-label="Superficie de trabajo" className="flex flex-wrap gap-2">
            <button type="button" className={button} aria-pressed={!photosOpen} onClick={() => setPhotosOpen(false)}>Máscara 3D</button>
            <button type="button" className={button} aria-pressed={photosOpen} onClick={() => setPhotosOpen(true)}>
              <Images size={16} className="mr-1 inline" aria-hidden="true" />Fotografías ({sources.length})</button>
            {onRequestPhoto && <button type="button" className={button} onClick={onRequestPhoto} disabled={disabled}>Revisar fotos</button>}
            {migration && <button type="button" className={button} disabled={disabled || !migration.ids.length}
              onClick={() => { setMigrationDraft(value); setMigrationOpen(true); setDetailOpen(false); }}>Revisar traslado</button>}
          </div>
          {!migrationOpen && (photosOpen ? photoPane : viewMode === 'split' && referenceView ? comparisonPane : maskPane)}
        </> : <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,360px),1fr))' }}>
          <div className={view === 'photo' ? 'min-w-0' : 'hidden min-w-0 lg:block'}>{photoPane}</div>
          <div className={view === '3d' ? 'min-w-0' : 'hidden min-w-0 lg:block'}>{maskPane}</div>
        </div>}
        {bitmapError && <p role="alert" className="text-sm text-red-700">{bitmapError}</p>}
        {aiAllowed && (statusLoading ? <p role="status" className="text-sm">Consultando herramientas…</p> : statusError ?
          <div role="alert" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">No se pudo consultar la asistencia IA. El marcado manual sigue disponible. <button type="button" className={button} title={statusError} onClick={() => setStatusVersion(v => v + 1)}>Reintentar</button></div> :
          status?.enabled ? <div className="space-y-2">
            <Dialog open={cropOpen} onClose={() => { if (!busy) { setCropOpen(false); setConsent(false); } }} labelledBy="skin-crop-title">
              <div className="w-[min(56rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-gray-300 bg-white p-4">
              <h4 id="skin-crop-title" className="font-semibold">Seleccionar recorte original</h4>
              <p className="text-sm">Disponible: {status.remainingUsd.toFixed(3)} USD estimados. Se enviará solo el recorte seleccionado a Gemini; no se guardará la foto automáticamente.</p>
              <div className="grid gap-3 md:grid-cols-2"><div>
                <p className="text-sm font-medium">Vista previa inmediata del recorte</p>
                {image ? <CanvasImage image={image} crop={crop} label="Vista previa del recorte original" /> : <p role="status">Abriendo la foto original…</p>}
              </div><div className="space-y-2">
                {(['x', 'y', 'width', 'height'] as const).map(key => <label key={key} className="block text-sm">
                  {({ x: 'Mover horizontal', y: 'Mover vertical', width: 'Ancho', height: 'Alto' })[key]}: {Math.round(crop[key] * 100)} %
                  <input className="w-full" type="range" min={key === 'width' || key === 'height' ? .05 : 0}
                    max={key === 'x' ? 1 - crop.width : key === 'y' ? 1 - crop.height : key === 'width' ? 1 - crop.x : 1 - crop.y}
                    step=".01" value={crop[key]} disabled={disabled || busy} onChange={e => setCrop({ ...crop, [key]: Number(e.target.value) })} />
                </label>)}
              </div></div>
              <label className="flex gap-2 text-sm"><input type="checkbox" checked={consent} disabled={disabled || busy}
                onChange={e => setConsent(e.target.checked)} /> Confirmo el envío de este recorte a Gemini.</label>
              <button type="button" className={button} disabled={disabled || busy || !consent || !image || status.remainingUsd <= 0} onClick={analyze}>
                {busy ? 'Solicitando propuestas…' : 'Confirmar y buscar'}</button>
              {busy && <button type="button" className={button} onClick={() => { request.current.cancel(); setBusy(false); setNotice('Espera cancelada; el envío iniciado podría tener coste.'); }}>Cancelar espera</button>}
              <button type="button" className={button} disabled={busy} onClick={() => { setCropOpen(false); setConsent(false); }}>Cerrar</button>
            </div></Dialog>
          </div> : null)}
      </>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {group.some(id => value.some(m => m.id === id && m.status === 'pending')) && <div className="space-y-2 rounded-lg border border-amber-400 bg-amber-50 p-3">
      <p className="text-sm font-semibold">Revisión del último grupo de propuestas</p>
      {group.map(id => { const mark = value.find(m => m.id === id); return mark && <label key={id} className="block text-sm">
        <input type="checkbox" disabled={disabled || mark.status === 'validated'} checked={included.includes(id)}
          onChange={e => setIncluded(current => e.target.checked ? [...current, id] : current.filter(item => item !== id))} /> Incluir {mark.label}
      </label>; })}
      <button type="button" className={button} disabled={disabled || !included.length} onClick={() => {
        try { onChange(validateEvaluationGroup(latest.current, included)); setIncluded([]); }
        catch (e) { setError(e instanceof Error ? e.message : 'Revisa las propuestas.'); }
      }}>Validar grupo seleccionado</button>{' '}
      <button type="button" className={button} disabled={disabled} onClick={() => {
        onChange(latest.current.filter(m => !group.includes(m.id) || m.status === 'validated')); setGroup([]); setIncluded([]);
      }}>Descartar pendientes del grupo</button>
    </div>}
    {!migrationOpen && !!value.length && <div className="flex max-h-32 flex-wrap gap-2 overflow-auto rounded-xl border border-gray-200 p-3" aria-label="Marcas de la evaluación">
      {value.map(mark => <button key={mark.id} type="button" className={button}
        aria-pressed={selectedMark === mark.id} onClick={() => { setSelectedMark(mark.id); setDetailOpen(true); }}>
        <span className={`mr-2 inline-block h-2 w-2 rounded-full ${mark.status === 'validated' ? 'bg-green-700' : 'bg-amber-500'}`} />
        {mark.label}<span className="ml-2 text-xs text-gray-500">{mark.status === 'validated' ? 'Confirmada' : 'Por revisar'}</span></button>)}
    </div>}
    {detailOpen && !migrationOpen && <Dialog open={!!activeMarks.find(mark => mark.id === selectedMark)} onClose={() => setDetailOpen(false)} labelledBy="skin-mark-title">
    <div className="max-h-[85dvh] w-[min(30rem,calc(100vw-2rem))] overflow-auto rounded-2xl bg-white p-5 text-gray-900">
    <h3 id="skin-mark-title" className="mb-4 text-lg font-semibold">Revisar marca</h3>
    {activeMarks.filter(mark => mark.id === selectedMark).map(mark => <div key={mark.id} className="space-y-3">
      <p className="text-sm text-gray-500">{mark.status === 'validated' ? 'Confirmada' : 'Por revisar'} · {sources.find(s => s.id === mark.sourceId)?.label ?? 'Foto no disponible'}</p>
      <label className="block text-sm">Lesión o descripción
        <input className={field} list="skin-evaluation-catalog" maxLength={300} value={mark.label} disabled={disabled}
          onChange={e => edit(mark.id, { label: e.target.value, category: Object.entries(LESION_CATALOG).find(([, label]) => label === e.target.value)?.[0] ?? 'other' })} /></label>
      <details><summary className="admin-focus-ring cursor-pointer text-sm text-gray-600">Observaciones de la marca</summary><label className="mt-2 block text-sm">Observación
        <textarea className={field} rows={2} maxLength={3000} value={mark.note} disabled={disabled}
          onChange={e => edit(mark.id, { note: e.target.value })} /></label></details>
      <details><summary className="admin-focus-ring cursor-pointer text-sm text-gray-600">Ajustar área de la marca</summary>
      <fieldset disabled={disabled} className="mt-2 grid grid-cols-2 gap-2"><legend className="text-sm">Región en foto original (%)</legend>
        {(['x', 'y', 'width', 'height'] as const).map(key => <label key={key} className="text-xs">
          {({ x: 'Izquierda', y: 'Arriba', width: 'Ancho', height: 'Alto' })[key]}
          <input className={field} type="number" min="0" max="100" step="0.1" value={Number.isFinite(mark.box[key]) ? Math.round(mark.box[key] * 1000) / 10 : ''}
            onChange={e => edit(mark.id, { box: { ...mark.box, [key]: e.target.value === '' ? NaN : Number(e.target.value) / 100 } })} />
        </label>)}</fieldset></details>
      {!validBox(mark.box) && <p className="text-sm text-red-700">La región debe quedar dentro de la foto y tener tamaño positivo.</p>}
      {!photoReferences?.[mark.sourceId] && <p className="text-xs text-gray-500">Las fotos se vincularán al preparar el examen para guardar.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled} onClick={() => { setRelocating(true); setDetailOpen(false); }}>Reubicar marca</button>
        <button type="button" className={button} disabled={disabled || mark.status === 'validated' || !mark.label.trim() || !validBox(mark.box)}
          onClick={() => { onChange(validateEvaluationGroup(latest.current, [mark.id])); setDetailOpen(false); }}>Validar región</button>
        <button type="button" className={button} disabled={disabled} onClick={() => { onChange(latest.current.filter(m => m.id !== mark.id)); setDetailOpen(false); }}>Descartar región</button>
      </div>
    </div>)}
    <button type="button" className={`${button} mt-4`} onClick={() => setDetailOpen(false)}>Cerrar</button>
    </div></Dialog>}
    {relocating && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl bg-gold-light p-3 text-sm">Pulsa la nueva ubicación en la máscara o la foto.
      <button type="button" className={button} onClick={() => setRelocating(false)}>Cancelar reubicación</button></div>}
    {migrationOpen && <Dialog open onClose={() => { setMigrationOpen(false); setMigrationDraft(null); setRelocating(false); }} labelledBy="skin-migration-title">
      <div className="flex max-h-[95dvh] w-[min(86rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl bg-white text-gray-900">
        <header className="shrink-0 border-b p-4"><h2 id="skin-migration-title" className="text-lg font-semibold">Compara y confirma las ubicaciones</h2>
          <p className="text-sm text-gray-600">Selecciona una marca y pulsa Reubicar si necesitas moverla. El modelo original no cambia.</p></header>
        <div className="min-h-0 overflow-auto p-4">
          {comparisonPane}
          <div className="mt-3 flex flex-wrap gap-2">{activeMarks.filter(mark => migration?.ids.includes(mark.id)).map(mark =>
            <button key={mark.id} type="button" className={button} aria-pressed={selectedMark === mark.id} onClick={() => { setSelectedMark(mark.id); setRelocating(false); }}>{mark.label}</button>)}</div>
          {!!migration?.skipped && <p className="mt-3 text-sm text-amber-800">{migration.skipped} marca(s) no pudieron trasladarse. Se conservan en el modelo original.</p>}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t p-4">
          <button type="button" className={button} disabled={!selectedMark || !migration?.ids.includes(selectedMark)} onClick={() => { setRelocating(true); setComparisonSide('mask'); }}>Reubicar marca</button>
          <p role="status" className="text-sm">{relocating ? 'Pulsa la nueva ubicación en la máscara.' : 'Si todo está bien, confirma sin mover las marcas.'}</p>
          <div className="flex gap-2"><button type="button" className={button} onClick={() => { setMigrationOpen(false); setMigrationDraft(null); setRelocating(false); }}>Cancelar revisión</button>
          <button type="button" className={`${button} !bg-gold-light !border-gold-ink`} disabled={disabled || !migration?.ids.length} onClick={() => {
            try { onChange(validateEvaluationGroup(currentMarks.current, migration?.ids ?? [])); setMigrationDraft(null); setMigrationOpen(false); setRelocating(false); setNotice('Ubicaciones confirmadas. Prepara el examen para guardar.'); }
            catch (e) { setError(e instanceof Error ? e.message : 'Revisa las marcas antes de confirmar.'); }
          }}>Confirmar ubicaciones</button></div>
        </footer>
      </div>
    </Dialog>}
    <datalist id="skin-evaluation-catalog">{Object.entries(LESION_CATALOG).map(([key, label]) => <option key={key} value={label} />)}</datalist>
  </section>;
}
