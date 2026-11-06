import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import AdminLayout from '../components/layout/AdminLayout';
import { Dialog } from '../components/ui/Dialog';
import { SimulationPatientDialog, type SimulationPatient, type SimulationRecord } from '../components/admin/ficha-clinica/components/SimulationPatientDialog';
import { SimulationPhotoLibrary } from '../components/admin/ficha-clinica/components/SimulationPhotoLibrary';
import { ensureSimulationPhotos, loadSimulationPhotos, type SimulationPhotoCache } from '../components/admin/ficha-clinica/components/simulationPhotos';
import { toPersistedSkinReview } from '../components/admin/ficha-clinica/components/skinEvaluation';
import type { PhotoReference } from '../components/admin/ficha-clinica/components/skinVisualAI';
import { useAuth } from '../context/AuthContext';
import { useMasterView } from '../context/MasterViewContext';
import { useAdminNav } from '../hooks/useAdminNav';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import FaceSimLab from '../lab/faceSim/FaceSimLab';
import { SIMULATION_PHOTO_SLOTS, type FaceSimController, type FacialSimulationState, type SimulationPhotoSlot } from '../lab/faceSim/facialSimulationSession';
import recordsFetch from '../utils/recordsFetch';

const button = 'admin-focus-ring min-h-11 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50';
const input = 'admin-focus-ring w-full rounded-lg border border-gray-300 bg-white p-2 text-sm';
type Destination = 'mask' | 'exam';
type Revision = { id: number; created_at: string };
type PendingReference = { file?: File; canvas?: HTMLCanvasElement; recordId: number; reference: PhotoReference };
type ExamAntecedent = { skin_type?: string; phototype?: string; glogau_scale?: string; created_at?: string };

