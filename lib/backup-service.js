/**
 * Motor de respaldos por clínica: recolección, firma HMAC, cifrado AES-256-GCM, compresión y CSV.
 * Todo respaldo es por tenant (clinic_id); nunca exporta credenciales, tokens ni secretos de firma.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createGzip, gzipSync, gunzipSync, inflateSync, deflateSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeEcuadorIdentification } from './consent-signing.js';

export const BACKUP_FORMAT = 'bioskintech-backup';
export const BACKUP_SCHEMA_VERSION = 3;
export const BATCH_EXPORT_BUDGET_MS = 50_000;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_JSON_BYTES = 200 * 1024 * 1024;
export const isBackupUploadSizeAllowed = size => Number.isSafeInteger(size) && size >= 2 && size <= MAX_UPLOAD_BYTES;
export const MAX_ROWS_PER_TABLE = 50_000;
const checkedRows = (rows, label) => {
  if (rows.length > MAX_ROWS_PER_TABLE)
    throw new Error(`${label} supera ${MAX_ROWS_PER_TABLE} filas; no se generó una exportación parcial, requiere procesamiento por lotes`);
  return rows;
};
export const BACKUP_MODULES = ['patients', 'finance', 'inventory', 'config', 'communications'];

export const CLINICAL_TABLES = [
  'patients', 'clinical_records', 'consultations', 'medical_history', 'consultation_info', 'consultation_history',
  'physical_exams', 'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms',
  'medical_history_snapshots', 'clinical_photos', 'patient_audit_log',
];

export const EXCLUDED_CONSENT_COLUMNS = new Set([
  'signing_token', 'signing_email', 'signing_sender_user_id', 'signing_otp_hash', 'signing_otp_attempts',
  'signing_expires_at', 'signing_verified_at', 'signing_session_hash', 'signing_session_expires_at',
]);

const SAFE_USER_COLUMNS = ['id', 'username', 'full_name', 'first_name', 'last_name', 'email', 'role', 'access_scope',
  'profession', 'especialidad', 'cedula_profesional', 'matricula_senescyt', 'registro_acess', 'is_active', 'created_at'];
const SAFE_CLINIC_COLUMNS = ['id', 'name', 'slug', 'email', 'phone', 'address', 'city', 'country', 'ruc', 'website', 'created_at'];

export const BACKUP_NOTES = [
  'Las fotografías clínicas NO se incluyen: solo sus referencias (r2_key) y metadatos. Los archivos permanecen en almacenamiento privado.',
  'Las marcaciones 2D/3D (mapas faciales, corporales e inyectables) SÍ se incluyen como datos; los modelos 3D son parte del software.',
  'Los consentimientos incluyen contenido, firmas digitalizadas y huellas de integridad; se excluyen tokens y códigos de firma remota.',
  'La agenda se gestiona en el Google Calendar de cada profesional y no forma parte de este archivo.',
  'Los módulos "config" y "communications" son de referencia: no se restauran automáticamente.',
];

// ── Criptografía ──────────────────────────────────────────────────────────────
const ENC_MAGIC = Buffer.from('BSKE1');

function deriveKey(purpose) {
  const secret = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
  if (secret.length < 32) return null;
  return Buffer.from(hkdfSync('sha256', secret, 'bioskintech-backup-v1', purpose, 32));
}

export const hasBackupKey = () => deriveKey('enc') !== null;

export function signModules(modulesJson) {
  const key = deriveKey('sign');
  return key ? createHmac('sha256', key).update(modulesJson).digest('hex') : null;
}

export function verifyModulesSignature(modulesJson, signature) {
  const expected = signModules(modulesJson);
  if (!expected || typeof signature !== 'string' || signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function encryptBackup(buffer) {
  const key = deriveKey('enc');
  if (!key) throw new Error('BACKUP_ENCRYPTION_KEY no configurada');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(ENC_MAGIC);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([ENC_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

/** Acepta JSON plano, JSON gzip o respaldo cifrado; limita tamaño descomprimido (anti zip-bomb). */
export function decodeBackupBuffer(input) {
  let data = input;
  if (data.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
    const key = deriveKey('enc');
    if (!key) throw new Error('No se puede descifrar: clave de respaldo no configurada');
    const iv = data.subarray(5, 17);
    const tag = data.subarray(17, 33);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(ENC_MAGIC);
    decipher.setAuthTag(tag);
    try { data = Buffer.concat([decipher.update(data.subarray(33)), decipher.final()]); }
    catch { throw new Error('El respaldo cifrado fue alterado o pertenece a otra instalación'); }
  }
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try { data = gunzipSync(data, { maxOutputLength: MAX_JSON_BYTES }); }
    catch (err) { throw new Error(err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError ? 'El archivo descomprimido excede el tamaño permitido' : 'El archivo comprimido está dañado'); }
  }
  if (data.length > MAX_JSON_BYTES) throw new Error('El archivo excede el tamaño permitido');
  let text = data.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); }
  catch { throw new Error('El archivo no es un JSON válido de BioSkinTech'); }
}

export function assertBackupJsonSize(byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new TypeError('Tamaño JSON inválido');
  if (byteLength > MAX_JSON_BYTES)
    throw Object.assign(new Error(
      `El respaldo supera el límite de restauración de ${MAX_JSON_BYTES / 1048576} MiB descomprimidos. No se generó; coordina una exportación/restauración asistida con soporte.`,
    ), { status: 413 });
}

export function compressBackup(doc, { maxCompressedBytes } = {}) {
  const json = JSON.stringify(doc);
  assertBackupJsonSize(Buffer.byteLength(json, 'utf8'));
  const compressed = gzipSync(Buffer.from(json, 'utf8'));
  if (maxCompressedBytes !== undefined && compressed.length > maxCompressedBytes)
    throw Object.assign(new Error(
      `El respaldo comprimido supera el límite compatible de ${(maxCompressedBytes / 1048576).toFixed(1)} MiB. No se generó; coordina una exportación/restauración asistida con soporte.`,
    ), { status: 413 });
  return compressed;
}

// ── Documento ─────────────────────────────────────────────────────────────────
function countRows(modules) {
  const counts = {};
  const add = (key, rows) => { if (Array.isArray(rows)) counts[key] = rows.length; };
  for (const [table, rows] of Object.entries(modules.patients?.tables || {})) add(table, rows);
  add('finance_records', modules.finance?.records);
  add('financial_items', modules.finance?.items);
  for (const key of ['items', 'groups', 'batches', 'movements']) add(`inventory_${key}`, modules.inventory?.[key]?.data);
  return counts;
}

export function buildBackupDocument({ clinicId, clinicName, generatedBy, kind, modules }) {
  return {
    format: BACKUP_FORMAT,
    schema_version: BACKUP_SCHEMA_VERSION,
    metadata: {
      timestamp: new Date().toISOString(),
      clinic_id: clinicId,
      clinic_name: clinicName || null,
      generated_by: generatedBy,
      kind,
      version: '3.0',
      modules: Object.keys(modules),
      counts: countRows(modules),
      notes: BACKUP_NOTES,
    },
    signature: signModules(JSON.stringify(modules)),
    modules,
  };
}

/** Valida estructura, versión, firma y antigüedad sin tocar la base de datos. */
export function inspectBackupDocument(doc, targetClinicId) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.metadata || typeof doc.metadata !== 'object' ||
      !doc.modules || typeof doc.modules !== 'object' || Array.isArray(doc.modules))
    throw new Error('Formato de respaldo inválido');
  const legacy = doc.format === undefined;
  if (!legacy && doc.format !== BACKUP_FORMAT) throw new Error('El archivo no es un respaldo de BioSkinTech');
  if (!legacy && !(Number(doc.schema_version) >= 1 && Number(doc.schema_version) <= BACKUP_SCHEMA_VERSION))
    throw new Error('Respaldo generado por una versión incompatible del sistema');
  const signature = !doc.signature ? 'unsigned' : verifyModulesSignature(JSON.stringify(doc.modules), doc.signature) ? 'valid' : 'invalid';
  const created = Date.parse(doc.metadata.timestamp);
  return {
    legacy,
    signature,
    sourceClinicId: typeof doc.metadata.clinic_id === 'string' ? doc.metadata.clinic_id : null,
    sameClinic: String(doc.metadata.clinic_id || '') === String(targetClinicId || ''),
    timestamp: Number.isFinite(created) ? new Date(created).toISOString() : null,
    ageDays: Number.isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : null,
    modules: Object.keys(doc.modules).filter(key => BACKUP_MODULES.includes(key)),
    counts: countRows(doc.modules),
  };
}

