import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import recordsFetch from '../../../../utils/recordsFetch';
import {
  SKIN_CATEGORIES, SkinRequestScope, parseSkinAnalysis, parseSkinStatus,
  prepareSkinPhoto, validateProposal, validBox,
  parsePhotoReference, safePhotoReadURL, skinReviewDescription,
} from './skinVisualAI';
import type {
  NormalizedBox, PhotoReference, PreparedSkinPhoto, ReviewedSkinMark,
  SkinAnalysis, SkinCategory, SkinContext, SkinProposal, SkinStatus,
} from './skinVisualAI';

interface LibraryPhoto { id: number; r2_key: string; r2_url: string | null; session_label?: string }
interface SelectedPhoto {
  prepared: PreparedSkinPhoto; reference: PhotoReference | null; url: string; name: string;
}
interface Draft extends SkinProposal { rejected: boolean }
interface Props {
  recordId: number; consultationId?: number; context: SkinContext;
  examIdentity?: string | number;
  reviewed: ReviewedSkinMark[]; onChange: (marks: ReviewedSkinMark[]) => void; disabled?: boolean;
}
const button = 'admin-focus-ring rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50';
const input = 'admin-focus-ring w-full rounded-lg border border-gray-300 bg-white p-2 text-sm text-gray-900';
const money = (value: number) => new Intl.NumberFormat('es', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(value);

async function responseJSON(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : `Error HTTP ${response.status}. Reintenta.`;
    throw new Error(message);
  }
  return data;
}

