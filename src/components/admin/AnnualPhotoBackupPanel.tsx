import { useCallback, useEffect, useId, useState } from 'react';
import { Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AnnualPhotoBackupRequest, AnnualPhotoBackupStatus } from '../../types';
import recordsFetch from '../../utils/recordsFetch';
import { useAuth } from '../../hooks/useAuth';
import { Dialog } from '../ui/Dialog';

const STATE_LABELS: Record<AnnualPhotoBackupRequest['status'], string> = {
  PENDING: 'Pendiente de autorización', APPROVED: 'Autorizado', PROCESSING: 'Preparando archivos',
  READY: 'Disponible para descargar', EXPIRED: 'Descarga vencida', REJECTED: 'Rechazado',
  CANCELLED: 'Cancelado', FAILED: 'Requiere revisión',
};
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-dark disabled:opacity-50';
const REASON_LABELS: Record<string, string> = {
  feature_disabled: 'El respaldo fotográfico anual está deshabilitado. Contacte a soporte.',
  migration_needed: 'El respaldo fotográfico anual requiere una actualización del servidor. Contacte a soporte.',
};

async function requestApi<T>(action: string, body?: object): Promise<T> {
  const response = await recordsFetch(`/api/backup?action=${action}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `No se pudo completar la operación (${response.status})`);
  return result;
}

export default function AnnualPhotoBackupPanel({ master = false, clinics = [] }: {
  master?: boolean;
  clinics?: { id: string | number; name: string }[];
}) {
  const { user } = useAuth();
  const canManage = master ? user?.role === 'master_admin'
    : user?.role === 'clinic_admin' || user?.role === 'master_admin';
  const decisionTitleId = useId();
  const [data, setData] = useState<AnnualPhotoBackupStatus | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [configurationReason, setConfigurationReason] = useState<string | null>(null);
  const [requests, setRequests] = useState<AnnualPhotoBackupRequest[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clinicId, setClinicId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [decision, setDecision] = useState<{ id: string; approve: boolean } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      if (master) {
        const result = await requestApi<{ requests: AnnualPhotoBackupRequest[]; configured: boolean; reason?: string | null }>('listPhotoBackupRequests');
        setRequests(result.requests);
        setConfigured(typeof result.configured === 'boolean' ? result.configured : null);
        setConfigurationReason(result.reason || null);
      } else {
        const result = await requestApi<AnnualPhotoBackupStatus>('photoBackupStatus');
        setData(result);
        setRequests(result.requests);
        setConfigured(result.configured === true);
        setConfigurationReason(result.reason);
      }
      setError('');
    } catch (failure) {
      setConfigured(null);
      setError(failure instanceof Error ? failure.message : 'No se pudo consultar el respaldo anual');
    } finally {
      setLoading(false);
    }
  }, [canManage, master]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!canManage || !requests.some(item => ['APPROVED', 'PROCESSING'].includes(item.status))) return;
    const interval = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(interval);
  }, [canManage, load, requests]);

  const perform = async (action: string, body: object, message: string) => {
    if (!canManage) return;
    if (['setPhotoBackupPeriod', 'approvePhotoBackup', 'requestPhotoBackup'].includes(action) &&
        (configured !== true || loading || (!master && !data?.eligible))) {
      setError('La operación está bloqueada hasta verificar que el respaldo anual esté habilitado y disponible.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await requestApi(action, body);
      setNotice(message);
      setDecision(null);
      setReason('');
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo completar la operación');
    } finally {
      setBusy(false);
    }
  };

  const download = async (requestId: string, index: number) => {
    if (!canManage) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestApi<{ url: string; filename: string }>('photoBackupDownload', { requestId, index });
      const anchor = document.createElement('a');
      anchor.href = result.url;
      anchor.download = result.filename;
      anchor.rel = 'noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setNotice('Enlace emitido. Descargue todas las partes y conserve los archivos en un lugar seguro.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo emitir la descarga');
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) return null;

  return <section className="rounded-2xl border border-gray-200 bg-white p-5 text-gray-800 shadow-sm">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5 text-gold-dark" aria-hidden="true" />Respaldo fotográfico anual</h2>
      <button type="button" disabled={busy || loading} onClick={() => void load()} className={buttonClass}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar</button>
    </header>
    <p className="mt-3 text-sm leading-relaxed text-gray-600">Una entrega gratuita por clínica y período de 12 meses registrado, bajo solicitud y autorización del Master Admin. Incluye fotografías originales, datos clínicos y copias legibles de historias y consentimientos registrados. Se entrega en ZIP independientes; descargue todas las partes durante las 24 horas de disponibilidad. No sustituye el respaldo automático de datos ni una copia periódica de fotografías.</p>
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
    {!loading && configured !== true && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{configured === false ? 'El procesamiento está deshabilitado o no configurado. El registro de períodos, las solicitudes y las aprobaciones están bloqueados.' : 'No se pudo verificar la configuración. Actualice el estado antes de registrar períodos, solicitar o aprobar entregas.'}</p>}
    {configurationReason && <p className="mt-3 text-sm text-gray-600">{REASON_LABELS[configurationReason] || configurationReason}</p>}
    {loading ? <p className="mt-4 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Consultando solicitudes…</p> : <>
      {!master && <div className="mt-4 space-y-3">
        <p className="text-sm">{data?.period ? `Período registrado: ${data.period.start_date.slice(0, 10)} a ${data.period.end_date.slice(0, 10)}` : 'El Master Admin debe registrar el período contractual antes de solicitar la entrega.'}</p>
        <button type="button" disabled={busy || configured !== true || !data?.eligible} onClick={() => setDecision({ id: '', approve: true })} className={buttonClass}>Solicitar Respaldo Anual</button>
      </div>}
      {master && <form className="mt-5 grid gap-3 rounded-xl bg-gray-50 p-4 sm:grid-cols-3" onSubmit={event => {
        event.preventDefault();
        void perform('setPhotoBackupPeriod', { clinicId, startDate, endDate }, 'Período registrado. La cuota se controla por clínica, no por usuario.');
      }}>
        <fieldset disabled={busy || configured !== true} className="contents">
        <p className="text-sm text-gray-600 sm:col-span-3">Registre las fechas del período anual aceptado. No se generan automáticamente desde una fecha de suscripción editable.</p>
        <label className="text-sm">Clínica<select required value={clinicId} onChange={event => setClinicId(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="">Seleccione</option>{clinics.map(clinic => <option key={clinic.id} value={String(clinic.id)}>{clinic.name}</option>)}</select></label>
        <label className="text-sm">Inicio<input required type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" /></label>
        <label className="text-sm">Fin exclusivo (12 meses)<input required type="date" min={startDate || undefined} value={endDate} onChange={event => setEndDate(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" /></label>
        <button disabled={busy || configured !== true} className={buttonClass}>Registrar período</button>
        </fieldset>
      </form>}
      {decision && <Dialog open onClose={() => { if (!busy) setDecision(null); }} labelledBy={decisionTitleId} className="w-full sm:w-[32rem]">
        <div className="rounded-xl bg-white p-5">
        <h3 id={decisionTitleId} className="mb-3 text-lg font-semibold">{!master ? 'Solicitar respaldo anual' : decision.approve ? 'Autorizar respaldo anual' : 'Rechazar solicitud'}</h3>
        <p className="text-sm">{!master ? 'Confirme que solicita una copia de los datos de su clínica y que custodiará los archivos sensibles. La cuota se consume únicamente al completarse la entrega.' : decision.approve ? 'La autorización inicia el procesamiento de datos sensibles. Verifique la clínica y el período.' : 'Indique el motivo de rechazo; no se consumirá la cuota.'}</p>
        {master && !decision.approve && <label className="mt-3 block text-sm">Motivo<textarea maxLength={500} value={reason} onChange={event => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 p-2" /></label>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy || loading || (decision.approve && configured !== true) || (!master && !data?.eligible) || (master && !decision.approve && !reason.trim())} className={buttonClass} onClick={() => void perform(
            !master ? 'requestPhotoBackup' : decision.approve ? 'approvePhotoBackup' : 'rejectPhotoBackup',
            !master ? {} : { requestId: decision.id, ...(decision.approve ? {} : { reason: reason.trim() }) },
            !master ? 'Solicitud registrada. El Master Admin recibirá la notificación.' : decision.approve ? 'Autorización registrada; consulte el progreso.' : 'Solicitud rechazada.',
          )}>Confirmar</button>
          <button type="button" disabled={busy} onClick={() => setDecision(null)} className={buttonClass}>Cancelar</button>
        </div>
        </div>
      </Dialog>}
      <div className="mt-5 space-y-3">
        {!error && !requests.length && <p className="text-sm text-gray-500">No hay solicitudes registradas.</p>}
        {requests.map(item => <article key={item.id} className="rounded-xl border border-gray-200 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="font-semibold">{master ? item.clinic_name || item.clinic_id : 'Solicitud anual'}</h3><p className="text-xs text-gray-500">{item.id} · {new Date(item.created_at).toLocaleString('es-EC')}</p></div>
            <p className="text-sm font-medium">{STATE_LABELS[item.status]}</p>
          </div>
          <p className="mt-2 text-sm text-gray-600">{item.photo_count ?? 0} fotografías · {((item.total_bytes ?? 0) / 1048576).toFixed(1)} MiB</p>
          {item.error_code && <p className="mt-2 text-sm text-red-700">Preparación no completada: {item.error_code}. Solicite revisión; no se presenta una entrega parcial como completa.</p>}
          {item.notification_error && <p className="mt-2 text-sm text-amber-800">El aviso por correo requiere revisión. Consulte el estado aquí.</p>}
          {item.expires_at && <p className="mt-2 text-sm">Disponible hasta {new Date(item.expires_at).toLocaleString('es-EC')}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {master && ['PENDING', 'APPROVED', 'FAILED'].includes(item.status) && <button type="button" disabled={busy || configured !== true} onClick={() => setDecision({ id: item.id, approve: true })} className={buttonClass}>{item.status === 'PENDING' ? 'Aprobar' : 'Reintentar preparación'}</button>}
            {master && item.status === 'PENDING' && <button type="button" disabled={busy} onClick={() => setDecision({ id: item.id, approve: false })} className={buttonClass}>Rechazar</button>}
            {item.status === 'READY' && item.parts?.map(part => <button type="button" key={part.index} disabled={busy} onClick={() => void download(item.id, part.index)} className={buttonClass}><Download className="h-4 w-4" aria-hidden="true" />Descargar parte {part.index + 1}</button>)}
          </div>
        </article>)}
      </div>
    </>}
  </section>;
}
