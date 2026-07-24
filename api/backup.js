/**
 * @file api/backup.js
 * @description Respaldo y estadísticas de datos de la clínica.
 *
 * SEGURIDAD: Las consultas se filtran por clinic_id cuando el usuario
 * es clinic_admin o clinic_user. master_admin puede ver todo.
 *
 * Acciones (query param `action`):
 *  - stats   → devuelve conteos por tabla (no descarga)
 *  - backup  → descarga JSON con los datos seleccionados (default)
 */

import { getPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';

// Tablas con columna clinic_id — siempre filtradas por tenant
const CLINIC_SCOPED_TABLES = new Set([
  'patients', 'clinical_records', 'medical_history',
  'consultation_info', 'consultation_history', 'physical_exams',
  'diagnoses', 'treatments', 'injectables', 'prescriptions', 'consent_forms',
  'external_finance_records', 'financial_records',
  'inventory_items', 'inventory_batches',
]);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticateRequest(req);
  if (!auth.valid) return res.status(401).json({ error: 'No autenticado' });

  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database no disponible' });

  const { action = 'backup', modules } = req.query;
  const isMaster = auth.role === 'master_admin';
  // effective_clinic_id: puede ser la clínica objetivo cuando master admin usa X-Target-Clinic-Id
  const clinicId = auth.effective_clinic_id ?? auth.clinic_id;

  // clinic_admin sin clinic_id es un error de configuración
  if (!isMaster && !clinicId) {
    return res.status(403).json({ error: 'Clínica no identificada' });
  }

  // Helper: agrega filtro de clinic_id cuando corresponde
  const withClinicFilter = (table, baseQuery, params = []) => {
    if (isMaster) return { query: baseQuery, params };
    if (!CLINIC_SCOPED_TABLES.has(table)) return { query: baseQuery, params };
    const hasWhere = baseQuery.toUpperCase().includes(' WHERE ');
    const op = hasWhere ? ' AND ' : ' WHERE ';
    return {
      query: baseQuery + `${op}clinic_id = $${params.length + 1}`,
      params: [...params, clinicId],
    };
  };

  // Helper: verifica si una tabla existe
  const tableExists = async (name) => {
    const r = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
      [name]
    );
    return r.rows[0].exists;
  };

  try {
    // ── ESTADÍSTICAS (no descarga) ─────────────────────────────────────────
    if (action === 'stats') {
      const statsMap = [
        { key: 'patients',            table: 'patients',            label: 'Pacientes' },
        { key: 'clinical_records',    table: 'clinical_records',    label: 'Expedientes' },
        { key: 'diagnoses',           table: 'diagnoses',           label: 'Diagnósticos' },
        { key: 'treatments',          table: 'treatments',          label: 'Tratamientos' },
        { key: 'prescriptions',       table: 'prescriptions',       label: 'Recetas' },
        { key: 'physical_exams',      table: 'physical_exams',      label: 'Exámenes Físicos' },
        { key: 'injectables',         table: 'injectables',         label: 'Inyectables' },
        { key: 'consent_forms',       table: 'consent_forms',       label: 'Consentimientos' },
        { key: 'medical_history',     table: 'medical_history',     label: 'Antecedentes' },
        { key: 'finance',             table: 'external_finance_records', label: 'Registros Finanzas' },
        { key: 'inventory_items',     table: 'inventory_items',     label: 'Ítems Inventario' },
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

    // ── DESCARGA DE RESPALDO ───────────────────────────────────────────────
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

    // 1. Pacientes y fichas clínicas
    if (selectedModules.includes('patients')) {
      const tables = [
        'patients', 'clinical_records', 'medical_history', 'consultation_info',
        'consultation_history', 'physical_exams', 'diagnoses', 'treatments',
        'injectables', 'prescriptions', 'consent_forms',
      ];
      const data = {};
      for (const t of tables) {
        try {
          if (!(await tableExists(t))) { data[t] = []; continue; }
          const { query, params } = withClinicFilter(t, `SELECT * FROM ${t} ORDER BY id LIMIT 10000`, []);
          const r = await pool.query(query, params);
          data[t] = r.rows;
        } catch (e) {
          data[t] = [];
          console.warn(`Backup skip table ${t}:`, e.message);
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
        backupData.modules.finance = { count: r.rows.length, records: r.rows };
      } catch (e) {
        backupData.modules.finance = { count: 0, records: [], error: e.message };
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
        backupData.modules.inventory = {
          items: { count: items.rows.length, data: items.rows },
          batches: { count: batches.rows.length, data: batches.rows },
        };
      } catch (e) {
        backupData.modules.inventory = { error: e.message };
      }
    }

    const safeClinicId = clinicId ? String(clinicId).replace(/[^a-zA-Z0-9]/g, '') : 'master';
    const filename = `bioskin-backup-clinica${safeClinicId}-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).json(backupData);

  } catch (error) {
    console.error('[backup] Error:', error);
    return res.status(500).json({ error: 'Error generando respaldo', details: error.message });
  }
}
