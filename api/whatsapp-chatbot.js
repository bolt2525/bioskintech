import crypto from 'crypto';
import { google } from 'googleapis';
import { sql } from '@vercel/postgres';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../lib/whatsapp-service.js';
import { buildFinanceCsv } from '../lib/finance-csv.js';
import { requireAuth, requireRole } from '../lib/admin-auth.js';
import {
  listWhatsAppContacts,
  listWhatsAppMessages,
  recordWhatsAppMessage,
  isWithinCustomerServiceWindow,
  updateWhatsAppMessageStatus,
} from '../lib/whatsapp-crm.js';

const getQueryValue = (value) => Array.isArray(value) ? value[0] : value;

export const config = { api: { bodyParser: false } };

/** Números de staff interno del sistema (no clínicas/pacientes) — soporte técnico vía WhatsApp. */
function getSystemStaffPhones() {
  return new Set(
    (process.env.WHATSAPP_SYSTEM_STAFF_PHONES || '')
      .split(',')
      .map((p) => normalizeEcuadorPhone(p.trim()))
      .filter(Boolean)
  );
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) {
      const error = new Error('Payload demasiado grande');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function verifyWhatsAppWebhook(query, verifyToken = process.env.WHATSAPP_VERIFY_TOKEN) {
  const mode = getQueryValue(query?.['hub.mode']);
  const token = getQueryValue(query?.['hub.verify_token']);
  const challenge = getQueryValue(query?.['hub.challenge']);

  if (mode !== 'subscribe' || !verifyToken || token !== verifyToken || challenge === undefined) {
    return null;
  }

  return String(challenge);
}

export function verifyWhatsAppSignature(signature, rawBody, appSecret = process.env.WHATSAPP_APP_SECRET) {
  if (!signature || !rawBody || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const received = Buffer.from(String(signature));
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && crypto.timingSafeEqual(received, calculated);
}

/** OAuth2 client con los tokens de Google guardados para el usuario. */
async function getUserOAuth2Client(userId) {
  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const r = await sql`SELECT access_token, refresh_token, token_expiry FROM clinic_oauth_tokens WHERE clinic_user_id = ${userId}`;
  if (!r.rows.length) return null;
  const { access_token, refresh_token, token_expiry } = r.rows[0];
  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, `${appUrl}/api/calendar`);
  oAuth2.setCredentials({ access_token, refresh_token, expiry_date: token_expiry ? new Date(token_expiry).getTime() : null });
  return oAuth2;
}

/** Normaliza un número a formato Ecuador (593...) a partir de dígitos crudos. */
export function normalizeEcuadorPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `593${digits.substring(1)}`;
  if (digits.startsWith('593')) return digits;
  return `593${digits}`;
}

/** Extrae teléfono y nombre de paciente del evento de Google Calendar, igual que CalendarManager.tsx. */
function parseAppointmentEvent(event) {
  if (!event.summary?.startsWith('Cita: ')) return null;
  // Sin teléfono la cita igual debe listarse; solo se omite el link de recordatorio manual
  const phoneMatch = event.description?.match(/Teléfono:\s*([\d+\-\s]+)/);
  const phone = phoneMatch ? normalizeEcuadorPhone(phoneMatch[1]) : '';
  const patientName = event.summary.substring(6).split(' - ')[0] || 'Paciente';
  const professional = event.description?.match(/Profesional:\s*([^\n]+)/)?.[1]?.trim() || '';
  return { phone, patientName, professional };
}

/** Extrae mensajes entrantes normalizados del payload de WhatsApp Cloud API. */
export function extractIncomingMessages(body) {
  const messages = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const contacts = new Map((change?.value?.contacts || []).map(contact => [
        normalizeEcuadorPhone(contact?.wa_id),
        String(contact?.profile?.name || '').trim() || null,
      ]));
      for (const msg of change?.value?.messages || []) {
        if (!msg?.from || !msg?.id) continue;
        const from = normalizeEcuadorPhone(msg.from);
        const mediaType = msg.type === 'image' ? 'imagen' : msg.type === 'audio' ? 'audio' : 'texto';
        // Respuesta a botón de plantilla (quick reply) llega como msg.button, no msg.text
        const buttonText = msg.button?.text || msg.interactive?.button_reply?.title || '';
        const text = (msg.text?.body || buttonText || msg.image?.caption || (mediaType === 'imagen' ? '[Imagen]' : mediaType === 'audio' ? '[Audio]' : '')).trim();
        messages.push({
          from,
          text,
          mediaType,
          providerMessageId: msg.id || null,
          timestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
          name: contacts.get(from) || null,
        });
      }
    }
  }
  return messages;
}

export function extractMessageStatuses(body) {
  const statuses = [];
  const statusMap = { sent: 'enviado', delivered: 'enviado', read: 'leido', failed: 'fallido' };
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const event of change?.value?.statuses || []) {
        const status = statusMap[event?.status];
        if (event?.id && status) {
          statuses.push({
            providerMessageId: event.id,
            status,
            errorDetail: event.errors?.[0]?.title || event.errors?.[0]?.message || null,
          });
        }
      }
    }
  }
  return statuses;
}

/** Lista en texto plano las citas de hoy del usuario autorizado. */
async function listTodayAppointments(userId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  return listAppointmentsForDate(userId, today, 'Citas de hoy');
}

