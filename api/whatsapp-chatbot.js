import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { sql } from '@vercel/postgres';
import { buildAppointmentSystemNote, resolvePatientReminderContactPhone, sendWhatsAppText, sendWhatsAppTemplate } from '../lib/whatsapp-service.js';
import { buildFinanceCsv } from '../lib/finance-csv.js';
import { requireAuth, requireRole } from '../lib/admin-auth.js';
import { getPool } from '../lib/neon-clinical-db.js';
import { loadSubscriptionLifecycle } from '../lib/subscription-lifecycle.js';
import { lockClinicWriters, unlockClinicWriters } from '../lib/clinic-lifecycle.js';
import {
  listWhatsAppContacts,
  listWhatsAppMessages,
  recordWhatsAppMessage,
  isWithinCustomerServiceWindow,
  updateWhatsAppMessageStatus,
  isSystemStaffPhone,
  setWhatsAppContactClinic,
  claimMessageStatusNotification,
  getContactById,
  ensureWhatsAppContactClinic,
  getRecentAppointmentNotificationContext,
  hasRecentAppointmentSystemReply,
  getPendingAppointmentReplyContext,
  setAppointmentReplyStatus,
  clearAppointmentReplyStatus,
  getAppointmentReplyStatuses,
  getAppointmentDeliveryStatuses,
} from '../lib/whatsapp-crm.js';
import { getBotState, setBotState, clearBotState } from '../lib/whatsapp-bot-state.js';
import { createShortWaLink, resolveShortWaLink } from '../lib/wa-short-link.js';
import { ownerResourceId, eventResourceId, resourceExtendedProperties } from '../lib/agenda-resources.js';

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

/** Extrae teléfono, correo y nombre de paciente del evento de Google Calendar, igual que CalendarManager.tsx. */
export function parseAppointmentEvent(event) {
  if (!event.summary?.startsWith('Cita: ')) return null;
  // Sin teléfono la cita igual debe listarse; solo se omite el link de recordatorio manual
  const phoneMatch = event.description?.match(/Teléfono:\s*([\d+\-\s]+)/);
  const phone = phoneMatch ? normalizeEcuadorPhone(phoneMatch[1]) : '';
  const summaryParts = event.summary.substring(6).split(' - ');
  const patientName = summaryParts[0]?.trim() || 'Paciente';
  // El agendamiento del panel guarda el correo en el título (`Cita: Nombre - correo`); el del bot, en la descripción.
  const emailFromSummary = summaryParts.slice(1).find(part => part.includes('@'))?.trim() || '';
  const email = (event.description?.match(/Correo:\s*(\S+@\S+)/)?.[1] || emailFromSummary).trim();
  const professional = event.description?.match(/Profesional:\s*([^\n]+)/)?.[1]?.trim() || '';
  const service = event.description?.match(/Servicio:\s*([^\n]+)/)?.[1]?.trim() || '';
  const resource = event.description?.match(/Recurso:\s*([^\n]+)/)?.[1]?.trim() || '';
  return { phone, email, patientName, professional, service, resource };
}

function formatLocalDateKey(date, timeZone = 'America/Guayaquil') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function shouldSendAppointmentReminder(event, now = new Date()) {
  if (!event?.summary?.startsWith('Cita: ')) return false;
  const parsed = parseAppointmentEvent(event);
  if (!parsed?.phone) return false;
  const start = event?.start?.dateTime ? new Date(event.start.dateTime) : event?.start?.date ? new Date(`${event.start.date}T12:00:00-05:00`) : null;
  if (!start || !Number.isFinite(start.getTime())) return false;
  const diffHours = (start.getTime() - now.getTime()) / (60 * 60 * 1000);
  if (diffHours < 12 || diffHours > 36) return false;
  const sentDateKey = String(event?.extendedProperties?.private?.bioskinReminderSent || '').trim();
  const currentDateKey = formatLocalDateKey(start);
  return sentDateKey !== currentDateKey;
}

export function formatWhatsAppLabel(value, fallback = '') {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(normalized || fallback).slice(0, 150).join('');
}

export function buildPatientReminderMessage({ patientName, clinicName, dateLabel, professionalName }) {
  const patient = formatWhatsAppLabel(patientName, 'Paciente');
  const clinic = formatWhatsAppLabel(clinicName, 'la clínica');
  const date = formatWhatsAppLabel(dateLabel, 'fecha acordada');
  const professional = formatWhatsAppLabel(professionalName);
  const professionalLine = professional ? `\n👤 ${professional}` : '';
  return `Hola ${patient} 👋\n\n*Recordatorio de cita*\n📍 ${clinic}${professionalLine}\n📅 ${date}\n\n*Elige una opción:*\n✅ *CONFIRMAR* — asistiré\n🔄 *CAMBIAR* — necesito otra fecha`;
}


/** Quita tildes y mayúsculas: el teclado del móvil autocorrige “menu” → “Menú” y rompía los comandos globales. */
export function normalizeCommandText(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function classifyAppointmentReply(text, buttonPayload = '') {
  // El botón de la plantilla es una señal explícita: no se reinterpreta con heurísticas de texto.
  if (String(buttonPayload || '').startsWith('appointment_confirm')) return 'confirmed';
  const value = normalizeCommandText(`${buttonPayload} ${text}`).replace(/[^a-z0-9_:\s]/g, ' ');
  // El rechazo se evalúa PRIMERO: “no voy a poder confirmar” contenía “confirmar” y se
  // registraba como asistencia confirmada.
  if (/\b(no|nel|cancelar|cancelo|cancela|cancelada|cancelado|anular|reprogramar|reprogramacion|cambiar|mover|posponer|otro dia|otra fecha|tarde|atrasar|imposible)\b/.test(value)) return 'needs_contact';
  if (/\b(confirmo|confirmar|confirmada|confirmado|confirmamos|asistire|ahi estare|si|sip|claro|listo|ok|okay|dale|perfecto|de acuerdo)\b/.test(value)) return 'confirmed';
  return 'needs_contact';
}

export function isExplicitAppointmentChangeRequest(text, buttonPayload = '') {
  const value = normalizeCommandText(`${buttonPayload} ${text}`).replace(/[^a-z0-9_:\s]/g, ' ');
  return /\b(no|nel|cancelar|cancelacion|cancelo|cancela|cancelada|cancelado|anular|reprogramar|reprogramacion|cambiar|cambio|mover|posponer|otro dia|otra fecha|tarde|atrasar|imposible)\b/.test(value);
}

export function formatAppointmentReplyStatus(status) {
  if (status === 'confirmed') return '✅ Confirmada';
  if (status === 'needs_contact') return '🔴 Requiere contacto';
  return '⏳ Sin respuesta';
}

export function formatAppointmentSummaryStatus(replyStatus, deliveryStatus) {
  return deliveryStatus === 'fallido'
    ? '⚠️ Recordatorio no entregado'
    : formatAppointmentReplyStatus(replyStatus);
}

export function shouldNotifyStaffOfAppointmentReply(intent) {
  return intent === 'needs_contact';
}

export function paginateAppointmentSummaryLines(lines, pageSize) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 4;
  return Array.from({ length: Math.ceil(safeLines.length / safePageSize) }, (_, page) =>
    safeLines.slice(page * safePageSize, page * safePageSize + safePageSize));
}

function normalizeContactPhone(value) {
  return normalizeEcuadorPhone(value);
}

export function buildClinicContactMessage({ clinicName, contactLink, professionalName }) {
  const clinic = formatWhatsAppLabel(clinicName, 'la clínica');
  const professional = formatWhatsAppLabel(professionalName, clinic);
  return contactLink
    ? `Para cambiar o consultar tu cita, escribe directamente a *${professional}*:\n${contactLink}`
    : `Para cambiar o consultar tu cita, comunícate con *${professional}* por sus canales habituales.`;
}

async function notifyStaffOfPatientReply(appointment, patientText, intent) {
  if (!shouldNotifyStaffOfAppointmentReply(intent)) return 'summary';
  const patient = appointment.patient_name || 'El paciente';
  const appointmentDate = appointment.appointment_start
    ? new Date(appointment.appointment_start).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'short' })
    : 'la cita programada';
  const header = `🔴 *${patient} necesita que lo contactes*`;
  const footer = 'NO confirmó la cita. Comunícate con el paciente para reprogramar o aclarar.';
  const message = `${header}

Cita: ${appointmentDate}
Respondió: “${patientText || 'Confirmar asistencia (botón)'}”

${footer}

_Aviso automático del chatbot._`;
  const staffPhone = normalizeContactPhone(appointment.professional_phone);
  if (isSystemStaffPhone(staffPhone)) return 'none';
  if (staffPhone && await isWithinCustomerServiceWindow(staffPhone)) {
    await sendWhatsAppText(staffPhone, message, { clinicId: appointment.clinic_id });
    return 'whatsapp';
  }
  if (appointment.professional_email && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: appointment.professional_email,
      subject: `Respuesta de ${patient} sobre su cita`,
      text: `${message}\nClínica: ${appointment.clinic_name}`,
    });
    return 'email';
  }
  return 'none';
}