// ── Recolección ───────────────────────────────────────────────────────────────
const pick = (row, columns) => Object.fromEntries(columns.filter(c => Object.hasOwn(row, c)).map(c => [c, row[c]]));

/** Lee todo en una sola transacción REPEATABLE READ de solo lectura: la copia refleja un instante coherente aunque haya escrituras en curso. */
export async function collectClinicData(pool, clinicId, selected = BACKUP_MODULES, { signal } = {}) {
  if (!clinicId) throw new Error('Clínica no identificada');
  signal?.throwIfAborted();
  if (typeof pool.connect !== 'function') return collectWith(pool, clinicId, selected, signal);
  const client = await pool.connect();
  try {
    signal?.throwIfAborted();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const modules = await collectWith(client, clinicId, selected, signal);
    signal?.throwIfAborted();
    await client.query('COMMIT');
    return modules;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function collectWith(pool, clinicId, selected, signal) {
  const query = async (sql, params) => {
    signal?.throwIfAborted();
    const result = await pool.query(sql, params);
    signal?.throwIfAborted();
    return result;
  };
  const existing = new Set((await query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  )).rows.map(r => r.table_name));
  const rows = async (table, sql, params = [clinicId]) => existing.has(table) ? (await query(sql, params)).rows : [];
  // Nunca se guarda una copia incompleta en silencio: si una tabla supera el límite, la copia falla y se alerta.
  const byClinic = async table => {
    const result = await rows(table, `SELECT * FROM ${table} WHERE clinic_id = $1 ORDER BY id LIMIT ${MAX_ROWS_PER_TABLE + 1}`);
    if (result.length > MAX_ROWS_PER_TABLE) throw new Error(`La tabla ${table} supera ${MAX_ROWS_PER_TABLE} filas; el respaldo requiere procesamiento por lotes`);
    return result;
  };
  const modules = {};

  if (selected.includes('patients')) {
    const tables = {};
    for (const table of CLINICAL_TABLES) tables[table] = await byClinic(table);
    tables.consent_forms = tables.consent_forms.map(row =>
      Object.fromEntries(Object.entries(row).filter(([column]) => !EXCLUDED_CONSENT_COLUMNS.has(column))));
    modules.patients = { count: tables.patients.length, tables };
  }

  if (selected.includes('finance')) {
    const source = existing.has('financial_records') ? 'financial_records' : 'external_finance_records';
    const records = await byClinic(source);
    const items = source === 'financial_records' ? await byClinic('financial_items') : [];
    modules.finance = { source_table: source, count: records.length, records, items };
  }

  if (selected.includes('inventory')) {
    const [items, groups, batches, movements] = [
      await byClinic('inventory_items'), await byClinic('inventory_groups'),
      await byClinic('inventory_batches'), await byClinic('inventory_movements'),
    ];
    modules.inventory = {
      items: { count: items.length, data: items },
      groups: { count: groups.length, data: groups },
      batches: { count: batches.length, data: batches },
      movements: { count: movements.length, data: movements },
    };
  }

  if (selected.includes('config')) {
    modules.config = {
      restorable: false,
      clinic: (await rows('clinics', 'SELECT * FROM clinics WHERE id = $1')).map(r => pick(r, SAFE_CLINIC_COLUMNS))[0] || null,
      settings: (await rows('clinic_settings', 'SELECT * FROM clinic_settings WHERE clinic_id = $1'))[0] || null,
      features: await rows('clinic_features', 'SELECT feature, enabled FROM clinic_features WHERE clinic_id = $1 ORDER BY feature'),
      users: (await rows('clinic_users', 'SELECT * FROM clinic_users WHERE clinic_id = $1 ORDER BY id')).map(r => pick(r, SAFE_USER_COLUMNS)),
      staff_resources: await byClinic('clinic_staff_resources'),
      consent_templates: await rows('clinic_consent_templates', 'SELECT template_id FROM clinic_consent_templates WHERE clinic_id = $1 ORDER BY template_id'),
      patient_assignments: await rows('patient_assignments',
        'SELECT pa.* FROM patient_assignments pa JOIN patients p ON p.id = pa.patient_id WHERE p.clinic_id = $1 ORDER BY pa.id'),
      sharing_groups: await byClinic('sharing_groups'),
    };
  }

  if (selected.includes('communications')) {
    const contacts = await byClinic('whatsapp_contacts');
    const messages = contacts.length ? await rows('whatsapp_messages',
      `SELECT id, contact_id, direction, content, media_type, occurred_at, status, appointment_start
       FROM whatsapp_messages WHERE contact_id = ANY($1::bigint[]) ORDER BY id LIMIT ${MAX_ROWS_PER_TABLE + 1}`,
      [contacts.map(c => c.id)]) : [];
    modules.communications = { restorable: false, whatsapp_contacts: contacts,
      whatsapp_messages: checkedRows(messages, 'La tabla whatsapp_messages') };
  }
  return modules;
}

// ── Formato por lotes batch-jsonl-v1 ─────────────────────────────────────────
/**
 * Archivo `.jsonl.gz` (un único stream gzip, NDJSON UTF-8): línea 1 = manifiesto, luego lotes en orden
 * de dependencias y al final un trailer. Cada línea se sella así:
 *   sha256    = SHA-256(JSON.stringify(contenido sin sha256/signature))
 *   signature = HMAC-SHA256(clave de firma, `batch-jsonl-v1:<type>:<sha256>`) o null si no hay clave.
 * Cada lote incluye manifest_sha256; el trailer acredita conteos y la cadena
 *   chain_0 = manifest_sha256, chain_k = SHA-256(`${chain_{k-1}}:${sha256_lote_k}`).
 * La lectura usa una única transacción REPEATABLE READ READ ONLY con cursores (sin OFFSET ni tablas en memoria):
 * un primer pase calcula el plan de lotes (tamaños estimados en Postgres) y el segundo emite exactamente ese plan.
 */
export const BATCH_FORMAT = 'batch-jsonl-v1';
export const BATCH_LIMITS = Object.freeze({
  maxLineBytes: 1024 * 1024,
  targetBatchBytes: 512 * 1024,
  maxBatchRows: 500,
  maxManifestBytes: 256 * 1024,
  maxRequestBytes: 3 * 1024 * 1024,
  maxBatches: 20_000,
});
const ROW_SIZE_MARGIN = 256;
const SIZE_FETCH_ROWS = 5000;
const ENC_STREAM_MAGIC = Buffer.from('BSKE2');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Error con mensaje seguro para el usuario; `details.reason` identifica la causa para la UI. */
export const batchError = (status, reason, message, details = {}) =>
  Object.assign(new Error(message), { status, details: { reason, ...details } });

export const BATCH_RESTORE_ORDER = [...CLINICAL_TABLES, 'financial_records', 'external_finance_records', 'financial_items',
  'inventory_groups', 'inventory_items', 'inventory_batches', 'inventory_movements'];
// Módulos de referencia: se exportan como en v3, pero nunca se restauran automáticamente.
const REFERENCE_SPECS = {
  clinics: ['config', 'SELECT * FROM clinics WHERE id = $1', 'id', row => pick(row, SAFE_CLINIC_COLUMNS)],
  clinic_settings: ['config', 'SELECT * FROM clinic_settings WHERE clinic_id = $1', 'clinic_id'],
  clinic_features: ['config', 'SELECT feature, enabled FROM clinic_features WHERE clinic_id = $1', 'feature'],
  clinic_users: ['config', 'SELECT * FROM clinic_users WHERE clinic_id = $1', 'id', row => pick(row, SAFE_USER_COLUMNS)],
  clinic_staff_resources: ['config', 'SELECT * FROM clinic_staff_resources WHERE clinic_id = $1', 'id'],
  clinic_consent_templates: ['config', 'SELECT template_id FROM clinic_consent_templates WHERE clinic_id = $1', 'template_id'],
  patient_assignments: ['config', 'SELECT pa.* FROM patient_assignments pa JOIN patients p ON p.id = pa.patient_id WHERE p.clinic_id = $1', 'id'],
  sharing_groups: ['config', 'SELECT * FROM sharing_groups WHERE clinic_id = $1', 'id'],
  whatsapp_contacts: ['communications', 'SELECT * FROM whatsapp_contacts WHERE clinic_id = $1', 'id'],
  whatsapp_messages: ['communications', `SELECT m.id, m.contact_id, m.direction, m.content, m.media_type, m.occurred_at, m.status, m.appointment_start
    FROM whatsapp_messages m JOIN whatsapp_contacts c ON c.id = m.contact_id WHERE c.clinic_id = $1`, 'id'],
};
export const BATCH_TABLE_ORDER = [...BATCH_RESTORE_ORDER, ...Object.keys(REFERENCE_SPECS)];
const restoreModuleOf = table => CLINICAL_TABLES.includes(table) ? 'patients' : table.startsWith('inventory_') ? 'inventory' : 'finance';
const moduleOf = table => REFERENCE_SPECS[table]?.[0] ?? restoreModuleOf(table);
const withoutConsentSecrets = row => Object.fromEntries(Object.entries(row).filter(([column]) => !EXCLUDED_CONSENT_COLUMNS.has(column)));

/** Tablas a exportar, en orden canónico de dependencias (mismo alcance que collectClinicData). */
export function batchTableSpecs(selected, existing) {
  const finance = existing.has('financial_records') ? 'financial_records' : 'external_finance_records';
  return BATCH_TABLE_ORDER.flatMap(name => {
    const reference = REFERENCE_SPECS[name];
    const module = moduleOf(name);
    if (!selected.includes(module) || !existing.has(name)) return [];
    if ((name === 'financial_records' || name === 'external_finance_records') && name !== finance) return [];
    if (name === 'financial_items' && finance !== 'financial_records') return [];
    if (name === 'whatsapp_messages' && !existing.has('whatsapp_contacts')) return [];
    if (reference) return [{ name, module, restorable: false, select: reference[1], order: reference[2], project: reference[3] }];
    return [{ name, module, restorable: true, select: `SELECT * FROM ${name} WHERE clinic_id = $1`, order: 'id',
      project: name === 'consent_forms' ? withoutConsentSecrets : undefined }];
  });
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
const lineSignature = (type, hash) => {
  const key = deriveKey('sign');
  return key ? createHmac('sha256', key).update(`${BATCH_FORMAT}:${type}:${hash}`).digest('hex') : null;
};
export const chainBatchHash = (chain, hash) => sha256Hex(`${chain}:${hash}`);

export function sealBatchLine(content) {
  const hash = sha256Hex(JSON.stringify(content));
  return { line: `${JSON.stringify({ ...content, sha256: hash, signature: lineSignature(content.type, hash) })}\n`, sha256: hash };
}

/** Verifica tamaño, JSON, SHA-256 y firma de una línea; devuelve el contenido canónico verificado. */
export function openBatchLine(text, type, maxBytes) {
  if (typeof text !== 'string' || !text.trim()) throw batchError(400, 'MALFORMED', `Falta la línea ${type} del respaldo por lotes`);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw batchError(413, 'SIZE', `La línea ${type} supera ${maxBytes} bytes`);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw batchError(422, 'INTEGRITY', `La línea ${type} no es JSON válido`); }
  if (!isPlainObject(parsed) || parsed.type !== type) throw batchError(422, 'INTEGRITY', `Se esperaba una línea de tipo ${type}`);
  const { sha256, signature, ...content } = parsed;
  if (typeof sha256 !== 'string' || sha256Hex(JSON.stringify(content)) !== sha256)
    throw batchError(422, 'INTEGRITY', `La línea ${type} fue alterada (SHA-256 no coincide)`);
  const expected = lineSignature(type, sha256);
  const status = signature == null ? 'unsigned'
    : typeof signature === 'string' && /^[\da-f]{64}$/i.test(signature) && expected &&
      timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) ? 'valid' : 'invalid';
  return { content, sha256, signature: status };
}

