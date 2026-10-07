import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { getPool, getAppPool, withTenantContext } from './neon-clinical-db.js';
import { authenticateRequest } from './admin-auth.js';
import { generateDownloadUrl, r2ObjectExists, putR2Object } from './r2-service.js';
import { collectClinicData } from './backup-service.js';
import { buildPortableDocuments } from './portable-clinical-export.js';

export const PHOTO_BACKUP_ACTIONS = new Set([
  'photoBackupStatus', 'requestPhotoBackup', 'listPhotoBackupRequests', 'setPhotoBackupPeriod',
  'approvePhotoBackup', 'rejectPhotoBackup', 'photoBackupDownload',
  'photoBackupWorkerClaim', 'photoBackupWorkerPart', 'photoBackupWorkerComplete', 'photoBackupWorkerFail',
  'photoBackupWorkerMaintenance',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_PART_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_BYTES = MAX_PART_BYTES - 64 * 1024 * 1024;
const LEASE_SECONDS = 1200;
const DOWNLOAD_WINDOW_MS = 86400000;
const MAX_DOWNLOAD_URL_SECONDS = 300;
// Must stay below the R2 lifecycle days on annual-photo-backups/ (7): sources older
// than this are treated as gone, so APPROVED jobs expire instead of retrying.
const SOURCE_RETRY_DAYS = 6;
// Longer than Vercel maxDuration (60 s): a hung R2 delete dies with the function
// before the reservation lapses, so it can never hit keys rewritten by a reopen.
const CLEANUP_LEASE_SECONDS = 300;
const R2_OP_TIMEOUT_MS = 10000;
const SOURCES_STALE = `coalesce(sources_uploaded_at,approved_at) <= now()-interval '${SOURCE_RETRY_DAYS} days'`;
const SAFE_REQUEST_FIELDS = `id,clinic_id,period_id,status,created_at,approved_at,ready_at,
  rejected_at,rejection_reason,snapshot_at,dispatch_status,last_error,heartbeat_at,lease_expires_at,expired_at`;

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function serviceSecret() {
  return process.env.ANNUAL_PHOTO_BACKUP_SECRET || process.env.ANNUAL_BACKUP_SERVICE_SECRET;
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'Identificador inválido');
  return value.toLowerCase();
}
function bodyObject(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 16 * 1024)
    fail(400, 'Cuerpo inválido');
  return body;
}
function requirePost(req) { if (req.method !== 'POST') fail(405, 'Requiere POST'); }
function email(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value) ? value : null;
}
function workerUrl() {
  try {
    const url = new URL(process.env.ANNUAL_PHOTO_BACKUP_WORKER_URL);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function publicStatus(row) {
  if (row.status === 'REQUESTED') return 'PENDING';
  if (row.status === 'READY' && Date.parse(row.ready_at) + 86400000 <= Date.now()) return 'EXPIRED';
  if (row.status === 'APPROVED' && row.expired_at) return 'EXPIRED';
  if (row.status === 'APPROVED' && row.last_error) return 'FAILED';
  if (row.status === 'APPROVED' && Date.parse(row.lease_expires_at) > Date.now()) return 'PROCESSING';
  return row.status;
}
async function listRequests(db, clinicId = null) {
  const columns = SAFE_REQUEST_FIELDS.split(',').map(column => `r.${column.trim()}`).join(',');
  const rows = (await db.query(`SELECT ${columns},p.photo_count,p.total_bytes,p.parts,
    EXISTS(SELECT 1 FROM annual_photo_backup_notifications n WHERE n.request_id=r.id AND n.clinic_id=r.clinic_id
      AND n.status='FAILED') AS notification_failed
    FROM annual_photo_backup_requests r LEFT JOIN LATERAL (
      SELECT coalesce(sum(photo_count),0)::integer AS photo_count,
        coalesce(sum(coalesce(size_bytes,source_bytes)),0)::bigint AS total_bytes,
        coalesce(jsonb_agg(jsonb_build_object('index',part_number-1,'size',size_bytes,'sha256',sha256,
          'status',CASE WHEN completed_at IS NULL THEN 'PENDING' ELSE 'READY' END) ORDER BY part_number),'[]'::jsonb) AS parts
      FROM annual_photo_backup_parts WHERE request_id=r.id AND clinic_id=r.clinic_id
    ) p ON true ${clinicId ? 'WHERE r.clinic_id=$1' : ''}
    ORDER BY r.created_at DESC LIMIT ${clinicId ? 24 : 100}`, clinicId ? [clinicId] : [])).rows;
  return rows.map(row => ({
    ...row, status: publicStatus(row), internal_status: row.status,
    total_bytes: Number(row.total_bytes), error_code: row.last_error,
    notification_error: row.notification_failed ? 'SMTP_FAILED' : null,
    expires_at: row.ready_at ? new Date(Date.parse(row.ready_at) + 86400000).toISOString() : null,
  }));
}
export function annualPhotoBackupConfigured() {
  return Boolean(process.env.ANNUAL_PHOTO_BACKUP_ENABLED === 'true' &&
    workerUrl() && Buffer.byteLength(serviceSecret() || '') >= 32 &&
    process.env.EMAIL_USER && process.env.EMAIL_PASS && email(process.env.ANNUAL_PHOTO_BACKUP_MASTER_EMAIL) &&
    process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}
export function verifyPhotoBackupServiceSecret(value, expected = serviceSecret()) {
  if (typeof expected !== 'string' || Buffer.byteLength(expected) < 32 || typeof value !== 'string' || value.length > 1024) return false;
  const received = crypto.createHash('sha256').update(value).digest();
  const wanted = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(received, wanted);
}

export function photoBackupExpectedKey(clinicId, requestId, partNumber) {
  uuid(clinicId); uuid(requestId);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 9999) fail(400, 'Parte inválida');
  return `annual-photo-backups/${clinicId}/${requestId}/part-${String(partNumber).padStart(4, '0')}.zip`;
}

/**
 * Existing photos have no persisted byte length. Reserve the upload maximum for
 * each unknown length; the worker MUST HEAD and reject images >20 MiB before ZIP.
 * This conservative bound keeps batches <=512 MiB without reading images in API.
 */
export function buildPhotoBackupParts(photos, clinicId, requestId) {
  uuid(clinicId); uuid(requestId);
  const parts = [];
  let current = { photos: [], sourceBytes: 0 };
  let metadataBytes = 0;
  for (const photo of photos) {
    const key = photo.r2_key;
    if (String(photo.clinic_id).toLowerCase() !== clinicId.toLowerCase() ||
        typeof key !== 'string' || !key.startsWith(`clinics/${clinicId}/records/${photo.record_id}/photos/`) ||
        key.includes('..') || /[\u0000-\u001f\\]/.test(key)) fail(409, 'Foto fuera del prefijo de la clínica');
    const persistedSize = photo.file_size ?? photo.size_bytes;
    const size = persistedSize == null ? MAX_PHOTO_BYTES : Number(persistedSize);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PHOTO_BYTES) fail(409, 'Tamaño de foto inválido');
    const manifestPhoto = {
      id: photo.id, record_id: photo.record_id, r2_key: photo.r2_key,
      file_size: persistedSize == null ? null : size,
      mime_type: typeof photo.mime_type === 'string' ? photo.mime_type : null,
    };
    const photoBytes = Buffer.byteLength(JSON.stringify(manifestPhoto));
    if (photoBytes > 1024 * 1024) fail(409, 'Metadatos de foto demasiado grandes');
    if (current.photos.length >= 200 || current.sourceBytes + size > MAX_SOURCE_BYTES || metadataBytes + photoBytes > 1024 * 1024) {
      parts.push(current); current = { photos: [], sourceBytes: 0 };
      metadataBytes = 0;
    }
    current.photos.push(manifestPhoto);
    current.sourceBytes += size;
    metadataBytes += photoBytes;
  }
  // Even an empty clinic receives a manifest/data ZIP.
  parts.push(current);
  return parts.map((part, index) => ({
    ...part, partNumber: index + 1, photoCount: part.photos.length,
    expectedKey: photoBackupExpectedKey(clinicId, requestId, index + 1),
  }));
}

// Schema creation is explicit deployment work, never run from an API request.
export async function createAnnualPhotoBackupSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS annual_photo_backup_periods (
      id UUID PRIMARY KEY, clinic_id UUID NOT NULL REFERENCES clinics(id),
      starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
      created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), consumed_at TIMESTAMPTZ,
      CHECK (ends_at = starts_at + interval '12 months'), UNIQUE(id,clinic_id)
    );
    CREATE TABLE IF NOT EXISTS annual_photo_backup_requests (
      id UUID PRIMARY KEY, clinic_id UUID NOT NULL REFERENCES clinics(id), period_id UUID NOT NULL,
      requested_by INTEGER NOT NULL, requester_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','REJECTED','READY')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), approved_at TIMESTAMPTZ, approved_by INTEGER,
      rejected_at TIMESTAMPTZ, rejection_reason TEXT, ready_at TIMESTAMPTZ,
      snapshot_at TIMESTAMPTZ, snapshot_data JSONB,
      lease_hash TEXT, lease_expires_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
      dispatch_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(dispatch_status IN ('PENDING','DISPATCHING','SENT','FAILED')),
      dispatch_at TIMESTAMPTZ, last_error TEXT,
      FOREIGN KEY(period_id,clinic_id) REFERENCES annual_photo_backup_periods(id,clinic_id),
      UNIQUE(id,clinic_id), UNIQUE(period_id)
    );
    CREATE TABLE IF NOT EXISTS annual_photo_backup_parts (
      request_id UUID NOT NULL, clinic_id UUID NOT NULL, part_number INTEGER NOT NULL CHECK(part_number > 0),
      expected_key TEXT NOT NULL, manifest JSONB NOT NULL, documents JSONB NOT NULL DEFAULT '[]'::jsonb, source_bytes BIGINT NOT NULL,
      photo_count INTEGER NOT NULL CHECK(photo_count BETWEEN 0 AND 200),
      r2_key TEXT, size_bytes BIGINT, sha256 TEXT, completed_at TIMESTAMPTZ,
      PRIMARY KEY(request_id,part_number),
      FOREIGN KEY(request_id,clinic_id) REFERENCES annual_photo_backup_requests(id,clinic_id),
      CHECK(source_bytes BETWEEN 0 AND 536870912), CHECK(r2_key IS NULL OR r2_key = expected_key)
    );
    CREATE TABLE IF NOT EXISTS annual_photo_backup_notifications (
      id UUID PRIMARY KEY, request_id UUID NOT NULL, clinic_id UUID NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('REQUESTED','READY','REJECTED')),
      recipient TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','SENT','FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0, claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, last_error TEXT,
      FOREIGN KEY(request_id,clinic_id) REFERENCES annual_photo_backup_requests(id,clinic_id),
      UNIQUE(request_id,kind)
    );
    CREATE INDEX IF NOT EXISTS annual_backup_period_clinic ON annual_photo_backup_periods(clinic_id,starts_at);
    CREATE INDEX IF NOT EXISTS annual_backup_request_clinic ON annual_photo_backup_requests(clinic_id,created_at DESC);
    ALTER TABLE annual_photo_backup_periods ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
    ALTER TABLE annual_photo_backup_parts ADD COLUMN IF NOT EXISTS documents JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS dispatch_token UUID;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS sources_uploaded_at TIMESTAMPTZ;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS snapshot_purged_at TIMESTAMPTZ;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS sources_deleted_at TIMESTAMPTZ;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS artifacts_deleted_at TIMESTAMPTZ;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS cleanup_error TEXT;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS cleanup_token UUID;
    ALTER TABLE annual_photo_backup_requests ADD COLUMN IF NOT EXISTS cleanup_lease_until TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS annual_backup_request_cleanup ON annual_photo_backup_requests(status,ready_at)
      WHERE sources_deleted_at IS NULL OR artifacts_deleted_at IS NULL;
    CREATE OR REPLACE FUNCTION annual_backup_period_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
        OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
        RAISE EXCEPTION 'Annual backup period identity and dates are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS annual_backup_period_immutable ON annual_photo_backup_periods;
    CREATE TRIGGER annual_backup_period_immutable BEFORE UPDATE ON annual_photo_backup_periods
      FOR EACH ROW EXECUTE FUNCTION annual_backup_period_immutable();
  `);
  // The migration installs RLS atomically: no unprotected window before role setup.
  for (const table of ['annual_photo_backup_periods', 'annual_photo_backup_requests', 'annual_photo_backup_parts', 'annual_photo_backup_notifications']) {
    await db.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await db.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await db.query(`DROP POLICY IF EXISTS annual_backup_tenant ON ${table}`);
    await db.query(`CREATE POLICY annual_backup_tenant ON ${table}
      USING (clinic_id = NULLIF(current_setting('app.current_tenant',true),'')::uuid)
      WITH CHECK (clinic_id = NULLIF(current_setting('app.current_tenant',true),'')::uuid)`);
    await db.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bioskin_app')
      THEN GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO bioskin_app; END IF; END $$`);
  }
}