async function handlePatientAppointmentReply({ from, text, buttonPayload }) {
  const eventId = String(buttonPayload || '').startsWith('appointment_confirm:')
    ? String(buttonPayload).substring('appointment_confirm:'.length)
    : null;
  const appointment = await getPendingAppointmentReplyContext(from, eventId);
  if (!appointment) return false;
  if (!(await loadSubscriptionLifecycle(getPool(), appointment.clinic_id)).canoperate) return true;

  if (!eventId && appointment.appointment_reply_status === 'confirmed' && !isExplicitAppointmentChangeRequest(text, buttonPayload)) {
    return true;
  }
  const intent = classifyAppointmentReply(text, buttonPayload);
  const persisted = await setAppointmentReplyStatus(from, appointment.appointment_event_id, intent, appointment.booked_by_user_id);
  if (!persisted) {
    console.error('❌ No se actualizó el estado de la cita; se omite cualquier confirmación al paciente', appointment.appointment_event_id);
    return true;
  }
  if (intent === 'confirmed') {
    await sendWhatsAppText(from, `✅ Gracias. Hemos registrado tu confirmación para la cita del ${new Date(appointment.appointment_start).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'short' })}.`, { clinicId: appointment.clinic_id });
  } else {
    await notifyStaffOfPatientReply(appointment, text, intent).catch(error => {
      console.error('❌ No se pudo avisar al profesional sobre el cambio de cita:', error.message);
    });
    const contactPhone = resolvePatientReminderContactPhone({
      clinicPhone: appointment.clinic_phone,
      patientPhone: from,
    });
    const contactLink = contactPhone
      ? await createShortWaLink(contactPhone, `Hola, necesito comunicarme sobre mi cita del ${new Date(appointment.appointment_start).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'short' })}.`, appointment.clinic_id)
      : '';
    await sendWhatsAppText(from, buildClinicContactMessage({ ...appointment, contactLink }), { clinicId: appointment.clinic_id });
  }
  return true;
}

// Presupuesto por invocación: al agotarse se reanuda en otra invocación en vez de morir por timeout
// a mitad del envío. El throttle evita ráfagas que degradan el quality rating del número en Meta.
const REMINDER_BUDGET_MS = 40_000;
const SEND_THROTTLE_MS = 120;