/** Valida y normaliza fechas escritas por el staff (hoy/mañana/DD-MM-AAAA/DD/MM/AAAA/AAAA-MM-DD) a 'YYYY-MM-DD'. */
function parseFlexibleDate(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return null;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  if (['hoy', 'today'].includes(raw)) return today();
  if (['mañana', 'manana', 'tomorrow'].includes(raw)) {
    const d = new Date(`${today()}T00:00:00-05:00`);
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  }
  // ISO: AAAA-MM-DD
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  // DD/MM/AAAA o DD-MM-AAAA
  if (!m) {
    const alt = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (alt) m = [alt[0], alt[3], alt[2], alt[1]];
  }
  // DD/MM (año actual)
  if (!m) {
    const alt = raw.match(/^(\d{1,2})[/-](\d{1,2})$/);
    if (alt) m = [alt[0], String(new Date().getFullYear()), alt[2], alt[1]];
  }
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00-05:00`);
  // Rechaza fechas inválidas tipo 31/02 (JS las "normaliza" a marzo)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return iso;
}

/** Valida y normaliza una hora escrita por el staff ("14:30", "2:30pm", "2pm") a {hour, minute}. */
function parseFlexibleTime(text) {
  const raw = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  let m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    return (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) ? { hour, minute } : null;
  }
  m = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (m[3] === 'pm' && hour !== 12) hour += 12;
    if (m[3] === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  return null;
}

/** Trae las citas de un día con datos listos para reprogramar/eliminar (id de evento, paciente, teléfono, duración). */
async function getAppointmentsForDate(userId, isoDate) {
  const auth = await getUserOAuth2Client(userId);
  if (!auth) return { error: 'No tienes Google Calendar conectado a tu cuenta.' };
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.events.list({
    calendarId: 'primary', timeMin: `${isoDate}T00:00:00-05:00`, timeMax: `${isoDate}T23:59:59-05:00`,
    singleEvents: true, orderBy: 'startTime',
  });
  const appointments = (data.items || [])
    .filter(e => e.summary?.startsWith('Cita: '))
    .map(e => {
      const parsed = parseAppointmentEvent(e) || {};
      const start = new Date(e.start?.dateTime || e.start?.date);
      const end = new Date(e.end?.dateTime || e.end?.date);
      const hora = e.start?.dateTime
        ? start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Guayaquil' })
        : '';
      const patientName = parsed.patientName || e.summary.substring(6).split(' - ')[0] || 'Paciente';
      const reminderMessage = `Hola ${patientName}, te escribimos para confirmar/actualizar tu cita del ${isoDate}${hora ? ` a las ${hora}` : ''}. Por favor responde a este mensaje si tienes alguna consulta.`;
      return {
        id: e.id, hora, patientName, phone: parsed.phone || '', professional: parsed.professional || '',
        link: parsed.phone ? `https://wa.me/${parsed.phone}?text=${encodeURIComponent(reminderMessage)}` : '',
        durationMs: (!Number.isNaN(end.getTime()) && !Number.isNaN(start.getTime()) && end > start) ? end - start : 60 * 60 * 1000,
      };
    });
  return { appointments };
}

function formatAppointmentSelectionList(appointments) {
  return appointments.map((a, i) => `${i + 1}. ${a.hora || 'Hora pendiente'} — ${a.patientName}`).join('\n');
}

async function listAppointmentsForDate(userId, isoDate, label) {
  const { error, appointments } = await getAppointmentsForDate(userId, isoDate);
  if (error) return error;
  const dateLabel = new Date(`${isoDate}T00:00:00-05:00`).toLocaleDateString('es-ES', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric' });
  if (!appointments.length) return `${label} (${dateLabel}): no hay citas agendadas.`;
  const lines = appointments.map((a, i) => `${i + 1}. ${a.hora || 'Hora pendiente'} — ${a.patientName}${a.link ? `\n   Enviar recordatorio: ${a.link}` : ''}`);
  return `📅 ${label} (${dateLabel}):\n\n${lines.join('\n\n')}`;
}

/** Cambia la fecha/hora de una cita existente, conservando su duración original. */
async function rescheduleAppointment(userId, eventId, newIsoDate, time, durationMs) {
  const auth = await getUserOAuth2Client(userId);
  if (!auth) throw new Error('No tienes Google Calendar conectado a tu cuenta.');
  const calendar = google.calendar({ version: 'v3', auth });
  const startDate = new Date(`${newIsoDate}T${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}:00-05:00`);
  const endDate = new Date(startDate.getTime() + durationMs);
  await calendar.events.patch({
    calendarId: 'primary', eventId,
    requestBody: {
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Guayaquil' },
      end: { dateTime: endDate.toISOString(), timeZone: 'America/Guayaquil' },
    },
  });
  return startDate;
}

/** Elimina una cita existente del calendario del staff. */
async function deleteAppointment(userId, eventId) {
  const auth = await getUserOAuth2Client(userId);
  if (!auth) throw new Error('No tienes Google Calendar conectado a tu cuenta.');
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId: 'primary', eventId });
}