async function adminTransaction(fn) {
  const pool = getPool();
  if (!pool) fail(503, 'Base de datos no disponible');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
}
async function queueNotification(db, request, kind) {
  const recipient = kind === 'REQUESTED' ? email(process.env.ANNUAL_PHOTO_BACKUP_MASTER_EMAIL) : email(request.requester_email);
  if (!recipient) fail(503, 'Correo de notificación no configurado');
  await db.query(`INSERT INTO annual_photo_backup_notifications(id,request_id,clinic_id,kind,recipient)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_id,kind) DO NOTHING`,
  [crypto.randomUUID(), request.id, request.clinic_id, kind, recipient]);
}
async function notify(requestId, clinicId) {
  // Durable, at-least-once SMTP. A crash after SMTP accepts may cause a duplicate.
  const notifications = await withTenantContext(clinicId, async db => (await db.query(`
    UPDATE annual_photo_backup_notifications SET status='SENDING',attempts=attempts+1,claimed_at=now()
    WHERE request_id=$1 AND clinic_id=$2 AND
      (status IN ('PENDING','FAILED') OR (status='SENDING' AND claimed_at < now()-interval '5 minutes'))
    RETURNING id,recipient,kind,attempts`, [requestId, clinicId])).rows);
  if (!notifications.length) return;
  const transport = nodemailer.createTransport({
    service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
  });
  for (const notification of notifications) {
    let ok = false;
    try {
      // No ZIP URL, patient data, or PHI in email. Panel always requires session.
      const panel = new URL(process.env.ANNUAL_PHOTO_BACKUP_PANEL_URL || 'https://bioskintech.vercel.app/');
      if (panel.protocol !== 'https:') throw new Error('Panel URL inválida');
      await transport.sendMail({
        from: process.env.EMAIL_USER, to: notification.recipient,
        subject: `BIOSKIN: respaldo anual ${notification.kind}`,
        text: `Estado del respaldo anual: ${notification.kind}. Solicitud ${requestId}. Ingresa al panel con tu sesión para revisarlo: ${panel.href}`,
      });
      ok = true;
    } catch { /* Only a safe classification is persisted. */ }
    await withTenantContext(clinicId, db => db.query(`UPDATE annual_photo_backup_notifications
      SET status=$2,sent_at=CASE WHEN $2='SENT' THEN now() ELSE NULL END,last_error=$3
      WHERE id=$1 AND clinic_id=$4 AND attempts=$5 AND status='SENDING'`,
    [notification.id, ok ? 'SENT' : 'FAILED', ok ? null : 'SMTP_FAILED', clinicId, notification.attempts]));
  }
  transport.close();
}