/** Genera las líneas NDJSON. `onComplete` solo se invoca tras emitir el trailer y confirmar la lectura. */
export async function* streamBatchExport(pool, { clinicId, modules, generatedBy = null, kind = 'download', signal,
  budgetMs = BATCH_EXPORT_BUDGET_MS, onComplete } = {}) {
  if (!clinicId) throw new Error('Clínica no identificada');
  const selected = BACKUP_MODULES.filter(module => Array.isArray(modules) && modules.includes(module));
  if (!selected.length) throw new Error('Selecciona al menos un módulo');
  signal ||= AbortSignal.timeout(budgetMs);
  signal?.throwIfAborted();
  const deadline = Date.now() + budgetMs;
  const connection = Promise.resolve().then(() => pool.connect());
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new Error('Presupuesto de exportación agotado'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  let client;
  try { client = await Promise.race([connection, aborted]); }
  catch (error) {
    connection.then(connected => connected.release(), () => undefined)
      .catch(releaseError => console.error('[backup:batch] late connection release failed', releaseError?.name || 'Error'));
    throw error;
  } finally { signal.removeEventListener('abort', onAbort); }
  let open = false;
  let releaseError;
  const query = async (sql, params) => {
    signal?.throwIfAborted();
    const remaining = Math.floor(deadline - Date.now() - 10);
    if (remaining < 1) throw Object.assign(new Error('Batch export query budget exceeded'), { code: '57014' });
    await client.query(`SET LOCAL statement_timeout = ${remaining}`);
    signal?.throwIfAborted();
    const result = await client.query(sql, params);
    if (Date.now() >= deadline) throw Object.assign(new Error('Batch export query budget exceeded'), { code: '57014' });
    signal?.throwIfAborted();
    return result;
  };
  try {
    // The query wrapper can observe cancellation immediately after BEGIN completes.
    open = true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    signal?.throwIfAborted();
    const remaining = Math.floor(deadline - Date.now() - 10);
    if (remaining < 1) throw Object.assign(new Error('Batch export query budget exceeded'), { code: '57014' });
    await client.query(`SET LOCAL statement_timeout = ${remaining}`);
    const existing = new Set((await query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map(row => row.table_name));
    const head = (await query('SELECT now() AS snapshot_at, (SELECT name FROM clinics WHERE id = $1) AS clinic_name', [clinicId])).rows[0];
    const specs = batchTableSpecs(selected, existing);
    const tables = [];
    const plan = [];
    for (const [ti, spec] of specs.entries()) {
      await query(`DECLARE bsk_size_${ti} NO SCROLL CURSOR FOR SELECT octet_length(row_to_json(src)::text) AS b FROM (${spec.select}) AS src ORDER BY src.${spec.order}`, [clinicId]);
      let rows = 0, batches = 0, batchRows = 0, batchBytes = 0;
      for (;;) {
        const page = (await query(`FETCH FORWARD ${SIZE_FETCH_ROWS} FROM bsk_size_${ti}`)).rows;
        for (const { b } of page) {
          const estimate = Number(b) + ROW_SIZE_MARGIN;
          if (batchRows && (batchRows === BATCH_LIMITS.maxBatchRows || batchBytes + estimate > BATCH_LIMITS.targetBatchBytes)) {
            plan.push([ti, batchRows]); batches++; batchRows = 0; batchBytes = 0;
          }
          batchRows++; batchBytes += estimate; rows++;
        }
        if (page.length < SIZE_FETCH_ROWS) break;
      }
      if (batchRows) { plan.push([ti, batchRows]); batches++; }
      await query(`CLOSE bsk_size_${ti}`);
      tables.push({ name: spec.name, module: spec.module, restorable: spec.restorable, rows, batches });
    }
    if (plan.length > BATCH_LIMITS.maxBatches)
      throw batchError(413, 'SIZE', `La exportación requiere más de ${BATCH_LIMITS.maxBatches} lotes; coordina una exportación asistida con soporte.`);
    const financeTable = tables.find(t => t.name === 'financial_records' || t.name === 'external_finance_records')?.name ?? null;
    const counts = Object.fromEntries(tables.map(t => [t.name, t.rows]));
    const timestamp = new Date(head.snapshot_at).toISOString();
    const exportId = randomUUID();
    const manifest = sealBatchLine({
      type: 'manifest', format: BACKUP_FORMAT, batch_format: BATCH_FORMAT, batch_version: 1, schema_version: BACKUP_SCHEMA_VERSION,
      export_id: exportId, clinic_id: clinicId, clinic_name: head.clinic_name ?? null, generated_by: generatedBy, kind, timestamp,
      modules: selected, finance_source_table: financeTable, tables, plan, total_batches: plan.length, counts,
      limits: { max_line_bytes: BATCH_LIMITS.maxLineBytes, max_batch_rows: BATCH_LIMITS.maxBatchRows },
      notes: BACKUP_NOTES, signature_alg: deriveKey('sign') ? 'HMAC-SHA256' : null,
    });
    if (Buffer.byteLength(manifest.line) > BATCH_LIMITS.maxManifestBytes)
      throw batchError(413, 'SIZE', 'El manifiesto supera el tamaño permitido; coordina una exportación asistida con soporte.');
    yield manifest.line;
    let chain = manifest.sha256;
    let index = 0;
    for (const [ti, spec] of specs.entries()) {
      await query(`DECLARE bsk_rows_${ti} NO SCROLL CURSOR FOR SELECT * FROM (${spec.select}) AS src ORDER BY src.${spec.order}`, [clinicId]);
      for (; index < plan.length && plan[index][0] === ti; index++) {
        const count = plan[index][1];
        const rows = (await query(`FETCH FORWARD ${count} FROM bsk_rows_${ti}`)).rows;
        if (rows.length !== count) throw new Error(`La lectura de ${spec.name} no coincide con el plan del snapshot; no se generó el respaldo`);
        const batch = sealBatchLine({ type: 'batch', manifest_sha256: manifest.sha256, index, table: spec.name, count,
          rows: spec.project ? rows.map(spec.project) : rows });
        if (Buffer.byteLength(batch.line) > BATCH_LIMITS.maxLineBytes)
          throw batchError(413, 'SIZE', `Un lote de ${spec.name} supera ${BATCH_LIMITS.maxLineBytes / 1048576} MiB (fila id ${rows[0]?.id ?? '?'}); no se generó el respaldo. Coordina una exportación asistida con soporte.`);
        chain = chainBatchHash(chain, batch.sha256);
        yield batch.line;
      }
      if ((await query(`FETCH FORWARD 1 FROM bsk_rows_${ti}`)).rows.length)
        throw new Error(`La lectura de ${spec.name} excede el plan del snapshot; no se generó el respaldo`);
      await query(`CLOSE bsk_rows_${ti}`);
    }
    yield sealBatchLine({ type: 'trailer', manifest_sha256: manifest.sha256, total_batches: plan.length, counts, chain, complete: true }).line;
    await query('COMMIT');
    open = false;
    onComplete?.({ export_id: exportId, manifest_sha256: manifest.sha256, total_batches: plan.length, counts,
      signed: Boolean(deriveKey('sign')), timestamp });
  } finally {
    if (open) {
      try { await client.query('ROLLBACK'); }
      catch (error) { releaseError = error; console.error('[backup:batch] rollback failed', error?.code || error?.name); }
    }
    client.release(releaseError);
  }
}

/** gzip (y opcionalmente AES-256-GCM en streaming: BSKE2 | iv | ciphertext | tag) con contrapresión. */
export async function* encodeBatchExport(lines, { encrypt = false } = {}) {
  const key = encrypt ? deriveKey('enc') : null;
  if (encrypt && !key) throw new Error('BACKUP_ENCRYPTION_KEY no configurada');
  const gzip = createGzip();
  const iv = randomBytes(12);
  const cipher = key ? createCipheriv('aes-256-gcm', key, iv) : null;
  cipher?.setAAD(ENC_STREAM_MAGIC);
  const output = cipher || gzip;
  // Si el consumidor se detiene (fallo de subida), abortar destruye la fuente y ejecuta el finally del generador (ROLLBACK + release).
  const stop = new AbortController();
  const done = pipeline([Readable.from(lines), gzip, ...(cipher ? [cipher] : [])], { signal: stop.signal }).then(() => null, error => error);
  let finished = false;
  try {
    if (cipher) yield Buffer.concat([ENC_STREAM_MAGIC, iv]);
    for await (const chunk of output) yield chunk;
    const error = await done;
    if (error) throw error;
    if (cipher) yield cipher.getAuthTag();
    finished = true;
  } finally {
    if (!finished) {
      stop.abort();
      const error = await done;
      if (error && error.name !== 'AbortError') console.error('[backup:batch] export stream stopped', error.code || error.name);
    }
  }
}

/** Descifra BSKE2 en streaming; el tag GCM se valida al final y un fallo aborta la publicación. */
export async function* decryptBatchSnapshot(chunks) {
  const key = deriveKey('enc');
  if (!key) throw new Error('No se puede descifrar: clave de respaldo no configurada');
  let header = Buffer.alloc(0);
  let decipher = null;
  let tail = Buffer.alloc(0);
  for await (const raw of chunks) {
    let chunk = Buffer.from(raw);
    if (!decipher) {
      header = Buffer.concat([header, chunk]);
      if (header.length < 17) continue;
      if (!header.subarray(0, 5).equals(ENC_STREAM_MAGIC)) throw new Error('El respaldo por lotes no tiene un formato cifrado reconocido');
      decipher = createDecipheriv('aes-256-gcm', key, header.subarray(5, 17));
      decipher.setAAD(ENC_STREAM_MAGIC);
      chunk = header.subarray(17);
    }
    const data = Buffer.concat([tail, chunk]);
    tail = data.subarray(Math.max(0, data.length - 16));
    const body = data.subarray(0, data.length - tail.length);
    if (body.length) yield decipher.update(body);
  }
  if (!decipher || tail.length !== 16) throw new Error('El respaldo cifrado está incompleto');
  decipher.setAuthTag(tail);
  let last;
  try { last = decipher.final(); }
  catch { throw new Error('El respaldo cifrado fue alterado o pertenece a otra instalación'); }
  if (last.length) yield last;
}

/** Partes de tamaño fijo (R2 exige partes iguales salvo la última); memoria acotada a una parte. */
export async function* fixedSizeParts(chunks, partBytes) {
  let part = Buffer.allocUnsafe(partBytes);
  let used = 0;
  for await (const raw of chunks) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (let offset = 0; offset < chunk.length;) {
      const n = Math.min(partBytes - used, chunk.length - offset);
      chunk.copy(part, used, offset, offset + n);
      used += n; offset += n;
      if (used === partBytes) { yield part; part = Buffer.allocUnsafe(partBytes); used = 0; }
    }
  }
  if (used) yield part.subarray(0, used);
}

/** Valida manifiesto: sello, versión, tenant UUID, orden de dependencias, plan y conteos coherentes. */
export function inspectBatchManifest(text, targetClinicId) {
  const { content: m, sha256, signature } = openBatchLine(text, 'manifest', BATCH_LIMITS.maxManifestBytes);
  if (signature === 'invalid') throw batchError(422, 'INTEGRITY', 'La firma HMAC del manifiesto no es válida; el archivo fue alterado');
  const invalid = message => batchError(422, 'MANIFEST', `Manifiesto inválido: ${message}`);
  if (m.format !== BACKUP_FORMAT || m.batch_format !== BATCH_FORMAT || m.batch_version !== 1) throw invalid('formato no reconocido');
  if (m.schema_version !== BACKUP_SCHEMA_VERSION) throw invalid('versión de esquema incompatible');
  if (typeof m.clinic_id !== 'string' || !UUID_PATTERN.test(m.clinic_id) || typeof m.export_id !== 'string' || !UUID_PATTERN.test(m.export_id))
    throw invalid('identificadores');
  const created = Date.parse(m.timestamp);
  if (!Number.isFinite(created)) throw invalid('fecha');
  if (!Array.isArray(m.modules) || new Set(m.modules).size !== m.modules.length || !m.modules.every(x => BACKUP_MODULES.includes(x)))
    throw invalid('módulos');
  if (!Array.isArray(m.tables)) throw invalid('tablas');
  let lastOrder = -1;
  for (const t of m.tables) {
    const order = isPlainObject(t) ? BATCH_TABLE_ORDER.indexOf(t.name) : -1;
    if (order <= lastOrder) throw invalid('tablas fuera del orden de dependencias, desconocidas o repetidas');
    lastOrder = order;
    if (t.module !== moduleOf(t.name) || t.restorable !== !REFERENCE_SPECS[t.name] || !m.modules.includes(t.module)) throw invalid(`módulo de ${t.name}`);
    if (!Number.isSafeInteger(t.rows) || t.rows < 0 || !Number.isSafeInteger(t.batches) || t.batches < 0) throw invalid(`conteos de ${t.name}`);
  }
  const names = m.tables.map(t => t.name);
  const finance = names.filter(name => name === 'financial_records' || name === 'external_finance_records');
  if ((m.finance_source_table ?? null) !== (finance[0] ?? null)) throw invalid('tabla financiera');
  if (names.includes('financial_items') && finance[0] !== 'financial_records') throw invalid('partidas sin registros financieros estructurados');
  if (!Array.isArray(m.plan) || m.plan.length !== m.total_batches || m.plan.length > BATCH_LIMITS.maxBatches) throw invalid('cantidad de lotes');
  const rows = m.tables.map(() => 0);
  const batches = m.tables.map(() => 0);
  let lastTable = 0;
  for (const entry of m.plan) {
    const [ti, n] = Array.isArray(entry) && entry.length === 2 ? entry : [];
    if (!Number.isSafeInteger(ti) || ti < lastTable || ti >= m.tables.length || !Number.isSafeInteger(n) || n < 1 || n > BATCH_LIMITS.maxBatchRows)
      throw invalid('plan de lotes');
    lastTable = ti; rows[ti] += n; batches[ti]++;
  }
  if (m.tables.some((t, i) => t.rows !== rows[i] || t.batches !== batches[i])) throw invalid('conteos de tablas y plan no coinciden');
  if (!isPlainObject(m.counts) || Object.keys(m.counts).length !== m.tables.length || m.tables.some(t => m.counts[t.name] !== t.rows))
    throw invalid('conteos');
  return {
    manifest: m, sha256, signature,
    info: {
      format: BATCH_FORMAT, export_id: m.export_id, manifest_sha256: sha256, signature,
      sourceClinicId: m.clinic_id, sameClinic: m.clinic_id.toLowerCase() === String(targetClinicId || '').toLowerCase(),
      timestamp: new Date(created).toISOString(), ageDays: Math.floor((Date.now() - created) / 86400000),
      modules: m.modules, counts: m.counts, total_batches: m.total_batches,
      tables: m.tables.map(({ name, restorable, rows: n, batches: b }) => ({ name, restorable, rows: n, batches: b })),
    },
  };
}

const BATCH_KEYS = 'type,manifest_sha256,index,table,count,rows';
/** Verifica un lote contra el manifiesto verificado y el índice esperado (sin omisiones ni repeticiones). */
export function openBatch(text, ctx, expectedIndex) {
  const { content: b, sha256, signature } = openBatchLine(text, 'batch', BATCH_LIMITS.maxLineBytes);
  if (signature === 'invalid') throw batchError(422, 'INTEGRITY', 'La firma HMAC del lote no es válida; el archivo fue alterado');
  if (Object.keys(b).join(',') !== BATCH_KEYS) throw batchError(422, 'INTEGRITY', 'Estructura de lote no reconocida');
  if (b.manifest_sha256 !== ctx.sha256) throw batchError(422, 'INTEGRITY', 'El lote pertenece a otro manifiesto');
  if (ctx.signature === 'valid' && signature !== 'valid') throw batchError(422, 'INTEGRITY', 'La firma del lote no es válida; el archivo fue alterado');
  if (b.index !== expectedIndex)
    throw batchError(409, 'SEQUENCE', `Se esperaba el lote ${expectedIndex}; no se permiten lotes omitidos ni repetidos`, { expected_index: expectedIndex });
  const [ti, count] = ctx.manifest.plan[b.index];
  const table = ctx.manifest.tables[ti];
  if (b.table !== table.name || b.count !== count || !Array.isArray(b.rows) || b.rows.length !== count)
    throw batchError(422, 'COUNT', `El lote ${b.index} no coincide con la tabla o el conteo del manifiesto`);
  if (!b.rows.every(isPlainObject)) throw batchError(422, 'INTEGRITY', `El lote ${b.index} contiene filas inválidas`);
  const source = ctx.manifest.clinic_id.toLowerCase();
  if (table.restorable && b.rows.some(row => typeof row.clinic_id !== 'string' || row.clinic_id.toLowerCase() !== source))
    throw batchError(422, 'TENANT', `El lote ${b.index} contiene filas de otra clínica`);
  return { batch: b, sha256, table };
}

export function openBatchTrailer(text, ctx, chain) {
  const { content: t, signature } = openBatchLine(text, 'trailer', BATCH_LIMITS.maxManifestBytes);
  if (signature === 'invalid') throw batchError(422, 'INTEGRITY', 'La firma HMAC del trailer no es válida; el archivo fue alterado');
  if (ctx.signature === 'valid' && signature !== 'valid') throw batchError(422, 'INTEGRITY', 'La firma del trailer no es válida');
  if (t.manifest_sha256 !== ctx.sha256 || t.total_batches !== ctx.manifest.total_batches || t.complete !== true ||
      t.chain !== chain || JSON.stringify(t.counts) !== JSON.stringify(ctx.manifest.counts))
    throw batchError(422, 'TRAILER', 'El trailer no acredita los lotes procesados; el archivo está incompleto o alterado');
  return t;
}

// Token de reanudación: payload JSON en base64url + HMAC (clave derivada distinta de firma/cifrado). Sin tablas.
export function signRestoreToken(payload) {
  const key = deriveKey('restore-token');
  if (!key) throw batchError(503, 'KEY', 'El cifrado de respaldos no está configurado. Contacta a soporte.');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', key).update(`bsk-restore-token:${body}`).digest('base64url')}`;
}

export function openRestoreToken(token, now = Date.now()) {
  const key = deriveKey('restore-token');
  if (!key) throw batchError(503, 'KEY', 'El cifrado de respaldos no está configurado. Contacta a soporte.');
  const invalid = () => batchError(409, 'TOKEN', 'El token de reanudación es inválido o venció; reinicia la restauración desde el lote 0');
  if (typeof token !== 'string' || token.length > 4096) throw invalid();
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) throw invalid();
  const expected = createHmac('sha256', key).update(`bsk-restore-token:${body}`).digest('base64url');
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw invalid();
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload?.v !== 1 || !(payload.exp > now)) throw invalid();
  return payload;
}

