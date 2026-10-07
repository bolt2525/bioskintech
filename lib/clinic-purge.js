import crypto from 'node:crypto';
import { getPool } from './neon-clinical-db.js';
import { deleteR2Object, listR2ObjectPage } from './r2-service.js';
import { reserveClinicLifecycle } from './clinic-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_MS = 300000;
const QUIESCE_MS = 25 * 60000;
const PHASES = ['PHOTOS', 'TEMP', 'ANNUAL', 'SQL', 'COMPLETE'];
const TABLES = new Set([
  'patients', 'clinical_records', 'consultations', 'consultation_history', 'consultation_info',
  'medical_history', 'physical_exams', 'diagnoses', 'treatments', 'treatment_packages',
  'prescriptions', 'injectables', 'consent_forms', 'medical_history_snapshots', 'inventory_items',
  'inventory_groups', 'inventory_batches', 'inventory_movements', 'financial_records',
  'financial_items', 'external_finance_records', 'sharing_groups', 'patient_audit_log',
  'clinical_photos', 'patient_assignments', 'sharing_group_members', 'professional_signatures',
  'prescription_templates', 'annual_photo_backup_periods', 'annual_photo_backup_requests',
  'annual_photo_backup_parts', 'annual_photo_backup_notifications', 'clinic_users',
  'admin_sessions', 'clinic_features', 'clinic_oauth_tokens', 'clinic_consent_templates',
  'clinic_notifications', 'clinic_staff_resources', 'invite_links', 'whatsapp_contacts',
  'legal_acceptances', 'ai_consultations',
]);
const RETAINED = new Set(['clinic_settings', 'subscriptions']);
const CASCADE_CHILDREN = new Set([
  'login_otp', 'trusted_devices', 'password_setup_tokens', 'oauth_states',
  'user_module_overrides', 'whatsapp_messages',
]);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function purgeClinicId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'Identificador de clínica inválido');
  return value.toLowerCase();
}

export function purgePrefixes(id) {
  id = purgeClinicId(id);
  return [`clinics/${id}/`, `backup-tmp/${id}/`, `annual-photo-backups/${id}/`];
}

export function isPurgeKey(key, id, phase) {
  const prefix = purgePrefixes(id)[PHASES.indexOf(phase)];
  if (!prefix || typeof key !== 'string' || !key.startsWith(prefix) ||
      key.includes('..') || /[\u0000-\u001f\\]/.test(key)) return false;
  return phase !== 'PHOTOS' || new RegExp(`^clinics/${id}/records/[1-9]\\d*/photos/[^/]+$`).test(key);
}

export function purgeReasons(clinic, now = Date.now()) {
  const reasons = [];
  if (clinic.is_active !== false) reasons.push('Desactiva la clínica antes de solicitar la purga.');
  const ended = Date.parse(clinic.subscription_expires_at);
  if (!Number.isFinite(ended) || ended + 30 * 86400000 > now)
    reasons.push('Se requiere fin de suscripción registrado y haber cumplido 30 días posteriores.');
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
  const settings = (await db.query('SELECT general FROM clinic_settings WHERE clinic_id=$1', [id])).rows[0];
  if (settings && (!settings.general || typeof settings.general !== 'object' || Array.isArray(settings.general)))
    fail(409, 'Configuración de clínica inválida: requiere revisión técnica.');
  const purge = settings?.general?._purge || null;
  if (purge && (typeof purge !== 'object' || Array.isArray(purge) ||
      !['QUIESCING', 'RUNNING', 'FAILED', 'COMPLETE'].includes(purge.state) ||
      !PHASES.includes(purge.phase) || !Number.isFinite(Date.parse(purge.retryAfter)) ||
      !Number.isSafeInteger(purge.deletedObjects) || purge.deletedObjects < 0 ||
      (purge.phase === 'COMPLETE') !== (purge.state === 'COMPLETE') ||
      (purge.leaseUntil && !Number.isFinite(Date.parse(purge.leaseUntil)))))
    fail(409, 'Constancia de purga inválida: requiere revisión técnica.');
  return { clinic, purge };
}