/** Reencola la continuación del lote en una invocación nueva (fire-and-forget). */
async function resumeReminders(slot, cursor) {
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || ''}`).replace(/\/$/, '').trim();
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (!appUrl.startsWith('https://') || !cronSecret) {
    console.error('⚠️ Lote de recordatorios incompleto y sin APP_URL/CRON_SECRET para reanudar; quedó en el índice', cursor);
    return;
  }
  try {
    const response = await fetch(`${appUrl}/api/whatsapp-chatbot?action=sendReminders&slot=${encodeURIComponent(slot || '')}&cursor=${cursor}`, {
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    console.error('❌ No se pudo reanudar el lote de recordatorios:', err.message);
  }
}

/** Avisa al staff cuando el recordatorio de un paciente no pudo entregarse. */
async function notifyStaffOfReminderFailure(row, patientName, dateLabel, reason) {
  try {
    const staffPhone = normalizeContactPhone(row.whatsapp_staff_phone || row.phone);
    if (!staffPhone || isSystemStaffPhone(staffPhone) || !(await isWithinCustomerServiceWindow(staffPhone))) return;
    await sendWhatsAppText(staffPhone, `⚠️ *Recordatorio NO enviado*\n\nNo se pudo entregar el recordatorio de ${patientName} (cita del ${dateLabel}).\nMotivo: ${String(reason).slice(0, 200)}\n\nContáctalo por otro medio.`, { clinicId: row.clinic_id });
  } catch (err) {
    console.error('❌ Error avisando fallo de recordatorio:', err.message);
  }
}

async function markAppointmentReminderSent(auth, event, dateKey) {
  const calendar = google.calendar({ version: 'v3', auth });
  const privateProps = { ...(event.extendedProperties?.private || {}) };
  privateProps.bioskinReminderSent = dateKey;
  await calendar.events.patch({
    calendarId: 'primary',
    eventId: event.id,
    requestBody: {
      extendedProperties: { private: privateProps },
    },
  });
}

async function sendPatientAppointmentReminders(dayOffset = 1, startIndex = 0, deadline = Number.POSITIVE_INFINITY) {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + dayOffset);
  const dateKey = targetDate.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const timeMin = `${dateKey}T00:00:00-05:00`;
  const timeMax = `${dateKey}T23:59:59-05:00`;

  // ORDER BY fijo: el índice de reanudación solo es válido si el orden es estable entre invocaciones.
  const users = await sql`
    SELECT cu.id AS user_id, cu.clinic_id, cu.full_name, cu.phone, cu.whatsapp_staff_phone, cs.general,
           cl.name AS clinic_name, cl.phone AS clinic_phone
    FROM clinic_oauth_tokens t
    JOIN clinic_users cu ON cu.id = t.clinic_user_id
      AND cu.is_active = true
      AND cu.whatsapp_bot_enabled = true
      AND cu.whatsapp_confirm_enabled = true
    JOIN clinic_settings cs ON cs.clinic_id = cu.clinic_id
    JOIN clinics cl ON cl.id = cu.clinic_id
    LEFT JOIN clinic_features cf ON cf.clinic_id = cu.clinic_id AND cf.feature = 'calendar'
    LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'calendar'
    WHERE COALESCE(cf.enabled, true) = true AND COALESCE(umo.enabled, true) = true
    ORDER BY cu.id
  `;

  let sent = 0;
  let index = startIndex;
  const errors = [];

  for (; index < users.rows.length; index++) {
    if (Date.now() > deadline) return { patientsChecked: users.rows.length, sent, errors, nextIndex: index };
    const row = users.rows[index];
    try {
      if (!(await loadSubscriptionLifecycle(getPool(), row.clinic_id)).canoperate) continue;
      const auth = await getUserOAuth2Client(row.user_id);
      if (!auth) continue;
      const calendar = google.calendar({ version: 'v3', auth });
      const { data } = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
      });

      for (const event of data.items || []) {
        if (!shouldSendAppointmentReminder(event, new Date())) continue;
        const parsed = parseAppointmentEvent(event);
        if (!parsed?.phone || isSystemStaffPhone(parsed.phone)) continue;
        const start = new Date(event.start?.dateTime || `${event.start?.date}T12:00:00-05:00`);
        const dateLabel = start.toLocaleString('es-ES', {
          timeZone: 'America/Guayaquil',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        const clinicName = row.clinic_name || row.general?.name || 'la clínica';
        const professionalName = parsed.professional || row.full_name || clinicName;
        const contactPhone = resolvePatientReminderContactPhone({
          clinicPhone: row.clinic_phone,
          patientPhone: parsed.phone,
        });
        const contactLink = contactPhone
          ? await createShortWaLink(contactPhone, `Hola, necesito comunicarme sobre mi cita del ${dateLabel}.`, row.clinic_id)
          : 'los canales habituales de la clínica';
        const patientMessage = buildPatientReminderMessage({
          patientName: parsed.patientName,
          clinicName,
          dateLabel,
          professionalName,
        });

        try {
          const withinWindow = await isWithinCustomerServiceWindow(parsed.phone);
          const templateName = (process.env.WHATSAPP_TEMPLATE_APPOINTMENT || '').trim();
          const templateLang = (process.env.WHATSAPP_TEMPLATE_APPOINTMENT_LANG || 'es_MX').trim();
          if (withinWindow) {
            await sendWhatsAppText(parsed.phone, `${patientMessage}\n\nSi prefieres hablar directamente con la clínica: ${contactLink}`, { clinicId: row.clinic_id, bookedByUserId: row.user_id, appointmentEventId: event.id, appointmentStart: start, appointmentPatientName: parsed.patientName, name: parsed.patientName });
          } else if (templateName) {
            await sendWhatsAppTemplate(parsed.phone, templateName, templateLang, {
              nombre_paciente: parsed.patientName,
              nombre_clinica: clinicName,
              nombre_usuario: professionalName,
              servicio: parsed.service || 'Consulta',
              fecha_hora: dateLabel,
              enlace_contacto: contactLink,
            }, { clinicId: row.clinic_id, bookedByUserId: row.user_id, appointmentEventId: event.id, appointmentStart: start, appointmentPatientName: parsed.patientName, name: parsed.patientName, buttonPayloads: [`appointment_confirm:${event.id}`] });
          } else {
            throw new Error('WHATSAPP_TEMPLATE_APPOINTMENT no configurada para recordatorio del día anterior');
          }
          await markAppointmentReminderSent(auth, event, formatLocalDateKey(start));
          sent++;
          // Meta permite ~80 msg/s, pero ráfagas de plantillas degradan el quality rating del número.
          await new Promise(resolve => setTimeout(resolve, SEND_THROTTLE_MS));
        } catch (sendErr) {
          errors.push(`${parsed.patientName}: ${sendErr.message}`);
          // Antes los fallos de plantilla (ej. idioma inexistente en Meta) quedaban solo en la BD:
          // el staff daba por enviado un recordatorio que el paciente nunca recibió.
          await notifyStaffOfReminderFailure(row, parsed.patientName, dateLabel, sendErr.message);
        }
      }
    } catch (err) {
      errors.push(`usuario ${row.user_id}: ${err.message}`);
    }
  }

  return { patientsChecked: users.rows.length, sent, errors, nextIndex: null };
}

/** Ayudantes activos del usuario. Vacío si no tiene el multi-recurso activado. */
async function listActiveResources(userId) {
  const u = await sql`SELECT multi_resource_enabled FROM clinic_users WHERE id = ${userId}`;
  if (u.rows[0]?.multi_resource_enabled !== true) return [];
  const r = await sql`
    SELECT id, name, work_hours FROM clinic_staff_resources
    WHERE owner_user_id = ${userId} AND active = true ORDER BY name
  `;
  return r.rows;
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
        const buttonPayload = msg.button?.payload || msg.interactive?.button_reply?.id || '';
        const text = (msg.text?.body || buttonText || msg.image?.caption || (mediaType === 'imagen' ? '[Imagen]' : mediaType === 'audio' ? '[Audio]' : '')).trim();
        messages.push({
          from,
          text,
          buttonPayload: String(buttonPayload || '').trim(),
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
/** Valida una duración en minutos escrita por el staff ("30", "60", "1.5h") entre 5 y 480 min. */
function parseDurationMinutes(text) {
  const raw = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  let m = raw.match(/^(\d{1,3})(min)?$/);
  if (m) {
    const n = Number(m[1]);
    return (n >= 5 && n <= 480) ? n : null;
  }
  m = raw.match(/^(\d+(?:\.\d+)?)h(oras?)?$/);
  if (m) {
    const n = Math.round(Number(m[1]) * 60);
    return (n >= 5 && n <= 480) ? n : null;
  }
  return null;
}

/** Interpreta "mañana"/"tarde" (o am/pm) como el período del día para buscar horarios disponibles. */
function parsePeriod(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (['manana', 'mañana', 'am', 'morning'].includes(raw)) return 'manana';
  if (['tarde', 'pm', 'afternoon'].includes(raw)) return 'tarde';
  return null;
}

/** Trae las citas de un día con datos listos para reprogramar/eliminar (id de evento, paciente, contacto, duración). */
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
      return {
        id: e.id, hora, patientName: parsed.patientName || 'Paciente', phone: parsed.phone || '', email: parsed.email || '',
        professional: parsed.professional || '', service: parsed.service || '', resource: parsed.resource || '',
        resourceId: eventResourceId(e, userId),
        startIso: Number.isNaN(start.getTime()) ? null : start.toISOString(),
        durationMinutes: (!Number.isNaN(end.getTime()) && !Number.isNaN(start.getTime()) && end > start)
          ? Math.round((end - start) / 60000)
          : 60,
      };
    });
  return { appointments };
}

function formatAppointmentSelectionList(appointments) {
  return appointments.map((a, i) => `${i + 1}. ${a.hora || 'Hora pendiente'} — ${formatWhatsAppLabel(a.patientName, 'Paciente')}${a.resource ? ` (${formatWhatsAppLabel(a.resource)})` : ''}`).join('\n');
}

export function buildDailySummaryMessage({ greeting, header, lines, footer, moreInstruction }, visibleLimit = 4) {
  const visibleLines = lines.slice(0, visibleLimit);
  const remaining = lines.length - visibleLines.length;
  const more = remaining > 0
    ? `*Hay ${remaining} ${remaining === 1 ? 'cita' : 'citas'} más.* ${moreInstruction}`
    : '';
  return [greeting, header, visibleLines.join('\n\n'), more, footer].filter(Boolean).join('\n\n');
}

async function listAppointmentsForDate(userId, isoDate, label) {
  const owner = (await sql`SELECT clinic_id FROM clinic_users WHERE id=${userId}`).rows[0];
  const { error, appointments } = await getAppointmentsForDate(userId, isoDate);
  if (error) return error;
  const dateLabel = new Date(`${isoDate}T00:00:00-05:00`).toLocaleDateString('es-ES', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric' });
  if (!appointments.length) return `${label} (${dateLabel}): no hay citas agendadas.`;
  // El enlace corto solo se crea aquí: generárselo a cada cita en los flujos de reprogramar/eliminar
  // insertaba filas en `wa_short_links` que nadie llegaba a abrir.
  const lines = await Promise.all(appointments.map(async (a, i) => {
    const link = a.phone
      ? await createShortWaLink(a.phone, `Hola ${a.patientName}, te escribimos para confirmar/actualizar tu cita del ${dateLabel}${a.hora ? ` a las ${a.hora}` : ''}. Por favor responde a este mensaje si tienes alguna consulta.`, owner?.clinic_id)
      : '';
    return `${i + 1}. ${a.hora || 'Hora pendiente'} — ${a.patientName}${a.resource ? ` (${a.resource})` : ''}${link ? `\n   Enviar recordatorio: ${link}` : ''}`;
  }));
  return `📅 ${label} (${dateLabel}):\n\n${lines.join('\n\n')}`;
}

/** Busca horarios libres de `durationMinutes` en un período del día, evitando choques con eventos existentes. */
async function getAvailableSlots(userId, clinicId, isoDate, period, durationMinutes, excludeEventId, resourceId) {
  const auth = await getUserOAuth2Client(userId);
  if (!auth) return { error: 'No tienes Google Calendar conectado a tu cuenta.' };
  const calendar = google.calendar({ version: 'v3', auth });

  const agendaRes = clinicId ? await sql`SELECT agenda FROM clinic_settings WHERE clinic_id = ${clinicId}` : { rows: [] };
  const agenda = agendaRes.rows[0]?.agenda || {};
  let dayStartHour = agenda.start_hour || '08:00';
  let dayEndHour = agenda.end_hour || '19:00';
  if (resourceId?.startsWith('staff:')) {
    const wh = await sql`SELECT work_hours FROM clinic_staff_resources WHERE id = ${parseInt(resourceId.slice(6), 10)} AND owner_user_id = ${userId}`;
    dayStartHour = wh.rows[0]?.work_hours?.start_hour || dayStartHour;
    dayEndHour   = wh.rows[0]?.work_hours?.end_hour   || dayEndHour;
  }
  const midday = '13:00';
  const [rangeStart, rangeEnd] = period === 'tarde' ? [midday, dayEndHour] : [dayStartHour, midday];

  const { data } = await calendar.events.list({
    calendarId: 'primary', timeMin: `${isoDate}T00:00:00-05:00`, timeMax: `${isoDate}T23:59:59-05:00`,
    singleEvents: true, orderBy: 'startTime',
  });
  const targetResource = resourceId || ownerResourceId(userId);
  const busy = (data.items || [])
    .filter(e => e.id !== excludeEventId && e.start?.dateTime && e.end?.dateTime)
    .filter(e => eventResourceId(e, userId) === targetResource)
    .map(e => ({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }));

  const durationMs = durationMinutes * 60000;
  const stepMs = 30 * 60000;
  const rangeEndDate = new Date(`${isoDate}T${rangeEnd}:00-05:00`);
  const slots = [];
  for (let cursor = new Date(`${isoDate}T${rangeStart}:00-05:00`); cursor.getTime() + durationMs <= rangeEndDate.getTime() && slots.length < 8; cursor = new Date(cursor.getTime() + stepMs)) {
    const slotEnd = new Date(cursor.getTime() + durationMs);
    if (!busy.some(b => cursor < b.end && slotEnd > b.start)) slots.push(new Date(cursor));
  }
  return { slots };
}

/** Mueve la cita completa: `patch` conserva título, descripción (teléfono/correo) y recurso, y solo cambia el horario. */
async function rescheduleAppointment(userId, eventId, startDate, durationMs) {
  const auth = await getUserOAuth2Client(userId);
  if (!auth) throw new Error('No tienes Google Calendar conectado a tu cuenta.');
  const calendar = google.calendar({ version: 'v3', auth });
  const endDate = new Date(startDate.getTime() + durationMs);
  await calendar.events.patch({
    calendarId: 'primary', eventId,
    requestBody: {
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Guayaquil' },
      end: { dateTime: endDate.toISOString(), timeZone: 'America/Guayaquil' },
      // Sin borrar la marca, mover la cita dentro del mismo día dejaba al paciente con la hora vieja:
      // el cron la daba por avisada y no reenviaba el recordatorio.
      extendedProperties: { private: { bioskinReminderSent: null } },
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

/** Crea una cita nueva en el calendario del staff, con el mismo formato que lee `parseAppointmentEvent`. */
async function createAppointmentEvent(userId, patientName, patientPhone, patientEmail, professional, startDate, durationMs, resourceId, resourceName) {
  const auth = await getUserOAuth2Client(userId);
  if (!auth) throw new Error('No tienes Google Calendar conectado a tu cuenta.');
  const calendar = google.calendar({ version: 'v3', auth });
  const endDate = new Date(startDate.getTime() + durationMs);
  const description = `Teléfono: ${patientPhone || 'No proporcionado'}` +
    `\nCorreo: ${patientEmail || 'No proporcionado'}` +
    (professional ? `\nProfesional: ${professional}` : '') +
    (resourceName ? `\nRecurso: ${resourceName}` : '') +
    '\n[AGENDADO POR WHATSAPP]';
  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      // Mismo título que el panel (`Cita: Nombre - correo`) para que la agenda se lea igual en ambos canales.
      summary: patientEmail ? `Cita: ${patientName} - ${patientEmail}` : `Cita: ${patientName}`,
      description,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Guayaquil' },
      end: { dateTime: endDate.toISOString(), timeZone: 'America/Guayaquil' },
      extendedProperties: resourceExtendedProperties(resourceId, userId),
    },
  });
  return data.id;
}

const APPOINTMENT_COPY = {
  booked:      { subject: 'Tu cita está agendada', heading: '¡Tu cita está agendada!', intro: 'hemos registrado tu cita. Este es el resumen:' },
  rescheduled: { subject: 'Tu cita fue reprogramada', heading: 'Tu cita fue reprogramada', intro: 'tu cita cambió de horario. Este es el nuevo detalle:' },
  cancelled:   { subject: 'Tu cita fue cancelada', heading: 'Tu cita fue cancelada', intro: 'hemos cancelado la siguiente cita:' },
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildAppointmentEmailHtml({ kind, patientName, clinicName, professionalName, dateLabel, durationMinutes }) {
  const copy = APPOINTMENT_COPY[kind];
  const rows = [
    ['Fecha y hora', dateLabel],
    durationMinutes ? ['Duración', `${durationMinutes} minutos`] : null,
    professionalName ? ['Profesional', professionalName] : null,
    ['Clínica', clinicName],
  ].filter(Boolean);
  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,#8a6b3f 0%,#ba9256 100%);color:#fff;padding:22px 24px;border-radius:12px 12px 0 0;">
        <h2 style="margin:0 0 4px;font-size:20px;">${escapeHtml(copy.heading)}</h2>
        <p style="margin:0;font-size:13px;opacity:.85;">${escapeHtml(clinicName)}</p>
      </div>
      <div style="background:#fff;border:1px solid #ececec;border-top:0;padding:24px;">
        <p style="margin:0 0 16px;color:#444;">Hola <strong>${escapeHtml(patientName)}</strong>, ${escapeHtml(copy.intro)}</p>
        <table style="width:100%;border-collapse:collapse;">
          ${rows.map(([label, value], i) => `<tr${i % 2 === 0 ? ' style="background:#faf5ef;"' : ''}><td style="padding:10px 12px;border-bottom:1px solid #f0e8d8;color:#666;font-size:13px;width:40%;">${escapeHtml(label)}</td><td style="padding:10px 12px;border-bottom:1px solid #f0e8d8;font-weight:600;color:#333;font-size:13px;">${escapeHtml(value)}</td></tr>`).join('')}
        </table>
        <p style="margin:20px 0 0;color:#555;font-size:13px;">${kind === 'cancelled' ? 'Si deseas agendar una nueva cita, responde este correo.' : '¿Tienes alguna pregunta? Responde este correo.'}</p>
      </div>
      <div style="padding:18px 24px;text-align:center;background:#3e3026;color:#eadfd2;font-size:11px;line-height:1.6;border-radius:0 0 12px 12px;">
        <strong style="display:block;color:#e8c995;letter-spacing:2px;font-size:12px;">BIOSKINTECH · GESTIÓN CLÍNICA</strong>
        <a href="https://bioskintechapp.com" style="color:#fff;text-decoration:none;">bioskintechapp.com</a>
      </div>
    </div>`;
}