const MENU_TEXT = '1) Agenda\n2) Reporte financiero\n\nResponde con el número de la opción.';
const AGENDA_MENU_TEXT = '📅 Agenda\n\n1) Ver citas de hoy\n2) Ver citas de otro día\n3) Reprogramar una cita\n4) Eliminar una cita\n\nResponde con el número de la opción.';
const FINANCE_REPORT_MENU_TEXT = '📊 Reporte financiero\n\n1) Diario\n2) Semanal\n3) Mensual\n\nResponde con el número o la palabra del período.';
const AGENDA_DATE_PROMPT = '📅 Escribe la fecha que quieres consultar.\nFormatos válidos: "hoy", "mañana", 31/12/2026 o 2026-12-31.';
const RESCHEDULE_DATE_PROMPT = '📅 ¿Qué día está la cita que quieres reprogramar?\nFormatos válidos: "hoy", "mañana", 31/12/2026 o 2026-12-31.';
const DELETE_DATE_PROMPT = '📅 ¿Qué día está la cita que quieres eliminar?\nFormatos válidos: "hoy", "mañana", 31/12/2026 o 2026-12-31.';
const NEW_DATE_PROMPT = '📅 Escribe la nueva fecha para la cita.\nFormatos válidos: "hoy", "mañana", 31/12/2026 o 2026-12-31.';
const NEW_TIME_PROMPT = '🕒 Escribe la nueva hora de la cita (ej: 14:30 o 2:30pm).';
const financeStateByPhone = new Map();
const agendaDateStateByPhone = new Map();
const agendaMenuStateByPhone = new Map();
const rescheduleStateByPhone = new Map();
const deleteStateByPhone = new Map();
const ALLOWED_BOT_ACTIONS = new Set(['1', '2', 'diario', 'daily', 'semanal', 'weekly', 'mensual', 'monthly']);

function buildFinanceRange(period, today = new Date()) {
  const fmt = (d) => d.toISOString().split('T')[0];
  if (period === 'daily') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    return { startDate: fmt(y), endDate: fmt(y), periodLabel: 'diario' };
  }
  if (period === 'weekly') {
    const start = new Date(today); start.setDate(start.getDate() - 7);
    const end = new Date(today); end.setDate(end.getDate() - 1);
    return { startDate: fmt(start), endDate: fmt(end), periodLabel: 'semanal' };
  }
  if (period === 'monthly') {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { startDate: fmt(start), endDate: fmt(end), periodLabel: 'mensual' };
  }
  return null;
}

export function resolveFinancePeriodChoice(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'diario', 'daily'].includes(raw)) return 'daily';
  if (['2', 'semanal', 'weekly'].includes(raw)) return 'weekly';
  if (['3', 'mensual', 'monthly'].includes(raw)) return 'monthly';
  return null;
}

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

async function getUserGmailClient(userId) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
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

async function sendFinanceReportToUser(clinicUser, period, from) {
  const clinicId = clinicUser.clinic_id;
  const settingsRes = await sql`SELECT finanzas, general FROM clinic_settings WHERE clinic_id = ${clinicId}`;
  const row = settingsRes.rows[0] || {};
  const finanzas = row.finanzas || {};
  const clinicName = row.general?.name || 'la clínica';
  const recipientEmail = (clinicUser.email || finanzas.admin_email || '').trim();
  if (!recipientEmail) {
    await sendWhatsAppText(from, '⚠️ Tu usuario no tiene un correo configurado para recibir el reporte.');
    return;
  }

  const oauth = await getUserGmailClient(clinicUser.id);
  if (!oauth) {
    await sendWhatsAppText(from, '⚠️ No tienes una cuenta Gmail conectada para enviar el reporte financiero.');
    return;
  }

  const range = buildFinanceRange(period);
  if (!range) {
    await sendWhatsAppText(from, '❌ Período no válido para el reporte financiero.');
    return;
  }

  const recordsRes = clinicUser.finance_scope === 'own'
    ? await sql`SELECT * FROM financial_records WHERE clinic_id = ${clinicId}
        AND (created_by_user_id = ${clinicUser.id} OR created_by_user_id IN (
          SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
          JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
          WHERE sgm1.clinic_user_id = ${clinicUser.id}
        )) AND date >= ${range.startDate} AND date <= ${range.endDate} ORDER BY date ASC`
    : await sql`SELECT * FROM financial_records WHERE clinic_id = ${clinicId}
        AND date >= ${range.startDate} AND date <= ${range.endDate} ORDER BY date ASC`;

  const csv = buildFinanceCsv(recordsRes.rows);
  const gmail = google.gmail({ version: 'v1', auth: oauth.client });
  const raw = buildRawEmailWithCsvAttachment({
    from: `${clinicName} <${oauth.email}>`,
    to: recipientEmail,
    subject: `Reporte financiero (${range.periodLabel}) — ${clinicName}`,
    html: `<p>Adjunto el reporte financiero de <strong>${clinicName}</strong> (${range.periodLabel}, ${range.startDate} a ${range.endDate}).</p><p>Registros incluidos: ${recordsRes.rows.length}</p>`,
    attachmentName: `finanzas_${range.startDate}_${range.endDate}.csv`,
    attachmentContent: csv,
  });

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  await sendWhatsAppText(from, `✅ Reporte financiero ${range.periodLabel} enviado a ${recipientEmail} (${recordsRes.rows.length} registros).`);
}

