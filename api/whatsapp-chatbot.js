import crypto from 'crypto';
import { google } from 'googleapis';
import { sql } from '@vercel/postgres';
import { sendWhatsAppText } from '../lib/whatsapp-service.js';
import { buildFinanceCsv } from '../lib/finance-csv.js';

const getQueryValue = (value) => Array.isArray(value) ? value[0] : value;

export function verifyWhatsAppWebhook(query, verifyToken = process.env.WHATSAPP_VERIFY_TOKEN) {
  const mode = getQueryValue(query?.['hub.mode']);
  const token = getQueryValue(query?.['hub.verify_token']);
  const challenge = getQueryValue(query?.['hub.challenge']);

  if (mode !== 'subscribe' || !verifyToken || token !== verifyToken || challenge === undefined) {
    return null;
  }

  return String(challenge);
}

/** OAuth2 client con los tokens de Google guardados para la clínica. Retorna null si no hay conexión. */
async function getClinicOAuth2Client(clinicId) {
  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const r = await sql`SELECT access_token, refresh_token, token_expiry FROM clinic_oauth_tokens WHERE clinic_id = ${clinicId}`;
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

/** Extrae mensajes entrantes { from, text } del payload del webhook de WhatsApp Cloud API. */
export function extractIncomingMessages(body) {
  const messages = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const msg of change?.value?.messages || []) {
        if (!msg?.from) continue;
        messages.push({ from: normalizeEcuadorPhone(msg.from), text: (msg.text?.body || '').trim() });
      }
    }
  }
  return messages;
}

/** Lista en texto plano las citas de hoy de la clínica, para responder al staff autorizado. */
async function listTodayAppointments(clinicId) {
  const auth = await getClinicOAuth2Client(clinicId);
  if (!auth) return 'No hay Google Calendar conectado para tu clínica.';
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

async function getClinicGmailClient(clinicId) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const r = await sql`SELECT access_token, refresh_token, token_expiry, email FROM clinic_oauth_tokens WHERE clinic_id = ${clinicId}`;
  if (!r.rows.length) return null;
  const { access_token, refresh_token, token_expiry, email } = r.rows[0];
  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, `${appUrl}/api/calendar`);
  oAuth2.setCredentials({ access_token, refresh_token, expiry_date: token_expiry ? new Date(token_expiry).getTime() : null });
  return { client: oAuth2, email };
}

async function sendFinanceReportToAdmin(clinicId, period, from) {
  const settingsRes = await sql`SELECT finanzas, general FROM clinic_settings WHERE clinic_id = ${clinicId}`;
  const row = settingsRes.rows[0] || {};
  const finanzas = row.finanzas || {};
  const clinicName = row.general?.name || 'la clínica';
  const adminEmail = (finanzas.admin_email || '').trim();
  if (!adminEmail) {
    await sendWhatsAppText(from, '⚠️ Aún no está configurado el correo del administrador financiero de la clínica.');
    return;
  }

  const oauth = await getClinicGmailClient(clinicId);
  if (!oauth) {
    await sendWhatsAppText(from, '⚠️ No hay una cuenta de Gmail conectada para enviar el reporte financiero.');
    return;
  }

  const range = buildFinanceRange(period);
  if (!range) {
    await sendWhatsAppText(from, '❌ Período no válido para el reporte financiero.');
    return;
  }

  const recordsRes = await sql`
    SELECT *
    FROM financial_records
    WHERE clinic_id = ${clinicId}
      AND date >= ${range.startDate}
      AND date <= ${range.endDate}
    ORDER BY date ASC
  `;

  const csv = buildFinanceCsv(recordsRes.rows);
  const gmail = google.gmail({ version: 'v1', auth: oauth.client });
  const raw = buildRawEmailWithCsvAttachment({
    from: `${clinicName} <${oauth.email}>`,
    to: adminEmail,
    subject: `Reporte financiero (${range.periodLabel}) — ${clinicName}`,
    html: `<p>Adjunto el reporte financiero de <strong>${clinicName}</strong> (${range.periodLabel}, ${range.startDate} a ${range.endDate}).</p><p>Registros incluidos: ${recordsRes.rows.length}</p>`,
    attachmentName: `finanzas_${range.startDate}_${range.endDate}.csv`,
    attachmentContent: csv,
  });

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  await sendWhatsAppText(from, `✅ Reporte financiero ${range.periodLabel} enviado al correo ${adminEmail} (${recordsRes.rows.length} registros).`);
}

