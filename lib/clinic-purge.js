import crypto from 'node:crypto';
import { getPool } from './neon-clinical-db.js';
import { deleteR2Object, listR2ObjectPage } from './r2-service.js';
import { reserveClinicLifecycle } from './clinic-lifecycle.js';
import { SUBSCRIPTION_POLICY_VERSION } from './subscription-lifecycle.js';
import { reserveIdentities, assertClinicAliases } from './identity-reservations.js';
import { normalizeWaIdentityPhone } from './wa-link-resolver.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_MS = 300000;
const QUIESCE_MS = 25 * 60000;
const STORAGE_RETRY_MS = 24 * 60 * 60000;
const BACKUP_RETENTION_MS = 30 * 86400000;
const CRON_BUDGET_MS = 20000;
const CRON_BATCH_SIZE = 100;
const PHASES = ['PHOTOS', 'TEMP', 'ANNUAL', 'BACKUPS', 'SQL', 'COMPLETE'];
const PREFIXES = { PHOTOS: 'clinics', TEMP: 'backup-tmp', ANNUAL: 'annual-photo-backups', BACKUPS: 'backups' };
const TABLES = new Set([
  'patients', 'clinical_records', 'consultations', 'consultation_history', 'consultation_info',
  'medical_history', 'physical_exams', 'diagnoses', 'treatments', 'treatment_packages',
  'prescriptions', 'injectables', 'consent_forms', 'medical_history_snapshots', 'inventory_items',
  'inventory_groups', 'inventory_batches', 'inventory_movements', 'financial_records',
  'financial_items', 'external_finance_records', 'sharing_groups', 'patient_audit_log',
  'clinical_photos', 'patient_assignments', 'sharing_group_members', 'professional_signatures',
  'prescription_templates', 'annual_photo_backup_periods', 'annual_photo_backup_requests',
  'annual_photo_backup_parts', 'annual_photo_backup_notifications',
  'admin_sessions', 'clinic_features', 'clinic_oauth_tokens', 'clinic_consent_templates',
  'clinic_notifications', 'clinic_staff_resources', 'invite_links', 'whatsapp_contacts',
  'ai_consultations',
  'user_whatsapp_channels', 'whatsapp_signup_attempts',
]);
const RETAINED = new Set(['clinic_settings', 'subscriptions', 'legal_acceptances', 'clinic_users', 'clinic_identity_history']);
const CASCADE_CHILDREN = new Set([
  'login_otp', 'trusted_devices', 'password_setup_tokens', 'oauth_states',
  'user_module_overrides', 'whatsapp_messages',
]);
const WA_TABLES = ['whatsapp_contacts','whatsapp_messages','whatsapp_bot_state','wa_short_links'];
const phoneKey = normalizeWaIdentityPhone;

// Global legacy WA tables have no reliable tenant column. Attribution uses the
// contact AND message author, never just a patient phone guessed from URL text.
export function planWhatsAppPurge(id, { contacts = [], users = [], messages = [], states = [], links = [] }) {
  const summary = {
    // Keep the UI/API field compatible; ambiguous clusters are excluded, not
    // a reason to veto independent exclusive rows.
    policy: 'preserve_ambiguous', blocked: false,
    deletable: Object.fromEntries(WA_TABLES.map(table => [table, 0])),
    retained: Object.fromEntries(WA_TABLES.map(table => [table, 0])),
    retainedScope: 'GLOBAL_AMBIGUOUS_NOT_TENANT_OWNERSHIP',
  };
  const tenantsByPhone = new Map();
  const add = (phone, tenant) => {
    const key = phoneKey(phone);
    if (!key) return;
    if (!tenantsByPhone.has(key)) tenantsByPhone.set(key, new Set());
    tenantsByPhone.get(key).add(tenant || null);
  };
  for (const c of contacts) add(c.phone, c.clinic_id);
  for (const u of users) { add(u.phone, u.clinic_id); add(u.whatsapp_staff_phone, u.clinic_id); }
  const exclusive = phone => {
    const tenants = tenantsByPhone.get(phoneKey(phone));
    return tenants?.size === 1 ? [...tenants][0] : null;
  };
  const contactById = new Map(contacts.map(c => [String(c.id), c]));
  const ambiguousContacts = new Set(contacts
    .filter(c => !c.clinic_id || exclusive(c.phone) !== c.clinic_id).map(c => String(c.id)));
  for (const message of messages) {
    const contact = contactById.get(String(message.contact_id));
    if (!contact?.clinic_id) continue; // Global orphan/unassigned rows: retain, never infer ownership.
    if ((message.booked_by_user_id != null && message.owner_clinic_id !== contact.clinic_id) ||
        (message.owner_clinic_id != null && message.owner_clinic_id !== contact.clinic_id)) {
      ambiguousContacts.add(String(contact.id));
    }
  }
  const parsedLinks = links.map(link => {
    const scoped = /^([0-9a-f-]{36})\.[A-Za-z0-9_-]{22}$/i.exec(link.code || '');
    try {
      const target = new URL(link.target_url);
      if (target.protocol === 'https:' && target.hostname === 'wa.me' && /^\/\d+$/.test(target.pathname))
        return { link, scoped, phone: target.pathname.slice(1) };
    } catch { /* Invalid links are retained without inferring ownership. */ }
    return { link, scoped, phone: null };
  });
  // retain_whatsapp_cluster: removing the only phone evidence must not make a
  // contradictory scoped link look exclusive to its declared clinic next time.
  const conflictingPhones = new Set(parsedLinks
    .filter(({ scoped, phone }) => phone && scoped && UUID.test(scoped[1]) &&
      tenantsByPhone.has(phoneKey(phone)) && exclusive(phone) !== scoped[1].toLowerCase())
    .map(({ phone }) => phoneKey(phone)));
  for (const contact of contacts)
    if (conflictingPhones.has(phoneKey(contact.phone))) ambiguousContacts.add(String(contact.id));
  // A conflicting target contact is indivisible: keep it and its entire history.
  const selectedContacts = contacts.filter(c => c.clinic_id === id && !ambiguousContacts.has(String(c.id)));
  const selectedIds = new Set(selectedContacts.map(c => String(c.id)));
  for (const contact of contacts) {
    if (!ambiguousContacts.has(String(contact.id))) continue;
    summary.retained.whatsapp_contacts++;
  }
  for (const message of messages) {
    const key = String(message.contact_id);
    if (selectedIds.has(key)) summary.deletable.whatsapp_messages++;
    else if (!contactById.has(key) || ambiguousContacts.has(key)) summary.retained.whatsapp_messages++;
  }
  // Retention is fail-closed per cluster, not a global purge veto. Keep related
  // state/links too, even when the contact phone otherwise looks exclusive.
  const retainedPhones = new Set(contacts.filter(c => ambiguousContacts.has(String(c.id))).map(c => phoneKey(c.phone)));
  const statePhones = [], stateIds = [];
  for (const state of states) {
    const tenant = retainedPhones.has(phoneKey(state.phone)) ? null : exclusive(state.phone);
    const declared = new Set();
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['clinicId','clinic_id'].includes(key) && child != null) declared.add(String(child).toLowerCase());
        else visit(child);
      }
    };
    visit(state.data);
    if (!tenant || [...declared].some(owner => owner !== tenant)) summary.retained.whatsapp_bot_state++;
    else if (tenant === id) { statePhones.push(state.phone); if (state.id != null) stateIds.push(state.id); }
  }
  const linkCodes = [];
  for (const { link, scoped, phone } of parsedLinks) {
    if (!phone) { summary.retained.wa_short_links++; continue; }
    const inferred = exclusive(phone);
    const tenant = scoped ? scoped[1].toLowerCase() : inferred;
    if (retainedPhones.has(phoneKey(phone)) || !tenant || (scoped && (!UUID.test(scoped[1]) ||
        (tenantsByPhone.has(phoneKey(phone)) && inferred !== tenant)))) summary.retained.wa_short_links++;
    else if (tenant === id) linkCodes.push(link.code);
  }
  summary.deletable.whatsapp_contacts = selectedContacts.length;
  summary.deletable.whatsapp_bot_state = statePhones.length;
  summary.deletable.wa_short_links = linkCodes.length;
  return { contactIds: selectedContacts.map(c => c.id), statePhones, stateIds, linkCodes, summary };
}

