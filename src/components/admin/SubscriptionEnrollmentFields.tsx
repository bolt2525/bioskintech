import { useId } from 'react';
import type { EnrollmentDraft } from '../../utils/subscriptionEnrollment';

interface Props {
  value: EnrollmentDraft;
  onChange: (value: EnrollmentDraft) => void;
  eligible: boolean;
}

export default function SubscriptionEnrollmentFields({ value, onChange, eligible }: Props) {
  const id = useId();
  const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-gold-dark';
  return <fieldset className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-slate-900">
    <legend className="font-semibold">Política contractual 15 + 30 días</legend>
    <p id={`${id}-warning`} className="text-xs text-amber-950">No cambia un contrato existente sin acuerdo. Requiere un contrato nuevo o adenda aceptada y evidencia de pago validada por el servidor; activar esta casilla no acredita pago ni aceptación.</p>
    {!eligible && <p className="text-xs text-amber-950">Sin evidencia de suscripción pagada confirmada. Demos y contratos anteriores no se inscriben automáticamente.</p>}
    <label className="flex items-start gap-2">
      <input type="checkbox" checked={value.enabled} disabled={!eligible} aria-describedby={`${id}-warning`}
        name="policy_opt_in" onChange={event => onChange({ ...value, enabled: event.target.checked, acceptanceConfirmed: false })} className="mt-1 accent-gold focus-visible:ring-2 focus-visible:ring-gold-dark" />
      Registrar acuerdo para vigencia prospectiva
    </label>
    {value.enabled && <>
      <label className="block">Fundamento
        <select name="policy_basis" value={value.basis} onChange={event => onChange({ ...value, basis: event.target.value as EnrollmentDraft['basis'] })} className={`${inputClass} bg-white text-slate-900`}>
          <option value="new_contract">Contrato nuevo</option><option value="addendum">Adenda aceptada</option>
        </select>
      </label>
      <label className="block">Referencia del acuerdo firmado
        <input name="contract_reference" autoComplete="off" spellCheck={false} value={value.contractReference} minLength={10} maxLength={200} onChange={event => onChange({ ...value, contractReference: event.target.value })} className={inputClass} />
      </label>
      <label className="block">Fecha de aceptación (hora local de este dispositivo)
        <input name="accepted_at" type="datetime-local" value={value.acceptedAt} onChange={event => onChange({ ...value, acceptedAt: event.target.value })} className={inputClass} />
      </label>
      <label className="block">Vigencia futura (hora local de este dispositivo)
        <input name="effective_at" type="datetime-local" value={value.effectiveAt} onChange={event => onChange({ ...value, effectiveAt: event.target.value })} className={inputClass} />
      </label>
      <label className="flex items-start gap-2">
        <input name="acceptance_confirmed" type="checkbox" checked={value.acceptanceConfirmed} onChange={event => onChange({ ...value, acceptanceConfirmed: event.target.checked })} className="mt-1 accent-gold focus-visible:ring-2 focus-visible:ring-gold-dark" />
        Confirmo que existe un acuerdo firmado verificable que acepta esta política.
      </label>
    </>}
    <p className="text-xs">Renovar conserva los módulos configurados; no habilita todos los módulos ni activa cobros o procesamiento anual automático.</p>
  </fieldset>;
}
