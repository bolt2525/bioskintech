import { google } from 'googleapis';
import { sql } from '@vercel/postgres';
import { resolveResourceId, resourceExtendedProperties, rangesOverlap, eventResourceId, isWithinWorkHours, isValidFutureLocalDateTime } from '../lib/agenda-resources.js';

const isGoogleAuthError = (error) => error?.code === 401 || error?.response?.status === 401 || /invalid_grant|invalid authentication credentials/i.test(error?.message || '');
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const rateLimitStore = new Map();

function sanitizeText(value, maxLength = 160) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function getClientIp(req) {
  const raw = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  return Array.isArray(raw) ? raw[0] : String(raw).split(',')[0].trim();
}

function isRateLimited(req, clinicSlug, username) {
  const key = `${getClientIp(req)}:${String(clinicSlug || '').trim().toLowerCase()}:${String(username || '').trim().toLowerCase()}`;
  const now = Date.now();
  const entries = rateLimitStore.get(key) || [];
  const recent = entries.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitStore.set(key, recent);
    return true;
  }
  recent.push(now);
  rateLimitStore.set(key, recent);
  return false;
}

function parseClock(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function getTurnstileAllowedHosts() {
  const rawHosts = `${process.env.TURNSTILE_HOSTNAMES || ''},${process.env.APP_URL || ''}`;
  const hosts = rawHosts
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
    .map((host) => host.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase());

  const normalized = new Set(hosts);
  if (process.env.NODE_ENV !== 'production') {
    normalized.add('localhost');
    normalized.add('127.0.0.1');
  }
  return [...normalized].filter(Boolean);
}

async function verifyTurnstileToken(req, token) {
  const secret = (process.env.TURNSTILE_SECRET || '').trim();
  if (!secret) {
    return process.env.NODE_ENV === 'production'
      ? { ok: false, error: 'La verificación de seguridad no está disponible.' }
      : { ok: true };
  }

  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, error: 'Confirma que no eres un robot para reservar.' };
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret,
      response: token.trim(),
      remoteip: getClientIp(req),
    }).toString(),
  });

  if (!response.ok) {
    return { ok: false, error: 'La verificación de seguridad falló. Inténtalo de nuevo.' };
  }

  const result = await response.json();
  const allowedHosts = getTurnstileAllowedHosts();
  if (!result?.success) {
    return { ok: false, error: 'La verificación anti-bot falló. Inténtalo de nuevo.' };
  }

  if (allowedHosts.length && !allowedHosts.includes(String(result?.hostname || '').toLowerCase())) {
    return { ok: false, error: 'El host de la solicitud no está autorizado.' };
  }

  return { ok: true };
}

async function getUserOAuth2Client(userId) {
  if (!userId) return null;
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const r = await sql`SELECT access_token, refresh_token, token_expiry, email FROM clinic_oauth_tokens WHERE clinic_user_id = ${userId}`;
  if (!r.rows.length) return null;
  const { access_token, refresh_token, token_expiry, email } = r.rows[0];
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, `${appUrl}/api/calendar`);
  oauth2.setCredentials({ access_token, refresh_token, expiry_date: token_expiry ? new Date(token_expiry).getTime() : null });
  oauth2.on('tokens', async (tokens) => {
    await sql`UPDATE clinic_oauth_tokens SET access_token = ${tokens.access_token}, token_expiry = ${tokens.expiry_date ? new Date(tokens.expiry_date) : null}, updated_at = NOW() WHERE clinic_user_id = ${userId}`;
  });
  return { client: oauth2, email };
}

async function findResourceConflict(oauthClient, userId, resourceId, start, end) {
  const calendar = google.calendar({ version: 'v3', auth: oauthClient });
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Rango de fechas inválido');
  }
  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date(startMs).toISOString(),
    timeMax: new Date(endMs).toISOString(),
    singleEvents: true,
  });
  for (const ev of data.items || []) {
    if (ev.status === 'cancelled') continue;
    if (eventResourceId(ev, userId) !== resourceId) continue;
    const evStart = new Date(ev.start?.dateTime || ev.start?.date).getTime();
    const evEnd = new Date(ev.end?.dateTime || ev.end?.date).getTime();
    if (rangesOverlap(startMs, endMs, evStart, evEnd)) return ev.summary || 'evento existente';
  }
  return null;
}