// ── CSV para Excel/Sheets (consulta, no restauración) ─────────────────────────
// Excel en configuración regional de Ecuador separa listas con ";"; con "," abre todo en una sola columna.
const csvCell = value => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (headers, data) => `\uFEFF${[headers, ...data].map(r => r.map(csvCell).join(';')).join('\r\n')}`;
const day = value => (value instanceof Date ? value.toISOString() : String(value ?? '')).split('T')[0];

export const CSV_DATASETS = {
  patients: {
    label: 'pacientes',
    query: `SELECT first_name, last_name, identification_type, COALESCE(identification_number, rut) AS identification_number,
              email, phone, birth_date, gender, estado_civil, tipo_sangre, occupation, address, created_at
            FROM patients WHERE clinic_id = $1 ORDER BY last_name, first_name`,
    headers: ['nombres', 'apellidos', 'tipo_identificacion', 'numero_identificacion', 'email', 'telefono', 'fecha_nacimiento',
      'genero', 'estado_civil', 'tipo_sangre', 'ocupacion', 'direccion', 'registrado'],
    map: r => [r.first_name, r.last_name, r.identification_type, r.identification_number, r.email, r.phone, day(r.birth_date),
      r.gender, r.estado_civil, r.tipo_sangre, r.occupation, r.address, day(r.created_at)],
  },
  treatments: {
    label: 'tratamientos',
    query: `SELECT p.first_name, p.last_name, COALESCE(p.identification_number, p.rut) AS identification_number, t.date,
              t.procedure_name, t.area_treated, t.equipment_used, t.duration_minutes, t.cost, t.performed_by, t.notes
            FROM treatments t JOIN clinical_records cr ON cr.id = t.record_id JOIN patients p ON p.id = cr.patient_id
            WHERE t.clinic_id = $1 ORDER BY t.date DESC`,
    headers: ['nombres', 'apellidos', 'identificacion', 'fecha', 'procedimiento', 'zona', 'equipo', 'duracion_min', 'costo', 'realizado_por', 'notas'],
    map: r => [r.first_name, r.last_name, r.identification_number, day(r.date), r.procedure_name, r.area_treated,
      r.equipment_used, r.duration_minutes, r.cost, r.performed_by, r.notes],
  },
  finance: {
    label: 'finanzas',
    query: 'SELECT date, invoice_number, entity, description, type, subtotal, tax, total, registered_by, status FROM financial_records WHERE clinic_id = $1 ORDER BY date DESC',
    headers: ['fecha', 'factura', 'entidad', 'descripcion', 'tipo', 'subtotal', 'iva', 'total', 'registrado_por', 'estado'],
    map: r => [day(r.date), r.invoice_number, r.entity, r.description, r.type, r.subtotal, r.tax, r.total, r.registered_by, r.status],
  },
  inventory: {
    label: 'inventario',
    query: `SELECT i.sku, i.name, i.brand, i.category, i.group_name, i.unit_of_measure, i.is_archived,
              b.batch_number, b.expiration_date, b.quantity_current, b.cost_per_unit, b.status
            FROM inventory_items i LEFT JOIN inventory_batches b ON b.item_id = i.id AND b.clinic_id = i.clinic_id
            WHERE i.clinic_id = $1 ORDER BY i.name, b.expiration_date`,
    headers: ['sku', 'producto', 'marca', 'categoria', 'subcategoria', 'unidad', 'archivado', 'lote', 'vencimiento', 'stock_lote', 'costo_unitario', 'estado_lote'],
    map: r => [r.sku, r.name, r.brand, r.category, r.group_name, r.unit_of_measure, r.is_archived ? 'si' : 'no',
      r.batch_number, day(r.expiration_date), r.quantity_current, r.cost_per_unit, r.status],
  },
};

