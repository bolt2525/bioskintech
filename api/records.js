import crypto from 'crypto';
import { google } from 'googleapis';
import { sql } from '@vercel/postgres';
import { initClinicalDatabase, getPool, getAppPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';
import { generateUploadUrl, generateReadUrl, deleteR2Object, putR2Object } from '../lib/r2-service.js';
import { buildFinanceCsv } from '../lib/finance-csv.js';

console.log('✅ [API] records.js loaded');

// Global flag to track initialization in the current container instance
let dbInitialized = false;

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper — reads session from admin_sessions via @vercel/postgres (neondb_owner)
// ─────────────────────────────────────────────────────────────────────────────

/** Builds the normalized session-user object from authenticateRequest result. */
function buildSu(auth) {
  if (!auth?.valid) return null;
  return {
    role:                auth.role,
    clinic_id:           auth.clinic_id,           // UUID string
    effective_clinic_id: auth.effective_clinic_id, // UUID string (may differ for master)
    user_id:             auth.id,
    access_scope:        auth.access_scope || 'all',
    finance_scope:       auth.finance_scope || 'all',
    inventory_scope:     auth.inventory_scope || 'all',
    calendar_scope:      auth.calendar_scope || 'own',
    username:            auth.username,
  };
}

/**
 * Registra un evento de auditoría en patient_audit_log.
 * Silencioso si falla — la auditoría nunca debe interrumpir la operación principal.
 */
async function logAudit(client, { patientId, recordId, sessionUser, actionType, module, summary, fieldChanges }) {
  try {
    await client.query(
      `INSERT INTO patient_audit_log (patient_id, record_id, clinic_user_id, user_display_name, action_type, module, summary, field_changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        patientId || null,
        recordId  || null,
        sessionUser?.user_id  || null,
        sessionUser?.username || 'Sistema',
        actionType,
        module,
        summary,
        fieldChanges ? JSON.stringify(fieldChanges) : null,
      ]
    );
  } catch { /* silencioso — auditoría no bloquea operaciones */ }
}

/** IDOR guard — returns false if item doesn't belong to the current clinic */
const CLINICAL_TABLES = new Set(['physical_exams', 'diagnoses', 'treatments', 'injectables', 'consent_forms']);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO_TYPES = new Set(['before', 'after', 'diagnostic', 'progress', 'general']);

async function recordBelongsToClinic(pool, recordId, clinicId) {
  if (!recordId || !clinicId) return false;
  const result = await pool.query(
    'SELECT 1 FROM clinical_records WHERE id = $1 AND clinic_id = $2 LIMIT 1',
    [recordId, clinicId]
  );
  return result.rows.length > 0;
}

async function canAccessPatient(pool, sessionUser, patientId) {
  if (!patientId || !sessionUser) return false;
  const clinicId = sessionUser.effective_clinic_id ?? sessionUser.clinic_id;
  const result = await pool.query(
    `SELECT 1 FROM patients p
     WHERE p.id = $1 AND ($2::uuid IS NULL OR p.clinic_id = $2)
       AND ($3::boolean = false OR p.created_by_user_id = $4 OR EXISTS (
         SELECT 1 FROM patient_assignments pa WHERE pa.patient_id = p.id AND pa.clinic_user_id = $4
       )) LIMIT 1`,
    [patientId, clinicId, sessionUser.role !== 'master_admin' && sessionUser.access_scope === 'own', sessionUser.user_id]
  );
  return result.rows.length > 0;
}

async function canAccessRecord(pool, sessionUser, recordId) {
  if (!recordId || !sessionUser) return false;
  const clinicId = sessionUser.effective_clinic_id ?? sessionUser.clinic_id;
  const result = await pool.query(
    `SELECT 1 FROM clinical_records cr
     WHERE cr.id = $1 AND ($2::uuid IS NULL OR cr.clinic_id = $2)
       AND ($3::boolean = false OR cr.created_by_user_id = $4) LIMIT 1`,
    [recordId, clinicId, sessionUser.role !== 'master_admin' && sessionUser.access_scope === 'own', sessionUser.user_id]
  );
  return result.rows.length > 0;
}

async function canAccessFinanceRecord(pool, sessionUser, recordId) {
  if (!recordId || !sessionUser) return false;
  const clinicId = sessionUser.effective_clinic_id ?? sessionUser.clinic_id;
  const result = await pool.query(
    `SELECT 1 FROM financial_records fr
     WHERE fr.id = $1 AND ($2::uuid IS NULL OR fr.clinic_id = $2)
       AND ($3::boolean = false OR fr.created_by_user_id = $4 OR fr.created_by_user_id IN (
         SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
         JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
         WHERE sgm1.clinic_user_id = $4
       )) LIMIT 1`,
    [recordId, clinicId, sessionUser.role !== 'master_admin' && sessionUser.finance_scope === 'own', sessionUser.user_id]
  );
  return result.rows.length > 0;
}

function inventoryOwnerClause(alias, parameterIndex) {
  return `(
    ${alias}.created_by_user_id = $${parameterIndex}
    OR ${alias}.created_by_user_id IS NULL
    OR ${alias}.created_by_user_id IN (
      SELECT sgm2.clinic_user_id
      FROM sharing_group_members sgm1
      JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
      WHERE sgm1.clinic_user_id = $${parameterIndex}
    )
  )`;
}

export function isOwnedPhotoKey(key, clinicId, recordId) {
  const prefix = `clinics/${clinicId}/records/${recordId}/photos/`;
  return typeof key === 'string' && key.startsWith(prefix) &&
    /^[a-f0-9-]{36}\.(?:jpg|jpeg|png|webp|heic)$/i.test(key.slice(prefix.length));
}

// ─────────────────────────────────────────────────────────────────────────────
// Envío de reportes financieros (CSV por correo)
// ─────────────────────────────────────────────────────────────────────────────

/** OAuth2 client de Gmail con los tokens guardados para un usuario. */
async function getUserGmailClient(userId) {
  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const r = await sql`SELECT access_token, refresh_token, token_expiry, email FROM clinic_oauth_tokens WHERE clinic_user_id = ${userId}`;
  if (!r.rows.length) return null;
  const { access_token, refresh_token, token_expiry, email } = r.rows[0];
  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, `${appUrl}/api/calendar`);
  oAuth2.setCredentials({ access_token, refresh_token, expiry_date: token_expiry ? new Date(token_expiry).getTime() : null });
  return { client: oAuth2, email };
}

/** Arma un mensaje MIME multipart (HTML + adjunto CSV) codificado para la Gmail API. */
function buildRawEmailWithCsvAttachment({ from, to, subject, html, attachmentName, attachmentContent }) {
  const boundary = `bioskin_${crypto.randomBytes(8).toString('hex')}`;
  const attachmentB64 = Buffer.from(attachmentContent, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '',
    `--${boundary}`,
    `Content-Type: text/csv; name="${attachmentName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    '',
    attachmentB64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

/** Genera el CSV del rango pedido y lo envía por Gmail al correo de administración financiera configurado. */
async function sendFinanceCsvToAdmin({ pool, clinicId, userId, financeScope = 'all', startDate, endDate, periodLabel }) {
  const settingsRes = await sql`SELECT finanzas, general FROM clinic_settings WHERE clinic_id = ${clinicId}`;
  const finanzas   = settingsRes.rows[0]?.finanzas || {};
  const clinicName = settingsRes.rows[0]?.general?.name || 'la clínica';
  const adminEmail = (finanzas.admin_email || '').trim();
  if (!adminEmail) throw new Error('No hay correo de administrador financiero configurado');

  const oauth = await getUserGmailClient(userId);
  if (!oauth) throw new Error('El usuario no tiene una cuenta Gmail conectada');

  const recordsRes = financeScope === 'own'
    ? await pool.query(
      `SELECT * FROM financial_records WHERE clinic_id = $1 AND date >= $2 AND date <= $3
       AND (created_by_user_id = $4 OR created_by_user_id IN (
         SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
         JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
         WHERE sgm1.clinic_user_id = $4
       )) ORDER BY date ASC`,
      [clinicId, startDate, endDate, userId]
    )
    : await pool.query(
      'SELECT * FROM financial_records WHERE clinic_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
      [clinicId, startDate, endDate]
    );
  const csv = buildFinanceCsv(recordsRes.rows);
  const gmail = google.gmail({ version: 'v1', auth: oauth.client });
  const raw = buildRawEmailWithCsvAttachment({
    from: `${clinicName} <${oauth.email}>`,
    to: adminEmail,
    subject: `Reporte financiero (${periodLabel}) — ${clinicName}`,
    html: `<p>Adjunto el reporte financiero de <strong>${clinicName}</strong> (${periodLabel}, ${startDate} a ${endDate}).</p><p>Registros incluidos: ${recordsRes.rows.length}</p>`,
    attachmentName: `finanzas_${startDate}_${endDate}.csv`,
    attachmentContent: csv,
  });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { recordCount: recordsRes.rows.length, adminEmail };
}

/** Decide si hoy corresponde enviar el reporte programado y qué rango de fechas cubre. Retorna null si no toca hoy. */
export function resolveScheduledRange(schedule, weekday, monthDay, today = new Date()) {
  const fmt = (d) => d.toISOString().split('T')[0];
  if (schedule === 'daily') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    return { startDate: fmt(y), endDate: fmt(y), periodLabel: 'diario' };
  }
  if (schedule === 'weekly') {
    if (Number(weekday) !== today.getDay()) return null;
    const start = new Date(today); start.setDate(start.getDate() - 7);
    const end = new Date(today); end.setDate(end.getDate() - 1);
    return { startDate: fmt(start), endDate: fmt(end), periodLabel: 'semanal' };
  }
  if (schedule === 'monthly') {
    if (Number(monthDay) !== today.getDate()) return null;
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end   = new Date(today.getFullYear(), today.getMonth(), 0);
    return { startDate: fmt(start), endDate: fmt(end), periodLabel: 'mensual' };
  }
  return null;
}

/** Recorre las clínicas con envío programado activo y despacha el CSV correspondiente a cada una. */
async function sendScheduledFinanceCsvs() {
  const appPool = getAppPool();
  if (!appPool) return { clinicsChecked: 0, sent: 0, errors: ['NEON_APP_URL no configurada'] };

  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }));
  const clinics = await sql`
    SELECT DISTINCT ON (cs.clinic_id) cs.clinic_id, cs.finanzas, t.clinic_user_id, cu.finance_scope
    FROM clinic_settings cs
    JOIN clinic_oauth_tokens t ON t.clinic_id = cs.clinic_id AND t.clinic_user_id IS NOT NULL
    JOIN clinic_users cu ON cu.id = t.clinic_user_id AND cu.is_active = true
    LEFT JOIN clinic_features cf ON cf.clinic_id = cs.clinic_id AND cf.feature = 'finance'
    LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'finance'
    WHERE cs.finanzas->>'csv_schedule' IN ('daily','weekly','monthly')
      AND COALESCE(cs.finanzas->>'admin_email','') != ''
      AND COALESCE(cf.enabled, true) = true
      AND COALESCE(umo.enabled, true) = true
    ORDER BY cs.clinic_id, (cu.role = 'clinic_admin') DESC, cu.id
  `;

  let sent = 0;
  const errors = [];
  for (const row of clinics.rows) {
    const f = row.finanzas || {};
    const range = resolveScheduledRange(f.csv_schedule, f.csv_weekday, f.csv_month_day, today);
    if (!range) continue;
    const client = await appPool.connect();
    try {
      await client.query("SELECT set_config('app.current_tenant', $1, false)", [String(row.clinic_id)]);
      const tenantPool = { query: (...a) => client.query(...a) };
      await sendFinanceCsvToAdmin({ pool: tenantPool, clinicId: row.clinic_id, userId: row.clinic_user_id, financeScope: row.finance_scope, ...range });
      sent++;
    } catch (err) {
      errors.push(`clinic ${row.clinic_id}: ${err.message}`);
    } finally {
      try { await client.query("SELECT set_config('app.current_tenant', '', false)"); } catch { /* ignore */ }
      client.release();
    }
  }
  return { clinicsChecked: clinics.rows.length, sent, errors };
}

async function ownedByClinic(pool, table, itemId, clinicId) {
  if (!clinicId || !CLINICAL_TABLES.has(table)) return true;
  const r = await pool.query(
    `SELECT p.clinic_id FROM ${table} t
     JOIN clinical_records cr ON cr.id = t.record_id
     JOIN patients p ON p.id = cr.patient_id
     WHERE t.id = $1`,
    [itemId]
  );
  return r.rows.length > 0 && String(r.rows[0].clinic_id) === String(clinicId);
}