/** Procesa mensajes entrantes: solo responde a números registrados como staff activo (clinic_users.phone). */
async function handleIncomingMessages(body) {
  for (const { from, text } of extractIncomingMessages(body)) {
    if (!from) continue;
    const normalizedText = String(text || '').trim().toLowerCase();
    if (!normalizedText) continue;
    const staff = await sql`SELECT id, clinic_id, full_name, phone FROM clinic_users WHERE phone = ${from} AND is_active = true LIMIT 1`;
    if (!staff.rows.length) continue; // número no reconocido — se ignora sin responder, no se revela nada
    const clinicUser = staff.rows[0];
    const state = financeStateByPhone.get(from);
    const financeChoice = resolveFinancePeriodChoice(normalizedText);
    const isAllowedAction = ALLOWED_BOT_ACTIONS.has(normalizedText) || ALLOWED_BOT_ACTIONS.has(text?.trim() || '');

    try {
      if (state?.stage === 'awaitingFinanceChoice' && financeChoice) {
        financeStateByPhone.delete(from);
        await sendFinanceReportToAdmin(clinicUser.clinic_id, financeChoice, from);
        continue;
      }

      if (!isAllowedAction && !state?.stage) {
        await sendWhatsAppText(from, `Hola ${clinicUser.full_name || ''} 👋\n\n${MENU_TEXT}`);
        continue;
      }

      if (text === '2' || normalizedText === 'reporte' || normalizedText === 'finance') {
        financeStateByPhone.set(from, { stage: 'awaitingFinanceChoice', clinicId: clinicUser.clinic_id });
        await sendWhatsAppText(from, FINANCE_REPORT_MENU_TEXT);
        continue;
      }

      if (text === '1') {
        await sendWhatsAppText(from, await listTodayAppointments(clinicUser.clinic_id));
        continue;
      }

      if (financeChoice) {
        await sendFinanceReportToAdmin(clinicUser.clinic_id, financeChoice, from);
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

  const clinics = await sql`
    SELECT cs.clinic_id, cs.general, cs.email, cu.phone AS staff_phone, cu.full_name AS staff_name
    FROM clinic_settings cs
    JOIN clinic_oauth_tokens t ON t.clinic_id = cs.clinic_id
    JOIN clinic_users cu ON cu.clinic_id = cs.clinic_id AND cu.is_active = true AND NULLIF(cu.phone, '') IS NOT NULL
    WHERE (cs.agenda->>'daily_reminder_whatsapp')::boolean IS TRUE
  `;

  let remindersSent = 0;
  const errors = [];
  const groupedClinics = new Map();
  for (const row of clinics.rows) {
    if (!groupedClinics.has(row.clinic_id)) groupedClinics.set(row.clinic_id, { ...row, staff: [] });
    groupedClinics.get(row.clinic_id).staff.push({ phone: normalizeEcuadorPhone(row.staff_phone), name: row.staff_name || 'equipo' });
  }

  for (const row of groupedClinics.values()) {
    const clinicName = row.general?.name || 'la clínica';
    const clinicNumber = normalizeEcuadorPhone(row.email?.whatsapp_number || row.general?.phone || '');
    try {
      const auth = await getClinicOAuth2Client(row.clinic_id);
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
        const link = clinicNumber ? `https://wa.me/${clinicNumber}?text=${encodeURIComponent(patientMessage)}` : '';
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
      for (const staff of row.staff) {
        try {
          await sendWhatsAppText(staff.phone, summary);
          remindersSent++;
        } catch (sendErr) {
          errors.push(`clinic ${row.clinic_id}, staff ${staff.phone}: ${sendErr.message}`);
        }
      }
    } catch (clinicErr) {
      errors.push(`clinic ${row.clinic_id}: ${clinicErr.message}`);
    }
  }

  return { clinicsChecked: clinics.rows.length, remindersSent, errors };
}

export default async function handler(req, res) {
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
    if (req.body?.object && req.body.object !== 'whatsapp_business_account') {
      return res.status(400).json({ success: false });
    }

    try {
      await handleIncomingMessages(req.body);
    } catch (err) {
      console.error('❌ Error procesando mensaje WhatsApp:', err.message);
    }
    return res.status(200).send('EVENT_RECEIVED');
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ success: false, message: 'Método no permitido' });
}