export async function buildDatasetCsv(pool, dataset, clinicId) {
  const def = CSV_DATASETS[dataset];
  if (!def) throw new Error('Conjunto de datos no válido');
  const { rows } = await pool.query(`${def.query} LIMIT ${MAX_ROWS_PER_TABLE + 1}`, [clinicId]);
  checkedRows(rows, `El CSV de ${def.label}`);
  return { filename: `bioskintech-${def.label}-${new Date().toISOString().split('T')[0]}.csv`, csv: toCsv(def.headers, rows.map(def.map)), count: rows.length };
}

// ── Importación de pacientes desde plantilla CSV ──────────────────────────────
// [columna, obligatorio, descripción, ejemplo] — la misma definición alimenta la plantilla, la UI y la validación.
export const PATIENT_TEMPLATE_COLUMNS = [
  ['nombres', true, 'Nombres del paciente', 'Ana María'],
  ['apellidos', true, 'Apellidos del paciente', 'Pérez López'],
  ['tipo_identificacion', false, 'cedula o ruc. Si se deja vacío se detecta por la cantidad de dígitos (10 = cédula, 13 = RUC)', 'cedula'],
  ['numero_identificacion', true, 'Solo números. Si Excel quita el cero inicial, el sistema lo corrige', '0102030405'],
  ['email', false, 'Correo electrónico', 'ana@correo.com'],
  ['telefono', false, 'Celular o teléfono', '0991234567'],
  ['fecha_nacimiento', false, 'DD/MM/AAAA o AAAA-MM-DD', '15/03/1990'],
  ['genero', false, 'Femenino, Masculino u Otro', 'Femenino'],
  ['estado_civil', false, 'Texto libre', 'Soltera'],
  ['tipo_sangre', false, 'Ej.: O+, A-', 'O+'],
  ['ocupacion', false, 'Texto libre', 'Docente'],
  ['direccion', false, 'Texto libre', 'Av. Solano 1-23, Cuenca'],
  ['alergias', false, 'Antecedente: alergias conocidas', 'Penicilina'],
  ['medicacion_actual', false, 'Antecedente: medicamentos actuales', 'Anticonceptivo oral'],
  ['antecedentes_patologicos', false, 'Antecedente: enfermedades, hospitalizaciones', 'Hipotiroidismo'],
  ['antecedentes_quirurgicos', false, 'Antecedente: cirugías previas', 'Apendicectomía 2015'],
  ['antecedentes_familiares', false, 'Antecedente: enfermedades familiares', 'Diabetes (madre)'],
  ['habitos', false, 'Antecedente: tabaco, alcohol, ejercicio, alimentación', 'No fuma'],
  ['antecedentes_esteticos', false, 'Antecedente: tratamientos estéticos previos', 'Toxina botulínica 2024'],
  ['antecedentes_gineco_obstetricos', false, 'Antecedente: FUM, embarazos, anticoncepción', 'G1 P1'],
  ['rutina_facial', false, 'Antecedente: rutina de cuidado facial', 'Limpieza y protector solar'],
];
const HISTORY_FIELDS = {
  alergias: 'allergies', medicacion_actual: 'current_medications', antecedentes_patologicos: 'pathological',
  antecedentes_quirurgicos: 'surgical_history', antecedentes_familiares: 'family_history', habitos: 'non_pathological',
  antecedentes_esteticos: 'aesthetic_history', antecedentes_gineco_obstetricos: 'gynecological_history', rutina_facial: 'facial_routine',
};
export const TEMPLATE_EXAMPLE_PREFIX = 'EJEMPLO';