// ── Panel de staff interno del sistema (soporte técnico, no clínicas/pacientes) ──

const systemStateByPhone = new Map();
const SYSTEM_MENU_TEXT = '🛠️ Panel de sistema BIOSKIN\n\n1) Estado de servicios (DB / Email / WhatsApp)\n2) Clínicas y usuarios activos\n3) Conexiones Google (OAuth) por clínica\n4) Mensajes de WhatsApp fallidos (24h)\n5) Pregunta libre (IA)\n\nResponde con el número.';

async function getServiceStatusText() {
  const parts = [];
  try {
    const t0 = Date.now();
    await sql`SELECT 1`;
    parts.push(`✅ Base de datos: OK (${Date.now() - t0}ms)`);
  } catch (e) {
    parts.push(`❌ Base de datos: ${e.message}`);
  }
  parts.push((process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_HOST)
    ? '✅ Email SMTP: configurado' : '⚠️ Email SMTP: no configurado');
  parts.push((process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
    ? '✅ WhatsApp Cloud API: credenciales configuradas' : '❌ WhatsApp Cloud API: faltan credenciales');
  return parts.join('\n');
}

async function getClinicsUsersSummaryText() {
  const [clinics, users] = await Promise.all([
    sql`SELECT count(*) FILTER (WHERE is_active) AS active, count(*) AS total FROM clinics`,
    sql`SELECT count(*) FILTER (WHERE is_active) AS active, count(*) AS total FROM clinic_users`,
  ]);
  const c = clinics.rows[0]; const u = users.rows[0];
  return `🏥 Clínicas: ${c.active} activas / ${c.total} total\n👤 Usuarios: ${u.active} activos / ${u.total} total`;
}

async function getOAuthConnectionsText() {
  const r = await sql`
    SELECT c.name AS clinic_name, count(t.*) AS conectados,
           count(*) FILTER (WHERE t.token_expiry IS NOT NULL AND t.token_expiry < NOW()) AS expirados
    FROM clinics c
    LEFT JOIN clinic_users cu ON cu.clinic_id = c.id
    LEFT JOIN clinic_oauth_tokens t ON t.clinic_user_id = cu.id
    WHERE c.is_active = true
    GROUP BY c.name
    ORDER BY c.name
  `;
  if (!r.rows.length) return 'Sin clínicas activas.';
  return r.rows.map(row => `${row.clinic_name}: ${row.conectados} conectados${Number(row.expirados) > 0 ? ` (⚠️ ${row.expirados} con token vencido)` : ''}`).join('\n');
}

async function getRecentFailedMessagesText() {
  const r = await sql`
    SELECT c.phone, m.error_detail, m.occurred_at
    FROM whatsapp_messages m
    JOIN whatsapp_contacts c ON c.id = m.contact_id
    WHERE m.status = 'fallido' AND m.occurred_at > NOW() - INTERVAL '24 hours'
    ORDER BY m.occurred_at DESC
    LIMIT 10
  `;
  if (!r.rows.length) return '✅ Sin mensajes fallidos en las últimas 24h.';
  return r.rows.map(row => `• ${row.phone}: ${row.error_detail || 'sin detalle'} (${new Date(row.occurred_at).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })})`).join('\n');
}

/** Responde una pregunta libre usando Gemini, con contexto real del sistema (solo lectura, sin acceso directo a la BD desde la IA). */
async function askSystemAI(question) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return '⚠️ IA no configurada (falta GEMINI_API_KEY en Vercel).';
  const [status, counts, oauth, failed] = await Promise.all([
    getServiceStatusText(), getClinicsUsersSummaryText(), getOAuthConnectionsText(), getRecentFailedMessagesText(),
  ]);
  const context = `Estado de servicios:\n${status}\n\nClínicas y usuarios:\n${counts}\n\nConexiones Google por clínica:\n${oauth}\n\nMensajes de WhatsApp fallidos (24h):\n${failed}`;
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = 'Eres un asistente técnico interno del sistema BIOSKIN_2.0. Responde ÚNICAMENTE con base en los datos reales listados abajo, en español, breve y directo (máximo 6 líneas). ' +
      'Si la pregunta no se puede responder con estos datos, dilo claramente en vez de inventar.\n\n' +
      `DATOS DEL SISTEMA:\n${context}\n\nPREGUNTA: ${question}`;
    const result = await model.generateContent(prompt);
    return result.response.text().trim().slice(0, 3500) || '⚠️ La IA no devolvió respuesta.';
  } catch (e) {
    return `⚠️ Error consultando IA: ${e.message}`;
  }
}

