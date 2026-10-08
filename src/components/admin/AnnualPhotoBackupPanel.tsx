import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AnnualPhotoBackupNotification, AnnualPhotoBackupProviderStatus, AnnualPhotoBackupQuote, AnnualPhotoBackupRequest, AnnualPhotoBackupStatus } from '../../types';
import recordsFetch from '../../utils/recordsFetch';
import { useAuth } from '../../hooks/useAuth';
import { Dialog } from '../ui/Dialog';
import { subscriptionAccess } from '../../utils/subscriptionAccess';
import { annualCanApprove, annualCanRequest, annualMoney, annualOriginalSize, ANNUAL_STATUS_LABELS } from '../../utils/annualPhotoBackup';
import { subscriptionDate } from '../../utils/subscriptionAccess';
import AnnualPhotoBackupOrder, { type AnnualOrderCommand } from './AnnualPhotoBackupOrder';

const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-dark disabled:opacity-50';

async function requestApi<T>(action: string, body?: object, targetClinic?: string): Promise<T> {
  const response = await recordsFetch(`/api/backup?action=${action}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(targetClinic ? { 'X-Target-Clinic-Id': targetClinic } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `No se pudo completar la operación (${response.status})`);
  return result;
}

export default function AnnualPhotoBackupPanel({ master = false, clinics = [], deliveryOnly = false, onProviderStatus }: {
  master?: boolean;
  clinics?: { id: string | number; name: string }[];
  deliveryOnly?: boolean;
  onProviderStatus?: (status: AnnualPhotoBackupProviderStatus) => void;
}) {
  const { user } = useAuth();
  const access = subscriptionAccess(user);
  const onlyDelivery = deliveryOnly || access.deliveryOnly;
  const canRequest = !onlyDelivery && access.canRequestAnnual;
  const canManage = master ? user?.role === 'master_admin'
    : access.canAnnualDelivery;
  const decisionTitleId = useId();
  const [data, setData] = useState<AnnualPhotoBackupStatus | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [processorReady, setProcessorReady] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<AnnualPhotoBackupNotification[]>([]);
  const [requests, setRequests] = useState<AnnualPhotoBackupRequest[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const [loading, setLoading] = useState(true);
  const [clinicId, setClinicId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [decision, setDecision] = useState<{ id: string; approve: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [periodSuggestion, setPeriodSuggestion] = useState<AnnualPhotoBackupStatus['period_suggestion']>(null);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [periodError, setPeriodError] = useState('');

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      if (master) {
        const result = await requestApi<AnnualPhotoBackupProviderStatus>('listPhotoBackupRequests');
        setRequests(result.requests.map(item => ({
          ...item,
          notification_error: item.notification_error || (result.notifications?.some(notification =>
            notification.request_id === item.id && notification.status === 'FAILED') ? 'SMTP_FAILED' : null),
        })));
        setProcessorReady(result.processor_ready === true);
        setPendingCount(typeof result.pending_count === 'number' ? result.pending_count : null);
        setNotifications(result.notifications || []);
        onProviderStatus?.(result);
        setConfigured(typeof result.configured === 'boolean' ? result.configured : null);
      } else {
        const result = await requestApi<AnnualPhotoBackupStatus>('photoBackupStatus');
        setData(result);
        setRequests(result.requests);
        setConfigured(result.configured === true);
        setProcessorReady(result.processor_ready === true);
      }
      setError('');
    } catch (failure) {
      setConfigured(null);
      setProcessorReady(false);
      setPendingCount(null);
      setError(failure instanceof Error ? failure.message : 'No se pudo consultar el respaldo anual');
    } finally {
      setLoading(false);
    }
  }, [canManage, master, onProviderStatus]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!master || !canManage || !clinicId || configured !== true) return;
    let cancelled = false;
    setPeriodLoading(true); setPeriodError(''); setPeriodSuggestion(null);
    void requestApi<AnnualPhotoBackupStatus>('photoBackupStatus', undefined, clinicId)
      .then(result => { if (!cancelled) setPeriodSuggestion(result.period_suggestion || null); })
      .catch(failure => { if (!cancelled) setPeriodError(failure instanceof Error ? failure.message : 'No se pudo consultar la vigencia'); })
      .finally(() => { if (!cancelled) setPeriodLoading(false); });
    return () => { cancelled = true; };
  }, [master, canManage, clinicId, configured]);
  useEffect(() => {
    if (!canManage || !requests.some(item => ['APPROVED', 'PROCESSING'].includes(item.status))) return;
    const interval = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(interval);
  }, [canManage, load, requests]);

  const perform = async (action: string, body: object, message: string) => {
    if (!canManage || busy || actionPending.current) return;
    if (onlyDelivery || (action === 'requestPhotoBackup' && !canRequest)) {
      setError('Esta sesión solo permite consultar el estado y descargar la entrega anual.');
      return;
    }
    if (['setPhotoBackupPeriod', 'approvePhotoBackup', 'requestPhotoBackup'].includes(action) &&
        (configured !== true || loading || (!master && !annualCanRequest(data)) ||
          (action === 'approvePhotoBackup' && !processorReady))) {
      setError('Esta acción no está disponible. Actualiza el estado o contacta a soporte.');
      return;
    }
    if (action === 'approvePhotoBackup') {
      const requestId = 'requestId' in body ? body.requestId : null;
      const item = requests.find(request => request.id === requestId);
      if (!item || !annualCanApprove(item, processorReady)) {
        setError('La aprobación requiere elegibilidad y pago confirmado cuando corresponde. Actualiza el estado.');
        return;
      }
    }
    actionPending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await requestApi<{ entitlement_kind?: 'FREE' | 'PAID'; payment_status?: string }>(action, body);
      setNotice(action === 'requestPhotoBackup'
        ? result.entitlement_kind === 'PAID'
          ? 'Solicitud adicional registrada. Cotización y pago pendientes; no se realizó ningún cobro automático.'
          : 'Solicitud registrada. Consulta aquí el estado de tu entrega.'
        : message);
      setDecision(null);
      setReason('');
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo completar la operación');
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };

  const executeOrder = async (command: AnnualOrderCommand): Promise<AnnualPhotoBackupQuote | undefined> => {
    if (!master || !canManage || onlyDelivery || busy || actionPending.current || loading || configured !== true)
      throw new Error('La operación requiere proveedor autenticado y registro disponible.');
    actionPending.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await requestApi<AnnualPhotoBackupQuote>(command.action, command.body);
      setNotice(command.action === 'quotePhotoBackup'
        ? result.quote_complete ? 'Cotización calculada.' : 'Medición parcial guardada. Continúa la cotización.'
        : command.action === 'retryPhotoBackupNotifications' ? 'Reenvío solicitado.'
          : command.action === 'acceptPhotoBackupQuote' ? 'Aceptación registrada. Pago pendiente.'
            : 'Pago registrado. Pendiente de autorización.');
      await load();
      return command.action === 'quotePhotoBackup' ? result : undefined;
    } finally { actionPending.current = false; setBusy(false); }
  };

  const download = async (requestId: string, index: number) => {
    if (!canManage || actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await requestApi<{ url: string; filename: string }>('photoBackupDownload', {
        requestId, index, ...(master ? { clinicId: requests.find(item => item.id === requestId)?.clinic_id } : {}),
      });
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
      actionPending.current = false;
      setBusy(false);
    }
  };

  if (!canManage) return null;

  return <section className="rounded-2xl border border-gray-200 bg-white p-5 text-gray-800 shadow-sm">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5 text-gold-dark" aria-hidden="true" />Respaldo fotográfico anual</h2>
      <button type="button" disabled={busy || loading} onClick={() => void load()} className={buttonClass}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar</button>
    </header>
    <p className="mt-3 text-sm text-gray-600">Descarga tus fotografías originales, historias clínicas y consentimientos. Una entrega gratuita por año; las adicionales se cotizan.</p>
    <details className="mt-2 text-xs text-gray-600">
      <summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold-dark">Formato y plazo de descarga</summary>
      <p className="mt-2">Descarga todas las partes ZIP dentro de las 24 horas de disponibilidad y guárdalas en un lugar seguro.</p>
    </details>
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
    {!loading && configured !== true && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{configured === false ? 'Contacta a soporte para solicitar tu respaldo anual.' : 'No se pudo consultar el estado. Actualiza para reintentar.'}</p>}
    {master && pendingCount !== null && <p role="status" className="mt-3 text-sm font-medium">{pendingCount} solicitudes pendientes de gestión del proveedor.</p>}
    {loading && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Consultando solicitudes…</p>}
    {(!loading || requests.length > 0) && <>
      {!master && <div className="mt-4 space-y-3">
        {configured === true && (data?.period || data?.period_suggestion) && <p className="text-sm">Vigencia hasta {subscriptionDate(data.period?.end_date || data?.period_suggestion?.ends_at)}</p>}
        {configured === true && !data?.period && !data?.can_request && !onlyDelivery && <p className="text-sm">Contacta a soporte para revisar la vigencia de tu suscripción.</p>}
        {data?.period?.request_deadline_at && <p className="text-sm">Plazo para solicitar: {subscriptionDate(data.period.request_deadline_at)} (Ecuador).</p>}
        {data?.additional_requires_payment && !onlyDelivery && <p className="text-sm text-amber-950">La entrega gratuita ya fue solicitada. Una entrega adicional requiere cotización y pago.</p>}
        {!onlyDelivery && <button type="button" disabled={busy || !annualCanRequest(data) || !canRequest} onClick={() => setDecision({ id: '', approve: true })} className={buttonClass}>Solicitar Respaldo Anual</button>}
      </div>}
      {master && <form className="mt-5 grid gap-3 rounded-xl bg-gray-50 p-4 sm:grid-cols-3" onSubmit={event => {
        event.preventDefault();
        void perform('setPhotoBackupPeriod', { clinicId, startDate, endDate }, 'Período registrado.');
      }}>
        <fieldset disabled={busy || configured !== true} className="contents">
        <p className="text-sm text-gray-600 sm:col-span-3">Vigencia del respaldo anual.</p>
        <label className="text-sm min-w-0">Clínica<select required value={clinicId} onChange={event => { setClinicId(event.target.value); setStartDate(''); setEndDate(''); setPeriodSuggestion(null); setPeriodError(''); }} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="">Seleccione</option>{clinics.map(clinic => <option key={clinic.id} value={String(clinic.id)}>{clinic.name}</option>)}</select></label>
        {clinicId && <div className="text-sm sm:col-span-3">
          {periodLoading ? <p role="status">Consultando vigencia…</p> : periodError ? <p role="alert" className="text-red-700">{periodError}</p> : periodSuggestion ? <>
            <p>Vigencia sugerida: {new Date(periodSuggestion.starts_at).toLocaleDateString('es-EC', { timeZone: 'UTC' })} a {new Date(periodSuggestion.ends_at).toLocaleDateString('es-EC', { timeZone: 'UTC' })} (fechas UTC).</p>
            <button type="button" className={`${buttonClass} mt-2`} onClick={() => {
              setStartDate(periodSuggestion.starts_at.slice(0, 10)); setEndDate(periodSuggestion.ends_at.slice(0, 10));
            }}>Usar fechas sugeridas</button>
          </> : <p>Revisa la fecha de vencimiento de la suscripción.</p>}
        </div>}
        <label className="text-sm">Inicio<input required type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" /></label>
        <label className="text-sm">Fin (12 meses)<input required type="date" min={startDate || undefined} value={endDate} onChange={event => setEndDate(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" /></label>
        <button disabled={busy || configured !== true} className={buttonClass}>Registrar período</button>
        </fieldset>
      </form>}
      {decision && <Dialog open onClose={() => { if (!busy) setDecision(null); }} labelledBy={decisionTitleId} className="w-full sm:w-[32rem]">
        <div className="rounded-xl bg-white p-5">
        <h3 id={decisionTitleId} className="mb-3 text-lg font-semibold">{!master ? 'Solicitar respaldo anual' : decision.approve ? 'Autorizar respaldo anual' : 'Rechazar solicitud'}</h3>
        <p className="text-sm">{!master ? 'El proveedor revisará tu solicitud. Te avisaremos cuando el respaldo esté disponible.' : decision.approve ? 'Verifica la clínica, la vigencia y el pago antes de autorizar.' : 'Indica el motivo de rechazo.'}</p>
        {!master && data?.additional_requires_payment && <p className="mt-2 text-sm font-semibold">Esta solicitud adicional requiere cotización y pago. Confirmar no autoriza un cargo.</p>}
        {master && !decision.approve && <label className="mt-3 block text-sm">Motivo<textarea maxLength={500} value={reason} onChange={event => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 p-2" /></label>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy || loading || (decision.approve && configured !== true) || (!master && !annualCanRequest(data)) || (master && decision.approve && !processorReady) || (master && !decision.approve && !reason.trim())} className={buttonClass} onClick={() => void perform(
            !master ? 'requestPhotoBackup' : decision.approve ? 'approvePhotoBackup' : 'rejectPhotoBackup',
            !master ? {} : { requestId: decision.id, clinicId: requests.find(item => item.id === decision.id)?.clinic_id, ...(decision.approve ? {} : { reason: reason.trim() }) },
            !master ? 'Solicitud registrada. El proveedor del sistema recibirá la notificación.' : decision.approve ? 'Autorización registrada; consulte el progreso.' : 'Solicitud rechazada.',
          )}>Confirmar</button>
          <button type="button" disabled={busy} onClick={() => setDecision(null)} className={buttonClass}>Cancelar</button>
        </div>
        </div>
      </Dialog>}
      <div className="mt-5 space-y-3">
        {!error && !requests.length && <p className="text-sm text-gray-500">No hay solicitudes registradas.</p>}
        {requests.map(item => <article key={item.id} className="rounded-xl border border-gray-200 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="font-semibold">{master ? item.clinic_name || item.clinic_id : 'Solicitud anual'}</h3><p className="text-xs text-gray-500">{new Date(item.created_at).toLocaleString('es-EC')}</p></div>
            <p className="text-sm font-medium">{ANNUAL_STATUS_LABELS[item.status] || 'Estado pendiente de verificación'}</p>
          </div>
          {item.photo_count != null && <p className="mt-2 text-sm text-gray-600">{item.photo_count} fotografías{item.total_bytes != null ? ` · ${(item.total_bytes / 1048576).toFixed(1)} MiB` : ''}</p>}
          {item.entitlement_kind && <p className="mt-2 text-sm">{item.entitlement_kind === 'FREE' ? 'Entrega gratuita del período' : 'Entrega adicional de pago'}{item.payment_status === 'PAID' ? ' · Pago confirmado por el proveedor' : item.entitlement_kind === 'PAID' ? ' · Sin pago confirmado' : ''}</p>}
          {item.entitlement_kind === 'PAID' && <p className="mt-2 text-sm">{annualOriginalSize(item.original_total_bytes)} · {annualMoney(item.quote_total_cents)}{item.quote_total_cents ? ' · USD, IVA incluido' : ''}. {item.quote_accepted_at ? 'Aceptación registrada.' : 'Sin aceptación registrada.'}</p>}
          {item.entitlement_deadline_at && <p className="mt-2 text-xs">Plazo contractual: {subscriptionDate(item.entitlement_deadline_at)} (Ecuador).</p>}
          {item.error_code && <p role="alert" className="mt-2 text-sm text-red-700">No se pudo preparar el respaldo. Contacta a soporte.</p>}
          {item.notification_error && <p role="status" className="mt-2 text-sm text-amber-800">No se pudo enviar el aviso por correo. Tu solicitud sigue registrada. {master ? 'Reintenta el envío.' : 'Consulta su estado aquí.'}</p>}
          {master && notifications.some(notification => notification.request_id === item.id) && <ul aria-label="Estado persistente de avisos por correo" className="mt-2 space-y-1 text-xs text-slate-700">
            {notifications.filter(notification => notification.request_id === item.id).map(notification => <li key={`${notification.request_id}-${notification.kind}`}>
              {notification.kind === 'REQUESTED' ? 'Aviso de solicitud' : notification.kind === 'READY' ? 'Aviso de entrega' : 'Aviso del respaldo'}: {notification.status === 'FAILED' ? 'Envío fallido' : notification.status === 'SENT' ? 'Enviado' : notification.status === 'SENDING' ? 'Enviando' : 'Pendiente'} · {notification.attempts} intentos
            </li>)}
          </ul>}
          {item.expires_at && <p className="mt-2 text-sm">Disponible hasta {subscriptionDate(item.expires_at)} (Ecuador)</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {master && ['PENDING', 'APPROVED', 'FAILED'].includes(item.status) && <button type="button" disabled={busy || configured !== true || !annualCanApprove(item, processorReady)} onClick={() => setDecision({ id: item.id, approve: true })} className={buttonClass}>{item.status === 'PENDING' ? 'Aprobar' : 'Reintentar preparación'}</button>}
            {master && item.status === 'PENDING' && <button type="button" disabled={busy} onClick={() => setDecision({ id: item.id, approve: false })} className={buttonClass}>Rechazar</button>}
            {item.status === 'READY' && item.parts?.map(part => <button type="button" key={part.index} disabled={busy} onClick={() => void download(item.id, part.index)} className={buttonClass}><Download className="h-4 w-4" aria-hidden="true" />Descargar parte {part.index + 1}</button>)}
          </div>
          {master && <AnnualPhotoBackupOrder item={item} busy={busy || loading || configured !== true} execute={executeOrder} />}
        </article>)}
      </div>
    </>}
  </section>;
}
