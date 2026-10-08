import { reserveClinicLifecycle, lockClinicWriters } from './clinic-lifecycle.js';

export const DAY_MS = 86400000;
// Independent of LEGAL_VERSION: activating this contract requires explicit
// provider attestation of a new signed contract or accepted addendum.
export const SUBSCRIPTION_POLICY_VERSION = 'paid-grace15-recovery30-v1';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const timestamp = value => value == null || value === '' ? NaN : new Date(value).getTime();
const isoInstant = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(timestamp(value)) && new Date(value).toISOString() ===
    (value.includes('.') ? value : value.replace('Z', '.000Z'));

// Evidence, not an expiry date, establishes a paid subscription. Registration
// codes and unclassified legacy clinics do not silently become paid accounts.
export const SUBSCRIPTION_FIELDS = `c.subscription_expires_at, c.is_active, cs.general,
  EXISTS(SELECT 1 FROM subscriptions s WHERE s.clinic_id=c.id
    AND s.status IN ('paid','registered') AND s.paid_at IS NOT NULL AND s.amount_cents>0
    AND coalesce(s.plan_name,'') !~* '(trial|demo|prueba)') AS paid_subscription,
  EXISTS(SELECT 1 FROM subscriptions s WHERE s.clinic_id=c.id
    AND coalesce(s.plan_name,'') ~* '(trial|demo|prueba)') AS trial_subscription`;

export function subscriptionLifecycle(clinic = {}, now = Date.now()) {
  const enrollment = clinic.general?._subscription_policy;
  const declared = enrollment?.kind;
  const policy = declared === 'legacy' ? 'legacy' : declared === 'demo' || clinic.trial_subscription === true ? 'demo'
    : clinic.paid_subscription === true ? 'paid' : 'legacy';
  const end = timestamp(clinic.subscription_expires_at);
  const eligible = policy === 'paid' && validPolicyEnrollment(enrollment) &&
    timestamp(enrollment.effective_at) <= now && timestamp(enrollment.effective_at) <= end;
  const missing = clinic.subscription_expires_at == null || clinic.subscription_expires_at === '';
  const invalid = !missing && !Number.isFinite(end);
  const grace = eligible ? end + 15 * DAY_MS : end;
  const recovery = eligible ? end + 45 * DAY_MS : end;
  // Legacy with no contractual date keeps its existing access, but is NEVER
  // automatically purged. A paid/demo account missing a date fails closed.
  let state = missing && policy === 'legacy' ? 'ACTIVE'
    : !Number.isFinite(end) ? 'CLOSED'
    : now < end ? 'ACTIVE' : now < grace ? 'GRACE' : now < recovery ? 'RECOVERY' : 'CLOSED';
  if (clinic.is_active === false || clinic.general?._purge) state = 'CLOSED';
  const operate = state === 'ACTIVE' || state === 'GRACE';
  const boundary = state === 'ACTIVE' ? end : state === 'GRACE' ? grace : recovery;
  const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
  return {
    state, policy: invalid ? 'invalid' : policy,
    policyVersion: enrollment?.policy_version || null,
    opt_in: eligible, auto_purge_eligible: eligible,
    policy_accepted: policy === 'paid' && validPolicyEnrollment(enrollment),
    purge_after: eligible && Number.isFinite(recovery) ? new Date(recovery).toISOString() : null,
    effective_at: validPolicyEnrollment(enrollment) ? enrollment.effective_at : null,
    enrollment_status: eligible ? 'ENROLLED' : validPolicyEnrollment(enrollment) && policy === 'paid'
      ? 'SCHEDULED' : policy === 'demo' ? 'EXCLUDED' : 'REQUIRES_CONTRACT_REVIEW',
    expires_at: iso(end), grace_ends_at: iso(grace), recovery_ends_at: iso(recovery),
    remainingdays: state === 'CLOSED' ? 0 : Number.isFinite(boundary) ? Math.max(0, Math.ceil((boundary - now) / DAY_MS)) : null,
    canoperate: operate, canexport: operate || state === 'RECOVERY',
    canlogin: state !== 'CLOSED', can_auto_backup: operate && (policy === 'legacy' || !missing),
    canimport: operate, canrestore: operate, can_manual_snapshot: operate,
  };
}