export default async function handler(req, res) {
  console.log(`[Clinical Records API] Request received: ${req.method} ${req.url}`);

  // CORS headers
  const requestOrigin = req.headers.origin || '';
  const allowedOrigins = (process.env.ADMIN_CORS_ORIGIN || 'https://bioskintech.vercel.app,http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim());
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-Clinic-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Cron: reportes financieros programados (diario/semanal/mensual) ──────
  if (req.method === 'GET' && req.query.action === 'sendScheduledFinanceCsv') {
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }
    try {
      const result = await sendScheduledFinanceCsvs();
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('❌ Error en CSV programado de finanzas:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  try {
    let { action } = req.query;
    const body = req.body || {};

    // Allow action to be passed in body for POST requests
    if (!action && body.action) {
      action = body.action;
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    // ponytail: whitelist mínima pública; cualquier acción nueva requiere auth por defecto
    const PUBLIC_ACTIONS = new Set(['health', 'submitSignature', 'getSigningSession']);
    let auth = null;
    if (!PUBLIC_ACTIONS.has(action)) {
      auth = await authenticateRequest(req);
      if (!auth?.valid) return res.status(401).json({ error: 'No autenticado' });
    }

    // Session user object compatible con código existente
    const su = buildSu(auth);
    // ponytail: aliases — auth ya fue verificada arriba, ambas devuelven el mismo su
    const getSessionUserOnce = async () => su;
    const getSessionUser = async (_pool, _req) => su;

    const appPool = getAppPool();
    if (!appPool) {
      return res.status(500).json({ error: 'Database connection not configured. Check NEON_DATABASE_URL.' });
    }

    // ── Health check ──────────────────────────────────────────────────────
    if (action === 'health') {
      try {
        const client = await appPool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        return res.status(200).json({ 
          status: 'ok', 
          message: 'Clinical Records API is running', 
          db_time: result.rows[0].now 
        });
      } catch (err) {
        console.error('❌ Health check failed:', err);
        return res.status(500).json({ error: 'Database connection failed', details: err.message });
      }
    }

    const normalizeOptionalText = (value) => {
      if (value == null) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    };

    const normalizeOptionalNumber = (value) => {
      if (value == null || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    // Auto-inicializar el schema clínico en el primer uso del contenedor
    if (!dbInitialized) {
      try {
        await initClinicalDatabase();
        dbInitialized = true;
      } catch (e) {
        console.error('⚠️ Clinical DB init warning:', e.message);
      }
    }

    // ── Acquire tenant-scoped client ──────────────────────────────────────
    // is_local=false → session-level; se resetea a '' en el finally antes de release.
    // ponytail: más simple que BEGIN/COMMIT y compatible con early-return en cada case.
    const effectiveClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
    const client = await appPool.connect();

    try {
      await client.query(
        "SELECT set_config('app.current_tenant', $1, false)",
        [effectiveClinicId ? String(effectiveClinicId) : '']
      );

      // ponytail: pool alias para los pocos handlers que usan pool.connect() internamente
      const pool = { query: (...a) => client.query(...a), connect: () => appPool.connect() };

      const patientIdByAction = {
        getPatient: req.query.id,
        listRecords: req.query.patient_id,
        createRecord: body.patient_id,
        updatePatient: body.id,
        deletePatient: req.query.id,
        listConsents: req.query.patient_id,
        listAuditLog: req.query.patient_id,
      };
      const directRecordIdByAction = {
        getRecordData: req.query.recordId,
        listConsultations: req.query.record_id,
        createConsultation: body.record_id,
        listHistorySnapshots: req.query.record_id,
        saveConsultation: body.recordId,
        saveHistory: body.record_id,
        savePhysicalExam: body.id ? null : body.record_id,
        saveDiagnosis: body.id ? null : body.record_id,
        addTreatment: body.record_id,
        getInjectablesByRecord: req.query.record_id,
        addInjectable: body.record_id,
        listPrescriptions: req.query.record_id,
        createPrescription: body.ficha_id,
        uploadPhotoProxy: body.record_id,
        getPhotoUploadUrl: body.record_id,
        confirmPhotoUpload: body.record_id,
        listPhotos: req.query.record_id,
        deleteRecord: req.query.id,
        listConsents: req.query.record_id,
        listAuditLog: req.query.record_id,
        saveConsent: body.id ? null : body.record_id,
      };
      const childRecordTables = {
        updateConsultation: ['consultations', body.id],
        deleteConsultation: ['consultations', req.query.id],
        deleteConsultationHistory: ['consultation_history', req.query.id],
        savePhysicalExam: ['physical_exams', body.id],
        deletePhysicalExam: ['physical_exams', req.query.id],
        saveDiagnosis: ['diagnoses', body.id],
        deleteDiagnosis: ['diagnoses', req.query.id],
        updateTreatment: ['treatments', body.id],
        deleteTreatment: ['treatments', req.query.id],
        getInjectablesByTreatment: ['treatments', req.query.treatment_id],
        updateInjectable: ['injectables', body.id],
        deleteInjectable: ['injectables', req.query.id],
        getPrescription: ['prescriptions', req.query.id],
        updatePrescription: ['prescriptions', body.id],
        deletePrescription: ['prescriptions', req.query.id],
        getConsent: ['consent_forms', req.query.id],
        generateSigningToken: ['consent_forms', body.id],
        deleteConsent: ['consent_forms', req.query.id],
        saveConsent: ['consent_forms', body.id],
      };

      if (su?.role !== 'master_admin' && su?.access_scope === 'own') {
        const patientId = patientIdByAction[action];
        if (patientId && !(await canAccessPatient(pool, su, patientId)))
          return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });

        let recordId = directRecordIdByAction[action];
        const child = childRecordTables[action];
        if (!recordId && child?.[1]) {
          const childRecord = await pool.query(`SELECT record_id FROM ${child[0]} WHERE id = $1 LIMIT 1`, [child[1]]);
          recordId = childRecord.rows[0]?.record_id;
        }
        if (recordId && !(await canAccessRecord(pool, su, recordId)))
          return res.status(403).json({ error: 'Acceso no autorizado a este expediente' });
      }

      switch (action) {
      case 'init':
      case 'initClinical':
        return res.status(200).json({ success: true, message: 'Clinical database initialized' });

      // ==========================================
      // INVENTORY MODULE ACTIONS
      // ==========================================

      case 'inventoryListMovements':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const limit = req.query.limit || 100;
          const { type, startDate, endDate } = req.query;
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

          const params = [];
          let paramCount = 1;
          let query = `
            SELECT m.*, i.name as item_name, i.sku, b.batch_number, b.expiration_date
            FROM inventory_movements m
            JOIN inventory_batches b ON m.batch_id = b.id
            JOIN inventory_items i ON b.item_id = i.id
            WHERE 1=1
          `;
          // Filtro tenant via JOIN
          if (invClinicId) {
            query += ` AND (i.clinic_id = $${paramCount} OR i.clinic_id IS NULL)`;
            params.push(invClinicId);
            paramCount++;
          }
          if (su.inventory_scope === 'own') {
            query += ` AND ${inventoryOwnerClause('i', paramCount)}`;
            params.push(su.user_id);
            paramCount++;
          }
          if (type && type !== 'all') {
            if (type === 'IN')  query += ` AND m.quantity_change > 0`;
            if (type === 'OUT') query += ` AND m.quantity_change < 0`;
          }
          if (startDate) { query += ` AND m.created_at >= $${paramCount}`; params.push(startDate); paramCount++; }
          if (endDate)   { query += ` AND m.created_at <= $${paramCount}`; params.push(endDate);   paramCount++; }
          query += ` ORDER BY m.created_at DESC LIMIT $${paramCount}`;
          params.push(Math.min(parseInt(limit) || 100, 500));

          const movements = await pool.query(query, params);
          return res.status(200).json(movements.rows);
        } catch (err) {
          console.error('Error listing movements:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryDeleteMovement':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Sin permiso' });
          const { id } = req.query;
          const deleteParams = [id];
          let deleteQuery = `DELETE FROM inventory_movements m WHERE m.id = $1 AND EXISTS (
            SELECT 1 FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
            WHERE b.id = m.batch_id`;
          if (su.inventory_scope === 'own') {
            deleteQuery += ` AND ${inventoryOwnerClause('i', 2)}`;
            deleteParams.push(su.user_id);
          }
          deleteQuery += ') RETURNING m.id';
          const deleted = await pool.query(deleteQuery, deleteParams);
          if (!deleted.rows.length) return res.status(403).json({ error: 'Sin acceso al movimiento' });
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting movement:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryClearMovements':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (su.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
          const { days } = body;
          const daysInt = parseInt(days, 10);
          if (!Number.isFinite(daysInt) || daysInt <= 0)
            return res.status(400).json({ error: 'days debe ser un entero positivo' });
          // Usar parámetro — sin interpolación de string (previene inyección con días negativos)
          await pool.query(`DELETE FROM inventory_movements WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`, [daysInt]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error clearing movements:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryListBatches':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          const params = [];
          let whereClause = `b.status = 'active' AND b.quantity_current > 0`;
          if (invClinicId) {
            whereClause += ` AND (i.clinic_id = $1 OR i.clinic_id IS NULL)`;
            params.push(invClinicId);
          }
          if (su.inventory_scope === 'own') {
            const ownerParam = params.length + 1;
            whereClause += ` AND ${inventoryOwnerClause('i', ownerParam)}`;
            params.push(su.user_id);
          }
          const batches = await pool.query(`
            SELECT b.*, i.name as item_name, i.sku, i.category, i.unit_of_measure
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE ${whereClause}
            ORDER BY b.expiration_date ASC
          `, params);
          return res.status(200).json(batches.rows);
        } catch (err) {
          console.error('Error listing batches:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryListItems':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          const filterByUserId = su.inventory_scope === 'all' && ['clinic_admin','master_admin'].includes(su?.role) && req.query.filterByUserId
            ? parseInt(req.query.filterByUserId, 10) : null;

          const params = [];
          let pCount = 1;
          const wheres = [];

          if (invClinicId) {
            wheres.push(`(i.clinic_id = $${pCount} OR i.clinic_id IS NULL)`);
            params.push(invClinicId);
            pCount++;
          }
          if (filterByUserId) {
            // Admin filtrando por profesional → ítems propios + ítems compartidos de la clínica
            const fu = invClinicId ? await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 LIMIT 1', [filterByUserId, invClinicId]) : { rows: [{}] };
            if (fu.rows.length) {
              wheres.push(`(i.created_by_user_id = $${pCount} OR i.created_by_user_id IS NULL)`);
              params.push(filterByUserId);
              pCount++;
            }
          } else if (su.inventory_scope === 'own') {
            wheres.push(inventoryOwnerClause('i', pCount));
            params.push(su.user_id);
            pCount++;
          }

          const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
          const items = await pool.query(`
            SELECT i.*,
              cu.full_name AS created_by_user_name, cu.username AS created_by_username,
              COALESCE(SUM(b.quantity_current), 0) as total_stock,
              COALESCE(SUM(b.quantity_initial), 0) as total_initial,
              COUNT(b.id) as batch_count,
              MIN(b.expiration_date) as next_expiry
            FROM inventory_items i
            LEFT JOIN inventory_batches b ON i.id = b.item_id AND b.status = 'active'
            LEFT JOIN clinic_users cu ON cu.id = i.created_by_user_id
            ${whereClause}
            GROUP BY i.id, cu.full_name, cu.username
            ORDER BY i.name ASC
          `, params);
          return res.status(200).json(items.rows);
        } catch (err) {
          console.error('Error listing inventory:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryStats':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

          // Fetch expiry_alert_days from clinic settings (default 30)
          let expiryAlertDays = 30;
          if (invClinicId) {
            try {
              const settingsRow = await pool.query(
                `SELECT inventario->>'expiry_alert_days' AS expiry_alert_days FROM clinic_settings WHERE clinic_id = $1`,
                [invClinicId]
              );
              const val = parseInt(settingsRow.rows[0]?.expiry_alert_days);
              if (!isNaN(val) && val > 0) expiryAlertDays = val;
            } catch { /* use default */ }
          }

          // Usar parámetros $1 — sin interpolación de string para clinic_id
          const clinicParam = invClinicId ? [invClinicId] : [];
          const iWhere = invClinicId ? `AND (i.clinic_id = $1 OR i.clinic_id IS NULL)` : '';
          const bWhere = invClinicId ? `JOIN inventory_items ii ON ii.id = b.item_id AND (ii.clinic_id = $1 OR ii.clinic_id IS NULL)` : '';
          const alertWhere = invClinicId ? `AND (i.clinic_id = $1 OR i.clinic_id IS NULL)` : '';
          const ownerParam = clinicParam.length + 1;
          const ownerWhere = su.inventory_scope === 'own' ? ` AND ${inventoryOwnerClause('i', ownerParam)}` : '';
          const batchOwnerWhere = su.inventory_scope === 'own' ? ` AND ${inventoryOwnerClause('ii', ownerParam)}` : '';
          if (su.inventory_scope === 'own') clinicParam.push(su.user_id);

          const statsResult = await pool.query(`
            SELECT
              COUNT(DISTINCT i.id)::int AS total_items,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) = 0 THEN i.id END)::int AS out_of_stock_count,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) > 0 AND COALESCE(stock.total_stock, 0) <= i.min_stock_level THEN i.id END)::int AS low_stock_count
            FROM inventory_items i
            LEFT JOIN (
              SELECT item_id, SUM(quantity_current) AS total_stock
              FROM inventory_batches WHERE status = 'active'
              GROUP BY item_id
            ) stock ON stock.item_id = i.id
            WHERE 1=1 ${iWhere}${ownerWhere}
          `, clinicParam);

          const batchStats = await pool.query(`
            SELECT
              COUNT(CASE WHEN b.expiration_date < CURRENT_DATE THEN 1 END)::int AS expired_count,
              COUNT(CASE WHEN b.expiration_date >= CURRENT_DATE AND b.expiration_date <= CURRENT_DATE + INTERVAL '${expiryAlertDays} days' THEN 1 END)::int AS expiring_soon_count
            FROM inventory_batches b ${bWhere}
            WHERE b.status = 'active'${batchOwnerWhere}
          `, clinicParam);

          const movementsStats = await pool.query(`
            SELECT COUNT(*)::int AS movements_this_month
            FROM inventory_movements m
            JOIN inventory_batches b ON b.id = m.batch_id
            JOIN inventory_items i ON i.id = b.item_id
            WHERE m.created_at >= DATE_TRUNC('month', CURRENT_DATE)
              ${iWhere}${ownerWhere}
          `, clinicParam);

          const alertBatches = await pool.query(`
            SELECT b.id, b.batch_number, b.expiration_date, b.quantity_current,
              i.name AS item_name, i.sku, i.unit_of_measure,
              CASE WHEN b.expiration_date < CURRENT_DATE THEN 'expired'
                   WHEN b.expiration_date <= CURRENT_DATE + INTERVAL '${expiryAlertDays} days' THEN 'expiring_soon'
              END AS alert_type
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE b.status = 'active'
              AND (b.expiration_date < CURRENT_DATE OR b.expiration_date <= CURRENT_DATE + INTERVAL '${expiryAlertDays} days')
              ${alertWhere}${ownerWhere}
            ORDER BY b.expiration_date ASC LIMIT 20
          `, clinicParam);

          return res.status(200).json({
            ...statsResult.rows[0],
            ...batchStats.rows[0],
            ...movementsStats.rows[0],
            alert_batches: alertBatches.rows
          });
        } catch (err) {
          console.error('Error fetching inventory stats:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryGetItem':
        try {
          const itemId = req.query.id;
          const su = await getSessionUserOnce();
          const cid = su?.effective_clinic_id ?? su?.clinic_id;
          // Tenant check: restrict item visibility to the user's clinic (A-1 fix)
          const itemParams = [itemId];
          let itemQuery = 'SELECT * FROM inventory_items i WHERE i.id = $1';
          if (cid) { itemQuery += ' AND (i.clinic_id = $2 OR i.clinic_id IS NULL)'; itemParams.push(cid); }
          if (su?.inventory_scope === 'own') {
            itemQuery += ` AND ${inventoryOwnerClause('i', itemParams.length + 1)}`;
            itemParams.push(su.user_id);
          }
          const itemResult = await pool.query(itemQuery, itemParams);
          
          if (itemResult.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
          }

          const batchesResult = await pool.query(`
            SELECT * FROM inventory_batches 
            WHERE item_id = $1 AND status = 'active' 
            ORDER BY expiration_date ASC
          `, [itemId]);

          const movementsResult = await pool.query(`
            SELECT m.*, b.batch_number 
            FROM inventory_movements m
            JOIN inventory_batches b ON m.batch_id = b.id
            WHERE b.item_id = $1
            ORDER BY m.created_at DESC
            LIMIT 50
          `, [itemId]);

          return res.status(200).json({
            item: itemResult.rows[0],
            batches: batchesResult.rows,
            movements: movementsResult.rows
          });
        } catch (err) {
          console.error('Error getting inventory item:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryCreateItem':
        try {
          const { sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price } = body;
          const cleanSku = normalizeOptionalText(sku);
          const cleanBrand = normalizeOptionalText(brand);
          const cleanDescription = normalizeOptionalText(description);
          const cleanGroupName = normalizeOptionalText(group_name);
          const cleanSanitaryRegistration = normalizeOptionalText(sanitary_registration);
          const suInv = await getSessionUserOnce();
          const invClinicId = suInv?.effective_clinic_id ?? suInv?.clinic_id ?? null;
          const newItem = await pool.query(`
            INSERT INTO inventory_items (clinic_id, sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price, created_by_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
          `, [invClinicId, cleanSku, name, cleanBrand, cleanDescription, category, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
              normalizeOptionalNumber(cost_price),
              normalizeOptionalNumber(sale_price),
              suInv?.user_id ?? null]);
          return res.status(201).json(newItem.rows[0]);
        } catch (err) {
          console.error('Error creating inventory item:', err);
          if (err.code === '23505') {
            return res.status(409).json({ error: 'El SKU ya existe en esta clínica. Usa otro código o deja el campo vacío.' });
          }
          return res.status(500).json({ error: 'Error al crear producto de inventario.' });
        }

      case 'inventoryUpdateItem':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const { id, sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price } = body;
          const cleanSku = normalizeOptionalText(sku);
          const cleanBrand = normalizeOptionalText(brand);
          const cleanDescription = normalizeOptionalText(description);
          const cleanGroupName = normalizeOptionalText(group_name);
          const cleanSanitaryRegistration = normalizeOptionalText(sanitary_registration);
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          // Verificar que el item pertenece a la clínica del usuario
          const clinicCheck = invClinicId
            ? ` AND (clinic_id = $14 OR clinic_id IS NULL)`
            : '';
          const params = [cleanSku, name, cleanBrand, cleanDescription, category, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
            normalizeOptionalNumber(cost_price), normalizeOptionalNumber(sale_price), id];
          if (invClinicId) params.push(invClinicId);
          const ownerCheck = su.inventory_scope === 'own'
            ? ` AND ${inventoryOwnerClause('inventory_items', params.length + 1)}`
            : '';
          if (su.inventory_scope === 'own') params.push(su.user_id);
          const updatedItem = await pool.query(
            `UPDATE inventory_items SET sku=$1, name=$2, brand=$3, description=$4, category=$5, group_name=$6, unit_of_measure=$7, min_stock_level=$8, requires_cold_chain=$9, sanitary_registration=$10, cost_price=$11, sale_price=$12 WHERE id=$13${clinicCheck}${ownerCheck} RETURNING *`,
            params
          );
          if (updatedItem.rows.length === 0) return res.status(404).json({ error: 'Item not found or not in your clinic' });
          return res.status(200).json(updatedItem.rows[0]);
        } catch (err) {
          console.error('Error updating inventory item:', err);
          if (err.code === '23505') return res.status(409).json({ error: 'El SKU ya existe. Usa otro código o deja el campo vacío.' });
          return res.status(500).json({ error: 'Error al actualizar producto de inventario.' });
        }

      case 'inventoryDeleteItem':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Solo administradores pueden eliminar productos' });
          const { id } = req.query;
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          if (invClinicId) {
            const checkParams = [id, invClinicId];
            let checkQuery = 'SELECT id FROM inventory_items i WHERE id = $1 AND (i.clinic_id = $2 OR i.clinic_id IS NULL)';
            if (su.inventory_scope === 'own') {
              checkQuery += ` AND ${inventoryOwnerClause('i', 3)}`;
              checkParams.push(su.user_id);
            }
            const check = await pool.query(checkQuery, checkParams);
            if (check.rows.length === 0) return res.status(403).json({ error: 'Producto no encontrado en tu clínica' });
          }
          // Use pool.query (tenant-scoped client) — not pool.connect() which would skip set_config tenant
          await pool.query('BEGIN');
          try {
            const batchesCheck = await pool.query('SELECT id FROM inventory_batches WHERE item_id = $1', [id]);
            const batchIds = batchesCheck.rows.map(b => b.id);
            if (batchIds.length > 0) {
              await pool.query('DELETE FROM inventory_movements WHERE batch_id = ANY($1)', [batchIds]);
              await pool.query('DELETE FROM inventory_batches WHERE item_id = $1', [id]);
            }
            await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]);
            await pool.query('COMMIT');
            return res.status(200).json({ success: true });
          } catch (txError) {
            await pool.query('ROLLBACK');
            throw txError;
          }
        } catch (err) {
          console.error('Error deleting inventory item:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryDeleteBatch':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Solo administradores pueden eliminar lotes' });
          const { id } = req.query;
          if (su.inventory_scope === 'own') {
            const owner = await pool.query(
              `SELECT 1 FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
               WHERE b.id = $1 AND ${inventoryOwnerClause('i', 2)}`,
              [id, su.user_id]
            );
            if (!owner.rows.length) return res.status(403).json({ error: 'Sin acceso al lote' });
          }
          // Tenant check: verify batch belongs to user's clinic (A-1 fix)
          const cid = su?.effective_clinic_id ?? su?.clinic_id;
          if (cid != null && su.role !== 'master_admin') {
            const chk = await pool.query(
              'SELECT i.clinic_id FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id WHERE b.id = $1',
              [id]
            );
            if (chk.rows.length && chk.rows[0].clinic_id !== cid)
              return res.status(403).json({ error: 'Lote no pertenece a esta clínica' });
          }
          await pool.query('DELETE FROM inventory_movements WHERE batch_id = $1', [id]);
          await pool.query('DELETE FROM inventory_batches WHERE id = $1', [id]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting batch:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryAddBatch':
        try {
          const { item_id, batch_number, expiration_date, quantity, cost_per_unit } = body;
          // Tenant check: verify item belongs to user's clinic before adding stock (A-1 fix)
          const suBatch = await getSessionUserOnce();
          const batchCid = suBatch?.effective_clinic_id ?? suBatch?.clinic_id;
          if (batchCid != null && suBatch?.role !== 'master_admin') {
            const itemChk = await pool.query('SELECT clinic_id FROM inventory_items WHERE id = $1', [item_id]);
            if (itemChk.rows.length && itemChk.rows[0].clinic_id !== batchCid)
              return res.status(403).json({ error: 'Ítem no pertenece a esta clínica' });
          }
          // Resolve clinic_id for insertion (use item's clinic_id as source of truth)
          const itemParams = [item_id];
          let itemQuery = 'SELECT clinic_id FROM inventory_items i WHERE id = $1';
          if (suBatch?.inventory_scope === 'own') {
            itemQuery += ` AND ${inventoryOwnerClause('i', 2)}`;
            itemParams.push(suBatch.user_id);
          }
          const itemRow = await pool.query(itemQuery, itemParams);
          if (!itemRow.rows.length) return res.status(403).json({ error: 'Sin acceso al producto' });
          const resolvedClinicId = itemRow.rows[0]?.clinic_id ?? batchCid ?? null;
          // Use the outer tenant-scoped client via pool.query — avoids creating a new connection without app.current_tenant
          await pool.query('BEGIN');
          try {
            const newBatch = await pool.query(`
              INSERT INTO inventory_batches (item_id, clinic_id, batch_number, expiration_date, quantity_initial, quantity_current, cost_per_unit, status)
              VALUES ($1, $2, $3, $4, $5, $5, $6, 'active')
              RETURNING *
            `, [item_id, resolvedClinicId, batch_number, expiration_date, quantity, cost_per_unit]);

            await pool.query(`
              INSERT INTO inventory_movements (batch_id, clinic_id, movement_type, quantity_change, reason, user_id)
              VALUES ($1, $2, 'PURCHASE', $3, 'Ingreso inicial de lote', $4)
            `, [newBatch.rows[0].id, resolvedClinicId, quantity, suBatch?.user_id ?? null]);

            await pool.query('COMMIT');
            return res.status(201).json(newBatch.rows[0]);
          } catch (e) {
            await pool.query('ROLLBACK');
            throw e;
          }
        } catch (err) {
          console.error('Error adding batch:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryConsume':
        try {
          const { batch_id, quantity, reason, reference_id, preferred_display_unit } = body;
          // Tenant check: verify batch belongs to user's clinic before consuming (A-1 fix)
          const suCons = await getSessionUserOnce();
          const consCid = suCons?.effective_clinic_id ?? suCons?.clinic_id;
          if (suCons?.inventory_scope === 'own') {
            const access = await pool.query(
              `SELECT 1 FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
               WHERE b.id = $1 AND ${inventoryOwnerClause('i', 2)}`,
              [batch_id, suCons.user_id]
            );
            if (!access.rows.length) return res.status(403).json({ error: 'Sin acceso al producto' });
          }
          if (consCid != null && suCons?.role !== 'master_admin') {
            const tenantChk = await pool.query(
              'SELECT i.clinic_id FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id WHERE b.id = $1',
              [batch_id]
            );
            if (tenantChk.rows.length && tenantChk.rows[0].clinic_id !== consCid)
              return res.status(403).json({ error: 'Lote no pertenece a esta clínica' });
          }
          const client = await pool.connect();
          try {
            // Propagar tenant context al cliente interno (necesario para RLS)
            await client.query("SELECT set_config('app.current_tenant', $1, false)", [consCid ? String(consCid) : '']);
            await client.query('BEGIN');
            
            // Check current stock
            const batchRes = await client.query('SELECT quantity_current, item_id, clinic_id FROM inventory_batches WHERE id = $1', [batch_id]);
            if (batchRes.rows.length === 0) throw new Error('Batch not found');
            
            const currentQty = parseFloat(batchRes.rows[0].quantity_current);
            const itemId = batchRes.rows[0].item_id;
            const batchClinicId = batchRes.rows[0].clinic_id;

            if (currentQty < quantity) throw new Error('Insufficient stock in this batch');

            const newQty = currentQty - quantity;
            const newStatus = newQty <= 0 ? 'depleted' : 'active';

            // Update Batch only if quantity > 0
            if (quantity > 0) {
              await client.query(`
                UPDATE inventory_batches 
                SET quantity_current = $1, status = $2 
                WHERE id = $3
              `, [newQty, newStatus, batch_id]);
            }

            // Update Item Preference if provided
            if (preferred_display_unit) {
              await client.query(`
                UPDATE inventory_items
                SET preferred_display_unit = $1
                WHERE id = $2
              `, [preferred_display_unit, itemId]);
            }

            // Record Movement only if quantity > 0
            if (quantity > 0) {
              await client.query(`
                INSERT INTO inventory_movements (batch_id, clinic_id, movement_type, quantity_change, reason, reference_id, user_id)
                VALUES ($1, $2, 'CONSUMPTION', $3, $4, $5, $6)
              `, [batch_id, batchClinicId, -quantity, reason, reference_id, suCons?.user_id ?? null]);
            }

            await client.query('COMMIT');
            return res.status(200).json({ success: true, new_quantity: newQty });
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }
        } catch (err) {
          console.error('Error consuming inventory:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'listPatients': {
        const su = await getSessionUser(pool, req);
        const filterMine = req.query.filterMine === 'true';
        // viewAsUserId: master_admin navegando AS un usuario específico → ver exactamente lo que ve ese usuario
        const viewAsUserId  = su?.role === 'master_admin' && req.query.viewAsUserId  ? parseInt(req.query.viewAsUserId,  10) : null;
        // filterByUserId: admin filtrando la vista clínica por profesional (no impersonación)
        const filterByUserId = su?.access_scope === 'all' && ['master_admin','clinic_admin'].includes(su?.role) && req.query.filterByUserId ? parseInt(req.query.filterByUserId, 10) : null;

        let pq, pp = [];
        const effectiveClinicId = su?.effective_clinic_id ?? su?.clinic_id;

        // ponytail: helper para queries con owner JOIN — evita repetición
        const fromOwner = `FROM patients p LEFT JOIN clinic_users cu ON cu.id = p.created_by_user_id`;
        const selOwner  = `SELECT p.*, cu.full_name AS created_by_user_name, cu.username AS created_by_username, ROW_NUMBER() OVER (PARTITION BY p.clinic_id ORDER BY p.id) AS seq`;
        // filtro de pacientes propios + asignados
        const ownFilter = `AND (p.created_by_user_id = $2 OR EXISTS (SELECT 1 FROM patient_assignments pa WHERE pa.patient_id = p.id AND pa.clinic_user_id = $2))`;

        if (!su || effectiveClinicId == null) {
          // Pre-migración o master sin contexto de clínica
          const cf = req.query.clinicId ? parseInt(req.query.clinicId) : null;
          if (cf) { pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`; pp = [cf]; }
          else    { pq = `${selOwner} ${fromOwner} ORDER BY p.last_name, p.first_name`; }

        } else if (viewAsUserId) {
          // Impersonación: aplicar scope real del usuario destino
          const vu = await pool.query(
            'SELECT access_scope FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true LIMIT 1',
            [viewAsUserId, effectiveClinicId]
          );
          if (vu.rows.length && vu.rows[0].access_scope === 'own') {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId, viewAsUserId];
          } else {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId];
          }

        } else if (filterByUserId) {
          // Filtro por profesional en vista clínica — validar que el usuario pertenezca a esta clínica
          const fu = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 LIMIT 1', [filterByUserId, effectiveClinicId]);
          if (fu.rows.length) {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId, filterByUserId];
          } else {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId];
          }

        } else if (su.access_scope === 'own' || (su.access_scope === 'all' && filterMine)) {
          pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
          pp = [effectiveClinicId, su.user_id];

        } else {
          pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
          pp = [effectiveClinicId];
        }

        // Búsqueda por texto — usar alias p. para evitar ambigüedad con el JOIN
        const searchTerm = req.query.search?.trim();
        if (searchTerm && pp.length > 0) {
          const idx = pp.length + 1;
          pq = pq.replace('ORDER BY', `AND (CONCAT_WS(' ', p.first_name, p.last_name) ILIKE $${idx} OR p.first_name ILIKE $${idx} OR p.last_name ILIKE $${idx} OR p.rut ILIKE $${idx}) ORDER BY`);
          pp.push(`%${searchTerm}%`);
        } else if (searchTerm) {
          pq = `${selOwner} ${fromOwner} WHERE (CONCAT_WS(' ', p.first_name, p.last_name) ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1 OR p.rut ILIKE $1) ORDER BY p.last_name, p.first_name`;
          pp = [`%${searchTerm}%`];
        }

        const limitVal = parseInt(req.query.limit || '500');
        pq += ` LIMIT ${Math.min(limitVal, 1000)}`;
        const patients = await pool.query(pq, pp);
        return res.status(200).json(patients.rows);
      }

      case 'getPatient': {
        const { id } = req.query;
        const patient = await pool.query('SELECT * FROM patients WHERE id = $1', [id]);
        if (patient.rows.length === 0) return res.status(404).json({ error: 'Patient not found' });
        // Clinic scope check
        const su = await getSessionUser(pool, req);
        if (su?.clinic_id != null && patient.rows[0].clinic_id != null && patient.rows[0].clinic_id !== su.clinic_id && su.role !== 'master_admin') {
          return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });
        }
        // own-scope: solo permite acceso a pacientes propios o asignados explícitamente
        if (su?.access_scope === 'own' && su.user_id != null) {
          const owned = patient.rows[0].created_by_user_id === su.user_id;
          if (!owned) {
            const asgn = await pool.query(
              'SELECT 1 FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2 LIMIT 1',
              [patient.rows[0].id, su.user_id]
            );
            if (!asgn.rows.length) return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });
          }
        }
        // Also fetch active record ID — scoped to user for 'own' access
        let recordQuery, recordParams;
        if (su?.access_scope === 'own' && su.user_id != null && su.role !== 'master_admin') {
          recordQuery = "SELECT id FROM clinical_records WHERE patient_id = $1 AND status = 'active' AND created_by_user_id = $2 ORDER BY created_at DESC LIMIT 1";
          recordParams = [id, su.user_id];
        } else {
          recordQuery = "SELECT id FROM clinical_records WHERE patient_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1";
          recordParams = [id];
        }
        const record = await pool.query(recordQuery, recordParams);
        return res.status(200).json({ ...patient.rows[0], active_record_id: record.rows[0]?.id || null });
      }

      case 'listRecords': {
        const { patient_id } = req.query;
        const su = await getSessionUserOnce();
        const cid = su?.effective_clinic_id ?? su?.clinic_id;
        if (cid != null && su?.role !== 'master_admin') {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [patient_id]);
          if (chk.rows.length && chk.rows[0].clinic_id !== cid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        // Join creator name so the UI can label each expediente by doctor
        const selectWithCreator = `
          SELECT cr.*,
                 cu.full_name   AS created_by_full_name,
                 cu.username    AS created_by_username,
                 cu.gentilicio  AS created_by_gentilicio
          FROM clinical_records cr
          LEFT JOIN clinic_users cu ON cu.id = cr.created_by_user_id
          WHERE cr.patient_id = $1
        `;
        let records;
        if (su?.access_scope === 'own' && su?.user_id != null && su?.role !== 'master_admin') {
          records = await pool.query(
            selectWithCreator + ' AND cr.created_by_user_id = $2 ORDER BY cr.created_at DESC',
            [patient_id, su.user_id]
          );
        } else {
          records = await pool.query(
            selectWithCreator + ' ORDER BY cr.created_at DESC',
            [patient_id]
          );
        }
        return res.status(200).json(records.rows);
      }

      case 'createRecord': {
        const { patient_id: p_id } = body;
        const su = await getSessionUserOnce();
        const cid = su?.effective_clinic_id ?? su?.clinic_id;
        if (cid != null && su?.role !== 'master_admin') {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [p_id]);
          if (chk.rows.length && chk.rows[0].clinic_id !== cid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        const newRecord = await pool.query(
          'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
          [p_id, cid, su?.user_id || null, 'active']
        );
        return res.status(201).json(newRecord.rows[0]);
      }

      case 'createPatient':
        try {
          const { first_name, last_name, rut, email, phone, birth_date, gender, address, occupation, tipo_sangre, estado_civil } = body;
          
          console.log('📝 Creating patient:', { first_name, last_name, rut, email });

          // Handle empty strings as null for optional fields
          const cleanRut = rut && rut.trim() !== '' ? rut.trim() : null;
          const cleanBirthDate = birth_date && birth_date.trim() !== '' ? birth_date : null;

          // Obtener clinic_id y created_by_user_id desde sesión (post-migración)
          const suCreate = await getSessionUser(pool, req);
          // Para master admin viendo una clínica, usar effective_clinic_id
          const patientClinicId = suCreate?.effective_clinic_id ?? suCreate?.clinic_id ?? null;
          const patientCreatedBy = suCreate?.user_id ?? null;

          // Verificar duplicado dentro de la misma clínica antes de insertar
          if (cleanRut && patientClinicId != null) {
            const dup = await pool.query(
              'SELECT id, first_name, last_name, rut, created_by_user_id FROM patients WHERE rut = $1 AND clinic_id = $2',
              [cleanRut, patientClinicId]
            );
            if (dup.rows.length > 0) {
              const conflictType = dup.rows[0].created_by_user_id === patientCreatedBy ? 'same_user' : 'same_clinic';
              return res.status(409).json({ conflict: conflictType, patient: dup.rows[0] });
            }
          }

          // Usar INSERT con columnas de tenant si están disponibles
          let newPatient;
          if (patientClinicId != null) {
            newPatient = await pool.query(
              `INSERT INTO patients (first_name, last_name, rut, email, phone, birth_date, gender, address, occupation, tipo_sangre, estado_civil, clinic_id, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
              [first_name, last_name, cleanRut, email, phone, cleanBirthDate, gender, address, occupation, tipo_sangre || null, estado_civil || null, patientClinicId, patientCreatedBy]
            );
          } else {
            newPatient = await pool.query(
              `INSERT INTO patients (first_name, last_name, rut, email, phone, birth_date, gender, address, occupation, tipo_sangre, estado_civil)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
              [first_name, last_name, cleanRut, email, phone, cleanBirthDate, gender, address, occupation, tipo_sangre || null, estado_civil || null]
            );
          }
          // Create an initial clinical record for the patient — with user ownership
          await pool.query(
            'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4)',
            [newPatient.rows[0].id, patientClinicId, patientCreatedBy, 'active']
          );
          // Audit
          await logAudit(pool, { patientId: newPatient.rows[0].id, sessionUser: suCreate, actionType: 'create', module: 'patient', summary: `Paciente creado: ${first_name} ${last_name}` });
          return res.status(201).json(newPatient.rows[0]);
        } catch (err) {
          console.error('❌ Error creating patient:', err);
          
          if (err.code === '23505') {
            if (err.detail.includes('rut')) {
              return res.status(400).json({ error: 'El RUT ya está registrado en el sistema.' });
            }
            if (err.detail.includes('email')) {
              return res.status(400).json({ error: 'El correo electrónico ya está registrado.' });
            }
          }
          
          if (err.code === '22007') {
             return res.status(400).json({ error: 'Formato de fecha inválido.' });
          }

          return res.status(500).json({ error: `Error al crear paciente: ${err.message}` });
        }

      case 'updatePatient': {
        const { id: pid, ...updates } = body;
        // Whitelist de campos permitidos (previene SQL injection por nombres de columna)
        const suUpd = await getSessionUser(pool, req);
        const ALLOWED_PATIENT_FIELDS = ['first_name', 'last_name', 'rut', 'email', 'phone', 'birth_date', 'gender', 'address', 'occupation', 'tipo_sangre', 'estado_civil'];
        // master_admin puede reasignar clinic_id (para corregir pacientes huérfanos)
        if (suUpd?.role === 'master_admin') ALLOWED_PATIENT_FIELDS.push('clinic_id');
        const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED_PATIENT_FIELDS.includes(k)));
        if (suUpd?.clinic_id != null) {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [pid]);
          if (chk.rows.length && chk.rows[0].clinic_id != null && chk.rows[0].clinic_id !== suUpd.clinic_id && suUpd.role !== 'master_admin') {
            return res.status(403).json({ error: 'Acceso no autorizado' });
          }
        }
        const fields = Object.keys(safe);
        if (!fields.length) return res.status(400).json({ error: 'Sin campos válidos para actualizar' });
        const values = Object.values(safe);
        const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        const updatedPatient = await pool.query(
          `UPDATE patients SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [pid, ...values]
        );
        return res.status(200).json(updatedPatient.rows[0]);
      }

      // ─── Importar snapshot de paciente (datos básicos + antecedentes) ────
      case 'importPatientSnapshot': {
        const { source_patient_id, import_fields = ['basic', 'history'] } = body;
        if (!source_patient_id) return res.status(400).json({ error: 'source_patient_id requerido' });

        const suImp = await getSessionUser(pool, req);
        if (!suImp) return res.status(401).json({ error: 'No autenticado' });
        const targetClinicId = suImp.effective_clinic_id ?? suImp.clinic_id;
        if (!targetClinicId) return res.status(400).json({ error: 'Sin clínica activa' });

        // Seguridad: source_patient debe pertenecer a la misma clínica
        const srcChk = await pool.query(
          'SELECT * FROM patients WHERE id = $1 AND clinic_id = $2',
          [source_patient_id, targetClinicId]
        );
        if (!srcChk.rows.length) return res.status(403).json({ error: 'Paciente fuente no encontrado en tu clínica' });
        const src = srcChk.rows[0];

        // Idempotente: solo match exacto por user_id (NULL = legacy sin dueño, no cuenta como propio)
        const existingRecord = await pool.query(
          'SELECT * FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $2 AND status = $3 ORDER BY created_at DESC LIMIT 1',
          [src.id, suImp.user_id, 'active']
        );
        if (existingRecord.rows.length > 0) {
          return res.status(200).json({ patient: src, record: existingRecord.rows[0], already_exists: true });
        }

        // Crear expediente propio para este médico — NO se duplica el paciente
        const newRecord = await pool.query(
          'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
          [src.id, targetClinicId, suImp.user_id || null, 'active']
        );
        const newRecordRow = newRecord.rows[0];

        // Registrar acceso del médico al paciente en patient_assignments (para listPatients own-scope)
        await pool.query(
          'INSERT INTO patient_assignments (patient_id, clinic_user_id, assigned_by, assigned_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING',
          [src.id, suImp.user_id, suImp.user_id]
        );

        // Copiar antecedentes si se solicita — desde el expediente más antiguo del paciente, excluyendo el recién creado
        if (import_fields.includes('history')) {
          const srcRec = await pool.query(
            'SELECT id FROM clinical_records WHERE patient_id = $1 AND id != $2 ORDER BY created_at ASC LIMIT 1',
            [source_patient_id, newRecordRow.id]
          );
          if (srcRec.rows.length > 0) {
            const hist = await pool.query(
              'SELECT * FROM medical_history WHERE record_id = $1 ORDER BY updated_at DESC LIMIT 1',
              [srcRec.rows[0].id]
            );
            if (hist.rows.length > 0) {
              const h = hist.rows[0];
              await pool.query(
                `INSERT INTO medical_history
                 (record_id, pathological, non_pathological, family_history, surgical_history,
                  allergies, current_medications, aesthetic_history, gynecological_history)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT DO NOTHING`,
                [newRecordRow.id, h.pathological, h.non_pathological, h.family_history,
                 h.surgical_history, h.allergies, h.current_medications, h.aesthetic_history, h.gynecological_history]
              );
            }
          }
        }

        await logAudit(pool, { patientId: src.id, sessionUser: suImp, actionType: 'create', module: 'patient', summary: `Nuevo expediente creado para paciente existente ID ${source_patient_id}: ${src.first_name} ${src.last_name}` });
        return res.status(201).json({ patient: src, record: newRecordRow });
      }

      case 'deletePatient': {
        const { id: delPid } = req.query;
        // Clinic scope check
        const suDel = await getSessionUser(pool, req);
        if (suDel?.clinic_id != null) {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [delPid]);
          if (chk.rows.length && chk.rows[0].clinic_id != null && chk.rows[0].clinic_id !== suDel.clinic_id && suDel.role !== 'master_admin') {
            return res.status(403).json({ error: 'Acceso no autorizado' });
          }
        }
        try {
          await pool.query('DELETE FROM patients WHERE id = $1', [delPid]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting patient:', err);
          return res.status(500).json({ error: 'Error al eliminar paciente. Puede tener registros asociados.' });
        }
      }

      // ─── Listar usuarios de la clínica actual (para UI de asignación) ────
      case 'listClinicUsers': {
        const suLU = await getSessionUser(pool, req);
        if (!suLU) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suLU.role)) return res.status(403).json({ error: 'Sin permisos' });
        const clinicId = suLU.effective_clinic_id ?? suLU.clinic_id;
        if (clinicId == null) return res.status(400).json({ error: 'Sin clínica activa' });
        const usersRes = await pool.query(
          `SELECT id, username, full_name, role, access_scope
           FROM clinic_users WHERE clinic_id = $1 AND is_active = true ORDER BY full_name`,
          [clinicId]
        );
        return res.status(200).json(usersRes.rows);
      }

      // ─── Grupos de compartición (inventario + finanzas) ───────────────────
      case 'listSharingGroups': {
        const suSG = await getSessionUser(pool, req);
        if (!suSG) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suSG.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suSG.effective_clinic_id ?? suSG.clinic_id;
        if (!sgClinic) return res.status(400).json({ error: 'Sin clínica activa' });
        const groups = await pool.query(
          `SELECT sg.id, sg.name, sg.description,
             COALESCE(json_agg(json_build_object('id', cu.id, 'username', cu.username, 'full_name', cu.full_name)
               ORDER BY cu.full_name) FILTER (WHERE cu.id IS NOT NULL), '[]') AS members
           FROM sharing_groups sg
           LEFT JOIN sharing_group_members sgm ON sgm.group_id = sg.id
           LEFT JOIN clinic_users cu ON cu.id = sgm.clinic_user_id
           WHERE sg.clinic_id = $1
           GROUP BY sg.id ORDER BY sg.name`,
          [sgClinic]
        );
        return res.status(200).json(groups.rows);
      }

      case 'manageSharingGroup': {
        // mode: 'create' | 'update' | 'delete'
        const suMSG = await getSessionUser(pool, req);
        if (!suMSG) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suMSG.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suMSG.effective_clinic_id ?? suMSG.clinic_id;
        const { mode, group_id, name, description } = body;
        if (mode === 'create') {
          if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
          const r = await pool.query(
            'INSERT INTO sharing_groups (clinic_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description',
            [sgClinic, name.trim(), description?.trim() || null]
          );
          return res.status(201).json(r.rows[0]);
        }
        if (mode === 'update') {
          await pool.query('UPDATE sharing_groups SET name=$1, description=$2 WHERE id=$3 AND clinic_id=$4', [name?.trim(), description?.trim() || null, group_id, sgClinic]);
          return res.status(200).json({ success: true });
        }
        if (mode === 'delete') {
          await pool.query('DELETE FROM sharing_groups WHERE id=$1 AND clinic_id=$2', [group_id, sgClinic]);
          return res.status(200).json({ success: true });
        }
        return res.status(400).json({ error: 'mode inválido' });
      }

      case 'manageSharingMember': {
        // mode: 'add' | 'remove'
        const suMSM = await getSessionUser(pool, req);
        if (!suMSM) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suMSM.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suMSM.effective_clinic_id ?? suMSM.clinic_id;
        const { mode: mMode, group_id: gId, clinic_user_id: mUid } = body;
        // Verificar que el grupo pertenece a la clínica
        const gChk = await pool.query('SELECT id FROM sharing_groups WHERE id=$1 AND clinic_id=$2', [gId, sgClinic]);
        if (!gChk.rows.length) return res.status(403).json({ error: 'Grupo no encontrado en esta clínica' });
        if (mMode === 'add') {
          await pool.query('INSERT INTO sharing_group_members (group_id, clinic_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gId, mUid]);
        } else if (mMode === 'remove') {
          await pool.query('DELETE FROM sharing_group_members WHERE group_id=$1 AND clinic_user_id=$2', [gId, mUid]);
        }
        return res.status(200).json({ success: true });
      }

      // ─── Asignar/copiar paciente a otro usuario de la clínica ─────────────
      case 'assignPatient': {
        const suAsgn = await getSessionUser(pool, req);
        if (!suAsgn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suAsgn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: asgnPid, target_user_id } = body;
        if (!asgnPid || !target_user_id) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        // Verificar que el paciente pertenece a la clínica del admin
        const clinicIdAsgn = suAsgn.effective_clinic_id ?? suAsgn.clinic_id;
        const patChk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [asgnPid]);
        if (!patChk.rows.length || patChk.rows[0].clinic_id !== clinicIdAsgn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        // Verificar que el usuario destino pertenece a la misma clínica
        const userChk = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true', [target_user_id, clinicIdAsgn]);
        if (!userChk.rows.length) return res.status(404).json({ error: 'Usuario destino no encontrado en esta clínica' });
        await pool.query(
          `INSERT INTO patient_assignments (patient_id, clinic_user_id, assigned_by)
           VALUES ($1, $2, $3) ON CONFLICT (patient_id, clinic_user_id) DO NOTHING`,
          [asgnPid, target_user_id, suAsgn.user_id]
        );
        await logAudit(pool, { patientId: asgnPid, sessionUser: suAsgn, actionType: 'assign', module: 'patient', summary: `Paciente asignado al usuario ID ${target_user_id}` });
        return res.status(200).json({ success: true });
      }

      // ─── Remover asignación de un paciente a un usuario ──────────────────
      case 'unassignPatient': {
        const suUnasgn = await getSessionUser(pool, req);
        if (!suUnasgn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suUnasgn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: unasgnPid, target_user_id: unasgnUid } = body;
        if (!unasgnPid || !unasgnUid) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        const clinicIdUnasgn = suUnasgn.effective_clinic_id ?? suUnasgn.clinic_id;
        const patChkU = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [unasgnPid]);
        if (!patChkU.rows.length || patChkU.rows[0].clinic_id !== clinicIdUnasgn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        await pool.query('DELETE FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2', [unasgnPid, unasgnUid]);
        await logAudit(pool, { patientId: unasgnPid, sessionUser: suUnasgn, actionType: 'unassign', module: 'patient', summary: `Asignación removida del usuario ID ${unasgnUid}` });
        return res.status(200).json({ success: true });
      }

      // ─── Trasladar paciente: cambia el propietario (created_by_user_id) ──
      case 'transferPatient': {
        const suTrn = await getSessionUser(pool, req);
        if (!suTrn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suTrn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: trnPid, target_user_id: trnUid } = body;
        if (!trnPid || !trnUid) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        const clinicIdTrn = suTrn.effective_clinic_id ?? suTrn.clinic_id;
        const patChkT = await pool.query('SELECT clinic_id, created_by_user_id FROM patients WHERE id = $1', [trnPid]);
        if (!patChkT.rows.length || patChkT.rows[0].clinic_id !== clinicIdTrn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        const userChkT = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true', [trnUid, clinicIdTrn]);
        if (!userChkT.rows.length) return res.status(404).json({ error: 'Usuario destino no encontrado en esta clínica' });
        const prevOwner = patChkT.rows[0].created_by_user_id;
        await pool.query('UPDATE patients SET created_by_user_id = $1, updated_at = NOW() WHERE id = $2', [trnUid, trnPid]);
        // Eliminar asignación previa del nuevo propietario si existía (evita duplicado lógico)
        await pool.query('DELETE FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2', [trnPid, trnUid]);
        await logAudit(pool, { patientId: trnPid, sessionUser: suTrn, actionType: 'transfer', module: 'patient', summary: `Paciente trasladado de usuario ID ${prevOwner} a ID ${trnUid}` });
        return res.status(200).json({ success: true });
      }

      case 'deleteRecord': {
        const { id: delRecordId } = req.query;
        // Tenant check: verify record belongs to user's clinic (C-3 fix)
        const suDR = await getSessionUserOnce();
        const drCid = suDR?.effective_clinic_id ?? suDR?.clinic_id;
        if (drCid != null && suDR?.role !== 'master_admin') {
          const chk = await pool.query(
            'SELECT p.clinic_id FROM patients p JOIN clinical_records cr ON cr.patient_id = p.id WHERE cr.id = $1',
            [delRecordId]
          );
          if (chk.rows.length && chk.rows[0].clinic_id !== drCid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        try {
          await pool.query('DELETE FROM clinical_records WHERE id = $1', [delRecordId]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting record:', err);
          return res.status(500).json({ error: 'Error al eliminar expediente.' });
        }
      }

      case 'getRecordData': {
        const { recordId, patientId } = req.query;
        let targetRecordId = recordId;

        // If no recordId provided, try to find one for the patient
        if ((!targetRecordId || targetRecordId === 'undefined' || targetRecordId === 'null') && patientId) {
           // Find record filtered by user scope
           const isOwnScope = su?.access_scope === 'own' && su?.user_id != null && su?.role !== 'master_admin';
           let r;
           if (isOwnScope) {
             r = await pool.query(
               "SELECT id FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
               [patientId, su.user_id]
             );
             if (r.rows.length === 0) {
               r = await pool.query(
                 'SELECT id FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $2 ORDER BY created_at DESC LIMIT 1',
                 [patientId, su.user_id]
               );
             }
           } else {
             r = await pool.query("SELECT id FROM clinical_records WHERE patient_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [patientId]);
             if (r.rows.length === 0) {
               r = await pool.query('SELECT id FROM clinical_records WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1', [patientId]);
             }
           }
           
           // If still no record, create one with user ownership
           if (r.rows.length === 0) {
             const newRec = await pool.query(
               'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
               [patientId, effectiveClinicId, su?.user_id || null, 'active']
             );
             targetRecordId = newRec.rows[0].id;
           } else {
             targetRecordId = r.rows[0].id;
           }
        }

        if (!targetRecordId || targetRecordId === 'undefined' || targetRecordId === 'null') {
          return res.status(404).json({ error: 'Record not found' });
        }

        const recordDetails = await pool.query('SELECT * FROM clinical_records WHERE id = $1', [targetRecordId]);
        
        if (recordDetails.rows.length === 0) {
           return res.status(404).json({ error: 'Record ID not found in database' });
        }

        const patientIdFromRecord = recordDetails.rows[0]?.patient_id;

        // Tenant check: verify the record's patient belongs to the authenticated user's clinic (C-1 fix)
        const suGrd = await getSessionUserOnce();
        const grdCid = suGrd?.effective_clinic_id ?? suGrd?.clinic_id;
        if (grdCid != null && suGrd?.role !== 'master_admin') {
          const pChk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [patientIdFromRecord]);
          if (pChk.rows.length && pChk.rows[0].clinic_id !== grdCid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        // own-scope: verify this record belongs to the current user
        if (suGrd?.access_scope === 'own' && suGrd?.user_id != null && suGrd?.role !== 'master_admin') {
          if (recordDetails.rows[0].created_by_user_id !== null &&
              recordDetails.rows[0].created_by_user_id !== suGrd.user_id) {
            return res.status(403).json({ error: 'No tienes permiso para acceder a este expediente' });
          }
        }

        // Helper to safely query tables that might not exist yet
        const safeQuery = async (query, params) => {
          try {
            return await pool.query(query, params);
          } catch (err) {
            if (err.code === '42P01') { // undefined_table
              return { rows: [] };
            }
            if (err.code === '42703') { // undefined_column
              console.warn(`⚠️ Column missing in query: ${query}`, err.message);
              return { rows: [] };
            }
            throw err;
          }
        };

        const [
          history, 
          physical, 
          diagnoses, 
          treatments, 
          prescriptions, 
          consents, 
          injectables,
          consultation,
          consultationHistory
        ] = await Promise.all([
          safeQuery('SELECT * FROM medical_history WHERE record_id = $1', [targetRecordId]),
          safeQuery('SELECT * FROM physical_exams WHERE record_id = $1 ORDER BY created_at DESC', [targetRecordId]),
          safeQuery('SELECT * FROM diagnoses WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM treatments WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM prescriptions WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM consent_forms WHERE record_id = $1 ORDER BY id DESC', [targetRecordId]),
          safeQuery('SELECT * FROM injectables WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM consultation_info WHERE record_id = $1', [targetRecordId]),
          safeQuery('SELECT * FROM consultations WHERE record_id = $1 ORDER BY created_at DESC', [targetRecordId])
        ]);

        return res.status(200).json({
          recordId: targetRecordId,
          patientId: patientIdFromRecord,
          history: history.rows[0] || {},
          physicalExams: physical.rows,
          diagnoses: diagnoses.rows,
          treatments: treatments.rows,
          prescriptions: prescriptions.rows,
          consentForms: consents.rows,
          injectables: injectables.rows,
          consultation: consultation.rows[0] || {},
          consultations: consultationHistory.rows || []
        });
      }

      case 'deleteConsultationHistory': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'ID required' });
        await pool.query('DELETE FROM consultation_history WHERE id = $1', [id]);
        return res.status(200).json({ success: true });
      }

      // ── Consultas (hub de sesión) ────────────────────────────────────────

      case 'listConsultations': {
        const { record_id: lcRid } = req.query;
        if (!lcRid) return res.status(400).json({ error: 'record_id required' });
        const lcRes = await pool.query(
          'SELECT * FROM consultations WHERE record_id = $1 ORDER BY created_at DESC',
          [lcRid]
        );
        return res.status(200).json(lcRes.rows);
      }

      case 'createConsultation': {
        const { record_id: ccRid, reason: ccReason, current_illness: ccIllness,
                enable_injectables: ccInj = false, enable_consents: ccCons = false } = body;
        if (!ccRid) return res.status(400).json({ error: 'record_id required' });
        const newCons = await pool.query(
          `INSERT INTO consultations (record_id, clinic_id, reason, current_illness, enable_injectables, enable_consents)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [ccRid, effectiveClinicId, ccReason, ccIllness, ccInj, ccCons]
        );
        await logAudit(pool, { recordId: ccRid, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'consultation', summary: `Nueva consulta: ${ccReason || ''}` });
        return res.status(201).json(newCons.rows[0]);
      }

      case 'updateConsultation': {
        const { id: ucId, ...ucFields } = body;
        if (!ucId) return res.status(400).json({ error: 'id required' });
        const allowed = ['reason', 'current_illness', 'enable_injectables', 'enable_consents'];
        const safe = Object.fromEntries(Object.entries(ucFields).filter(([k]) => allowed.includes(k)));
        if (!Object.keys(safe).length) return res.status(400).json({ error: 'No valid fields' });
        const setClause = Object.keys(safe).map((f, i) => `${f} = $${i + 2}`).join(', ');
        const ucRow = await pool.query(
          `UPDATE consultations SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [ucId, ...Object.values(safe)]
        );
        return res.status(200).json(ucRow.rows[0] || { success: true });
      }

      case 'deleteConsultation': {
        const { id: dcId } = req.query;
        if (!dcId) return res.status(400).json({ error: 'id required' });
        // Cascade: delete all records linked to this consultation before removing it
        await Promise.all([
          pool.query('DELETE FROM physical_exams   WHERE consultation_id = $1', [dcId]),
          pool.query('DELETE FROM diagnoses         WHERE consultation_id = $1', [dcId]),
          pool.query('DELETE FROM treatments        WHERE consultation_id = $1', [dcId]),
          pool.query('DELETE FROM prescriptions     WHERE consultation_id = $1', [dcId]),
          pool.query('DELETE FROM consent_forms     WHERE consultation_id = $1', [dcId]),
          pool.query('DELETE FROM injectables       WHERE consultation_id = $1', [dcId]),
        ]);
        await pool.query('DELETE FROM consultations WHERE id = $1', [dcId]);
        return res.status(200).json({ success: true });
      }

      case 'listHistorySnapshots': {
        const { record_id: lhsRid } = req.query;
        if (!lhsRid) return res.status(400).json({ error: 'record_id required' });
        const snaps = await pool.query(
          'SELECT id, changed_by, created_at, snapshot_data FROM medical_history_snapshots WHERE record_id = $1 ORDER BY created_at DESC',
          [lhsRid]
        );
        return res.status(200).json(snaps.rows);
      }

      case 'saveConsultation': {
        const { recordId, reason, current_illness } = body;
        
        if (!recordId) return res.status(400).json({ error: 'Record ID required' });

        // Check if exists
        const existing = await pool.query('SELECT id FROM consultation_info WHERE record_id = $1', [recordId]);

        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE consultation_info SET reason = $1, current_illness = $2, updated_at = NOW() WHERE record_id = $3',
            [reason, current_illness, recordId]
          );
        } else {
          await pool.query(
            'INSERT INTO consultation_info (record_id, clinic_id, reason, current_illness) VALUES ($1, $2, $3, $4)',
            [recordId, effectiveClinicId, reason, current_illness]
          );
        }
        
        // Save to history
        if ((reason && reason.trim()) || (current_illness && current_illness.trim())) {
          try {
            await pool.query(
              'INSERT INTO consultation_history (record_id, clinic_id, reason, current_illness) VALUES ($1, $2, $3, $4)',
              [recordId, effectiveClinicId, reason, current_illness]
            );
          } catch (histErr) {
            console.error('Error saving consultation history:', histErr);
          }
        }
        await logAudit(pool, { recordId, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'consultation', summary: 'Guardó Motivo de Consulta' });
        return res.status(200).json({ success: true });
      }

      case 'saveHistory': {
        const { record_id: hid, ...historyData } = body;
        delete historyData.id;
        delete historyData.created_at;
        delete historyData.updated_at;
        // Whitelist: solo identificadores SQL válidos (\w+) — previene SQL injection por nombres de columna
        const safeHistData = Object.fromEntries(Object.entries(historyData).filter(([k]) => /^\w+$/.test(k)));

        const existingHistory = await pool.query('SELECT id FROM medical_history WHERE record_id = $1', [hid]);
        if (existingHistory.rows.length > 0) {
           const hFields = Object.keys(safeHistData);
           const hValues = Object.values(safeHistData);
           if (hFields.length > 0) {
             const hSet = hFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE medical_history SET ${hSet}, updated_at = NOW() WHERE record_id = $1`, [hid, ...hValues]);
           }
        } else {
           const safeHistNoClinic = Object.fromEntries(Object.entries(safeHistData).filter(([k]) => k !== 'clinic_id'));
           const hFields = ['record_id', 'clinic_id', ...Object.keys(safeHistNoClinic)];
           const hValues = [hid, effectiveClinicId, ...Object.values(safeHistNoClinic)];
           const hParams = hFields.map((_, i) => `$${i + 1}`).join(', ');
           await pool.query(`INSERT INTO medical_history (${hFields.join(', ')}) VALUES (${hParams})`, hValues);
        }
        await logAudit(pool, { recordId: hid, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'history', summary: 'Guardó Antecedentes Médicos' });
        // Save full snapshot for version history
        try {
          const snapUser = (await getSessionUserOnce())?.username || 'unknown';
          await pool.query(
            'INSERT INTO medical_history_snapshots (record_id, clinic_id, snapshot_data, changed_by) VALUES ($1, $2, $3, $4)',
            [hid, effectiveClinicId, JSON.stringify(safeHistData), snapUser]
          );
        } catch (snapErr) { console.warn('Snapshot save warning:', snapErr.message); }
        return res.status(200).json({ success: true });
      }

      case 'savePhysicalExam': {
        const { id: examId, record_id: pid_exam, created_at, ...examData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        // clinic_id se excluye: lo fija el servidor via effectiveClinicId, nunca el cliente
        const safeExamData = Object.fromEntries(Object.entries(examData).filter(([k]) => /^\w+$/.test(k) && k !== 'clinic_id'));
        
        if (examId) {
           const eFields = Object.keys(safeExamData);
           const eValues = Object.values(safeExamData);
           if (eFields.length > 0) {
             const eSet = eFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE physical_exams SET ${eSet} WHERE id = $1`, [examId, ...eValues]);
           }
           return res.status(200).json({ success: true, id: examId });
        } else {
           if (!pid_exam) return res.status(400).json({ error: 'Falta el ID del expediente (record_id)' });
           const eFields = ['record_id', 'clinic_id', ...Object.keys(safeExamData)];
           const eValues = [pid_exam, effectiveClinicId, ...Object.values(safeExamData)];
           const eParams = eFields.map((_, i) => `$${i + 1}`).join(', ');
           const newExam = await pool.query(`INSERT INTO physical_exams (${eFields.join(', ')}) VALUES (${eParams}) RETURNING id`, eValues);
           return res.status(200).json({ success: true, id: newExam.rows[0].id });
        }
      }

      case 'deletePhysicalExam': {
        const { id: delExamId } = req.query;
        if (!(await ownedByClinic(pool, 'physical_exams', delExamId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM physical_exams WHERE id = $1', [delExamId]);
        return res.status(200).json({ success: true });
      }

      case 'saveDiagnosis': {
        const { id: diagId, record_id: did, date: diagDate, ...diagData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        // clinic_id se excluye: lo fija el servidor via effectiveClinicId, nunca el cliente
        const safeDiagData = Object.fromEntries(Object.entries(diagData).filter(([k]) => /^\w+$/.test(k) && k !== 'clinic_id'));
        if (diagId) {
           const dFields = Object.keys(safeDiagData);
           const dValues = Object.values(safeDiagData);
           if (dFields.length > 0) {
             const dSet = dFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE diagnoses SET ${dSet} WHERE id = $1`, [diagId, ...dValues]);
           }
           return res.status(200).json({ success: true });
        } else {
           const dFields = ['record_id', 'clinic_id', ...Object.keys(safeDiagData)];
           const dValues = [did, effectiveClinicId, ...Object.values(safeDiagData)];
           const dParams = dFields.map((_, i) => `$${i + 1}`).join(', ');
           const newDiag = await pool.query(`INSERT INTO diagnoses (${dFields.join(', ')}) VALUES (${dParams}) RETURNING *`, dValues);
           await logAudit(pool, { recordId: did, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'diagnosis', summary: 'Registró Diagnóstico' });
           return res.status(201).json(newDiag.rows[0]);
        }
      }

      case 'deleteDiagnosis': {
        const { id: delDiagId } = req.query;
        if (!(await ownedByClinic(pool, 'diagnoses', delDiagId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM diagnoses WHERE id = $1', [delDiagId]);
        return res.status(200).json({ success: true });
      }

      case 'addTreatment': {
        const { record_id: tid, ...treatData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        // clinic_id/id se excluyen: un tratamiento duplicado en el cliente puede traer el clinic_id de la fila original
        const safeTreatData = Object.fromEntries(Object.entries(treatData).filter(([k]) => /^\w+$/.test(k) && k !== 'clinic_id' && k !== 'id'));
        if (safeTreatData.parameters && typeof safeTreatData.parameters === 'object') {
          safeTreatData.parameters = JSON.stringify(safeTreatData.parameters);
        }
        const tFields = ['record_id', 'clinic_id', ...Object.keys(safeTreatData)];
        const tValues = [tid, effectiveClinicId, ...Object.values(safeTreatData)];
        const tParams = tFields.map((_, i) => `$${i + 1}`).join(', ');
        const newTreat = await pool.query(`INSERT INTO treatments (${tFields.join(', ')}) VALUES (${tParams}) RETURNING *`, tValues);
        await logAudit(pool, { recordId: tid, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'treatment', summary: `Agregó tratamiento: ${safeTreatData.name || safeTreatData.procedure_name || ''}` });
        return res.status(201).json(newTreat.rows[0]);
      }

      case 'updateTreatment': {
        const { id: upTreatId, ...upTreatData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        // clinic_id se excluye: no debe ser modificable por el cliente (aislamiento de tenant)
        const safeUpTreat = Object.fromEntries(Object.entries(upTreatData).filter(([k]) => /^\w+$/.test(k) && k !== 'clinic_id'));
        if (safeUpTreat.parameters && typeof safeUpTreat.parameters === 'object') {
          safeUpTreat.parameters = JSON.stringify(safeUpTreat.parameters);
        }
        const upTFields = Object.keys(safeUpTreat);
        const upTValues = Object.values(safeUpTreat);
        if (upTFields.length > 0) {
          const upTSet = upTFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
          await pool.query(`UPDATE treatments SET ${upTSet} WHERE id = $1`, [upTreatId, ...upTValues]);
        }
        return res.status(200).json({ success: true });
      }

      case 'updateSchema':
        try {
          await pool.query('ALTER TABLE treatments ADD COLUMN IF NOT EXISTS ai_suggestion TEXT');
          return res.status(200).json({ message: 'Schema updated successfully' });
        } catch (err) {
          console.error('Schema update error:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'deleteTreatment': {
        const { id: delTreatId } = req.query;
        if (!(await ownedByClinic(pool, 'treatments', delTreatId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM treatments WHERE id = $1', [delTreatId]);
        return res.status(200).json({ success: true });
      }

      // --- INYECTABLES ---

      case 'getInjectablesByRecord': {
        const { record_id: injRecordId } = req.query;
        if (!injRecordId) return res.status(400).json({ error: 'record_id required' });
        const injByRecord = await pool.query(
          'SELECT * FROM injectables WHERE record_id = $1 ORDER BY date DESC',
          [injRecordId]
        );
        return res.status(200).json(injByRecord.rows);
      }

      case 'getInjectablesByTreatment': {
        const { treatment_id: injTreatId } = req.query;
        if (!injTreatId) return res.status(400).json({ error: 'treatment_id required' });
        const injList = await pool.query(
          'SELECT * FROM injectables WHERE treatment_id = $1 ORDER BY date DESC',
          [injTreatId]
        );
        return res.status(200).json(injList.rows);
      }

      case 'addInjectable': {
        const { record_id: injRecId, treatment_id: injTid, ...injData } = body;
        if (!injRecId) return res.status(400).json({ error: 'record_id required' });

        // Sanitize fields
        const allowedFields = [
          'date', 'product_type', 'product_name', 'brand', 'lot_number',
          'expiration_date', 'volume_used', 'units_used', 'areas_treated',
          'technique', 'injection_plane', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date', 'relleno_subtype', 'consultation_id'
        ];
        const dateFields = ['date', 'expiration_date', 'follow_up_date'];
        const numericFields = ['volume_used', 'units_used', 'dilution_volume'];
        const cleanData = {};
        for (const key of allowedFields) {
          if (injData[key] !== undefined) {
            let val = injData[key];
            // Convert empty strings to null for date and numeric fields
            if (typeof val === 'string' && val.trim() === '' && (dateFields.includes(key) || numericFields.includes(key))) {
              val = null;
            }
            if (['areas_treated', 'mapping_data'].includes(key) && typeof val === 'object') {
              val = JSON.stringify(val);
            }
            // Skip null/empty optional fields to avoid type errors
            if (val === null && key !== 'date') continue;
            cleanData[key] = val;
          }
        }

        const fields = ['record_id', 'clinic_id', ...Object.keys(cleanData)];
        const values = [injRecId, effectiveClinicId, ...Object.values(cleanData)];

        // Include treatment_id only if provided (column may not exist in older schemas)
        if (injTid) {
          fields.push('treatment_id');
          values.push(injTid);
        }

        const params = fields.map((_, i) => `$${i + 1}`).join(', ');
        const newInj = await pool.query(
          `INSERT INTO injectables (${fields.join(', ')}) VALUES (${params}) RETURNING *`,
          values
        );
        await logAudit(pool, { recordId: injRecId, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'injectable', summary: `Registró inyectable: ${cleanData.product_name || ''} (${cleanData.product_type || ''})` });
        return res.status(201).json(newInj.rows[0]);
      }

      case 'updateInjectable': {
        const { id: updInjId, ...updInjData } = body;
        if (!updInjId) return res.status(400).json({ error: 'id required' });

        const allowedFields = [
          'date', 'product_type', 'product_name', 'brand', 'lot_number',
          'expiration_date', 'volume_used', 'units_used', 'areas_treated',
          'technique', 'injection_plane', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date', 'relleno_subtype', 'consultation_id'
        ];
        const cleanData = {};
        const dateFields = ['date', 'expiration_date', 'follow_up_date'];
        for (const key of allowedFields) {
          if (updInjData[key] !== undefined) {
            let val = updInjData[key];
            // Convertir string vacío a null en campos de tipo date
            if (dateFields.includes(key) && (val === '' || val === null)) {
              val = null;
            } else if (['areas_treated', 'mapping_data'].includes(key) && typeof val === 'object') {
              val = JSON.stringify(val);
            }
            cleanData[key] = val;
          }
        }

        const uFields = Object.keys(cleanData);
        const uValues = Object.values(cleanData);
        if (uFields.length === 0) return res.status(400).json({ error: 'No fields to update' });

        const uSet = uFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        await pool.query(`UPDATE injectables SET ${uSet} WHERE id = $1`, [updInjId, ...uValues]);
        return res.status(200).json({ success: true });
      }

      case 'deleteInjectable': {
        const { id: delInjId } = req.query;
        if (!delInjId) return res.status(400).json({ error: 'id required' });
        if (!(await ownedByClinic(pool, 'injectables', delInjId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM injectables WHERE id = $1', [delInjId]);
        return res.status(200).json({ success: true });
      }

      // ── Catálogo global de inyectables (seeds gestionados por master admin) ──

      case 'listInjectableCatalog': {
        const cat = await pool.query(
          'SELECT id, categoria, elemento, descripcion FROM injectable_catalog WHERE activo = 1 ORDER BY categoria, elemento'
        );
        return res.status(200).json(cat.rows);
      }

      case 'saveInjectableSeed': {
        const sess = await getSessionUserOnce();
        if (!sess || sess.role !== 'master_admin') return res.status(403).json({ error: 'Forbidden' });
        const { id: seedId, categoria: seedCat, elemento: seedEl, descripcion: seedDesc } = body;
        if (!seedCat || !seedEl) return res.status(400).json({ error: 'categoria y elemento requeridos' });
        if (seedId) {
          await pool.query(
            'UPDATE injectable_catalog SET categoria=$2, elemento=$3, descripcion=$4 WHERE id=$1',
            [seedId, seedCat.trim(), seedEl.trim(), seedDesc || null]
          );
          return res.status(200).json({ success: true });
        }
        const newSeed = await pool.query(
          'INSERT INTO injectable_catalog(categoria, elemento, descripcion) VALUES($1,$2,$3) RETURNING id',
          [seedCat.trim(), seedEl.trim(), seedDesc || null]
        );
        return res.status(201).json(newSeed.rows[0]);
      }

      case 'deleteInjectableSeed': {
        const sess = await getSessionUserOnce();
        if (!sess || sess.role !== 'master_admin') return res.status(403).json({ error: 'Forbidden' });
        const { id: delSeedId } = req.query;
        if (!delSeedId) return res.status(400).json({ error: 'id required' });
        await pool.query('UPDATE injectable_catalog SET activo=0 WHERE id=$1', [delSeedId]);
        return res.status(200).json({ success: true });
      }

      case 'listPrescriptions':
        const { record_id: presc_record_id } = req.query;
        const prescriptionsList = await pool.query('SELECT * FROM prescriptions WHERE record_id = $1 ORDER BY date DESC, id DESC', [presc_record_id]);
        const mappedPrescriptions = prescriptionsList.rows.map(p => ({
          ...p,
          fecha: p.date,
          diagnostico: p.diagnosis,
          mode: p.prescription_mode || 'routine',
          validity_type: p.validity_type || null,
          valid_until: p.valid_until || null,
          regulatory_snapshot: p.regulatory_snapshot || {},
        }));
        return res.status(200).json(mappedPrescriptions);

      case 'getPrescription':
        const { id: getPrescId } = req.query;
        const presc = await pool.query('SELECT * FROM prescriptions WHERE id = $1', [getPrescId]);
        if (presc.rows.length === 0) return res.status(404).json({ error: 'Prescription not found' });
        const pData = presc.rows[0];
        return res.status(200).json({
          ...pData,
          fecha: pData.date,
          diagnostico: pData.diagnosis,
          items: pData.items || [],
          mode: pData.prescription_mode || 'routine',
          validity_type: pData.validity_type || null,
          valid_until: pData.valid_until || null,
          regulatory_snapshot: pData.regulatory_snapshot || {},
        });

      case 'createPrescription': {
        const { ficha_id, fecha, diagnostico, items, consultation_id: prescConsId,
                mode = 'routine', validity_type = null, valid_until = null,
                regulatory_snapshot = {} } = body;
        const safeMode = mode === 'prescription' ? 'prescription' : 'routine';
        const prescFields = ['record_id', 'clinic_id', 'date', 'diagnosis', 'items', 'prescription_mode', 'validity_type', 'valid_until', 'regulatory_snapshot'];
        const prescValues = [ficha_id, effectiveClinicId, fecha, diagnostico, JSON.stringify(items), safeMode, validity_type, valid_until, JSON.stringify(regulatory_snapshot || {})];
        if (prescConsId) { prescFields.push('consultation_id'); prescValues.push(prescConsId); }
        const prescParams = prescFields.map((_, i) => `$${i + 1}`).join(', ');
        const newPresc = await pool.query(
          `INSERT INTO prescriptions (${prescFields.join(', ')}) VALUES (${prescParams}) RETURNING id`,
          prescValues
        );
        await logAudit(pool, { recordId: ficha_id, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'prescription', summary: `Creó receta médica` });
        return res.status(200).json({ id: newPresc.rows[0].id, message: 'Receta created' });
      }

      case 'updatePrescription':
        const { id: updPrescId, fecha: updFecha, diagnostico: updDiag, items: updItems,
                mode: updMode = 'routine', validity_type: updValidityType = null,
                valid_until: updValidUntil = null, regulatory_snapshot: updSnapshot = {} } = body;
        await pool.query(
          'UPDATE prescriptions SET date = $1, diagnosis = $2, items = $3, prescription_mode = $4, validity_type = $5, valid_until = $6, regulatory_snapshot = $7 WHERE id = $8',
          [updFecha, updDiag, JSON.stringify(updItems), updMode === 'prescription' ? 'prescription' : 'routine', updValidityType, updValidUntil, JSON.stringify(updSnapshot || {}), updPrescId]
        );
        return res.status(200).json({ message: 'Receta updated' });

      case 'deletePrescription':
        const { id: delPrescId } = req.query;
        await pool.query('DELETE FROM prescriptions WHERE id = $1', [delPrescId]);
        return res.status(200).json({ message: 'Receta deleted' });

      case 'getTemplates':
        const templates = await pool.query('SELECT * FROM prescription_templates ORDER BY name ASC');
        const mappedTemplates = templates.rows.map(t => ({
          ...t,
          nombre: t.name
        }));
        return res.status(200).json(mappedTemplates);

      case 'saveTemplate':
        const { nombre, items: tItems } = body;
        const newTempl = await pool.query(
          'INSERT INTO prescription_templates (name, items_json) VALUES ($1, $2) RETURNING id',
          [nombre, JSON.stringify(tItems)]
        );
        return res.status(200).json({ id: newTempl.rows[0].id, message: 'Template saved' });

      case 'deleteTemplate':
        const { id: delTemplId } = req.query;
        await pool.query('DELETE FROM prescription_templates WHERE id = $1', [delTemplId]);
        return res.status(200).json({ message: 'Template deleted' });

      // --- CONSENTIMIENTOS ---

      case 'migrateConsents':
        // Add signing columns if they don't exist
        try {
          await pool.query(`
            ALTER TABLE consent_forms 
            ADD COLUMN IF NOT EXISTS signing_token VARCHAR(100),
            ADD COLUMN IF NOT EXISTS signing_status VARCHAR(20) DEFAULT 'pending';
            CREATE INDEX IF NOT EXISTS idx_consent_forms_signing_token ON consent_forms(signing_token);
          `);
          return res.status(200).json({ message: 'Consent forms table migrated' });
        } catch (err) {
          console.error('Migration error:', err);
          return res.status(500).json({ error: 'Migration failed', details: err.message });
        }

      case 'initConsents':
        // WARNING: This drops the table! Use with caution.
        await pool.query(`
          DROP TABLE IF EXISTS consent_forms;
          CREATE TABLE consent_forms (
              id SERIAL PRIMARY KEY,
              record_id INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
              patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
              status VARCHAR(20) DEFAULT 'draft',
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW(),
              created_by VARCHAR(100),
              procedure_type VARCHAR(150),
              zone VARCHAR(150),
              sessions INTEGER,
              objectives JSONB,
              description TEXT,
              risks JSONB,
              benefits JSONB,
              alternatives JSONB,
              pre_care JSONB,
              post_care JSONB,
              contraindications JSONB,
              critical_antecedents JSONB,
              authorizations JSONB,
              declarations JSONB,
              signatures JSONB,
              attachments JSONB,
              signing_token VARCHAR(100),
              signing_status VARCHAR(20) DEFAULT 'pending'
          );
          CREATE INDEX idx_consent_forms_record_id ON consent_forms(record_id);
          CREATE INDEX idx_consent_forms_patient_id ON consent_forms(patient_id);
          CREATE INDEX idx_consent_forms_signing_token ON consent_forms(signing_token);
        `);
        return res.status(200).json({ message: 'Consent forms table initialized' });

      case 'initProfessionalSignatures':
        // La tabla se crea en initClinicalDatabase() — solo confirmar existencia
        return res.status(200).json({ message: 'Professional signatures table initialized' });

      case 'saveProfessionalSignature': {
        const { name, signature, cedula } = body;
        const existing = await pool.query('SELECT id FROM professional_signatures WHERE professional_name = $1', [name]);
        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE professional_signatures SET signature_data = $1, cedula = $2, updated_at = NOW() WHERE professional_name = $3',
            [signature, cedula || null, name]
          );
        } else {
          await pool.query(
            'INSERT INTO professional_signatures (professional_name, signature_data, cedula) VALUES ($1, $2, $3)',
            [name, signature, cedula || null]
          );
        }
        return res.status(200).json({ success: true });
      }

      case 'getProfessionalSignature': {
        const { name } = req.query;
        const result = await pool.query(
          'SELECT signature_data, cedula FROM professional_signatures WHERE professional_name = $1',
          [name]
        );
        return res.status(200).json({
          signature: result.rows[0]?.signature_data || null,
          cedula: result.rows[0]?.cedula || null
        });
      }

      case 'listProfessionalSignatures': {
        const sigList = await pool.query(
          'SELECT id, professional_name, cedula, created_at FROM professional_signatures ORDER BY professional_name ASC'
        );
        return res.status(200).json(sigList.rows);
      }

      case 'generateSigningToken': {
        const { id: signId } = body;
        if (!signId) return res.status(400).json({ error: 'Consent ID required' });
        // ponytail: Math.random() es predecible — usar randomBytes para tokens de firma médica
        const token = crypto.randomBytes(32).toString('hex');
        
        await pool.query(
          'UPDATE consent_forms SET signing_token = $1, signing_status = $2 WHERE id = $3',
          [token, 'pending', signId]
        );
        
        return res.status(200).json({ token, url: `/consent-signing/${token}` });
      }

      case 'getSigningSession': {
        const { token } = req.query;
        if (!token) return res.status(400).json({ error: 'Token required' });
        // Use owner pool (bypasses RLS) — public action, no tenant context
        const ownerPool = getPool();
        const session = await ownerPool.query(
          'SELECT * FROM consent_forms WHERE signing_token = $1',
          [token]
        );
        
        if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
        
        const data = session.rows[0];
        
        // Fetch patient details
        const patient = await ownerPool.query(
          'SELECT first_name, last_name, rut, phone, birth_date FROM patients WHERE id = $1',
          [data.patient_id]
        );
        
        return res.status(200).json({
          ...data,
          patient: patient.rows[0] || {}
        });
      }

      case 'submitSignature': {
        const { token, signature, declarations, authorizations } = body;
        if (!token || !signature) return res.status(400).json({ error: 'Token and signature required' });
        // Use owner pool (bypasses RLS) — public action, no tenant context
        const ownerPool = getPool();
        const current = await ownerPool.query('SELECT signatures FROM consent_forms WHERE signing_token = $1', [token]);
        if (current.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
        
        const currentSigs = current.rows[0].signatures || {};
        const newSigs = {
          ...currentSigs,
          patient_sig_data: signature,
          patient_signed_at: new Date().toISOString()
        };
        
        await ownerPool.query(
          'UPDATE consent_forms SET signatures = $1, declarations = $2, authorizations = $3, signing_status = $4, status = $5, updated_at = NOW() WHERE signing_token = $6',
          [JSON.stringify(newSigs), JSON.stringify(declarations), JSON.stringify(authorizations || {}), 'signed', 'finalized', token]
        );
        
        return res.status(200).json({ success: true });
      }

      case 'listConsents': {
        const { patient_id: pid, record_id: rid } = req.query;
        let query = 'SELECT * FROM consent_forms WHERE ';
        let params = [];
        if (rid) {
          query += 'record_id = $1';
          params.push(rid);
        } else if (pid) {
          query += 'patient_id = $1';
          params.push(pid);
        } else {
          return res.status(400).json({ error: 'Missing patient_id or record_id' });
        }
        query += ' ORDER BY created_at DESC';
        const consents = await pool.query(query, params);
        return res.status(200).json(consents.rows);
      }

      case 'listAuditLog': {
        const { patient_id: auditPid, record_id: auditRid, limit: auditLimit } = req.query;
        if (!auditPid && !auditRid) return res.status(400).json({ error: 'patient_id o record_id requerido' });
        const ownAudit = su?.role !== 'master_admin' && su?.access_scope === 'own';
        const q = auditPid
          ? `SELECT l.* FROM patient_audit_log l
             WHERE l.patient_id = $1
               AND ($3::boolean = false OR l.clinic_user_id = $4 OR l.record_id IN (
                 SELECT id FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $4
               )) ORDER BY l.created_at DESC LIMIT $2`
          : `SELECT l.* FROM patient_audit_log l
             WHERE l.record_id = $1
               AND ($3::boolean = false OR l.clinic_user_id = $4)
             ORDER BY l.created_at DESC LIMIT $2`;
        const logs = await pool.query(q, [auditPid || auditRid, parseInt(auditLimit || '50'), ownAudit, su?.user_id]);
        return res.status(200).json(logs.rows);
      }

      case 'getConsent':
        const { id: cid } = req.query;
        const consent = await pool.query('SELECT * FROM consent_forms WHERE id = $1', [cid]);
        if (consent.rows.length === 0) return res.status(404).json({ error: 'Consent not found' });
        return res.status(200).json(consent.rows[0]);

      case 'saveConsent': {
        const { 
          id: saveCid, 
          record_id: saveRid, 
          patient_id: savePid,
          consultation_id: consId,
          status,
          created_by,
          procedure_type,
          zone,
          sessions,
          objectives,
          description,
          risks,
          benefits,
          alternatives,
          pre_care,
          post_care,
          contraindications,
          critical_antecedents,
          authorizations,
          declarations,
          signatures,
          attachments
        } = body;

        if (saveCid) {
          // Update
          const updateQuery = `
            UPDATE consent_forms SET
              status = COALESCE($1, status),
              consultation_id = COALESCE($2, consultation_id),
              updated_at = NOW(),
              procedure_type = COALESCE($3, procedure_type),
              zone = COALESCE($4, zone),
              sessions = COALESCE($5, sessions),
              objectives = COALESCE($6, objectives),
              description = COALESCE($7, description),
              risks = COALESCE($8, risks),
              benefits = COALESCE($9, benefits),
              alternatives = COALESCE($10, alternatives),
              pre_care = COALESCE($11, pre_care),
              post_care = COALESCE($12, post_care),
              contraindications = COALESCE($13, contraindications),
              critical_antecedents = COALESCE($14, critical_antecedents),
              authorizations = COALESCE($15, authorizations),
              declarations = COALESCE($16, declarations),
              signatures = COALESCE($17, signatures),
              attachments = COALESCE($18, attachments)
            WHERE id = $19 RETURNING *
          `;
          const updated = await pool.query(updateQuery, [
            status, consId, procedure_type, zone, sessions, 
            JSON.stringify(objectives), description, JSON.stringify(risks), JSON.stringify(benefits), JSON.stringify(alternatives),
            JSON.stringify(pre_care), JSON.stringify(post_care), JSON.stringify(contraindications),
            JSON.stringify(critical_antecedents), JSON.stringify(authorizations), JSON.stringify(declarations),
            JSON.stringify(signatures), JSON.stringify(attachments),
            saveCid
          ]);
          return res.status(200).json(updated.rows[0]);
        } else {
          // Create
          const insertQuery = `
            INSERT INTO consent_forms (
              record_id, patient_id, clinic_id, consultation_id, status, created_by,
              procedure_type, zone, sessions,
              objectives, description, risks, benefits, alternatives,
              pre_care, post_care, contraindications,
              critical_antecedents, authorizations, declarations,
              signatures, attachments
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9,
              $10, $11, $12, $13, $14,
              $15, $16, $17,
              $18, $19, $20,
              $21, $22
            ) RETURNING *
          `;
          const created = await pool.query(insertQuery, [
            saveRid, savePid, effectiveClinicId, consId, status || 'draft', created_by,
            procedure_type, zone, sessions,
            JSON.stringify(objectives || []), description || '', JSON.stringify(risks || []), JSON.stringify(benefits || []), JSON.stringify(alternatives || []),
            JSON.stringify(pre_care || []), JSON.stringify(post_care || []), JSON.stringify(contraindications || []),
            JSON.stringify(critical_antecedents || {}), JSON.stringify(authorizations || {}), JSON.stringify(declarations || {}),
            JSON.stringify(signatures || {}), JSON.stringify(attachments || [])
          ]);
          return res.status(200).json(created.rows[0]);
        }
      }

      case 'deleteConsent': {
        const { id: delCid } = req.query;
        if (!(await ownedByClinic(pool, 'consent_forms', delCid, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM consent_forms WHERE id = $1', [delCid]);
        return res.status(200).json({ message: 'Consent deleted' });
      }

      // ==========================================
      // FINANCE MODULE ACTIONS
      // ==========================================

      case 'financeCreate': {
        const su = await getSessionUserOnce();
        const { date, invoice_number, entity, description, type, subtotal, tax, total } = body;
        if (!entity || !type) return res.status(400).json({ error: 'Entidad y tipo son requeridos' });
        const clinicId   = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        const regBy      = su?.username ?? 'manual';
        const sub  = parseFloat(subtotal || 0);
        const taxV = parseFloat(tax  || 0);
        const tot  = parseFloat(total || 0) || (sub + taxV);
        try {
          const r = await pool.query(
            `INSERT INTO financial_records (date, invoice_number, entity, description, type, subtotal, tax, total, registered_by, clinic_id, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [date || new Date().toISOString().split('T')[0], invoice_number || null, entity, description || null, type, sub, taxV, tot, regBy, clinicId, su?.user_id ?? null]
          );
          return res.status(201).json(r.rows[0]);
        } catch (err) {
          console.error('Error creating finance record:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeUsers': {
        // Devuelve los usuarios de la clínica con su estado de visibilidad de finanzas
        const su = await getSessionUserOnce();
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        if (!clinicId && su?.role !== 'master_admin') return res.status(403).json({ error: 'Sin contexto de clínica' });
        try {
          // Usuarios de la clínica (excluyendo master_admin)
          let usersQuery = `SELECT id, username, full_name, role FROM clinic_users WHERE role != 'master_admin' AND is_active = true`;
          const usersParams = [];
          if (clinicId) { usersQuery += ` AND clinic_id = $1`; usersParams.push(clinicId); }
          // ponytail: @vercel/postgres no está disponible aquí — usamos pool (neon-clinical-db)
          // La tabla clinic_users vive en la misma BD (misma NEON_DATABASE_URL)
          const usersRes = await pool.query(usersQuery, usersParams);

          // Overrides de visibilidad de finanzas por usuario
          const userIds  = usersRes.rows.map(u => u.id);
          let overrides = {};
          if (userIds.length) {
            try {
              const ovr = await pool.query(
                `SELECT clinic_user_id, enabled FROM user_module_overrides WHERE feature = 'finanzas_visible' AND clinic_user_id = ANY($1)`,
                [userIds]
              );
              ovr.rows.forEach(r => { overrides[r.clinic_user_id] = r.enabled; });
            } catch (ovrErr) {
              // ponytail: si la tabla aun no existe, ignorar — todos visibles por defecto
              if (ovrErr.code !== '42P01') throw ovrErr;
            }
          }

          const users = usersRes.rows.map(u => ({
            id:         u.id,
            username:   u.username,
            full_name:  u.full_name || u.username,
            role:       u.role,
            // Si no hay override → visible (true). Si hay override con enabled=false → no visible
            finance_visible: overrides[u.id] !== false,
          }));
          return res.status(200).json(users);
        } catch (err) {
          console.error('Error fetching finance users:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeItemsGet': {
        const { record_id } = req.query;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!(await canAccessFinanceRecord(pool, su, record_id))) return res.status(403).json({ error: 'Sin acceso' });
        try {
          const items = await pool.query(
            'SELECT * FROM financial_items WHERE record_id = $1 ORDER BY sort_order, id ASC',
            [record_id]
          );
          return res.status(200).json(items.rows);
        } catch (err) {
          if (err.code === '42P01') return res.status(200).json([]); // tabla no existe aún
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeItemsSave': {
        // Guarda/reemplaza los items de una factura y recalcula totales del record
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        const { record_id, items } = body;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un array' });

        const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
        if (!(await canAccessFinanceRecord(pool, su, record_id))) return res.status(403).json({ error: 'Sin acceso' });

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Propagar tenant context al cliente interno para compatibilidad con RLS
          await client.query("SELECT set_config('app.current_tenant', $1, false)", [clinicId ? String(clinicId) : '']);
          // Borrar items anteriores
          await client.query('DELETE FROM financial_items WHERE record_id = $1', [record_id]);

          let totalSubtotal = 0, totalTax = 0, totalTotal = 0;

          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const qty      = parseFloat(it.quantity  || 1);
            const uprice   = parseFloat(it.unit_price || 0);
            const ivaRate  = parseFloat(it.iva_rate   || 0);
            const subtotal = parseFloat((qty * uprice).toFixed(2));
            const tax      = parseFloat((subtotal * ivaRate / 100).toFixed(2));
            const total    = parseFloat((subtotal + tax).toFixed(2));
            totalSubtotal += subtotal;
            totalTax      += tax;
            totalTotal    += total;
            await client.query(
              `INSERT INTO financial_items (record_id, clinic_id, description, quantity, unit_price, iva_rate, subtotal, tax, total, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [record_id, clinicId ?? null, it.description, qty, uprice, ivaRate,
               subtotal, tax, total, i]
            );
          }

          // Si hay items, actualizar totales del record padre
          if (items.length > 0) {
            await client.query(
              `UPDATE financial_records SET subtotal=$1, tax=$2, total=$3 WHERE id=$4`,
              [totalSubtotal.toFixed(2), totalTax.toFixed(2), totalTotal.toFixed(2), record_id]
            );
          }

          await client.query('COMMIT');
          return res.status(200).json({ success: true, subtotal: totalSubtotal, tax: totalTax, total: totalTotal });
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('Error saving finance items:', err);
          return res.status(500).json({ error: err.message });
        } finally {
          client.release();
        }
      }

      case 'financeList': {
        const su = await getSessionUserOnce();
        const { startDate, endDate, registered_by } = req.query;
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

        let query = `SELECT * FROM financial_records WHERE 1=1`;
        const params = [];
        let paramCount = 1;

        // Filtro por clínica (multi-tenant)
        if (clinicId) {
          query += ` AND (clinic_id = $${paramCount} OR clinic_id IS NULL)`;
          params.push(clinicId);
          paramCount++;
        }

        // Respetar finance_scope: 'own' restringe al usuario actual + grupo; 'all' permite ver toda la clínica
        if (su?.finance_scope === 'own') {
          query += ` AND (
            created_by_user_id = $${paramCount}
            OR created_by_user_id IN (
              SELECT sgm2.clinic_user_id
              FROM sharing_group_members sgm1
              JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
              WHERE sgm1.clinic_user_id = $${paramCount}
            )
          )`;
          params.push(su.user_id);
          paramCount++;
        } else if (registered_by && registered_by !== 'all' && registered_by !== 'null' && registered_by !== 'undefined') {
          // Soporta lista separada por comas: "user1,user2,user3"
          const users = String(registered_by).split(',').map(u => u.trim()).filter(Boolean);
          if (users.length === 1) {
            query += ` AND registered_by = $${paramCount}`;
            params.push(users[0]);
            paramCount++;
          } else if (users.length > 1) {
            // ponytail: unnest con ANY es idiomático en PostgreSQL y previene SQL injection
            query += ` AND registered_by = ANY($${paramCount}::text[])`;
            params.push(users);
            paramCount++;
          }
        }

        if (startDate && startDate !== 'null' && startDate !== 'undefined') {
          query += ` AND date >= $${paramCount}`;
          params.push(startDate);
          paramCount++;
        }
        if (endDate && endDate !== 'null' && endDate !== 'undefined') {
          query += ` AND date <= $${paramCount}`;
          params.push(endDate);
          paramCount++;
        }

        query += ` ORDER BY date DESC, created_at DESC`;
        
        try {
          const result = await pool.query(query, params);
          return res.status(200).json(result.rows);
        } catch (err) {
          console.error('Error listing finance records:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeDelete': {
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(su.role))
          return res.status(403).json({ error: 'Solo administradores pueden eliminar registros' });
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        if (!(await canAccessFinanceRecord(pool, su, id))) return res.status(403).json({ error: 'Sin acceso' });
        try {
          const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
          if (su.role === 'master_admin') {
            await pool.query('DELETE FROM financial_records WHERE id = $1', [id]);
          } else {
            await pool.query('DELETE FROM financial_records WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)', [id, clinicId]);
          }
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeStats': {
        // Stats generales y por usuario
        const su = await getSessionUserOnce();
        const { startDate, endDate } = req.query;
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        let query = `
          SELECT 
            type, 
            registered_by,
            SUM(total) as total_amount,
            COUNT(*) as count
          FROM financial_records
          WHERE status = 'confirmed'
        `;
        const params = [];
        let paramCount = 1;

        if (clinicId) {
          query += ` AND clinic_id = $${paramCount}`;
          params.push(clinicId);
          paramCount++;
        }
        if (su?.finance_scope === 'own') {
          query += ` AND (created_by_user_id = $${paramCount} OR created_by_user_id IN (
            SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
            JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
            WHERE sgm1.clinic_user_id = $${paramCount}
          ))`;
          params.push(su.user_id);
          paramCount++;
        }

        if (startDate && startDate !== 'null') {
          query += ` AND date >= $${paramCount}`;
          params.push(startDate);
          paramCount++;
        }
        if (endDate && endDate !== 'null') {
          query += ` AND date <= $${paramCount}`;
          params.push(endDate);
          paramCount++;
        }
        
        query += ` GROUP BY type, registered_by`;

        try {
          const result = await pool.query(query, params);
          return res.status(200).json(result.rows);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeUpdate': {
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(su.role))
          return res.status(403).json({ error: 'Solo administradores pueden editar registros' });
        const { id, date, invoice_number, entity, description, type, subtotal, tax, total } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        if (!['ingreso', 'egreso'].includes(type))
          return res.status(400).json({ error: 'Tipo inválido. Use ingreso o egreso' });
        if (!(await canAccessFinanceRecord(pool, su, id))) return res.status(403).json({ error: 'Sin acceso' });

        try {
          const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
          if (su.role === 'master_admin') {
            await pool.query(
              `UPDATE financial_records SET date=$1, invoice_number=$2, entity=$3, description=$4, type=$5, subtotal=$6, tax=$7, total=$8 WHERE id=$9`,
              [date, invoice_number, entity, description, type, subtotal, tax, total, id]
            );
          } else {
            await pool.query(
              `UPDATE financial_records SET date=$1, invoice_number=$2, entity=$3, description=$4, type=$5, subtotal=$6, tax=$7, total=$8 WHERE id=$9 AND (clinic_id=$10 OR clinic_id IS NULL)`,
              [date, invoice_number, entity, description, type, subtotal, tax, total, id, clinicId]
            );
          }
          return res.status(200).json({ success: true, message: 'Record updated' });
        } catch (err) {
          console.error('Error updating finance record:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      // ==========================================
      // PHOTOS MODULE (Cloudflare R2)
      // ==========================================

      case 'uploadPhotoProxy': {
        // Cliente envía base64 → servidor sube a R2 y guarda metadata
        const { fileBase64, content_type, record_id, consultation_id, session_label, photo_type = 'general', face_zone } = body;
        if (!fileBase64 || !record_id || !content_type) return res.status(400).json({ error: 'fileBase64, record_id y content_type requeridos' });
        const allowed = ['image/jpeg','image/png','image/webp','image/heic'];
        if (!allowed.includes(content_type)) return res.status(400).json({ error: 'Tipo de archivo no permitido' });
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!(await recordBelongsToClinic(pool, record_id, clinicId))) return res.status(404).json({ error: 'Expediente no encontrado' });
        const ext = content_type.split('/')[1] || 'jpg';
        const r2Key = `clinics/${clinicId}/records/${record_id}/photos/${crypto.randomUUID()}.${ext}`;
        try {
          const buffer = Buffer.from(fileBase64, 'base64');
          if (buffer.length === 0 || buffer.length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'La imagen supera el límite permitido de 4 MB' });
          await putR2Object(r2Key, buffer, content_type);
          const result = await pool.query(
            `INSERT INTO clinical_photos (record_id, consultation_id, clinic_id, r2_key, photo_type, face_zone, session_label, taken_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id, r2_key, photo_type, created_at`,
            [record_id, consultation_id||null, clinicId, r2Key, photo_type, face_zone||null, session_label||null]
          );
          return res.status(201).json(result.rows[0]);
        } catch (err) {
          console.error('uploadPhotoProxy error:', err);
          if (err.message?.includes('no configuradas')) return res.status(503).json({ error: 'Almacenamiento no configurado — Configure R2_ACCESS_KEY_ID en Vercel' });
          return res.status(500).json({ error: err.message });
        }
      }

      case 'getPhotoUploadUrl': {
        // Returns a presigned PUT URL — the client uploads directly to R2, never via server
        const { record_id, content_type, content_length } = body;
        if (!record_id || !content_type || !content_length) return res.status(400).json({ error: 'record_id, content_type y content_length requeridos' });
        if (!Number.isInteger(content_length) || content_length < 1 || content_length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'La imagen supera el límite permitido de 4 MB' });
        const allowed = ['image/jpeg','image/png','image/webp','image/heic'];
        if (!allowed.includes(content_type)) return res.status(400).json({ error: 'Tipo de archivo no permitido' });

        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!(await recordBelongsToClinic(appPool, record_id, clinicId))) return res.status(404).json({ error: 'Expediente no encontrado' });
        const r2Key = `clinics/${clinicId}/records/${record_id}/photos/${crypto.randomUUID()}.${content_type.split('/')[1]}`;
        try {
          const presignedUrl = await generateUploadUrl(r2Key, content_type, content_length);
          return res.status(200).json({ presignedUrl, r2Key });
        } catch (err) {
          console.error('R2 upload URL error:', err);
          return res.status(503).json({ error: 'Almacenamiento no configurado — Configure R2_ACCESS_KEY_ID en Vercel' });
        }
      }

      case 'confirmPhotoUpload': {
        const { record_id, r2_key, photo_type = 'general', face_zone, body_zone, session_label, notes, consultation_id, taken_at } = body;
        if (!record_id || !r2_key) return res.status(400).json({ error: 'record_id y r2_key requeridos' });
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!PHOTO_TYPES.has(photo_type)) return res.status(400).json({ error: 'Tipo de foto inválido' });
        if (!(await recordBelongsToClinic(pool, record_id, clinicId)) || !isOwnedPhotoKey(r2_key, clinicId, record_id)) {
          return res.status(400).json({ error: 'Clave de almacenamiento inválida' });
        }
        try {
          const result = await pool.query(
            `INSERT INTO clinical_photos (record_id, consultation_id, clinic_id, r2_key, photo_type, face_zone, body_zone, session_label, notes, taken_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, r2_key, photo_type, created_at`,
            [record_id, consultation_id||null, clinicId, r2_key, photo_type, face_zone||null, body_zone||null, session_label||null, notes||null, taken_at||null]
          );
          return res.status(201).json(result.rows[0]);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'listPhotos': {
        const { record_id, limit: lim, offset: off } = req.query;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        const pageSize = Math.min(parseInt(lim) || 24, 50);
        const offset   = Math.max(parseInt(off) || 0, 0);
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!(await recordBelongsToClinic(pool, record_id, clinicId))) return res.status(404).json({ error: 'Expediente no encontrado' });
        try {
          const countRes = await pool.query(
            `SELECT COUNT(*) FROM clinical_photos WHERE record_id = $1 AND clinic_id = $2`, [record_id, clinicId]
          );
          const total = parseInt(countRes.rows[0].count);
          const result = await pool.query(
            `SELECT id, r2_key, photo_type, face_zone, body_zone, session_label, notes, taken_at, created_at
             FROM clinical_photos WHERE record_id = $1 AND clinic_id = $2 ORDER BY taken_at DESC LIMIT $3 OFFSET $4`,
            [record_id, clinicId, pageSize, offset]
          );
          const photos = await Promise.all(result.rows.map(async (p) => {
            try { return { ...p, r2_url: await generateReadUrl(p.r2_key) }; }
            catch { return { ...p, r2_url: null }; }
          }));
          return res.status(200).json({ photos, total, hasMore: offset + pageSize < total });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'updatePhoto': {
        const { id, photo_type, face_zone, body_zone, session_label, notes } = body;
        if (!id) return res.status(400).json({ error: 'id requerido' });
        const clinicIdUp = su?.effective_clinic_id ?? su?.clinic_id;
        try {
          const upRes = await pool.query(
            `UPDATE clinical_photos SET photo_type=$1, face_zone=$2, body_zone=$3, session_label=$4, notes=$5
             WHERE id=$6 AND clinic_id=$7`,
            [photo_type||null, face_zone||null, body_zone||null, session_label||null, notes||null, id, clinicIdUp]
          );
          if (upRes.rowCount === 0) return res.status(404).json({ error: 'Foto no encontrada' });
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'deletePhoto': {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id requerido' });
        const clinicIdDel = su?.effective_clinic_id ?? su?.clinic_id;
        try {
          const r = await pool.query(
            'SELECT r2_key FROM clinical_photos WHERE id = $1 AND clinic_id = $2',
            [id, clinicIdDel]
          );
          if (!r.rows.length) return res.status(404).json({ error: 'Foto no encontrada' });
          if (r.rows[0].r2_key) await deleteR2Object(r.rows[0].r2_key);
          await pool.query('DELETE FROM clinical_photos WHERE id = $1', [id]);
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'sendFinanceCsv': {
        const su = await getSessionUserOnce();
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!clinicId) return res.status(400).json({ error: 'Clínica no identificada' });
        const { startDate, endDate } = body;
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate y endDate requeridos' });
        try {
          const result = await sendFinanceCsvToAdmin({ pool, clinicId, userId: su.user_id, financeScope: su.finance_scope, startDate, endDate, periodLabel: 'manual' });
          return res.status(200).json({ success: true, ...result });
        } catch (err) {
          return res.status(400).json({ success: false, error: err.message });
        }
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
    } finally {
      // Limpiar tenant antes de devolver la conexión al pool
      try { await client.query("SELECT set_config('app.current_tenant', '', false)"); } catch {}
      client.release();
    }
  } catch (error) {
    console.error('Clinical Records API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
