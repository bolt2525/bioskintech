/**
 * Motor de respaldos por clínica: recolección, firma HMAC, cifrado AES-256-GCM, compresión y CSV.
 * Todo respaldo es por tenant (clinic_id); nunca exporta credenciales, tokens ni secretos de firma.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
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

/** Lee todo en una sola transacción REPEATABLE READ de solo lectura: la copia refleja un instante coherente aunque haya escrituras en curso. */
export async function collectClinicData(pool, clinicId, selected = BACKUP_MODULES) {
  if (!clinicId) throw new Error('Clínica no identificada');
  if (typeof pool.connect !== 'function') return collectWith(pool, clinicId, selected);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const modules = await collectWith(client, clinicId, selected);
    await client.query('COMMIT');
    return modules;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function collectWith(pool, clinicId, selected) {
  const existing = new Set((await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  )).rows.map(r => r.table_name));
  const rows = async (table, query, params = [clinicId]) => existing.has(table) ? (await pool.query(query, params)).rows : [];
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
       FROM whatsapp_messages WHERE contact_id = ANY($1::bigint[]) ORDER BY id LIMIT ${MAX_ROWS_PER_TABLE}`,
      [contacts.map(c => c.id)]) : [];
    modules.communications = { restorable: false, whatsapp_contacts: contacts, whatsapp_messages: messages };
  }
  return modules;
}

// ── CSV para Excel/Sheets (consulta, no restauración) ─────────────────────────
// Excel en configuración regional de Ecuador separa listas con ";"; con "," abre todo en una sola columna.
const csvCell = value => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers, data) => `\uFEFF${[headers, ...data].map(r => r.map(csvCell).join(';')).join('\r\n')}`;
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
    WHERE cf.clinic_id = $1 AND ${SIGNED_CONSENT_FILTER}
    GROUP BY p.id ORDER BY p.last_name, p.first_name LIMIT ${MAX_ROWS_PER_TABLE}`, [clinicId]);
  return rows;
}

/** patientIds = null exporta todos; un arreglo limita a esos pacientes (siempre dentro de la clínica). */
export async function buildConsentsHtml(pool, clinicId, patientIds = null) {
  const [{ rows }, clinic] = await Promise.all([
    pool.query(`SELECT cf.*, p.first_name, p.last_name, COALESCE(p.identification_number, p.rut) AS patient_identification
      FROM consent_forms cf JOIN patients p ON p.id = cf.patient_id
      WHERE cf.clinic_id = $1 AND ${SIGNED_CONSENT_FILTER} AND ($2::int[] IS NULL OR cf.patient_id = ANY($2::int[]))
      ORDER BY p.last_name, p.first_name, cf.created_at LIMIT ${MAX_ROWS_PER_TABLE}`, [clinicId, patientIds]),
    pool.query('SELECT name FROM clinics WHERE id = $1', [clinicId]),
  ]);
  const img = (src, alt) => (typeof src === 'string' && SAFE_PNG.test(src) ? `<img src="${src}" alt="${esc(alt)}">` : '<p class="muted">Sin firma registrada</p>');
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
<p class="muted tip">Para guardar como PDF use Imprimir → Guardar como PDF. Copia legible generada desde BioSkinTech; la evidencia original permanece en el sistema.</p></header>
${docs || '<p>No hay consentimientos firmados.</p>'}</body></html>`;
}