async function dispatch(requestId, clinicId) {
  // Each attempt owns a fresh token; the final write is a CAS on it so a concurrent
  // Worker callback (Fail/Complete) is never overwritten.
  const dispatchToken = crypto.randomUUID();
  const claimed = await adminTransaction(async db => (await db.query(`
    UPDATE annual_photo_backup_requests SET dispatch_status='DISPATCHING',dispatch_at=now(),
      dispatch_token=$3,last_error=NULL
    WHERE id=$1 AND clinic_id=$2 AND status='APPROVED'
      AND (lease_expires_at IS NULL OR lease_expires_at < now())
      AND (dispatch_status <> 'DISPATCHING' OR dispatch_at < now()-interval '1 minute')
      AND (dispatch_status <> 'SENT' OR coalesce(heartbeat_at,dispatch_at) < now()-interval '30 minutes')
      AND expired_at IS NULL AND (cleanup_lease_until IS NULL OR cleanup_lease_until <= now()) AND NOT (${SOURCES_STALE})
    RETURNING id`, [requestId, clinicId, dispatchToken])).rows.length > 0);
  if (!claimed) return { dispatched: false, busy: true };
  let ok = false;
  try {
    if (!workerUrl()) throw new Error('Worker sin configurar');
    const response = await fetch(workerUrl(), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceSecret()}` },
      body: JSON.stringify({ requestId, clinicId }),
    });
    ok = response.ok;
    await response.body?.cancel();
  } catch { /* The persistent job remains APPROVED and retryable. */ }
  const settled = await adminTransaction(async db => (await db.query(`UPDATE annual_photo_backup_requests
    SET dispatch_status=$3,last_error=$4
    WHERE id=$1 AND clinic_id=$2 AND status='APPROVED' AND dispatch_status='DISPATCHING' AND dispatch_token=$5
    RETURNING id`, [requestId, clinicId, ok ? 'SENT' : 'FAILED', ok ? null : 'DISPATCH_FAILED', dispatchToken])).rows.length > 0);
  return { dispatched: ok, busy: false, ...(settled ? {} : { superseded: true }) };
}

async function requireLease(db, requestId, clinicId, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail(403, 'Lease inválido');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = (await db.query(`SELECT id,clinic_id,status,requester_email FROM annual_photo_backup_requests
    WHERE id=$1 AND clinic_id=$2 AND status='APPROVED' AND lease_hash=$3
      AND lease_expires_at > now() FOR UPDATE`, [requestId, clinicId, hash])).rows[0];
  if (!row) fail(409, 'Lease vencido o trabajo no disponible');
  return row;
}

async function captureSnapshot(clinicId) {
  const pool = getAppPool();
  if (!pool) fail(503, 'Base de datos clínica no disponible');
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SELECT set_config('app.current_tenant',$1,true)", [clinicId]);
    const at = (await db.query('SELECT transaction_timestamp() AS at')).rows[0].at;
    // Pass a query-only adapter so collectClinicData does not start another TX.
    const modules = await collectClinicData({ query: db.query.bind(db) }, clinicId, ['patients']);
    await db.query('COMMIT');
    return { at, modules };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
}

async function snapshotPage(db, requestId, clinicId, table, offset) {
  if (typeof table !== 'string' || !/^[a-z_]+$/.test(table) || !Number.isSafeInteger(offset) || offset < 0)
    fail(400, 'Página de snapshot inválida');
  const count = (await db.query(`SELECT jsonb_array_length(snapshot_data->'patients'->'tables'->$3) AS total
    FROM annual_photo_backup_requests WHERE id=$1 AND clinic_id=$2`, [requestId, clinicId, table])).rows[0]?.total;
  if (count == null) fail(400, 'Tabla de snapshot inválida');
  const source = (await db.query(`SELECT item FROM annual_photo_backup_requests r,
    LATERAL jsonb_array_elements(r.snapshot_data->'patients'->'tables'->$3) WITH ORDINALITY AS items(item,n)
    WHERE r.id=$1 AND r.clinic_id=$2 AND n > $4 ORDER BY n LIMIT 200`,
  [requestId, clinicId, table, offset])).rows.map(row => row.item);
  const rows = [];
  let bytes = 0;
  for (const row of source) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (rowBytes > 1024 * 1024) fail(409, 'Fila de snapshot demasiado grande para el worker');
    if (bytes + rowBytes > 1024 * 1024) break;
    rows.push(row); bytes += rowBytes;
  }
  return { table, rows, nextOffset: offset + rows.length, total: count };
}

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENTS_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLE_RAW_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_SERIALIZED_BYTES = 12 * 1024 * 1024;

export function safeDocumentName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 240 || name.startsWith('/') ||
      name.includes('\\') || name.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
      /[\u0000-\u001f\u007f]/.test(name)) fail(409, 'Nombre de documento inválido');
  return name;
}

export function buildDocumentBundles(documents) {
  if (!Array.isArray(documents)) fail(500, 'Documentos inválidos');
  const bundles = [];
  let current = [], raw = 0, total = 0;
  const flush = () => {
    if (!current.length) return;
    const index = bundles.length + 1;
    const name = `bundle-${String(index).padStart(4, '0')}.json`;
    const body = Buffer.from(JSON.stringify({ format: 'bioskin-annual-document-bundle', version: 1, documents: current }), 'utf8');
    if (body.length > MAX_BUNDLE_SERIALIZED_BYTES) fail(409, 'Paquete documental excede el límite');
    bundles.push({ index, name, body, serializedBytes: body.length, documents: current,
      sha256: crypto.createHash('sha256').update(body).digest('hex') });
    current = []; raw = 0;
  };
  for (const document of documents) {
    const name = safeDocumentName(document?.name);
    const body = Buffer.isBuffer(document?.body) ? document.body : null;
    if (!body || body.length > MAX_DOCUMENT_BYTES) fail(409, 'Un documento supera 4 MiB; requiere dividir la exportación');
    if (typeof document.contentType !== 'string' || !/^(application\/json|text\/csv|text\/html)(;.*)?$/.test(document.contentType))
      fail(409, 'Tipo de documento no permitido');
    total += body.length;
    if (total > MAX_DOCUMENTS_BYTES) fail(409, 'La documentación supera 128 MiB');
    if (raw + body.length > MAX_BUNDLE_RAW_BYTES || current.length >= 200) flush();
    current.push({ name, contentType: document.contentType, size: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'), bodyBase64: body.toString('base64') });
    raw += body.length;
  }
  flush();
  return bundles;
}

async function uploadBundles(bundles, clinicId, requestId, deadline) {
  let next = 0;
  const worker = async () => {
    while (next < bundles.length) {
      const bundle = bundles[next++];
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail(504, 'Tiempo agotado preparando documentos; no se despachó el trabajo');
      bundle.key = `annual-photo-backups/${clinicId}/${requestId}/source/${bundle.name}`;
      let timer;
      try {
        await Promise.race([
          putR2Object(bundle.key, bundle.body, 'application/json'),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { status: 504 })), remaining); }),
        ]);
      } catch (error) {
        if (error.status === 504) fail(504, 'Tiempo agotado preparando documentos; no se despachó el trabajo');
        throw error;
      } finally { clearTimeout(timer); }
    }
  };
  await Promise.all([worker(), worker()]);
}
/** Signed URL lifetime: <=300 s and never beyond the 24 h download window. */
export function photoBackupDownloadTtl(readyAt, now = Date.now()) {
  const remaining = Math.floor((Date.parse(readyAt) + DOWNLOAD_WINDOW_MS - now) / 1000);
  return Number.isFinite(remaining) ? Math.min(MAX_DOWNLOAD_URL_SECONDS, remaining) : 0;
}

const CLEANUP_CANDIDATE = `(cleanup_lease_until IS NULL OR cleanup_lease_until <= now()) AND (
    (status='READY' AND ready_at < now()-interval '1 hour' AND (sources_deleted_at IS NULL
      OR (artifacts_deleted_at IS NULL AND ready_at < now()-interval '24 hours 10 minutes')))
    OR (status='APPROVED' AND (sources_deleted_at IS NULL OR artifacts_deleted_at IS NULL)
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      AND NOT (dispatch_status='DISPATCHING' AND dispatch_at > now()-interval '1 minute')
      AND (expired_at IS NOT NULL OR ${SOURCES_STALE})))`;

/**
 * Atomically revalidates one candidate under FOR UPDATE and reserves it with a
 * cleanup lease. Reopen, approve, dispatch and Worker claims refuse leased rows,
 * so no writer can recreate keys under the same requestId while deletes run.
 * APPROVED jobs past the source window are expired first: retry is disabled
 * before any source is deleted.
 */
async function reserveCleanup() {
  return adminTransaction(async db => {
    const job = (await db.query(`SELECT id,clinic_id,status,
        (sources_deleted_at IS NULL) AS sources,
        (artifacts_deleted_at IS NULL AND (status='APPROVED' OR ready_at < now()-interval '24 hours 10 minutes')) AS artifacts
      FROM annual_photo_backup_requests WHERE ${CLEANUP_CANDIDATE}
      ORDER BY coalesce(ready_at,approved_at) LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if (!job) return null;
    const token = crypto.randomUUID();
    await db.query(`UPDATE annual_photo_backup_requests SET cleanup_token=$3,
      cleanup_lease_until=now()+($4 * interval '1 second'),cleanup_error=NULL,
      expired_at=CASE WHEN status='APPROVED' THEN coalesce(expired_at,now()) ELSE expired_at END,
      last_error=CASE WHEN status='APPROVED' THEN 'SOURCES_EXPIRED' ELSE last_error END,
      dispatch_status=CASE WHEN status='APPROVED' THEN 'FAILED' ELSE dispatch_status END,
      lease_hash=CASE WHEN status='APPROVED' THEN NULL ELSE lease_hash END,
      lease_expires_at=CASE WHEN status='APPROVED' THEN NULL ELSE lease_expires_at END,
      snapshot_purged_at=CASE WHEN status='APPROVED' AND snapshot_data IS NOT NULL THEN now() ELSE snapshot_purged_at END,
      snapshot_data=CASE WHEN status='APPROVED' THEN NULL ELSE snapshot_data END
      WHERE id=$1 AND clinic_id=$2`, [job.id, job.clinic_id, token, CLEANUP_LEASE_SECONDS]);
    const parts = (await db.query(`SELECT expected_key,documents FROM annual_photo_backup_parts
      WHERE request_id=$1 AND clinic_id=$2`, [job.id, job.clinic_id])).rows;
    return { ...job, token, parts };
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

/**
 * Service-only cleanup (Worker cron). Bounded and idempotent: a request is marked
 * cleaned, and its reservation released, only after every R2 delete succeeded.
 * Objects never referenced in DB (upload timeouts, reopened requests) require
 * the external R2 lifecycle rule on annual-photo-backups/.
 */
export async function runMaintenance(deadline = Date.now() + 40000) {
  const { deleteR2Object } = await import('./r2-service.js');
  const result = { state: 'maintenance_done', snapshotsPurged: 0, sourcesDeleted: 0, artifactsDeleted: 0, expired: 0, failures: 0, partial: false };
  result.snapshotsPurged = await adminTransaction(async db => (await db.query(`UPDATE annual_photo_backup_requests
    SET snapshot_data=NULL,snapshot_purged_at=now()
    WHERE id IN (SELECT id FROM annual_photo_backup_requests WHERE snapshot_data IS NOT NULL
      AND (status IN ('READY','REJECTED') OR (status='APPROVED' AND expired_at IS NOT NULL))
      LIMIT 100 FOR UPDATE SKIP LOCKED)`)).rowCount || 0);
  for (let processed = 0; processed < 20; processed++) {
    if (Date.now() + R2_OP_TIMEOUT_MS > deadline) { result.partial = true; break; }
    const job = await reserveCleanup();
    if (!job) break;
    if (job.status === 'APPROVED') result.expired++;
    const clinicId = uuid(job.clinic_id), requestId = uuid(job.id);
    const base = `annual-photo-backups/${clinicId}/${requestId}/`;
    const sources = job.sources ? job.parts.flatMap(p => p.documents || []).map(d => d?.key)
      .filter(key => typeof key === 'string' && key.startsWith(`${base}source/`) && !key.includes('..')) : [];
    const artifacts = job.artifacts ? job.parts.map(p => p.expected_key)
      .filter(key => typeof key === 'string' && key.startsWith(`${base}part-`) && !key.includes('..')) : [];
    let error = null;
    for (const key of [...sources, ...artifacts]) {
      if (Date.now() + R2_OP_TIMEOUT_MS > deadline) { error = 'CLEANUP_INCOMPLETE'; result.partial = true; break; }
      try { await withTimeout(deleteR2Object(key), R2_OP_TIMEOUT_MS); } catch { error = 'R2_DELETE_FAILED'; break; }
    }
    if (error) result.failures++;
    // On failure the reservation is kept until it lapses: a timed-out delete may still be in flight.
    await adminTransaction(db => db.query(`UPDATE annual_photo_backup_requests SET
      sources_deleted_at=CASE WHEN $4::text IS NULL AND $5::boolean THEN coalesce(sources_deleted_at,now()) ELSE sources_deleted_at END,
      artifacts_deleted_at=CASE WHEN $4::text IS NULL AND $6::boolean THEN coalesce(artifacts_deleted_at,now()) ELSE artifacts_deleted_at END,
      cleanup_error=$4::text,
      cleanup_token=CASE WHEN $4::text IS NULL THEN NULL ELSE cleanup_token END,
      cleanup_lease_until=CASE WHEN $4::text IS NULL THEN NULL ELSE cleanup_lease_until END
      WHERE id=$1 AND clinic_id=$2 AND cleanup_token=$3`, [requestId, clinicId, job.token, error, job.sources, job.artifacts]));
    if (!error) { if (job.sources) result.sourcesDeleted++; if (job.artifacts) result.artifactsDeleted++; }
  }
  return result;
}

async function workerCallback(action, req) {
  requirePost(req);
  const suppliedSecret = req.headers?.['x-photo-backup-secret'] ||
    (typeof req.headers?.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!verifyPhotoBackupServiceSecret(suppliedSecret)) fail(401, 'Servicio no autorizado');
  // Cross-clinic by design: administrative pool, never reads or returns PHI.
  if (action === 'photoBackupWorkerMaintenance') return runMaintenance();
  const body = bodyObject(req), requestId = uuid(body.requestId), clinicId = uuid(body.clinicId);
  const result = await withTenantContext(clinicId, async db => {
    if (action === 'photoBackupWorkerClaim') {
      const existing = (await db.query(`SELECT status,lease_expires_at,
        (expired_at IS NOT NULL OR cleanup_lease_until > now() OR ${SOURCES_STALE}) AS expired
        FROM annual_photo_backup_requests WHERE id=$1 AND clinic_id=$2 FOR UPDATE`, [requestId, clinicId])).rows[0];
      if (!existing) return { state: 'cancelled' };
      if (existing.status === 'READY') return { state: 'completed' };
      if (existing.status === 'REJECTED') return { state: 'cancelled' };
      if (existing.status !== 'APPROVED') return { state: 'cancelled' };
      if (existing.expired) return { state: 'expired' };
      let token;
      if (body.leaseToken) {
        await requireLease(db, requestId, clinicId, body.leaseToken);
        token = body.leaseToken;
      } else {
        const job = (await db.query(`SELECT id FROM annual_photo_backup_requests
          WHERE id=$1 AND clinic_id=$2 AND status='APPROVED'
          AND (lease_expires_at IS NULL OR lease_expires_at < now()) FOR UPDATE`, [requestId, clinicId])).rows[0];
        if (!job) return { state: 'leased', retryAfterSeconds: 60 };
        token = crypto.randomBytes(32).toString('hex');
      }
      const job = (await db.query(`UPDATE annual_photo_backup_requests SET lease_hash=$3,
        lease_expires_at=now()+($4 * interval '1 second'),heartbeat_at=now()
        WHERE id=$1 AND clinic_id=$2 RETURNING snapshot_at,lease_expires_at`,
      [requestId, clinicId, crypto.createHash('sha256').update(token).digest('hex'), LEASE_SECONDS])).rows[0];
      const parts = (await db.query(`SELECT part_number,expected_key,manifest,documents,photo_count,source_bytes,completed_at
        FROM annual_photo_backup_parts WHERE request_id=$1 AND clinic_id=$2 AND completed_at IS NULL
        ORDER BY part_number LIMIT 1`, [requestId, clinicId])).rows;
      const counts = (await db.query(`SELECT count(*)::integer AS total,
        count(*) FILTER(WHERE completed_at IS NULL)::integer AS pending FROM annual_photo_backup_parts
        WHERE request_id=$1 AND clinic_id=$2`, [requestId, clinicId])).rows[0];
      const tables = (await db.query(`SELECT key,jsonb_array_length(value) AS total
        FROM annual_photo_backup_requests r,
          LATERAL jsonb_each(r.snapshot_data->'patients'->'tables')
        WHERE r.id=$1 AND r.clinic_id=$2`, [requestId, clinicId])).rows;
      return {
        state: counts.pending ? 'claimed' : 'ready_to_complete',
        requestId, clinicId, leaseToken: token, leaseExpiresAt: job.lease_expires_at,
        snapshotAt: job.snapshot_at, expectedPrefix: `annual-photo-backups/${clinicId}/${requestId}/`,
        partCount: counts.total, pendingPartCount: counts.pending,
        totalParts: counts.total, remainingParts: counts.pending,
        snapshotTables: Object.fromEntries(tables.map(row => [row.key, row.total])),
        ...(body.snapshotTable ? { snapshotPage: await snapshotPage(db, requestId, clinicId, body.snapshotTable, body.snapshotOffset ?? 0) } : {}),
        parts: parts.map(p => ({
          partNumber: p.part_number, expectedKey: p.expected_key, photos: p.manifest,
          index: p.part_number, key: p.expected_key, documents: p.documents,
          photoCount: p.photo_count, sourceBytes: Number(p.source_bytes), completed: Boolean(p.completed_at),
        })),
      };
    }
    if (action === 'photoBackupWorkerComplete' && typeof body.leaseToken === 'string' && /^[a-f0-9]{64}$/.test(body.leaseToken)) {
      const alreadyReady = (await db.query(`SELECT id FROM annual_photo_backup_requests
        WHERE id=$1 AND clinic_id=$2 AND status='READY' AND lease_hash=$3`,
      [requestId, clinicId, crypto.createHash('sha256').update(body.leaseToken).digest('hex')])).rows.length > 0;
      if (alreadyReady) return { state: 'completed', status: 'READY', alreadyCompleted: true };
    }
    let job;
    if (action === 'photoBackupWorkerFail' && body.leaseToken == null) {
      job = (await db.query(`SELECT id,status FROM annual_photo_backup_requests WHERE id=$1 AND clinic_id=$2
        AND status='APPROVED' AND (lease_expires_at IS NULL OR lease_expires_at<=now()) FOR UPDATE`,
      [requestId, clinicId])).rows[0];
      if (!job) return { state: 'cancelled' };
      if ((await db.query(`SELECT 1 FROM annual_photo_backup_requests WHERE id=$1 AND clinic_id=$2
        AND (expired_at IS NOT NULL OR cleanup_lease_until > now())`, [requestId, clinicId])).rows.length) return { state: 'expired' };
    } else job = await requireLease(db, requestId, clinicId, body.leaseToken);
    if (action === 'photoBackupWorkerPart') {
      const partNumber = body.partNumber ?? body.index;
      const r2Key = body.r2Key ?? body.key;
      const sizeBytes = body.sizeBytes ?? body.size;
      const key = photoBackupExpectedKey(clinicId, requestId, partNumber);
      if (r2Key !== key || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 ||
          sizeBytes > MAX_PART_BYTES || !/^[a-f0-9]{64}$/.test(body.sha256 || ''))
        fail(400, 'Parte o metadatos inválidos');
      if (!(await r2ObjectExists(key))) fail(409, 'Parte no disponible en almacenamiento');
      const row = (await db.query(`UPDATE annual_photo_backup_parts SET r2_key=$4,size_bytes=$5,sha256=$6,completed_at=now()
        WHERE request_id=$1 AND clinic_id=$2 AND part_number=$3 AND expected_key=$4
          AND (completed_at IS NULL OR (sha256=$6 AND size_bytes=$5)) RETURNING part_number`,
      [requestId, clinicId, partNumber, key, sizeBytes, body.sha256])).rows[0];
      if (!row) fail(409, 'Parte inexistente o ya registrada con otro contenido');
      await db.query(`UPDATE annual_photo_backup_requests SET heartbeat_at=now(),
        lease_expires_at=now()+($3 * interval '1 second') WHERE id=$1 AND clinic_id=$2`, [requestId, clinicId, LEASE_SECONDS]);
      const remaining = (await db.query(`SELECT count(*)::integer AS pending FROM annual_photo_backup_parts
        WHERE request_id=$1 AND clinic_id=$2 AND completed_at IS NULL`, [requestId, clinicId])).rows[0].pending;
      // Queues contain no lease tokens: release between parts, retain final lease for Complete.
      if (remaining > 0) await db.query(`UPDATE annual_photo_backup_requests SET lease_hash=NULL,lease_expires_at=NULL
        WHERE id=$1 AND clinic_id=$2`, [requestId, clinicId]);
      return { state: 'part_recorded', saved: true, remainingParts: remaining };
    }
    if (action === 'photoBackupWorkerComplete') {
      const pending = (await db.query(`SELECT count(*)::integer AS total,
        count(*) FILTER(WHERE completed_at IS NULL)::integer AS pending
        FROM annual_photo_backup_parts WHERE request_id=$1 AND clinic_id=$2`, [requestId, clinicId])).rows[0];
      if (!pending.total || pending.pending) fail(409, 'Faltan partes del respaldo');
      const ready = (await db.query(`UPDATE annual_photo_backup_requests SET status='READY',ready_at=now(),
        lease_expires_at=NULL,last_error=NULL WHERE id=$1 AND clinic_id=$2 RETURNING id,clinic_id,period_id,requester_email`,
      [requestId, clinicId])).rows[0];
      await db.query(`UPDATE annual_photo_backup_periods SET consumed_at=now()
        WHERE id=$1 AND clinic_id=$2 AND consumed_at IS NULL`, [ready.period_id, clinicId]);
      await queueNotification(db, ready, 'READY');
      return { state: 'completed', status: 'READY' };
    }
    if (action === 'photoBackupWorkerFail') {
      const code = ['INVALID_CLAIM', 'SOURCE_MISSING', 'SOURCE_TOO_LARGE', 'ARCHIVE_TOO_LARGE', 'UPLOAD_FAILED',
        'CALLBACK_FAILED', 'DEADLINE_EXCEEDED', 'INTERNAL_ERROR', 'LEASE_LOST', 'QUEUE_PUBLISH_FAILED', 'CONFIG_MISSING'].includes(body.code) ? body.code : 'WORKER_FAILED';
      await db.query(`UPDATE annual_photo_backup_requests SET lease_hash=NULL,lease_expires_at=NULL,
        last_error=$3,dispatch_status='FAILED' WHERE id=$1 AND clinic_id=$2`, [requestId, clinicId, code]);
      return { state: 'failed', status: job.status, retryable: true };
    }
    fail(400, 'Acción inválida');
  });
  if (action === 'photoBackupWorkerComplete') await notify(requestId, clinicId).catch(() => {});
  return result;
}

async function sessionAction(action, req, auth) {
  const master = auth.role === 'master_admin';
  if (!master && auth.role !== 'clinic_admin') fail(403, 'Solo administrador de clínica');
  const masterActions = ['setPhotoBackupPeriod', 'approvePhotoBackup', 'rejectPhotoBackup', 'listPhotoBackupRequests'];
  if (masterActions.includes(action) && !master) fail(403, 'Requiere administrador maestro');
  if (!annualPhotoBackupConfigured()) {
    const disabled = { configured: false, eligible: false, reason: 'feature_disabled', period: null, requests: [] };
    if (action === 'photoBackupStatus' || action === 'listPhotoBackupRequests') return action === 'listPhotoBackupRequests' ? { ...disabled, notifications: [] } : disabled;
    fail(503, 'Respaldo anual no habilitado');
  }
  if (action === 'listPhotoBackupRequests') {
    if (req.method !== 'GET') fail(405, 'Requiere GET');
    // Deliberately administrative, bounded listing; never includes manifests/PHI.
    return adminTransaction(async db => ({
      configured: true, requests: await listRequests(db),
      notifications: (await db.query(`SELECT request_id,kind,status,attempts,last_error
        FROM annual_photo_backup_notifications ORDER BY claimed_at DESC NULLS LAST LIMIT 100`)).rows,
    }));
  }
  const body = req.method === 'POST' ? bodyObject(req) : {};
  let targetClinic = master ? (body.clinicId || auth.effective_clinic_id || auth.clinic_id) : auth.clinic_id;
  if (master && !targetClinic && (body.requestId || req.query.requestId)) {
    // Scope the administrative lookup to a validated job, never client-provided PHI.
    const id = uuid(body.requestId || req.query.requestId);
    targetClinic = await adminTransaction(async db => (await db.query(
      'SELECT clinic_id FROM annual_photo_backup_requests WHERE id=$1', [id])).rows[0]?.clinic_id);
    if (!targetClinic) fail(404, 'Solicitud no encontrada');
  }
  const clinicId = uuid(targetClinic);
  if (action === 'setPhotoBackupPeriod') {
    requirePost(req);
    const startsAt = body.startsAt || (typeof body.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate) ? `${body.startDate}T00:00:00Z` : null);
    const endsAt = body.endsAt || (typeof body.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.endDate) ? `${body.endDate}T00:00:00Z` : null);
    for (const date of [startsAt, endsAt]) {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date) ||
          !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date.slice(0, 10))
        fail(400, 'Fechas inicial y final UTC explícitas requeridas');
    }
    return adminTransaction(async db => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [clinicId]);
      if (!(await db.query('SELECT id FROM clinics WHERE id=$1', [clinicId])).rows.length) fail(404, 'Clínica no encontrada');
      if (!(await db.query(`SELECT $1::timestamptz + interval '12 months' = $2::timestamptz AS valid`, [startsAt, endsAt])).rows[0].valid)
        fail(400, 'El período debe tener exactamente 12 meses');
      const overlap = await db.query(`SELECT id FROM annual_photo_backup_periods WHERE clinic_id=$1
        AND tstzrange(starts_at,ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')`,
      [clinicId, startsAt, endsAt]);
      if (overlap.rows.length) fail(409, 'Existe un período superpuesto; los períodos persistidos no se editan');
      const period = (await db.query(`INSERT INTO annual_photo_backup_periods(id,clinic_id,starts_at,ends_at,created_by)
        VALUES($1,$2,$3::timestamptz,$4::timestamptz,$5) RETURNING *`,
      [crypto.randomUUID(), clinicId, startsAt, endsAt, auth.id])).rows[0];
      return { period: { ...period, start_date: period.starts_at, end_date: period.ends_at } };
    });
  }
  if (action === 'photoBackupStatus') {
    if (req.method !== 'GET') fail(405, 'Requiere GET');
    return withTenantContext(clinicId, async db => {
      const period = (await db.query(`SELECT * FROM annual_photo_backup_periods
        WHERE clinic_id=$1 AND starts_at<=now() AND ends_at>now() ORDER BY starts_at DESC LIMIT 1`, [clinicId])).rows[0] || null;
      const requests = await listRequests(db, clinicId);
      const reserved = period ? (await db.query(`SELECT 1 FROM annual_photo_backup_requests
        WHERE clinic_id=$1 AND period_id=$2 AND NOT (status='REJECTED' OR
          (status='APPROVED' AND last_error IS NOT NULL AND expired_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<=now())))`,
      [clinicId, period.id])).rows.length > 0 : false;
      return { configured: annualPhotoBackupConfigured(), eligible: Boolean(annualPhotoBackupConfigured() &&
        period && !reserved), period: period ? { ...period, start_date: period.starts_at, end_date: period.ends_at } : null,
      reason: !period ? 'No existe un período anual activo.' : reserved ? 'Ya existe una solicitud para este período.' : null, requests };
    });
  }
  if (action === 'requestPhotoBackup') {
    requirePost(req);
    if (master) fail(403, 'La solicitud debe emitirla el administrador de la clínica');
    if (!annualPhotoBackupConfigured()) fail(503, 'Respaldo anual no configurado');
    const request = await withTenantContext(clinicId, async db => {
      const period = (await db.query(`SELECT id FROM annual_photo_backup_periods
        WHERE clinic_id=$1 AND starts_at<=now() AND ends_at>now() FOR UPDATE`, [clinicId])).rows[0];
      if (!period) fail(409, 'La clínica no tiene un período activo configurado por el maestro');
      const user = (await db.query(`SELECT email FROM clinic_users WHERE id=$1 AND clinic_id=$2
        AND is_active=true AND role='clinic_admin'`, [auth.id, clinicId])).rows[0];
      if (!email(user?.email)) fail(409, 'Configura un correo válido en tu cuenta');
      const previous = (await db.query(`SELECT id,status,last_error,lease_expires_at,expired_at,
        (cleanup_lease_until > now()) AS cleaning FROM annual_photo_backup_requests
        WHERE clinic_id=$1 AND period_id=$2 FOR UPDATE`, [clinicId, period.id])).rows[0];
      if (previous) {
        if (previous.cleaning) fail(409, 'Limpieza del respaldo anterior en curso; intenta en unos minutos');
        if (previous.expired_at) fail(409, 'La solicitud caducó; contacta a soporte para una nueva entrega autorizada');
        if (!(previous.status === 'REJECTED' || (previous.status === 'APPROVED' && previous.last_error &&
          (!previous.lease_expires_at || Date.parse(previous.lease_expires_at) <= Date.now()))))
          fail(409, 'Ya existe una solicitud reservada o consumida para este período');
        await db.query(`DELETE FROM annual_photo_backup_parts WHERE request_id=$1 AND clinic_id=$2`, [previous.id, clinicId]);
        const reopened = (await db.query(`UPDATE annual_photo_backup_requests SET status='REQUESTED',requested_by=$3,
          requester_email=$4,created_at=now(),approved_at=NULL,approved_by=NULL,rejected_at=NULL,rejection_reason=NULL,
          snapshot_at=NULL,snapshot_data=NULL,lease_hash=NULL,lease_expires_at=NULL,last_error=NULL,
          dispatch_status='PENDING',dispatch_at=NULL,dispatch_token=NULL,sources_uploaded_at=NULL,
          snapshot_purged_at=NULL,sources_deleted_at=NULL,artifacts_deleted_at=NULL,cleanup_error=NULL,
          expired_at=NULL,cleanup_token=NULL,cleanup_lease_until=NULL WHERE id=$1 AND clinic_id=$2 RETURNING *`,
        [previous.id, clinicId, auth.id, user.email])).rows[0];
        await queueNotification(db, reopened, 'REQUESTED');
        await db.query(`UPDATE annual_photo_backup_notifications SET status='PENDING',recipient=$3,last_error=NULL
          WHERE request_id=$1 AND clinic_id=$2 AND kind='REQUESTED'`,
        [previous.id, clinicId, email(process.env.ANNUAL_PHOTO_BACKUP_MASTER_EMAIL)]);
        return reopened;
      }
      const inserted = (await db.query(`INSERT INTO annual_photo_backup_requests(id,clinic_id,period_id,requested_by,requester_email)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(period_id) DO NOTHING RETURNING *`,
      [crypto.randomUUID(), clinicId, period.id, auth.id, user.email])).rows[0];
      if (!inserted) fail(409, 'Ya existe una solicitud para este período');
      await queueNotification(db, inserted, 'REQUESTED');
      return inserted;
    });
    await notify(request.id, clinicId).catch(() => {});
    return { requestId: request.id, status: 'PENDING' };
  }
  const requestId = uuid(body.requestId || req.query.requestId);
  if (action === 'approvePhotoBackup') {
    requirePost(req);
    if (body.retryNotifications === true) {
      const request = await adminTransaction(async db => (await db.query(`SELECT status FROM annual_photo_backup_requests
        WHERE id=$1 AND clinic_id=$2`, [requestId, clinicId])).rows[0]);
      if (!request) fail(404, 'Solicitud no encontrada');
      await notify(requestId, clinicId);
      return { requestId, status: request.status, notificationsRetry: true };
    }
    if (!annualPhotoBackupConfigured()) fail(503, 'Respaldo anual no configurado');
    const job = await adminTransaction(async db => {
      const request = (await db.query(`SELECT id,clinic_id,status,
        (expired_at IS NOT NULL OR cleanup_lease_until > now() OR (status='APPROVED' AND ${SOURCES_STALE})) AS expired
        FROM annual_photo_backup_requests WHERE id=$1 AND clinic_id=$2 FOR UPDATE`, [requestId, clinicId])).rows[0];
      if (!request) fail(404, 'Solicitud no encontrada');
      if (!['REQUESTED', 'APPROVED'].includes(request.status)) fail(409, 'Solicitud no aprobable');
      if (request.expired) fail(409, 'El respaldo caducó; la clínica debe solicitarlo nuevamente');
      if (request.status === 'REQUESTED') {
        // Read clinical data with appPool/RLS, not the administrative connection.
        const snapshot = await captureSnapshot(clinicId);
        for (const rows of Object.values(snapshot.modules.patients.tables)) {
          if (rows.some(row => Buffer.byteLength(JSON.stringify(row)) > 1024 * 1024))
            fail(409, 'El snapshot contiene filas demasiado grandes para exportación por lotes');
        }
        const photos = snapshot.modules.patients.tables.clinical_photos || [];
        const parts = buildPhotoBackupParts(photos, clinicId, requestId);
        const documents = buildPortableDocuments(snapshot.modules, {
          clinicId, generatedAt: new Date(snapshot.at).toISOString(),
        });
        // Bundles keep R2 writes bounded; the worker decodes one bundle at a time.
        const bundles = buildDocumentBundles(documents);
        const deadline = Date.now() + 45000;
        await uploadBundles(bundles, clinicId, requestId, deadline);
        for (const bundle of bundles) {
          let part = parts.find(p => p.sourceBytes + bundle.serializedBytes <= MAX_SOURCE_BYTES &&
            (p.documents?.length || 0) < 200);
          if (!part) {
            const partNumber = parts.length + 1;
            part = { partNumber, expectedKey: photoBackupExpectedKey(clinicId, requestId, partNumber),
              photos: [], photoCount: 0, sourceBytes: 0 };
            parts.push(part);
          }
          (part.documents ||= []).push({ type: 'bundle', key: bundle.key, name: bundle.name,
            size: bundle.serializedBytes, documentCount: bundle.documents.length, sha256: bundle.sha256 });
          part.sourceBytes += bundle.serializedBytes;
        }        for (const part of parts) {
          await db.query(`INSERT INTO annual_photo_backup_parts(request_id,clinic_id,part_number,expected_key,manifest,source_bytes,photo_count,documents)
            VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)`,
          [requestId, clinicId, part.partNumber, part.expectedKey, JSON.stringify(part.photos), part.sourceBytes, part.photoCount,
            JSON.stringify(part.documents || [])]);
        }
        await db.query(`UPDATE annual_photo_backup_requests SET status='APPROVED',approved_at=now(),approved_by=$3,
          snapshot_at=$4,snapshot_data=$5::jsonb,sources_uploaded_at=now() WHERE id=$1 AND clinic_id=$2`,
        [requestId, clinicId, auth.id, snapshot.at, JSON.stringify(snapshot.modules)]);
      }
      return { requestId, status: 'APPROVED' };
    });
    const dispatched = await dispatch(requestId, clinicId);
    await notify(requestId, clinicId).catch(() => {});
    return { ...job, ...dispatched };
  }
  if (action === 'rejectPhotoBackup') {
    requirePost(req);
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) fail(400, 'Motivo requerido (máximo 500 caracteres)');
    await adminTransaction(async db => {
      const request = (await db.query(`UPDATE annual_photo_backup_requests SET status='REJECTED',
        rejected_at=now(),rejection_reason=$3 WHERE id=$1 AND clinic_id=$2 AND status='REQUESTED' RETURNING *`,
      [requestId, clinicId, body.reason.trim()])).rows[0];
      if (!request) fail(409, 'Solo se rechazan solicitudes pendientes');
      await queueNotification(db, request, 'REJECTED');
    });
    await notify(requestId, clinicId).catch(() => {});
    return { requestId, status: 'REJECTED' };
  }
  if (action === 'photoBackupDownload') {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'Requiere GET o POST');
    const available = await withTenantContext(clinicId, async db => {
      const request = (await db.query(`SELECT id,ready_at FROM annual_photo_backup_requests
        WHERE id=$1 AND clinic_id=$2 AND status='READY'`, [requestId, clinicId])).rows[0];
      if (!request) fail(404, 'Respaldo no disponible');
      const expiresIn = photoBackupDownloadTtl(request.ready_at);
      if (expiresIn < 1) fail(410, 'El período de descarga de 24 horas ha vencido');
      const parts = (await db.query(`SELECT part_number,r2_key,size_bytes,sha256 FROM annual_photo_backup_parts
        WHERE request_id=$1 AND clinic_id=$2 AND completed_at IS NOT NULL ORDER BY part_number`, [requestId, clinicId])).rows;
      return { parts, expiresIn };
    });
    if (req.method === 'POST') {
      if (!Number.isInteger(body.index) || body.index < 0) fail(400, 'Índice inválido');
      const part = available.parts.find(p => p.part_number === body.index + 1);
      if (!part) fail(404, 'Parte no encontrada');
      const filename = `respaldo-${requestId}-parte-${part.part_number}.zip`;
      return { url: await generateDownloadUrl(photoBackupExpectedKey(clinicId, requestId, part.part_number), filename, available.expiresIn),
        filename, expiresIn: available.expiresIn };
    }
    return { requestId, expiresIn: available.expiresIn, parts: await Promise.all(available.parts.map(async p => ({
      partNumber: p.part_number, sizeBytes: Number(p.size_bytes), sha256: p.sha256,
      url: await generateDownloadUrl(photoBackupExpectedKey(clinicId, requestId, p.part_number),
        `respaldo-${requestId}-parte-${p.part_number}.zip`, available.expiresIn),
    }))) };
  }
  fail(400, 'Acción inválida');
}