export function minimalSubscriptionReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const receipt = {};
  // Do not retain arbitrary provider objects, customer identity or free text.
  for (const key of ['transactionId','clientTransactionId','authorizationCode','statusCode','amount','currency']) {
    const item = value[key];
    if (typeof item === 'number' && Number.isFinite(item)) receipt[key] = item;
    else if (typeof item === 'string' && item.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(item)) receipt[key] = item;
  }
  return receipt;
}

async function whatsappPlan(db, id) {
  const tables = (await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name=ANY($1::text[])`, [WA_TABLES])).rows.map(r => r.table_name);
  if (!tables.length) return { tables, ...planWhatsAppPurge(id, {}), messageCount: 0 };
  if (WA_TABLES.some(table => !tables.includes(table))) fail(409, 'Esquema WhatsApp incompleto; requiere revisión asistida.');
  const bounded = async statement => {
    const rows = (await db.query(statement)).rows;
    if (rows.length > 50000) fail(409, 'Más de 50.000 referencias WhatsApp: requiere separación asistida.');
    return rows;
  };
  const contacts = await bounded('SELECT id,phone,clinic_id FROM whatsapp_contacts LIMIT 50001');
  const users = await bounded(`SELECT id,clinic_id,phone,whatsapp_staff_phone FROM clinic_users
    UNION ALL SELECT (a->>'id')::integer,h.clinic_id,a->>'phone',a->>'whatsapp_staff_phone'
    FROM clinic_identity_history h CROSS JOIN LATERAL jsonb_array_elements(h.user_aliases) a LIMIT 50001`);
  const messages = await bounded(`SELECT m.id,m.contact_id,m.booked_by_user_id,u.clinic_id AS owner_clinic_id
    FROM whatsapp_messages m LEFT JOIN clinic_users u ON u.id=m.booked_by_user_id LIMIT 50001`);
  const states = await bounded('SELECT phone,data,id FROM whatsapp_bot_state LIMIT 50001');
  const links = await bounded('SELECT code,target_url FROM wa_short_links LIMIT 50001');
  const plan = planWhatsAppPurge(id, { contacts, users, messages, states, links });
  return { tables, ...plan, messageCount: plan.summary.deletable.whatsapp_messages };
}
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function purgeClinicId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'Identificador de clínica inválido');
  return value.toLowerCase();
}

export function purgePrefixes(id) {
  id = purgeClinicId(id);
  return Object.values(PREFIXES).map(prefix => `${prefix}/${id}/`);
}

export function isPurgeKey(key, id, phase) {
  const prefixIndex = Object.keys(PREFIXES).indexOf(phase);
  const prefix = purgePrefixes(id)[prefixIndex];
  if (!prefix || typeof key !== 'string' || !key.startsWith(prefix) ||
      key.includes('..') || /[\u0000-\u001f\\]/.test(key)) return false;
  if (phase === 'PHOTOS') return new RegExp(`^clinics/${id}/records/[1-9]\\d*/photos/[^/]+$`).test(key);
  if (phase === 'BACKUPS') return new RegExp(`^backups/${id}/[^/]+/[^/]+$`).test(key);
  return true;
}

export function purgeReasons(clinic, now = Date.now(), lifecycle = null, { manual = false } = {}) {
  const reasons = [];
  if (clinic.is_active !== false) reasons.push('Desactiva la clínica antes de solicitar la purga.');
  const policy = lifecycle?.policy || 'legacy';
  if (policy === 'invalid' || (!manual && (policy === 'legacy' || (policy === 'paid' && lifecycle?.auto_purge_eligible !== true))))
    reasons.push('Contrato no habilitado para este ciclo de retención; requiere revisión y aceptación prospectiva explícita.');
  const ended = Date.parse(lifecycle?.expires_at ?? clinic.subscription_expires_at);
  const retentionDays = policy === 'paid' ? 45 : 30;
  const recoveryEnds = Date.parse(lifecycle?.recovery_ends_at);
  if (policy === 'invalid' || (lifecycle && lifecycle.state !== 'CLOSED') ||
      (policy === 'paid' && (!Number.isFinite(recoveryEnds) || recoveryEnds > now)) ||
      !Number.isFinite(ended) || ended + retentionDays * 86400000 > now)
    reasons.push(`Se requiere fin de suscripción registrado y haber cumplido ${retentionDays} días posteriores.`);
  return reasons;
}

export function validatePurgeConfirmation(body, clinic) {
  if (body.confirmation !== clinic.slug || body.authorizationConfirmed !== true ||
      body.retentionConfirmed !== true || typeof body.reason !== 'string' ||
      body.reason.trim().length < 10 || body.reason.length > 1000)
    fail(400, 'Confirma el identificador de destino, autorización, plazo y un motivo de 10 a 1000 caracteres.');
}

export function orderPurgeTables(tables, foreignKeys) {
  const remaining = new Set(tables);
  const result = [];
  while (remaining.size) {
    const leaf = [...remaining].find(parent => !foreignKeys.some(fk =>
      fk.parent === parent && fk.child !== parent && remaining.has(fk.child)));
    if (!leaf) fail(409, 'Dependencias cíclicas: la purga requiere revisión técnica.');
    remaining.delete(leaf);
    result.push(leaf);
  }
  return result;
}

async function transaction(pool, fn) {
  const db = await pool.connect();
  const deadline = Date.now() + 12000;
  try {
    await db.query('BEGIN');
    const bounded = {
      query: async (sql, params) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) fail(503, 'Presupuesto SQL del lote agotado. Reintenta la operación.');
        await db.query(`SET LOCAL statement_timeout = '${Math.min(10000, remaining)}ms'`);
        return db.query(sql, params);
      },
    };
    const result = await fn(bounded);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

async function loadClinic(db, id, lock = false) {
  const clinic = (await db.query(`SELECT id,name,slug,is_active,subscription_expires_at FROM clinics
    WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!clinic) fail(404, 'Clínica no encontrada');
  const identity = (await db.query('SELECT clinic_aliases,released_at FROM clinic_identity_history WHERE clinic_id=$1', [id])).rows[0];
  // Confirmation remains bound to the original identity, not technical aliases.
  if (identity) Object.assign(clinic, { name: identity.clinic_aliases.name, slug: identity.clinic_aliases.slug });
  const settings = (await db.query('SELECT general FROM clinic_settings WHERE clinic_id=$1', [id])).rows[0];
  if (settings && (!settings.general || typeof settings.general !== 'object' || Array.isArray(settings.general)))
    fail(409, 'Configuración de clínica inválida: requiere revisión técnica.');
  const purge = settings?.general?._purge || null;
  if (purge && (typeof purge !== 'object' || Array.isArray(purge) ||
      !['QUIESCING', 'RUNNING', 'WAITING_STORAGE', 'FAILED', 'COMPLETE'].includes(purge.state) ||
      !PHASES.includes(purge.phase) || !Number.isFinite(Date.parse(purge.retryAfter)) ||
      !Number.isSafeInteger(purge.deletedObjects) || purge.deletedObjects < 0 ||
      (purge.phase === 'COMPLETE') !== (purge.state === 'COMPLETE') ||
      (purge.state === 'WAITING_STORAGE' && purge.phase !== 'BACKUPS') ||
      (purge.state === 'WAITING_STORAGE' && (!purge.waitingStorage ||
        typeof purge.waitingStorage !== 'object' || Array.isArray(purge.waitingStorage) ||
        !Number.isFinite(Date.parse(purge.waitingStorage.checkedAt)) ||
        !Number.isSafeInteger(purge.waitingStorage.pendingObjects) || purge.waitingStorage.pendingObjects < 0 ||
        !Number.isFinite(Date.parse(purge.waitingStorage.until)) ||
        (purge.waitingStorage.morePending !== undefined && typeof purge.waitingStorage.morePending !== 'boolean'))) ||
      (purge.leaseUntil && !Number.isFinite(Date.parse(purge.leaseUntil))) ||
      (purge.backupRetentionUntil && !Number.isFinite(Date.parse(purge.backupRetentionUntil)))))
    fail(409, 'Constancia de purga inválida: requiere revisión técnica.');
  return { clinic, purge, identity };
}