async function store(db, id, job) {
  await db.query(`INSERT INTO clinic_settings(clinic_id,general) VALUES($1,jsonb_build_object('_purge',$2::jsonb))
    ON CONFLICT(clinic_id) DO UPDATE SET general=clinic_settings.general ||
      jsonb_build_object('_purge',$2::jsonb),updated_at=now()`, [id, JSON.stringify(job)]);
}

async function revokeClinicAccess(db, id) {
  await db.query(`UPDATE admin_sessions SET is_active=false WHERE clinic_id=$1
    OR clinic_user_id IN (SELECT id FROM clinic_users WHERE clinic_id=$1)`, [id]);
  const signing = await db.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='consent_forms' AND column_name='signing_token'`);
  if (signing.rows.length) await db.query(`UPDATE consent_forms SET signing_token=NULL
    WHERE clinic_id=$1 AND signing_status='pending' AND signing_token IS NOT NULL`, [id]);
}

async function foreignKeyJoin(db, fk, parentAlias) {
  const attrs = (await db.query(`SELECT attrelid,attnum,attname FROM pg_attribute
    WHERE attrelid=ANY($1::oid[]) AND attnum>0 AND NOT attisdropped`,
  [[fk.child_oid, fk.parent_oid]])).rows;
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
  for (const column of settingsColumns.filter(c => !['clinic_id', 'general', 'updated_at'].includes(c.column_name))) {
    if (!['treatments', 'email', 'agenda', 'finanzas', 'inventario', 'notificaciones'].includes(column.column_name) ||
        column.udt_name !== 'jsonb') fail(409, 'Configuración tenant no cubierta: requiere revisión técnica.');
    settingsClears.push(`"${column.column_name}"='${column.column_name === 'treatments' ? '[]' : '{}'}'::jsonb`);
  }
  const names = columns.filter(row => TABLES.has(row.table_name)).map(row => row.table_name);
  const foreignKeys = (await db.query(`SELECT child.relname AS child,parent.relname AS parent,
    con.confdeltype AS delete_type,con.conkey AS child_columns,con.confkey AS parent_columns,
    con.conrelid AS child_oid,con.confrelid AS parent_oid
    FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_namespace ns ON ns.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=con.confrelid
    WHERE con.contype='f' AND ns.nspname='public'`)).rows;
  const order = orderPurgeTables(names, foreignKeys);
  const counts = {};
  for (const table of order) {
    const scope = table === 'admin_sessions'
      ? 'clinic_id=$1 OR clinic_user_id IN (SELECT id FROM clinic_users WHERE clinic_id=$1)'
      : 'clinic_id=$1';
    counts[table] = Number((await db.query(`SELECT count(*) AS count FROM "${table}" WHERE ${scope}`, [id])).rows[0].count);
  }
  if (Object.values(counts).reduce((a, b) => a + b, 0) > 50000)
    fail(409, 'Más de 50.000 filas: requiere purga asistida; no se han borrado objetos.');
  if (counts.whatsapp_contacts > 0)
    fail(409, 'La auditoría WhatsApp es global y requiere separación asistida antes de purgar esta clínica.');
  // A cascading FK must never remove rows belonging to another tenant.
  for (const fk of foreignKeys.filter(fk => names.includes(fk.parent) && names.includes(fk.child))) {
    const join = await foreignKeyJoin(db, fk, 'p');
    const crossed = await db.query(`SELECT 1 FROM "${fk.child}" c JOIN "${fk.parent}" p
      ON ${join} WHERE p.clinic_id=$1 AND c.clinic_id IS DISTINCT FROM $1::uuid LIMIT 1`, [id]);
    if (crossed.rows.length) fail(409, 'Referencias entre clínicas: requiere revisión técnica.');
  }
  for (const fk of foreignKeys.filter(fk => names.includes(fk.parent) && !names.includes(fk.child))) {
    if (fk.delete_type === 'c') {
      if (!CASCADE_CHILDREN.has(fk.child)) fail(409, 'Cascada no cubierta: requiere revisión técnica antes de borrar objetos.');
      continue;
    }
    // Do not erase or detach global attribution/registration records through a tenant FK.
    if (!/^[a-z_][a-z0-9_]*$/.test(fk.child)) fail(409, 'Referencia global no verificable.');
    const join = await foreignKeyJoin(db, fk, 'p');
    if ((await db.query(`SELECT 1 FROM "${fk.child}" c JOIN "${fk.parent}" p ON ${join}
      WHERE p.clinic_id=$1 LIMIT 1`, [id])).rows.length)
      fail(409, 'Existen atribuciones globales a datos de esta clínica. Requiere purga asistida antes de borrar objetos.');
  }
  return { order, counts, settingsClears };
}

async function requireAnnualDeliveryClosed(db, id) {
  if (!(await db.query("SELECT to_regclass('public.annual_photo_backup_requests') AS table_name")).rows[0]?.table_name) return;
  if ((await db.query(`SELECT 1 FROM annual_photo_backup_requests WHERE clinic_id=$1 AND (
    status='REQUESTED' OR (status='APPROVED' AND expired_at IS NULL)
    OR (status='READY' AND ready_at + interval '24 hours 10 minutes' > now())
    OR lease_expires_at > now() OR cleanup_lease_until > now()) LIMIT 1`, [id])).rows.length)
    fail(409, 'Existe una entrega anual pendiente, en curso o disponible. Resuélvela o espera su vencimiento antes de purgar.');
}

function response(clinic, job, counts = {}, reasons = []) {
  return {
    success: true, clinic, purge: job, counts, eligible: !reasons.length, reasons,
    requiredConfirmation: clinic.slug, complete: job?.state === 'COMPLETE',
    retainedBackups: { prefix: `backups/${clinic.id}/`, immutableDays: 30, retentionDays: 35,
      note: 'No se borran respaldos cifrados existentes ni se crea otro respaldo al purgar. Su retención depende del lifecycle R2.' },
  };
}

export async function clinicPurgePreview(value, pool = getPool()) {
  const id = purgeClinicId(value);
  return transaction(pool, async db => {
    const { clinic, purge } = await loadClinic(db, id);
    const { counts } = await schemaPlan(db, id);
    const reasons = purgeReasons(clinic);
    try { await requireAnnualDeliveryClosed(db, id); }
    catch (error) { if (error.status !== 409) throw error; reasons.push(error.message); }
    return response(clinic, purge, counts, reasons);
  });
}

export async function updateClinicState(body, pool = getPool()) {
  const id = purgeClinicId(body.id);
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean')
    fail(400, 'is_active debe ser booleano.');
  return transaction(pool, async db => {
    await reserveClinicLifecycle(db, id);
    const { purge } = await loadClinic(db, id, true);
    if (purge) fail(409, 'La clínica tiene una purga irreversible registrada y no puede modificarse ni reactivarse.');
    const updated = (await db.query(`UPDATE clinics SET name=coalesce($2,name),email=coalesce($3,email),
      phone=coalesce($4,phone),address=coalesce($5,address),is_active=coalesce($6,is_active)
      WHERE id=$1 RETURNING *`, [id, body.name ?? null, body.email ?? null, body.phone ?? null,
      body.address ?? null, body.is_active ?? null])).rows[0];
    if (body.is_active === false) await revokeClinicAccess(db, id);
    return updated;
  });
}

export async function purgeClinic(body, actor, deps = {}) {
  if (actor?.role !== 'master_admin') fail(403, 'Solo master_admin puede purgar una clínica.');
  const id = purgeClinicId(body.id);
  const pool = deps.pool || getPool();
  const now = deps.now || Date.now;
  const list = deps.list || listR2ObjectPage;
  const remove = deps.remove || deleteR2Object;
  const token = crypto.randomUUID();
  const reserved = await transaction(pool, async db => {
    await reserveClinicLifecycle(db, id);
    const { clinic, purge } = await loadClinic(db, id, true);
    validatePurgeConfirmation(body, clinic);
    const reasons = purgeReasons(clinic, now());
    if (reasons.length) fail(409, reasons.join(' '));
    await schemaPlan(db, id);
    await requireAnnualDeliveryClosed(db, id);
    if (purge?.state === 'COMPLETE') return { clinic, job: purge, done: true };
    if (purge?.leaseUntil && Date.parse(purge.leaseUntil) > now()) fail(409, 'Hay un lote en curso; espera antes de reintentar.');
    const job = purge || {
      state: 'QUIESCING', phase: 'PHOTOS', requestedAt: new Date(now()).toISOString(),
      retryAfter: new Date(now() + QUIESCE_MS).toISOString(), actorId: actor.id,
      actorUsername: actor.username, reason: body.reason.trim(),
      authorizationConfirmed: true, retentionConfirmed: true, deletedObjects: 0,
    };
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
  const deadline = now() + 15000;
  try {
    if (job.phase !== 'SQL') {
      const prefix = purgePrefixes(id)[PHASES.indexOf(job.phase)];
      const page = await list(prefix, 100, { abortSignal: AbortSignal.timeout(10000) });
      if (!Array.isArray(page.objects) || page.objects.length > 100 || (page.truncated && !page.objects.length))
        fail(502, 'Listado de almacenamiento incompleto o fuera de límite.');
      if (page.objects.some(obj => !isPurgeKey(obj.key, id, job.phase)))
        fail(409, 'Objeto fuera del formato permitido: requiere revisión técnica.');
      for (const obj of page.objects) {
        if (now() >= deadline) break;
        await remove(obj.key, { abortSignal: AbortSignal.timeout(10000) });
        job.deletedObjects++;
      }
      if (!page.objects.length) job.phase = PHASES[PHASES.indexOf(job.phase) + 1];
    }
    if (job.phase === 'SQL') {
      await transaction(pool, async db => {
        await reserveClinicLifecycle(db, id);
        const current = await loadClinic(db, id, true);
        if (current.purge?.leaseToken !== token || current.clinic.is_active !== false)
          fail(409, 'La reserva de purga ya no está vigente.');
        let plan = await schemaPlan(db, id);
        if (plan.order.length) await db.query(`LOCK TABLE ${plan.order.map(t => `"${t}"`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
        plan = await schemaPlan(db, id);
        if (plan.order.includes('admin_sessions')) await db.query(`DELETE FROM "admin_sessions"
          WHERE clinic_id=$1 OR clinic_user_id IN (SELECT id FROM clinic_users WHERE clinic_id=$1)`, [id]);
        for (const table of plan.order) await db.query(`DELETE FROM "${table}" WHERE clinic_id=$1`, [id]);
        for (const table of plan.order) {
          if ((await db.query(`SELECT 1 FROM "${table}" WHERE clinic_id=$1 LIMIT 1`, [id])).rows.length)
            fail(409, 'Quedan filas tenant; la transacción ha sido cancelada.');
        }
        Object.assign(job, { state: 'COMPLETE', phase: 'COMPLETE', completedAt: new Date(now()).toISOString(),
          leaseToken: null, leaseUntil: null });
        // Keep the identity, authorization and audit tombstone, not clinic settings containing personal data.
        await db.query(`UPDATE clinic_settings SET general=jsonb_build_object('_purge',$2::jsonb),
          ${plan.settingsClears.length ? `${plan.settingsClears.join(',')},` : ''}
          updated_at=now() WHERE clinic_id=$1`, [id, JSON.stringify(job)]);
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
        Object.assign(job, { state: 'FAILED', last_error: 'PURGE_BATCH_FAILED' });
        // Retain the lease after timeout: an external operation may still be completing.
        await store(db, id, job);
      }
    });
    throw Object.assign(new Error('El lote de purga falló. La clínica permanece bloqueada; revisa el estado y reintenta después de la reserva.'), { status: error.status || 502 });
  }
}