async function getPublicAvailability(req, res) {
  const clinicSlug = sanitizeText(req.query?.clinicSlug, 120);
  const username = sanitizeText(req.query?.username, 80);
  const date = sanitizeText(req.query?.date, 20);
  const service = sanitizeText(req.query?.service, 200);
  const requestedResource = sanitizeText(req.query?.resource_id, 40);
  const resourceRequest = requestedResource === 'owner' ? '' : requestedResource;
  if (!clinicSlug || !username || !date || !service) {
    return res.status(400).json({ success: false, error: 'Selecciona fecha y tratamiento para ver horarios.' });
  }

  const userRow = await sql`
    SELECT cu.id, cu.clinic_id, cu.full_name, cu.username, cu.public_booking_enabled,
      cu.multi_resource_enabled, c.name AS clinic_name, c.slug AS clinic_slug
    FROM clinic_users cu
    JOIN clinics c ON c.id = cu.clinic_id
    WHERE c.slug = ${clinicSlug} AND cu.username = ${username} AND cu.is_active = true
    LIMIT 1
  `;
  if (!userRow.rows.length) return res.status(404).json({ success: false, error: 'El enlace de agendamiento no existe o no está activo.' });
  const professional = userRow.rows[0];
  if (!professional.public_booking_enabled) return res.status(403).json({ success: false, error: 'Este profesional no tiene habilitado el agendamiento público.' });

  const settingsRows = await sql`SELECT treatments, agenda FROM clinic_settings WHERE clinic_id = ${professional.clinic_id} LIMIT 1`;
  const settings = settingsRows.rows[0] || {};
  const treatments = Array.isArray(settings.treatments) ? settings.treatments : [];
  const durations = settings.agenda && typeof settings.agenda === 'object' ? settings.agenda.treatment_durations || {} : {};
  const treatment = treatments
    .map((name) => ({ name: String(name || '').trim(), durationMinutes: Number(durations[name] || 0) }))
    .find((item) => item.name === service && Number.isFinite(item.durationMinutes) && item.durationMinutes >= 30 && item.durationMinutes <= 180);
  if (!treatment) return res.status(400).json({ success: false, error: 'Selecciona un tratamiento disponible para reservar.' });
  if (!isValidFutureLocalDateTime(date, '23:59')) return res.status(400).json({ success: false, error: 'Selecciona una fecha futura válida.' });
  if (resourceRequest && resourceRequest.startsWith('staff:') && !professional.multi_resource_enabled) {
    return res.status(400).json({ success: false, error: 'El agendamiento multiusuario no está habilitado.' });
  }

  const resourceId = await resolveResourceId(professional.id, resourceRequest || undefined);
  if (!resourceId) return res.status(400).json({ success: false, error: 'Recurso de agenda inválido.' });
  const resourceRow = resourceId.startsWith('staff:')
    ? await sql`SELECT work_hours FROM clinic_staff_resources WHERE id = ${parseInt(resourceId.replace('staff:', ''), 10)} AND owner_user_id = ${professional.id} AND active = true`
    : { rows: [{ work_hours: {} }] };
  const workHours = resourceRow.rows[0]?.work_hours || {};
  const workStart = workHours.start_hour || settings.agenda?.start_hour || '08:00';
  const workEnd = workHours.end_hour || settings.agenda?.end_hour || '19:00';
  const startMinutes = parseClock(workStart);
  const endMinutes = parseClock(workEnd);
  const configuredStep = Number(settings.agenda?.slot_minutes);
  const step = configuredStep >= 15 && configuredStep <= 120 ? configuredStep : 30;
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return res.status(200).json({ success: true, slots: [], message: 'No hay una jornada válida configurada.' });
  }

  const oauth = await getUserOAuth2Client(professional.id);
  if (!oauth) return res.status(503).json({ success: false, error: 'Este profesional aún no tiene agenda conectada.' });
  const calendar = google.calendar({ version: 'v3', auth: oauth.client });
  const dayStart = new Date(`${date}T00:00:00-05:00`);
  const dayEnd = new Date(`${date}T23:59:59-05:00`);
  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
  });
  const busy = (data.items || [])
    .filter((event) => event.status !== 'cancelled' && eventResourceId(event, professional.id) === resourceId)
    .map((event) => ({
      start: new Date(event.start?.dateTime || event.start?.date).getTime(),
      end: new Date(event.end?.dateTime || event.end?.date).getTime(),
    }))
    .filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end));
  const slots = [];
  for (let minutes = startMinutes; minutes + treatment.durationMinutes <= endMinutes; minutes += step) {
    const hour = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    if (!isValidFutureLocalDateTime(date, hour)) continue;
    const start = new Date(`${date}T${hour}:00-05:00`).getTime();
    const end = start + treatment.durationMinutes * 60_000;
    if (!busy.some((event) => rangesOverlap(start, end, event.start, event.end))) slots.push(hour);
  }
  return res.status(200).json({ success: true, slots, durationMinutes: treatment.durationMinutes });
}

