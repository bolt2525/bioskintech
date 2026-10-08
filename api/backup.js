/**
 * @file api/backup.js
 * @description Respaldos por clínica: estadísticas, exportación (JSON restaurable / CSV), restauración con simulación,
 * importación de pacientes por plantilla y copias automáticas cifradas en Cloudflare R2 (cron diario).
 *
 * Seguridad: solo clinic_admin/master_admin; todo se filtra por clinic_id; las restauraciones corren en una
 * transacción con SAVEPOINT por fila, validan pertenencia de cada referencia y generan un respaldo previo.
 */

import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { getPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';
import { lockClinicWriters, unlockClinicWriters, requireClinicWritable } from '../lib/clinic-lifecycle.js';
import { PHOTO_BACKUP_ACTIONS, handleAnnualPhotoBackup } from '../lib/annual-photo-backup.js';
import { putR2Object, getR2ObjectBuffer, listR2Objects, generateDownloadUrl, generateUploadUrl, r2ObjectExists, deleteR2Object } from '../lib/r2-service.js';
import {
  BACKUP_MODULES, MAX_UPLOAD_BYTES, MAX_JSON_BYTES, MAX_ROWS_PER_TABLE, EXCLUDED_CONSENT_COLUMNS, PATIENT_TEMPLATE_COLUMNS,
  buildBackupDocument, collectClinicData, compressBackup, decodeBackupBuffer, encryptBackup, hasBackupKey,
  inspectBackupDocument, buildDatasetCsv, validatePatientImportRow, buildPatientTemplateCsv, isTemplateExampleRow, buildConsentsPage, listConsentPatients,
  isBackupUploadSizeAllowed,
} from '../lib/backup-service.js';

const CLINIC_SCOPED_TABLES = new Set([
  'patients', 'clinical_records', 'consultations', 'medical_history',
  'consultation_info', 'consultation_history', 'physical_exams',
  'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms',
  'medical_history_snapshots', 'clinical_photos', 'patient_audit_log',
  'external_finance_records', 'financial_records',
  'financial_items', 'inventory_items', 'inventory_groups', 'inventory_batches', 'inventory_movements',
]);

const IMPORTABLE_TABLES = new Set([
  'patients', 'clinical_records', 'consultations', 'medical_history', 'consultation_info', 'consultation_history',
  'physical_exams', 'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms',
  'medical_history_snapshots', 'clinical_photos', 'patient_audit_log',
  'financial_records', 'external_finance_records', 'financial_items', 'inventory_items', 'inventory_batches', 'inventory_movements',
]);
const RECORD_CHILD_TABLES = new Set([
  'medical_history', 'consultation_info', 'consultation_history', 'physical_exams', 'diagnoses', 'treatments',
  'injectables', 'prescriptions', 'consent_forms', 'medical_history_snapshots', 'clinical_photos',
]);
const LEGACY_FINANCE_COLUMNS = new Set([
  'patient_name', 'intervention_date', 'doctor_fees', 'raw_note', 'intervention_type', 'payment_method',
]);
const CURRENT_FINANCE_COLUMNS = new Set(['date', 'entity', 'type', 'subtotal', 'tax', 'registered_by']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_KINDS = ['auto', 'manual', 'pre-restore'];

export async function rejectPurgedBackup(pool, doc, targetClinicId) {
  const ids = [targetClinicId, doc?.metadata?.clinic_id].filter(id => typeof id === 'string' && UUID_RE.test(id));
  if (!ids.length) return;
  const result = await pool.query(`SELECT true AS purge FROM clinic_settings
    WHERE clinic_id=ANY($1::uuid[]) AND general ? '_purge' LIMIT 1`, [ids]);
  if (result.rows.some(row => row.purge === true))
    throw Object.assign(new Error('No se permite restaurar copias de una clínica con purga registrada, ni en otra identidad de clínica.'), { status: 409 });
}

export function resolveFinanceSourceTable(financeModule) {
  const source = financeModule?.source_table;
  if (source === 'financial_records' || source === 'external_finance_records') return source;
  const rows = financeModule?.records;
  if (!Array.isArray(rows) || rows.length === 0) return 'financial_records';
  const columns = new Set(rows.flatMap(row => Object.keys(row || {})));
  const isLegacy = [...LEGACY_FINANCE_COLUMNS].some(column => columns.has(column));
  const isCurrent = [...CURRENT_FINANCE_COLUMNS].some(column => columns.has(column));
  if (isLegacy !== isCurrent) return isLegacy ? 'external_finance_records' : 'financial_records';
  throw new Error('Esquema financiero del backup ambiguo o no compatible');
}

export function buildClinicFilter(table, baseQuery, params = [], isMaster = false, clinicId = null) {
  if ((isMaster && !clinicId) || !CLINIC_SCOPED_TABLES.has(table)) return { query: baseQuery, params };
  const suffixMatch = /\s+(ORDER\s+BY|LIMIT|OFFSET)\b/i.exec(baseQuery);
  const splitAt = suffixMatch?.index ?? baseQuery.length;
  const statement = baseQuery.slice(0, splitAt);
  const suffix = baseQuery.slice(splitAt);
  const op = /\bWHERE\b/i.test(statement) ? ' AND ' : ' WHERE ';
  return { query: statement + `${op}clinic_id = $${params.length + 1}` + suffix, params: [...params, clinicId] };
}

export function buildBackupInsertStatement(table, row, tableColumns, jsonColumns = new Set()) {
  if (!IMPORTABLE_TABLES.has(table) || !row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('Tabla o fila de backup inválida');
  const valuesByColumn = Object.fromEntries(Object.entries(row).filter(([column]) =>
    /^[a-z_][a-z0-9_]*$/i.test(column) && tableColumns.has(column) &&
    !(table === 'consent_forms' && EXCLUDED_CONSENT_COLUMNS.has(column))
  ));
  if (!Object.hasOwn(valuesByColumn, 'id')) throw new Error(`La fila de ${table} no tiene id válido`);
  const columns = Object.keys(valuesByColumn);
  return {
    query: `INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`,
    // node-pg convierte arrays JS a arrays Postgres; en columnas jsonb deben ir como JSON.
    values: columns.map(column => jsonColumns.has(column) && valuesByColumn[column] != null && typeof valuesByColumn[column] === 'object'
      ? JSON.stringify(valuesByColumn[column]) : valuesByColumn[column]),
  };
}

const tableColumnsCache = new Map();
const jsonColumnsCache = new Map();
async function getTableColumns(pool, table) {
  if (!IMPORTABLE_TABLES.has(table)) throw new Error('Tabla de backup no permitida');
  if (!tableColumnsCache.has(table)) {
    const result = await pool.query(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', table]
    );
    tableColumnsCache.set(table, new Set(result.rows.map(row => row.column_name)));
    jsonColumnsCache.set(table, new Set(result.rows.filter(row => /^jsonb?$/.test(row.data_type || '')).map(row => row.column_name)));
  }
  return tableColumnsCache.get(table);
}

export async function insertBackupRow(pool, table, inputRow, clinicId, isMaster, { financialRecordTable = 'financial_records', photoExists = r2ObjectExists } = {}) {
  const tableColumns = await getTableColumns(pool, table);
  const row = { ...inputRow };
  const tenantId = clinicId || row.clinic_id || null;
  if (CLINIC_SCOPED_TABLES.has(table)) {
    if (!tableColumns.has('clinic_id')) throw new Error(`La tabla ${table} no tiene clinic_id`);
    if (clinicId) row.clinic_id = clinicId;
    else if (!isMaster) throw new Error('Clínica no identificada para importar datos');
  }
  const clearForeignOwner = async field => {
    if (row[field] == null) return;
    const user = await pool.query(
      'SELECT 1 FROM clinic_users WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2',
      [row[field], tenantId]
    );
    if (!user.rows.length) row[field] = null;
  };

  if (table === 'patients' && Number.isSafeInteger(Number(row.id))) {
    const existing = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [row.id]);
    if (existing.rows.length && String(existing.rows[0].clinic_id || '') !== String(tenantId || ''))
      throw new Error('El paciente del backup ya existe en otra clínica');
    if (existing.rows.length) return 0;
    await clearForeignOwner('created_by_user_id');
  } else if (Number.isSafeInteger(Number(row.id)) && tableColumns.has('clinic_id') &&
      (await pool.query(`SELECT clinic_id FROM ${table} WHERE id = $1`, [row.id])).rows.some(r => {
        if (String(r.clinic_id || '') !== String(tenantId || '')) throw new Error(`El registro de ${table} ya existe en otra clínica`);
        return true;
      })) {
    // Ya existe en esta clínica: nunca se sobrescribe ni se revalida.
    return 0;
  } else if (table === 'clinical_records') {
    const patient = await pool.query('SELECT 1 FROM patients WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.patient_id, tenantId]);
    if (!patient.rows.length) throw new Error('El expediente referencia un paciente fuera de la clínica destino');
    await clearForeignOwner('created_by_user_id');
  } else if (table === 'consultations') {
    const record = await pool.query('SELECT 1 FROM clinical_records WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.record_id, tenantId]);
    if (!record.rows.length) throw new Error('La consulta referencia un expediente fuera de la clínica destino');
  } else if (RECORD_CHILD_TABLES.has(table)) {
    const record = await pool.query('SELECT patient_id FROM clinical_records WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.record_id, tenantId]);
    if (!record.rows.length) throw new Error(`La fila de ${table} referencia un expediente fuera de la clínica destino`);
    if (table === 'consent_forms' && Number(record.rows[0].patient_id) !== Number(row.patient_id))
      throw new Error('El consentimiento referencia un paciente distinto al expediente');
    if (table === 'consent_forms') {
      await clearForeignOwner('annulled_by_user_id');
      if (row.replaces_consent_id != null) {
        const original = await pool.query(
          'SELECT 1 FROM consent_forms WHERE id = $1 AND patient_id = $2 AND record_id = $3 AND clinic_id IS NOT DISTINCT FROM $4 AND status = $5',
          [row.replaces_consent_id, row.patient_id, row.record_id, tenantId, 'annulled']
        );
        if (!original.rows.length || Number(row.replaces_consent_id) === Number(row.id))
          throw new Error('El reemplazo referencia un consentimiento anulado distinto o fuera de la clínica destino');
      }
    }
    if (table === 'clinical_photos') {
      const prefix = `clinics/${tenantId}/records/${row.record_id}/photos/`;
      if (typeof row.r2_key !== 'string' || !row.r2_key.startsWith(prefix) || row.r2_key.includes('..'))
        throw new Error('La foto referencia un archivo fuera de la clínica o expediente destino');
      if (!(await photoExists(row.r2_key))) throw new Error('El archivo de la foto ya no existe en el almacenamiento; no se restaura su referencia');
    }
    if (row.consultation_id != null) {
      const consultation = await pool.query('SELECT 1 FROM consultations WHERE id = $1 AND record_id = $2 AND clinic_id IS NOT DISTINCT FROM $3', [row.consultation_id, row.record_id, tenantId]);
      if (!consultation.rows.length) throw new Error(`La fila de ${table} referencia una consulta fuera del expediente o la clínica destino`);
    }
    if (table === 'injectables' && row.treatment_id != null) {
      const treatment = await pool.query(
        'SELECT 1 FROM treatments WHERE id = $1 AND record_id = $2 AND clinic_id IS NOT DISTINCT FROM $3',
        [row.treatment_id, row.record_id, tenantId]
      );
      if (!treatment.rows.length) throw new Error('El inyectable referencia un tratamiento fuera del expediente o la clínica destino');
    }
  } else if (table === 'patient_audit_log') {
    if (row.patient_id != null) {
      const patient = await pool.query('SELECT 1 FROM patients WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.patient_id, tenantId]);
      if (!patient.rows.length) throw new Error('La auditoría referencia un paciente fuera de la clínica destino');
    }
    if (row.record_id != null) {
      const record = await pool.query('SELECT 1 FROM clinical_records WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.record_id, tenantId]);
      if (!record.rows.length) throw new Error('La auditoría referencia un expediente fuera de la clínica destino');
    }
    await clearForeignOwner('clinic_user_id');
  } else if (table === 'inventory_batches') {
    const item = await pool.query('SELECT 1 FROM inventory_items WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.item_id, tenantId]);
    if (!item.rows.length) throw new Error('El lote referencia un ítem fuera de la clínica destino');
  } else if (table === 'financial_items') {
    if (!['financial_records', 'external_finance_records'].includes(financialRecordTable))
      throw new Error('Tabla financiera de backup no permitida');
    const record = await pool.query(`SELECT 1 FROM ${financialRecordTable} WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2`, [row.record_id, tenantId]);
    if (!record.rows.length) throw new Error('La partida referencia un registro financiero fuera de la clínica destino');
  } else if (table === 'inventory_movements') {
    const batch = await pool.query('SELECT 1 FROM inventory_batches WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.batch_id, tenantId]);
    if (!batch.rows.length) throw new Error('El movimiento referencia un lote fuera de la clínica destino');
    await clearForeignOwner('user_id');
  }

  if (table === 'financial_records' || table === 'inventory_items') await clearForeignOwner('created_by_user_id');

  const statement = buildBackupInsertStatement(table, row, tableColumns, jsonColumnsCache.get(table));
  const result = await pool.query(statement.query, statement.values);
  return result.rowCount;
}

export async function restoreInventoryGroups(pool, rows, clinicId, isMaster) {
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error('Catálogo de backup inválido');
  let count = 0;
  for (const row of rows) {
    const targetClinic = clinicId || (isMaster ? row?.clinic_id : null);
    if (!targetClinic || typeof row?.category !== 'string' || row.category.length > 100 || typeof row?.name !== 'string')
      throw new Error('Subcategoría de backup inválida');
    const name = row.name.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 100) throw new Error('Subcategoría de backup inválida');
    const nameKey = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
    const result = await pool.query(`
      INSERT INTO inventory_groups (clinic_id, category, name, name_key)
      VALUES ($1, $2, $3, $4) ON CONFLICT (clinic_id, category, name_key) DO NOTHING
    `, [targetClinic, row.category.trim(), name, nameKey]);
    count += result.rowCount;
  }
  return count;
}

const PG_ERRORS = {
  '23505': 'Ya existe otro registro con la misma identificación o clave única',
  '23503': 'Referencia a un registro inexistente',
  '23502': 'Falta un campo obligatorio',
  '23514': 'Valor no permitido por las reglas de la base',
  '22P02': 'Valor con formato inválido',
  '22007': 'Fecha con formato inválido',
  '22008': 'Fecha fuera de rango',
  '22001': 'Texto más largo de lo permitido',
  '22003': 'Número fuera de rango',
};
export const describeRestoreError = err =>
  err?.code ? (PG_ERRORS[err.code] || `Error de base de datos (${err.code})`) : String(err?.message || 'Error desconocido').slice(0, 200);

/** Restaura en una transacción; cada fila en su SAVEPOINT. Confirma solo si no es simulación y no hay errores (o se aceptan parciales). */
export async function restoreBackupDocument(pool, doc, clinicId, { dryRun = true, allowPartial = false } = {}) {
  const client = await pool.connect();
  const report = { inserted: {}, existing: {}, errors: [], errorCount: 0, committed: false };
  const touched = new Set();
  const insertRows = async (table, rows, inserter) => {
    if (rows == null) return;
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_TABLE) throw new Error(`La sección ${table} es inválida o demasiado grande`);
    for (const raw of rows) {
      await client.query('SAVEPOINT backup_row');
      try {
        const n = await inserter(raw);
        await client.query('RELEASE SAVEPOINT backup_row');
        const bucket = n ? report.inserted : report.existing;
        bucket[table] = (bucket[table] || 0) + 1;
        if (n) touched.add(table);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT backup_row');
        report.errorCount++;
        if (report.errors.length < 200) report.errors.push({ table, id: raw?.id ?? null, error: describeRestoreError(err) });
      }
    }
  };
  const rowsOf = (table, value) => {
    if (value != null && !Array.isArray(value)) throw new Error(`La sección ${table} es inválida`);
    return value;
  };
  const insert = (table, opts) => row => insertBackupRow(client, table, row, clinicId, false, opts);

  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const sourceClinic = doc?.metadata?.clinic_id;
    await lockClinicWriters(client, [clinicId,
      ...(typeof sourceClinic === 'string' && UUID_RE.test(sourceClinic) ? [sourceClinic] : [])]);
    await requireClinicWritable(client, clinicId);
    await rejectPurgedBackup(client, doc, clinicId);
    const modules = doc.modules;
    const t = modules.patients?.tables;
    if (t && typeof t === 'object') {
      await insertRows('patients', rowsOf('patients', t.patients), row => insertBackupRow(client, 'patients',
        { ...row, rut: row?.rut || row?.identification_number, identification_number: row?.identification_number || row?.rut }, clinicId, false));
      for (const table of ['clinical_records', 'consultations', 'medical_history', 'consultation_info', 'consultation_history',
        'physical_exams', 'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms',
        'medical_history_snapshots', 'clinical_photos', 'patient_audit_log']) {
        const legacyWithoutConsultations = table !== 'consultations' && !Array.isArray(t.consultations);
        await insertRows(table, rowsOf(table, t[table]), row => insertBackupRow(client, table,
          legacyWithoutConsultations && row?.consultation_id != null ? { ...row, consultation_id: null } : row, clinicId, false));
      }
    }
    if (modules.finance?.records) {
      const finTable = resolveFinanceSourceTable(modules.finance);
      const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${finTable}`]);
      if (!exists.rows[0].ok) throw new Error('La tabla financiera del respaldo no existe en esta instalación');
      if (finTable === 'external_finance_records' && modules.finance.items?.length)
        throw new Error('El respaldo financiero legacy no puede restaurar partidas estructuradas');
      await insertRows(finTable, rowsOf(finTable, modules.finance.records), insert(finTable));
      await insertRows('financial_items', rowsOf('financial_items', modules.finance.items), insert('financial_items', { financialRecordTable: finTable }));
    }
    const inv = modules.inventory;
    if (inv && typeof inv === 'object') {
      await insertRows('inventory_groups', rowsOf('inventory_groups', inv.groups?.data), row => restoreInventoryGroups(client, [row], clinicId, false));
      await insertRows('inventory_items', rowsOf('inventory_items', inv.items?.data), insert('inventory_items'));
      await insertRows('inventory_batches', rowsOf('inventory_batches', inv.batches?.data), insert('inventory_batches'));
      await insertRows('inventory_movements', rowsOf('inventory_movements', inv.movements?.data), insert('inventory_movements'));
    }

    const commit = !dryRun && (report.errorCount === 0 || allowPartial);
    if (commit) {
      // Con IDs explícitos las secuencias no avanzan; sin esto el próximo INSERT normal chocaría.
      for (const table of touched) {
        if (table === 'inventory_groups') continue;
        await client.query(
          `SELECT setval(s, GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 1), COALESCE(pg_sequence_last_value(s::regclass), 1)))
           FROM (SELECT pg_get_serial_sequence($1, 'id') AS s) seq WHERE s IS NOT NULL`, [table]);
      }
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    report.committed = commit;
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Copias en R2 ──────────────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export const isSnapshotKey = (key, clinicId) =>
  typeof key === 'string' && new RegExp(`^backups/${clinicId}/(${SNAPSHOT_KINDS.join('|')})/[\\w.-]+\\.json\\.gz\\.enc$`).test(key);
export const isUploadKey = (key, clinicId) =>
  typeof key === 'string' && new RegExp(`^backup-tmp/${clinicId}/uploads/[0-9a-f-]{36}$`).test(key);

const MANUAL_SNAPSHOT_TIME_ZONE = 'America/Guayaquil';
const MAX_RESTORABLE_SNAPSHOT_BYTES = MAX_UPLOAD_BYTES * 2;
const ENCRYPTED_BACKUP_HEADER_BYTES = 33;

async function manualSnapshotClock(db) {
  return (await db.query(`SELECT
    to_char(now() AT TIME ZONE '${MANUAL_SNAPSHOT_TIME_ZONE}', 'YYYY-MM-DD') AS local_date,
    (date_trunc('day', now() AT TIME ZONE '${MANUAL_SNAPSHOT_TIME_ZONE}') + interval '1 day')
      AT TIME ZONE '${MANUAL_SNAPSHOT_TIME_ZONE}' AS next_allowed_at,
    now() AS now`)).rows[0];
}

function ecuadorDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MANUAL_SNAPSHOT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function manualSnapshotQuota(clock, existingManualSnapshots, metadata = null, historyMayBeTruncated = false, processing = false) {
  const historyIncomplete = historyMayBeTruncated || existingManualSnapshots.length >= 500;
  const latestObject = historyIncomplete ? null : [...existingManualSnapshots]
    .sort((a, b) => new Date(b.lastModified ?? b.created_at) - new Date(a.lastModified ?? a.created_at))[0] || null;
  const matching = existingManualSnapshots
    .filter(item => ecuadorDate(item.lastModified ?? item.created_at) === clock.local_date)
    .sort((a, b) => new Date(b.lastModified ?? b.created_at) - new Date(a.lastModified ?? a.created_at));
  const existingToday = matching[0] || null;
  const saved = metadata && typeof metadata === 'object' ? metadata : {};
  const savedCreatedAt = saved.last_created_at && ecuadorDate(saved.last_created_at) === clock.local_date;
  const successToday = Boolean(existingToday || savedCreatedAt);
  const latest = latestObject || (saved.last_created_at ? {
    created_at: saved.last_created_at,
    key: typeof saved.last_key === 'string' ? saved.last_key : null,
  } : null);
  const state = historyIncomplete ? 'HISTORY_INCOMPLETE'
    : processing ? 'PROCESSING' : successToday ? 'USED' : 'AVAILABLE';
  return {
    time_zone: MANUAL_SNAPSHOT_TIME_ZONE,
    daily_limit: 1,
    used_today: successToday ? 1 : 0,
    available: !successToday && !historyIncomplete && !processing,
    state,
    reason: historyIncomplete ? 'No se pudo verificar todo el historial; contacta a soporte.' : null,
    next_allowed_at: historyIncomplete || processing ? null : clock.next_allowed_at,
    last_success_at: latest?.lastModified || latest?.created_at || null,
    last_success_key: latest?.key || null,
  };
}

export async function getManualSnapshotQuota(pool, clinicId, {
  manualSnapshots,
  listManualSnapshots = listR2Objects,
  historyMayBeTruncated = false,
} = {}) {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`manual-snapshot:${clinicId}`]);
    lockHeld = lock.rows[0]?.acquired === true;
    const [clock, settings, objects] = await Promise.all([
      manualSnapshotClock(client),
      client.query('SELECT general->\'_manual_backup\' AS metadata FROM clinic_settings WHERE clinic_id=$1', [clinicId]),
      lockHeld ? (manualSnapshots ??
        listManualSnapshots(`backups/${clinicId}/manual/`, 500)) : Promise.resolve(manualSnapshots || []),
    ]);
    return manualSnapshotQuota(clock, objects, settings.rows[0]?.metadata, historyMayBeTruncated, !lockHeld);
  } finally {
    if (lockHeld) {
      try {
        const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',
          [`manual-snapshot:${clinicId}`]);
        if (result.rows[0]?.unlocked !== true)
          throw new Error('No se pudo liberar el bloqueo de consulta del respaldo manual');
      } catch (error) {
        client.release(error);
        throw error;
      }
    }
    client.release();
  }
}

export function manualBackupContract(quota) {
  return {
    available: quota.available,
    next_allowed_at: quota.next_allowed_at,
    last_created_at: quota.last_success_at,
    timezone: quota.time_zone,
    limit: quota.daily_limit,
    ...(quota.state === 'HISTORY_INCOMPLETE' || quota.state === 'PROCESSING'
      ? { state: quota.state, reason: quota.reason || null } : {}),
  };
}

export async function reserveManualSnapshot(pool, clinicId, listManualSnapshots = listR2Objects, reservationClient = null) {
  const ownsClient = !reservationClient;
  const client = reservationClient || await pool.connect();
  let lockHeld = false;
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`manual-snapshot:${clinicId}`]);
    lockHeld = lock.rows[0]?.acquired === true;
    if (!lockHeld) {
      const clock = await manualSnapshotClock(client);
      throw Object.assign(new Error('Ya hay un respaldo manual en curso para esta clínica; espera a que termine y vuelve a intentar.'), {
        status: 429,
        nextAllowedAt: clock.next_allowed_at,
      });
    }
    const existingManualSnapshots = await listManualSnapshots(`backups/${clinicId}/manual/`, 500);
    const clock = await manualSnapshotClock(client);
    const metadata = (await client.query(
      'SELECT general->\'_manual_backup\' AS metadata FROM clinic_settings WHERE clinic_id=$1', [clinicId],
    )).rows[0]?.metadata;
    const quota = manualSnapshotQuota(clock, existingManualSnapshots, metadata);
    if (quota.state === 'HISTORY_INCOMPLETE')
      throw Object.assign(new Error(quota.reason), { status: 503 });
    if (!quota.available) {
      const error = Object.assign(new Error(
        `Ya se creó o está en curso un respaldo manual hoy en Ecuador; podrás solicitar otro después de ${new Date(clock.next_allowed_at).toLocaleString('es-EC', { timeZone: MANUAL_SNAPSHOT_TIME_ZONE })}.`,
      ), { status: 429, nextAllowedAt: clock.next_allowed_at });
      throw error;
    }
    return { client, clinicId, lockHeld, clock, ownsClient };
  } catch (error) {
    if (lockHeld) {
      try {
        const unlocked = await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',
          [`manual-snapshot:${clinicId}`]);
        if (unlocked.rows[0]?.unlocked !== true) throw new Error('No se pudo liberar el bloqueo manual del respaldo');
      }
      catch (unlockError) {
        if (ownsClient) client.release(unlockError);
        else unlockError.destroyClient = true;
        throw unlockError;
      }
    }
    if (ownsClient) client.release();
    throw error;
  }
}

export async function persistManualSnapshotMetadata(reservation, snapshot) {
  if (!reservation?.client || !reservation.lockHeld) throw new Error('Reserva manual inválida');
  const { client, clinicId } = reservation;
  const clock = await manualSnapshotClock(client);
  await client.query(`INSERT INTO clinic_settings(clinic_id,general) VALUES($1,
      jsonb_build_object('_manual_backup',$2::jsonb))
    ON CONFLICT(clinic_id) DO UPDATE SET
      general=jsonb_set(coalesce(clinic_settings.general,'{}'::jsonb),'{_manual_backup}',$2::jsonb,true),
      updated_at=now()`, [
    clinicId,
    JSON.stringify({
      last_created_at: new Date(clock.now).toISOString(),
      local_date: clock.local_date,
      last_key: snapshot.key,
      size_bytes: snapshot.size,
    }),
  ]);
}

export async function releaseManualSnapshotReservation(reservation) {
  if (!reservation?.client || !reservation.lockHeld) return;
  const { client, clinicId, ownsClient = true } = reservation;
  try {
    const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',
      [`manual-snapshot:${clinicId}`]);
    if (result.rows[0]?.unlocked !== true) throw new Error('No se pudo liberar el bloqueo del respaldo manual');
  } catch (error) {
    if (ownsClient) client.release(error);
    else error.destroyClient = true;
    throw error;
  }
  if (ownsClient) client.release();
}

async function clinicName(pool, clinicId) {
  return (await pool.query('SELECT name FROM clinics WHERE id = $1', [clinicId])).rows[0]?.name || null;
}

export async function createSnapshot(pool, clinicId, kind, generatedBy, {
  signal, collect = collectClinicData, put = putR2Object, beforeUpload,
} = {}) {
  signal?.throwIfAborted();
  const modules = await collect(pool, clinicId, BACKUP_MODULES, { signal });
  signal?.throwIfAborted();
  const doc = buildBackupDocument({ clinicId, clinicName: await clinicName(pool, clinicId), generatedBy, kind, modules });
  signal?.throwIfAborted();
  const body = encryptBackup(compressBackup(doc, {
    maxCompressedBytes: MAX_RESTORABLE_SNAPSHOT_BYTES - ENCRYPTED_BACKUP_HEADER_BYTES,
  }));
  signal?.throwIfAborted();
  const key = `backups/${clinicId}/${kind}/${stamp()}-${crypto.randomBytes(4).toString('hex')}.json.gz.enc`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await lockClinicWriters(client, [clinicId]);
    await requireClinicWritable(client, clinicId, { allowInactive: true });
    signal?.throwIfAborted();
    if (beforeUpload) await beforeUpload();
    await put(key, body, 'application/octet-stream', {
      abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return { key, size: body.length, counts: doc.metadata.counts };
}

async function publishTemporaryDownload(clinicId, doc, filenameBase) {
  return publishTemporaryFile(clinicId, compressBackup(doc, { maxCompressedBytes: MAX_UPLOAD_BYTES }),
    `${filenameBase}-${new Date().toISOString().split('T')[0]}.json.gz`);
}

async function publishTemporaryFile(clinicId, gzBuffer, filename) {
  const key = `backup-tmp/${clinicId}/exports/${crypto.randomUUID()}.gz`;
  await putR2Object(key, gzBuffer, 'application/gzip');
  return { url: await generateDownloadUrl(key, filename), filename };
}

/**
 * POST ?action=consentsHtml: { patientIds?: number[], offset: 0, limit: 100 }.
 * Continuar con la misma selección y { offset: nextOffset, limit, revision } hasta
 * hasMore=false. count=total seleccionado, returnedCount=documentos de esta parte.
 * Si cambia el conjunto, HTTP 409: descartar partes anteriores y reiniciar.
 * Sin offset/limit se conserva el contrato anterior: >100 falla, nunca se trunca.
 */
export async function exportConsentsFile(pool, clinicId, body, publish = publishTemporaryFile) {
  const { html, ...page } = await buildConsentsPage(pool, clinicId, body);
  if (body.offset === undefined && body.limit === undefined && page.hasMore)
    throw new Error('La selección supera 100 consentimientos; solicita partes con offset=0, limit=100 y continúa con nextOffset y revision');
  return { ...(await publish(clinicId, gzipSync(Buffer.from(html, 'utf8')),
    `consentimientos-firmados-${new Date().toISOString().split('T')[0]}-parte-${page.offset}.html.gz`)), ...page };
}

/** Política: las fotos se eliminan 30 días después de vencer la suscripción sin renovación; no se respaldan. */
export async function purgeExpiredClinicPhotos(pool, deleteObject = deleteR2Object, limit = 500) {
  const { rows } = await pool.query(
    `SELECT f.id, f.r2_key FROM clinical_photos f JOIN clinics c ON c.id = f.clinic_id
     WHERE c.subscription_expires_at IS NOT NULL AND c.subscription_expires_at < NOW() - INTERVAL '30 days'
       AND NOT EXISTS (SELECT 1 FROM clinic_settings cs WHERE cs.clinic_id=c.id AND cs.general ? '_purge')
     ORDER BY f.id LIMIT ${Number(limit)}`);
  let deleted = 0;
  for (const photo of rows) {
    try {
      await deleteObject(photo.r2_key);
      await pool.query('DELETE FROM clinical_photos WHERE id = $1', [photo.id]);
      deleted++;
    } catch (err) { console.error('[backup:cron] photo purge failed', photo.id, err?.name || 'Error'); }
  }
  return deleted;
}

/**
 * Basura efímera del bot de WhatsApp. No toca `whatsapp_messages`: Meta no conserva el contenido
 * de los mensajes, así que esa tabla es el único registro de lo que se le comunicó a cada paciente.
 */
async function purgeEphemeralWhatsAppRows(pool) {
  // Redirecciones de un solo uso hacia una cita que ya ocurrió; nadie vuelve a abrirlas.
  const links = await pool.query("DELETE FROM wa_short_links WHERE created_at < NOW() - INTERVAL '30 days'");
  // Conversaciones abandonadas a medio flujo; `getBotState()` ya las ignora tras 2 horas.
  const states = await pool.query("DELETE FROM whatsapp_bot_state WHERE updated_at < NOW() - INTERVAL '1 day'");
  return { shortLinks: links.rowCount, botStates: states.rowCount };
}

// ponytail: presupuesto por invocación, sin cola persistente → retries operacionales explícitos.
export const CRON_BUDGET_MS = 45_000; // deja 15 s del maxDuration=60 para responder/logs.
const CRON_MIN_START_MS = 15_000;
const CRON_BUDGET_EXCEEDED = Symbol('cron-budget-exceeded');

/**
 * Reintento operacional: ?action=cron&clinicId=<UUID>, con el mismo Bearer CRON_SECRET.
 * Procesa únicamente esa clínica existente y omite mantenimiento global.
 * Sin clinicId mantiene la ejecución general. No programa retries ni resuelve
 * automáticamente los pendientes de otras invocaciones.
 */
export async function runCron(req, res, pool, {
  snapshot = createSnapshot, purgePhotos = purgeExpiredClinicPhotos,
  purgeWhatsApp = purgeEphemeralWhatsAppRows, now = Date.now,
  budgetMs = CRON_BUDGET_MS,
} = {}) {
  const started = now();
  const remaining = () => Math.max(0, budgetMs - (now() - started));
  // No se confunde un timeout con fallo: una operación no cancelable puede terminar
  // después de responder. Nunca se inicia otra clínica/limpieza tras ese timeout.
  const withinBudget = async operation => {
    const ms = remaining();
    if (!ms) return CRON_BUDGET_EXCEEDED;
    let timer;
    const controller = new AbortController();
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise(resolve => { timer = setTimeout(() => {
          resolve(CRON_BUDGET_EXCEEDED);
          controller.abort(new Error('Presupuesto del cron agotado'));
        }, ms); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = String(req.headers.authorization || '');
  const expected = `Bearer ${secret}`;
  if (!secret || provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected)))
    return res.status(401).json({ error: 'No autorizado' });
  const targetClinicId = req.query?.clinicId;
  const targeted = targetClinicId !== undefined;
  if (targeted && (typeof targetClinicId !== 'string' || !UUID_RE.test(targetClinicId)))
    return res.status(400).json({ error: 'clinicId debe ser un UUID válido' });
  const scope = { scope: targeted ? 'clinic' : 'all', clinicId: targeted ? targetClinicId : null };
  if (!hasBackupKey()) return res.status(503).json({ error: 'BACKUP_ENCRYPTION_KEY no configurada' });
  const clinicResult = await withinBudget(() => targeted
    ? pool.query(`SELECT c.id FROM clinics c WHERE c.id=$1 AND NOT EXISTS
        (SELECT 1 FROM clinic_settings cs WHERE cs.clinic_id=c.id AND cs.general ? '_purge')`, [targetClinicId])
    : pool.query(`SELECT c.id FROM clinics c WHERE NOT EXISTS
        (SELECT 1 FROM clinic_settings cs WHERE cs.clinic_id=c.id AND cs.general ? '_purge') ORDER BY c.id`));
  if (clinicResult === CRON_BUDGET_EXCEEDED)
    return res.status(503).json({ error: 'Presupuesto agotado al listar clínicas; ninguna fue iniciada',
      ...scope, complete: false, needsRetry: true, retryScheduled: false });
  if (targeted && !clinicResult.rows.length)
    return res.status(404).json({ error: 'Clínica no encontrada', ...scope,
      ok: 0, complete: false, needsRetry: false, retryScheduled: false });
  const clinics = clinicResult.rows;
  let ok = 0;
  const failed = [];
  const uncertain = [];
  const unprocessed = [];
  let longestSnapshotMs = 0;
  for (const [index, { id }] of clinics.entries()) {
    if (remaining() < Math.max(CRON_MIN_START_MS, longestSnapshotMs * 2)) {
      unprocessed.push(...clinics.slice(index).map(clinic => clinic.id));
      break;
    }
    const snapshotStarted = now();
    try {
      const result = await withinBudget(signal => snapshot(pool, id, 'auto', 'cron', { signal }));
      if (result === CRON_BUDGET_EXCEEDED) {
        uncertain.push(id);
        unprocessed.push(...clinics.slice(index + 1).map(clinic => clinic.id));
        break;
      }
      ok++;
    }
    catch (err) { failed.push(id); console.error('[backup:cron] snapshot failed', id, err?.code || err?.name || 'Error'); }
    longestSnapshotMs = Math.max(longestSnapshotMs, now() - snapshotStarted);
  }
  const complete = failed.length + uncertain.length + unprocessed.length === 0;
  console.info('[backup:cron] done', { ok, failed, uncertain, unprocessed, complete });
  if (failed.length && remaining() >= CRON_MIN_START_MS) {
    const { sendDeveloperAlert } = await import('./admin-auth.js');
    await withinBudget(() => sendDeveloperAlert('Respaldo automático con fallos', { Correctos: ok, Fallidos: failed.length, 'Clínicas': failed.join(', ') }))
      .catch(err => console.error('[backup:cron] alert error', err?.name || 'Error'));
  }
  const maintenance = {
    photos: targeted ? 'not_requested' : 'skipped',
    whatsapp: targeted ? 'not_requested' : 'skipped',
  };
  let photosPurged = null, whatsappPurged = null;
  for (const [name, operation] of [['photos', purgePhotos], ['whatsapp', purgeWhatsApp]]) {
    if (targeted) break;
    if (remaining() < CRON_MIN_START_MS) break;
    try {
      const result = await withinBudget(() => operation(pool));
      if (result === CRON_BUDGET_EXCEEDED) { maintenance[name] = 'uncertain'; break; }
      maintenance[name] = 'complete';
      if (name === 'photos') photosPurged = result;
      else whatsappPurged = result;
    } catch (err) {
      maintenance[name] = 'failed';
      console.error('[backup:cron] maintenance failed', name, err?.code || err?.name);
    }
  }
  const maintenanceComplete = targeted || Object.values(maintenance).every(status => status === 'complete');
  return res.status(complete && maintenanceComplete ? 200 : 207).json({
    ...scope, ok, failed, uncertain, unprocessed, complete, needsRetry: !complete || !maintenanceComplete,
    retryScheduled: false, photosPurged, whatsappPurged, maintenance,
    elapsedMs: now() - started, budgetMs,
  });
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

async function importPatients(pool, rows, clinicId, auth, dryRun) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5000) throw new Error('El archivo debe tener entre 1 y 5000 pacientes');
  const report = { valid: 0, created: 0, withHistory: 0, examplesSkipped: 0, duplicates: [], errors: [], committed: false };
  const seen = new Set();
  const candidates = [];
  rows.forEach((raw, index) => {
    const line = index + 2;
    if (isTemplateExampleRow(raw)) { report.examplesSkipped++; return; }
    const { patient, history, error } = validatePatientImportRow(raw);
    if (error) return report.errors.length < 500 && report.errors.push({ line, error });
    const key = `${patient.identification_type}:${patient.identification_number}`;
    if (seen.has(key)) return report.duplicates.push({ line, reason: 'Identificación repetida dentro del archivo' });
    seen.add(key);
    candidates.push({ line, patient, history });
  });
  if (candidates.length) {
    const existing = await pool.query(
      `SELECT identification_type, regexp_replace(COALESCE(identification_number, rut), '[^0-9]', '', 'g') AS num
       FROM patients WHERE clinic_id = $1`, [clinicId]);
    const taken = new Set(existing.rows.flatMap(r => [`${r.identification_type}:${r.num}`, `null:${r.num}`]));
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { line, patient } = candidates[i];
      if (taken.has(`${patient.identification_type}:${patient.identification_number}`) || taken.has(`null:${patient.identification_number}`)) {
        report.duplicates.push({ line, reason: 'Ya existe un paciente con esa identificación en la clínica' });
        candidates.splice(i, 1);
      }
    }
  }
  report.valid = candidates.length;
  report.withHistory = candidates.filter(c => c.history).length;
  report.duplicates.sort((a, b) => a.line - b.line);
  if (dryRun || report.errors.length || !candidates.length) return report;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { patient: p, history } of candidates) {
      const created = await client.query(
        `INSERT INTO patients (first_name, last_name, rut, identification_type, identification_number, email, phone, birth_date, gender,
           address, occupation, tipo_sangre, estado_civil, clinic_id, created_by_user_id)
         VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [p.first_name, p.last_name, p.identification_number, p.identification_type, p.email, p.phone, p.birth_date, p.gender,
          p.address, p.occupation, p.tipo_sangre, p.estado_civil, clinicId, auth.id ?? null]);
      const patientId = created.rows[0].id;
      const record = await client.query('INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
        [patientId, clinicId, auth.id ?? null, 'active']);
      if (history) {
        const fields = Object.keys(history);
        await client.query(
          `INSERT INTO medical_history (record_id, clinic_id, ${fields.join(', ')}) VALUES ($1, $2, ${fields.map((_, i) => `$${i + 3}`).join(', ')})`,
          [record.rows[0].id, clinicId, ...Object.values(history)]);
        await client.query('INSERT INTO medical_history_snapshots (record_id, clinic_id, snapshot_data, changed_by) VALUES ($1, $2, $3, $4)',
          [record.rows[0].id, clinicId, JSON.stringify(history), `${auth.username || 'importación'} (CSV)`]);
      }
      await client.query(
        `INSERT INTO patient_audit_log (patient_id, clinic_id, clinic_user_id, user_display_name, action_type, module, summary)
         VALUES ($1, $2, $3, $4, 'create', 'patient', 'Paciente importado desde plantilla CSV')`,
        [patientId, clinicId, auth.id ?? null, auth.username || null]);
    }
    await client.query('COMMIT');
    report.created = candidates.length;
    report.committed = true;
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(describeRestoreError(err));
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query.action || 'stats');
  if (PHOTO_BACKUP_ACTIONS.has(action)) return handleAnnualPhotoBackup(req, res, action);
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (action === 'cron') {
    try { return await runCron(req, res, pool); }
    catch (err) { console.error('[backup:cron] error', err?.code || err?.name); return res.status(500).json({ error: 'Cron de respaldo falló' }); }
  }

  const auth = await authenticateRequest(req);
  if (!auth.valid) return res.status(401).json({ error: 'No autenticado' });
  const isMaster = auth.role === 'master_admin';
  if (!isMaster && auth.role !== 'clinic_admin')
    return res.status(403).json({ error: 'Solo el administrador de la clínica puede gestionar respaldos' });
  const clinicId = auth.effective_clinic_id ?? auth.clinic_id ?? null;
  if (!isMaster && !clinicId) return res.status(403).json({ error: 'Clínica no identificada' });
  if (clinicId && !UUID_RE.test(String(clinicId))) return res.status(400).json({ error: 'Clínica inválida' });
  const requireClinic = () => { if (!clinicId) { res.status(400).json({ error: 'Selecciona una clínica para operar sus respaldos' }); return false; } return true; };
  const isPost = req.method === 'POST';
  let writerClient = null;
  let writerLocked = false;
  let writerClientFailure = null;
  let manualSnapshotReservation = null;

  try {
    if (clinicId) {
      writerClient = await pool.connect();
      await writerClient.query("SET statement_timeout = '15s'");
      await lockClinicWriters(writerClient, [clinicId], { session: true });
      writerLocked = true;
      await writerClient.query('SET statement_timeout = 0');
      await requireClinicWritable(writerClient, clinicId, { allowInactive: true });
    }
    if (action === 'stats' && req.method === 'GET') {
      const existing = new Set((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map(r => r.table_name));
      const finTable = existing.has('financial_records') ? 'financial_records' : 'external_finance_records';
      const statsMap = [
        ['patients', 'patients', 'Pacientes'], ['clinical_records', 'clinical_records', 'Expedientes'],
        ['consultations', 'consultations', 'Consultas'], ['medical_history', 'medical_history', 'Antecedentes'],
        ['physical_exams', 'physical_exams', 'Exámenes Físicos'], ['diagnoses', 'diagnoses', 'Diagnósticos'],
        ['treatments', 'treatments', 'Tratamientos'], ['injectables', 'injectables', 'Inyectables'],
        ['prescriptions', 'prescriptions', 'Recetas'], ['consent_forms', 'consent_forms', 'Consentimientos'],
        ['medical_history_snapshots', 'medical_history_snapshots', 'Versiones de antecedentes'],
        ['patient_audit_log', 'patient_audit_log', 'Auditoría'], ['clinical_photos', 'clinical_photos', 'Fotos (solo referencias)'],
        ['finance', finTable, 'Registros Finanzas'], ['financial_items', 'financial_items', 'Partidas de facturas'],
        ['inventory_items', 'inventory_items', 'Productos'], ['inventory_batches', 'inventory_batches', 'Lotes'],
        ['inventory_movements', 'inventory_movements', 'Movimientos'], ['inventory_groups', 'inventory_groups', 'Subcategorías'],
      ];
      const stats = {};
      for (const [key, table, label] of statsMap) {
        if (!existing.has(table)) { stats[key] = { label, count: 0, exists: false }; continue; }
        const { query, params } = buildClinicFilter(table, `SELECT COUNT(*)::int AS n FROM ${table}`, [], isMaster, clinicId);
        stats[key] = { label, count: (await pool.query(query, params)).rows[0].n, exists: true };
      }
      const totalRecords = Object.entries(stats).filter(([k]) => k !== 'clinical_photos').reduce((a, [, s]) => a + s.count, 0);
      const manualBackup = clinicId ? manualBackupContract(await getManualSnapshotQuota(pool, clinicId)) : null;
      return res.status(200).json({ stats, totalRecords, clinic_id: clinicId || 'master',
        is_master: isMaster && !clinicId, encryption_ready: hasBackupKey(), manual_backup: manualBackup });
    }

    if (action === 'csv' && req.method === 'GET') {
      if (!requireClinic()) return;
      const { filename, csv } = await buildDatasetCsv(pool, String(req.query.dataset || ''), clinicId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(csv);
    }

    if (action === 'template' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="plantilla-pacientes-bioskintech.csv"');
      return res.status(200).send(buildPatientTemplateCsv());
    }

    if (action === 'templateInfo' && req.method === 'GET') {
      return res.status(200).json({ columns: PATIENT_TEMPLATE_COLUMNS.map(([name, required, description, example]) => ({ name, required, description, example })) });
    }

    if (action === 'consentPatients' && req.method === 'GET') {
      if (!requireClinic()) return;
      const patients = await listConsentPatients(pool, clinicId);
      return res.status(200).json({ patients, count: patients.length,
        totalConsents: patients.reduce((sum, patient) => sum + patient.count, 0) });
    }

    if (action === 'snapshots' && req.method === 'GET') {
      if (!requireClinic()) return;
      const items = (await listR2Objects(`backups/${clinicId}/`, 500))
        .filter(o => isSnapshotKey(o.key, clinicId))
        .map(o => ({ key: o.key, kind: o.key.split('/')[2], size: o.size, created_at: o.lastModified }))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const manualQuota = await getManualSnapshotQuota(pool, clinicId);
      return res.status(200).json({ snapshots: items, manual_quota: manualQuota,
        manual_backup: manualBackupContract(manualQuota),
        encryption_ready: hasBackupKey(), retention_days: 35, immutable_days: 30 });
    }

    if (!isPost) return res.status(405).json({ error: 'Método no permitido' });
    if (!requireClinic()) return;
    const body = await parseJsonBody(req);

    if (action === 'export') {
      if (body.snapshotKey != null) {
        if (!isSnapshotKey(body.snapshotKey, clinicId)) return res.status(400).json({ error: 'Respaldo no válido para esta clínica' });
        const doc = decodeBackupBuffer(await getR2ObjectBuffer(body.snapshotKey, MAX_RESTORABLE_SNAPSHOT_BYTES));
        inspectBackupDocument(doc, clinicId);
        return res.status(200).json(await publishTemporaryDownload(clinicId, doc, 'bioskintech-respaldo-nube'));
      }
      const selected = Array.isArray(body.modules) ? body.modules.filter(m => BACKUP_MODULES.includes(m)) : [];
      if (!selected.length) return res.status(400).json({ error: 'Selecciona al menos un módulo' });
      const modules = await collectClinicData(pool, clinicId, selected);
      const doc = buildBackupDocument({ clinicId, clinicName: await clinicName(pool, clinicId), generatedBy: auth.username, kind: 'download', modules });
      console.info('[backup] export', { clinicId, user: auth.id, modules: selected });
      return res.status(200).json({ ...(await publishTemporaryDownload(clinicId, doc, 'bioskintech-respaldo')), counts: doc.metadata.counts, signed: !!doc.signature });
    }

    if (action === 'consentsHtml') {
      const file = await exportConsentsFile(pool, clinicId, body);
      console.info('[backup] consents html', { clinicId, user: auth.id, offset: file.offset, count: file.returnedCount });
      return res.status(200).json(file);
    }

    if (action === 'uploadUrl') {
      const size = Number(body.size);
      if (!isBackupUploadSizeAllowed(size))
        return res.status(413).json({ error: `El archivo debe pesar entre 2 bytes y ${MAX_UPLOAD_BYTES / 1048576} MiB. Para archivos mayores, comprímelos con gzip; la API limita la expansión a ${MAX_JSON_BYTES / 1048576} MiB.` });
      const key = `backup-tmp/${clinicId}/uploads/${crypto.randomUUID()}`;
      const url = await generateUploadUrl(key, 'application/octet-stream', size, 300, MAX_UPLOAD_BYTES);
      return res.status(200).json({ key, url });
    }

    if (action === 'snapshot') {
      if (!hasBackupKey()) return res.status(503).json({ error: 'El cifrado de respaldos no está configurado. Contacta a soporte.' });
      const snap = await createSnapshot(pool, clinicId, 'manual', auth.username, {
        beforeUpload: async () => {
          manualSnapshotReservation = await reserveManualSnapshot(pool, clinicId, listR2Objects, writerClient);
        },
      });
      await persistManualSnapshotMetadata(manualSnapshotReservation, snap);
      await releaseManualSnapshotReservation(manualSnapshotReservation);
      manualSnapshotReservation = null;
      const manualQuota = await getManualSnapshotQuota(pool, clinicId);
      console.info('[backup] manual snapshot', { clinicId, user: auth.id });
      return res.status(201).json({ ...snap, manual_quota: manualQuota,
        manual_backup: manualBackupContract(manualQuota) });
    }

    if (action === 'restore') {
      const source = body.source === 'snapshot' ? 'snapshot' : 'upload';
      const validKey = source === 'snapshot' ? isSnapshotKey(body.key, clinicId) : isUploadKey(body.key, clinicId);
      if (!validKey) return res.status(400).json({ error: 'Archivo de respaldo no válido para esta clínica' });
      const doc = decodeBackupBuffer(await getR2ObjectBuffer(body.key, MAX_RESTORABLE_SNAPSHOT_BYTES));
      const info = inspectBackupDocument(doc, clinicId);
      try { await rejectPurgedBackup(pool, doc, clinicId); }
      catch (error) {
        if (!error.status) throw error;
        console.error('[backup:restore]', error.status);
        return res.status(error.status).json({ error: error.message });
      }
      const dryRun = body.dryRun !== false;
      const confirmations = [];
      if (info.signature !== 'valid') confirmations.push('unsigned');
      if (!info.sameClinic) confirmations.push('foreignClinic');
      if (!dryRun) {
        if (confirmations.includes('unsigned') && body.acceptUnsigned !== true)
          return res.status(409).json({ error: 'El archivo no tiene una firma válida de este sistema; confirma explícitamente para continuar', info });
        if (confirmations.includes('foreignClinic') && body.confirmForeignClinic !== true)
          return res.status(409).json({ error: 'El respaldo pertenece a otra clínica; confirma explícitamente para continuar', info });
        if (!hasBackupKey()) return res.status(503).json({ error: 'No se puede restaurar sin generar antes un respaldo de seguridad (cifrado no configurado)' });
      }
      const preRestore = dryRun ? null : await createSnapshot(pool, clinicId, 'pre-restore', auth.username);
      const report = await restoreBackupDocument(pool, doc, clinicId, { dryRun, allowPartial: body.allowPartial === true });
      console.info('[backup] restore', { clinicId, user: auth.id, dryRun, committed: report.committed, errors: report.errorCount });
      return res.status(200).json({ info, confirmations, report, preRestoreSnapshot: preRestore?.key || null });
    }

    if (action === 'importPatients') {
      const report = await importPatients(pool, body.rows, clinicId, auth, body.dryRun !== false);
      if (report.committed) console.info('[backup] patient import', { clinicId, user: auth.id, created: report.created });
      return res.status(200).json(report);
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (error) {
    if (error?.destroyClient) writerClientFailure = error;
    if (error?.name === 'NoSuchKey') return res.status(404).json({ error: 'El archivo ya no está disponible; vuelve a subirlo' });
    // Solo los Error propios (sin código de pg ni metadatos de AWS) llevan mensajes seguros para el usuario.
    const known = error instanceof Error && error.name === 'Error' && !error.code && !error.$metadata;
    console.error('[backup] error', action, error?.code || error?.name || 'Error');
    const status = known ? (Number.isInteger(error.status) ? error.status : 400) : 500;
    return res.status(status).json({ error: known ? error.message : 'No se pudo procesar el respaldo.',
      ...(status === 429 && error.nextAllowedAt ? { next_allowed_at: error.nextAllowedAt } : {}) });
  } finally {
    if (manualSnapshotReservation) {
      try { await releaseManualSnapshotReservation(manualSnapshotReservation); }
      catch (error) {
        if (error?.destroyClient) writerClientFailure = error;
        console.error('[backup:manual-snapshot] lock release failed', error.code || error.name);
      }
    }
    if (writerClient) {
      try {
        if (writerLocked) await unlockClinicWriters(writerClient, [clinicId]);
        await writerClient.query('SET statement_timeout = 0');
        writerClient.release(writerClientFailure || undefined);
      } catch (error) {
        console.error('[backup:lifecycle] release failed', error.code || error.name);
        writerClient.release(error);
      }
    }
  }
}
