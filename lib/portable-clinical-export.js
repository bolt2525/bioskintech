import { buildBackupDocument, CLINICAL_TABLES, EXCLUDED_CONSENT_COLUMNS, toCsv, compactSignatureDataUrl } from './backup-service.js';

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const CHUNK_CONTENT_BYTES = MAX_DOCUMENT_BYTES - 16 * 1024;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const LABELS = {
  patients: 'Paciente', clinical_records: 'Expedientes', consultations: 'Consultas',
  medical_history: 'Antecedentes', consultation_info: 'Motivo de consulta', consultation_history: 'Historial de consulta',
  physical_exams: 'Examen físico y marcaciones', diagnoses: 'Diagnósticos', treatments: 'Tratamientos',
  injectables: 'Inyectables', prescriptions: 'Recetas', consent_forms: 'Consentimientos',
  medical_history_snapshots: 'Versiones de antecedentes', clinical_photos: 'Fotografías: metadatos', patient_audit_log: 'Auditoría',
};
const FIELD_LABELS = {
  first_name: 'Nombres', last_name: 'Apellidos', birth_date: 'Fecha de nacimiento',
  identification_number: 'Identificación', created_at: 'Fecha de registro', updated_at: 'Última actualización',
  date: 'Fecha', notes: 'Notas', description: 'Descripción', content_text: 'Contenido',
  skin_type: 'Tipo de piel', phototype: 'Fototipo', glogau_scale: 'Escala de Glogau',
  lesions_description: 'Descripción de lesiones', face_map_data: 'Marcaciones faciales',
  body_map_data: 'Marcaciones corporales', mapping_data: 'Mapeo de aplicaciones',
  category: 'Categoría', label: 'Región o etiqueta', tercio: 'Tercio anatómico', position3D: 'Coordenadas 3D',
  injectionPoints: 'Puntos de aplicación', referenceLines: 'Líneas de referencia',
  editablePoints: 'Puntos editables', freehandLines: 'Trazos', surfaceShapes: 'Formas', haVials: 'Viales',
  product_name: 'Producto', dose: 'Dosis', units: 'Unidades', areas_treated: 'Áreas tratadas',
  signatures: 'Firmas registradas', patient_sig_data: 'Firma del paciente', professional_sig_data: 'Firma del profesional',
  signing_hash: 'Huella de integridad', signing_status: 'Estado de firma', status: 'Estado',
  objectives: 'Objetivos', risks: 'Riesgos', benefits: 'Beneficios', alternatives: 'Alternativas',
  pre_care: 'Cuidados previos', post_care: 'Cuidados posteriores', contraindications: 'Contraindicaciones',
};
const JSON_FIELDS = new Set(['face_map_data', 'body_map_data', 'mapping_data', 'signatures']);

function readableValue(key, value) {
  if (JSON_FIELDS.has(key) && typeof value === 'string') {
    try { return JSON.parse(value); }
    catch { throw new Error(`El campo clínico ${key} contiene datos no interpretables`); }
  }
  return value;
}

function renderValue(value) {
  if (value === null || value === undefined) return '<span>—</span>';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    return `<img alt="Firma digitalizada registrada" src="${compactSignatureDataUrl(value)}">`;
  if (Array.isArray(value)) return `<ol>${value.map(item => `<li>${renderValue(item)}</li>`).join('')}</ol>`;
  if (typeof value === 'object') return renderFields(value);
  return escapeHtml(value);
}

function renderFields(row) {
  return `<dl>${Object.entries(row).filter(([key]) => !EXCLUDED_CONSENT_COLUMNS.has(key))
    .map(([key, value]) => `<dt>${escapeHtml(FIELD_LABELS[key] || key.replace(/_/g, ' '))}</dt><dd>${renderValue(readableValue(key, value))}</dd>`).join('')}</dl>`;
}

function documentHtml(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>
body{font:14px Arial,sans-serif;max-width:960px;margin:24px auto;padding:16px;color:#222}dl{display:block;border:1px solid #ddd;padding:12px}dt{font-weight:bold;margin-top:8px}dd{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;max-height:180px}section{break-inside:avoid}h2{border-bottom:1px solid #ccc}@media print{body{max-width:none}}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function tableCsv(rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return text;
  };
  return toCsv(columns, rows.map(row => columns.map(key => cell(row[key]))));
}

function withoutSigningSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSigningSecrets);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).filter(([key]) => !EXCLUDED_CONSENT_COLUMNS.has(key))
      .map(([key, child]) => [key, withoutSigningSecrets(child)]));
  return value;
}

