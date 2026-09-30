/**
 * Motor de respaldos por clínica: recolección, firma HMAC, cifrado AES-256-GCM, compresión y CSV.
 * Todo respaldo es por tenant (clinic_id); nunca exporta credenciales, tokens ni secretos de firma.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { escapeCsvCell } from './finance-csv.js';
import { normalizeEcuadorIdentification } from './consent-signing.js';

export const BACKUP_FORMAT = 'bioskintech-backup';
export const BACKUP_SCHEMA_VERSION = 3;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_JSON_BYTES = 200 * 1024 * 1024;
export const MAX_ROWS_PER_TABLE = 50_000;
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
  'La agenda vive en Google Calendar de cada profesional y no forma parte de este archivo.',
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

export const compressBackup = doc => gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));

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

export async function collectClinicData(pool, clinicId, selected = BACKUP_MODULES) {
  if (!clinicId) throw new Error('Clínica no identificada');
  const existing = new Set((await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  )).rows.map(r => r.table_name));
  const rows = async (table, query, params = [clinicId]) => existing.has(table) ? (await pool.query(query, params)).rows : [];
  const byClinic = table => rows(table, `SELECT * FROM ${table} WHERE clinic_id = $1 ORDER BY id LIMIT ${MAX_ROWS_PER_TABLE}`);
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
       FROM whatsapp_messages WHERE contact_id = ANY($1::bigint[]) ORDER BY id LIMIT ${MAX_ROWS_PER_TABLE}`,
      [contacts.map(c => c.id)]) : [];
    modules.communications = { restorable: false, whatsapp_contacts: contacts, whatsapp_messages: messages };
  }
  return modules;
}

// ── CSV para Excel/Sheets (consulta, no restauración) ─────────────────────────
const toCsv = (headers, data) => `\uFEFF${[headers, ...data].map(r => r.map(escapeCsvCell).join(',')).join('\r\n')}`;
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
  const { rows } = await pool.query(`${def.query} LIMIT ${MAX_ROWS_PER_TABLE}`, [clinicId]);
  return { filename: `bioskintech-${def.label}-${new Date().toISOString().split('T')[0]}.csv`, csv: toCsv(def.headers, rows.map(def.map)), count: rows.length };
}

// ── Importación de pacientes desde plantilla CSV ──────────────────────────────
export const PATIENT_TEMPLATE_HEADERS = CSV_DATASETS.patients.headers.slice(0, -1);
const GENDERS = new Map([['femenino', 'Femenino'], ['masculino', 'Masculino'], ['otro', 'Otro']]);
const text = (value, max) => {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^'(?=[=+\-@])/, '');
  return clean.length > max ? undefined : clean || null;
};

/** Normaliza una fila de la plantilla; devuelve { patient } o { error } legible para el usuario. */
export function validatePatientImportRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Fila inválida' };
  const first_name = text(raw.nombres, 100);
  const last_name = text(raw.apellidos, 100);
  if (!first_name || !last_name) return { error: 'Nombres y apellidos son obligatorios (máx. 100 caracteres)' };
  const identification_type = String(raw.tipo_identificacion ?? '').trim().toLowerCase();
  const digits = String(raw.numero_identificacion ?? '').replace(/\D/g, '');
  // Excel elimina el cero inicial de cédulas/RUC de provincias 01-09.
  const padded = (identification_type === 'cedula' && digits.length === 9) || (identification_type === 'ruc' && digits.length === 12) ? `0${digits}` : raw.numero_identificacion;
  const identification_number = normalizeEcuadorIdentification(identification_type, padded);
  if (!identification_number) return { error: 'Identificación inválida: use cedula (10 dígitos) o ruc (13 dígitos)' };
  const email = text(raw.email, 150);
  if (email === undefined || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: 'Correo inválido' };
  const phone = text(raw.telefono, 30);
  if (phone === undefined || (phone && !/^[0-9+()\-\s]{7,20}$/.test(phone))) return { error: 'Teléfono inválido' };
  let birth_date = text(raw.fecha_nacimiento, 10);
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(birth_date || '');
  if (dmy) birth_date = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (birth_date) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(birth_date) ? new Date(`${birth_date}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birth_date ||
        parsed.getUTCFullYear() < 1900 || parsed > new Date()) return { error: 'Fecha de nacimiento inválida (use AAAA-MM-DD o DD/MM/AAAA)' };
  } else birth_date = null;
  const genderRaw = String(raw.genero ?? '').trim().toLowerCase();
  if (genderRaw && !GENDERS.has(genderRaw)) return { error: 'Género inválido (Femenino, Masculino u Otro)' };
  const optional = { estado_civil: text(raw.estado_civil, 50), tipo_sangre: text(raw.tipo_sangre, 10), occupation: text(raw.ocupacion, 100), address: text(raw.direccion, 500) };
  if (Object.values(optional).some(v => v === undefined)) return { error: 'Un campo opcional excede la longitud permitida' };
  return { patient: { first_name, last_name, identification_type, identification_number, email: email?.toLowerCase() || null, phone, birth_date, gender: GENDERS.get(genderRaw) || null, ...optional } };
}