function ensureBackupRetention(job, now) {
  if (!job || job.state === 'COMPLETE' || Number.isFinite(Date.parse(job.backupRetentionUntil))) return;
  job.backupRetentionUntil = new Date(now + BACKUP_RETENTION_MS).toISOString();
  if (job.phase === 'SQL') job.phase = 'BACKUPS';
}

async function lifecycleHelpers(deps = {}) {
  const module = deps.loadSubscriptionLifecycle && deps.annualPurgeProtection && deps.persistSubscriptionLifecycle
    ? deps : await import('./subscription-lifecycle.js');
  const load = deps.loadSubscriptionLifecycle || module.loadSubscriptionLifecycle;
  const protect = deps.annualPurgeProtection || module.annualPurgeProtection;
  const persist = deps.persistSubscriptionLifecycle || module.persistSubscriptionLifecycle;
  if (typeof load !== 'function' || typeof protect !== 'function' || typeof persist !== 'function')
    fail(503, 'No se pudo cargar la política de ciclo de vida de suscripción.');
  return { load, protect, persist };
}

function assertLifecycle(lifecycle) {
  if (!lifecycle || !['paid', 'demo', 'legacy', 'invalid'].includes(lifecycle.policy) ||
      !['ACTIVE', 'GRACE', 'RECOVERY', 'CLOSED'].includes(lifecycle.state))
    fail(409, 'Estado de suscripción inválido: requiere revisión antes de purgar.');
}

async function loadLifecycle(db, id, now, helpers) {
  const lifecycle = await helpers.load(db, id, now);
  assertLifecycle(lifecycle);
  return lifecycle;
}

async function store(db, id, job) {
  await db.query(`INSERT INTO clinic_settings(clinic_id,general) VALUES($1,jsonb_build_object('_purge',$2::jsonb))
    ON CONFLICT(clinic_id) DO UPDATE SET general=clinic_settings.general ||
      jsonb_build_object('_purge',$2::jsonb),updated_at=now()`, [id, JSON.stringify(job)]);
}

async function revokeClinicAccess(db, id) {
  await db.query(`DELETE FROM password_setup_tokens
    WHERE user_id IN (SELECT id FROM clinic_users WHERE clinic_id=$1)`, [id]);
  await db.query(`UPDATE admin_sessions SET is_active=false WHERE clinic_id=$1
    OR clinic_user_id IN (SELECT id FROM clinic_users WHERE clinic_id=$1)
    OR (clinic_user_id IS NULL AND username IN (SELECT username FROM clinic_users WHERE clinic_id=$1))`, [id]);
  const signing = await db.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='consent_forms' AND column_name='signing_token'`);
  if (signing.rows.length) await db.query(`UPDATE consent_forms SET signing_token=NULL
    WHERE clinic_id=$1 AND signing_status='pending' AND signing_token IS NOT NULL`, [id]);
}

async function releaseClinicIdentities(db, id, job, plan, now) {
  if (job.identifiersReleasedAt) return;
  const existing = (await db.query('SELECT released_at FROM clinic_identity_history WHERE clinic_id=$1', [id])).rows[0];
  if (existing) fail(409, 'Constancia de identidad inconsistente; requiere revisión técnica.');
  const clinic = (await db.query(`SELECT name,slug,email,phone,created_at,subscription_expires_at
    FROM clinics WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!clinic) fail(409, 'No se pudo capturar la identidad original.');
  const users = (await db.query(`SELECT id,clinic_id,username,email,phone,whatsapp_staff_phone,created_at
    FROM clinic_users WHERE clinic_id=$1 FOR UPDATE`, [id])).rows;
  const releasedAt = new Date(now).toISOString();
  await db.query(`INSERT INTO clinic_identity_history(clinic_id,released_at,clinic_aliases,user_aliases)
    VALUES($1,$2,$3::jsonb,$4::jsonb)`, [id, releasedAt, JSON.stringify(clinic), JSON.stringify(users)]);
  const phones = [...new Set([clinic.phone, ...users.flatMap(u => [u.phone, u.whatsapp_staff_phone])]
    .filter(Boolean).map(normalizeWaIdentityPhone))];
  // Do not change original phones or owners on historical WA rows. Retiring the
  // operational alias creates a fresh contact/state identity for a later claim.
  if (plan.wa.tables.length) {
    const contacts = (await db.query('SELECT id,phone,clinic_id,retired_at FROM whatsapp_contacts FOR UPDATE')).rows;
    const retire = contacts.filter(c => c.clinic_id === id || phones.includes(normalizeWaIdentityPhone(c.phone)));
    const states = (await db.query('SELECT id,phone,data FROM whatsapp_bot_state WHERE retired_at IS NULL FOR UPDATE')).rows;
    const declaresClinic = data => data && typeof data === 'object' && Object.entries(data).some(([key, value]) =>
      (['clinicId', 'clinic_id'].includes(key) && String(value).toLowerCase() === id) || declaresClinic(value));
    const statePhones = [...new Set([...phones, ...retire.map(c => normalizeWaIdentityPhone(c.phone)),
      ...states.filter(s => declaresClinic(s.data)).map(s => normalizeWaIdentityPhone(s.phone))])];
    const identityConflict = () => fail(409, 'Conflicto de atribución WhatsApp con otra clínica; requiere revisión asistida.');
    if (contacts.some(c => !c.retired_at && c.clinic_id && c.clinic_id !== id &&
        statePhones.includes(normalizeWaIdentityPhone(c.phone)))) identityConflict();
    const declaresOtherClinic = data => data && typeof data === 'object' && Object.entries(data).some(([key, value]) =>
      (['clinicId', 'clinic_id'].includes(key) && value != null && String(value).toLowerCase() !== id) ||
      declaresOtherClinic(value));
    if (states.some(s => !s.retired_at && statePhones.includes(normalizeWaIdentityPhone(s.phone)) &&
        declaresOtherClinic(s.data))) identityConflict();
    const links = (await db.query('SELECT code,target_url FROM wa_short_links WHERE retired_at IS NULL FOR UPDATE')).rows;
    for (const link of links) {
      const scoped = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{16,22}$/i.exec(link.code);
      if (link.retired_at || !scoped || scoped[1].toLowerCase() === id) continue;
      let target;
      try { target = new URL(link.target_url); } catch { continue; }
      if (target.hostname === 'wa.me' && statePhones.includes(normalizeWaIdentityPhone(target.pathname.slice(1))))
        identityConflict();
    }
    // Contacts may be the sole evidence for a number. Keep its release boundary
    // even after the SQL phase removes that contact, so delayed inbound events
    // cannot be attached to a later generation of the same phone.
    await db.query(`UPDATE clinic_identity_history SET clinic_aliases=jsonb_set(clinic_aliases,
      '{whatsapp_aliases}',$2::jsonb) WHERE clinic_id=$1`,
    [id, JSON.stringify(statePhones.map(phone => ({ phone })))]);
    await db.query(`UPDATE whatsapp_contacts SET retired_at=coalesce(retired_at,$2::timestamptz)
      WHERE id=ANY($1::bigint[])`, [retire.map(c => c.id), releasedAt]);
    await db.query(`UPDATE whatsapp_bot_state SET retired_at=$2 WHERE id=ANY($1::bigint[])`,
      [states.filter(s => statePhones.includes(normalizeWaIdentityPhone(s.phone))).map(s => s.id), releasedAt]);
    const retiredLinks = links.filter(link => {
      if (link.code.startsWith(`${id}.`)) return true;
      try {
        const url = new URL(link.target_url);
        return url.hostname === 'wa.me' && phones.includes(normalizeWaIdentityPhone(url.pathname.slice(1)));
      } catch { return false; }
    }).map(link => link.code);
    await db.query('UPDATE wa_short_links SET retired_at=$2 WHERE code=ANY($1::text[])', [retiredLinks, releasedAt]);
  }
  await revokeClinicAccess(db, id);
  for (const child of plan.authChildren)
    await db.query(`DELETE FROM "${child.table}" c WHERE ${child.scope}`, [id]);
  // Revocation must be complete at the release COMMIT, not at the later SQL phase.
  for (const table of ['clinic_oauth_tokens', 'invite_links', 'whatsapp_signup_attempts'])
    if (plan.order.includes(table)) await db.query(`DELETE FROM "${table}" WHERE clinic_id=$1`, [id]);
  if (plan.order.includes('user_whatsapp_channels'))
    await db.query(`UPDATE user_whatsapp_channels SET status='disconnected',token_encrypted=NULL,
      contacts_request_id=NULL,history_request_id=NULL,updated_at=now() WHERE clinic_id=$1`, [id]);
  await db.query(`UPDATE clinic_users SET username='!purged:' || id::text,email=NULL,
    phone=NULL,whatsapp_staff_phone=NULL,is_active=false,password_hash='',salt=NULL,hash_algo=NULL,
    full_name=NULL${plan.authClears.length ? `,${plan.authClears.join(',')}` : ''}
    WHERE clinic_id=$1`, [id]);
  await db.query(`UPDATE clinics SET name='Clínica eliminada ' || id::text,slug='!purged:' || id::text,
    email=NULL,phone=NULL,is_active=false WHERE id=$1`, [id]);
  job.identifiersReleasedAt = releasedAt;
  job.waScope = { contactIds: plan.wa.contactIds, stateIds: plan.wa.stateIds, linkCodes: plan.wa.linkCodes };
}

