/**
 * @file api/system-status.js
 * @description Estado y diagnóstico de los servicios del sistema.
 *
 * ACCESO:
 *  - master_admin: todos los checks (DB, Calendar, Email)
 *  - clinic_admin / clinic_user: solo DB + Email de la clínica
 *
 * Acciones (query param `type`):
 *  - all      → todos los checks disponibles para el rol (objeto con todos los estados)
 *  - db       → conexión a Neon PostgreSQL
 *  - calendar → Google Calendar (solo master_admin)
 *  - email    → SMTP Email
 */

import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { getPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';

export default async function handler(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth.valid) return res.status(401).json({ success: false, error: 'No autenticado' });

  const isMaster = auth.role === 'master_admin';
  const { type } = req.query;

  // ── Estado relevante para el usuario (suscripción + demo) ────────────────
  if (type === 'user-status') {
    try {
      const pool = getPool();
      if (!pool) return res.status(503).json({ success: false, error: 'DB no disponible' });
      const clinicId = auth.effective_clinic_id ?? auth.clinic_id;
      if (!clinicId) return res.status(200).json({ success: true, status: 'master', plan_name: 'Master Admin' });

      // clinics y clinic_users están en la misma BD (POSTGRES_URL / NEON_DATABASE_URL)
      const [clinicRes, userRes] = await Promise.all([
        pool.query('SELECT name, subscription_expires_at FROM clinics WHERE id = $1', [clinicId]),
        auth.id
          ? pool.query('SELECT is_demo, demo_expires_at FROM clinic_users WHERE id = $1', [auth.id])
          : Promise.resolve({ rows: [] }),
      ]);

      const clinic = clinicRes.rows[0] || {};
      const cu     = userRes.rows[0]   || {};
      const expiresAt = clinic.subscription_expires_at ? new Date(clinic.subscription_expires_at) : null;
      const daysRemaining = expiresAt
        ? Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000)
        : null;

      let status = 'active';
      if (cu.is_demo) status = 'demo';
      else if (!expiresAt) status = 'no_subscription';
      else if (daysRemaining < 0) status = 'expired';
      else if (daysRemaining <= 21) status = 'expiring_soon';

      return res.status(200).json({
        success: true,
        clinic_name: clinic.name || null,
        subscription_expires_at: expiresAt ? expiresAt.toISOString() : null,
        days_remaining: daysRemaining,
        status,
        is_demo: cu.is_demo || false,
        demo_expires_at: cu.demo_expires_at || null,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (type === 'all') {
    // Ejecutar todos los checks disponibles para el rol
    const results = {};

    results.db = await checkDB();

    if (isMaster) {
      results.calendar = await checkCalendar();
    }

    results.email = await checkEmail();

    return res.status(200).json({
      success: Object.values(results).every(r => r.success),
      role: auth.role,
      username: auth.username,
      checks: results,
    });
  }

  if (type === 'db') {
    return res.status(200).json(await checkDB());
  }

  if (type === 'calendar') {
    if (!isMaster) return res.status(403).json({ success: false, error: 'Acceso restringido — solo master_admin' });
    return res.status(200).json(await checkCalendar());
  }

  if (type === 'email') {
    return res.status(200).json(await checkEmail());
  }

  return res.status(400).json({ success: false, error: 'Tipo de prueba no válido (all/db/calendar/email)' });
}

// ─── Checks ───────────────────────────────────────────────────────────────────

async function checkDB() {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  try {
    log('Verificando conexión a Neon PostgreSQL...');
    const connStr = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
    if (!connStr) throw new Error('NEON_DATABASE_URL / POSTGRES_URL no configurada');

    const pool = getPool();
    if (!pool) throw new Error('Pool no disponible');

    const start = Date.now();
    const r = await pool.query('SELECT 1 AS ok, NOW() AS ts');
    const ms = Date.now() - start;

    log(`Conexión exitosa. Latencia: ${ms}ms. DB time: ${r.rows[0].ts}`);
    return { success: true, latency_ms: ms, logs };
  } catch (e) {
    log(`ERROR: ${e.message}`);
    return { success: false, logs };
  }
}

async function checkCalendar() {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  try {
    log('Iniciando prueba de conexión con Google Calendar...');
    const credBase64 = process.env.GOOGLE_CREDENTIALS_BASE64;
    if (!credBase64) throw new Error('GOOGLE_CREDENTIALS_BASE64 no configurada');

    const creds = JSON.parse(Buffer.from(credBase64, 'base64').toString('utf8'));
    log(`Credenciales cargadas para: ${creds.client_email}`);

    const jwt = new google.auth.JWT(
      creds.client_email, null, creds.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    await jwt.authorize();
    log('Autenticación Google exitosa.');

    const cal = google.calendar({ version: 'v3', auth: jwt });
    const resp = await cal.calendarList.list({ maxResults: 1 });
    log(`Calendarios encontrados: ${resp.data.items?.length ?? 0}`);
    return { success: true, logs };
  } catch (e) {
    log(`ERROR: ${e.message}`);
    if (e.response?.data) log(`Detalle API: ${JSON.stringify(e.response.data)}`);
    return { success: false, logs, code: e.code };
  }
}

async function checkEmail() {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  try {
    log('Iniciando prueba de conexión SMTP...');
    const host = process.env.EMAIL_HOST;
    const port = process.env.EMAIL_PORT;
    const user = process.env.EMAIL_USER;
    if (!host || !port || !user) throw new Error('Faltan vars de entorno: EMAIL_HOST, EMAIL_PORT, EMAIL_USER');

    log(`SMTP: ${host}:${port} (${user})`);
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(port),
      secure: parseInt(port) === 465,
      auth: { user, pass: process.env.EMAIL_PASS },
    });

    await transporter.verify();
    log('Conexión SMTP verificada correctamente.');
    return { success: true, logs };
  } catch (e) {
    log(`ERROR: ${e.message}`);
    return { success: false, logs, code: e.code };
  }
}
