const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
import { SUBSCRIPTION_FIELDS, subscriptionLifecycle, annualPurgeProtection } from './subscription-lifecycle.js';

export function lifecycleClinicIds(ids) {
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id))) fail(400, 'Clínica inválida.');
  return [...new Set(ids.map(id => id.toLowerCase()))].sort();
}

export async function lockClinicWriters(db, ids, { session = false } = {}) {
  for (const id of lifecycleClinicIds(ids))
    await db.query(`SELECT pg_advisory_${session ? 'lock_shared' : 'xact_lock_shared'}(hashtextextended($1,68421))`, [id]);
}

export async function unlockClinicWriters(db, ids) {
  for (const id of lifecycleClinicIds(ids).reverse())
    await db.query('SELECT pg_advisory_unlock_shared(hashtextextended($1,68421))', [id]);
}

export async function reserveClinicLifecycle(db, id) {
  const [clinicId] = lifecycleClinicIds([id]);
  const result = await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,68421)) AS acquired', [clinicId]);
  if (result.rows[0]?.acquired !== true)
    fail(409, 'Hay operaciones de la clínica en curso; espera a que terminen y reintenta.');
}

export async function requireClinicWritable(db, id, { allowInactive = false, subscriptionAccess = 'operate' } = {}) {
  const [clinicId] = lifecycleClinicIds([id]);
  const result = await db.query(`SELECT c.is_active,cs.general ? '_purge' AS purging,${SUBSCRIPTION_FIELDS}
    FROM clinics c LEFT JOIN clinic_settings cs ON cs.clinic_id=c.id WHERE c.id=$1`, [clinicId]);
  if (!result.rows.length || result.rows[0].purging === true ||
      (!allowInactive && result.rows[0].is_active !== true))
    fail(409, 'La clínica está desactivada o tiene una purga registrada; la operación fue bloqueada.');
  const lifecycle = subscriptionLifecycle(result.rows[0]);
  if (subscriptionAccess === 'admin') return lifecycle;
  if (lifecycle.canoperate || (['recovery', 'delivery'].includes(subscriptionAccess) && lifecycle.canexport)) return lifecycle;
  if (subscriptionAccess === 'delivery' &&
      (await annualPurgeProtection(db, clinicId, lifecycle.recovery_ends_at)).protected) return lifecycle;
  fail(403, 'Suscripción limitada a recuperación de datos; esta operación no está permitida.');
}
