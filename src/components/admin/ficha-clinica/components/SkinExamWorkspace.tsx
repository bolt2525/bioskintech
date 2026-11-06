import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import recordsFetch from '../../../../utils/recordsFetch';
import { SimulationPhotoLibrary } from './SimulationPhotoLibrary';
import { ensureSimulationPhotos, loadSimulationPhotos } from './simulationPhotos';
import type { SimulationPhotoCache } from './simulationPhotos';
import { fromLegacySkinReview, fromPersistedSkinReview, skinReviewSummaries, toPersistedSkinReview } from './skinEvaluation';
import type { EvaluationMark, PersistedSkinReview } from './skinEvaluation';
import { parseSkinReview } from './skinVisualAI';
import type { PhotoReference, SkinContext, SkinVisualReviewData } from './skinVisualAI';
import { SIMULATION_PHOTO_SLOTS } from '../../../../lab/faceSim/facialSimulationSession';
import type { FaceSimController, FaceSimIntegration, FacialSimulationState, SimulationPhotoSlot } from '../../../../lab/faceSim/facialSimulationSession';

const FaceSimLab = lazy(() => import('../../../../lab/faceSim/FaceSimLab'));
const button = 'admin-focus-ring rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-50';
type Review = string | SkinVisualReviewData | PersistedSkinReview | undefined;

function priorReferences(review: Review): Record<string, PhotoReference> {
  let data: unknown = review;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return {}; } }
  if (!data || typeof data !== 'object' || !('version' in data)) return {};
  const photos: PhotoReference[] = data.version === 1 ? parseSkinReview(data as SkinVisualReviewData).map(m => m.photo) :
    data.version === 2 && 'annotations' in data && Array.isArray(data.annotations)
      ? data.annotations.flatMap((m: { photo?: PhotoReference; observations?: { photo: PhotoReference }[] }) =>
        m.photo ? [m.photo, ...(m.observations?.map(o => o.photo) ?? [])] : []) : [];
  const unique = photos.filter((photo, index) => photos.findIndex(item => item.id === photo.id && item.r2Key === photo.r2Key) === index);
  if (unique.length > SIMULATION_PHOTO_SLOTS.length) throw new Error('Esta revisión usa más fotos de las que puede vincular el editor. Los datos anteriores se conservan.');
  return Object.fromEntries(unique.map((photo, index) => [SIMULATION_PHOTO_SLOTS[index], photo]));
}

function simulationId(review: Review): number | undefined {
  let data: unknown = review;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return undefined; } }
  return data && typeof data === 'object' && 'version' in data && data.version === 2 && 'simulationId' in data &&
    typeof data.simulationId === 'number' && Number.isInteger(data.simulationId) && data.simulationId > 0 ? data.simulationId : undefined;
}

function reviewIntegrity(review: Review): string {
  if (!review) return '';
  let value: unknown = review;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return 'La revisión anterior no se pudo leer; no se modificará.'; } }
  if (!value || typeof value !== 'object' || !('version' in value) || ![1, 2].includes(Number(value.version)) ||
    !('annotations' in value) || !Array.isArray(value.annotations) ||
    skinReviewSummaries(value).length !== value.annotations.length) return 'La revisión anterior contiene datos no reconocidos; no se modificará.';
  return '';
}

async function json(response: Response) {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `Error HTTP ${response.status}.`);
  return value;
}