export async function handleAnnualPhotoBackup(req, res, action) {
  try {
    const service = action.startsWith('photoBackupWorker');
    let result;
    if (service && !annualPhotoBackupConfigured()) fail(503, 'Respaldo anual no habilitado');
    if (service) result = await workerCallback(action, req);
    else {
      const auth = await authenticateRequest(req);
      if (!auth.valid) fail(401, 'No autenticado');
      result = await sessionAction(action, req, auth);
    }
    const dispatchFailed = action === 'approvePhotoBackup' && result.dispatched === false && !result.busy;
    return res.status(dispatchFailed ? 502 : 200).json({
      success: !dispatchFailed, ...result,
      ...(dispatchFailed ? { error: 'Aprobado, pero el despacho falló. Reintenta la aprobación para enviar el trabajo.' } : {}),
    });
  } catch (error) {
    if (error.code === '42P01' && ['photoBackupStatus', 'listPhotoBackupRequests'].includes(action))
      return res.status(200).json({ success: true, configured: false, eligible: false, reason: 'migration_needed', period: null, requests: [], ...(action === 'listPhotoBackupRequests' ? { notifications: [] } : {}) });
    console.error('[annual-photo-backup]', action, error.code || error.status || 'ERROR');
    return res.status(error.status || 500).json({ success: false,
      ...(action.startsWith('photoBackupWorker') && error.status === 409 ? { state: 'lease_lost' } : {}),
      error: error.status ? error.message : 'No fue posible procesar el respaldo anual' });
  }
}