function ProposalEditor({ proposal, index, validated, disabled, onEdit, onReject, onValidate }: {
  proposal: Draft; index: number; validated: boolean; disabled: boolean;
  onEdit: (patch: Partial<SkinProposal>) => void; onReject: () => void; onValidate: () => void;
}) {
  return (
    <li className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
      <p className="text-sm font-semibold">Región {index + 1} · {validated ? 'Validada para guardar' : proposal.rejected ? 'Descartada' : 'Pendiente de revisión'}</p>
      <label className="block text-sm">Etiqueta
        <input className={input} value={proposal.label} maxLength={300} disabled={disabled || proposal.rejected}
          onChange={e => onEdit({ label: e.target.value })} />
      </label>
      <label className="block text-sm">Categoría
        <select className={input} value={proposal.category} disabled={disabled || proposal.rejected}
          onChange={e => onEdit({ category: e.target.value as SkinCategory })}>
          {Object.entries(SKIN_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label className="block text-sm">Observación revisada
        <textarea className={input} rows={2} maxLength={3000} value={proposal.note} disabled={disabled || proposal.rejected}
          onChange={e => onEdit({ note: e.target.value })} />
      </label>
      <fieldset disabled={disabled || proposal.rejected} className="grid grid-cols-2 gap-2">
        <legend className="mb-1 text-xs text-gray-600">Rectángulo sobre foto (%) · origen arriba a la izquierda</legend>
        {(['x', 'y', 'width', 'height'] as const).map(key => (
          <label key={key} className="text-xs">{({ x: 'Izquierda', y: 'Arriba', width: 'Ancho', height: 'Alto' })[key]}
            <input className={input} type="number" min={0} max={100} step={0.1}
              value={Number.isFinite(proposal.box[key]) ? Math.round(proposal.box[key] * 1000) / 10 : ''}
              onChange={e => onEdit({ box: { ...proposal.box, [key]: e.target.value === '' ? NaN : Number(e.target.value) / 100 } })} />
          </label>
        ))}
      </fieldset>
      {!validBox(proposal.box) && <p className="text-xs text-red-700">La región debe quedar dentro de la foto y tener ancho y alto mayores que cero.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled || proposal.rejected || validated || !proposal.label.trim() || !validBox(proposal.box)}
          onClick={onValidate}>Verificar y validar esta región</button>
        <button type="button" className={button} disabled={disabled} onClick={onReject}>
          {proposal.rejected ? 'Restaurar como pendiente' : 'Descartar esta región'}
        </button>
      </div>
    </li>
  );
}

export default function SkinVisualAIReview({ recordId, consultationId, examIdentity, context, reviewed, onChange, disabled = false }: Props) {
  const [status, setStatus] = useState<SkinStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [statusVersion, setStatusVersion] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [consent, setConsent] = useState(false);
  const [photo, setPhoto] = useState<SelectedPhoto | null>(null);
  const [photos, setPhotos] = useState<LibraryPhoto[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [analysis, setAnalysis] = useState<SkinAnalysis | null>(null);
  const [provenance, setProvenance] = useState<Omit<ReviewedSkinMark['source'], 'proposal'> | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [category, setCategory] = useState<SkinCategory>('acne');
  const [zoom, setZoom] = useState(1);
  const work = useRef(new SkinRequestScope());
  const libraryWork = useRef(new SkinRequestScope());
  const statusWork = useRef(new SkinRequestScope());
  const [libraryLoading, setLibraryLoading] = useState(false);
  const blobUrl = useRef<string | null>(null);

  // Synchronous commit-boundary reset: do not rely on a parent's key or passive unmount cleanup.
  useLayoutEffect(() => {
    work.current.cancel(); libraryWork.current.cancel(); statusWork.current.cancel();
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
    setEnabled(false); setConsent(false); setPhoto(null); setPhotos([]); setLibraryLoaded(false);
    setHasMore(false); setBusy(''); setError(''); setNotice(''); setAnalysis(null); setProvenance(null);
    setDrafts([]); setCategory('acne'); setZoom(1); setLibraryLoading(false);
    setStatus(null); setStatusLoading(true); setStatusError('');
  }, [recordId, consultationId, examIdentity]);

  useEffect(() => {
    const scope = statusWork.current;
    const task = scope.start();
    setStatusLoading(true); setStatusError(''); setStatus(null);
    recordsFetch('/api/ai-consultation?action=skinVisualStatus', { signal: task.signal })
      .then(responseJSON).then(parseSkinStatus)
      .then(value => { if (task.current()) setStatus(value); })
      .catch(e => { if (task.current()) setStatusError(e instanceof Error ? e.message : 'No se pudo verificar el permiso.'); })
      .finally(() => { if (task.current()) setStatusLoading(false); });
    return () => { scope.cancel(); };
  }, [recordId, consultationId, examIdentity, statusVersion]);

  useEffect(() => () => {
    work.current.cancel(); libraryWork.current.cancel(); statusWork.current.cancel();
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
  }, []);

  function cancel() {
    work.current.cancel(); setBusy('');
    setNotice('Espera cancelada en este navegador. Esto no garantiza detener un envío ya iniciado ni evitar su coste; el servidor conserva la reserva ante incertidumbre. Una subida puede haber guardado una copia: comprueba Fotos antes de repetirla.');
  }
  function clearPhoto() {
    work.current.cancel(); setBusy(''); setPhoto(null); setConsent(false);
    setDrafts([]); setAnalysis(null); setProvenance(null); setError(''); setNotice(''); setZoom(1);
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
  }
  async function selectPhoto(file: Blob | null, library?: LibraryPhoto) {
    clearPhoto();
    const task = work.current.start();
    setBusy('Preparando foto…');
    try {
      if (library) {
        parsePhotoReference(library, recordId);
        const readURL = safePhotoReadURL(library.r2_url);
        // Signed storage URL only, never attach the clinical session token to storage requests.
        const response = await fetch(readURL, { signal: task.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
        if (!response.ok) throw new Error('No se pudo abrir la foto. Actualiza la biblioteca y reintenta.');
        const length = Number(response.headers.get('content-length'));
        if (length > 12 * 1024 * 1024) throw new Error('La foto supera 12 MB.');
        file = await response.blob();
      }
      if (!file) return;
      const prepared = await prepareSkinPhoto(file, task.signal);
      if (!task.current()) return;
      const url = URL.createObjectURL(prepared.blob);
      blobUrl.current = url;
      setPhoto({ prepared, url, reference: library ? parsePhotoReference(library, recordId) : null,
        name: library ? `Foto #${library.id}` : 'Foto local temporal' });
    } catch (e) {
      if (task.current()) setError(e instanceof Error ? e.message : 'No se pudo preparar la foto.');
    } finally { if (task.current()) setBusy(''); }
  }
  async function loadLibrary(append = false) {
    const task = libraryWork.current.start();
    setLibraryLoading(true); setError('');
    try {
      const data = await responseJSON(await recordsFetch(
        `/api/records?action=listPhotos&record_id=${encodeURIComponent(recordId)}&limit=50&offset=${append ? photos.length : 0}`,
        { signal: task.signal },
      ));
      if (!data || typeof data !== 'object' || !('photos' in data) || !Array.isArray(data.photos)) throw new Error('Biblioteca no disponible.');
      const loaded = data.photos.filter((p): p is LibraryPhoto => p && Number.isInteger(p.id) && typeof p.r2_key === 'string' &&
        (p.r2_url === null || typeof p.r2_url === 'string'));
      if (!task.current()) return;
      setPhotos(prev => append ? [...prev, ...loaded] : loaded); setLibraryLoaded(true);
      setHasMore('hasMore' in data && data.hasMore === true);
    } catch (e) { if (task.current()) setError(e instanceof Error ? e.message : 'Error al cargar las fotos.'); }
    finally { if (task.current()) setLibraryLoading(false); }
  }
  async function savePhoto() {
    if (!photo || photo.reference || busy) return;
    const task = work.current.start();
    setBusy('Guardando copia de la foto…'); setError('');
    try {
      const data = await responseJSON(await recordsFetch('/api/records', {
        method: 'POST', signal: task.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'uploadPhotoProxy', record_id: recordId, consultation_id: consultationId,
          fileBase64: photo.prepared.base64, content_type: 'image/jpeg', photo_type: 'general',
          session_label: 'Referencia de revisión visual 2D' }),
      }));
      const reference = parsePhotoReference(data, recordId);
      if (!task.current()) return;
      setPhoto({ ...photo, reference });
      setNotice('Copia JPEG guardada en Fotos; las anotaciones se guardan por separado con Guardar examen.');
    } catch (e) { if (task.current()) setError(e instanceof Error ? e.message : 'No se pudo guardar la foto.'); }
    finally { if (task.current()) setBusy(''); }
  }
  async function analyze() {
    if (!photo || !consent || !enabled || !status?.enabled || status.remainingUsd <= 0 || busy) return;
    const task = work.current.start();
    const requestId = crypto.randomUUID();
    const consentedAt = new Date().toISOString();
    const sentContext = { ...context };
    setConsent(false); setBusy('Solicitando propuestas a Gemini…'); setError(''); setNotice('');
    setAnalysis(null); setDrafts([]); setProvenance(null);
    try {
      const result = parseSkinAnalysis(await responseJSON(await recordsFetch('/api/ai-consultation?action=analyzeSkinVisual', {
        method: 'POST', signal: task.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId, imageBase64: photo.prepared.base64, mimeType: 'image/jpeg',
          consent: true, context: sentContext, requestId }),
      })));
      if (!task.current()) return;
      setAnalysis(result); setDrafts(result.proposals.map(p => ({ ...p, box: { ...p.box }, rejected: false })));
      setCategory(result.proposals[0]?.category ?? 'acne');
      setProvenance({ provider: 'google-gemini', analysisId: result.analysisId, model: result.model, requestId,
        analyzedAt: new Date().toISOString(), consentedAt, imageWidth: photo.prepared.width,
        imageHeight: photo.prepared.height, summary: result.summary, limitations: result.limitations, context: sentContext });
      setStatus(prev => prev ? { ...prev, ...result.usage } : prev);
    } catch (e) {
      if (task.current()) {
        setError(e instanceof Error ? e.message : 'No se pudo analizar. Revisa el permiso y reintenta.');
        setStatusVersion(v => v + 1); // Server authority: refresh permission/budget after a refused POST.
      }
    } finally { if (task.current()) setBusy(''); }
  }
  const markId = (id: string) => `skin-photo:${analysis?.analysisId}:${id}`;
  function editDraft(id: string, patch: Partial<SkinProposal>) {
    onChange(reviewed.filter(m => m.id !== markId(id))); // Editing invalidates prior verification.
    setDrafts(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }
  function validate(draft: Draft) {
    const original = analysis?.proposals.find(p => p.id === draft.id);
    if (!photo?.reference || !original || !provenance) return;
    try {
      const mark = validateProposal(draft, photo.reference, { ...provenance, proposal: original });
      onChange([...reviewed.filter(m => m.id !== mark.id), mark]);
      setNotice('Región verificada. Falta pulsar Guardar examen para persistirla.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Revisa esta región.'); }
  }
  const visibleDrafts = drafts.filter(p => p.category === category);
  const boxes: { id: string; label: string; box: NormalizedBox; validated: boolean; number: number }[] = [
    ...drafts.filter(p => p.category === category && !p.rejected && validBox(p.box)).map(p => ({
      id: markId(p.id), label: p.label, box: p.box, validated: reviewed.some(m => m.id === markId(p.id)),
      number: drafts.findIndex(d => d.id === p.id) + 1,
    })),
    ...reviewed.filter(m => m.photo.id === photo?.reference?.id && m.category === category &&
      !drafts.some(p => markId(p.id) === m.id)).map((m, i) => ({
      id: m.id, label: m.label, box: m.normalizedBox, validated: true, number: drafts.length + i + 1,
    })),
  ];

  return (
    <section aria-label="Revisión visual opcional con IA" className="mb-6 min-w-0 space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-gray-900">
      <h3 className="font-bold">Revisión visual 2D · Gemini opcional</h3>
      <p className="text-sm">Propuestas ilustrativas, no diagnóstico. Verifica cada región antes de guardar. Una respuesta vacía no descarta lesiones. No evalúa poros ni clasifica el tipo de piel; el contexto procede del examen manual.</p>
      <div role="status" className="space-y-1 text-sm">
        {statusLoading ? <p>Consultando permiso del servidor…</p> : statusError ? <p className="text-red-700">{statusError}</p> :
          status && <><p>{status.enabled ? 'Disponible según el servidor.' : `Deshabilitado: ${status.reason || 'sin autorización del servidor'}`}</p>
            <p className="text-xs">Consumo estimado: {money(status.usedUsd)} / {money(status.limitUsd)} · Disponible: {money(status.remainingUsd)}.
              Tope estimado de 5 USD; no garantiza el importe de la factura.</p></>}
      </div>
      <button type="button" className={button} disabled={statusLoading || disabled} onClick={() => setStatusVersion(v => v + 1)}>Actualizar permiso</button>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="admin-focus-ring mt-1" checked={enabled} disabled={disabled}
          onChange={e => { setEnabled(e.target.checked); setConsent(false); if (!e.target.checked) cancel(); }} />
        Habilitar propuestas IA en este examen (opcional)
      </label>
      {enabled && (
        <div className="space-y-4">
          <p className="text-xs text-gray-600">Cambiar o quitar la foto descarta las propuestas pendientes, no las regiones ya verificadas. El mapa 3D genérico permanece independiente.</p>
          <div className="flex flex-wrap gap-3">
            <label className="block text-sm">Subir foto para revisión (JPEG/PNG)
              <input aria-label="Subir foto para revisión" type="file" accept="image/jpeg,image/png" className={`${input} mt-1`} disabled={disabled}
                onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void selectPhoto(file); }} />
            </label>
            <label className="block text-sm">Tomar foto
              <input aria-label="Tomar foto para revisión" type="file" accept="image/jpeg,image/png" capture="environment" className={`${input} mt-1`} disabled={disabled}
                onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void selectPhoto(file); }} />
            </label>
          </div>
          <div className="space-y-2">
            <button type="button" className={button} disabled={libraryLoading || disabled} onClick={() => void loadLibrary()}>
              {libraryLoading ? 'Cargando biblioteca…' : 'Cargar / actualizar fotos de esta ficha'}
            </button>
            {libraryLoaded && (photos.length ? <label className="block text-sm">Seleccionar foto disponible
              <select aria-label="Foto disponible de esta ficha" className={input} value="" disabled={disabled}
                onChange={e => { const selected = photos.find(p => p.id === Number(e.target.value)); if (selected) void selectPhoto(null, selected); }}>
                <option value="">Elige una foto…</option>
                {photos.map(p => <option key={p.id} value={p.id} disabled={!p.r2_url}>Foto #{p.id}{p.session_label ? ` · ${p.session_label}` : ''}{!p.r2_url ? ' · No disponible' : ''}</option>)}
              </select>
            </label> : <p className="text-sm">No hay fotos disponibles en esta ficha.</p>)}
            {hasMore && <button type="button" className={button} disabled={libraryLoading || disabled} onClick={() => void loadLibrary(true)}>Cargar más fotos</button>}
          </div>
          {photo && <>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold">{photo.name}{photo.reference ? ` · Referencia guardada #${photo.reference.id}` : ' · Sin referencia persistente'}</p>
              <button type="button" className={button} disabled={disabled} onClick={clearPhoto}>Quitar foto</button>
            </div>
            {!photo.reference && <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p>Foto temporal: se elimina al salir. Para validar y guardar anotaciones, guarda expresamente una copia JPEG reducida y sin metadatos en Fotos. El original local no se sube.</p>
              <button type="button" className={button} disabled={!!busy || disabled} onClick={() => void savePhoto()}>Guardar copia de referencia en Fotos</button>
            </div>}
            <label className="block text-sm">Capa por categoría
              <select className={input} value={category} onChange={e => setCategory(e.target.value as SkinCategory)}>
                {Object.entries(SKIN_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label} ({drafts.filter(p => p.category === key && !p.rejected).length})</option>)}
              </select>
            </label>
            <label className="flex items-center gap-3 text-sm">Zoom {Math.round(zoom * 100)} %
              <input aria-label="Zoom de foto" className="admin-focus-ring min-w-0 flex-1" type="range" min="1" max="3" step="0.25" value={zoom} onChange={e => setZoom(Number(e.target.value))} />
            </label>
            <div className="admin-focus-ring max-h-[32rem] overflow-auto rounded-lg border border-gray-300 bg-gray-200" tabIndex={0} role="region" aria-label="Foto con regiones rectangulares; desplaza para explorar con zoom">
              <div className="relative" style={{ width: `${zoom * 100}%` }}>
                <img src={photo.url} width={photo.prepared.width} height={photo.prepared.height} alt="Foto seleccionada para revisión visual 2D" className="block h-auto w-full" />
                {boxes.map(region => <div key={region.id} className={`pointer-events-none absolute border-2 ${region.validated ? 'border-emerald-500' : 'border-amber-400'}`}
                  style={{ left: `${region.box.x * 100}%`, top: `${region.box.y * 100}%`, width: `${region.box.width * 100}%`, height: `${region.box.height * 100}%` }}>
                  <span className="absolute left-0 top-0 max-w-full truncate bg-gray-950 px-1 text-xs text-white" title={region.label}>
                    {region.number} · {region.label} · {region.validated ? 'Verificada' : 'Propuesta'}
                  </span>
                </div>)}
              </div>
            </div>
            <p className="text-xs text-gray-600">Cajas aproximadas, no máscaras segmentadas ni delimitación exacta. No se transfieren al modelo 3D.</p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="admin-focus-ring mt-1" checked={consent} disabled={!!busy || disabled}
                onChange={e => setConsent(e.target.checked)} />
              Autorizo este envío de esta foto reducida y del contexto manual a Google (Gemini), servicio externo, no motor local. Cuento con autorización para compartirla.
            </label>
            <button type="button" className={button} disabled={!consent || !status?.enabled || statusLoading || status.remainingUsd <= 0 || !!busy || disabled}
              onClick={() => void analyze()}>Solicitar propuestas para esta foto</button>
            <p className="text-xs text-gray-600">Cancelar la espera en el navegador no garantiza detener un envío ya iniciado ni evitar su coste. El servidor conserva la reserva de presupuesto ante incertidumbre.</p>
            {status?.enabled && status.remainingUsd <= 0 && <p className="text-sm text-amber-900">Presupuesto estimado agotado; no se puede solicitar otro análisis.</p>}
          </>}
          {busy && <div role="status" className="flex flex-wrap items-center gap-2 text-sm">{busy}
            <button type="button" className={button} onClick={cancel}>Cancelar espera</button>
          </div>}
          {analysis && <div className="space-y-3">
            <p className="break-words text-sm">{analysis.summary}</p>
            <ul className="list-inside list-disc break-words text-xs text-gray-600">{analysis.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul>
            <p className="text-sm">{drafts.length} propuestas; ninguna se acepta automáticamente.
              {!photo?.reference && ' Guarda la foto de referencia antes de validar.'}</p>
            {!drafts.length && <p className="text-sm font-semibold">Sin propuestas. Esto no descarta lesiones; continúa el examen manual.</p>}
            {drafts.length > 0 && !visibleDrafts.length && <p className="text-sm">Sin propuestas en esta categoría. Selecciona otra capa.</p>}
            <ol className="space-y-3">{visibleDrafts.map(p => <ProposalEditor key={p.id} proposal={p} index={drafts.findIndex(d => d.id === p.id)}
              validated={reviewed.some(m => m.id === markId(p.id))} disabled={disabled || !!busy}
              onEdit={patch => editDraft(p.id, patch)}
              onReject={() => { onChange(reviewed.filter(m => m.id !== markId(p.id))); setDrafts(prev => prev.map(d => d.id === p.id ? { ...d, rejected: !d.rejected } : d)); }}
              onValidate={() => { if (!photo?.reference) setError('Guarda primero la foto de referencia.'); else validate(p); }} />)}</ol>
          </div>}
        </div>
      )}
      {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="text-sm text-gray-700">{notice}</p>}
      <div className="space-y-2 border-t border-gray-200 pt-3">
        <h4 className="text-sm font-semibold">Regiones verificadas del examen ({reviewed.length})</h4>
        <p className="text-xs text-gray-600">Solo estas regiones se incluyen al pulsar Guardar examen. Pendientes y descartadas no persisten. Para volver a ver una capa, carga la biblioteca y selecciona su foto.</p>
        {!reviewed.length ? <p className="text-sm">Ninguna región verificada. Esto no descarta lesiones.</p> :
          <ul className="max-h-64 space-y-2 overflow-auto">{reviewed.map(m => <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-2 text-sm">
            <span className="min-w-0 break-words">{skinReviewDescription(m)} · Verificada, no diagnóstico</span>
            <button type="button" className={button} disabled={disabled} onClick={() => onChange(reviewed.filter(item => item.id !== m.id))}>Retirar región verificada</button>
          </li>)}</ul>}
      </div>
    </section>
  );
}