export async function loadSubscriptionLifecycle(db, id, now = Date.now()) {
  const result = await db.query(`SELECT ${SUBSCRIPTION_FIELDS}
    FROM clinics c LEFT JOIN clinic_settings cs ON cs.clinic_id=c.id WHERE c.id=$1`, [id]);
  if (!result.rows.length) fail(404, 'Clínica no encontrada.');
  return subscriptionLifecycle(result.rows[0], now);
}

export async function persistSubscriptionLifecycle(db, id, lifecycle) {
  await db.query(`INSERT INTO clinic_settings(clinic_id,general)
    VALUES($1,jsonb_build_object('_subscription_lifecycle',$2::jsonb))
    ON CONFLICT(clinic_id) DO UPDATE SET general=clinic_settings.general ||
    jsonb_build_object('_subscription_lifecycle',$2::jsonb),updated_at=now()
    WHERE clinic_settings.general->'_subscription_lifecycle' IS DISTINCT FROM $2::jsonb`,
  [id, JSON.stringify(lifecycle)]);
}

export async function syncSubscriptionLifecycle(pool, clinic, now = Date.now()) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout = '10s'");
    await lockClinicWriters(db, [clinic.id]);
    const lifecycle = await loadSubscriptionLifecycle(db, clinic.id, now);
    await persistSubscriptionLifecycle(db, clinic.id, lifecycle);
    await db.query('COMMIT');
    return lifecycle;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

export const RECOVERY_BACKUP_ACTIONS = new Set([
  'stats', 'csv', 'template', 'templateInfo', 'consentPatients', 'consentsHtml',
  'snapshots', 'export', 'download', 'photoBackupStatus', 'photoBackupDownload', 'requestPhotoBackup',
]);
export function subscriptionRequestAllowed(lifecycle, role, req, { delivery = false } = {}) {
  if (!lifecycle) return true; // master without a tenant
  if (lifecycle.canoperate) return true;
  if (role !== 'clinic_admin') return false;
  const action = String(req.query?.action || req.body?.action || 'stats');
  const path = String(req.url || '').split('?')[0].replace(/\/$/, '');
  if (delivery && ['photoBackupStatus', 'photoBackupDownload'].includes(action)) return true;
  return lifecycle.state === 'RECOVERY' && path === '/api/backup' && RECOVERY_BACKUP_ACTIONS.has(action);
}

export async function requireSubscriptionOperation(db, id) {
  const lifecycle = await loadSubscriptionLifecycle(db, id);
  if (!lifecycle.canoperate) fail(403, 'La suscripción no permite operaciones. Solo recuperación de datos por el administrador.');
  return lifecycle;
}

// Shared by status, registration, approval, callbacks and purge. Only the current
// registered period can grant a new free entitlement: renewal never accumulates it.
export const ANNUAL_PERIOD_SQL = `p.starts_at<=now()
  AND p.ends_at=p.starts_at+interval '12 months'
  AND (p.ends_at>now() OR ($3::boolean AND p.ends_at=$2::timestamptz
    AND now()<p.ends_at+interval '45 days'))
  AND NOT EXISTS (SELECT 1 FROM annual_photo_backup_periods newer
    WHERE newer.clinic_id=p.clinic_id AND newer.starts_at>p.starts_at AND newer.starts_at<=now())`;

export const ANNUAL_ENTITLEMENT_SQL = `r.created_at>=p.starts_at
  AND r.created_at<=now()
  AND p.ends_at=p.starts_at+interval '12 months'
  AND r.created_at<r.entitlement_deadline_at
  AND r.entitlement_deadline_at>=p.ends_at
  AND r.entitlement_deadline_at<=p.ends_at+interval '45 days'
  AND (r.entitlement_deadline_at=p.ends_at OR r.recovery_allowed=true)
  AND (r.expired_at IS NULL OR (r.status='APPROVED' AND r.last_error='SOURCES_EXPIRED'))
  AND (r.entitlement_kind='FREE' OR (r.entitlement_kind='PAID'
    AND r.payment_status='PAID' AND r.confirmed_provider_id IS NOT NULL AND r.quote_provider_id IS NOT NULL
    AND r.quote_accepted_at>=r.created_at AND r.quote_accepted_at<r.entitlement_deadline_at
    AND r.paid_at>=r.quote_accepted_at AND r.paid_at<r.entitlement_deadline_at
    AND r.paid_at<=now()
    AND length(btrim(r.payment_reference)) BETWEEN 3 AND 200 AND r.quote_total_cents>0))`;