export function buildPatientTemplateCsv() {
  const example = (suffix, overrides = {}) => PATIENT_TEMPLATE_COLUMNS.map(([name, , , value]) =>
    name === 'nombres' ? `${TEMPLATE_EXAMPLE_PREFIX} ${suffix} (borre esta fila)` : overrides[name] ?? value);
  return toCsv(PATIENT_TEMPLATE_COLUMNS.map(([name]) => name), [
    example('1'),
    example('2', { tipo_identificacion: '', numero_identificacion: '0912345678', email: '', telefono: '', fecha_nacimiento: '',
      alergias: '', medicacion_actual: '', antecedentes_patologicos: '', antecedentes_quirurgicos: '', antecedentes_familiares: '',
      habitos: '', antecedentes_esteticos: '', antecedentes_gineco_obstetricos: '', rutina_facial: '', estado_civil: '', tipo_sangre: '', ocupacion: '', direccion: '' }),
  ]);
}

export const isTemplateExampleRow = raw => String(raw?.nombres ?? '').trim().toUpperCase().startsWith(TEMPLATE_EXAMPLE_PREFIX);

/** Cédula ecuatoriana: provincia 01-24 o 30, tercer dígito < 6 y dígito verificador módulo 10. */
export function isValidEcuadorCedula(cedula) {
  if (!/^\d{10}$/.test(cedula)) return false;
  const province = Number(cedula.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30) || Number(cedula[2]) > 5) return false;
  const sum = [...cedula.slice(0, 9)].reduce((acc, d, i) => {
    const n = Number(d) * (i % 2 === 0 ? 2 : 1);
    return acc + (n > 9 ? n - 9 : n);
  }, 0);
  return (10 - (sum % 10)) % 10 === Number(cedula[9]);
}

const GENDERS = new Map([['femenino', 'Femenino'], ['f', 'Femenino'], ['masculino', 'Masculino'], ['m', 'Masculino'], ['otro', 'Otro']]);
const text = (value, max) => {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^'(?=[=+\-@])/, '');
  return clean.length > max ? undefined : clean || null;
};

