import { google } from 'googleapis';
import { sql } from '@vercel/postgres';
import { sendWhatsAppText } from '../lib/whatsapp-service.js';

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
  return { phone, patientName };
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

const MENU_TEXT = '1) Consultar mis citas de hoy\n\nResponde con el número de la opción.';

/** Procesa mensajes entrantes: solo responde a números registrados como staff activo (clinic_users.phone). */
async function handleIncomingMessages(body) {
  for (const { from, text } of extractIncomingMessages(body)) {
    if (!from) continue;
    const staff = await sql`SELECT id, clinic_id, full_name FROM clinic_users WHERE phone = ${from} AND is_active = true LIMIT 1`;
    if (!staff.rows.length) continue; // número no reconocido — se ignora sin responder, no se revela nada
    const clinicUser = staff.rows[0];
    try {
      if (text === '1') {
        await sendWhatsAppText(from, await listTodayAppointments(clinicUser.clinic_id));
      } else {
        await sendWhatsAppText(from, `Hola ${clinicUser.full_name || ''} 👋\n\n${MENU_TEXT}`);
      }
    } catch (err) {
      console.error('❌ Error respondiendo por WhatsApp:', err.message);
    }
  }
}

/** Envía el recordatorio diario de citas por WhatsApp a las clínicas que lo activaron en Agenda. */
async function sendDailyReminders() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const timeMin = `${today}T00:00:00-05:00`;
  const timeMax = `${today}T23:59:59-05:00`;

  const clinics = await sql`
    SELECT cs.clinic_id, cs.general
    FROM clinic_settings cs
    JOIN clinic_oauth_tokens t ON t.clinic_id = cs.clinic_id
    WHERE (cs.agenda->>'daily_reminder_whatsapp')::boolean IS TRUE
  `;

  let remindersSent = 0;
  const errors = [];

  for (const row of clinics.rows) {
    const clinicName = row.general?.name || 'la clínica';
    try {
      const auth = await getClinicOAuth2Client(row.clinic_id);
      if (!auth) continue;
      const calendar = google.calendar({ version: 'v3', auth });
      const { data } = await calendar.events.list({
        calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
      });

      for (const event of data.items || []) {
        const appointment = parseAppointmentEvent(event);
        if (!appointment) continue;
        const start = new Date(event.start?.dateTime || event.start?.date);
        const hora = event.start?.dateTime
          ? start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Guayaquil' })
          : '';
        const message = `Hola ${appointment.patientName} 👋, te saludamos de ${clinicName}.\n\n` +
          `Te recordamos tu cita agendada para hoy${hora ? ` a las ${hora}` : ''}.\n\n` +
          `¡Te esperamos!`;
        try {
          await sendWhatsAppText(appointment.phone, message);
          remindersSent++;
        } catch (sendErr) {
          errors.push(`clinic ${row.clinic_id}: ${sendErr.message}`);
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
      const result = await sendDailyReminders();
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