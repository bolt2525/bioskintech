import { google } from 'googleapis';
import sendEmailHandler from './sendEmail.js';
import { sql } from '@vercel/postgres';
import { authenticateRequest } from '../lib/admin-auth.js';
import { sendDeveloperAlert } from './admin-auth.js';
import { eventResourceId, resolveResourceId, resourceExtendedProperties } from '../lib/agenda-resources.js';

const isGoogleAuthError = (error) => error?.code === 401 || error?.response?.status === 401 || /invalid_grant|invalid authentication credentials/i.test(error?.message || '');

// ── Helper: obtener OAuth2 client con tokens del usuario ─────────────────────
async function getUserOAuth2Client(userId) {
  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;

  const appBase    = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const redirectUri = `${appBase}/api/calendar`;
  const oAuth2      = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  try {
    const r = await sql`SELECT access_token, refresh_token, token_expiry FROM clinic_oauth_tokens WHERE clinic_user_id = ${userId}`;
    if (!r.rows.length) return null;
    const { access_token, refresh_token, token_expiry } = r.rows[0];
    oAuth2.setCredentials({ access_token, refresh_token, expiry_date: token_expiry ? new Date(token_expiry).getTime() : null });
    // Auto-refresh si el token expiró
    oAuth2.on('tokens', async (tokens) => {
      await sql`
        UPDATE clinic_oauth_tokens SET access_token = ${tokens.access_token}, token_expiry = ${tokens.expiry_date ? new Date(tokens.expiry_date) : null}, updated_at = NOW()
        WHERE clinic_user_id = ${userId}
      `;
    });
    return oAuth2;
  } catch { return null; }
}