function foreignKeyJoin(attrs, fk, parentAlias) {
  if (![fk.child, fk.parent].every(table => /^[a-z_][a-z0-9_]*$/.test(table)))
    fail(409, 'Referencia global no verificable.');
  const name = (oid, num) => attrs.find(a => String(a.attrelid) === String(oid) && a.attnum === num)?.attname;
  return fk.child_columns.map((num, i) => {
    const child = name(fk.child_oid, num), parent = name(fk.parent_oid, fk.parent_columns[i]);
    if (!child || !parent || !/^[a-z_][a-z0-9_]*$/.test(child + parent))
      fail(409, 'Relación tenant no verificable.');
    return `c."${child}"=${parentAlias}."${parent}"`;
  }).join(' AND ');
}

async function schemaPlan(db, id) {
  const columns = (await db.query(`SELECT c.table_name,c.udt_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND c.column_name='clinic_id' AND t.table_type='BASE TABLE'`)).rows;
  const unsupported = columns.filter(row => !TABLES.has(row.table_name) && !RETAINED.has(row.table_name));
  if (unsupported.length || columns.some(row => row.udt_name !== 'uuid'))
    fail(409, 'Esquema tenant no cubierto: requiere revisión técnica antes de purgar.');
  const settingsColumns = (await db.query(`SELECT column_name,udt_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='clinic_settings'`)).rows;
  const settingsClears = [];
  // Legal receipts reference clinic_users with ON DELETE CASCADE. Keep inert
  // receipt identities, not authentication material or their dependent tokens.
  const authColumns = (await db.query(`SELECT column_name,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='clinic_users'`)).rows;
  // Authorized attribution evidence: inactive/tombstoned users must keep both
  // phones so a later clinic purge cannot turn a shared number into exclusive.
  // Authentication material is still scrubbed explicitly below or by authClears.
  const authKept = new Set(['id','clinic_id','username','role','full_name','email','password_hash','salt','hash_algo','created_at','is_active',
    'phone','whatsapp_staff_phone']);
  const authClears = [];
  for (const column of authColumns.filter(c => !authKept.has(c.column_name))) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column.column_name)) fail(409, 'Columna de autenticación no verificable.');
    authClears.push(`"${column.column_name}"=${column.is_nullable === 'YES' ? 'NULL' : 'DEFAULT'}`);
  }
  for (const column of settingsColumns.filter(c => !['clinic_id', 'general', 'updated_at'].includes(c.column_name))) {
    if (!['treatments', 'email', 'agenda', 'finanzas', 'inventario', 'notificaciones'].includes(column.column_name) ||
        column.udt_name !== 'jsonb') fail(409, 'Configuración tenant no cubierta: requiere revisión técnica.');
    settingsClears.push(`"${column.column_name}"='${column.column_name === 'treatments' ? '[]' : '{}'}'::jsonb`);
  }
  const wa = await whatsappPlan(db, id);
  const names = columns.filter(row => TABLES.has(row.table_name) && row.table_name !== 'whatsapp_contacts').map(row => row.table_name);
  const foreignKeys = (await db.query(`SELECT child.relname AS child,parent.relname AS parent,
    con.confdeltype AS delete_type,con.conkey AS child_columns,con.confkey AS parent_columns,
    con.conrelid AS child_oid,con.confrelid AS parent_oid
    FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_namespace ns ON ns.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=con.confrelid
    WHERE con.contype='f' AND ns.nspname='public'`)).rows;
  const order = orderPurgeTables(names, foreignKeys);
  let attributes;
  const joinFor = async fk => {
    if (!attributes) {
      const oids = [...new Set(foreignKeys.flatMap(key => [key.child_oid, key.parent_oid]))];
      attributes = (await db.query(`SELECT attrelid,attnum,attname FROM pg_attribute
        WHERE attrelid=ANY($1::oid[]) AND attnum>0 AND NOT attisdropped`, [oids])).rows;
    }
    return foreignKeyJoin(attributes, fk, 'p');
  };
  const authChildren = [];
  for (const fk of foreignKeys.filter(fk => fk.parent === 'clinic_users' && !names.includes(fk.child))) {
    if (fk.child === 'legal_acceptances') continue;
    if (fk.child === 'whatsapp_messages')
      fail(409, 'Dependencia de identidad no cubierta: requiere revisión antes de purgar.');
    // Non-cascading global references are not credential children. The scoped
    // existence check below blocks only actual references, without detaching them.
    if (fk.delete_type !== 'c') continue;
    if (!CASCADE_CHILDREN.has(fk.child))
      fail(409, 'Dependencia de identidad no cubierta: requiere revisión antes de purgar.');
    const join = await joinFor(fk);
    authChildren.push({ table: fk.child,
      scope: `EXISTS (SELECT 1 FROM clinic_users p WHERE p.clinic_id=$1 AND ${join})` });
  }
  const counts = {};
  const countQueries = [];
  const countQuery = (table, scope, alias = '') => {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) fail(409, 'Tabla tenant no verificable.');
    return `SELECT '${table}' AS table_name,count(*) AS count FROM "${table}"${alias} WHERE ${scope}`;
  };
  for (const child of authChildren) countQueries.push(countQuery(child.table, child.scope, ' c'));
  for (const table of order) {
    const scope = table === 'admin_sessions'
      ? 'clinic_id=$1 OR clinic_user_id IN (SELECT id FROM clinic_users WHERE clinic_id=$1)'
      : 'clinic_id=$1';
    countQueries.push(countQuery(table, scope));
  }
  // One round trip for counts only; preserve each scope and the transaction budget.
  if (countQueries.length)
    for (const row of (await db.query(countQueries.join('\nUNION ALL\n'), [id])).rows)
      counts[row.table_name] = Number(row.count);
  counts.whatsapp_contacts = wa.contactIds.length;
  counts.whatsapp_bot_state = wa.statePhones.length;
  counts.wa_short_links = wa.linkCodes.length;
  counts.whatsapp_messages = wa.messageCount;
  if (Object.values(counts).reduce((a, b) => a + b, 0) > 50000)
    fail(409, 'Más de 50.000 filas: requiere purga asistida; no se han borrado objetos.');
  // A cascading FK must never remove rows belonging to another tenant.
  const referenceChecks = [];
  const referenceReasons = [];
  const addReferenceCheck = (query, reason) => {
    referenceChecks.push(`SELECT ${referenceReasons.length} AS check_id WHERE EXISTS (${query})`);
    referenceReasons.push(reason);
  };
  for (const fk of foreignKeys.filter(fk => names.includes(fk.parent) && names.includes(fk.child))) {
    const join = await joinFor(fk);
    addReferenceCheck(`SELECT 1 FROM "${fk.child}" c JOIN "${fk.parent}" p
      ON ${join} WHERE p.clinic_id=$1 AND c.clinic_id IS DISTINCT FROM $1::uuid LIMIT 1`,
    'Referencias entre clínicas: requiere revisión técnica.');
  }
  for (const fk of foreignKeys.filter(fk =>
    (names.includes(fk.parent) || fk.parent === 'clinic_users') && !names.includes(fk.child))) {
    // Legal receipt identities are intentionally retained; their existing
    // references are not global attribution records to detach or remove.
    if (fk.parent === 'clinic_users' && fk.child === 'legal_acceptances') continue;
    if (fk.delete_type === 'c') {
      if (!CASCADE_CHILDREN.has(fk.child)) fail(409, 'Cascada no cubierta: requiere revisión técnica antes de borrar objetos.');
      continue;
    }
    // Do not erase or detach global attribution/registration records through a tenant FK.
    if (!/^[a-z_][a-z0-9_]*$/.test(fk.child)) fail(409, 'Referencia global no verificable.');
    const join = await joinFor(fk);
    addReferenceCheck(`SELECT 1 FROM "${fk.child}" c JOIN "${fk.parent}" p ON ${join}
      WHERE p.clinic_id=$1 LIMIT 1`,
    'Existen atribuciones globales a datos de esta clínica. Requiere purga asistida antes de borrar objetos.');
  }
  if (referenceChecks.length) {
    const references = (await db.query(referenceChecks.join('\nUNION ALL\n'), [id])).rows;
    if (references.length) {
      const index = Math.min(...references.map(row => Number(row.check_id)));
      fail(409, referenceReasons[index] || 'Referencias tenant no verificables.');
    }
  }
  return { order, counts, settingsClears, authClears, authChildren, wa };
}

