
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { sql } from '@vercel/postgres';

/** Obtiene un OAuth2 client con los tokens guardados para la clínica. Retorna null si no hay tokens. */
async function getClinicOAuth2Client(clinicId) {
  if (!clinicId) return null;
  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const appUrl = `https://${(process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app').trim()}`;
  try {
    const r = await sql`SELECT access_token, refresh_token, token_expiry, email FROM clinic_oauth_tokens WHERE clinic_id = ${clinicId}`;
    if (!r.rows.length) return null;
    const { access_token, refresh_token, token_expiry, email: connectedEmail } = r.rows[0];
    const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, `${appUrl}/api/calendar`);
    oAuth2.setCredentials({
      access_token,
      refresh_token,
      expiry_date: token_expiry ? new Date(token_expiry).getTime() : null,
    });
    // Auto-refresh y guardar nuevo token
    oAuth2.on('tokens', async (tokens) => {
      await sql`UPDATE clinic_oauth_tokens SET access_token = ${tokens.access_token},
        token_expiry = ${tokens.expiry_date ? new Date(tokens.expiry_date) : null}, updated_at = NOW()
        WHERE clinic_id = ${clinicId}`;
    });
    return { client: oAuth2, email: connectedEmail };
  } catch { return null; }
}

/** Carga settings de una clínica. Devuelve defaults si no hay data o falla. */
async function getClinicConfig(clinicId) {
  const defaults = {
    name: 'BIOSKIN', city: 'Cuenca', tagline: 'Salud y Estética',
    logo_url: 'https://bioskintech.vercel.app/favicon.ico',
    staff_email: process.env.EMAIL_TO || '',
    from_name: 'BIOSKIN Cuenca', signature: 'El equipo de BIOSKIN',
    whatsapp_number: ''
  };
  if (!clinicId) return defaults;
  try {
    const r = await sql`SELECT general, email FROM clinic_settings WHERE clinic_id = ${clinicId}`;
    if (!r.rows.length) return defaults;
    const g = r.rows[0].general || {};
    const e = r.rows[0].email   || {};
    return {
      name:         g.name       || defaults.name,
      city:         g.city       || defaults.city,
      tagline:      g.tagline    || defaults.tagline,
      logo_url:     g.logo_url   || defaults.logo_url,
      staff_email:  e.staff_email || defaults.staff_email,
      from_name:    e.from_name  || `${g.name || defaults.name} ${g.city || defaults.city}`.trim(),
      signature:    e.signature  || `El equipo de ${g.name || defaults.name}`,
      whatsapp_number: e.whatsapp_number || defaults.whatsapp_number,
    };
  } catch {
    return defaults;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Método no permitido' });
  }

  const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const formatDateTime = (dateStr) => {
    if (!dateStr) return 'No especificado';
    try {
      return new Date(dateStr).toLocaleString('es-ES', {
        timeZone: 'America/Guayaquil',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return String(dateStr);
    }
  };

  const buildStaffRecipients = () => {
    const recipients = [
      process.env.EMAIL_TO,
      'salud.bioskin@gmail.com',
      'rafa1227_g@hotmail.com',
      'dannypau.95@gmail.com'
    ]
      .filter(Boolean)
      .map((item) => String(item).trim())
      .join(', ');

    return recipients;
  };

  const { 
    name, 
    email, 
    message, 
    start, 
    end, 
    service, 
    phone,
    notificationType, // 'appointment', 'chatbot_new_conversation', 'chatbot_reactivation', 'chatbot_appointment'
    inactivityMinutes, // para reactivaciones
    eventTitle,
    eventStart,
    eventEnd,
    eventLocation,
    eventDescription,
    eventId,
    eventType,
    actionDate,
    date,
    hours,
    reason,
    totalAffected,
    totalRequested,
    errorCount,
    blockedBy
  } = req.body;

  // ============================================
  // CASO 0: NOTIFICACIONES ADMINISTRATIVAS AL STAFF
  // ============================================
  if (
    notificationType === 'admin_appointment_cancelled' ||
    notificationType === 'admin_block_created' ||
    notificationType === 'admin_block_deleted' ||
    notificationType === 'admin_blocks_deleted'
  ) {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    const notifications = {
      admin_appointment_cancelled: {
        title: '❌ Cita cancelada desde panel administrativo',
        subject: `❌ Cita cancelada - ${eventTitle || 'Agenda BIOSKIN'}`,
        intro: 'Se ha cancelado una cita registrada en Google Calendar.',
        details: [
          ['Evento', eventTitle || 'Sin título'],
          ['Inicio', formatDateTime(eventStart)],
          ['Fin', formatDateTime(eventEnd)],
          ['Ubicación', eventLocation || 'No especificada'],
          ['ID del evento', eventId || 'No disponible'],
          ['Acción ejecutada', formatDateTime(actionDate || new Date().toISOString())],
        ],
      },
      admin_block_created: {
        title: '🚫 Horario bloqueado en agenda',
        subject: `🚫 Horario bloqueado - ${date || 'Agenda BIOSKIN'}`,
        intro: 'Se registró un bloqueo de horarios desde el panel administrativo.',
        details: [
          ['Fecha', date || 'No especificada'],
          ['Horas bloqueadas', Array.isArray(hours) && hours.length > 0 ? hours.join(', ') : 'No especificadas'],
          ['Motivo', reason || 'No especificado'],
          ['Bloqueado por', blockedBy || 'Administrador BIOSKIN'],
          ['Bloqueos creados', `${totalAffected || 0} de ${totalRequested || 0}`],
          ['Errores', String(errorCount || 0)],
          ['Acción ejecutada', formatDateTime(actionDate || new Date().toISOString())],
        ],
      },
      admin_block_deleted: {
        title: '✅ Bloqueo eliminado de agenda',
        subject: `✅ Bloqueo eliminado - ${eventTitle || 'Agenda BIOSKIN'}`,
        intro: 'Se eliminó un bloqueo de horario en Google Calendar.',
        details: [
          ['Evento', eventTitle || 'Sin título'],
          ['Inicio', formatDateTime(eventStart)],
          ['Fin', formatDateTime(eventEnd)],
          ['Motivo original', reason || 'No especificado'],
          ['ID del evento', eventId || 'No disponible'],
          ['Acción ejecutada', formatDateTime(actionDate || new Date().toISOString())],
        ],
      },
      admin_blocks_deleted: {
        title: '✅ Bloqueos eliminados de agenda',
        subject: `✅ Bloqueos eliminados - ${date || 'Agenda BIOSKIN'}`,
        intro: 'Se eliminaron uno o más bloqueos de horario desde el panel administrativo.',
        details: [
          ['Fecha', date || 'No especificada'],
          ['Motivo', reason || 'No especificado'],
          ['Bloqueos eliminados', `${totalAffected || 0} de ${totalRequested || 0}`],
          ['Errores', String(errorCount || 0)],
          ['Acción ejecutada', formatDateTime(actionDate || new Date().toISOString())],
        ],
      },
    };

    const selected = notifications[notificationType];
    const detailsRows = selected.details
      .map(([label, value]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><strong>${escapeHtml(label)}:</strong></td><td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(value)}</td></tr>`)
      .join('');

    const extraDescription = eventDescription
      ? `<div style="margin-top:14px;background:#f7f7f7;border-radius:8px;padding:12px;"><strong>Descripción:</strong><br>${escapeHtml(eventDescription)}</div>`
      : '';

    try {
      await transporter.sendMail({
        from: `Sistema BIOSKIN <${process.env.EMAIL_USER}>`,
        to: buildStaffRecipients(),
        subject: selected.subject,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;padding:20px;">
            <div style="background:linear-gradient(135deg,#8a6b3f 0%,#ba9256 100%);color:#fff;padding:18px 20px;border-radius:12px 12px 0 0;">
              <h2 style="margin:0;font-size:22px;">${selected.title}</h2>
            </div>
            <div style="background:#fff;border:1px solid #ececec;border-top:0;padding:18px 20px;border-radius:0 0 12px 12px;">
              <p style="margin-top:0;color:#333;">${selected.intro}</p>
              <table style="width:100%;border-collapse:collapse;margin-top:10px;">${detailsRows}</table>
              ${extraDescription}
              <p style="margin:16px 0 0;color:#666;font-size:12px;">Mensaje automático del sistema BIOSKIN.</p>
            </div>
          </div>
        `,
      });

      return res.status(200).json({ success: true, message: 'Notificación administrativa enviada' });
    } catch (err) {
      console.error('❌ Error notificación administrativa:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  // ============================================
  // CASO 1: NOTIFICACIÓN DE NUEVA CONVERSACIÓN
  // ============================================
  if (notificationType === 'chatbot_new_conversation') {
    const phoneClean = phone.replace(/\D/g, '');
    const whatsappLink = `https://wa.me/${phoneClean}`;
    const adminPanel = 'https://saludbioskin.vercel.app/chatbot-manager.html';
    const messagePreview = message.length > 150 ? message.substring(0, 150) + '...' : message;
    const safePhone = escapeHtml(phone || 'No disponible');
    const safeMessagePreview = escapeHtml(messagePreview || '');

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    try {
      await transporter.sendMail({
        from: `Chatbot BIOSKIN <${process.env.EMAIL_USER}>`,
        to: buildStaffRecipients(),
        subject: '🆕 [Staff] Nueva conversación WhatsApp - BIOSKIN',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #ba9256 0%, #d4af37 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
              <h2 style="margin: 0;">🆕 Nueva Conversación</h2>
            </div>
            <div style="background: #f9f9f9; padding: 20px; border-radius: 0 0 10px 10px;">
              <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #ba9256;">
                <p style="margin: 8px 0;"><strong>📱 Teléfono:</strong> <a href="${whatsappLink}" style="color: #25D366;">${safePhone}</a></p>
                <p style="margin: 8px 0;"><strong>💬 Mensaje:</strong></p>
                <div style="background: #f5f5f5; padding: 12px; border-radius: 5px; margin-top: 8px;">
                  <p style="margin: 0; white-space: pre-wrap;">${safeMessagePreview}</p>
                </div>
              </div>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${whatsappLink}" style="display: inline-block; background: #25D366; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; font-weight: bold; margin: 5px;">💬 Responder en WhatsApp</a>
                <a href="${adminPanel}" style="display: inline-block; background: #667eea; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; font-weight: bold; margin: 5px;">📊 Ver Panel Admin</a>
              </div>
              <p style="color: #666; font-size: 12px; text-align: center; margin-top: 20px; border-top: 1px solid #ddd; padding-top: 15px;">Notificación automática del chatbot BIOSKIN</p>
            </div>
          </div>
        `
      });
      return res.status(200).json({ success: true, message: 'Notificación enviada' });
    } catch (err) {
      console.error('❌ Error:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  // ============================================
  // CASO 2: REACTIVACIÓN DE CONVERSACIÓN
  // ============================================
  if (notificationType === 'chatbot_reactivation') {
    const phoneClean = phone.replace(/\D/g, '');
    const whatsappLink = `https://wa.me/${phoneClean}`;
    const adminPanel = 'https://saludbioskin.vercel.app/chatbot-manager.html';
    const messagePreview = message.length > 150 ? message.substring(0, 150) + '...' : message;
    const safePhone = escapeHtml(phone || 'No disponible');
    const safeMessagePreview = escapeHtml(messagePreview || '');

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    try {
      await transporter.sendMail({
        from: `Chatbot BIOSKIN <${process.env.EMAIL_USER}>`,
        to: buildStaffRecipients(),
        subject: `🔔 [Staff] Conversación reactivada (${inactivityMinutes} min) - BIOSKIN`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #ba9256 0%, #d4af37 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
              <h2 style="margin: 0;">🔔 Conversación Reactivada</h2>
            </div>
            <div style="background: #f9f9f9; padding: 20px; border-radius: 0 0 10px 10px;">
              <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-bottom: 15px; border-radius: 4px;">
                <strong>⏰ Cliente volvió después de ${inactivityMinutes} minutos de inactividad</strong>
              </div>
              <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #ba9256;">
                <p style="margin: 8px 0;"><strong>📱 Teléfono:</strong> <a href="${whatsappLink}" style="color: #25D366;">${safePhone}</a></p>
                <p style="margin: 8px 0;"><strong>💬 Mensaje:</strong></p>
                <div style="background: #f5f5f5; padding: 12px; border-radius: 5px; margin-top: 8px;">
                  <p style="margin: 0; white-space: pre-wrap;">${safeMessagePreview}</p>
                </div>
              </div>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${whatsappLink}" style="display: inline-block; background: #25D366; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; font-weight: bold; margin: 5px;">💬 Responder en WhatsApp</a>
                <a href="${adminPanel}" style="display: inline-block; background: #667eea; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; font-weight: bold; margin: 5px;">📊 Ver Panel Admin</a>
              </div>
              <p style="color: #666; font-size: 12px; text-align: center; margin-top: 20px; border-top: 1px solid #ddd; padding-top: 15px;">Notificación automática del chatbot BIOSKIN</p>
            </div>
          </div>
        `
      });
      return res.status(200).json({ success: true, message: 'Notificación enviada' });
    } catch (err) {
      console.error('❌ Error:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  // ============================================
  // CASO 3: AGENDAMIENTO DESDE CHATBOT
  // ============================================
  if (notificationType === 'chatbot_appointment') {
    const phoneClean = phone.replace(/\D/g, '');
    const whatsappLink = `https://wa.me/${phoneClean}`;
    
    const dateObj = new Date(message + 'T00:00:00-05:00');
    const dateFormatted = dateObj.toLocaleDateString('es-ES', {
      day: 'numeric', month: 'long', year: 'numeric', weekday: 'long', timeZone: 'America/Guayaquil'
    });
    const safeName = escapeHtml(name || 'Paciente');
    const safePhone = escapeHtml(phone || 'No disponible');
    const safeService = escapeHtml(service || 'No especificado');
    const safeDateFormatted = escapeHtml(dateFormatted || 'No especificada');
    const safeHour = escapeHtml(email || 'No especificada');

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    try {
      await transporter.sendMail({
        from: `Agendamiento BIOSKIN <${process.env.EMAIL_USER}>`,
        to: buildStaffRecipients(),
        subject: `🗓️ [Staff] Nueva cita desde chatbot - ${name} (${dateFormatted})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 25px; border-radius: 10px 10px 0 0; text-align: center;">
              <h2 style="margin: 0; font-size: 28px;">🗓️ ¡Nueva Cita Agendada!</h2>
            </div>
            <div style="background: #f9f9f9; padding: 25px; border-radius: 0 0 10px 10px;">
              <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #28a745;">
                <h3 style="color: #28a745; margin-top: 0;">Detalles de la Cita</h3>
                <table style="width: 100%; border-collapse: collapse;">
                  <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>👤 Paciente:</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${safeName}</td></tr>
                  <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>📱 Teléfono:</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><a href="${whatsappLink}" style="color: #25D366;">${safePhone}</a></td></tr>
                  <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>💆 Tratamiento:</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${safeService}</td></tr>
                  <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>📅 Fecha:</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${safeDateFormatted}</td></tr>
                  <tr><td style="padding: 10px 0;"><strong>⏰ Hora:</strong></td><td style="padding: 10px 0;">${safeHour}</td></tr>
                </table>
              </div>
              <div style="background: #e7f3ff; border-left: 4px solid #2196F3; padding: 15px; border-radius: 4px; margin-bottom: 20px;">
                <p style="margin: 0;"><strong>📌 Recordatorio:</strong> Esta cita ya fue creada en Google Calendar automáticamente.</p>
              </div>
              <div style="text-align: center;">
                <a href="${whatsappLink}" style="display: inline-block; background: #25D366; color: white; padding: 14px 28px; border-radius: 25px; text-decoration: none; font-weight: bold; margin: 8px;">💬 Contactar Paciente</a>
                <a href="https://calendar.google.com" style="display: inline-block; background: #4285F4; color: white; padding: 14px 28px; border-radius: 25px; text-decoration: none; font-weight: bold; margin: 8px;">📅 Ver Calendar</a>
              </div>
              <p style="color: #666; font-size: 12px; text-align: center; margin-top: 25px; border-top: 1px solid #ddd; padding-top: 15px;">Cita agendada a través del chatbot de WhatsApp</p>
            </div>
          </div>
        `
      });
      return res.status(200).json({ success: true, message: 'Notificación enviada' });
    } catch (err) {
      console.error('❌ Error:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  // ============================================
  // CASO 4: AGENDAMIENTO NORMAL (flujo original)
  // ============================================
  if (!name || !email || !message) {
    return res.status(400).json({ success: false, message: 'Faltan datos' });
  }

  // --- Limpia número de teléfono ---
  const phoneClean = phone
    ? phone.replace(/[\s\-+]/g, "").replace(/^0/, "")
    : (message.match(/Teléfono:\s*([\d+\- ]+)/)?.[1] || "").replace(/[\s\-+]/g, "").replace(/^0/, "");

  // --- Extrae datos para WhatsApp cordial ---
  const paciente = name || 'Paciente';
  const tratamiento = service || (message.match(/Servicio:\s*([^\n]+)/)?.[1] || "Tratamiento");
  const fecha = (message.match(/Fecha:\s*([^\n]+)/)?.[1] || "");
  const hora = (message.match(/Hora:\s*([^\n]+)/)?.[1] || "");

  // Cargar config de la clínica (usa clinicId del body si existe, o defaults)
  const clinic = await getClinicConfig(req.body?.clinicId || null);

  // --- Mensaje cordial para WhatsApp (dinamizado por clínica) ---
  const whatsappMessage =
    `Hola ${paciente}, ¡gracias por agendar tu cita en ${clinic.name}! 🧴✨\n` +
    `Hemos recibido tu solicitud para el servicio "${tratamiento}".\n` +
    (fecha && hora ? `Tu cita está programada para el ${fecha} a las ${hora} en ${clinic.city ? clinic.name + ' ' + clinic.city : 'nuestro consultorio'}.\n` : "") +
    `Si tienes alguna consulta, no dudes en responder este mensaje.\n` +
    `¡Nos vemos pronto!\n\n` +
    `— ${clinic.signature}`;

  const whatsappLink = phoneClean
    ? `https://wa.me/593${phoneClean}?text=${encodeURIComponent(whatsappMessage)}`
    : "";

  let calendarSuccess = false;
  let emailSuccess = false;
  let errorDetails = [];

  // --- 1. CREAR EVENTO EN GOOGLE CALENDAR ---
  // Intenta OAuth de la clínica primero; fallback a service account si existe
  try {
    if (start && end) {
      const clinicOAuth = await getClinicOAuth2Client(req.body?.clinicId);
      let auth, calendarId;

      if (clinicOAuth) {
        // ✅ Usa OAuth de la clínica conectada
        auth       = clinicOAuth.client;
        calendarId = 'primary'; // El calendario principal de la cuenta OAuth conectada
        console.log('📅 Usando OAuth de clínica para Calendar:', clinicOAuth.email);
      } else if (process.env.GOOGLE_CREDENTIALS_BASE64) {
        // Fallback: service account legacy
        const creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8'));
        auth = new google.auth.JWT(creds.client_email, undefined, creds.private_key,
          ['https://www.googleapis.com/auth/calendar']);
        calendarId = creds.calendar_id;
        console.log('📅 Usando service account para Calendar');
      } else {
        throw new Error('No hay credenciales de Google configuradas. Conecta la cuenta Gmail de la clínica desde el Master Admin.');
      }

      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.insert({
        calendarId,
        requestBody: {
          summary:     `Cita: ${paciente} - ${email}`,
          description: message,
          start: { dateTime: start, timeZone: 'America/Guayaquil' },
          end:   { dateTime: end,   timeZone: 'America/Guayaquil' },
        },
      });
      console.log('✅ Evento creado en Google Calendar');
      calendarSuccess = true;
    }
  } catch (calErr) {
    console.error('❌ Error en Calendar:', calErr.message);
    errorDetails.push(`Calendar: ${calErr.message}`);
  }

  // --- 2. ENVÍO DE CORREOS: Gmail API OAuth (si hay token) o SMTP fallback ---
  try {
    const clinicOAuth = await getClinicOAuth2Client(req.body?.clinicId);

    const staffEmailHtml = `
      <h2 style="color:#ba9256;margin-bottom:4px;">Nueva cita registrada</h2>
      <p>Hola ${clinic.from_name}, se ha recibido una nueva solicitud de cita.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Paciente:</b></td><td>${escapeHtml(paciente)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Email:</b></td><td>${escapeHtml(email)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Teléfono:</b></td><td>${escapeHtml(phoneClean || 'No registrado')}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Servicio:</b></td><td>${escapeHtml(tratamiento)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Fecha:</b></td><td>${escapeHtml(fecha || 'No especificada')}</td></tr>
        <tr><td style="padding:8px 0;"><b>Hora:</b></td><td>${escapeHtml(hora || 'No especificada')}</td></tr>
      </table>
      ${whatsappLink ? `<a href="${whatsappLink}" style="display:inline-block;background:#25D366;color:#fff;padding:10px 22px;border-radius:8px;font-weight:bold;text-decoration:none;" target="_blank">WhatsApp</a>` : ''}
    `;

    const patientEmailHtml = `
      <div style="font-family:Segoe UI,Arial,sans-serif;">
        <h2 style="color:#ba9256;">¡Tu cita está en proceso!</h2>
        <p>Hola <b>${escapeHtml(paciente)}</b>,<br>Gracias por confiar en <b>${escapeHtml(clinic.name)}</b>. Hemos recibido tu solicitud.</p>
        <pre style="background:#f5f5f5;padding:10px;border-radius:8px;font-family:inherit;white-space:pre-wrap;">${escapeHtml(message)}</pre>
        <p style="margin-top:18px;">En breve te confirmaremos la cita. <b>¿Dudas? Responde este email.</b></p>
        <p style="margin-top:24px;font-size:15px;">— ${escapeHtml(clinic.signature)}</p>
      </div>
    `;

    const staffTo = clinic.staff_email || process.env.EMAIL_TO || '';

    if (clinicOAuth) {
      // ✅ Gmail API con OAuth de la clínica
      console.log('📧 Enviando vía Gmail API OAuth:', clinicOAuth.email);
      const gmail = google.gmail({ version: 'v1', auth: clinicOAuth.client });
      const fromAddr = `${clinic.from_name} <${clinicOAuth.email}>`;

      const makeRaw = (to, subject, html, from) => {
        const msg = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=UTF-8',
          '',
          html,
        ].join('\r\n');
        return Buffer.from(msg).toString('base64url');
      };

      if (staffTo) {
        await gmail.users.messages.send({ userId: 'me', requestBody: {
          raw: makeRaw(staffTo, `🗓️ Nueva cita - ${paciente}${fecha ? ` (${fecha})` : ''}`, staffEmailHtml, fromAddr)
        }});
      }
      await gmail.users.messages.send({ userId: 'me', requestBody: {
        raw: makeRaw(email, `¡Hemos recibido tu cita en ${clinic.name}!`, patientEmailHtml, fromAddr)
      }});
      emailSuccess = true;
      console.log('✅ Correos enviados vía Gmail API');

    } else if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      // Fallback: SMTP legacy
      console.log('📧 Enviando vía SMTP');
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST, port: parseInt(process.env.EMAIL_PORT || '587'),
        secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        tls: { rejectUnauthorized: false }
      });
      if (staffTo) await transporter.sendMail({ from: process.env.EMAIL_USER, to: staffTo, subject: `🗓️ Nueva cita - ${paciente}`, html: staffEmailHtml });
      await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: `¡Hemos recibido tu cita en ${clinic.name}!`, html: patientEmailHtml });
      emailSuccess = true;
    } else {
      throw new Error('No hay cuenta Gmail conectada ni SMTP configurado. Ve a Master Admin → Ajustes de Clínica → Conectar Gmail.');
    }

  } catch (emailErr) {
    console.error('❌ Error enviando correos:', emailErr.message);
    errorDetails.push(`Email: ${emailErr.message}`);
  }

  // --- RESPUESTA FINAL AL CLIENTE ---
  // Si al menos uno de los dos procesos importantes funcionó (Calendar o Email), lo consideramos éxito parcial
  if (calendarSuccess || emailSuccess) {
      if (!calendarSuccess && start && end) {
          console.warn('⚠️ Alerta: Cita procesada pero falló inserción en Calendar.');
      }
      return res.status(200).json({ 
          success: true, 
          message: 'Solicitud procesada',
          details: { calendar: calendarSuccess, email: emailSuccess }
      });
  } else {
    // Si NADA funciona, entonces error 500
    return res.status(500).json({ 
        success: false, 
        message: 'Error al procesar la solicitud',
        errors: errorDetails
    });
  }
}