function emailHtml({ clinicName, patientName, service, date, time, professionalName, resourceName }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;border:1px solid #f0e7db;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#8a6b3f 0%,#ba9256 100%);padding:20px;color:#fff;">
        <h2 style="margin:0;font-size:24px;">¡Solicitud de cita recibida!</h2>
      </div>
      <div style="padding:22px;background:#fff; color:#333;">
        <p>Hola <strong>${patientName}</strong>,</p>
        <p>Hemos recibido tu solicitud para <strong>${service}</strong> en <strong>${clinicName}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px;">
          <tr><td style="padding:8px 0;color:#666;width:35%;">Profesional</td><td style="padding:8px 0;font-weight:600;">${professionalName}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Recurso</td><td style="padding:8px 0;font-weight:600;">${resourceName || 'Principal'}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Fecha</td><td style="padding:8px 0;font-weight:600;">${date}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Hora</td><td style="padding:8px 0;font-weight:600;">${time}</td></tr>
        </table>
        <p style="margin-top:16px;">Pronto recibirás la confirmación definitiva por correo o WhatsApp.</p>
      </div>
    </div>
  `;
}

function clinicNotificationHtml({ clinicName, patientName, patientEmail, phone, service, date, time, professionalName, resourceName }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#333;">
      <h2 style="color:#8a6b3f;">Nueva cita desde la agenda pública</h2>
      <p>Se recibió una nueva solicitud para <strong>${service}</strong> en <strong>${clinicName}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:7px 0;color:#666;width:35%;">Paciente</td><td style="padding:7px 0;font-weight:600;">${patientName}</td></tr>
        <tr><td style="padding:7px 0;color:#666;">Correo</td><td style="padding:7px 0;font-weight:600;">${patientEmail}</td></tr>
        <tr><td style="padding:7px 0;color:#666;">Teléfono</td><td style="padding:7px 0;font-weight:600;">${phone}</td></tr>
        <tr><td style="padding:7px 0;color:#666;">Profesional</td><td style="padding:7px 0;font-weight:600;">${professionalName}</td></tr>
        <tr><td style="padding:7px 0;color:#666;">Recurso</td><td style="padding:7px 0;font-weight:600;">${resourceName || 'Principal'}</td></tr>
        <tr><td style="padding:7px 0;color:#666;">Fecha y hora</td><td style="padding:7px 0;font-weight:600;">${date}, ${time}</td></tr>
      </table>
    </div>
  `;
}

