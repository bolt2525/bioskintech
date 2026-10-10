import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Treatment, TreatmentMode } from '../../types/treatment';
import {
  type TreatmentFollowUp, getTreatmentFollowUp, getFollowUpLabel, getFollowUpSessions,
  treatmentDate, formatTreatmentDate, describeTreatmentAssessment, compareTreatmentAssessments,
} from '../../types/treatmentFollowUp';

interface Props {
  mode: TreatmentMode;
  current: Treatment;
  history: Treatment[];
  onChange: (followUp: TreatmentFollowUp) => void;
}

export default function TreatmentFollowUpPanel({ mode, current, history, onChange }: Props) {
  const followUp = getTreatmentFollowUp(current);
  const referenceId = followUp.referenceId ?? '';
  const sessions = useMemo(() => getFollowUpSessions(current, history, mode), [current, history, mode]);
  const candidates = sessions.filter(session => session.id != null && session.id !== current.id
    && treatmentDate(session.date) <= treatmentDate(current.date));
  const initial = candidates.filter(session => getTreatmentFollowUp(session).purpose === 'initial').at(-1);
  const reference = referenceId
    ? candidates.find(session => String(session.id) === referenceId)
    : initial ?? candidates[0];
  return (
    <details
      className="admin-surface group overflow-hidden"
      aria-label="Seguimiento del tratamiento"
      defaultOpen={Boolean(current.id || followUp.purpose || followUp.observations)}
    >
      <summary className="admin-focus-ring flex cursor-pointer list-none items-center justify-between gap-4 p-4 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block font-semibold text-gray-800">Seguimiento clínico de la sesión</span>
          <span className="mt-1 block text-xs leading-5 text-gray-500">
            {current.id || followUp.purpose ? 'Revisa la referencia, comparación y evolución registrada.' : 'Opcional: define una evaluación inicial o compara este control con una sesión previa.'}
          </span>
        </span>
        <ChevronDown className="h-5 w-5 shrink-0 text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-4 border-t border-gray-100 p-4">
        <p className="text-xs leading-5 text-gray-500">
          Sesiones del mismo {current.package_id ? 'paquete' : 'procedimiento independiente'} y modo,
          incluidas otras consultas de este expediente. No se fusionan paquetes ni procedimientos distintos.
        </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-gray-700">
          Tipo de registro
          <select value={followUp.purpose ?? ''} onChange={event => onChange({
            ...followUp, purpose: event.target.value === 'initial' ? 'initial' : event.target.value === 'control' ? 'control' : null,
          })} className="admin-focus-ring mt-1 min-h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm">
            <option value="">Sin definir (historial previo)</option>
            <option value="initial">Evaluación inicial</option>
            <option value="control">Control / seguimiento</option>
          </select>
        </label>
        <label className="text-xs font-medium text-gray-700">
          Comparar con
          <select value={referenceId} onChange={event => onChange({ ...followUp, referenceId: event.target.value || null })}
            className="admin-focus-ring mt-1 min-h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm">
            <option value="">Última inicial previa o primer registro disponible</option>
            {referenceId && !reference ? <option value={referenceId}>Referencia guardada no disponible</option> : null}
            {candidates.map(session => <option key={session.id} value={String(session.id)}>
              {formatTreatmentDate(session.date)} · {getFollowUpLabel(session)}
            </option>)}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-gray-50 p-3 text-xs leading-5">
          <p className="font-semibold text-gray-700">Referencia</p>
          {reference ? <>
            <p>{formatTreatmentDate(reference.date)} · {getFollowUpLabel(reference)}</p>
            <p>{describeTreatmentAssessment(reference, mode)}</p>
            {getTreatmentFollowUp(reference).observations ? <p className="whitespace-pre-wrap break-words">{getTreatmentFollowUp(reference).observations}</p> : null}
            {getTreatmentFollowUp(reference).purpose !== 'initial' ? <p className="mt-1 text-amber-700">No es una evaluación inicial confirmada.</p> : null}
            {treatmentDate(reference.date) === treatmentDate(current.date)
              ? <p className="mt-1 text-amber-700">Misma fecha: verifica el orden clínico; no se infiere una hora.</p> : null}
          </> : <p>{referenceId ? 'La referencia guardada no está disponible en este grupo o es posterior a la sesión; selecciona otra, sin sustituirla automáticamente.' : 'No hay referencia previa. Define la inicial o selecciona un procedimiento.'}</p>}
        </div>
        <div className="rounded-xl bg-gold/10 p-3 text-xs leading-5">
          <p className="font-semibold text-gray-700">{current.id ? 'Sesión seleccionada' : 'Nueva sesión (sin guardar)'}</p>
          <p>{formatTreatmentDate(current.date)} · {getFollowUpLabel(current)}</p>
          <p>{describeTreatmentAssessment(current, mode)}</p>
        </div>
      </div>
      {reference ? <p className="rounded-lg border border-gray-100 p-3 text-xs leading-5 text-gray-600" role="status">
        {compareTreatmentAssessments(reference, current, mode)}
      </p> : null}
      <label className="block text-xs font-medium text-gray-700">
        Objetivo inicial / evolución observada en esta sesión
        <textarea value={followUp.observations} onChange={event => onChange({ ...followUp, observations: event.target.value })}
          rows={3} maxLength={4000} placeholder="Describe cambios, respuesta, síntomas y plan del próximo control…"
          className="admin-focus-ring mt-1 w-full rounded-lg border border-gray-200 p-3 text-sm" />
      </label>
      <p className="text-xs leading-5 text-gray-500">
        Los cambios se guardan con el botón Guardar de la sesión. Preparar el siguiente control conserva
        procedimiento, equipos y zonas, pero exige registrar de nuevo sus hallazgos; no crea ni cobra una sesión automáticamente.
      </p>
      {sessions.length ? <details className="rounded-lg border border-gray-100 p-3">
        <summary className="admin-focus-ring cursor-pointer text-xs font-semibold text-gray-700">
          Secuencia de seguimiento · {sessions.length} sesión(es) guardada(s)
        </summary>
        <ol className="mt-3 max-h-64 space-y-3 overflow-y-auto text-xs">
          {sessions.map((session, index) => <li key={session.id ?? index} className="border-l-2 border-gold/40 pl-3 leading-5">
            <p className="font-semibold">{formatTreatmentDate(session.date)} · {getFollowUpLabel(session)}</p>
            <p>{describeTreatmentAssessment(session, mode)}</p>
            {getTreatmentFollowUp(session).observations ? <p className="whitespace-pre-wrap break-words">{getTreatmentFollowUp(session).observations}</p> : null}
          </li>)}
        </ol>
      </details> : null}
      </div>
    </details>
  );
}