/** Normaliza una fila de la plantilla; devuelve { patient, history } o { error } legible para el usuario. */
export function validatePatientImportRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Fila inválida' };
  const first_name = text(raw.nombres, 100);
  const last_name = text(raw.apellidos, 100);
  if (!first_name || !last_name) return { error: 'Nombres y apellidos son obligatorios (máx. 100 caracteres)' };
  const digits = String(raw.numero_identificacion ?? '').replace(/\D/g, '');
  let identification_type = String(raw.tipo_identificacion ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!identification_type) identification_type = [9, 10].includes(digits.length) ? 'cedula' : [12, 13].includes(digits.length) ? 'ruc' : '';
  if (identification_type !== 'cedula' && identification_type !== 'ruc') return { error: 'Tipo de identificación inválido: use cedula o ruc' };
  // Excel elimina el cero inicial de cédulas/RUC de provincias 01-09.
  const padded = (identification_type === 'cedula' && digits.length === 9) || (identification_type === 'ruc' && digits.length === 12) ? `0${digits}` : raw.numero_identificacion;
  const identification_number = normalizeEcuadorIdentification(identification_type, padded);
  if (!identification_number) return { error: `Identificación inválida: la ${identification_type === 'ruc' ? 'RUC debe tener 13' : 'cédula debe tener 10'} dígitos` };
  if (!isValidEcuadorCedula(identification_number.slice(0, 10)) && identification_type === 'cedula')
    return { error: 'Cédula inválida (el dígito verificador no coincide)' };
  const email = text(raw.email, 150);
  if (email === undefined || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: 'Correo inválido' };
  const phone = text(raw.telefono, 30);
  if (phone === undefined || (phone && !/^[0-9+()\-\s]{7,20}$/.test(phone))) return { error: 'Teléfono inválido' };
  let birth_date = text(raw.fecha_nacimiento, 10);
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(birth_date || '');
  if (dmy) birth_date = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (birth_date) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(birth_date) ? new Date(`${birth_date}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birth_date ||
        parsed.getUTCFullYear() < 1900 || parsed > new Date()) return { error: 'Fecha de nacimiento inválida (use DD/MM/AAAA o AAAA-MM-DD)' };
  } else birth_date = null;
  const genderRaw = String(raw.genero ?? '').trim().toLowerCase();
  if (genderRaw && !GENDERS.has(genderRaw)) return { error: 'Género inválido (Femenino, Masculino u Otro)' };
  const optional = { estado_civil: text(raw.estado_civil, 50), tipo_sangre: text(raw.tipo_sangre, 10), occupation: text(raw.ocupacion, 100), address: text(raw.direccion, 500) };
  if (Object.values(optional).some(v => v === undefined)) return { error: 'Un campo opcional excede la longitud permitida' };
  const history = {};
  for (const [column, field] of Object.entries(HISTORY_FIELDS)) {
    const value = text(raw[column], 2000);
    if (value === undefined) return { error: `El antecedente "${column}" supera 2000 caracteres` };
    if (value) history[field] = value;
  }
  return {
    patient: { first_name, last_name, identification_type, identification_number, email: email?.toLowerCase() || null, phone, birth_date, gender: GENDERS.get(genderRaw) || null, ...optional },
    history: Object.keys(history).length ? history : null,
  };
}

// ── Consentimientos legibles (HTML autocontenido, imprimible a PDF) ──────────
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAFE_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_CONSENTS_PER_FILE = 100;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/**
 * Versión liviana de una firma para el documento legible: recorta el lienzo vacío y reduce a máx. 600 px.
 * El original en la base (y su hash de evidencia) no se toca. Ante cualquier formato inesperado devuelve el original.
 */
export function compactSignatureDataUrl(dataUrl, maxWidth = 600) {
  try {
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0 || w * h > 16_000_000) return dataUrl;
    const idat = [];
    for (let off = 8; off + 12 <= png.length;) {
      const len = png.readUInt32BE(off), type = png.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const stride = w * 4;
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * h });
    const px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? px[row + x - 4] : 0, b = y ? px[row - stride + x] : 0, c = x >= 4 && y ? px[row - stride + x - 4] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
        px[row + x] = (raw[src + x] + pred) & 0xff;
      }
    }
    const ink = i => px[i + 3] > 16 && !(px[i] > 235 && px[i + 1] > 235 && px[i + 2] > 235);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink(y * stride + x * 4)) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return dataUrl;
    const pad = 10;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const step = Math.max(1, Math.ceil((x1 - x0 + 1) / maxWidth));
    const ow = Math.ceil((x1 - x0 + 1) / step), oh = Math.ceil((y1 - y0 + 1) / step);
    const out = Buffer.alloc((ow * 4 + 1) * oh);
    for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
      // Max-pooling por alfa: conserva trazos finos que un promedio borraría.
      let best = -1;
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
        const sx = x0 + ox * step + dx, sy = y0 + oy * step + dy;
        if (sx > x1 || sy > y1) continue;
        const i = sy * stride + sx * 4;
        if (best < 0 || px[i + 3] > px[best + 3]) best = i;
      }
      px.copy(out, oy * (ow * 4 + 1) + 1 + ox * 4, best, best + 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4); ihdr.set([8, 6, 0, 0, 0], 8);
    const result = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(out, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
    return result.length < png.length ? `data:image/png;base64,${result.toString('base64')}` : dataUrl;
  } catch {
    return dataUrl;
  }
}
const choice = v => (v === true ? 'Sí' : v === false ? 'No' : 'No especificado');
const lines = value => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'boolean' ? choice(v) : Array.isArray(v) ? v.join(', ') : String(v ?? '')}`);
  return value == null ? [] : [String(value)];
};
const CONSENT_SECTIONS = [['objectives', 'Objetivos'], ['risks', 'Riesgos y complicaciones'], ['benefits', 'Beneficios esperados'],
  ['alternatives', 'Alternativas'], ['pre_care', 'Cuidados previos'], ['post_care', 'Cuidados posteriores'], ['contraindications', 'Contraindicaciones']];
const DECLARATIONS = [['understanding', 'Recibió información clara y completa del tratamiento'], ['questions', 'Tuvo oportunidad de hacer preguntas'],
  ['results', 'Comprende que los resultados pueden variar'], ['authorization', 'Autoriza voluntariamente el tratamiento'],
  ['revocation', 'Conoce su derecho a revocar el consentimiento'], ['alternatives', 'Conoce las alternativas, incluida no tratarse']];
const AUTHORIZATIONS = [['privacy_policy', 'Acepta la Política de Privacidad'], ['image_use', 'Autoriza uso de imágenes con fines educativos o promocionales'],
  ['photo_video', 'Autoriza fotografías o videos para el registro clínico']];
const fmt = value => (value ? new Date(value).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'long', timeStyle: 'short' }) : '—');

const SIGNED_CONSENT_FILTER = `(cf.signing_status = 'signed' OR cf.status IN ('signed', 'finalized', 'annulled')
        OR NULLIF(cf.signatures->>'patient_sig_data', '') IS NOT NULL)`;

export async function listConsentPatients(pool, clinicId) {
  const { rows } = await pool.query(`SELECT p.id, p.first_name, p.last_name, COALESCE(p.identification_number, p.rut) AS identification,
      COUNT(*)::int AS consents, MAX(cf.created_at) AS last_consent
    FROM consent_forms cf JOIN patients p ON p.id = cf.patient_id
    WHERE cf.clinic_id = $1 AND p.clinic_id = $1 AND ${SIGNED_CONSENT_FILTER}
    GROUP BY p.id ORDER BY p.last_name, p.first_name, p.id LIMIT ${MAX_ROWS_PER_TABLE + 1}`, [clinicId]);
  return checkedRows(rows, 'La lista de pacientes con consentimientos').map(row => ({ ...row, count: row.consents }));
}

export function validateConsentPage({ patientIds = null, offset = 0, limit = MAX_CONSENTS_PER_FILE, revision = null } = {}) {
  if (patientIds !== null && (!Array.isArray(patientIds) || !patientIds.length || patientIds.length > 5000 ||
      !patientIds.every(id => Number.isSafeInteger(id) && id > 0)))
    throw new Error('Selección de pacientes inválida');
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONSENTS_PER_FILE)
    throw new Error(`Paginación inválida: offset entero >= 0 y limit entre 1 y ${MAX_CONSENTS_PER_FILE}`);
  if ((revision !== null && (typeof revision !== 'string' || !/^[a-f0-9]{32}$/.test(revision))) ||
      (offset > 0 && revision === null))
    throw new Error('Las partes siguientes requieren la revision devuelta por la primera parte');
  return { patientIds, offset, limit, revision };
}