function buildRawEmail({ from, to, subject, html }) {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');
  return Buffer.from(message).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method === 'GET') return getPublicAvailability(req, res);
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Método no permitido' });

  const body = req.body || {};
  const turnstileToken = body.turnstileToken || body['cf-turnstile-response'] || body.token || '';
  const honeyPot = body.website || body.website_url || body.honeypot || '';

  if (honeyPot) {
    return res.status(403).json({ success: false, error: 'Solicitud rechazada.' });
  }

  const clinicSlug = sanitizeText(body.clinicSlug, 120);
  const username = sanitizeText(body.username, 80);
  const name = sanitizeText(body.name, 120);
  const email = sanitizeText(body.email, 160).toLowerCase();
  const phone = sanitizeText(body.phone, 30);
  const service = sanitizeText(body.service, 200);
  const date = sanitizeText(body.date, 20);
  const time = sanitizeText(body.time, 15);
  const resource_id = body.resource_id;

  if (!clinicSlug || !username || !name || !email || !phone || !service || !date || !time) {
    return res.status(400).json({ success: false, error: 'Nombre, correo, teléfono, tratamiento, fecha y hora son obligatorios.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'El correo no es válido.' });
  }

  if (!/^[0-9+()\-\s]{7,20}$/.test(phone)) {
    return res.status(400).json({ success: false, error: 'El teléfono no es válido.' });
  }

  if (!isValidFutureLocalDateTime(date, time)) {
    return res.status(400).json({ success: false, error: 'Selecciona una fecha y hora futuras válidas.' });
  }

  if (isRateLimited(req, clinicSlug, username)) {
    return res.status(429).json({ success: false, error: 'Demasiadas solicitudes desde esta dirección. Inténtalo más tarde.' });
  }

  const turnstileCheck = await verifyTurnstileToken(req, turnstileToken);
  if (!turnstileCheck.ok) {
    return res.status(403).json({ success: false, error: turnstileCheck.error || 'La verificación anti-bot falló.' });
  }

  const userRow = await sql`
        SELECT cu.id, cu.clinic_id, cu.full_name, cu.username, cu.phone, cu.public_booking_enabled,
          cu.multi_resource_enabled, c.name AS clinic_name, c.slug AS clinic_slug
    FROM clinic_users cu
    JOIN clinics c ON c.id = cu.clinic_id
    WHERE c.slug = ${clinicSlug} AND cu.username = ${username} AND cu.is_active = true
    LIMIT 1
  `;

  if (!userRow.rows.length) {
    return res.status(404).json({ success: false, error: 'El enlace de agendamiento no existe o no está activo.' });
  }

  const professional = userRow.rows[0];
  if (!professional.public_booking_enabled) {
    return res.status(403).json({ success: false, error: 'Este profesional no tiene habilitado el agendamiento público.' });
  }

  const settingsRows = await sql`
    SELECT treatments, agenda
    FROM clinic_settings
    WHERE clinic_id = ${professional.clinic_id}
    LIMIT 1
  `;
  const settings = settingsRows.rows[0] || {};
  const treatments = Array.isArray(settings.treatments) ? settings.treatments : [];
  const durations = settings.agenda && typeof settings.agenda === 'object' ? settings.agenda.treatment_durations || {} : {};
  const publishedTreatment = treatments
    .map((name) => ({ name: String(name || '').trim(), durationMinutes: Number(durations[name] || 0) }))
    .find((t) => t.name === service && Number.isFinite(t.durationMinutes) && t.durationMinutes >= 30 && t.durationMinutes <= 180);
  if (!publishedTreatment) {
    return res.status(400).json({ success: false, error: 'Selecciona un tratamiento disponible para reservar.' });
  }

  if (resource_id && String(resource_id).startsWith('staff:') && !professional.multi_resource_enabled) {
    return res.status(400).json({ success: false, error: 'El agendamiento multiusuario no está habilitado.' });
  }

  const bookingResourceId = await resolveResourceId(professional.id, resource_id);
  if (!bookingResourceId) {
    return res.status(400).json({ success: false, error: 'Recurso de agenda inválido' });
  }

  const resourceNameRow = bookingResourceId.startsWith('staff:')
    ? await sql`SELECT name, work_hours FROM clinic_staff_resources WHERE id = ${parseInt(bookingResourceId.replace('staff:', ''), 10)} AND owner_user_id = ${professional.id} AND active = true`
    : { rows: [{ name: professional.full_name || professional.username, work_hours: {} }] };
  const resourceWorkHours = resourceNameRow.rows[0]?.work_hours || {};
  const workStart = resourceWorkHours.start_hour || settings.agenda?.start_hour || '08:00';
  const workEnd = resourceWorkHours.end_hour || settings.agenda?.end_hour || '19:00';
  if (!isWithinWorkHours(time, publishedTreatment.durationMinutes, workStart, workEnd)) {
    return res.status(400).json({ success: false, error: `El horario debe permitir completar el tratamiento entre ${workStart} y ${workEnd}.` });
  }

  const oauth = await getUserOAuth2Client(professional.id);
  if (!oauth) {
    return res.status(503).json({ success: false, error: 'Este profesional aún no tiene Gmail conectado para agendar citas.' });
  }

  const startDate = new Date(`${date}T${time}:00-05:00`);
  const endDate = new Date(startDate.getTime() + publishedTreatment.durationMinutes * 60_000);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ success: false, error: 'La fecha y la hora no son válidas.' });
  }

  const conflict = await findResourceConflict(oauth.client, professional.id, bookingResourceId, startDate.toISOString(), endDate.toISOString());
  if (conflict) {
    return res.status(409).json({ success: false, error: `Ese horario ya está ocupado para ${resourceNameRow.rows[0]?.name || 'este profesional'}.` });
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth.client });
  const eventBody = {
    summary: `Cita: ${name} - ${email}`,
    description: [
      `Paciente: ${name}`,
      `Email: ${email}`,
      `Teléfono: ${phone || 'No informado'}`,
      `Servicio: ${service}`,
      `Profesional: ${professional.full_name || professional.username}`,
      `Enlace público: ${professional.clinic_slug}/${professional.username}`,
    ].join('\n'),
    start: { dateTime: startDate.toISOString(), timeZone: 'America/Guayaquil' },
    end: { dateTime: endDate.toISOString(), timeZone: 'America/Guayaquil' },
    extendedProperties: resourceExtendedProperties(bookingResourceId, professional.id),
  };

  try {
    await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
  } catch (error) {
    if (isGoogleAuthError(error)) {
      await sql`DELETE FROM clinic_oauth_tokens WHERE clinic_user_id = ${professional.id}`;
      return res.status(409).json({ success: false, error: 'La conexión de Google expiró. Pide al profesional que la reconecte.' });
    }
    console.error('[public-booking] calendar insert error:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo crear la cita. Inténtalo de nuevo.' });
  }

  const html = emailHtml({
    clinicName: professional.clinic_name,
    patientName: name,
    service,
    date: new Date(startDate).toLocaleDateString('es-ES', { timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    time: new Date(startDate).toLocaleTimeString('es-ES', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false }),
    professionalName: professional.full_name || professional.username,
    resourceName: resourceNameRow.rows[0]?.name || 'Principal',
  });
  const clinicHtml = clinicNotificationHtml({
    clinicName: professional.clinic_name,
    patientName: name,
    patientEmail: email,
    phone,
    service,
    date: new Date(startDate).toLocaleDateString('es-ES', { timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    time: new Date(startDate).toLocaleTimeString('es-ES', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false }),
    professionalName: professional.full_name || professional.username,
    resourceName: resourceNameRow.rows[0]?.name || 'Principal',
  });

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth.client });
    const from = `${professional.clinic_name} <${oauth.email}>`;
    await Promise.all([
      gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: buildRawEmail({ from, to: email, subject: `Confirmación de cita en ${professional.clinic_name}`, html }) },
      }),
      gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: buildRawEmail({ from, to: oauth.email, subject: `Nueva cita pública: ${name} - ${service}`, html: clinicHtml }) },
      }),
    ]);
  } catch (error) {
    if (isGoogleAuthError(error)) {
      await sql`DELETE FROM clinic_oauth_tokens WHERE clinic_user_id = ${professional.id}`;
      return res.status(409).json({ success: false, error: 'La conexión de Gmail expiró. Pide al profesional que la reconecte antes de reservar.' });
    }
    console.error('[public-booking] confirmation email error:', error.message);
    return res.status(200).json({
      success: true,
      message: 'Cita agendada, pero no se pudo enviar el correo de confirmación. La clínica debe revisar su conexión de Gmail.',
      data: { clinicSlug: professional.clinic_slug, username: professional.username, resourceId: bookingResourceId, start: startDate.toISOString(), end: endDate.toISOString() },
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Cita agendada correctamente.',
    data: {
      clinicSlug: professional.clinic_slug,
      username: professional.username,
      resourceId: bookingResourceId,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
  });
}

