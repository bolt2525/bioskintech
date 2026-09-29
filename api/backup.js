/**
 * @file api/backup.js
 * @description Respaldo y estadÃ­sticas de datos de la clÃ­nica.
 *
 * SEGURIDAD: Las consultas se filtran por clinic_id cuando el usuario
 * es clinic_admin o clinic_user. master_admin puede ver todo.
 *
 * Acciones (query param `action`):
 *  - stats   â†’ devuelve conteos por tabla (no descarga)
 *  - backup  â†’ descarga JSON con los datos seleccionados (default)
 */

import { getPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';

// Tablas con columna clinic_id â€” siempre filtradas por tenant
const CLINIC_SCOPED_TABLES = new Set([
  'patients', 'clinical_records', 'consultations', 'medical_history',
  'consultation_info', 'consultation_history', 'physical_exams',
  'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms',
  'external_finance_records', 'financial_records',
  'financial_items', 'inventory_items', 'inventory_groups', 'inventory_batches', 'inventory_movements',
]);

const IMPORTABLE_TABLES = new Set([
  'patients', 'clinical_records', 'consultations', 'medical_history', 'consultation_info', 'consultation_history',
  'physical_exams', 'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms',
  'financial_records', 'external_finance_records', 'financial_items', 'inventory_items', 'inventory_batches', 'inventory_movements',
]);
const EXCLUDED_CONSENT_BACKUP_COLUMNS = new Set([
  'signing_token', 'signing_email', 'signing_sender_user_id', 'signing_otp_hash', 'signing_otp_attempts',
  'signing_expires_at', 'signing_verified_at', 'signing_session_hash', 'signing_session_expires_at',
]);
const LEGACY_FINANCE_COLUMNS = new Set([
  'patient_name', 'intervention_date', 'doctor_fees', 'raw_note', 'intervention_type', 'payment_method',
]);
const CURRENT_FINANCE_COLUMNS = new Set(['date', 'entity', 'type', 'subtotal', 'tax', 'registered_by']);

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
  const hasWhere = /\bWHERE\b/i.test(statement);
  const op = hasWhere ? ' AND ' : ' WHERE ';
  return {
    query: statement + `${op}clinic_id = $${params.length + 1}` + suffix,
    params: [...params, clinicId],
  };
}

export function buildBackupInsertStatement(table, row, tableColumns) {
  if (!IMPORTABLE_TABLES.has(table) || !row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('Tabla o fila de backup inválida');
  const valuesByColumn = Object.fromEntries(Object.entries(row).filter(([column]) =>
    /^[a-z_][a-z0-9_]*$/i.test(column) && tableColumns.has(column) &&
    !(table === 'consent_forms' && EXCLUDED_CONSENT_BACKUP_COLUMNS.has(column))
  ));
  if (!Object.hasOwn(valuesByColumn, 'id')) throw new Error(`La fila de ${table} no tiene id válido`);
  const columns = Object.keys(valuesByColumn);
  return {
    query: `INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`,
    values: Object.values(valuesByColumn),
  };
}

const tableColumnsCache = new Map();
async function getTableColumns(pool, table) {
  if (!IMPORTABLE_TABLES.has(table)) throw new Error('Tabla de backup no permitida');
  if (!tableColumnsCache.has(table)) {
    const result = await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', table]
    );
    tableColumnsCache.set(table, new Set(result.rows.map(row => row.column_name)));
  }
  return tableColumnsCache.get(table);
}