// Función consolidada para todas las operaciones de calendario
export default async function handler(req, res) {
  // Configurar headers CORS — origin whitelist, no wildcard
  const reqOrigin = req.headers.origin || '';
  const allowedOrigins = (process.env.ADMIN_CORS_ORIGIN || 'https://bioskintechapp.com,https://bioskintech.vercel.app,http://localhost:5173').split(',').map(s => s.trim());
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { method } = req;
  const { action, code, state } = { ...req.query, ...(req.body || {}) };
  
  console.log(`🔍 Método extraído: ${method}, Acción extraída: ${action}`);

  // ── Callback OAuth de Google ────────────────────────────────────────────
  if (code && state && !action) {
    try {
      const stateRow = await sql`
        DELETE FROM oauth_states
        WHERE state = ${state} AND purpose = 'google_integration' AND expires_at > NOW()
        RETURNING clinic_user_id, return_path
      `;
      if (!stateRow.rows.length) throw new Error('Estado OAuth inválido o expirado');
      const { clinic_user_id: userId, return_path: returnPath } = stateRow.rows[0];
      const targetUser = await sql`SELECT clinic_id FROM clinic_users WHERE id = ${userId} AND is_active = true`;
      if (!targetUser.rows.length) throw new Error('Usuario no disponible');
      const clinicId = targetUser.rows[0].clinic_id;
      const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
      const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
      const redirectUri  = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim() + '/api/calendar';
      const oAuth2       = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const { tokens }   = await oAuth2.getToken(code);
      oAuth2.setCredentials(tokens);

      // Obtener email de la cuenta conectada
      const oauth2Api = google.oauth2({ version: 'v2', auth: oAuth2 });
      const userInfo  = await oauth2Api.userinfo.get();
      const email     = userInfo.data.email;

      await sql`
        INSERT INTO clinic_oauth_tokens (clinic_id, clinic_user_id, access_token, refresh_token, token_expiry, email)
        VALUES (${clinicId}, ${userId}, ${tokens.access_token}, ${tokens.refresh_token}, ${tokens.expiry_date ? new Date(tokens.expiry_date) : null}, ${email})
        ON CONFLICT (clinic_user_id) WHERE clinic_user_id IS NOT NULL DO UPDATE SET
          access_token = ${tokens.access_token},
          refresh_token = COALESCE(${tokens.refresh_token}, clinic_oauth_tokens.refresh_token),
          token_expiry = ${tokens.expiry_date ? new Date(tokens.expiry_date) : null},
          email = ${email},
          updated_at = NOW()
      `;
      await sendDeveloperAlert('Gmail conectado', {
        Clínica: clinicId,
        Usuario: userId,
        Cuenta: email,
        Acción: 'oauthCallback',
      }).catch(e => console.error('[oauth] developer alert error:', e.message));

      // Redirigir a la página que inició el flujo OAuth
      const dest = returnPath || '/gestionestetica/admin/master';
      return res.redirect(302, dest + '?oauth=success');
    } catch (e) {
      console.error('❌ OAuth callback error:', e.message);
      return res.redirect(302, '/admin?oauth=error&msg=' + encodeURIComponent(e.message));
    }
  }

  // Validar que se proporcione una acción
  if (!action) {
    return res.status(400).json({ success: false, message: 'Acción requerida.' });
  }

  // ── Helper: obtener cliente de calendario ──────────────────────────────
  // Agenda disponible únicamente con OAuth válido del usuario autenticado.
  const sessionUser = await authenticateRequest(req);
  if (!sessionUser?.valid || !sessionUser.id) return res.status(401).json({ success: false, message: 'No autenticado' });
  const userId = sessionUser.id;
  const clinicId = sessionUser.effective_clinic_id ?? sessionUser.clinic_id ?? null;
  // Propaga clinicId a req.body para que los mockReqs internos de notificaciones lo incluyan
  if (clinicId && req.body && !req.body.clinicId) req.body.clinicId = clinicId;
  async function getCalendarClient() {
    const oauthClient = await getUserOAuth2Client(userId);
    if (oauthClient) {
      return { calendar: google.calendar({ version: 'v3', auth: oauthClient }), calendarId: 'primary', credentials: { user_id: userId } };
    }
    throw new Error('No tienes una cuenta Gmail conectada. Conecta tu cuenta desde Estado del Sistema.');
  }

  try {
    switch (action) {
      case 'health':
        return res.status(200).json({ success: true, message: 'API Calendar funcionando', hasOAuth: !!(await getUserOAuth2Client(userId)), hasServiceAccount: false });

      case 'getEvents': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await getEvents(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      case 'getDayEvents': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await getDayEvents(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      case 'getCalendarEvents': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await getCalendarEvents(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      case 'blockSchedule': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await blockSchedule(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      case 'getBlockedSchedules': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await getBlockedSchedules(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      case 'deleteBlockedSchedule': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await deleteBlockedSchedule(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      case 'deleteEvent': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await deleteEvent(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      case 'updateEvent': {
        const { calendar, calendarId, credentials } = await getCalendarClient();
        return await updateEvent(req, res, calendar, { ...credentials, calendar_id: calendarId });
      }
      default:
        return res.status(400).json({ success: false, message: 'Acción no válida' });
    }
  } catch (error) {
    if (isGoogleAuthError(error) && userId) {
      await sql`DELETE FROM clinic_oauth_tokens WHERE clinic_user_id = ${userId}`;
      return res.status(200).json({ success: false, calendarNotConfigured: true, requiresReconnect: true, message: 'La conexión de Google expiró o fue revocada. Vuelve a conectar Gmail desde los ajustes de la clínica.' });
    }
    // Calendario no configurado → no es un crash, es un estado esperado
    if (error.message?.includes('No hay cuenta Gmail') || error.message?.includes('No tienes una cuenta Gmail') || error.message?.includes('Credenciales de Google')) {
      return res.status(200).json({ success: false, calendarNotConfigured: true, message: error.message });
    }
    console.error('❌ Error en calendario:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// Función para obtener eventos ocupados (original getEvents.js)
async function getEvents(req, res, calendar, credentials) {
  const { date, resourceId } = req.body;
  if (!date) return res.status(400).json({ error: "Fecha requerida" });

  const start = `${date}T00:00:00-05:00`;
  const end = `${date}T23:59:59-05:00`;

  const events = await calendar.events.list({
    calendarId: credentials.calendar_id,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: "startTime",
  });

  const items = events.data.items || [];
  const occupiedByResource = {};
  for (const e of items) {
    const rid = eventResourceId(e, credentials.user_id);
    (occupiedByResource[rid] ||= []).push({ start: e.start.dateTime, end: e.end.dateTime });
  }

  // Sin resourceId el comportamiento es el histórico: toda la agenda ocupa
  const occupied = resourceId
    ? (occupiedByResource[resourceId] || [])
    : items.map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));

  const fullEvents = items.map((e) => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    start: e.start.dateTime,
    end: e.end.dateTime,
    location: e.location,
    resourceId: eventResourceId(e, credentials.user_id),
  }));

  res.status(200).json({ 
    occupiedTimes: occupied,
    occupiedByResource,
    events: fullEvents 
  });
}

// Función para obtener eventos detallados del día (original getDayEvents.js)
async function getDayEvents(req, res, calendar, credentials) {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ success: false, message: 'Fecha requerida' });
  }

  const start = `${date}T00:00:00-05:00`;
  const end = `${date}T23:59:59-05:00`;

  console.log(`🔍 Buscando eventos para el día ${date}`);

  const response = await calendar.events.list({
    calendarId: credentials.calendar_id,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items || [];
  console.log(`📋 ${events.length} eventos encontrados para ${date}`);

  const formattedEvents = events.map(event => {
    const isBlockEvent = event.summary?.includes('BIOSKIN - BLOQUEO');
    
    return {
      id: event.id,
      summary: event.summary || 'Sin título',
      description: event.description || '',
      start: event.start,
      end: event.end,
      status: event.status,
      htmlLink: event.htmlLink,
      creator: event.creator,
      organizer: event.organizer,
      attendees: event.attendees || [],
      location: event.location || '',
      eventType: isBlockEvent ? 'block' : 'appointment',
      isBlockEvent,
      resourceId: eventResourceId(event, credentials.user_id),
      created: event.created,
      updated: event.updated,
      startDateTime: event.start.dateTime || event.start.date,
      endDateTime: event.end.dateTime || event.end.date
    };
  });

  return res.status(200).json({
    success: true,
    events: formattedEvents,
    totalEvents: formattedEvents.length,
    date,
    message: `${formattedEvents.length} eventos encontrados`
  });
}

// Función para obtener todos los eventos del calendario (original getCalendarEvents.js)
async function getCalendarEvents(req, res, calendar, credentials) {
  const { days = 30 } = req.body;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const hasDateRange = datePattern.test(req.body.startDate || '') && datePattern.test(req.body.endDate || '');
  const startDate = hasDateRange ? new Date(`${req.body.startDate}T00:00:00-05:00`) : new Date();
  const endDate = hasDateRange ? new Date(`${req.body.endDate}T23:59:59-05:00`) : new Date();
  if (!hasDateRange) endDate.setDate(startDate.getDate() + Number(days));
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return res.status(400).json({ success: false, message: 'Rango de fechas inválido' });
  }

  const timeMin = startDate.toISOString();
  const timeMax = endDate.toISOString();

  const response = await calendar.events.list({
    calendarId: credentials.calendar_id,
    timeMin: timeMin,
    timeMax: timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });

  const events = response.data.items || [];

  const formattedEvents = events.map(event => {
    const isBlockEvent = event.summary?.includes('BIOSKIN - BLOQUEO') || event.summary?.includes('BLOQUEO');
    
    return {
      id: event.id,
      summary: event.summary || 'Sin título',
      description: event.description || '',
      start: event.start,
      end: event.end,
      status: event.status,
      htmlLink: event.htmlLink,
      creator: event.creator,
      organizer: event.organizer,
      attendees: event.attendees || [],
      location: event.location || '',
      eventType: isBlockEvent ? 'block' : 'appointment',
      isBlockEvent,
      resourceId: eventResourceId(event, credentials.user_id),
      created: event.created,
      updated: event.updated,
      startDateTime: event.start.dateTime || event.start.date,
      endDateTime: event.end.dateTime || event.end.date,
      timeZone: event.start.timeZone || event.end.timeZone || 'America/Guayaquil'
    };
  });

  const appointmentEvents = formattedEvents.filter(e => e.eventType === 'appointment');
  const blockEvents = formattedEvents.filter(e => e.eventType === 'block');

  return res.status(200).json({
    success: true,
    events: formattedEvents,
    statistics: {
      totalEvents: formattedEvents.length,
      appointments: appointmentEvents.length,
      blocks: blockEvents.length,
      daysQueried: days,
      dateRange: { start: timeMin, end: timeMax }
    },
    message: `${formattedEvents.length} eventos encontrados`
  });
}

// Función para bloquear horarios (original blockSchedule.js)
async function blockSchedule(req, res, calendar, credentials) {
  const { date, hours, reason, adminName = 'Administrador BIOSKIN', resourceIds } = req.body;

  if (!date || !hours || !Array.isArray(hours) || hours.length === 0 || !reason) {
    return res.status(400).json({ 
      success: false, 
      message: 'Fecha, horas y motivo son requeridos' 
    });
  }

  const hourPattern = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
  const validHours = hours.every(hour => hourPattern.test(hour));

  if (!validHours) {
    return res.status(400).json({ 
      success: false, 
      message: 'Formato de hora inválido. Use HH:MM (24h)' 
    });
  }

  // Sin resourceIds se bloquea solo al titular, igual que antes
  const requested = Array.isArray(resourceIds) && resourceIds.length ? resourceIds : [null];
  const targets = [];
  for (const rid of requested) {
    const resolved = await resolveResourceId(credentials.user_id, rid);
    if (!resolved) return res.status(400).json({ success: false, message: 'Recurso inválido' });
    if (!targets.includes(resolved)) targets.push(resolved);
  }

  const createdEvents = [];
  const errors = [];

  const jobs = hours.flatMap(hour => targets.map(target => ({ hour, target })));

  for (const { hour, target } of jobs) {
    try {
      const [h, m] = hour.split(':').map(Number);
      
      const startDateTime = `${date}T${hour.padStart(5, '0')}:00-05:00`;
      const endHour = h + 1;
      const endDateTime = `${date}T${endHour.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:00-05:00`;
      
      console.log(`🕐 Creando bloqueo: ${startDateTime} - ${endDateTime}`);

      const response = await calendar.events.insert({
        calendarId: credentials.calendar_id,
        requestBody: {
          summary: `🚫 BLOQUEADO: ${reason}`,
          description: `Horario bloqueado por administración.\n\n` +
                      `Motivo: ${reason}\n` +
                      `Bloqueado por: ${adminName}\n` +
                      `Fecha de bloqueo: ${new Date().toLocaleString('es-ES', { timeZone: 'America/Guayaquil' })}\n\n` +
                      `Este horario no está disponible para citas de pacientes.`,
          start: { 
            dateTime: startDateTime, 
            timeZone: "America/Guayaquil" 
          },
          end: { 
            dateTime: endDateTime, 
            timeZone: "America/Guayaquil" 
          },
          status: 'confirmed',
          visibility: 'public',
          transparency: 'opaque',
          extendedProperties: resourceExtendedProperties(target, credentials.user_id)
        }
      });

      createdEvents.push({
        eventId: response.data.id,
        hour: hour,
        resourceId: target,
        summary: response.data.summary,
        htmlLink: response.data.htmlLink
      });

      console.log(`✅ Evento creado: ${response.data.id} para ${hour}`);

    } catch (error) {
      console.error(`❌ Error creando evento para ${hour}:`, error);
      errors.push({
        hour: hour,
        error: error.message
      });
    }
  }

  if (createdEvents.length === 0) {
    return res.status(500).json({
      success: false,
      message: 'No se pudo crear ningún bloqueo',
      errors: errors
    });
  }

  // Notificar al staff cuando se crean bloqueos manuales
  try {
    const mockReq = {
      method: 'POST',
      headers: req.headers,
      body: {
        notificationType: 'admin_block_created',
        date,
        hours,
        reason,
        totalAffected: createdEvents.length,
        totalRequested: hours.length,
        errorCount: errors.length,
        blockedBy: adminName,
        actionDate: new Date().toISOString()
      }
    };

    const mockRes = {
      status: (code) => ({
        headers: req.headers,
        json: (data) => {
          console.log(`📧 SendEmail handler respondió con status ${code}:`, data);
          return data;
        }
      }),
      setHeader: () => {}
    };

    await sendEmailHandler(mockReq, mockRes);
    console.log('📧 Notificación de bloqueo creado enviada al staff');
  } catch (emailError) {
    console.error('⚠️ Error enviando notificación de bloqueo creado:', emailError);
  }

  return res.status(200).json({
    success: true,
    message: `${createdEvents.length} horario(s) bloqueado(s) exitosamente`,
    data: {
      createdEvents,
      totalCreated: createdEvents.length,
      totalRequested: hours.length,
      errors: errors
    }
  });
}

// Función para obtener bloqueos existentes (original getBlockedSchedules.js)
async function getBlockedSchedules(req, res, calendar, credentials) {
  const startDate = new Date();
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + 3);

  const response = await calendar.events.list({
    calendarId: credentials.calendar_id,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    q: 'BIOSKIN - BLOQUEO',
    singleEvents: true,
    orderBy: 'startTime'
  });

  const blockEvents = response.data.items || [];
  console.log(`📋 ${blockEvents.length} bloqueos encontrados`);

  const groupedBlocks = {};
  
  blockEvents.forEach(event => {
    const eventDate = event.start.dateTime ? 
      event.start.dateTime.split('T')[0] : 
      event.start.date;
    
    const hour = event.start.dateTime ? 
      event.start.dateTime.split('T')[1].substring(0, 5) : 
      '00:00';

    if (!groupedBlocks[eventDate]) {
      groupedBlocks[eventDate] = {
        date: eventDate,
        hours: [],
        reason: event.summary?.replace('🚫 BLOQUEADO: ', '') || 'Sin motivo',
        created: event.created,
        events: []
      };
    }

    groupedBlocks[eventDate].hours.push(hour);
    groupedBlocks[eventDate].events.push({
      id: event.id,
      hour: hour,
      summary: event.summary,
      description: event.description,
      resourceId: eventResourceId(event, credentials.user_id),
      htmlLink: event.htmlLink
    });
  });

  const blocks = Object.values(groupedBlocks);

  return res.status(200).json({
    success: true,
    data: {
      blocks: blocks,
      totalBlocks: blocks.length,
      totalEvents: blockEvents.length
    }
  });
}

// Función para eliminar bloqueo específico (original deleteBlockedSchedule.js)
async function deleteBlockedSchedule(req, res, calendar, credentials) {
  const { eventIds, date, reason } = req.body;

  if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'IDs de eventos requeridos'
    });
  }

  const deletedEvents = [];
  const errors = [];

  for (const eventId of eventIds) {
    try {
      await calendar.events.delete({
        calendarId: credentials.calendar_id,
        eventId: eventId,
      });
      
      deletedEvents.push(eventId);
      console.log(`✅ Evento eliminado: ${eventId}`);
      
    } catch (error) {
      console.error(`❌ Error eliminando evento ${eventId}:`, error);
      errors.push({
        eventId: eventId,
        error: error.message
      });
    }
  }

  // Enviar notificación por email si se eliminaron bloqueos
  if (deletedEvents.length > 0) {
    try {
      console.log(`📧 Iniciando envío de notificación para ${deletedEvents.length} bloqueos eliminados`);

      const emailBody = {
        notificationType: 'admin_blocks_deleted',
        date,
        reason: reason || 'No especificado',
        totalAffected: deletedEvents.length,
        totalRequested: eventIds.length,
        errorCount: errors.length,
        actionDate: new Date().toISOString()
      };

      console.log('📧 Enviando notificación de bloques eliminados al staff');
        
      // Crear objetos mock de request y response para llamar al sendEmail handler directamente
      const mockReq = {
        method: 'POST',
        headers: req.headers,
        body: emailBody
      };
      
      const mockRes = {
        status: (code) => ({
          json: (data) => {
            console.log(`📧 SendEmail handler respondió con status ${code}:`, data);
            return data;
          }
        }),
        setHeader: () => {}
      };

      // Llamar directamente al handler de sendEmail
      await sendEmailHandler(mockReq, mockRes);
      console.log('📧 Notificación de eliminación de bloqueos enviada exitosamente via handler directo');
      
    } catch (emailError) {
      console.error('⚠️ Error enviando notificación de eliminación de bloqueos:', emailError);
      console.error(`⚠️ Stack trace:`, emailError.stack);
    }
  }

  return res.status(200).json({
    success: true,
    message: `${deletedEvents.length} evento(s) eliminado(s) exitosamente`,
    data: {
      deletedEvents,
      totalDeleted: deletedEvents.length,
      totalRequested: eventIds.length,
      errors: errors
    }
  });
}

