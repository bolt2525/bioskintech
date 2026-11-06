import { useEffect, useRef, useState } from 'react';
import recordsFetch from '../../../../utils/recordsFetch';
import { Dialog } from '../../../ui/Dialog';
import NewPatientForm from './NewPatientForm';

export interface SimulationPatient {
  id: number;
  first_name: string;
  last_name: string;
  identification_number?: string;
}

export interface SimulationRecord {
  id: number;
  created_at: string;
  status: string;
  created_by_full_name?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onWithoutPatient?: () => void;
  onSelect: (patient: SimulationPatient, record: SimulationRecord) => void;
}

const button = 'admin-focus-ring min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50';

async function readJSON(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'No se pudo completar la operación.');
  return data;
}

function PatientSearch({ onSelect }: { onSelect: (patient: SimulationPatient) => void }) {
  const [patients, setPatients] = useState<SimulationPatient[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setLoading(true); setError('');
    recordsFetch('/api/records?action=listPatients', { signal: request.signal })
      .then(readJSON).then(data => {
        if (!Array.isArray(data)) throw new Error('Respuesta inválida de pacientes.');
        if (!request.signal.aborted) setPatients(data);
      }).catch(e => { if (!request.signal.aborted) setError(e instanceof Error ? e.message : 'Error al cargar pacientes.'); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [attempt]);
  const query = search.trim().toLocaleLowerCase('es');
  const filtered = patients.filter(p => `${p.first_name} ${p.last_name} ${p.identification_number || ''}`.toLocaleLowerCase('es').includes(query));
  return <div className="space-y-3">
    <label htmlFor="simulation-patient-search" className="block text-sm font-medium">Nombre o identificación</label>
    <input id="simulation-patient-search" autoFocus value={search} onChange={e => setSearch(e.target.value)}
      className="admin-focus-ring w-full rounded-lg border border-gray-300 p-3" />
    {loading && <p role="status">Cargando pacientes…</p>}
    {error && <div role="alert" className="text-sm text-red-700">{error} <button type="button" className={button} onClick={() => setAttempt(n => n + 1)}>Reintentar</button></div>}
    {!loading && !error && !filtered.length && <p className="text-sm text-gray-600">No se encontraron pacientes.</p>}
    <ul className="max-h-64 space-y-2 overflow-y-auto">
      {filtered.map(patient => <li key={patient.id}>
        <button type="button" className={`${button} w-full text-left`} onClick={() => onSelect(patient)}>
          {patient.first_name} {patient.last_name}{patient.identification_number ? ` · ${patient.identification_number}` : ''}
        </button>
      </li>)}
    </ul>
  </div>;
}

function RecordSelection({ patient, onSelect, onCreating }: { patient: SimulationPatient; onSelect: (record: SimulationRecord) => void; onCreating: (value: boolean) => void }) {
  const [records, setRecords] = useState<SimulationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const createLock = useRef(false);
  useEffect(() => {
    const request = new AbortController();
    setLoading(true); setError('');
    recordsFetch(`/api/records?action=listRecords&patient_id=${patient.id}`, { signal: request.signal })
      .then(readJSON).then(data => {
        if (!Array.isArray(data)) throw new Error('Respuesta inválida de expedientes.');
        if (!request.signal.aborted) setRecords(data);
      }).catch(e => { if (!request.signal.aborted) setError(e instanceof Error ? e.message : 'Error al cargar expedientes.'); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [patient.id, attempt]);
  async function create() {
    if (createLock.current || !window.confirm('¿Crear un expediente nuevo para este paciente?')) return;
    createLock.current = true; onCreating(true); setCreating(true); setError('');
    try {
      const record = await readJSON(await recordsFetch('/api/records?action=createRecord', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patient.id }),
      }));
      if (!Number.isInteger(record?.id) || record.id <= 0) throw new Error('El expediente creado no tiene un identificador válido.');
      onSelect(record);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo crear el expediente.'); }
    finally { createLock.current = false; onCreating(false); setCreating(false); }
  }
  return <div className="space-y-3">
    <p className="font-medium">Expedientes de {patient.first_name} {patient.last_name}</p>
    {loading && <p role="status">Cargando expedientes…</p>}
    {error && <div role="alert" className="text-sm text-red-700">{error} <button type="button" className={button} onClick={() => setAttempt(n => n + 1)}>Reintentar</button></div>}
    {!loading && !error && !records.length && <p className="text-sm text-gray-600">Este paciente no tiene expedientes.</p>}
    <ul className="max-h-64 space-y-2 overflow-y-auto">
      {records.map(record => <li key={record.id}>
        <button type="button" className={`${button} w-full text-left`} disabled={creating} onClick={() => onSelect(record)}>
          Expediente #{record.id} · {record.status === 'active' ? 'Activo' : record.status}
          {record.created_by_full_name ? ` · ${record.created_by_full_name}` : ''}
        </button>
      </li>)}
    </ul>
    <button type="button" className={button} disabled={loading || creating} onClick={() => void create()}>
      {creating ? 'Creando expediente…' : 'Crear expediente'}
    </button>
  </div>;
}

export function SimulationPatientDialog({ open, onClose, onWithoutPatient, onSelect }: Props) {
  const [step, setStep] = useState<'choose' | 'search' | 'create' | 'record'>('choose');
  const [patient, setPatient] = useState<SimulationPatient | null>(null);
  const [error, setError] = useState('');
  const [loadingPatient, setLoadingPatient] = useState(false);
  const [creatingRecord, setCreatingRecord] = useState(false);

  useEffect(() => {
    if (open) { setStep('choose'); setPatient(null); setError(''); }
  }, [open]);
  async function created(id: number) {
    setLoadingPatient(true); setError('');
    try {
      const value = await readJSON(await recordsFetch(`/api/records?action=getPatient&id=${id}`));
      if (value?.id !== id) throw new Error('No se pudo recuperar el paciente creado.');
      setPatient(value); setStep('record');
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo recuperar el paciente.'); setStep('search'); }
    finally { setLoadingPatient(false); }
  }
  const close = () => { if (step !== 'create' && !loadingPatient && !creatingRecord) onClose(); };
  return <Dialog open={open} onClose={close} labelledBy="simulation-patient-title">
    <div className="w-[min(48rem,calc(100vw-2rem))] space-y-4 rounded-xl bg-white p-5 shadow-xl sm:p-6">
      <h2 id="simulation-patient-title" className="text-xl font-semibold text-gray-900">Paciente y expediente</h2>
      <p className="text-sm text-gray-600">Vincula un expediente para guardar. También puedes trabajar temporalmente sin paciente.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {loadingPatient && <p role="status">Cargando paciente…</p>}
      {step === 'choose' && <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => setStep('search')}>Buscar paciente</button>
        <button type="button" className={button} onClick={() => setStep('create')}>Crear paciente</button>
        {onWithoutPatient && <button type="button" className={button} onClick={onWithoutPatient}>Continuar sin paciente</button>}
      </div>}
      {step === 'search' && <PatientSearch onSelect={value => { setPatient(value); setStep('record'); }} />}
      {step === 'create' && !loadingPatient && <NewPatientForm onCreated={id => void created(id)} onCancel={() => setStep('choose')} />}
      {step === 'record' && patient && <RecordSelection key={patient.id} patient={patient} onCreating={setCreatingRecord} onSelect={record => onSelect(patient, record)} />}
      {step !== 'create' && <div className="flex gap-2">
        {step !== 'choose' && <button type="button" className={button} disabled={creatingRecord || loadingPatient} onClick={() => setStep('choose')}>Atrás</button>}
        <button type="button" className={button} disabled={creatingRecord || loadingPatient} onClick={close}>Cerrar</button>
      </div>}
    </div>
  </Dialog>;
}