export async function insertBackupRow(pool, table, inputRow, clinicId, isMaster, { financialRecordTable = 'financial_records' } = {}) {
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
    await clearForeignOwner('created_by_user_id');
  } else if (table === 'clinical_records') {
    const patient = await pool.query('SELECT 1 FROM patients WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.patient_id, tenantId]);
    if (!patient.rows.length) throw new Error('El expediente referencia un paciente fuera de la clínica destino');
    await clearForeignOwner('created_by_user_id');
  } else if (table === 'consultations') {
    const record = await pool.query('SELECT 1 FROM clinical_records WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2', [row.record_id, tenantId]);
    if (!record.rows.length) throw new Error('La consulta referencia un expediente fuera de la clínica destino');
  } else if (['medical_history', 'consultation_info', 'consultation_history', 'physical_exams', 'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms'].includes(table)) {
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

  const statement = buildBackupInsertStatement(table, row, tableColumns);
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

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticateRequest(req);
  if (!auth.valid) return res.status(401).json({ error: 'No autenticado' });

  const isMaster = auth.role === 'master_admin';
  // Solo clinic_admin y master_admin pueden exportar/importar
  if (!isMaster && auth.role !== 'clinic_admin') {
    return res.status(403).json({ error: 'Solo el administrador de la clÃ­nica puede realizar respaldos' });
  }

  let pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database no disponible' });

  const { action = 'backup', modules } = req.query;
  // effective_clinic_id: puede ser la clÃ­nica objetivo cuando master admin usa X-Target-Clinic-Id
  const clinicId = auth.effective_clinic_id ?? auth.clinic_id;

  // clinic_admin sin clinic_id es un error de configuraciÃ³n
  if (!isMaster && !clinicId) {
    return res.status(403).json({ error: 'ClÃ­nica no identificada' });
  }

  // Helper: agrega filtro de clinic_id cuando corresponde
  const withClinicFilter = (table, baseQuery, params = []) => buildClinicFilter(table, baseQuery, params, isMaster, clinicId);

  // Helper: verifica si una tabla existe
  const tableExists = async (name) => {
    const r = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
      [name]
    );
    return r.rows[0].exists;
  };

  try {
    // â”€â”€ IMPORTACIÃ“N (POST) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (req.method === 'POST') {
      const importData = req.body;
      if (!importData?.metadata || !importData?.modules) {
        return res.status(400).json({ error: 'Formato de backup invÃ¡lido' });
      }
      const originalPool = pool;
      const importClient = await pool.connect();
      pool = importClient;
      try {
      await pool.query('BEGIN');
      const importResults = {};

      // Pacientes y fichas clÃ­nicas
      if (importData.modules.patients?.tables) {
        const t = importData.modules.patients.tables;
        let pCount = 0;
        for (const p of (t.patients || [])) {
          const patient = { ...p, rut: p.rut || p.identification_number, identification_number: p.identification_number || p.rut };
          pCount += await insertBackupRow(pool, 'patients', patient, clinicId, isMaster);
        }
        importResults.patients = pCount;
        const subTables = ['clinical_records','consultations','medical_history','consultation_info','consultation_history','physical_exams','diagnoses','treatments','injectables','prescriptions','consent_forms'];
        for (const tbl of subTables) {
          let cnt = 0;
          for (const row of (t[tbl] || [])) {
            const importRow = tbl !== 'consultations' && !Array.isArray(t.consultations) && row.consultation_id != null
              ? { ...row, consultation_id: null }
              : row;
            cnt += await insertBackupRow(pool, tbl, importRow, clinicId, isMaster);
          }
          importResults[tbl] = cnt;
        }
      }

      // Finanzas
      if (importData.modules.finance?.records) {
        let cnt = 0;
        const finTable = resolveFinanceSourceTable(importData.modules.finance);
        if (!(await tableExists(finTable))) throw new Error('Tabla financiera origen no disponible en esta instalación');
        if (finTable === 'external_finance_records' && importData.modules.finance.items?.length)
          throw new Error('El backup legacy no puede restaurar partidas financieras estructuradas en esta instalación');
        for (const row of importData.modules.finance.records) {
          cnt += await insertBackupRow(pool, finTable, row, clinicId, isMaster);
        }
        importResults.finance = cnt;
        let itemCount = 0;
        for (const row of (importData.modules.finance.items || [])) {
          itemCount += await insertBackupRow(pool, 'financial_items', row, clinicId, isMaster, { financialRecordTable: finTable });
        }
        importResults.financial_items = itemCount;
      }

      // Inventario
      if (importData.modules.inventory?.items?.data || importData.modules.inventory?.groups?.data) {
        let itemCnt = 0, batchCnt = 0;
        const groupCnt = await restoreInventoryGroups(pool, importData.modules.inventory.groups?.data || [], clinicId, isMaster);
        for (const row of (importData.modules.inventory.items?.data || [])) {
          itemCnt += await insertBackupRow(pool, 'inventory_items', row, clinicId, isMaster);
        }
        for (const row of (importData.modules.inventory.batches?.data || [])) {
          batchCnt += await insertBackupRow(pool, 'inventory_batches', row, clinicId, isMaster);
        }
        let movementCount = 0;
        for (const row of (importData.modules.inventory.movements?.data || [])) {
          movementCount += await insertBackupRow(pool, 'inventory_movements', row, clinicId, isMaster);
        }
        importResults.inventory_items = itemCnt;
        importResults.inventory_groups = groupCnt;
        importResults.inventory_batches = batchCnt;
        importResults.inventory_movements = movementCount;
      }

      await pool.query('COMMIT');
      return res.status(200).json({ success: true, imported: importResults });
      } catch (importError) {
        await pool.query('ROLLBACK').catch(() => {});
        throw importError;
      } finally {
        pool = originalPool;
        importClient.release();
      }
    }

    // â”€â”€ ESTADÃSTICAS (no descarga) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'stats') {
      const statsMap = [
        { key: 'patients',            table: 'patients',            label: 'Pacientes' },
        { key: 'clinical_records',    table: 'clinical_records',    label: 'Expedientes' },
        { key: 'diagnoses',           table: 'diagnoses',           label: 'DiagnÃ³sticos' },
        { key: 'treatments',          table: 'treatments',          label: 'Tratamientos' },
        { key: 'prescriptions',       table: 'prescriptions',       label: 'Recetas' },
        { key: 'physical_exams',      table: 'physical_exams',      label: 'ExÃ¡menes FÃ­sicos' },
        { key: 'injectables',         table: 'injectables',         label: 'Inyectables' },
        { key: 'consent_forms',       table: 'consent_forms',       label: 'Consentimientos' },
        { key: 'medical_history',     table: 'medical_history',     label: 'Antecedentes' },
        { key: 'finance',             table: 'external_finance_records', label: 'Registros Finanzas' },
        { key: 'inventory_items',     table: 'inventory_items',     label: 'Ãtems Inventario' },
        { key: 'inventory_batches',   table: 'inventory_batches',   label: 'Lotes Inventario' },
      ];

      const stats = {};
      for (const { key, table, label } of statsMap) {
        try {
          if (!(await tableExists(table))) { stats[key] = { label, count: 0, exists: false }; continue; }
          const { query, params } = withClinicFilter(table, `SELECT COUNT(*)::int AS n FROM ${table}`, []);
          const r = await pool.query(query, params);
          stats[key] = { label, count: r.rows[0].n, exists: true };
        } catch {
          stats[key] = { label, count: 0, exists: false };
        }
      }

      const totalRecords = Object.values(stats).reduce((a, s) => a + (s.count || 0), 0);
      return res.status(200).json({ stats, totalRecords, clinic_id: clinicId || 'master', is_master: isMaster });
    }

    // â”€â”€ DESCARGA DE RESPALDO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const selectedModules = modules
      ? modules.split(',').map(m => m.trim())
      : ['patients', 'finance', 'inventory'];

    const backupData = {
      metadata: {
        timestamp: new Date().toISOString(),
        clinic_id: clinicId || 'master',
        generated_by: auth.username,
        modules: selectedModules,
        version: '2.0',
      },
      modules: {},
    };

    // 1. Pacientes y fichas clÃ­nicas
    if (selectedModules.includes('patients')) {
      const tables = [
        'patients', 'clinical_records', 'consultations', 'medical_history', 'consultation_info',
        'consultation_history', 'physical_exams', 'diagnoses', 'treatments',
        'injectables', 'prescriptions', 'consent_forms',
      ];
      const data = {};
      for (const t of tables) {
        try {
          if (!(await tableExists(t))) { data[t] = []; continue; }
          const columns = t === 'consent_forms'
            ? `id, record_id, patient_id, clinic_id, consultation_id, form_type, content_text, signature_data, signed_at, status,
               created_at, updated_at, created_by, procedure_type, zone, sessions, objectives, description, risks, benefits,
               alternatives, pre_care, post_care, contraindications, critical_antecedents, authorizations, declarations,
               signatures, attachments, signing_status, signing_snapshot, signing_snapshot_hash, signing_hash,
               signing_signed_at, signing_copy_sent_at, annulled_at, annulled_by_user_id,
               annulled_by_name, annulment_reason, replaces_consent_id`
            : '*';
          const { query, params } = withClinicFilter(t, `SELECT ${columns} FROM ${t} ORDER BY id LIMIT 10000`, []);
          const r = await pool.query(query, params);
          data[t] = r.rows;
        } catch (e) {
          console.error(`[backup] Clinical export failed for ${t}:`, e?.code || e?.name || 'UnknownError');
          throw new Error('No se pudo completar la exportación de fichas clínicas.');
        }
      }
      backupData.modules.patients = {
        count: data.patients?.length || 0,
        tables: data,
      };
    }

    // 2. Finanzas
    if (selectedModules.includes('finance')) {
      try {
        const finTable = (await tableExists('financial_records')) ? 'financial_records' : 'external_finance_records';
        const { query, params } = withClinicFilter(finTable, `SELECT * FROM ${finTable} ORDER BY id LIMIT 10000`, []);
        const r = await pool.query(query, params);
        backupData.modules.finance = { source_table: finTable, count: r.rows.length, records: r.rows };
        // Incluir items de facturas si existen
        if (finTable === 'financial_records' && await tableExists('financial_items')) {
          const recIds = r.rows.map(row => row.id);
          if (recIds.length > 0) {
            const itemQuery = withClinicFilter('financial_items',
              'SELECT * FROM financial_items WHERE record_id = ANY($1::int[]) ORDER BY id LIMIT 50000', [recIds]);
            const items = await pool.query(itemQuery.query, itemQuery.params);
            backupData.modules.finance.items = items.rows;
          }
        }
      } catch (e) {
        console.error('[backup] Finance export failed:', e?.code || e?.name || 'UnknownError');
        throw new Error('No se pudo completar la exportación financiera.');
      }
    }

    // 3. Inventario
    if (selectedModules.includes('inventory')) {
      try {
        const items = (await tableExists('inventory_items'))
          ? await pool.query(...Object.values(withClinicFilter('inventory_items', 'SELECT * FROM inventory_items ORDER BY id LIMIT 5000')))
          : { rows: [] };
        const batches = (await tableExists('inventory_batches'))
          ? await pool.query(...Object.values(withClinicFilter('inventory_batches', 'SELECT * FROM inventory_batches ORDER BY id LIMIT 5000')))
          : { rows: [] };
        const groups = (await tableExists('inventory_groups'))
          ? await pool.query(...Object.values(withClinicFilter('inventory_groups', 'SELECT * FROM inventory_groups ORDER BY id LIMIT 5000')))
          : { rows: [] };
        backupData.modules.inventory = {
          items: { count: items.rows.length, data: items.rows },
          groups: { count: groups.rows.length, data: groups.rows },
          batches: { count: batches.rows.length, data: batches.rows },
        };
        // Incluir movimientos si existen
        if (await tableExists('inventory_movements')) {
          const batchIds = batches.rows.map(b => b.id);
          if (batchIds.length > 0) {
            const movementQuery = withClinicFilter('inventory_movements',
              'SELECT * FROM inventory_movements WHERE batch_id = ANY($1::int[]) ORDER BY id LIMIT 20000', [batchIds]);
            const movements = await pool.query(movementQuery.query, movementQuery.params);
            backupData.modules.inventory.movements = { count: movements.rows.length, data: movements.rows };
          }
        }
      } catch (e) {
        console.error('[backup] Inventory export failed:', e?.code || e?.name || 'UnknownError');
        throw new Error('No se pudo completar la exportación de inventario.');
      }
    }

    const safeClinicId = clinicId ? String(clinicId).replace(/[^a-zA-Z0-9]/g, '') : 'master';
    const filename = `bioskin-backup-clinica${safeClinicId}-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).json(backupData);


  } catch (error) {
    console.error('[backup] Error:', error?.code || error?.name || 'UnknownError');
    return res.status(500).json({ error: 'No se pudo procesar el respaldo.' });
  }
}