// Función para eliminar evento individual (original deleteEvent.js)
async function deleteEvent(req, res, calendar, credentials) {
  const { eventId, eventType, date } = req.body;

  if (!eventId) {
    return res.status(400).json({ success: false, message: 'ID del evento requerido' });
  }

  console.log(`🗑️ Eliminando evento: ${eventId} (tipo: ${eventType})`);

  // Obtener información del evento antes de eliminarlo
  let eventDetails = null;
  try {
    const eventResponse = await calendar.events.get({
      calendarId: credentials.calendar_id,
      eventId: eventId,
    });
    eventDetails = eventResponse.data;
  } catch (getError) {
    return res.status(404).json({
      success: false,
      message: 'Evento no encontrado'
    });
  }

  await calendar.events.delete({
    calendarId: credentials.calendar_id,
    eventId: eventId,
  });

  console.log(`✅ Evento eliminado exitosamente: ${eventId}`);

  // Enviar notificación por email
  try {
    console.log(`📧 Iniciando envío de notificación para evento: ${eventId}, tipo: ${eventType}`);

    // Extraer información relevante del evento
    const eventTitle = eventDetails?.summary || 'Sin título';
    const eventStart = eventDetails?.start?.dateTime || eventDetails?.start?.date || '';
    const eventEnd = eventDetails?.end?.dateTime || eventDetails?.end?.date || '';
    const eventLocation = eventDetails?.location || '';
    const eventDescription = eventDetails?.description || '';
    
    console.log(`📧 Detalles del evento: ${eventTitle} - ${eventStart} to ${eventEnd}`);
    
    const notificationType = eventType === 'appointment'
      ? 'admin_appointment_cancelled'
      : 'admin_block_deleted';

    const emailBody = {
      notificationType,
      eventTitle,
      eventStart,
      eventEnd,
      eventLocation,
      eventDescription,
      eventId,
      eventType,
      reason: eventType === 'block'
        ? eventTitle?.replace('🚫 BLOQUEADO: ', '') || 'No especificado'
        : undefined,
      actionDate: new Date().toISOString()
    };

    console.log('📧 Enviando notificación de eliminación/cancelación al staff');
      
    // Crear objetos mock de request y response para llamar al sendEmail handler directamente
    const mockReq = {
      method: 'POST',
      headers: req.headers,
      body: emailBody
    };
    
    const mockRes = {
      status: (code) => ({
        json: (data) => {
          console.log(`📧 SendEmail handler respondió con status ${code}:`, data);
          return data;
        }
      }),
      setHeader: () => {}
    };

    // Llamar directamente al handler de sendEmail
    await sendEmailHandler(mockReq, mockRes);
    console.log('📧 Notificación enviada exitosamente via handler directo');
    
  } catch (emailError) {
    console.error(`⚠️ Error enviando notificación de ${eventType === 'appointment' ? 'cancelación' : 'eliminación de bloqueo'}:`, emailError);
    console.error(`⚠️ Stack trace:`, emailError.stack);
  }

  return res.status(200).json({
    success: true,
    message: eventType === 'appointment' 
      ? 'Cita cancelada exitosamente' 
      : 'Bloqueo eliminado exitosamente',
    eventId,
    eventType,
    date
  });
}

