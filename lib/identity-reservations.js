import { AsyncLocalStorage } from 'node:async_hooks';
import { getPool } from './neon-clinical-db.js';
import { normalizeWaIdentityPhone } from './wa-link-resolver.js';

const readers = new AsyncLocalStorage();
const conflict = () => { throw Object.assign(new Error('Los identificadores solicitados ya están reservados.'), { status: 409 }); };

// One namespace for registration, edits and irreversible release, including
// normalized phone aliases. Always acquire before the clinic lifecycle lock.
export async function reserveIdentities(db) {
  await db.query('SELECT pg_advisory_xact_lock(68422, 1)');
}

export async function withIdentityReadLock(operation, pool = getPool()) {
  if (readers.getStore()) return operation();
  const db = await pool.connect();
  let releaseError;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock_shared(68422, 1)');
    const result = await readers.run(true, operation);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try { await db.query('ROLLBACK'); }
    catch (rollbackError) { releaseError = rollbackError; }
    throw error;
  } finally {
    db.release(releaseError);
  }
}

export const normalizedAlias = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validateAlias = alias => {
  if (alias.startsWith('!purged:'))
    throw Object.assign(new Error('Identificador reservado para constancias del sistema.'), { status: 400 });
};

// Caller owns the global reservation through COMMIT. Existing legacy duplicates
// are not silently repaired; no new claim can add another duplicate.
export async function assertUserAliases(db, { id = null, username, email }) {
  for (const [column, value] of [['username', username], ['email', email]]) {
    const alias = normalizedAlias(value);
    if (!alias) continue;
    validateAlias(alias);
    const result = await db.query(`SELECT id FROM clinic_users WHERE lower(btrim(${column}))=$1
      AND ($2::integer IS NULL OR id<>$2) LIMIT 1`, [alias, id]);
    if (result.rows.length) conflict();
  }
}

export async function assertClinicAliases(db, { id = null, name, slug, email, phone }) {
  for (const [column, value] of [['name', name], ['slug', slug], ['email', email]]) {
    const alias = normalizedAlias(value);
    if (!alias) continue;
    validateAlias(alias);
    const result = await db.query(`SELECT id FROM clinics WHERE lower(btrim(${column}))=$1
      AND ($2::uuid IS NULL OR id<>$2) LIMIT 1`, [alias, id]);
    if (result.rows.length) conflict();
  }
  const normalized = normalizeWaIdentityPhone(phone);
  if (!normalized) return;
  const clinics = await db.query('SELECT id,phone FROM clinics WHERE ($1::uuid IS NULL OR id<>$1)', [id]);
  if (clinics.rows.some(row => normalizeWaIdentityPhone(row.phone) === normalized)) conflict();
  const users = await db.query(`SELECT phone,whatsapp_staff_phone FROM clinic_users
    WHERE ($1::uuid IS NULL OR clinic_id IS DISTINCT FROM $1)`, [id]);
  if (users.rows.some(row => [row.phone, row.whatsapp_staff_phone]
    .some(value => value && normalizeWaIdentityPhone(value) === normalized))) conflict();
  const contacts = await db.query(`SELECT phone FROM whatsapp_contacts
    WHERE retired_at IS NULL AND clinic_id IS NOT NULL
      AND ($1::uuid IS NULL OR clinic_id IS DISTINCT FROM $1)`, [id]);
  if (contacts.rows.some(row => normalizeWaIdentityPhone(row.phone) === normalized)) conflict();
}