async function json(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Error HTTP ${response.status}.`);
  return data;
}

export default function FacialSimulation() {
  const { hasFeature, logout } = useAuth();
  const master = useMasterView();
  const { nav } = useAdminNav();
  const allowed = master.isActive ? master.hasFeatureInContext('facial_simulation') : hasFeature('facial_simulation');
  const [patient, setPatient] = useState<SimulationPatient | null>(null);
  const [record, setRecord] = useState<SimulationRecord | null>(null);
  const [patientDialog, setPatientDialog] = useState(true);
  const [pendingSave, setPendingSave] = useState<Destination | null>(null);
  const [library, setLibrary] = useState(false);
  const [libraryImporting, setLibraryImporting] = useState(false);
  const [slot, setSlot] = useState<SimulationPhotoSlot>('frontal');
  const [exam, setExam] = useState(false);
  const [reason, setReason] = useState('');
  const [skinType, setSkinType] = useState('');
  const [phototype, setPhototype] = useState('');
  const [hydration, setHydration] = useState('');
  const [glogau, setGlogau] = useState('');
  const [antecedent, setAntecedent] = useState<ExamAntecedent | null>(null);
  const [antecedentError, setAntecedentError] = useState('');
  const [antecedentLoading, setAntecedentLoading] = useState(false);
  const [antecedentVersion, setAntecedentVersion] = useState(0);
  const [examDirty, setExamDirty] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leave, setLeave] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<Revision[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const controller = useRef<FaceSimController | null>(null);
  const photos = useRef<SimulationPhotoCache>(new Map());
  const pending = useRef(new Map<string, PendingReference>());
  const operation = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const revision = useRef(0);
  const requests = useRef<Partial<Record<Destination, { payload: string; id: string }>>>({});
  const savedSnapshot = useRef<{ payload: string; id: number } | null>(null);
  const leaveAfterSave = useRef(false);
  const leaveTarget = useRef<'dashboard' | 'logout'>('dashboard');
  const allowLeave = useRef(false);
  const blocker = useBlocker(() => !allowLeave.current && (dirty || examDirty));
  useUnsavedChangesGuard(dirty || examDirty);
  useEffect(() => { if (blocker.state === 'blocked') setLeave(true); }, [blocker.state]);

  const onController = useCallback((value: FaceSimController | null) => {
    controller.current = value;
    if (!value) return;
    for (const capture of value.getPhotos()) {
      const item = pending.current.get(capture.id);
      if (item && ((item.file && item.file === capture.original) || (item.canvas && item.canvas === capture.canvas))) {
        photos.current.set(capture.id, { recordId: item.recordId, canvas: capture.canvas, original: capture.original, reference: item.reference });
        pending.current.delete(capture.id);
      }
    }
  }, []);
  const onDirty = useCallback(() => {
    revision.current++; requests.current = {}; savedSnapshot.current = null; setDirty(true);
  }, []);
  useEffect(() => () => { operation.current?.abort(); }, []);
  useEffect(() => { setHistory([]); setCursor(null); }, [record?.id]);
  useEffect(() => {
    setAntecedent(null); setAntecedentError('');
    if (!exam || !record) return;
    const task = new AbortController();
    setAntecedentLoading(true);
    recordsFetch(`/api/records?action=getRecordData&recordId=${record.id}`, { signal: task.signal })
      .then(json).then(data => {
        if (task.signal.aborted) return;
        if (!Array.isArray(data.physicalExams)) throw new Error('No se pudieron leer los antecedentes de exámenes.');
        const previous: unknown = data.physicalExams[0];
        if (previous !== undefined) {
          if (!previous || typeof previous !== 'object' ||
            ['skin_type', 'phototype', 'glogau_scale', 'created_at'].some(key => key in previous &&
              typeof Reflect.get(previous, key) !== 'string' && Reflect.get(previous, key) !== null)) {
            throw new Error('El antecedente recibido tiene un formato no reconocido.');
          }
          setAntecedent(previous);
        }
      }).catch(e => { if (!task.signal.aborted) setAntecedentError(e instanceof Error ? e.message : 'No se pudieron consultar antecedentes.'); })
      .finally(() => { if (!task.signal.aborted) setAntecedentLoading(false); });
    return () => task.abort();
  }, [exam, record, antecedentVersion]);

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    const task = new AbortController();
    operation.current = task;
    setBusy(label); setError(''); setNotice('');
    try { await work(task.signal); }
    catch (e) { if (!task.signal.aborted) setError(e instanceof Error ? e.message : 'No se pudo completar la operación.'); }
    finally { if (operation.current === task) { operation.current = null; lock.current = false; setBusy(''); } }
  }
  function selectRecord(nextPatient: SimulationPatient, nextRecord: SimulationRecord) {
    if (record && (record.id !== nextRecord.id || patient?.id !== nextPatient.id)) {
      if (!window.confirm('Cambiar de paciente o expediente borrará el trabajo actual de esta sesión. ¿Continuar?')) return;
      operation.current?.abort(); controller.current?.reset(); photos.current.clear(); pending.current.clear();
      requests.current = {}; savedSnapshot.current = null; revision.current++; setDirty(false); setExamDirty(false); setReason(''); setSkinType(''); setPhototype(''); setHydration(''); setGlogau('');
    }
    setPatient(nextPatient); setRecord(nextRecord); setPatientDialog(false);
  }
  function finishLeave() {
    allowLeave.current = true;
    if (blocker.state === 'blocked') { blocker.proceed(); return; }
    if (leaveTarget.current === 'logout') { logout(); nav('/admin/login'); }
    else nav('');
    leaveTarget.current = 'dashboard';
  }
  function continueWorking() {
    if (blocker.state === 'blocked') blocker.reset();
    setLeave(false);
  }
  function leavePage(target: 'dashboard' | 'logout' = 'dashboard') {
    if (lock.current) return;
    leaveTarget.current = target;
    if (dirty || examDirty) setLeave(true);
    else finishLeave();
  }
  async function save(destination: Destination) {
    if (!record) { setPendingSave(destination); setLeave(false); setPatientDialog(true); return; }
    if (destination === 'exam' && (!reason.trim() || !skinType || !phototype)) {
      setExam(true); setError('Confirma el motivo, el tipo de piel y el fototipo antes de guardar.'); return;
    }
    await run(destination === 'mask' ? 'Guardando máscara…' : 'Guardando examen…', async signal => {
      const current = controller.current;
      if (!current) throw new Error('El editor aún no está listo.');
      if (current.getMarks().some(mark => mark.status === 'pending')) {
        throw new Error('Valida o descarta las regiones pendientes antes de guardar.');
      }
      const initialRevision = revision.current;
      const captures = current.getPhotos();
      if (destination === 'mask' && !captures.length) throw new Error('Agrega al menos una foto antes de guardar.');
      const refs = await ensureSimulationPhotos(record.id, captures, photos.current, signal);
      if (revision.current !== initialRevision) throw new Error('La sesión cambió durante el guardado. Revisa y vuelve a intentar.');
      async function post(kind: Destination, value: object) {
        const payload = JSON.stringify(value);
        if (!requests.current[kind] || requests.current[kind]?.payload !== payload) {
          requests.current[kind] = { payload, id: crypto.randomUUID() };
        }
        const body = JSON.stringify({ ...value, requestId: requests.current[kind]!.id });
        if (new Blob([body]).size > 4_000_000) throw new Error('La sesión supera el límite de envío de 4 MB; no se guardó ni simplificó.');
        return json(await recordsFetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }));
      }
      let simulationId: number | undefined;
      if (captures.length) {
        const state = await current.snapshot(refs);
        if (revision.current !== initialRevision) throw new Error('La sesión cambió durante el guardado. Revisa y vuelve a intentar.');
        const value = { action: 'saveFacialSimulation', record_id: record.id, scope: 'facial-simulation', state };
        const payload = JSON.stringify(value);
        if (savedSnapshot.current?.payload === payload) simulationId = savedSnapshot.current.id;
        else {
          const result = await post('mask', value);
          if (!Number.isInteger(result?.id) || result.id <= 0) throw new Error('No se confirmó el identificador de la máscara guardada.');
          simulationId = result.id;
          savedSnapshot.current = { payload, id: result.id };
        }
      }
      if (revision.current !== initialRevision) throw new Error('La sesión cambió durante el guardado. Revisa y vuelve a intentar.');
      if (destination === 'exam') {
        const review = toPersistedSkinReview(current.getMarks(), refs);
        await post('exam', { action: 'saveSimulationExam', record_id: record.id, reason: reason.trim(),
          exam: { skin_type: skinType, phototype, ...(hydration.trim() ? { hydration: hydration.trim() } : {}),
            ...(glogau ? { glogau_scale: glogau } : {}),
            skin_visual_review: { ...review, ...(simulationId ? { simulationId } : {}) } } });
      }
      if (revision.current !== initialRevision) throw new Error('La sesión cambió durante el guardado. Comprueba el expediente antes de volver a guardar.');
      if (destination === 'exam') delete requests.current.exam;
      if (destination === 'mask') {
        setDirty(false); setNotice('Máscara guardada en el expediente.');
        if (leaveAfterSave.current) { leaveAfterSave.current = false; finishLeave(); }
      } else {
        setDirty(false); setExamDirty(false); setExam(false); setNotice('Se creó una consulta nueva con su examen y se vinculó la máscara disponible.');
        if (leaveAfterSave.current) { leaveAfterSave.current = false; finishLeave(); }
      }
    });
  }
  useEffect(() => {
    if (!record || !pendingSave || patientDialog) return;
    const destination = pendingSave;
    setPendingSave(null);
    if (destination === 'exam') setExam(true);
    else void save(destination);
    // Ejecutar una sola vez cuando se complete la vinculación solicitada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, pendingSave, patientDialog]);
  async function listHistory(append = false) {
    if (!record) return;
    await run('Cargando historial…', async signal => {
      const before = append && cursor ? `&before=${cursor}` : '';
      const data = await json(await recordsFetch(`/api/records?action=listFacialSimulations&record_id=${record.id}&scope=facial-simulation&limit=20${before}`, { signal }));
      if (!Array.isArray(data.simulations)) throw new Error('Respuesta inválida del historial.');
      setHistory(previous => append ? [...previous, ...data.simulations] : data.simulations);
      setCursor(data.nextCursor ?? null);
      if (!data.simulations.length && !append) setNotice('No hay máscaras guardadas en este expediente.');
    });
  }
  async function restore(id: number) {
    if (!record || (dirty && !window.confirm('Abrir esta máscara reemplazará el trabajo actual. ¿Continuar?'))) return;
    await run('Abriendo máscara…', async signal => {
      const data = await json(await recordsFetch(`/api/records?action=getFacialSimulation&record_id=${record.id}&scope=facial-simulation&id=${id}`, { signal }));
      const state = data.state as FacialSimulationState;
      const loaded = await loadSimulationPhotos(record.id, state, signal);
      signal.throwIfAborted();
      const current = controller.current;
      if (!current) throw new Error('El editor aún no está listo.');
      await current.restore(state, loaded.canvases, loaded.originals);
      photos.current.clear(); pending.current.clear();
      for (const entry of state.photos) pending.current.set(entry.slot, { canvas: loaded.canvases[entry.slot], recordId: record.id, reference: entry.photo });
      setDirty(false); requests.current = {}; savedSnapshot.current = null; setNotice('Máscara abierta.');
    });
  }

  if (!allowed) return <AdminLayout title="Simulación facial"><p role="alert">Este módulo no está habilitado para la clínica o el usuario.</p></AdminLayout>;
  return <AdminLayout title="Simulación facial" subtitle="Trabajo temporal o vinculado a un expediente" onBack={() => leavePage()} onLogout={() => leavePage('logout')} moduleNav={false}>
    <div className="space-y-4">
      <div className="admin-surface flex flex-wrap items-center gap-2 p-4">
        <p className="mr-auto text-sm">{patient && record ? `${patient.first_name} ${patient.last_name} · Expediente #${record.id}` : 'Sin paciente · sesión temporal'}</p>
        <button type="button" className={button} disabled={!!busy} onClick={() => setPatientDialog(true)}>{record ? 'Cambiar expediente' : 'Vincular paciente'}</button>
        {record && <button type="button" className={button} disabled={!!busy} onClick={() => setLibrary(true)}>Biblioteca de fotos</button>}
        <button type="button" className={button} disabled={!!busy} onClick={() => void save('mask')}>Guardar máscara</button>
        <button type="button" className={button} disabled={!!busy} onClick={() => record ? setExam(true) : (setPendingSave('exam'), setPatientDialog(true))}>Guardar en examen</button>
      </div>
      {busy && <p role="status">{busy}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
      {!record && <p className="text-sm text-gray-600">Las fotos y cambios permanecen solo en esta sesión hasta que vincules y guardes. La IA, si está habilitada, puede consumir cuota.</p>}
      {record && <section className="admin-surface space-y-2 p-4" aria-label="Historial de máscaras">
        <button type="button" className={button} disabled={!!busy} onClick={() => void listHistory()}>Consultar historial de máscaras</button>
        <ul className="space-y-2">{history.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
          Máscara #{item.id} · {new Date(item.created_at).toLocaleString('es')}
          <button type="button" className={button} disabled={!!busy} onClick={() => void restore(item.id)}>Abrir</button>
        </li>)}</ul>
        {cursor && <button type="button" className={button} disabled={!!busy} onClick={() => void listHistory(true)}>Cargar más</button>}
      </section>}
      <fieldset disabled={!!busy} aria-busy={!!busy} className={busy ? 'pointer-events-none opacity-60' : ''}>
        <FaceSimLab integration={{ mode: 'simulation', recordId: record?.id, context: { skinType, phototype, hydration }, onController, onDirty }} />
      </fieldset>
    </div>
    <SimulationPatientDialog open={patientDialog} onClose={() => { setPatientDialog(false); setPendingSave(null); leaveAfterSave.current = false; }}
      onWithoutPatient={!record ? () => { setPatientDialog(false); setPendingSave(null); leaveAfterSave.current = false; } : undefined} onSelect={selectRecord} />
    <Dialog open={library && !!record} onClose={() => { if (!libraryImporting) setLibrary(false); }} labelledBy="simulation-library-title">
      <div className="w-[min(48rem,calc(100vw-2rem))] space-y-4 rounded-xl bg-white p-5">
        <h2 id="simulation-library-title" className="text-lg font-semibold">Elegir foto</h2>
        <label className="block text-sm">Vista de destino
          <select className={input} value={slot} onChange={e => setSlot(e.target.value as SimulationPhotoSlot)}>
            {SIMULATION_PHOTO_SLOTS.map(value => <option key={value} value={value}>{({ frontal: 'Frontal', izquierda: 'Izquierda', derecha: 'Derecha', extra_a: 'Extra A', extra_b: 'Extra B' })[value]}</option>)}
          </select>
        </label>
        {record && library && <SimulationPhotoLibrary recordId={record.id} onSelect={async (reference, file) => {
          if (!controller.current) throw new Error('El editor aún no está listo.');
          setLibraryImporting(true);
          pending.current.set(slot, { file, recordId: record.id, reference });
          try { await controller.current.importPhoto(file, slot); setLibrary(false); }
          catch (e) { pending.current.delete(slot); throw e; }
          finally { setLibraryImporting(false); }
        }} />}
        <button type="button" className={button} disabled={libraryImporting} onClick={() => setLibrary(false)}>Cerrar</button>
      </div>
    </Dialog>
    <Dialog open={exam} onClose={() => { if (!busy) { setExam(false); leaveAfterSave.current = false; } }} labelledBy="simulation-exam-title">
      <form className="w-[min(32rem,calc(100vw-2rem))] space-y-4 rounded-xl bg-white p-5" onSubmit={e => { e.preventDefault(); void save('exam'); }}>
        <h2 id="simulation-exam-title" className="text-lg font-semibold">Guardar en examen</h2>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <p className="text-sm text-gray-600">Se creará una consulta y un examen nuevos. Si hay fotos, la máscara se guardará y vinculará primero; si falla el examen, esa máscara seguirá guardada.</p>
        {antecedentLoading && <p role="status" className="text-sm">Consultando antecedentes; no se consideran datos actuales.</p>}
        {antecedentError && <p role="alert" className="text-sm text-red-700">{antecedentError}{' '}
          <button type="button" className={button} onClick={() => setAntecedentVersion(value => value + 1)}>Reintentar antecedentes</button></p>}
        {antecedent && <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p>Antecedente del {antecedent.created_at && Number.isFinite(Date.parse(antecedent.created_at))
            ? new Date(antecedent.created_at).toLocaleDateString('es') : 'registro sin fecha confirmada'} · pendiente de confirmar hoy.</p>
          <p>Tipo: {antecedent.skin_type || 'No registrado'} · Fototipo: {antecedent.phototype || 'No registrado'} · Glogau: {antecedent.glogau_scale || 'No registrado'}</p>
          <button type="button" className={button} onClick={() => {
            setSkinType(antecedent.skin_type ?? ''); setPhototype(antecedent.phototype ?? '');
            setGlogau(antecedent.glogau_scale ?? ''); setExamDirty(true);
          }}>Confirmar estos parámetros manualmente hoy</button>
        </div>}
        <label className="block text-sm">Motivo de consulta <textarea className={input} required maxLength={3000} value={reason} onChange={e => { setReason(e.target.value); setExamDirty(true); }} /></label>
        <label className="block text-sm">Tipo de piel <select className={input} required value={skinType} onChange={e => { setSkinType(e.target.value); setExamDirty(true); }}>
          <option value="">Selecciona y confirma</option>{['Sensible', 'Seca', 'Normal', 'Grasa', 'Mixta', 'No determinado'].map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label className="block text-sm">Fototipo <select className={input} required value={phototype} onChange={e => { setPhototype(e.target.value); setExamDirty(true); }}>
          <option value="">Selecciona y confirma</option>{['I', 'II', 'III', 'IV', 'V', 'VI', 'No determinado'].map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label className="block text-sm">Hidratación (recomendada) <input className={input} value={hydration} maxLength={300} onChange={e => { setHydration(e.target.value); setExamDirty(true); }} /></label>
        <label className="block text-sm">Glogau (según pertinencia) <select className={input} value={glogau} onChange={e => { setGlogau(e.target.value); setExamDirty(true); }}>
          <option value="">Sin evaluar</option>{['I', 'II', 'III', 'IV'].map(value => <option key={value}>{value}</option>)}
        </select></label>
        <div className="flex gap-2"><button type="submit" className={button} disabled={!!busy}>Guardar examen</button><button type="button" className={button} disabled={!!busy} onClick={() => { setExam(false); leaveAfterSave.current = false; }}>Cancelar</button></div>
      </form>
    </Dialog>
    <Dialog open={leave} onClose={continueWorking} labelledBy="simulation-leave-title">
      <div className="w-[min(30rem,calc(100vw-2rem))] space-y-4 rounded-xl bg-white p-5">
        <h2 id="simulation-leave-title" className="text-lg font-semibold">Cambios sin guardar</h2>
        <p className="text-sm text-gray-600">Descartar elimina el trabajo temporal de esta sesión, pero no devuelve cuotas de proveedores.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => { const destination = examDirty ? 'exam' : 'mask'; leaveAfterSave.current = true; setLeave(false); if (record) void save(destination); else { setPendingSave(destination); setPatientDialog(true); } }}>Vincular y guardar</button>
          <button type="button" className={button} onClick={continueWorking}>Seguir trabajando</button>
          <button type="button" className={button} onClick={() => { controller.current?.reset(); finishLeave(); }}>Descartar y salir</button>
        </div>
      </div>
    </Dialog>
  </AdminLayout>;
}
