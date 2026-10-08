export const SUBSCRIPTION_POLICY_VERSION = 'paid-grace15-recovery30-v1';

export interface EnrollmentDraft {
  enabled: boolean;
  acceptanceConfirmed: boolean;
  basis: 'new_contract' | 'addendum';
  contractReference: string;
  acceptedAt: string;
  effectiveAt: string;
}

export const EMPTY_ENROLLMENT: EnrollmentDraft = {
  enabled: false, acceptanceConfirmed: false, basis: 'addendum',
  contractReference: '', acceptedAt: '', effectiveAt: '',
};

/** Las fechas locales del formulario se envían como instantes ISO UTC. */
export function policyEnrollment(draft: EnrollmentDraft, expiresAt: number, now = Date.now()) {
  if (!draft.enabled) return undefined;
  const accepted = Date.parse(draft.acceptedAt);
  const effective = Date.parse(draft.effectiveAt);
  const reference = draft.contractReference.trim();
  if (!draft.acceptanceConfirmed || !['new_contract', 'addendum'].includes(draft.basis) ||
      reference.length < 10 || reference.length > 200 ||
      [...reference].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error('Confirma el acuerdo firmado e indica una referencia contractual verificable de 10 a 200 caracteres.');
  if (!Number.isFinite(accepted) || !Number.isFinite(effective) || accepted > now ||
      accepted > effective || effective <= now || effective > expiresAt)
    throw new Error('La aceptación debe ser pasada y la vigencia futura, anterior o igual al nuevo vencimiento.');
  return {
    policy_version: SUBSCRIPTION_POLICY_VERSION, opt_in: true, acceptance_confirmed: true,
    basis: draft.basis, contract_reference: reference,
    accepted_at: new Date(accepted).toISOString(), effective_at: new Date(effective).toISOString(),
  };
}