function chunksOf(rows, measure) {
  const chunks = [];
  let chunk = [];
  let bytes = 0;
  for (const row of rows) {
    const size = measure(row);
    if (size > CHUNK_CONTENT_BYTES) throw new Error('Un registro supera el límite documental; requiere una exportación asistida');
    if (chunk.length && bytes + size > CHUNK_CONTENT_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/** Generates readable copies from the same clinical snapshot, without network-dependent assets. */
export function buildPortableDocuments(modules, { clinicId, generatedAt = new Date().toISOString() }) {
  const rawTables = modules.patients?.tables;
  const tables = rawTables && withoutSigningSecrets(rawTables);
  if (!tables || !Array.isArray(tables.patients)) throw new Error('Snapshot clínico incompleto');
  const records = new Map((tables.clinical_records || []).map(row => [String(row.id), String(row.patient_id)]));
  const consultations = new Map((tables.consultations || []).map(row =>
    [String(row.id), String(row.patient_id ?? records.get(String(row.record_id)) ?? '')]));
  const patientIds = new Set(tables.patients.map(row => String(row.id)));
  const byPatient = new Map([...patientIds].map(id => [id, {}]));
  for (const [table, rows] of Object.entries(tables)) {
    if (!CLINICAL_TABLES.includes(table)) throw new Error('Tabla no autorizada en el snapshot clínico');
    for (const row of rows) {
      if (String(row.clinic_id) !== String(clinicId)) throw new Error('Snapshot fuera de la clínica autorizada');
      if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1) throw new Error('Identificador clínico inválido');
      const patientId = table === 'patients' ? String(row.id)
        : String(row.patient_id ?? records.get(String(row.record_id)) ?? consultations.get(String(row.consultation_id)) ?? '');
      if (!patientIds.has(patientId)) throw new Error(`No se puede relacionar un registro de ${table} con su paciente`);
      const group = byPatient.get(patientId);
      (group[table] ||= []).push(row);
    }
  }
  const documents = [];
  let total = 0;
  const add = (name, text, contentType) => {
    const body = Buffer.from(text, 'utf8');
    if (body.length > MAX_DOCUMENT_BYTES || total + body.length > MAX_TOTAL_BYTES)
      throw new Error('La documentación clínica supera el límite de esta exportación; requiere dividir el snapshot');
    total += body.length;
    documents.push({ name, body, contentType });
  };
  const makeBackup = selectedTables => {
    const backup = buildBackupDocument({ clinicId, generatedBy: 'exportación anual autorizada', kind: 'annual-photo',
      modules: { patients: { count: selectedTables.patients?.length || 0, tables: selectedTables } } });
    backup.metadata.timestamp = generatedAt;
    backup.metadata.notes = [
      'Datos clínicos. Los originales fotográficos están en las partes ZIP.',
      'Si hay JSON numerados, restaure todos en orden ascendente; cada parte complementa las anteriores.',
      'HTML imprimibles del mismo snapshot; sin tokens, credenciales, calendario externo ni modelos 3D.',
    ];
    return JSON.stringify(backup);
  };
  const orderedRows = CLINICAL_TABLES.flatMap(table => (tables[table] || []).map(row => ({ table, row })));
  const jsonChunks = chunksOf(orderedRows, ({ row }) => Buffer.byteLength(JSON.stringify(row)) + 32);
  for (const [index, chunk] of jsonChunks.entries()) {
    const selectedTables = Object.fromEntries(CLINICAL_TABLES.map(table => [table, []]));
    for (const { table, row } of chunk) selectedTables[table].push(row);
    const name = jsonChunks.length === 1 ? 'datos/backup.json'
      : `datos/backup-parte-${String(index + 1).padStart(4, '0')}.json`;
    add(name, makeBackup(selectedTables), 'application/json');
  }
  if (!jsonChunks.length) add('datos/backup.json', makeBackup(tables), 'application/json');
  for (const [table, rows] of Object.entries(tables)) {
    if (!rows.length) continue;
    const csvChunks = chunksOf(rows, row => Buffer.byteLength(tableCsv([row])) + 256);
    for (const [index, chunk] of csvChunks.entries()) {
      const suffix = csvChunks.length === 1 ? '' : `-parte-${String(index + 1).padStart(4, '0')}`;
      add(`datos/${table}${suffix}.csv`, tableCsv(chunk), 'text/csv');
    }
  }
  for (const [patientId, group] of byPatient) {
    const sections = Object.entries(group).flatMap(([table, rows]) => rows.map(row =>
      `<section><h2>${escapeHtml(LABELS[table] || table)}</h2>${renderFields(row)}</section>`));
    const historyChunks = chunksOf(sections, section => Buffer.byteLength(section));
    for (const [index, chunk] of historyChunks.entries()) {
      const suffix = historyChunks.length === 1 ? '' : `-parte-${String(index + 1).padStart(4, '0')}`;
      add(`historias/paciente-${patientId}${suffix}.html`, documentHtml('Historia clínica exportada',
        `<p>Fecha de corte: ${escapeHtml(generatedAt)}. Parte ${index + 1} de ${historyChunks.length}. Datos sensibles: conservar de forma segura. Las marcaciones se incluyen como coordenadas y anotaciones; los modelos 3D no se transfieren.</p>${chunk.join('')}`), 'text/html');
    }
    for (const consent of group.consent_forms || []) {
      add(`consentimientos/paciente-${patientId}/consentimiento-${consent.id}.html`,
        documentHtml('Consentimiento registrado', `<p>Se conserva el estado, contenido, firmas y evidencias disponibles; no sustituye el original de papel no digitalizado.</p>${renderFields(consent)}`), 'text/html');
    }
  }
  add('LEAME.html', documentHtml('Entrega anual de datos y fotografías',
    `<p>Fecha de corte: ${escapeHtml(generatedAt)}. Abra las historias y consentimientos HTML en el navegador para leerlos o imprimirlos. Los archivos JSON son técnicos: si están numerados, restaure todos en orden ascendente. Historias y CSV grandes se dividen en partes; conserve todas. Los ZIP son independientes: descargue todas las partes. Las fotografías originales se conservan sin recomprimir.</p><p>Esta exportación bajo solicitud no equivale a una copia automática periódica de las fotografías. No incluye el calendario externo ni documentos en papel no digitalizados.</p><h2>Índice de documentos</h2><ul>${documents.map(file => `<li>${escapeHtml(file.name)} (${file.body.length} bytes)</li>`).join('')}</ul>`), 'text/html');
  return documents;
}