/** Menú y consultas para el staff interno del sistema (soporte técnico), separado del bot de clínicas. */
async function handleSystemStaffMessage(from, text, normalizedText) {
  const state = systemStateByPhone.get(from);

  if (state?.stage === 'awaitingQuestion') {
    systemStateByPhone.delete(from);
    await sendWhatsAppText(from, await askSystemAI(text));
    return;
  }

  if (normalizedText === '1') {
    await sendWhatsAppText(from, `🛠️ Estado de servicios:\n\n${await getServiceStatusText()}`);
    return;
  }
  if (normalizedText === '2') {
    await sendWhatsAppText(from, await getClinicsUsersSummaryText());
    return;
  }
  if (normalizedText === '3') {
    await sendWhatsAppText(from, `🔗 Conexiones Google por clínica:\n\n${await getOAuthConnectionsText()}`);
    return;
  }
  if (normalizedText === '4') {
    await sendWhatsAppText(from, `⚠️ Mensajes fallidos (24h):\n\n${await getRecentFailedMessagesText()}`);
    return;
  }
  if (normalizedText === '5') {
    systemStateByPhone.set(from, { stage: 'awaitingQuestion' });
    await sendWhatsAppText(from, '🤖 Escribe tu pregunta sobre el estado del sistema.');
    return;
  }

  await sendWhatsAppText(from, SYSTEM_MENU_TEXT);
}