export async function annualPurgeProtection(db, id, deadline, now = Date.now()) {
  const cutoff = timestamp(deadline);
  if (!Number.isFinite(cutoff)) return { protected: false, until: null, reason: null };
  const table = await db.query("SELECT to_regclass('public.annual_photo_backup_requests') AS requests");
  if (!table.rows[0]?.requests) return { protected: false, until: null, reason: null };
  const schema = await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='annual_photo_backup_requests'
      AND column_name='entitlement_deadline_at') AS ready`);
  // An existing pre-migration table may contain pending delivery obligations.
  // Unknown entitlement is not evidence that destructive cleanup is permitted.
  if (!schema.rows[0]?.ready) throw Object.assign(new Error('Migración anual requerida para verificar entregas pendientes.'),
    { status: 503, code: 'ANNUAL_MIGRATION_NEEDED' });
  const rows = (await db.query(`SELECT r.*,(${ANNUAL_ENTITLEMENT_SQL}) AS entitled
    FROM annual_photo_backup_requests r JOIN annual_photo_backup_periods p
      ON p.id=r.period_id AND p.clinic_id=r.clinic_id
    WHERE r.clinic_id=$1 AND r.created_at < $2::timestamptz
      AND (${ANNUAL_ENTITLEMENT_SQL})
      AND r.status IN ('REQUESTED','APPROVED','READY')
      `, [id, new Date(cutoff).toISOString()])).rows;
  let until = null;
  for (const row of rows) {
    const hold = annualDeliveryHold({ ...row, free_eligible: row.entitled === true,
      provider_accepted_at: row.quote_accepted_at }, row.entitlement_deadline_at, now);
    if (hold.protected && !hold.until) return hold;
    if (hold.protected) until = Math.max(until || 0, timestamp(hold.until));
  }
  return { protected: until !== null, until: until ? new Date(until).toISOString() : null,
    reason: until ? 'ANNUAL_DELIVERY_WINDOW' : null };
}

// Future billing adapter must pass server-validated entitlement evidence from
// its own persisted order, never the request body or an unpaid quotation.
export function annualDeliveryHold(request, deadline, now = Date.now()) {
  const noHold = { protected: false, until: null, reason: null };
  const cutoff = timestamp(deadline);
  const requested = timestamp(request?.created_at);
  const accepted = timestamp(request?.provider_accepted_at);
  const eligible = (request?.entitlement_kind === 'FREE' && request.free_eligible === true) ||
    (request?.entitlement_kind === 'PAID' && request.payment_status === 'PAID' &&
      request.confirmed_provider_id != null && request.quote_provider_id != null &&
      typeof request.payment_reference === 'string' && request.payment_reference.trim().length>=3 &&
      request.payment_reference.length<=200 &&
      Number.isSafeInteger(Number(request.quote_total_cents)) && Number(request.quote_total_cents)>0 &&
      Number.isFinite(accepted) && accepted >= requested && accepted < cutoff && accepted <= now &&
      timestamp(request.paid_at)>=accepted && timestamp(request.paid_at)<cutoff && timestamp(request.paid_at)<=now);
  if (!eligible || !Number.isFinite(requested) || !Number.isFinite(cutoff) || requested > now || requested >= cutoff ||
      (request.expired_at && !(request.status==='APPROVED' && request.last_error==='SOURCES_EXPIRED')) ||
      !['REQUESTED','APPROVED','READY'].includes(request.status)) return noHold;
  if (request.status !== 'READY') return { protected: true, until: null, reason: 'ANNUAL_DELIVERY_PENDING' };
  const ready = timestamp(request.ready_at);
  if (!Number.isFinite(ready)) fail(409, 'Estado de entrega anual inválido.');
  return ready + DAY_MS > now ? { protected: true, until: new Date(ready + DAY_MS).toISOString(),
    reason: 'ANNUAL_DELIVERY_WINDOW' } : noHold;
}

function validPolicyEnrollment(record) {
  return record?.policy_version === SUBSCRIPTION_POLICY_VERSION && record.opt_in === true &&
    record.acceptance_confirmed === true && ['new_contract','addendum'].includes(record.basis) &&
    typeof record.contract_reference === 'string' && record.contract_reference.trim().length >= 10 &&
    record.contract_reference.length <= 200 && !/[\u0000-\u001f\u007f]/.test(record.contract_reference) &&
    isoInstant(record.accepted_at) && isoInstant(record.effective_at) && timestamp(record.accepted_at) <= timestamp(record.effective_at) &&
    record.recorded_by?.role === 'master_admin' && typeof record.recorded_by.username === 'string' &&
    record.recorded_by.username.length > 0 && isoInstant(record.recorded_at) &&
    timestamp(record.recorded_at) <= timestamp(record.effective_at);
}

export async function renewClinicSubscription(pool, id, expiresAt, days, kind, enrollment, actor) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '') ||
      !Number.isFinite(timestamp(expiresAt)) || !Number.isInteger(days) || days < 1 || days > 3650 ||
      (kind !== undefined && !['paid', 'demo', 'legacy'].includes(kind)))
    fail(400, 'Datos de suscripción inválidos.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await reserveClinicLifecycle(db, id);
    const row = (await db.query(`SELECT c.id,cs.general FROM clinics c LEFT JOIN clinic_settings cs ON cs.clinic_id=c.id
      WHERE c.id=$1 FOR UPDATE OF c`, [id])).rows[0];
    if (!row) fail(404, 'Clínica no encontrada.');
    if (row.general?._purge) fail(409, 'La clínica tiene una purga irreversible registrada.');
    let policyRecord = null;
    if (enrollment !== undefined) {
      if (actor?.role !== 'master_admin' || typeof actor.username !== 'string' || !actor.username)
        fail(403, 'Solo el proveedor autenticado puede registrar aceptación contractual.');
      if (!enrollment || typeof enrollment !== 'object' || Array.isArray(enrollment))
        fail(400, 'Constancia contractual inválida.');
      const now = Date.now();
      policyRecord = {
        kind: 'paid', policy_version: enrollment.policy_version, opt_in: enrollment.opt_in,
        acceptance_confirmed: enrollment.acceptance_confirmed, basis: enrollment.basis,
        contract_reference: enrollment.contract_reference, accepted_at: enrollment.accepted_at,
        effective_at: enrollment.effective_at, recorded_at: new Date(now).toISOString(),
        recorded_by: { role: actor.role, username: actor.username, id: actor.id ?? null },
      };
      if (!validPolicyEnrollment(policyRecord) || timestamp(policyRecord.accepted_at) > now ||
          timestamp(policyRecord.effective_at) < now || timestamp(policyRecord.effective_at) > timestamp(expiresAt) ||
          (kind !== undefined && kind !== 'paid'))
        fail(400, 'Se requiere aceptación confirmada y vigencia prospectiva de la política versionada.');
      const current = await loadSubscriptionLifecycle(db, id, now);
      if (current.policy !== 'paid') fail(409, 'No existe evidencia de suscripción pagada elegible; demos/trials excluidos.');
    }
    await db.query('UPDATE clinics SET subscription_expires_at=$2,subscription_days=$3 WHERE id=$1',
      [id, expiresAt, days]);
    if (policyRecord) await db.query(`INSERT INTO clinic_settings(clinic_id,general)
      VALUES($1,jsonb_build_object('_subscription_policy',$2::jsonb))
      ON CONFLICT(clinic_id) DO UPDATE SET general=clinic_settings.general ||
      jsonb_build_object('_subscription_policy',$2::jsonb),updated_at=now()`, [id, JSON.stringify(policyRecord)]);
    else if (kind) await db.query(`INSERT INTO clinic_settings(clinic_id,general)
      VALUES($1,jsonb_build_object('_subscription_policy',jsonb_build_object('kind',$2::text)))
      ON CONFLICT(clinic_id) DO UPDATE SET general=clinic_settings.general ||
      jsonb_build_object('_subscription_policy',coalesce(clinic_settings.general->'_subscription_policy','{}'::jsonb) ||
        jsonb_build_object('kind',$2::text)),updated_at=now()`, [id, kind]);
    const lifecycle = await loadSubscriptionLifecycle(db, id);
    await persistSubscriptionLifecycle(db, id, lifecycle);
    await db.query('COMMIT');
    return lifecycle;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