export type SkinExamSave = () => Promise<PersistedSkinReview>;
export default function SkinExamWorkspace({ recordId, context, review, onPrepared, onDirty, legacyMigration, onCaptureReady, referenceView, viewMode, aiAllowed, active, referenceVisible, onReferencePoints, selectedReferenceId,
  hoveredMarkId, onHoverMark, visibility, onEvaluationChange, saveController }: {
  recordId: number; context: SkinContext; review: Review;
  onPrepared: (review: PersistedSkinReview) => void; onDirty: () => void;
  legacyMigration?: FaceSimIntegration['legacyMigration'];
  onCaptureReady?: (ready: boolean) => void;
  referenceView?: ReactNode; viewMode?: 'mask' | 'split'; aiAllowed?: boolean;
  active?: boolean; referenceVisible?: boolean; onReferencePoints?: FaceSimIntegration['onReferencePoints'];
  selectedReferenceId?: string;
  hoveredMarkId?: string | null; onHoverMark?: (id: string | null) => void;
  visibility?: { marks: boolean; names: boolean };
  onEvaluationChange?: (marks: EvaluationMark[]) => void;
  saveController?: { current: SkinExamSave | null };
}) {
  const prior = useMemo(() => {
    try { return { refs: priorReferences(review), error: reviewIntegrity(review) }; }
    catch (e) { return { refs: {}, error: e instanceof Error ? e.message : 'La revisión anterior no se pudo abrir.' }; }
  }, [review]);
  const initialRefs = prior.refs;
  const initialMarks = useMemo(() => {
    const old = fromLegacySkinReview(review as string | SkinVisualReviewData | undefined, initialRefs);
    return old.length ? old : fromPersistedSkinReview(review as string | PersistedSkinReview | undefined, initialRefs);
  }, [review, initialRefs]);
  const [busy, setBusy] = useState(false);
  const [hasPhotos, setHasPhotos] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(!simulationId(review));
  const [controllerReady, setControllerReady] = useState(false);
  const controller = useRef<FaceSimController | null>(null);
  const cache = useRef<SimulationPhotoCache>(new Map());
  const pending = useRef(new Map<string, { canvas?: HTMLCanvasElement; file?: File; reference: PhotoReference }>());
  const operation = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const savingRequest = useRef(false);
  const onController = useCallback((next: FaceSimController | null) => {
    controller.current = next;
    if (!next) return;
    setControllerReady(true);
    setHasPhotos(next.getPhotos().length > 0);
    onEvaluationChange?.(next.getMarks());
    for (const capture of next.getPhotos()) {
      const entry = [...pending.current].find(([, item]) => item.canvas === capture.canvas || (!!item.file && item.file === capture.original));
      if (entry) {
        const [key, item] = entry;
        cache.current.set(capture.id, { recordId, canvas: capture.canvas, original: capture.original, reference: item.reference });
        pending.current.delete(key);
      }
    }
  }, [recordId, onEvaluationChange]);
  const changed = useCallback(() => {
    revision.current++; request.current = null; onDirty();
  }, [onDirty]);

  useEffect(() => {
    const id = simulationId(review);
    if (!id || !controllerReady) return;
    const task = new AbortController();
    operation.current = task;
    setBusy(true); setError('');
    (async () => {
      const data = await json(await recordsFetch(`/api/records?action=getFacialSimulation&record_id=${recordId}&id=${id}&scope=physical-exam`, { signal: task.signal }));
      const state = data.state as FacialSimulationState;
      const expected = skinReviewSummaries(review).map(mark => mark.id).sort();
      const actual = Array.isArray(state?.marks) ? state.marks.filter(mark => mark.status === 'validated').map(mark => mark.id).sort() : [];
      if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
        throw new Error('Las regiones de la máscara no coinciden con este examen. No se modificaron los datos.');
      }
      const images = await loadSimulationPhotos(recordId, state, task.signal);
      task.signal.throwIfAborted();
      if (!controller.current) throw new Error('El editor no está listo. Cierra y vuelve a abrir la evaluación.');
      for (const item of state.photos) pending.current.set(item.slot, { canvas: images.canvases[item.slot], reference: item.photo });
      await controller.current.restore(state, images.canvases, images.originals);
      task.signal.throwIfAborted(); setReady(true); setNotice('Evaluación y máscara recuperadas sin reconstrucción.');
    })().catch(e => { if (!task.signal.aborted) setError(e instanceof Error ? e.message : 'No se pudo recuperar la evaluación.'); })
      .finally(() => { if (!task.signal.aborted) setBusy(false); });
    return () => { task.abort(); if (operation.current === task) operation.current = null; };
  }, [recordId, review, controllerReady]);
  useEffect(() => () => operation.current?.abort(), []);

  async function prepare(): Promise<PersistedSkinReview> {
    if (savingRequest.current || busy || !ready || prior.error) throw new Error(prior.error || 'Espera a que termine la preparación de la máscara.');
    const current = controller.current;
    if (!current) throw new Error('El editor aún no está listo.');
    if (current.getMarks().some(mark => mark.status === 'pending')) {
      throw new Error('Confirma o descarta las marcas pendientes antes de guardar.');
    }
    savingRequest.current = true;
    const task = new AbortController();
    operation.current = task;
    setBusy(true); setError(''); setNotice('');
    try {
      const start = revision.current;
      const captures = current.getPhotos();
      if (!captures.length) throw new Error('Agrega las fotografías antes de preparar la evaluación.');
      for (const mark of current.getMarks()) {
        const capture = captures.find(item => item.id === mark.sourceId);
        if (!capture) throw new Error('Falta la fotografía correspondiente a una región. Vincúlala antes de preparar.');
        const expected = !simulationId(review) ? initialRefs[mark.sourceId] : undefined;
        const cached = cache.current.get(mark.sourceId);
        if (expected && (!cached || cached.canvas !== capture.canvas || cached.original !== capture.original ||
          cached.reference.id !== expected.id || cached.reference.r2Key !== expected.r2Key)) {
          throw new Error(`Vincula la foto clínica #${expected.id} en la vista ${mark.sourceId} antes de preparar la revisión anterior.`);
        }
      }
      const refs = await ensureSimulationPhotos(recordId, captures, cache.current, task.signal);
      if (revision.current !== start) throw new Error('La evaluación cambió durante el guardado. Vuelve a intentarlo.');
      const reviewed = toPersistedSkinReview(current.getMarks(), refs);
      const state = await current.snapshot(refs);
      if (revision.current !== start) throw new Error('La evaluación cambió durante el guardado. Vuelve a intentarlo.');
      const value = { action: 'saveFacialSimulation', record_id: recordId, scope: 'physical-exam', state };
      const payload = JSON.stringify(value);
      if (!request.current || request.current.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
      const body = JSON.stringify({ ...value, requestId: request.current.id });
      if (new Blob([body]).size > 4_000_000) throw new Error('La evaluación supera 4 MB y no se guardó ni simplificó.');
      const result = await json(await recordsFetch('/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: task.signal,
      }));
      if (!Number.isInteger(result?.id) || result.id <= 0) throw new Error('No se confirmó la sesión. Reintenta con la misma solicitud.');
      if (revision.current !== start) throw new Error('La evaluación cambió durante el guardado. Prepara la versión actual.');
      const prepared = { ...reviewed, simulationId: result.id };
      onPrepared(prepared);
      setNotice('Fotos y máscara listas para vincular al examen.');
      return prepared;
    } catch (e) {
      if (!task.signal.aborted) setError(e instanceof Error ? e.message : 'No se pudo preparar la evaluación.');
      throw e;
    } finally {
      savingRequest.current = false;
      if (operation.current === task) { operation.current = null; setBusy(false); }
    }
  }
  useEffect(() => {
    if (!saveController) return;
    saveController.current = prepare;
    return () => { saveController.current = null; };
  });

  async function importLibraryPhotos(items: { photo: PhotoReference; file: File }[]) {
    const editor = controller.current;
    if (!editor) throw new Error('El editor aún no está listo.');
    const expected = items.map(({ photo }) => Object.entries(initialRefs).find(([, ref]) => ref.id === photo.id && ref.r2Key === photo.r2Key));
    if (initialMarks.length && !simulationId(review) && expected.some(item => !item)) {
      throw new Error('Selecciona las fotografías originales de la revisión anterior.');
    }
    for (const item of items) pending.current.set(`photo-${item.photo.id}`, { file: item.file, reference: item.photo });
    try {
      if (initialMarks.length && !simulationId(review)) {
        for (const [index, item] of items.entries()) {
          await controller.current!.importPhoto(item.file, expected[index]![0] as SimulationPhotoSlot);
        }
      } else await editor.importPhotos(items.map(item => item.file));
    } catch (e) {
      for (const item of items) pending.current.delete(`photo-${item.photo.id}`);
      throw e;
    }
  }

  return <section aria-label="Evaluación compartida de piel" className="min-w-0 space-y-3">
    {initialMarks.length > 0 && !simulationId(review) && <p className="text-sm text-amber-800">Para editar la revisión anterior, selecciona sus fotos originales del expediente. Las marcas se conservan.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {prior.error && <p role="alert" className="text-sm text-red-700">{prior.error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <fieldset disabled={busy || !ready} aria-busy={busy || !ready} className={busy || !ready ? 'pointer-events-none opacity-60' : ''}>
    <Suspense fallback={<p role="status">Abriendo el editor…</p>}>
      <FaceSimLab integration={{ mode: 'skin-exam', recordId, context, initialMarks, onController, onDirty: changed, onMarksChange: changed,
        referenceView, viewMode, aiAllowed, active, referenceVisible, onReferencePoints, selectedReferenceId,
        hoveredMarkId, onHoverMark, visibility,
        legacyMigration, onCaptureReady, photoLibrary: <SimulationPhotoLibrary recordId={recordId} selection="multiple"
          onSelect={(photo, file) => importLibraryPhotos([{ photo, file }])} onSelectMany={importLibraryPhotos} /> }} />
    </Suspense>
    </fieldset>
    {hasPhotos && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{saveController ? 'Guardar examen incluye fotografías, máscara y marcas confirmadas.' : 'Prepara las fotos y la máscara para vincularlas al examen.'}</p>
      {!saveController && <button type="button" className={button} disabled={busy || !ready || !!prior.error}
        onClick={() => { void prepare().catch(e => setError(e instanceof Error ? e.message : 'No se pudo preparar la evaluación.')); }}>{busy ? 'Preparando…' : 'Preparar para guardar'}</button>}
    </div>}
  </section>;
}