/** Procesa mensajes entrantes: solo responde a números registrados como staff activo (clinic_users.phone). */
async function handleIncomingMessages(body) {
  for (const event of extractMessageStatuses(body)) {
    await updateWhatsAppMessageStatus(event.providerMessageId, event.status, event.errorDetail);
  }

  for (const { from, text, mediaType, providerMessageId, timestamp, name } of extractIncomingMessages(body)) {
    if (!from) continue;
    const audit = await recordWhatsAppMessage({
      phone: from,
      name,
      direction: 'entrante',
      content: text,
      mediaType,
      timestamp,
      status: 'leido',
      providerMessageId,
    });
    if (!audit.rows.length) continue;
    const normalizedText = String(text || '').trim().toLowerCase();
    if (!normalizedText) continue;

    // Staff interno del sistema (soporte técnico) — flujo totalmente separado de clinic_users
    if (getSystemStaffPhones().has(from)) {
      try {
        await handleSystemStaffMessage(from, text, normalizedText);
      } catch (err) {
        console.error('❌ Error en panel de sistema WhatsApp:', err.message);
      }
      continue;
    }

    const staff = await sql`
      SELECT cu.id, cu.clinic_id, cu.full_name, cu.gentilicio, cu.email, cu.phone, cu.whatsapp_staff_phone, cu.finance_scope,
              COALESCE(cf.enabled, true) AND COALESCE(umo.enabled, true) AND COALESCE(vis.enabled, true) AS finance_enabled,
              COALESCE(calendar_feature.enabled, true) AND COALESCE(calendar_override.enabled, true) AS calendar_enabled
      FROM clinic_users cu
            LEFT JOIN clinic_features cf ON cf.clinic_id = cu.clinic_id AND cf.feature = 'finance'
            LEFT JOIN clinic_features calendar_feature ON calendar_feature.clinic_id = cu.clinic_id AND calendar_feature.feature = 'calendar'
            LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'finance'
            LEFT JOIN user_module_overrides vis ON vis.clinic_user_id = cu.id AND vis.feature = 'finanzas_visible'
            LEFT JOIN user_module_overrides calendar_override ON calendar_override.clinic_user_id = cu.id AND calendar_override.feature = 'calendar'
      WHERE cu.is_active = true AND cu.whatsapp_bot_enabled = true
        AND (cu.phone IS NOT NULL OR cu.whatsapp_staff_phone IS NOT NULL)
    `;
    // El bot solo responde a números con whatsapp_bot_enabled = true (autorizado por master_admin)
    const matches = staff.rows.filter(row => normalizeEcuadorPhone(row.whatsapp_staff_phone || row.phone) === from);
    if (matches.length !== 1) continue; // desconocido, ambiguo o bot no habilitado: no se revela información
    const clinicUser = matches[0];
    const state = financeStateByPhone.get(from);
    const agendaDateState = agendaDateStateByPhone.get(from);
    const agendaMenuState = agendaMenuStateByPhone.get(from);
    const rescheduleState = rescheduleStateByPhone.get(from);
    const deleteState = deleteStateByPhone.get(from);
    const financeChoice = resolveFinancePeriodChoice(normalizedText);
    const isAllowedAction = ALLOWED_BOT_ACTIONS.has(normalizedText) || ALLOWED_BOT_ACTIONS.has(text?.trim() || '');
    const hasActiveState = !!(state?.stage || agendaDateState?.stage || agendaMenuState?.stage || rescheduleState?.stage || deleteState?.stage);

    try {
      // ── Reprogramar cita ──────────────────────────────────────────────
      if (rescheduleState?.stage === 'awaitingDate') {
        if (!clinicUser.calendar_enabled) { rescheduleStateByPhone.delete(from); await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        const isoDate = parseFlexibleDate(normalizedText);
        if (!isoDate) { await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${RESCHEDULE_DATE_PROMPT}`); continue; }
        const { error, appointments } = await getAppointmentsForDate(clinicUser.id, isoDate);
        if (error) { rescheduleStateByPhone.delete(from); await sendWhatsAppText(from, error); continue; }
        if (!appointments.length) { rescheduleStateByPhone.delete(from); await sendWhatsAppText(from, 'No hay citas agendadas ese día.'); continue; }
        rescheduleStateByPhone.set(from, { stage: 'awaitingSelection', appointments });
        await sendWhatsAppText(from, `${formatAppointmentSelectionList(appointments)}\n\nResponde con el número de la cita que quieres reprogramar.`);
        continue;
      }
      if (rescheduleState?.stage === 'awaitingSelection') {
        const selected = rescheduleState.appointments[Number(normalizedText) - 1];
        if (!selected) { await sendWhatsAppText(from, 'Número inválido. Responde con el número de la lista.'); continue; }
        rescheduleStateByPhone.set(from, { stage: 'awaitingNewDate', selected });
        await sendWhatsAppText(from, NEW_DATE_PROMPT);
        continue;
      }
      if (rescheduleState?.stage === 'awaitingNewDate') {
        const newIsoDate = parseFlexibleDate(normalizedText);
        if (!newIsoDate) { await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${NEW_DATE_PROMPT}`); continue; }
        rescheduleStateByPhone.set(from, { ...rescheduleState, stage: 'awaitingNewTime', newIsoDate });
        await sendWhatsAppText(from, NEW_TIME_PROMPT);
        continue;
      }
      if (rescheduleState?.stage === 'awaitingNewTime') {
        const time = parseFlexibleTime(normalizedText);
        if (!time) { await sendWhatsAppText(from, `No reconocí esa hora.\n\n${NEW_TIME_PROMPT}`); continue; }
        rescheduleStateByPhone.delete(from);
        try {
          const startDate = await rescheduleAppointment(clinicUser.id, rescheduleState.selected.id, rescheduleState.newIsoDate, time, rescheduleState.selected.durationMs);
          const horaLabel = startDate.toLocaleString('es-ES', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          const link = rescheduleState.selected.link ? `\n\nAvisa al paciente: ${rescheduleState.selected.link}` : '';
          await sendWhatsAppText(from, `✅ Cita de ${rescheduleState.selected.patientName} reprogramada para el ${horaLabel}.${link}`);
        } catch (err) {
          await sendWhatsAppText(from, `❌ No se pudo reprogramar la cita: ${err.message}`);
        }
        continue;
      }

      // ── Eliminar cita ─────────────────────────────────────────────────
      if (deleteState?.stage === 'awaitingDate') {
        if (!clinicUser.calendar_enabled) { deleteStateByPhone.delete(from); await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        const isoDate = parseFlexibleDate(normalizedText);
        if (!isoDate) { await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${DELETE_DATE_PROMPT}`); continue; }
        const { error, appointments } = await getAppointmentsForDate(clinicUser.id, isoDate);
        if (error) { deleteStateByPhone.delete(from); await sendWhatsAppText(from, error); continue; }
        if (!appointments.length) { deleteStateByPhone.delete(from); await sendWhatsAppText(from, 'No hay citas agendadas ese día.'); continue; }
        deleteStateByPhone.set(from, { stage: 'awaitingSelection', appointments });
        await sendWhatsAppText(from, `${formatAppointmentSelectionList(appointments)}\n\nResponde con el número de la cita que quieres eliminar.`);
        continue;
      }
      if (deleteState?.stage === 'awaitingSelection') {
        const selected = deleteState.appointments[Number(normalizedText) - 1];
        if (!selected) { await sendWhatsAppText(from, 'Número inválido. Responde con el número de la lista.'); continue; }
        deleteStateByPhone.set(from, { stage: 'awaitingConfirm', selected });
        await sendWhatsAppText(from, `¿Confirmas eliminar la cita de ${selected.patientName} (${selected.hora || 'hora pendiente'})? Responde "sí" o "no".`);
        continue;
      }
      if (deleteState?.stage === 'awaitingConfirm') {
        if (['si', 'sí', 'confirmar', 'yes'].includes(normalizedText)) {
          const { selected } = deleteState;
          deleteStateByPhone.delete(from);
          try {
            await deleteAppointment(clinicUser.id, selected.id);
            const link = selected.link ? `\n\nAvisa al paciente: ${selected.link}` : '';
            await sendWhatsAppText(from, `✅ Cita de ${selected.patientName} eliminada.${link}`);
          } catch (err) {
            await sendWhatsAppText(from, `❌ No se pudo eliminar la cita: ${err.message}`);
          }
        } else {
          deleteStateByPhone.delete(from);
          await sendWhatsAppText(from, 'Eliminación cancelada.');
        }
        continue;
      }

      if (agendaDateState?.stage === 'awaitingDate') {
        agendaDateStateByPhone.delete(from);
        if (!clinicUser.calendar_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        const isoDate = parseFlexibleDate(normalizedText);
        if (!isoDate) {
          agendaDateStateByPhone.set(from, { stage: 'awaitingDate' });
          await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${AGENDA_DATE_PROMPT}`);
          continue;
        }
        await sendWhatsAppText(from, await listAppointmentsForDate(clinicUser.id, isoDate, 'Citas'));
        continue;
      }

      if (agendaMenuState?.stage === 'menu') {
        if (!clinicUser.calendar_enabled) { agendaMenuStateByPhone.delete(from); await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        if (normalizedText === '1') { agendaMenuStateByPhone.delete(from); await sendWhatsAppText(from, await listTodayAppointments(clinicUser.id)); continue; }
        if (normalizedText === '2') { agendaMenuStateByPhone.delete(from); agendaDateStateByPhone.set(from, { stage: 'awaitingDate' }); await sendWhatsAppText(from, AGENDA_DATE_PROMPT); continue; }
        if (normalizedText === '3') { agendaMenuStateByPhone.delete(from); rescheduleStateByPhone.set(from, { stage: 'awaitingDate' }); await sendWhatsAppText(from, RESCHEDULE_DATE_PROMPT); continue; }
        if (normalizedText === '4') { agendaMenuStateByPhone.delete(from); deleteStateByPhone.set(from, { stage: 'awaitingDate' }); await sendWhatsAppText(from, DELETE_DATE_PROMPT); continue; }
        await sendWhatsAppText(from, `No reconocí esa opción.\n\n${AGENDA_MENU_TEXT}`);
        continue;
      }

      if (state?.stage === 'awaitingFinanceChoice' && financeChoice) {
        financeStateByPhone.delete(from);
        if (!clinicUser.finance_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Finanzas.'); continue; }
        await sendFinanceReportToUser(clinicUser, financeChoice, from);
        continue;
      }

      if (!isAllowedAction && !hasActiveState) {
        await sendWhatsAppText(from, `Hola ${clinicUser.full_name || ''} 👋\n\n${MENU_TEXT}`);
        continue;
      }

      if (normalizedText === '2' || normalizedText === 'reporte' || normalizedText === 'finance') {
        if (!clinicUser.finance_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Finanzas.'); continue; }
        financeStateByPhone.set(from, { stage: 'awaitingFinanceChoice', clinicId: clinicUser.clinic_id });
        await sendWhatsAppText(from, FINANCE_REPORT_MENU_TEXT);
        continue;
      }

      if (normalizedText === '1' || normalizedText === 'agenda') {
        if (!clinicUser.calendar_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        agendaMenuStateByPhone.set(from, { stage: 'menu' });
        await sendWhatsAppText(from, AGENDA_MENU_TEXT);
        continue;
      }

      if (financeChoice) {
        if (!clinicUser.finance_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Finanzas.'); continue; }
        await sendFinanceReportToUser(clinicUser, financeChoice, from);
        continue;
      }

      await sendWhatsAppText(from, `Hola ${clinicUser.full_name || ''} 👋\n\n${MENU_TEXT}`);
    } catch (err) {
      console.error('❌ Error respondiendo por WhatsApp:', err.message);
    }
  }
}

/** Envía a cada usuario autorizado un resumen de citas con enlaces para recordar manualmente. */
async function sendAppointmentSummaries(dayOffset = 0, slot = 'morning') {
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + dayOffset);
  const targetDate = baseDate.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const timeMin = `${targetDate}T00:00:00-05:00`;
  const timeMax = `${targetDate}T23:59:59-05:00`;

  // Opt-in por usuario (habilitado por master_admin) y por horario elegido (7am/7pm), no por clínica
  const summaryColumn = slot === 'evening' ? 'whatsapp_summary_7pm' : 'whatsapp_summary_7am';
  const users = summaryColumn === 'whatsapp_summary_7pm' ? await sql`
    SELECT cs.clinic_id, cs.general, cs.email, cu.id AS user_id,
           COALESCE(NULLIF(cu.whatsapp_staff_phone, ''), cu.phone) AS staff_phone, cu.full_name AS staff_name
    FROM clinic_oauth_tokens t
    JOIN clinic_users cu ON cu.id = t.clinic_user_id AND cu.is_active = true
      AND cu.whatsapp_bot_enabled = true AND cu.whatsapp_summary_7pm = true
      AND (NULLIF(cu.phone, '') IS NOT NULL OR NULLIF(cu.whatsapp_staff_phone, '') IS NOT NULL)
    JOIN clinic_settings cs ON cs.clinic_id = cu.clinic_id
    LEFT JOIN clinic_features cf ON cf.clinic_id = cu.clinic_id AND cf.feature = 'calendar'
    LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'calendar'
    WHERE COALESCE(cf.enabled, true) = true AND COALESCE(umo.enabled, true) = true
  ` : await sql`
    SELECT cs.clinic_id, cs.general, cs.email, cu.id AS user_id,
           COALESCE(NULLIF(cu.whatsapp_staff_phone, ''), cu.phone) AS staff_phone, cu.full_name AS staff_name
    FROM clinic_oauth_tokens t
    JOIN clinic_users cu ON cu.id = t.clinic_user_id AND cu.is_active = true
      AND cu.whatsapp_bot_enabled = true AND cu.whatsapp_summary_7am = true
      AND (NULLIF(cu.phone, '') IS NOT NULL OR NULLIF(cu.whatsapp_staff_phone, '') IS NOT NULL)
    JOIN clinic_settings cs ON cs.clinic_id = cu.clinic_id
    LEFT JOIN clinic_features cf ON cf.clinic_id = cu.clinic_id AND cf.feature = 'calendar'
    LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'calendar'
    WHERE COALESCE(cf.enabled, true) = true AND COALESCE(umo.enabled, true) = true
  `;

  let remindersSent = 0;
  const errors = [];
  for (const row of users.rows) {
    const clinicName = row.general?.name || 'la clínica';
    try {
      const auth = await getUserOAuth2Client(row.user_id);
      if (!auth) continue;
      const calendar = google.calendar({ version: 'v3', auth });
      const { data } = await calendar.events.list({
        calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
      });

      const appointments = [];
      for (const event of data.items || []) {
        const appointment = parseAppointmentEvent(event);
        if (!appointment) continue;
        const start = new Date(event.start?.dateTime || event.start?.date);
        const hora = event.start?.dateTime
          ? start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Guayaquil' })
          : '';
        const patientMessage = `Hola ${appointment.patientName}, te escribimos de ${clinicName}. ` +
          `Te recordamos tu cita para el ${targetDate}${hora ? ` a las ${hora}` : ''}. ` +
          'Por favor confirma tu asistencia respondiendo a este mensaje o comunícate con la clínica.';
        // Enlace abre WhatsApp del staff con el chat del PACIENTE, no del número de la clínica
        const link = appointment.phone ? `https://wa.me/${appointment.phone}?text=${encodeURIComponent(patientMessage)}` : '';
        appointments.push({ ...appointment, hora, link });
      }
      if (!appointments.length) continue;

      const label = dayOffset === 0 ? 'hoy' : 'mañana';
      const lines = appointments.map((appointment, index) => {
        const professional = appointment.professional ? `\nProfesional: ${appointment.professional}` : '';
        const link = appointment.link ? `\nEnviar recordatorio: ${appointment.link}` : '\nSin teléfono de paciente registrado — no se puede generar el enlace.';
        return `${index + 1}. ${appointment.hora || 'Hora pendiente'} — ${appointment.patientName}${professional}${link}`;
      });
      const summary = `Hola ${row.staff_name || 'equipo'}, este es el resumen de citas de ${clinicName} de ${label} (${targetDate}):\n\n${lines.join('\n\n')}` +
        '\n\nResponde 1 para Agenda o 2 para Reporte financiero.';
      const staffPhone = normalizeEcuadorPhone(row.staff_phone);
      try {
        // El staff no necesariamente escribió hoy: fuera de la ventana de 24h se requiere plantilla aprobada
        const withinWindow = await isWithinCustomerServiceWindow(staffPhone);
        const templateName = (process.env.WHATSAPP_TEMPLATE_DAILY_SUMMARY || '').trim();
        const templateLang = (process.env.WHATSAPP_TEMPLATE_DAILY_SUMMARY_LANG || 'es_MX').trim();
        if (withinWindow) {
          await sendWhatsAppText(staffPhone, summary);
        } else if (templateName) {
          // Meta rechaza parámetros de plantilla con saltos de línea; se aplana a una sola línea
          const summaryFlat = summary.replace(/\s*\n+\s*/g, ' · ').trim();
          await sendWhatsAppTemplate(staffPhone, templateName, templateLang, {
            nombre_usuario: row.staff_name || 'equipo',
            nombre_clinica: clinicName,
            fecha: targetDate,
            resumen: summaryFlat,
          });
        } else {
          throw new Error('Fuera de ventana de 24h y no hay WHATSAPP_TEMPLATE_DAILY_SUMMARY configurada');
        }
        remindersSent++;
      } catch (sendErr) {
        errors.push(`user ${row.user_id}, staff ${staffPhone}: ${sendErr.message}`);
      }
    } catch (clinicErr) {
      errors.push(`clinic ${row.clinic_id}: ${clinicErr.message}`);
    }
  }

  return { usersChecked: users.rows.length, remindersSent, errors };
}

export default async function handler(req, res) {
  const action = getQueryValue(req.query?.action);

  if (req.method === 'GET' && (action === 'crmContacts' || action === 'crmMessages')) {
    const user = await requireAuth(req, res);
    if (!user || !requireRole(user, res, 'master_admin')) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const data = action === 'crmContacts'
        ? await listWhatsAppContacts(getQueryValue(req.query?.search), getQueryValue(req.query?.limit))
        : await listWhatsAppMessages(getQueryValue(req.query?.contactId), getQueryValue(req.query?.limit));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      const status = error.message === 'Contacto inválido' ? 400 : 500;
      console.error('Error consultando CRM de WhatsApp:', error.message);
      return res.status(status).json({ success: false, error: status === 400 ? error.message : 'No se pudo consultar el historial' });
    }
  }

  if (req.method === 'GET' && getQueryValue(req.query?.action) === 'sendReminders') {
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }
    try {
      const slot = getQueryValue(req.query?.slot);
      const result = await sendAppointmentSummaries(slot === 'evening' ? 1 : 0, slot === 'evening' ? 'evening' : 'morning');
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('❌ Error en recordatorios WhatsApp:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  if (req.method === 'GET') {
    const challenge = verifyWhatsAppWebhook(req.query);
    return challenge === null ? res.status(403).send('Forbidden') : res.status(200).send(challenge);
  }

  if (req.method === 'POST') {
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false });
    }
    if (!verifyWhatsAppSignature(req.headers['x-hub-signature-256'], rawBody)) {
      return res.status(401).json({ success: false });
    }
    let body;
    try { body = JSON.parse(rawBody.toString('utf8')); }
    catch { return res.status(400).json({ success: false }); }
    if (body?.object && body.object !== 'whatsapp_business_account') {
      return res.status(400).json({ success: false });
    }

    try {
      await handleIncomingMessages(body);
    } catch (err) {
      console.error('❌ Error procesando mensaje WhatsApp:', err.message);
      return res.status(500).json({ success: false });
    }
    return res.status(200).send('EVENT_RECEIVED');
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ success: false, message: 'Método no permitido' });
}