/**
 * Una sola sentencia toma un snapshot coherente del conjunto y de la página.
 * La revisión de IDs impide avanzar offsets si se añadieron/eliminaron consentimientos:
 * el cliente debe descartar las partes anteriores y reiniciar, nunca omitir filas.
 */
export async function buildConsentsPage(pool, clinicId, options = {}) {
  const { patientIds, offset, limit, revision } = validateConsentPage(options);
  const [result, clinic] = await Promise.all([
    pool.query(`WITH selected AS MATERIALIZED (
      SELECT cf.id
      FROM consent_forms cf JOIN patients p ON p.id = cf.patient_id
      WHERE cf.clinic_id = $1 AND p.clinic_id = $1 AND ${SIGNED_CONSENT_FILTER}
        AND ($2::int[] IS NULL OR cf.patient_id = ANY($2::int[]))
    ), totals AS (
      SELECT COUNT(*)::int AS export_count,
        md5(COALESCE(string_agg(id::text, ',' ORDER BY id), '')) AS export_revision FROM selected
    )
    SELECT page.*, totals.export_count, totals.export_revision FROM totals
      LEFT JOIN LATERAL (
        SELECT cf.*, p.first_name, p.last_name, COALESCE(p.identification_number, p.rut) AS patient_identification
        FROM (SELECT id FROM selected ORDER BY id LIMIT $3 OFFSET $4) ids
        JOIN consent_forms cf ON cf.id = ids.id JOIN patients p ON p.id = cf.patient_id
        ORDER BY cf.id
      ) page ON TRUE
    ORDER BY page.id`, [clinicId, patientIds, limit, offset]),
    pool.query('SELECT name FROM clinics WHERE id = $1', [clinicId]),
  ]);
  const count = result.rows[0].export_count;
  const currentRevision = result.rows[0].export_revision;
  if (revision !== null && revision !== currentRevision)
    throw Object.assign(new Error('La selección de consentimientos cambió; descarta las partes anteriores y reinicia desde offset 0'), { status: 409 });
  const rows = result.rows.filter(row => row.id != null);
  const hasMore = offset + rows.length < count;
  return { html: renderConsentsHtml(rows, clinic), count, returnedCount: rows.length, offset, limit,
    hasMore, nextOffset: hasMore ? offset + rows.length : null, revision: currentRevision };
}

/** patientIds = null exporta todos; un arreglo limita a esos pacientes (siempre dentro de la clínica). */
export async function buildConsentsHtml(pool, clinicId, patientIds = null) {
  validateConsentPage({ patientIds });
  const [{ rows }, clinic] = await Promise.all([
    pool.query(`SELECT cf.*, p.first_name, p.last_name, COALESCE(p.identification_number, p.rut) AS patient_identification
      FROM consent_forms cf JOIN patients p ON p.id = cf.patient_id
      WHERE cf.clinic_id = $1 AND p.clinic_id = $1 AND ${SIGNED_CONSENT_FILTER} AND ($2::int[] IS NULL OR cf.patient_id = ANY($2::int[]))
      ORDER BY cf.id LIMIT ${MAX_CONSENTS_PER_FILE + 1}`, [clinicId, patientIds]),
    pool.query('SELECT name FROM clinics WHERE id = $1', [clinicId]),
  ]);
  if (rows.length > MAX_CONSENTS_PER_FILE)
    throw new Error(`La selección supera ${MAX_CONSENTS_PER_FILE} consentimientos; descárgala en varias partes`);
  return renderConsentsHtml(rows, clinic);
}

function renderConsentsHtml(rows, clinic) {
  const compacted = new Map();
  const img = (src, alt) => {
    if (typeof src !== 'string' || !SAFE_PNG.test(src)) return '<p class="muted">Sin firma registrada</p>';
    if (!compacted.has(src)) compacted.set(src, compactSignatureDataUrl(src));
    return `<img src="${compacted.get(src)}" alt="${esc(alt)}">`;
  };
  const docs = rows.map(c => {
    const s = c.signatures || {};
    const annulled = c.status === 'annulled' || c.annulled_at;
    const sections = CONSENT_SECTIONS.map(([key, title]) => {
      const items = lines(c[key]);
      return items.length ? `<h3>${title}</h3><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
    }).join('');
    const ant = c.critical_antecedents;
    const antHtml = ant ? `<h3>Antecedentes críticos</h3><p>Alergias: ${esc(ant.allergies || 'Niega')} · Medicación: ${esc(ant.medications || 'Niega')} · Embarazo/lactancia: ${choice(ant.pregnancy)} · Herpes: ${choice(ant.herpes)}</p>` : '';
    const list = (title, defs, values) => `<h3>${title}</h3><table>${defs.map(([k, label]) => `<tr><td>${label}</td><td><b>${choice(values?.[k])}</b></td></tr>`).join('')}</table>`;
    return `<article>
      ${annulled ? `<div class="annulled">DOCUMENTO ANULADO ${c.annulled_at ? `el ${esc(fmt(c.annulled_at))}` : ''}${c.annulment_reason ? ` — Motivo: ${esc(c.annulment_reason)}` : ''}</div>` : ''}
      <h2>${esc(c.procedure_type || c.form_type || 'Consentimiento informado')}</h2>
      <p><b>Paciente:</b> ${esc(`${c.first_name} ${c.last_name}`)} · <b>Identificación:</b> ${esc(c.patient_identification || '—')}</p>
      <p><b>Zona:</b> ${esc(c.zone || '—')} · <b>Sesiones:</b> ${esc(c.sessions ?? '—')} · <b>Creado:</b> ${esc(fmt(c.created_at))}</p>
      ${c.description ? `<h3>Descripción</h3><p>${esc(c.description)}</p>` : ''}
      ${c.content_text ? `<p>${esc(c.content_text)}</p>` : ''}
      ${sections}${antHtml}
      ${list('Declaraciones del paciente', DECLARATIONS, c.declarations)}
      ${list('Autorizaciones', AUTHORIZATIONS, c.authorizations)}
      <div class="signs">
        <div><h4>Paciente: ${esc(s.patient_name || `${c.first_name} ${c.last_name}`)}</h4>${img(s.patient_sig_data || c.signature_data, 'Firma del paciente')}<p class="muted">Firmado: ${esc(fmt(s.patient_signed_at || c.signing_signed_at || c.signed_at))}</p></div>
        <div><h4>Profesional: ${esc(s.professional_name || '—')}</h4>${img(s.professional_sig_data, 'Firma del profesional')}${s.witness_name ? `<p class="muted">Asistió: ${esc(s.witness_name)}</p>` : ''}</div>
      </div>
      <p class="muted">Huella de integridad (SHA-256): ${esc(c.signing_hash || c.signing_snapshot_hash || 'no disponible (firma anterior al registro de evidencia)')}</p>
    </article>`;
  }).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Consentimientos firmados</title>
<meta name="robots" content="noindex"><style>
body{font-family:Arial,Helvetica,sans-serif;color:#222;max-width:820px;margin:24px auto;padding:0 16px;font-size:13px}
header{border-bottom:2px solid #deb887;margin-bottom:16px}article{page-break-after:always;border-bottom:1px dashed #ccc;padding:16px 0}
h2{margin:4px 0;font-size:18px}h3{font-size:13px;margin:12px 0 4px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #eee;padding:3px}
.signs{display:flex;gap:24px;margin-top:16px}.signs div{flex:1;border:1px solid #ddd;padding:8px}.signs img{max-width:100%;max-height:120px}
.muted{color:#777;font-size:11px}.annulled{background:#fde2e2;color:#a00;padding:6px;font-weight:bold}
@media print{header p.tip{display:none}}</style></head><body>
<header><h1>Consentimientos informados firmados</h1><p>${esc(clinic.rows[0]?.name || '')} · Generado el ${esc(fmt(new Date()))} · ${rows.length} documento(s)</p>
<p class="muted tip">Para guardar como PDF use Imprimir → Guardar como PDF. Copia legible generada desde BioSkinTech: las firmas se muestran recortadas y reducidas para visualización; la firma original y su huella de integridad permanecen en el sistema.</p></header>
${docs || '<p>No hay consentimientos firmados.</p>'}</body></html>`;
}
