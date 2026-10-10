import { useMemo } from 'react';
import { Check, ChevronDown } from 'lucide-react';
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
  const setPurpose = (purpose: TreatmentFollowUp['purpose']) => onChange({
    ...followUp,
    purpose,
    referenceId: purpose === 'control' ? followUp.referenceId : null,
    observations: purpose ? followUp.observations : '',
  });
  const purposeOptions = [
    { value: null, label: 'Sin seguimiento', description: 'Sesión independiente, sin comparación.' },
    { value: 'initial' as const, label: 'Primera evaluación', description: 'Crea la línea base para controles futuros.' },
    { value: 'control' as const, label: 'Control de evolución', description: 'Compara con una sesión anterior.' },
  ];

  return (
    <details
      className="admin-surface group overflow-hidden"
      aria-label="Seguimiento del tratamiento"
      defaultOpen={Boolean(current.id || followUp.purpose || followUp.observations)}
    >
      <summary className="admin-focus-ring flex cursor-pointer list-none items-center justify-between gap-4 p-4 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block font-semibold text-gray-800">Comparar evolución</span>
          <span className="mt-1 block text-xs leading-5 text-gray-500">
            {followUp.purpose === 'initial'
              ? 'Esta sesión será la línea base del tratamiento.'
              : followUp.purpose === 'control'
                ? 'Esta sesión se comparará con un registro anterior.'
                : 'Opcional: úsalo solo para iniciar o continuar un seguimiento.'}
          </span>
        </span>
        <ChevronDown className="h-5 w-5 shrink-0 text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-4 border-t border-gray-100 p-4">
        <div>
          <p className="text-sm font-semibold text-gray-800">¿Cómo participa esta sesión en el seguimiento?</p>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            Solo se comparan sesiones del mismo {current.package_id ? 'paquete' : 'procedimiento'} y modo.
          </p>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {purposeOptions.map(option => {
            const selected = followUp.purpose === option.value;
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => setPurpose(option.value)}
                aria-pressed={selected}
                className={`admin-focus-ring relative min-h-24 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] ${
                  selected
                    ? 'border-gold-dark bg-gold/10 shadow-sm ring-2 ring-gold/20'
                    : 'border-gray-200 bg-white hover:border-gold hover:bg-gold/5'
                }`}
              >
                <span className="block pr-6 text-sm font-semibold text-gray-800">{option.label}</span>
                <span className="mt-1 block text-xs leading-5 text-gray-500">{option.description}</span>
                {selected ? <Check className="absolute right-3 top-3 h-4 w-4 text-gold-ink" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>

        {!followUp.purpose ? (
          <p className="rounded-xl bg-gray-50 p-3 text-xs leading-5 text-gray-600" role="status">
            Esta sesión se guardará sin relacionarse con otras. Puedes cambiar esta decisión antes de guardar.
          </p>
        ) : null}

        {followUp.purpose === 'control' ? (
          <>
            <label className="block text-xs font-medium text-gray-700">
              Sesión de referencia
              <select value={referenceId} onChange={event => onChange({ ...followUp, referenceId: event.target.value || null })}
                className="admin-focus-ring mt-1 min-h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm">
                <option value="">Usar la evaluación inicial más reciente</option>
                {referenceId && !reference ? <option value={referenceId}>Referencia guardada no disponible</option> : null}
                {candidates.map(session => <option key={session.id} value={String(session.id)}>
                  {formatTreatmentDate(session.date)} · {getFollowUpLabel(session)}
                </option>)}
              </select>
            </label>
            {!reference ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800" role="alert">
                No hay una sesión anterior comparable. Marca esta como primera evaluación o guarda sin seguimiento.
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl bg-gray-50 p-3 text-xs leading-5">
                    <p className="font-semibold text-gray-700">Referencia anterior</p>
                    <p>{formatTreatmentDate(reference.date)} · {getFollowUpLabel(reference)}</p>
                    <p>{describeTreatmentAssessment(reference, mode)}</p>
                    {getTreatmentFollowUp(reference).observations ? <p className="whitespace-pre-wrap break-words">{getTreatmentFollowUp(reference).observations}</p> : null}
                    {getTreatmentFollowUp(reference).purpose !== 'initial' ? <p className="mt-1 text-amber-700">Esta referencia no fue marcada como primera evaluación.</p> : null}
                    {treatmentDate(reference.date) === treatmentDate(current.date)
                      ? <p className="mt-1 text-amber-700">Ambas sesiones tienen la misma fecha; verifica el orden.</p> : null}
                  </div>
                  <div className="rounded-xl bg-gold/10 p-3 text-xs leading-5">
                    <p className="font-semibold text-gray-700">Sesión actual</p>
                    <p>{formatTreatmentDate(current.date)} · {getFollowUpLabel(current)}</p>
                    <p>{describeTreatmentAssessment(current, mode)}</p>
                  </div>
                </div>
                <p className="rounded-lg border border-gray-100 p-3 text-xs leading-5 text-gray-600" role="status">
                  {compareTreatmentAssessments(reference, current, mode)}
                </p>
              </>
            )}
          </>
        ) : null}

        {followUp.purpose ? (
          <label className="block text-xs font-medium text-gray-700">
            {followUp.purpose === 'initial' ? 'Objetivo y hallazgos iniciales' : 'Evolución observada y próximos pasos'}
            <textarea value={followUp.observations} onChange={event => onChange({ ...followUp, observations: event.target.value })}
              rows={3} maxLength={4000}
              placeholder={followUp.purpose === 'initial'
                ? 'Describe el estado inicial, objetivo y criterio de seguimiento…'
                : 'Describe cambios, respuesta, síntomas y plan del próximo control…'}
              className="admin-focus-ring mt-1 w-full rounded-lg border border-gray-200 p-3 text-sm" />
          </label>
        ) : null}

        <p className="text-xs leading-5 text-gray-500">
          Esta configuración se conserva únicamente al guardar la sesión.
        </p>
        {followUp.purpose && sessions.length ? <details className="rounded-lg border border-gray-100 p-3">
          <summary className="admin-focus-ring cursor-pointer text-xs font-semibold text-gray-700">
            Ver secuencia · {sessions.length} sesión(es) guardada(s)
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