async function updateEvent(req, res, calendar, credentials) {
  const { eventId, eventType, summary, description, date, startTime, endTime } = req.body;
  if (!eventId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'Evento y fecha válidos son requeridos' });
  }
  const parsedDate = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    return res.status(400).json({ success: false, message: 'Fecha inválida' });
  }
  if (eventType !== 'appointment' && eventType !== 'block') {
    return res.status(400).json({ success: false, message: 'Tipo de evento inválido' });
  }
  if ((startTime && !/^\d{2}:\d{2}$/.test(startTime)) || (endTime && !/^\d{2}:\d{2}$/.test(endTime))) {
    return res.status(400).json({ success: false, message: 'Formato de hora inválido' });
  }
  if ((startTime && !endTime) || (!startTime && endTime) || (startTime && endTime && startTime >= endTime)) {
    return res.status(400).json({ success: false, message: 'El horario del evento no es válido' });
  }

  const requestBody = {};
  if (summary !== undefined) {
    const normalizedSummary = String(summary).trim().slice(0, 300);
    requestBody.summary = eventType === 'appointment' && !/^Cita:\s*/i.test(normalizedSummary)
      ? `Cita: ${normalizedSummary}`
      : normalizedSummary;
  }
  if (description !== undefined) requestBody.description = String(description).slice(0, 5000);
  if (startTime && endTime) {
    requestBody.start = { dateTime: `${date}T${startTime}:00-05:00`, timeZone: 'America/Guayaquil' };
    requestBody.end = { dateTime: `${date}T${endTime}:00-05:00`, timeZone: 'America/Guayaquil' };
  }
  const response = await calendar.events.patch({ calendarId: credentials.calendar_id, eventId, requestBody });
  const event = response.data;
  return res.status(200).json({ success: true, event: {
    id: event.id,
    summary: event.summary || 'Sin título',
    description: event.description || '',
    start: event.start,
    end: event.end,
    location: event.location || '',
    eventType,
    isBlockEvent: eventType === 'block',
    resourceId: eventResourceId(event, credentials.user_id),
  }});
}