async function requireAnnualDeliveryClosed(db, id, deadline, now, helpers) {
  const protection = await helpers.protect(db, id, deadline, now);
  if (!protection || typeof protection.protected !== 'boolean')
    fail(409, 'No se pudo verificar la protección de respaldos anuales.');
  if (protection.protected)
    fail(409, protection.reason || `La purga está protegida hasta ${protection.until || 'resolver la entrega anual'}.`);
}

function response(clinic, job, counts = {}, reasons = [], whatsapp = job?.whatsapp, lifecycle = null, now = Date.now()) {
  const publicJob = job ? { ...job } : null;
  if (publicJob) delete publicJob.waScope;
  const retentionDays = (job?.retentionSnapshot?.policy || lifecycle?.policy) === 'paid' ? 45 : 30;
  const expiresAt = lifecycle?.expires_at ?? clinic.subscription_expires_at;
  const retentionSnapshot = job?.retentionSnapshot || {
    capturedAt: new Date(now).toISOString(), policy: lifecycle?.policy || 'legacy',
    policyVersion: lifecycle?.policyVersion || null, expiresAt,
    graceEndsAt: lifecycle?.grace_ends_at || null, recoveryEndsAt: lifecycle?.recovery_ends_at || null,
    retentionDays, eligibleAt: Number.isFinite(Date.parse(expiresAt))
      ? new Date(Date.parse(expiresAt) + retentionDays * 86400000).toISOString() : null,
    backupRetentionUntil: job?.backupRetentionUntil || null,
  };
  return {
    success: true, clinic, purge: job ? publicJob : null, counts, whatsapp, eligible: !reasons.length, reasons,
    manualLegacyAuthorizationRequired: (lifecycle?.policy || retentionSnapshot.policy) === 'legacy',
    identifiersReleasedAt: job?.identifiersReleasedAt || null, retentionSnapshot,
    requiredConfirmation: clinic.slug, complete: job?.state === 'COMPLETE',
    retainedBackups: { prefix: `backups/${clinic.id}/`, immutableDays: 30, retentionDays: 35,
      note: 'Los respaldos cifrados se borran solo tras vencer su inmutabilidad; WAITING_STORAGE conserva pendientes y no equivale a purga completa.' },
  };
}

export async function clinicPurgePreview(value, pool = getPool(), deps = {}) {
  const id = purgeClinicId(value);
  const helpers = await lifecycleHelpers(deps);
  const now = cronClock(deps.now ?? Date.now)();
  return transaction(pool, async db => {
    const { clinic, purge } = await loadClinic(db, id);
    const lifecycle = await loadLifecycle(db, id, now, helpers);
    const { counts, wa } = await schemaPlan(db, id);
    const reasons = purgeReasons(clinic, now, lifecycle, { manual: true });
    if (purge && !purge.identifiersReleasedAt)
      reasons.push('Purga anterior a la migración de identidades: requiere revisión asistida; no se liberan identificadores ni se reanudan lotes.');
    try { await requireAnnualDeliveryClosed(db, id, lifecycle.recovery_ends_at, now, helpers); }
    catch (error) { if (error.status !== 409) throw error; reasons.push(error.message); }
    return response(clinic, purge, counts, reasons, wa.summary, lifecycle, now);
  });
}

export async function updateClinicState(body, pool = getPool()) {
  const id = purgeClinicId(body.id);
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean')
    fail(400, 'is_active debe ser booleano.');
  return transaction(pool, async db => {
    await reserveIdentities(db);
    await reserveClinicLifecycle(db, id);
    const { purge } = await loadClinic(db, id, true);
    if (purge) fail(409, 'La clínica tiene una purga irreversible registrada y no puede modificarse ni reactivarse.');
    await assertClinicAliases(db, { ...body, id });
    const updated = (await db.query(`UPDATE clinics SET name=coalesce($2,name),email=coalesce($3,email),
      phone=coalesce($4,phone),address=coalesce($5,address),is_active=coalesce($6,is_active)
      WHERE id=$1 RETURNING *`, [id, body.name ?? null, body.email ?? null, body.phone ?? null,
      body.address ?? null, body.is_active ?? null])).rows[0];
    if (body.is_active === false) await revokeClinicAccess(db, id);
    return updated;
  });
}

