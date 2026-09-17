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
  const phoneMatch = event.description?.match(/Teléfono:\s*([\d+\-\s]+)/);
  if (!phoneMatch) return null;
  const phone = normalizeEcuadorPhone(phoneMatch[1]);
  if (!phone) return null;
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
        const text = (msg.text?.body || msg.image?.caption || (mediaType === 'imagen' ? '[Imagen]' : mediaType === 'audio' ? '[Audio]' : '')).trim();
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
  const auth = await getUserOAuth2Client(userId);
  if (!auth) return 'No tienes Google Calendar conectado a tu cuenta.';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.events.list({
    calendarId: 'primary', timeMin: `${today}T00:00:00-05:00`, timeMax: `${today}T23:59:59-05:00`,
    singleEvents: true, orderBy: 'startTime',
  });
  const appointments = (data.items || []).filter(e => e.summary?.startsWith('Cita: '));
  if (!appointments.length) return 'No tienes citas agendadas para hoy.';
  const lines = appointments.map(e => {
    const start = new Date(e.start?.dateTime || e.start?.date);
    const hora = e.start?.dateTime
      ? start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Guayaquil' })
      : '';
    const name = e.summary.substring(6).split(' - ')[0];
    return `• ${hora} — ${name}`;
  });
  return `📅 Citas de hoy:\n\n${lines.join('\n')}`;
}

const MENU_TEXT = '1) Consultar mis citas de hoy\n2) Reporte financiero\n\nResponde con el número de la opción.';
const FINANCE_REPORT_MENU_TEXT = '📊 Reporte financiero\n\n1) Diario\n2) Semanal\n3) Mensual\n\nResponde con el número o la palabra del período.';
const financeStateByPhone = new Map();
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
    const staff = await sql`
      SELECT cu.id, cu.clinic_id, cu.full_name, cu.email, cu.phone, cu.finance_scope,
              COALESCE(cf.enabled, true) AND COALESCE(umo.enabled, true) AND COALESCE(vis.enabled, true) AS finance_enabled,
              COALESCE(calendar_feature.enabled, true) AND COALESCE(calendar_override.enabled, true) AS calendar_enabled
      FROM clinic_users cu
            LEFT JOIN clinic_features cf ON cf.clinic_id = cu.clinic_id AND cf.feature = 'finance'
            LEFT JOIN clinic_features calendar_feature ON calendar_feature.clinic_id = cu.clinic_id AND calendar_feature.feature = 'calendar'
            LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'finance'
            LEFT JOIN user_module_overrides vis ON vis.clinic_user_id = cu.id AND vis.feature = 'finanzas_visible'
            LEFT JOIN user_module_overrides calendar_override ON calendar_override.clinic_user_id = cu.id AND calendar_override.feature = 'calendar'
      WHERE cu.phone IS NOT NULL AND cu.is_active = true
    `;
    const matches = staff.rows.filter(row => normalizeEcuadorPhone(row.phone) === from);
    if (matches.length !== 1) continue; // desconocido o ambiguo: no se revela información
    const clinicUser = matches[0];
    const state = financeStateByPhone.get(from);
    const financeChoice = resolveFinancePeriodChoice(normalizedText);
    const isAllowedAction = ALLOWED_BOT_ACTIONS.has(normalizedText) || ALLOWED_BOT_ACTIONS.has(text?.trim() || '');

    try {
      if (state?.stage === 'awaitingFinanceChoice' && financeChoice) {
        financeStateByPhone.delete(from);
        if (!clinicUser.finance_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Finanzas.'); continue; }
        await sendFinanceReportToUser(clinicUser, financeChoice, from);
        continue;
      }

      if (!isAllowedAction && !state?.stage) {
        await sendWhatsAppText(from, `Hola ${clinicUser.full_name || ''} 👋\n\n${MENU_TEXT}`);
        continue;
      }

      if (text === '2' || normalizedText === 'reporte' || normalizedText === 'finance') {
        if (!clinicUser.finance_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Finanzas.'); continue; }
        financeStateByPhone.set(from, { stage: 'awaitingFinanceChoice', clinicId: clinicUser.clinic_id });
        await sendWhatsAppText(from, FINANCE_REPORT_MENU_TEXT);
        continue;
      }

      if (text === '1') {
        if (!clinicUser.calendar_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        await sendWhatsAppText(from, await listTodayAppointments(clinicUser.id));
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
async function sendAppointmentSummaries(dayOffset = 0) {
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + dayOffset);
  const targetDate = baseDate.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const timeMin = `${targetDate}T00:00:00-05:00`;
  const timeMax = `${targetDate}T23:59:59-05:00`;

  const users = await sql`
    SELECT cs.clinic_id, cs.general, cs.email, cu.id AS user_id,
           cu.phone AS staff_phone, cu.full_name AS staff_name
    FROM clinic_oauth_tokens t
    JOIN clinic_users cu ON cu.id = t.clinic_user_id AND cu.is_active = true AND NULLIF(cu.phone, '') IS NOT NULL
    JOIN clinic_settings cs ON cs.clinic_id = cu.clinic_id
    LEFT JOIN clinic_features cf ON cf.clinic_id = cu.clinic_id AND cf.feature = 'calendar'
    LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'calendar'
    WHERE (cs.agenda->>'daily_reminder_whatsapp')::boolean IS TRUE
      AND COALESCE(cf.enabled, true) = true
      AND COALESCE(umo.enabled, true) = true
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
        const link = appointment.link ? `\nEnviar recordatorio: ${appointment.link}` : '\nConfigura el WhatsApp de la clínica para habilitar el enlace.';
        return `${index + 1}. ${appointment.hora || 'Hora pendiente'} — ${appointment.patientName}${professional}${link}`;
      });
      const summary = `📅 ${clinicName}: citas de ${label} (${targetDate})\n\n${lines.join('\n\n')}` +
        '\n\nResponde 1 para consultar citas de hoy o 2 para reportes financieros.';
      const staffPhone = normalizeEcuadorPhone(row.staff_phone);
      try {
        // El staff no necesariamente escribió hoy: fuera de la ventana de 24h se requiere plantilla aprobada
        const withinWindow = await isWithinCustomerServiceWindow(staffPhone);
        const templateName = (process.env.WHATSAPP_TEMPLATE_DAILY_SUMMARY || '').trim();
        const templateLang = (process.env.WHATSAPP_TEMPLATE_DAILY_SUMMARY_LANG || 'es_MX').trim();
        if (withinWindow) {
          await sendWhatsAppText(staffPhone, summary);
        } else if (templateName) {
          await sendWhatsAppTemplate(staffPhone, templateName, templateLang, [summary]);
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
      const result = await sendAppointmentSummaries(slot === 'evening' ? 1 : 0);
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