/** Envía un correo desde la cuenta Gmail conectada del propio usuario/clínica, nunca desde el SMTP global. */
async function sendEmailAsUser(userId, { fromName, to, subject, html }) {
  const oauth = await getUserGmailClient(userId);
  if (!oauth) throw new Error('no tienes una cuenta Gmail conectada');
  const gmail = google.gmail({ version: 'v1', auth: oauth.client });
  const raw = Buffer.from([
    `From: ${fromName} <${oauth.email}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n')).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return oauth.email;
}

/**
 * Avisa al paciente de una cita creada, movida o cancelada por correo (Gmail del usuario) y por WhatsApp.
 * Devuelve el detalle de lo ocurrido para mostrárselo al staff, en vez de fallar la operación completa.
 */
async function notifyPatientOfAppointment(clinicUser, { kind, patientName, phone, email, eventId, startDate, durationMinutes }) {
  const clinicName = clinicUser.clinic_name || 'la clínica';
  const professionalName = [clinicUser.gentilicio, clinicUser.full_name].filter(Boolean).join(' ').trim();
  const dateLabel = startDate && !Number.isNaN(startDate.getTime())
    ? startDate.toLocaleString('es-ES', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'la fecha acordada';
  const copy = APPOINTMENT_COPY[kind];
  const lines = [];

  if (email) {
    try {
      const sender = await sendEmailAsUser(clinicUser.id, {
        fromName: clinicName,
        to: email,
        subject: `${copy.subject} — ${clinicName}`,
        html: buildAppointmentEmailHtml({ kind, patientName, clinicName, professionalName, dateLabel, durationMinutes }),
      });
      lines.push(`📧 Correo enviado a ${email} desde ${sender}.`);
    } catch (err) {
      lines.push(`⚠️ No se pudo enviar el correo a ${email}: ${err.message}`);
    }
  } else {
    lines.push('📧 Sin correo registrado — no se envió confirmación por correo.');
  }

  if (!phone) {
    lines.push('📱 Sin número registrado — no se le puede escribir desde aquí.');
    return lines.join('\n');
  }

  const patientText = kind === 'cancelled'
    ? `Hola ${patientName}, tu cita del ${dateLabel} en ${clinicName} fue cancelada. Si deseas reagendar, responde a este mensaje.`
    : `Hola ${patientName}, tu cita en ${clinicName} quedó ${kind === 'rescheduled' ? 'reprogramada' : 'agendada'} para el ${dateLabel}.\n\n✅ Responde *CONFIRMAR* si asistirás.\n🔄 Responde *CAMBIAR* si necesitas otro horario.`;
  try {
    // Fuera de la ventana de 24h de Meta el texto libre se rechaza; ahí el staff lo envía con un toque.
    if (await isWithinCustomerServiceWindow(phone)) {
      await sendWhatsAppText(phone, patientText, {
        clinicId: clinicUser.clinic_id, bookedByUserId: clinicUser.id, name: patientName,
        ...(kind === 'cancelled' ? {} : { appointmentEventId: eventId, appointmentStart: startDate, appointmentPatientName: patientName }),
      });
      lines.push('📱 WhatsApp enviado al paciente automáticamente.');
    } else {
      lines.push(`📱 Avísale tú (fuera de la ventana de 24h): ${await createShortWaLink(phone, patientText, clinicUser.clinic_id)}`);
    }
  } catch (err) {
    lines.push(`⚠️ No se pudo avisar por WhatsApp: ${err.message}`);
  }
  return lines.join('\n');
}

const CANCEL_HINT = '\n\n_Salir: *cancelar* · Inicio: *menu*_';
const MENU_TEXT = '*¿Qué deseas hacer?*\n\n1. Ver agenda\n2. Recibir reporte financiero\n\n_Responde solo con 1 o 2._';
const AGENDA_MENU_TEXT = '📅 *Agenda*\n\n1. Citas de hoy\n2. Citas de otra fecha\n3. Reprogramar cita\n4. Eliminar cita\n5. Agendar cita\n\n_Responde solo con un número._' + CANCEL_HINT;
const FINANCE_REPORT_MENU_TEXT = '📊 *Reporte financiero*\n\n1. Diario\n2. Semanal\n3. Mensual\n\n_Responde solo con un número._' + CANCEL_HINT;
const DATE_FORMAT_HINT = '_Ejemplo: hoy, mañana o 31/12/2026_';
const AGENDA_DATE_PROMPT = '📅 *Consultar agenda*\n\n¿Qué fecha deseas ver?\n' + DATE_FORMAT_HINT + CANCEL_HINT;
const RESCHEDULE_DATE_PROMPT = '📅 *Reprogramar cita*\n\n¿En qué fecha está la cita?\n' + DATE_FORMAT_HINT + CANCEL_HINT;
const DELETE_DATE_PROMPT = '📅 *Eliminar cita*\n\n¿En qué fecha está la cita?\n' + DATE_FORMAT_HINT + CANCEL_HINT;
const NEW_DATE_PROMPT = '📅 *Nueva fecha*\n\n¿Para qué día deseas moverla?\n' + DATE_FORMAT_HINT + CANCEL_HINT;
const NEW_DURATION_PROMPT = '⏱️ *Duración*\n\n¿Cuántos minutos dura?\n_Ejemplo: 30, 60 o 90_' + CANCEL_HINT;
const NEW_PERIOD_PROMPT = '🌤️ *Horario*\n\n¿Mañana o tarde?\n_Responde: mañana o tarde_' + CANCEL_HINT;
const BOOKING_NAME_PROMPT = '🧑‍⚕️ Vamos a agendar una cita nueva.\n\n¿Cuál es el nombre completo del paciente?' + CANCEL_HINT;
const BOOKING_PHONE_PROMPT = '📱 *WhatsApp del paciente*\n\nEscribe el número.\n_Ejemplo: 0991234567_' + CANCEL_HINT;
const BOOKING_EMAIL_PROMPT = '✉️ ¿Cuál es el correo del paciente? Ahí se envía la confirmación de la cita.\n\nSi no lo tienes, responde *omitir*.' + CANCEL_HINT;
const BOOKING_DATE_PROMPT = '📅 *Fecha de la cita*\n\n¿Para qué día es?\n' + DATE_FORMAT_HINT + CANCEL_HINT;
const PAST_DATE_NOTICE = '⚠️ Esa fecha ya pasó. Escribe una fecha de hoy en adelante.';
const ALLOWED_BOT_ACTIONS = new Set(['1', '2', 'diario', 'daily', 'semanal', 'weekly', 'mensual', 'monthly']);

/** Un correo válido es requisito para la confirmación; "omitir" deja la cita sin correo a propósito. */
export function parsePatientEmail(text) {
  const raw = String(text || '').trim();
  if (['omitir', 'no', 'ninguno', 'sin correo', 'skip'].includes(normalizeCommandText(raw))) return { skipped: true, email: '' };
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw) ? { skipped: false, email: raw.toLowerCase() } : null;
}

/** Hoy en Ecuador, para rechazar citas agendadas hacia atrás. */
function isPastDate(isoDate) {
  return isoDate < new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
}

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
  const state = await getBotState(from);

  if (state?.flow === 'systemQuestion') {
    await clearBotState(from);
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
    await setBotState(from, 'systemQuestion', {});
    await sendWhatsAppText(from, '🤖 Escribe tu pregunta sobre el estado del sistema.');
    return;
  }

  await sendWhatsAppText(from, SYSTEM_MENU_TEXT);
}

export function shouldNotifyBookingUserOfDeliveryStatus(status) {
  return status === 'fallido';
}

/** Avisa al staff solo cuando el recordatorio falla; las lecturas se conservan en el CRM sin generar ruido. */
async function notifyBookingUserOfDeliveryStatus({ bookedByUserId, contactId, status, patientName, appointmentStart }) {
  if (!bookedByUserId || !shouldNotifyBookingUserOfDeliveryStatus(status)) return;
  try {
    const [staffRes, contact] = await Promise.all([
      sql`SELECT clinic_id,phone, whatsapp_staff_phone FROM clinic_users WHERE id = ${bookedByUserId} AND is_active = true AND whatsapp_bot_enabled = true`,
      getContactById(contactId),
    ]);
    if (!staffRes.rows[0]?.clinic_id || !(await loadSubscriptionLifecycle(getPool(), staffRes.rows[0].clinic_id)).canoperate) return;
    const staffPhone = normalizeEcuadorPhone(staffRes.rows[0]?.whatsapp_staff_phone || staffRes.rows[0]?.phone || '');
    if (!staffPhone || !(await isWithinCustomerServiceWindow(staffPhone))) return;
    const patientLabel = patientName || contact?.name || contact?.phone || 'el paciente';
    const phoneNote = contact?.phone && patientLabel !== contact.phone ? ` (${contact.phone})` : '';
    const dateNote = appointmentStart
      ? ` del ${new Date(appointmentStart).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'short' })}`
      : '';
    const message = `⚠️ *Recordatorio NO entregado*\n\nNo se pudo enviar el recordatorio de WhatsApp a ${patientLabel}${phoneNote} para su cita${dateNote}. Verifica el número o avísale por otro medio.\n\nEscribe *menu* para ver las opciones.`;
    await sendWhatsAppText(staffPhone, message);
  } catch (err) {
    console.error('❌ Error notificando estado de entrega al staff:', err.message);
  }
}

/** Procesa mensajes entrantes: solo responde a números registrados como staff activo (clinic_users.phone). */
export async function processWhatsAppDeliveryStatus(event, {
  pool = getPool(), update = updateWhatsAppMessageStatus, claim = claimMessageStatusNotification,
  notify = notifyBookingUserOfDeliveryStatus, load = loadSubscriptionLifecycle,
} = {}) {
  const db = await pool.connect();
  let lockedClinic = null;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout = '10s'");
    const lookup = async (locked = false) => (await db.query(`SELECT c.clinic_id AS contact_clinic_id,u.clinic_id AS owner_clinic_id,
      m.booked_by_user_id FROM whatsapp_messages m JOIN whatsapp_contacts c ON c.id=m.contact_id
      LEFT JOIN clinic_users u ON u.id=m.booked_by_user_id WHERE m.provider_message_id=$1${locked ? ' FOR UPDATE OF m,c' : ''}`, [event.providerMessageId])).rows[0];
    const target = await lookup();
    if (!target?.contact_clinic_id || (target.booked_by_user_id != null && target.owner_clinic_id !== target.contact_clinic_id)) {
      await db.query('ROLLBACK');
      return { blocked: true };
    }
    await lockClinicWriters(db, [target.contact_clinic_id], { session: true });
    lockedClinic = target.contact_clinic_id;
    const current = await lookup(true);
    if (!current || current.contact_clinic_id !== target.contact_clinic_id ||
        (current.booked_by_user_id != null && current.owner_clinic_id !== target.contact_clinic_id) ||
        !(await load(db, target.contact_clinic_id)).canoperate) {
      await db.query('ROLLBACK');
      return { blocked: true };
    }
    const updated = await update(event.providerMessageId, event.status, event.errorDetail, db);
    const notifyClaimed = updated && !updated.read_notified &&
      shouldNotifyBookingUserOfDeliveryStatus(updated.status) && await claim(updated.id, db);
    await db.query('COMMIT');
    // Release row locks before outbound CRM writes, but retain the common
    // session lifecycle lock until notification and a fresh date check finish.
    if (notifyClaimed && (await load(db, target.contact_clinic_id)).canoperate)
      await notify({ bookedByUserId: updated.booked_by_user_id, contactId: updated.contact_id, status: updated.status,
        patientName: updated.appointment_patient_name, appointmentStart: updated.appointment_start });
    return { blocked: false };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    try { if (lockedClinic) await unlockClinicWriters(db, [lockedClinic]); }
    catch (error) { db.release(error); throw error; }
    db.release();
  }
}

async function handleIncomingMessages(body) {
  for (const event of extractMessageStatuses(body)) {
    await processWhatsAppDeliveryStatus(event);
  }

  for (const { from, text, buttonPayload, mediaType, providerMessageId, timestamp, name } of extractIncomingMessages(body)) {
    if (!from) continue;
    if (!getSystemStaffPhones().has(from)) {
      const domestic = from.startsWith('593') ? `0${from.slice(3)}` : from;
      const tenants = await sql`SELECT clinic_id FROM whatsapp_contacts WHERE phone=${from} AND clinic_id IS NOT NULL
        UNION SELECT clinic_id FROM clinic_users WHERE clinic_id IS NOT NULL AND
          (regexp_replace(coalesce(phone,''),'[^0-9]','','g') IN (${from},${domestic})
           OR regexp_replace(coalesce(whatsapp_staff_phone,''),'[^0-9]','','g') IN (${from},${domestic}))`;
      let blocked = false;
      for (const tenant of tenants.rows) {
        if (!(await loadSubscriptionLifecycle(getPool(), tenant.clinic_id)).canoperate) { blocked = true; break; }
      }
      if (blocked) continue;
    }
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
    const normalizedText = normalizeCommandText(text);
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

    try {
      if (await handlePatientAppointmentReply({ from, text, buttonPayload })) continue;
    } catch (err) {
      console.error('❌ Error procesando respuesta de cita del paciente:', err.message);
    }

    const staff = await sql`
      SELECT cu.id, cu.clinic_id, cu.full_name, cu.gentilicio, cu.email, cu.phone, cu.whatsapp_staff_phone, cu.finance_scope,
              cl.name AS clinic_name,
              COALESCE(cf.enabled, true) AND COALESCE(umo.enabled, true) AND COALESCE(vis.enabled, true) AS finance_enabled,
              COALESCE(calendar_feature.enabled, true) AND COALESCE(calendar_override.enabled, true) AS calendar_enabled
      FROM clinic_users cu
            JOIN clinics cl ON cl.id = cu.clinic_id
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
    if (matches.length !== 1) {
      const notification = await getRecentAppointmentNotificationContext(from).catch(() => null);
      if (notification && (await loadSubscriptionLifecycle(getPool(), notification.clinic_id)).canoperate &&
          !(await hasRecentAppointmentSystemReply(from).catch(() => true))) {
        const systemNote = buildAppointmentSystemNote({
          clinicName: notification.clinic_name,
          clinicPhone: notification.clinic_phone,
          professionalName: notification.professional_name,
          professionalPhone: notification.professional_phone,
          patientPhone: from,
        });
        await sendWhatsAppText(from, systemNote, { clinicId: notification.clinic_id });
      }
      continue; // desconocido, ambiguo o bot no habilitado: no se revela información
    }
    const clinicUser = matches[0];
    if (!(await loadSubscriptionLifecycle(getPool(), clinicUser.clinic_id)).canoperate) continue;
    const botState = await getBotState(from); // { flow, stage, ...datos } | null — persistente entre invocaciones serverless
    const financeChoice = resolveFinancePeriodChoice(normalizedText);
    const isAllowedAction = ALLOWED_BOT_ACTIONS.has(normalizedText) || ALLOWED_BOT_ACTIONS.has(text?.trim() || '');
    const hasActiveState = !!botState;

    try {
      // ── Comandos globales, disponibles en cualquier punto de cualquier flujo ──
      if (['cancelar', 'cancela', 'salir', 'cancelarlo'].includes(normalizedText) && hasActiveState) {
        await clearBotState(from);
        await sendWhatsAppText(from, '❌ Operación cancelada.\n\nEscribe *menu* para ver las opciones.');
        continue;
      }
      if (['menu', 'menu principal', 'inicio', 'opciones', 'hola'].includes(normalizedText)) {
        await clearBotState(from);
        await sendWhatsAppText(from, `Hola ${clinicUser.full_name || ''} 👋\n\n${MENU_TEXT}`);
        continue;
      }

      // ── Reprogramar cita ──────────────────────────────────────────────
      if (botState?.flow === 'reschedule') {
        if (!clinicUser.calendar_enabled) { await clearBotState(from); await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }

        if (botState.stage === 'awaitingDate') {
          const isoDate = parseFlexibleDate(normalizedText);
          if (!isoDate) { await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${RESCHEDULE_DATE_PROMPT}`); continue; }
          const { error, appointments } = await getAppointmentsForDate(clinicUser.id, isoDate);
          if (error) { await clearBotState(from); await sendWhatsAppText(from, error); continue; }
          if (!appointments.length) { await clearBotState(from); await sendWhatsAppText(from, `No hay citas agendadas ese día.\n\nEscribe *menu* para ver las opciones.`); continue; }
          await setBotState(from, 'reschedule', { stage: 'awaitingSelection', appointments });
          await sendWhatsAppText(from, `${formatAppointmentSelectionList(appointments)}\n\nResponde con el número de la cita que quieres reprogramar.${CANCEL_HINT}`);
          continue;
        }
        if (botState.stage === 'awaitingSelection') {
          const selected = botState.appointments[Number(normalizedText) - 1];
          if (!selected) { await sendWhatsAppText(from, `Número inválido. Responde con el número de la lista.${CANCEL_HINT}`); continue; }
          await setBotState(from, 'reschedule', { stage: 'awaitingNewDate', selected });
          await sendWhatsAppText(from, `Cita seleccionada: *${selected.patientName}* (${selected.hora || 'hora pendiente'}, ${selected.durationMinutes} min).\nSe mantienen su teléfono, correo y profesional.\n\n${NEW_DATE_PROMPT}`);
          continue;
        }
        if (botState.stage === 'awaitingNewDate') {
          const newIsoDate = parseFlexibleDate(normalizedText);
          if (!newIsoDate) { await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${NEW_DATE_PROMPT}`); continue; }
          if (isPastDate(newIsoDate)) { await sendWhatsAppText(from, `${PAST_DATE_NOTICE}\n\n${NEW_DATE_PROMPT}`); continue; }
          await setBotState(from, 'reschedule', { ...botState, stage: 'awaitingDuration', newIsoDate });
          await sendWhatsAppText(from, `⏱️ ¿Cuánto durará la cita? Responde en minutos, o *igual* para mantener los ${botState.selected.durationMinutes} min actuales.${CANCEL_HINT}`);
          continue;
        }
        if (botState.stage === 'awaitingDuration') {
          const keepCurrent = ['igual', 'misma', 'lo mismo', 'mantener'].includes(normalizedText);
          const durationMinutes = keepCurrent ? botState.selected.durationMinutes : parseDurationMinutes(normalizedText);
          if (!durationMinutes) { await sendWhatsAppText(from, `No reconocí esa duración. Responde en minutos o *igual* para mantener los ${botState.selected.durationMinutes} min.${CANCEL_HINT}`); continue; }
          await setBotState(from, 'reschedule', { ...botState, stage: 'awaitingPeriod', durationMinutes });
          await sendWhatsAppText(from, NEW_PERIOD_PROMPT);
          continue;
        }
        if (botState.stage === 'awaitingPeriod') {
          const period = parsePeriod(normalizedText);
          if (!period) { await sendWhatsAppText(from, `No reconocí esa opción.\n\n${NEW_PERIOD_PROMPT}`); continue; }
          const { error, slots } = await getAvailableSlots(clinicUser.id, clinicUser.clinic_id, botState.newIsoDate, period, botState.durationMinutes, botState.selected.id, botState.selected.resourceId);
          if (error) { await clearBotState(from); await sendWhatsAppText(from, error); continue; }
          if (!slots.length) {
            await sendWhatsAppText(from, `No hay horarios disponibles esa ${period === 'tarde' ? 'tarde' : 'mañana'} para ${botState.durationMinutes} min.\n\n${NEW_PERIOD_PROMPT}`);
            continue;
          }
          await setBotState(from, 'reschedule', { ...botState, stage: 'awaitingSlotChoice', slots: slots.map(d => d.toISOString()) });
          const list = slots.map((d, i) => `${i + 1}. ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Guayaquil' })}`).join('\n');
          await sendWhatsAppText(from, `Horarios disponibles:\n\n${list}\n\nResponde con el número del horario que prefieres.${CANCEL_HINT}`);
          continue;
        }
        if (botState.stage === 'awaitingSlotChoice') {
          const chosenIso = botState.slots[Number(normalizedText) - 1];
          if (!chosenIso) { await sendWhatsAppText(from, `Número inválido. Responde con el número de la lista.${CANCEL_HINT}`); continue; }
          await clearBotState(from);
          const { selected, durationMinutes } = botState;
          try {
            const startDate = new Date(chosenIso);
            await rescheduleAppointment(clinicUser.id, selected.id, startDate, durationMinutes * 60000);
            // La confirmación anterior era para el horario viejo: dejarla marcada mostraba la cita
            // como "confirmada" en el resumen aunque el paciente aún no supiera del cambio.
            await clearAppointmentReplyStatus(selected.id, clinicUser.id).catch(() => {});
            const horaLabel = startDate.toLocaleString('es-ES', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const notice = await notifyPatientOfAppointment(clinicUser, {
              kind: 'rescheduled', patientName: selected.patientName, phone: selected.phone, email: selected.email,
              eventId: selected.id, startDate, durationMinutes,
            });
            await sendWhatsAppText(from, `✅ Cita de ${selected.patientName} reprogramada para el ${horaLabel} (${durationMinutes} min).\nSe mantuvieron teléfono, correo, profesional y recurso.\n\n${notice}\n\nEscribe *menu* para ver las opciones.`);
          } catch (err) {
            await sendWhatsAppText(from, `❌ No se pudo reprogramar la cita: ${err.message}\n\nEscribe *menu* para ver las opciones.`);
          }
          continue;
        }
      }

      // ── Eliminar cita ─────────────────────────────────────────────────
      if (botState?.flow === 'delete') {
        if (!clinicUser.calendar_enabled) { await clearBotState(from); await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }

        if (botState.stage === 'awaitingDate') {
          const isoDate = parseFlexibleDate(normalizedText);
          if (!isoDate) { await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${DELETE_DATE_PROMPT}`); continue; }
          const { error, appointments } = await getAppointmentsForDate(clinicUser.id, isoDate);
          if (error) { await clearBotState(from); await sendWhatsAppText(from, error); continue; }
          if (!appointments.length) { await clearBotState(from); await sendWhatsAppText(from, `No hay citas agendadas ese día.\n\nEscribe *menu* para ver las opciones.`); continue; }
          await setBotState(from, 'delete', { stage: 'awaitingSelection', appointments });
          await sendWhatsAppText(from, `${formatAppointmentSelectionList(appointments)}\n\nResponde con el número de la cita que quieres eliminar.${CANCEL_HINT}`);
          continue;
        }
        if (botState.stage === 'awaitingSelection') {
          const selected = botState.appointments[Number(normalizedText) - 1];
          if (!selected) { await sendWhatsAppText(from, `Número inválido. Responde con el número de la lista.${CANCEL_HINT}`); continue; }
          await setBotState(from, 'delete', { stage: 'awaitingConfirm', selected });
          await sendWhatsAppText(from, `¿Confirmas eliminar la cita de ${selected.patientName} (${selected.hora || 'hora pendiente'})? Responde "sí" o "no".${CANCEL_HINT}`);
          continue;
        }
        if (botState.stage === 'awaitingConfirm') {
          const { selected } = botState;
          await clearBotState(from);
          if (['si', 'sí', 'confirmar', 'yes'].includes(normalizedText)) {
            try {
              await deleteAppointment(clinicUser.id, selected.id);
              // El enlace anterior reutilizaba el texto de recordatorio ("confirmar/actualizar tu cita")
              // justo después de borrarla, dejando al paciente con un mensaje contradictorio.
              const notice = await notifyPatientOfAppointment(clinicUser, {
                kind: 'cancelled', patientName: selected.patientName, phone: selected.phone, email: selected.email,
                eventId: selected.id, startDate: selected.startIso ? new Date(selected.startIso) : null, durationMinutes: selected.durationMinutes,
              });
              await sendWhatsAppText(from, `✅ Cita de ${selected.patientName} eliminada.\n\n${notice}\n\nEscribe *menu* para ver las opciones.`);
            } catch (err) {
              await sendWhatsAppText(from, `❌ No se pudo eliminar la cita: ${err.message}\n\nEscribe *menu* para ver las opciones.`);
            }
          } else {
            await sendWhatsAppText(from, 'Eliminación cancelada.\n\nEscribe *menu* para ver las opciones.');
          }
          continue;
        }
      }

      // ── Agendar cita nueva ────────────────────────────────────────────
      if (botState?.flow === 'booking') {
        if (!clinicUser.calendar_enabled) { await clearBotState(from); await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }

        if (botState.stage === 'awaitingPatientName') {
          const patientName = text.trim().slice(0, 150);
          if (patientName.length < 2) { await sendWhatsAppText(from, `Ese nombre no parece válido.\n\n${BOOKING_NAME_PROMPT}`); continue; }
          await setBotState(from, 'booking', { stage: 'awaitingPatientPhone', patientName });
          await sendWhatsAppText(from, BOOKING_PHONE_PROMPT);
          continue;
        }
        if (botState.stage === 'awaitingPatientPhone') {
          const patientPhone = normalizeEcuadorPhone(normalizedText);
          if (patientPhone.length < 11 || patientPhone.length > 13) { await sendWhatsAppText(from, `Ese número no parece válido.\n\n${BOOKING_PHONE_PROMPT}`); continue; }
          await setBotState(from, 'booking', { ...botState, stage: 'awaitingPatientEmail', patientPhone });
          await sendWhatsAppText(from, BOOKING_EMAIL_PROMPT);
          continue;
        }
        if (botState.stage === 'awaitingPatientEmail') {
          const parsedEmail = parsePatientEmail(text);
          if (!parsedEmail) { await sendWhatsAppText(from, `Ese correo no parece válido.\n\n${BOOKING_EMAIL_PROMPT}`); continue; }
          const withEmail = { ...botState, patientEmail: parsedEmail.email };
          const resources = await listActiveResources(clinicUser.id);
          if (resources.length) {
            const options = [{ id: ownerResourceId(clinicUser.id), name: clinicUser.full_name || 'Yo' },
                             ...resources.map(r => ({ id: `staff:${r.id}`, name: r.name }))];
            await setBotState(from, 'booking', { ...withEmail, stage: 'awaitingResource', resourceOptions: options });
            const list = options.map((o, i) => `${i + 1}. ${o.name}`).join('\n');
            await sendWhatsAppText(from, `¿Quién atiende esta cita?\n\n${list}\n\nResponde con el número.${CANCEL_HINT}`);
            continue;
          }
          await setBotState(from, 'booking', { ...withEmail, stage: 'awaitingDate' });
          await sendWhatsAppText(from, BOOKING_DATE_PROMPT);
          continue;
        }
        if (botState.stage === 'awaitingResource') {
          const chosen = botState.resourceOptions?.[Number(normalizedText) - 1];
          if (!chosen) { await sendWhatsAppText(from, `Número inválido. Responde con el número de la lista.${CANCEL_HINT}`); continue; }
          await setBotState(from, 'booking', { ...botState, stage: 'awaitingDate', resourceId: chosen.id, resourceName: chosen.name });
          await sendWhatsAppText(from, BOOKING_DATE_PROMPT);
          continue;
        }
        if (botState.stage === 'awaitingDate') {
          const isoDate = parseFlexibleDate(normalizedText);
          if (!isoDate) { await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${BOOKING_DATE_PROMPT}`); continue; }
          if (isPastDate(isoDate)) { await sendWhatsAppText(from, `${PAST_DATE_NOTICE}\n\n${BOOKING_DATE_PROMPT}`); continue; }
          await setBotState(from, 'booking', { ...botState, stage: 'awaitingDuration', isoDate });
          await sendWhatsAppText(from, NEW_DURATION_PROMPT);
          continue;
        }
        if (botState.stage === 'awaitingDuration') {
          const durationMinutes = parseDurationMinutes(normalizedText);
          if (!durationMinutes) { await sendWhatsAppText(from, `No reconocí esa duración.\n\n${NEW_DURATION_PROMPT}`); continue; }
          await setBotState(from, 'booking', { ...botState, stage: 'awaitingPeriod', durationMinutes });
          await sendWhatsAppText(from, NEW_PERIOD_PROMPT);
          continue;
        }
        if (botState.stage === 'awaitingPeriod') {
          const period = parsePeriod(normalizedText);
          if (!period) { await sendWhatsAppText(from, `No reconocí esa opción.\n\n${NEW_PERIOD_PROMPT}`); continue; }
          const { error, slots } = await getAvailableSlots(clinicUser.id, clinicUser.clinic_id, botState.isoDate, period, botState.durationMinutes, undefined, botState.resourceId);
          if (error) { await clearBotState(from); await sendWhatsAppText(from, error); continue; }
          if (!slots.length) {
            await sendWhatsAppText(from, `No hay horarios disponibles esa ${period === 'tarde' ? 'tarde' : 'mañana'} para ${botState.durationMinutes} min.\n\n${NEW_PERIOD_PROMPT}`);
            continue;
          }
          await setBotState(from, 'booking', { ...botState, stage: 'awaitingSlotChoice', slots: slots.map(d => d.toISOString()) });
          const list = slots.map((d, i) => `${i + 1}. ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Guayaquil' })}`).join('\n');
          await sendWhatsAppText(from, `Horarios disponibles:\n\n${list}\n\nResponde con el número del horario que prefieres.${CANCEL_HINT}`);
          continue;
        }
        if (botState.stage === 'awaitingSlotChoice') {
          const chosenIso = botState.slots[Number(normalizedText) - 1];
          if (!chosenIso) { await sendWhatsAppText(from, `Número inválido. Responde con el número de la lista.${CANCEL_HINT}`); continue; }
          await clearBotState(from);
          try {
            const startDate = new Date(chosenIso);
            const staffResourceName = botState.resourceId?.startsWith('staff:') ? botState.resourceName : '';
            const eventId = await createAppointmentEvent(clinicUser.id, botState.patientName, botState.patientPhone, botState.patientEmail, clinicUser.full_name, startDate, botState.durationMinutes * 60000, botState.resourceId, staffResourceName);
            await ensureWhatsAppContactClinic(botState.patientPhone, clinicUser.clinic_id);
            const horaLabel = startDate.toLocaleString('es-ES', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const notice = await notifyPatientOfAppointment(clinicUser, {
              kind: 'booked', patientName: botState.patientName, phone: botState.patientPhone, email: botState.patientEmail,
              eventId, startDate, durationMinutes: botState.durationMinutes,
            });
            await sendWhatsAppText(from, `✅ Cita de ${botState.patientName} agendada para el ${horaLabel} (${botState.durationMinutes} min).\n\n${notice}\n\nEl recordatorio automático por WhatsApp sale el día anterior a la cita.\n\nEscribe *menu* para ver las opciones.`);
          } catch (err) {
            await sendWhatsAppText(from, `❌ No se pudo agendar la cita: ${err.message}\n\nEscribe *menu* para ver las opciones.`);
          }
          continue;
        }
      }

      if (botState?.flow === 'agendaDate' && botState.stage === 'awaitingDate') {
        await clearBotState(from);
        if (!clinicUser.calendar_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        const isoDate = parseFlexibleDate(normalizedText);
        if (!isoDate) {
          await setBotState(from, 'agendaDate', { stage: 'awaitingDate' });
          await sendWhatsAppText(from, `No reconocí esa fecha.\n\n${AGENDA_DATE_PROMPT}`);
          continue;
        }
        await sendWhatsAppText(from, `${await listAppointmentsForDate(clinicUser.id, isoDate, 'Citas')}\n\nEscribe *menu* para ver las opciones.`);
        continue;
      }

      if (botState?.flow === 'agendaMenu') {
        if (!clinicUser.calendar_enabled) { await clearBotState(from); await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        if (normalizedText === '1') { await clearBotState(from); await sendWhatsAppText(from, `${await listTodayAppointments(clinicUser.id)}\n\nEscribe *menu* para ver las opciones.`); continue; }
        if (normalizedText === '2') { await setBotState(from, 'agendaDate', { stage: 'awaitingDate' }); await sendWhatsAppText(from, AGENDA_DATE_PROMPT); continue; }
        if (normalizedText === '3') { await setBotState(from, 'reschedule', { stage: 'awaitingDate' }); await sendWhatsAppText(from, RESCHEDULE_DATE_PROMPT); continue; }
        if (normalizedText === '4') { await setBotState(from, 'delete', { stage: 'awaitingDate' }); await sendWhatsAppText(from, DELETE_DATE_PROMPT); continue; }
        if (normalizedText === '5') { await setBotState(from, 'booking', { stage: 'awaitingPatientName' }); await sendWhatsAppText(from, BOOKING_NAME_PROMPT); continue; }
        await sendWhatsAppText(from, `No reconocí esa opción.\n\n${AGENDA_MENU_TEXT}`);
        continue;
      }

      if (botState?.flow === 'finance' && botState.stage === 'awaitingFinanceChoice') {
        if (!financeChoice) { await sendWhatsAppText(from, `No reconocí esa opción.\n\n${FINANCE_REPORT_MENU_TEXT}`); continue; }
        await clearBotState(from);
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
        await setBotState(from, 'finance', { stage: 'awaitingFinanceChoice' });
        await sendWhatsAppText(from, FINANCE_REPORT_MENU_TEXT);
        continue;
      }

      if (normalizedText === '1' || normalizedText === 'agenda') {
        if (!clinicUser.calendar_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Agenda.'); continue; }
        await setBotState(from, 'agendaMenu', {});
        await sendWhatsAppText(from, AGENDA_MENU_TEXT);
        continue;
      }

      if (financeChoice) {
        if (!clinicUser.finance_enabled) { await sendWhatsAppText(from, 'No tienes acceso al módulo de Finanzas.'); continue; }
        await sendFinanceReportToUser(clinicUser, financeChoice, from);
        continue;
      }

      // Mostrar el menú principal sin limpiar el estado dejaba al bot dentro del flujo anterior:
      // el siguiente “1” se interpretaba como opción de ese flujo, no del menú recién mostrado.
      if (hasActiveState) await clearBotState(from);
      await sendWhatsAppText(from, `Hola ${clinicUser.full_name || ''} 👋\n\n${MENU_TEXT}`);
    } catch (err) {
      console.error('❌ Error respondiendo por WhatsApp:', err.message);
    }
  }
}

/** Envía a cada usuario autorizado un resumen de citas con enlaces para recordar manualmente. */
async function sendAppointmentSummaries(dayOffset = 0, slot = 'morning', startIndex = 0, deadline = Number.POSITIVE_INFINITY) {
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
    ORDER BY cu.id
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
    ORDER BY cu.id
  `;

  let remindersSent = 0;
  let index = startIndex;
  const errors = [];
  for (; index < users.rows.length; index++) {
    if (Date.now() > deadline) return { usersChecked: users.rows.length, remindersSent, errors, nextIndex: index };
    const row = users.rows[index];
    if (isSystemStaffPhone(row.staff_phone)) continue;
    const clinicName = row.general?.name || 'la clínica';
    try {
      if (!(await loadSubscriptionLifecycle(getPool(), row.clinic_id)).canoperate) continue;
      const auth = await getUserOAuth2Client(row.user_id);
      if (!auth) continue;
      const calendar = google.calendar({ version: 'v3', auth });
      const { data } = await calendar.events.list({
        calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
      });

      const appointments = [];
      const staffPhone = normalizeEcuadorPhone(row.staff_phone);
      for (const event of data.items || []) {
        const appointment = parseAppointmentEvent(event);
        if (!appointment) continue;
        const start = new Date(event.start?.dateTime || event.start?.date);
        const hora = event.start?.dateTime
          ? start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Guayaquil' })
          : '';
        const patientName = formatWhatsAppLabel(appointment.patientName, 'Paciente');
        const patientMessage = `Hola ${patientName}, te escribimos de ${formatWhatsAppLabel(clinicName, 'la clínica')}. ` +
          `Te recordamos tu cita para el ${targetDate}${hora ? ` a las ${hora}` : ''}. ` +
          'Por favor confirma tu asistencia respondiendo a este mensaje o comunícate con la clínica.';
        // Enlace abre WhatsApp del staff con el chat del PACIENTE, no del número de la clínica
        const patientPhone = normalizeEcuadorPhone(appointment.phone);
        const link = patientPhone && patientPhone !== staffPhone ? await createShortWaLink(patientPhone, patientMessage, row.clinic_id) : '';
        appointments.push({ ...appointment, patientName, eventId: event.id, hora, link });
      }
      if (!appointments.length) continue;

      const replyStatuses = await getAppointmentReplyStatuses(appointments.map(appointment => appointment.eventId), row.user_id);
      const deliveryStatuses = await getAppointmentDeliveryStatuses(appointments.map(appointment => appointment.eventId), row.user_id);
      const label = dayOffset === 0 ? 'hoy' : 'mañana';
      const lines = appointments.map((appointment, index) => {
        const contact = appointment.link
          ? `\n   💬 Chat del paciente: ${appointment.link}`
          : '\n   ⚠️ Paciente sin número registrado';
        return `${index + 1}. ${appointment.hora || 'Hora pendiente'} · ${appointment.patientName}\n   ${formatAppointmentSummaryStatus(replyStatuses[appointment.eventId], deliveryStatuses[appointment.eventId])}${contact}`;
      });
      const pending = appointments.filter(a => replyStatuses[a.eventId] !== 'confirmed').length;
      const header = `📅 *Agenda de ${label}* (${targetDate}) — ${formatWhatsAppLabel(clinicName, 'la clínica')}\n` +
        `${appointments.length} cita(s) · ${appointments.length - pending} confirmada(s) · ${pending} sin confirmar`;
      try {
        // El staff no necesariamente escribió hoy: fuera de la ventana de 24h se requiere plantilla aprobada
        const withinWindow = await isWithinCustomerServiceWindow(staffPhone);
        const templateName = (process.env.WHATSAPP_TEMPLATE_DAILY_SUMMARY || '').trim();
        const templateLang = (process.env.WHATSAPP_TEMPLATE_DAILY_SUMMARY_LANG || 'es_MX').trim();
        if (withinWindow) {
          const pages = paginateAppointmentSummaryLines(lines, 4);
          for (let page = 0; page < pages.length; page++) {
            const summaryMessage = buildDailySummaryMessage({
              greeting: page === 0 ? `Hola ${formatWhatsAppLabel(row.staff_name, 'equipo')} 👋` : '',
              header: pages.length > 1 ? `${header}\nParte ${page + 1}/${pages.length}` : header,
              lines: pages[page],
              footer: '',
            });
            await sendWhatsAppText(staffPhone, summaryMessage, { clinicId: row.clinic_id });
            if (page + 1 < pages.length) await new Promise(resolve => setTimeout(resolve, SEND_THROTTLE_MS));
          }
        } else if (templateName) {
          const pages = paginateAppointmentSummaryLines(lines, 3);
          for (let page = 0; page < pages.length; page++) {
            const visibleLines = pages[page].map(line => line.replace(/\s*\n+\s*/g, ' — '));
            await sendWhatsAppTemplate(staffPhone, templateName, templateLang, {
              nombre_usuario: formatWhatsAppLabel(row.staff_name, 'equipo'),
              nombre_clinica: formatWhatsAppLabel(clinicName, 'la clínica'),
              fecha: pages.length > 1 ? `${targetDate} (${page + 1}/${pages.length})` : targetDate,
              resumen: visibleLines.join(' | '),
            }, { clinicId: row.clinic_id });
            if (page + 1 < pages.length) await new Promise(resolve => setTimeout(resolve, SEND_THROTTLE_MS));
          }
        } else {
          throw new Error('Fuera de ventana de 24h y no hay WHATSAPP_TEMPLATE_DAILY_SUMMARY configurada');
        }
        remindersSent++;
        await new Promise(resolve => setTimeout(resolve, SEND_THROTTLE_MS));
      } catch (sendErr) {
        errors.push(`user ${row.user_id}, staff ${staffPhone}: ${sendErr.message}`);
      }
    } catch (clinicErr) {
      errors.push(`clinic ${row.clinic_id}: ${clinicErr.message}`);
    }
  }

  return { usersChecked: users.rows.length, remindersSent, errors, nextIndex: null };
}

export default async function handler(req, res) {
  const action = getQueryValue(req.query?.action);

  // Redirección de links cortos wa.me generados por el bot (públicos: solo apuntan a un chat de WhatsApp ya conocido)
  if (req.method === 'GET' && action === 'r') {
    const code = (getQueryValue(req.query?.c) || '').trim();
    const target = code ? await resolveShortWaLink(code) : null;
    if (!target) return res.status(404).send('Enlace no encontrado o expirado');
    return res.redirect(302, target);
  }

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

  if (req.method === 'POST' && action === 'crmSetContactClinic') {
    const user = await requireAuth(req, res);
    if (!user || !requireRole(user, res, 'master_admin')) return;
    res.setHeader('Cache-Control', 'private, no-store');
    let body;
    try { body = JSON.parse((await readRawBody(req)).toString('utf8') || '{}'); }
    catch { return res.status(400).json({ success: false, error: 'JSON inválido' }); }
    try {
      await setWhatsAppContactClinic(body.contactId, body.clinicId ?? null);
      return res.status(200).json({ success: true });
    } catch (error) {
      const status = error.message === 'Contacto inválido' || error.message === 'Clínica inválida' || error.message === 'Contacto no encontrado' ? 400 : 500;
      console.error('Error reasignando clínica de contacto WhatsApp:', error.message);
      return res.status(status).json({ success: false, error: status === 400 ? error.message : 'No se pudo actualizar el contacto' });
    }
  }

  if (req.method === 'GET' && getQueryValue(req.query?.action) === 'sendReminders') {
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }
    try {
      const slot = getQueryValue(req.query?.slot);
      const cursor = Math.max(0, Number(getQueryValue(req.query?.cursor)) || 0);
      const deadline = Date.now() + REMINDER_BUDGET_MS;
      const isAfternoon = slot === 'afternoon';
      const summaryResult = isAfternoon
        ? { usersChecked: 0, remindersSent: 0, errors: [], nextIndex: null }
        : await sendAppointmentSummaries(slot === 'evening' ? 1 : 0, slot === 'evening' ? 'evening' : 'morning', cursor, deadline);
      const patientResult = isAfternoon
        ? await sendPatientAppointmentReminders(1, cursor, deadline)
        : { patientsChecked: 0, sent: 0, errors: [], nextIndex: null };
      const nextIndex = isAfternoon ? patientResult.nextIndex : summaryResult.nextIndex;
      // Con muchas clínicas el lote no cabe en una sola invocación: se continúa donde quedó
      // en vez de morir por timeout dejando pacientes sin avisar y sin ninguna señal.
      if (nextIndex !== null) await resumeReminders(slot, nextIndex);
      return res.status(200).json({ success: true, ...summaryResult, resumedFrom: cursor, nextIndex, patientReminder: patientResult });
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