async function executePurgeBatch({ id, clinic, job, token, pool, now, helpers, list, remove, budgetDeadline = Infinity }) {
  const deadline = Math.min(now() + 15000, budgetDeadline);
  const storageSignal = () => AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now())));
  try {
    if (job.phase === 'BACKUPS' && now() < deadline) {
      const prefix = purgePrefixes(id)[Object.keys(PREFIXES).indexOf('BACKUPS')];
      const page = await list(prefix, 100, { abortSignal: storageSignal() });
      if (!Array.isArray(page.objects) || page.objects.length > 100 || (page.truncated && !page.objects.length))
        fail(502, 'Listado de respaldos incompleto o fuera de límite.');
      if (page.objects.some(obj => !isPurgeKey(obj.key, id, 'BACKUPS')))
        fail(409, 'Objeto de respaldo fuera del formato permitido: requiere revisión técnica.');
      if (page.objects.length || page.truncated) {
        const fallback = Date.parse(job.backupRetentionUntil) + QUIESCE_MS;
        const locked = page.objects.filter(obj => {
          const modified = obj.lastModified == null ? NaN : new Date(obj.lastModified).getTime();
          return (Number.isFinite(modified) ? modified + BACKUP_RETENTION_MS : fallback) > now();
        });
        const retentionUntil = locked.length ? Math.max(...locked.map(obj => {
          const modified = obj.lastModified == null ? NaN : new Date(obj.lastModified).getTime();
          return Number.isFinite(modified) ? modified + BACKUP_RETENTION_MS : fallback;
        })) : fallback;
        if (!Number.isFinite(retentionUntil)) fail(409, 'No se pudo validar el vencimiento de inmutabilidad de los respaldos.');
        if (locked.length) {
          Object.assign(job, {
            state: 'WAITING_STORAGE',
            retryAfter: new Date(Math.min(now() + STORAGE_RETRY_MS, retentionUntil)).toISOString(),
            waitingStorage: { checkedAt: new Date(now()).toISOString(), pendingObjects: page.objects.length,
              morePending: page.truncated, until: new Date(retentionUntil).toISOString() },
            leaseToken: null, leaseUntil: null,
          });
          await transaction(pool, async db => {
            const current = await loadClinic(db, id, true);
            if (current.purge?.leaseToken !== token) fail(409, 'La reserva de purga ya no está vigente.');
            await store(db, id, job);
          });
          return response(clinic, job);
        }
        for (const obj of page.objects) {
          if (now() >= deadline) break;
          await remove(obj.key, { abortSignal: storageSignal() });
          job.deletedObjects++;
        }
      }
      // A fresh empty listing, not a delete acknowledgement, permits SQL cleanup.
      if (!page.objects.length && !page.truncated) job.phase = 'SQL';
      job.waitingStorage = null;
    } else if (job.phase !== 'SQL' && now() < deadline) {
      const prefix = purgePrefixes(id)[Object.keys(PREFIXES).indexOf(job.phase)];
      const page = await list(prefix, 100, { abortSignal: storageSignal() });
      if (!Array.isArray(page.objects) || page.objects.length > 100 || (page.truncated && !page.objects.length))
        fail(502, 'Listado de almacenamiento incompleto o fuera de límite.');
      if (page.objects.some(obj => !isPurgeKey(obj.key, id, job.phase)))
        fail(409, 'Objeto fuera del formato permitido: requiere revisión técnica.');
      for (const obj of page.objects) {
        if (now() >= deadline) break;
        await remove(obj.key, { abortSignal: storageSignal() });
        job.deletedObjects++;
      }
      if (!page.objects.length) job.phase = PHASES[PHASES.indexOf(job.phase) + 1];
    }
    if (job.phase === 'SQL' && now() < deadline) {
      await transaction(pool, async db => {
        await reserveClinicLifecycle(db, id);
        const current = await loadClinic(db, id, true);
        if (current.purge?.leaseToken !== token || current.clinic.is_active !== false)
          fail(409, 'La reserva de purga ya no está vigente.');
        const lifecycle = await loadLifecycle(db, id, now(), helpers);
        const reasons = purgeReasons(current.clinic, now(), lifecycle, { manual: current.purge?.mode !== 'AUTOMATIC' });
        if (lifecycle.policy === 'legacy' && current.purge?.legacyAuthorizationConfirmed !== true)
          fail(409, 'Falta autorización manual explícita para la purga legacy.');
        if (reasons.length) fail(409, reasons.join(' '));
        await requireAnnualDeliveryClosed(db, id, lifecycle.recovery_ends_at, now(), helpers);
        let plan = await schemaPlan(db, id);
        const lockedTables = [...new Set([...plan.order, ...plan.authChildren.map(child => child.table), ...plan.wa.tables,
          'clinic_users','subscriptions'])];
        if (lockedTables.length) await db.query(`LOCK TABLE ${lockedTables.map(t => `"${t}"`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
        plan = await schemaPlan(db, id);
        job.whatsapp = plan.wa.summary;
        if (plan.wa.tables.length) {
          const scope = job.waScope;
          if (!scope) fail(409, 'Falta el alcance histórico inmutable de WhatsApp.');
          const contacts = plan.wa.contactIds.filter(key => scope.contactIds.includes(key));
          const states = plan.wa.stateIds.filter(key => scope.stateIds.includes(key));
          const links = plan.wa.linkCodes.filter(key => scope.linkCodes.includes(key));
          await db.query('DELETE FROM whatsapp_messages WHERE contact_id=ANY($1::bigint[])', [contacts]);
          await db.query('DELETE FROM whatsapp_contacts WHERE clinic_id=$1 AND id=ANY($2::bigint[])', [id, contacts]);
          await db.query('DELETE FROM whatsapp_bot_state WHERE id=ANY($1::bigint[]) AND retired_at IS NOT NULL', [states]);
          await db.query('DELETE FROM wa_short_links WHERE code=ANY($1::text[]) AND retired_at IS NOT NULL', [links]);
          const left = await whatsappPlan(db, id);
          if (left.contactIds.length || left.statePhones.length || left.linkCodes.length)
            fail(409, 'Quedan datos WhatsApp tenant; la transacción ha sido cancelada.');
          job.whatsapp = left.summary;
        }
        const receipts = (await db.query('SELECT id,payphone_response FROM subscriptions WHERE clinic_id=$1 FOR UPDATE', [id])).rows;
        for (const receipt of receipts)
          await db.query('UPDATE subscriptions SET payphone_response=$2::jsonb WHERE id=$1 AND clinic_id=$3',
            [receipt.id, JSON.stringify(minimalSubscriptionReceipt(receipt.payphone_response)), id]);
        for (const child of plan.authChildren)
          await db.query(`DELETE FROM "${child.table}" c WHERE ${child.scope}`, [id]);
        if (plan.order.includes('admin_sessions')) await db.query(`DELETE FROM "admin_sessions"
          WHERE clinic_id=$1 OR clinic_user_id IN (SELECT id FROM clinic_users WHERE clinic_id=$1)`, [id]);
        for (const table of plan.order) await db.query(`DELETE FROM "${table}" WHERE clinic_id=$1`, [id]);
        await db.query(`UPDATE clinic_users SET is_active=false,
          password_hash='',salt=NULL,
          ${plan.authClears.length ? `${plan.authClears.join(',')},` : ''}
          hash_algo=NULL WHERE clinic_id=$1`, [id]);
        for (const child of plan.authChildren)
          if ((await db.query(`SELECT 1 FROM "${child.table}" c WHERE ${child.scope} LIMIT 1`, [id])).rows.length)
            fail(409, 'Quedan credenciales tenant; la transacción ha sido cancelada.');
        for (const table of plan.order) {
          if ((await db.query(`SELECT 1 FROM "${table}" WHERE clinic_id=$1 LIMIT 1`, [id])).rows.length)
            fail(409, 'Quedan filas tenant; la transacción ha sido cancelada.');
        }
        Object.assign(job, { state: 'COMPLETE', phase: 'COMPLETE', completedAt: new Date(now()).toISOString(),
          leaseToken: null, leaseUntil: null, waitingStorage: null });
        await db.query(`UPDATE clinic_settings SET general=jsonb_build_object('_purge',$2::jsonb,'_subscription_lifecycle',$3::jsonb) ||
          CASE WHEN general ? '_subscription_policy' THEN jsonb_build_object('_subscription_policy',general->'_subscription_policy')
          ELSE '{}'::jsonb END,
          ${plan.settingsClears.length ? `${plan.settingsClears.join(',')},` : ''}
          updated_at=now() WHERE clinic_id=$1`, [id, JSON.stringify(job), JSON.stringify(lifecycle)]);
      });
      return response(clinic, job);
    }
    await transaction(pool, async db => {
      const current = await loadClinic(db, id, true);
      if (current.purge?.leaseToken !== token) fail(409, 'La reserva de purga ya no está vigente.');
      Object.assign(job, { leaseToken: null, leaseUntil: null });
      await store(db, id, job);
    });
    return response(clinic, job);
  } catch (error) {
    console.error('[clinic-purge]', id, job.phase, error.code || error.status || error.name);
    await transaction(pool, async db => {
      const current = await loadClinic(db, id, true);
      if (current.purge?.leaseToken === token) {
        Object.assign(job, { state: 'FAILED', last_error: 'PURGE_BATCH_FAILED',
          ...(error.whatsapp ? { whatsapp: error.whatsapp } : {}) });
        await store(db, id, job);
      }
    });
    throw Object.assign(new Error('El lote de purga falló. La clínica permanece bloqueada; revisa el estado y reintenta después de la reserva.'),
      { status: error.status || 502, ...(error.whatsapp ? { whatsapp: error.whatsapp } : {}) });
  }
}

export async function purgeClinic(body, actor, deps = {}) {
  if (actor?.role !== 'master_admin') fail(403, 'Solo master_admin puede purgar una clínica.');
  const id = purgeClinicId(body.id);
  const pool = deps.pool || getPool();
  const now = deps.now || Date.now;
  const helpers = await lifecycleHelpers(deps);
  const list = deps.list || listR2ObjectPage;
  const remove = deps.remove || deleteR2Object;
  const token = crypto.randomUUID();
  const reserved = await transaction(pool, async db => {
    await reserveIdentities(db);
    await reserveClinicLifecycle(db, id);
    const { clinic, purge } = await loadClinic(db, id, true);
    if (purge && !purge.identifiersReleasedAt)
      fail(409, 'Purga anterior a la migración de identidades: requiere revisión asistida.');
    validatePurgeConfirmation(body, clinic);
    const lifecycle = await loadLifecycle(db, id, now(), helpers);
    const reasons = purgeReasons(clinic, now(), lifecycle, { manual: true });
    if (reasons.length) fail(409, reasons.join(' '));
    if (lifecycle.policy === 'legacy' && body.legacyAuthorizationConfirmed !== true && purge?.legacyAuthorizationConfirmed !== true)
      fail(400, 'Confirma la autorización manual explícita para la clínica legacy.');
    const plan = await schemaPlan(db, id);
    await requireAnnualDeliveryClosed(db, id, lifecycle.recovery_ends_at, now(), helpers);
    if (purge?.state === 'COMPLETE') return { clinic, job: purge, done: true };
    ensureBackupRetention(purge, now());
    if (purge?.leaseUntil && Date.parse(purge.leaseUntil) > now()) fail(409, 'Hay un lote en curso; espera antes de reintentar.');
    const job = purge || {
      mode: 'MANUAL', state: 'QUIESCING', phase: 'PHOTOS', requestedAt: new Date(now()).toISOString(),
      retryAfter: new Date(now() + QUIESCE_MS).toISOString(), actorId: actor.id,
      actorUsername: actor.username, reason: body.reason.trim(),
      backupRetentionUntil: new Date(now() + BACKUP_RETENTION_MS).toISOString(),
      authorizationConfirmed: true, retentionConfirmed: true, deletedObjects: 0,
    };
    if (lifecycle.policy === 'legacy') job.legacyAuthorizationConfirmed = true;
    job.retentionSnapshot ||= response(clinic, null, {}, [], null, lifecycle, now()).retentionSnapshot;
    job.retentionSnapshot.backupRetentionUntil = job.backupRetentionUntil;
    await releaseClinicIdentities(db, id, job, plan, now());
    job.whatsapp = plan.wa.summary;
    await revokeClinicAccess(db, id);
    if (Date.parse(job.retryAfter) > now()) {
      await store(db, id, job);
      return { clinic, job, done: true };
    }
    Object.assign(job, { state: 'RUNNING', last_error: null, leaseToken: token,
      leaseUntil: new Date(now() + LEASE_MS).toISOString() });
    await store(db, id, job);
    return { clinic, job, done: false };
  });
  const { clinic, job } = reserved;
  if (reserved.done) return response(clinic, job);
  return executePurgeBatch({ id, clinic, job, token, pool, now, helpers, list, remove });
}

function cronClock(value) {
  if (typeof value === 'function') return value;
  if (Number.isFinite(value)) return () => value;
  fail(400, 'La fecha del lote automático es inválida.');
}

async function storePurgeSchedule(db, id, state, now, retryAt, reason = null, whatsapp) {
  const schedule = { state, attempted_at: new Date(now).toISOString(),
    retry_at: new Date(retryAt).toISOString(), reason, ...(whatsapp ? { whatsapp } : {}) };
  // Existing reserved contractual metadata cannot be edited through general
  // settings. Keep scheduling here without changing enrollment or acceptance.
  await db.query(`INSERT INTO clinic_settings(clinic_id,general)
    VALUES($1,jsonb_build_object('_subscription_policy',jsonb_build_object('purge_schedule',$2::jsonb)))
    ON CONFLICT(clinic_id) DO UPDATE SET general=jsonb_set(clinic_settings.general,'{_subscription_policy}',
      coalesce(clinic_settings.general->'_subscription_policy','{}'::jsonb) ||
      jsonb_build_object('purge_schedule',$2::jsonb)),updated_at=now()`, [id, JSON.stringify(schedule)]);
}

async function reserveAutomaticPurge(id, { pool, now, helpers }) {
  const token = crypto.randomUUID();
  return transaction(pool, async db => {
    await reserveIdentities(db);
    await reserveClinicLifecycle(db, id);
    const { clinic, purge } = await loadClinic(db, id, true);
    const result = await (async () => {
    if (purge && !purge.identifiersReleasedAt) return { type: 'skipped', reason: 'IDENTITY_MIGRATION_REVIEW_REQUIRED' };
    const manual = purge?.mode === 'MANUAL';
    if (purge && purge.mode !== 'AUTOMATIC' && !manual)
      return { type: 'skipped', reason: 'UNKNOWN_PURGE_MODE' };
    if (manual && (purge.authorizationConfirmed !== true || purge.retentionConfirmed !== true ||
        !purge.actorId || typeof purge.reason !== 'string' || purge.reason.trim().length < 10 ||
        !purge.waScope || !purge.retentionSnapshot))
      return { type: 'skipped', reason: 'MANUAL_AUTHORIZATION_INCOMPLETE' };
    if (purge?.state === 'COMPLETE') return { type: 'complete', job: purge };
    ensureBackupRetention(purge, now());
    const lifecycle = await loadLifecycle(db, id, now(), helpers);
    const recoveryEnds = Date.parse(lifecycle.recovery_ends_at);
    if (!manual && (lifecycle.policy !== 'paid' || lifecycle.auto_purge_eligible !== true || lifecycle.state !== 'CLOSED' ||
        !Number.isFinite(recoveryEnds) || recoveryEnds > now()))
      return { type: 'skipped', reason: 'NOT_PAID_CLOSED' };
    if (manual && lifecycle.policy === 'legacy' && purge.legacyAuthorizationConfirmed !== true)
      return { type: 'skipped', reason: 'LEGACY_AUTHORIZATION_REQUIRED' };
    const reasons = purgeReasons(manual ? clinic : { ...clinic, is_active: false }, now(), lifecycle, { manual });
    if (reasons.length) return { type: 'skipped', reason: 'CLOSURE_TIMESTAMP_INVALID' };
    const protection = await helpers.protect(db, id, lifecycle.recovery_ends_at, now());
    if (!protection || typeof protection.protected !== 'boolean')
      fail(409, 'No se pudo verificar la protección de respaldos anuales.');
    if (protection.protected) {
      await helpers.persist(db, id, { ...lifecycle, purge_wait: {
        state: 'WAITING_ANNUAL', until: protection.until || null, reason: protection.reason || 'ANNUAL_DELIVERY_PENDING',
      } });
      return { type: 'waitingAnnual', until: protection.until || null, reason: protection.reason || 'ANNUAL_DELIVERY_PENDING' };
    }
    const plan = await schemaPlan(db, id);
    if (purge) purge.whatsapp = plan.wa.summary;
    if (purge?.leaseUntil && Date.parse(purge.leaseUntil) > now())
      return { type: 'skipped', reason: 'ACTIVE_LEASE' };
    if (purge?.state === 'WAITING_STORAGE' && Date.parse(purge.retryAfter) > now())
      return { type: 'waitingStorage', job: purge };
    if (purge?.state === 'QUIESCING' && Date.parse(purge.retryAfter) > now())
      return { type: 'quiescing', job: purge };
    let job = purge;
    if (!job) {
      await helpers.persist(db, id, lifecycle);
      await db.query('UPDATE clinics SET is_active=false WHERE id=$1', [id]);
      await revokeClinicAccess(db, id);
      job = {
        mode: 'AUTOMATIC', state: 'QUIESCING', phase: 'PHOTOS',
        requestedAt: new Date(now()).toISOString(),
        retryAfter: new Date(now() + QUIESCE_MS).toISOString(),
        backupRetentionUntil: new Date(now() + BACKUP_RETENTION_MS).toISOString(),
        deletedObjects: 0, reason: 'PAID_SUBSCRIPTION_CLOSED',
        whatsapp: plan.wa.summary,
      };
      job.retentionSnapshot = response(clinic, null, {}, [], null, lifecycle, now()).retentionSnapshot;
      job.retentionSnapshot.backupRetentionUntil = job.backupRetentionUntil;
      await releaseClinicIdentities(db, id, job, plan, now());
      await store(db, id, job);
      return { type: 'quiescing', job };
    }
    Object.assign(job, { state: 'RUNNING', last_error: null, leaseToken: token,
      leaseUntil: new Date(now() + LEASE_MS).toISOString() });
    await store(db, id, job);
    return { type: 'run', clinic, job, token };
    })();
    const retry = result.type === 'waitingAnnual'
      ? Math.min(Date.parse(result.until) || now() + STORAGE_RETRY_MS, now() + STORAGE_RETRY_MS)
      : result.job?.retryAfter && ['quiescing','waitingStorage'].includes(result.type)
        ? Date.parse(result.job.retryAfter)
        : result.reason === 'ACTIVE_LEASE' ? Date.parse(purge.leaseUntil) : now() + LEASE_MS;
    const scheduledState = { waitingAnnual: 'WAITING_ANNUAL', waitingStorage: 'WAITING_STORAGE',
      quiescing: 'QUIESCING', run: 'RUNNING' }[result.type] || result.type.toUpperCase();
    await storePurgeSchedule(db, id, scheduledState, now(), Math.max(now() + 1, retry), result.reason, result.job?.whatsapp);
    result.retryAt = new Date(Math.max(now() + 1, retry)).toISOString();
    return result;
  });
}

export async function purgeExpiredClinics({
  pool = getPool(), now = Date.now, budgetMs = CRON_BUDGET_MS, clinicId, ...deps
} = {}) {
  const clock = cronClock(now);
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > QUIESCE_MS)
    fail(400, 'El presupuesto del lote automático debe estar entre 1 ms y 25 minutos.');
  const helpers = await lifecycleHelpers(deps);
  const startedAt = clock();
  const deadline = startedAt + budgetMs;
  const cutoff = new Date(startedAt).toISOString();
  if (clinicId !== undefined) clinicId = purgeClinicId(clinicId);
  const candidates = await transaction(pool, async db => (await db.query(`SELECT c.id FROM clinics c
    LEFT JOIN clinic_settings cs ON cs.clinic_id=c.id
    WHERE c.subscription_expires_at <= $1::timestamptz
      AND ($3::uuid IS NULL OR c.id=$3::uuid)
      AND ((cs.general #>> '{_purge,mode}'='MANUAL'
          AND cs.general #>> '{_purge,authorizationConfirmed}'='true'
          AND cs.general #>> '{_purge,retentionConfirmed}'='true'
          AND cs.general #>> '{_purge,identifiersReleasedAt}' IS NOT NULL)
        OR (c.subscription_expires_at <= $1::timestamptz-interval '45 days'
          AND coalesce(cs.general #>> '{_subscription_policy,kind}','') NOT IN ('demo','legacy')
          AND cs.general #>> '{_subscription_policy,policy_version}'=$4
          AND cs.general #>> '{_subscription_policy,opt_in}'='true'
          AND cs.general #>> '{_subscription_policy,acceptance_confirmed}'='true'
          AND EXISTS
            (SELECT 1 FROM subscriptions s WHERE s.clinic_id=c.id AND s.status IN ('paid','registered')
              AND s.paid_at IS NOT NULL AND s.amount_cents>0
              AND coalesce(s.plan_name,'') !~* '(trial|demo|prueba)')))
      AND (cs.general IS NULL OR NOT (cs.general ? '_purge')
        OR cs.general #>> '{_purge,mode}' IN ('AUTOMATIC','MANUAL'))
      AND coalesce(cs.general #>> '{_purge,state}','') <> 'COMPLETE'
      AND ($3::uuid IS NOT NULL OR coalesce(cs.general #>> '{_subscription_policy,purge_schedule,retry_at}','') <= $1::text)
    ORDER BY coalesce(cs.general #>> '{_subscription_policy,purge_schedule,attempted_at}','') ASC,
      c.subscription_expires_at ASC,c.id ASC LIMIT $2`, [cutoff, CRON_BATCH_SIZE, clinicId || null, SUBSCRIPTION_POLICY_VERSION])).rows.map(row => row.id));
  const report = { scanned: candidates.length, started: 0, completed: 0, waiting: 0,
    skipped: 0, failed: 0, budgetExhausted: false, results: [] };
  const deferred = await transaction(pool, async db => (await db.query(`SELECT count(*)::int AS deferred,
    min(cs.general #>> '{_subscription_policy,purge_schedule,retry_at}') AS next_retry_at
    FROM clinic_settings cs JOIN clinics c ON c.id=cs.clinic_id
    WHERE ($2::uuid IS NULL OR c.id=$2::uuid)
      AND ((cs.general #>> '{_purge,mode}'='MANUAL'
          AND cs.general #>> '{_purge,authorizationConfirmed}'='true'
          AND cs.general #>> '{_purge,retentionConfirmed}'='true'
          AND cs.general #>> '{_purge,identifiersReleasedAt}' IS NOT NULL)
        OR (cs.general #>> '{_subscription_policy,policy_version}'=$3
      AND cs.general #>> '{_subscription_policy,opt_in}'='true'
      AND cs.general #>> '{_subscription_policy,acceptance_confirmed}'='true'))
      AND cs.general #>> '{_subscription_policy,purge_schedule,retry_at}'> $1::text
      AND coalesce(cs.general #>> '{_purge,state}','') <> 'COMPLETE'`,
  [cutoff, clinicId || null, SUBSCRIPTION_POLICY_VERSION])).rows[0] || {});
  report.deferred = Number(deferred.deferred || 0);
  report.nextRetryAt = deferred.next_retry_at || null;
  const list = deps.list || listR2ObjectPage;
  const remove = deps.remove || deleteR2Object;
  for (const rawId of candidates) {
    if (clock() >= deadline) { report.budgetExhausted = true; break; }
    let id;
    try {
      id = purgeClinicId(rawId);
      const reservation = await reserveAutomaticPurge(id, { pool, now: clock, helpers });
      if (reservation.type === 'complete') {
        report.completed++;
        report.results.push({ id, state: 'COMPLETE', whatsapp: reservation.job.whatsapp });
      } else if (reservation.type === 'waitingAnnual') {
        report.waiting++;
        report.results.push({ id, state: 'WAITING_ANNUAL', until: reservation.until, reason: reservation.reason,
          retryAfter: reservation.retryAt });
      } else if (reservation.type === 'waitingStorage' || reservation.type === 'quiescing') {
        report.waiting++;
        report.results.push({ id, state: reservation.job.state, retryAfter: reservation.job.retryAfter,
          whatsapp: reservation.job.whatsapp });
      } else if (reservation.type === 'skipped') {
        if (reservation.reason === 'ACTIVE_LEASE') report.waiting++;
        else report.skipped++;
        report.results.push({ id, state: 'SKIPPED', reason: reservation.reason, retryAfter: reservation.retryAt });
      } else {
        report.started++;
        const result = await executePurgeBatch({ id, clinic: reservation.clinic, job: reservation.job,
          token: reservation.token, pool, now: clock, helpers, list, remove, budgetDeadline: deadline });
        const complete = result.complete;
        if (complete) report.completed++;
        else report.waiting++;
        report.results.push({ id, state: result.purge.state, phase: result.purge.phase,
          whatsapp: result.whatsapp,
          retryAfter: complete ? null : result.purge.state === 'WAITING_STORAGE'
            ? result.purge.retryAfter : reservation.retryAt, complete });
      }
    } catch (error) {
      report.failed++;
      const state = error.status === 409 ? 'BLOCKED' : 'FAILED';
      try {
        if (id) await transaction(pool, async db => {
          await reserveClinicLifecycle(db, id);
          await loadClinic(db, id, true);
          await storePurgeSchedule(db, id, state, clock(), clock() + (state === 'BLOCKED' ? STORAGE_RETRY_MS : LEASE_MS),
            state === 'BLOCKED' ? 'ASSISTED_REVIEW_REQUIRED' : 'PURGE_ATTEMPT_FAILED', error.whatsapp);
        });
      } catch { /* A contended lock must not be bypassed merely to persist a retry. */ }
      report.results.push({ id: id || String(rawId), state,
        ...(error.whatsapp ? { whatsapp: error.whatsapp } : {}),
        status: error.status || 500,
        message: error.status ? error.message : 'No se pudo procesar la clínica; revisa el registro operativo.' });
    }
  }
  if (!report.budgetExhausted && clock() >= deadline && report.results.length < candidates.length)
    report.budgetExhausted = true;
  report.candidateLimit = CRON_BATCH_SIZE;
  report.possiblyMore = candidates.length === CRON_BATCH_SIZE;
  report.unprocessed = candidates.slice(report.results.length);
  report.nextRetryAt = [report.nextRetryAt, ...report.results.map(result => result.retryAfter)]
    .filter(Boolean).sort()[0] || null;
  report.complete = !report.budgetExhausted && !report.possiblyMore && report.deferred === 0 && report.waiting === 0 && report.failed === 0;
  report.needsRetry = !report.complete;
  return report;
}
