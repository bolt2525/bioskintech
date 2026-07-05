
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

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

  // --- Mensaje cordial para WhatsApp ---
  const whatsappMessage =
    `Hola ${paciente}, ¡gracias por agendar tu cita en BIOSKIN! 🧴✨\n` +
    `Hemos recibido tu solicitud para el servicio “${tratamiento}”.\n` +
    (fecha && hora ? `Tu cita está programada para el ${fecha} a las ${hora} en nuestro consultorio Bioskin Cuenca.\n` : "") +
    `Si tienes alguna consulta, no dudes en responder este mensaje.\n` +
    `¡Nos vemos pronto!\n\n` +
    `— El equipo de BIOSKIN Salud y Estética`;

  const whatsappLink = phoneClean
    ? `https://wa.me/593${phoneClean}?text=${encodeURIComponent(whatsappMessage)}`
    : "";

  let calendarSuccess = false;
  let emailSuccess = false;
  let errorDetails = [];

  // --- 1. INTENTO DE CREAR EVENTO EN GOOGLE CALENDAR (PRIORIDAD) ---
  try {
    if (start && end) {
      if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
          throw new Error('Credenciales de Google no configuradas');
      }

      const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8');
      const credentials = JSON.parse(decoded);

      const auth = new google.auth.JWT(
        credentials.client_email,
        undefined,
        credentials.private_key,
        ['https://www.googleapis.com/auth/calendar']
      );

      const calendar = google.calendar({ version: 'v3', auth });

      await calendar.events.insert({
        calendarId: credentials.calendar_id,
        requestBody: {
          summary: `Cita: ${paciente} - ${email}`,
          description: message,
          start: { dateTime: start, timeZone: "America/Guayaquil" },
          end: { dateTime: end, timeZone: "America/Guayaquil" }
        }
      });
      console.log("✅ Evento creado exitosamente en Google Calendar");
      calendarSuccess = true;
    } else {
      console.log("⚠️ No se encontró fecha u hora válida en el body para Calendar.");
    }
  } catch (calErr) {
      console.error('❌ Error creando evento en Calendar:', calErr);
      errorDetails.push(`Calendar: ${calErr.message}`);
  }

  // --- Nodemailer setup ---
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT),
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false // Bypass self-signed certs (importante para entornos locales/dev)
    }
  });

  // --- 2. INTENTO DE ENVÍO DE CORREOS ---
  try {
    // --- ENVÍA CORREO AL STAFF BIOSKIN CON BOTÓN WHATSAPP ---
    await transporter.sendMail({
      from: `Formulario BIOSKIN <${process.env.EMAIL_USER}>`,
      to: buildStaffRecipients(),
      subject: `🗓️ [Staff] Nueva cita web - ${paciente}${fecha ? ` (${fecha}${hora ? ` ${hora}` : ''})` : ''}`,
      html: `
        <h2 style="color:#ba9256;margin-bottom:4px;">Nueva cita registrada desde la web</h2>
        <p>Hola equipo BIOSKIN, se ha recibido una nueva solicitud de cita.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Paciente:</b></td><td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(paciente)}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Email:</b></td><td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(email)}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Teléfono:</b></td><td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(phoneClean || "No registrado")}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Servicio:</b></td><td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(tratamiento)}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><b>Fecha:</b></td><td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(fecha || 'No especificada')}</td></tr>
          <tr><td style="padding:8px 0;"><b>Hora:</b></td><td style="padding:8px 0;">${escapeHtml(hora || 'No especificada')}</td></tr>
        </table>
        <pre style="font-family:inherit;white-space:pre-wrap;background:#f5f5f5;padding:10px;border-radius:8px;">${escapeHtml(message)}</pre>
        ${
          whatsappLink
            ? `<a href="${whatsappLink}" 
                  style="display:inline-block;background:#25D366;color:#fff;padding:10px 22px;border-radius:8px;font-weight:bold;text-decoration:none;margin-top:16px;"
                  target="_blank">
                Contactar por WhatsApp
              </a>`
            : ""
        }
        <p style="margin-top:18px;color:#7a5a30;"><b>Siguiente paso:</b> confirmar disponibilidad y gestionar la cita en Google Calendar.</p>
        <p style="font-size:12px;color:#888;margin-top:14px;">Este mensaje es automático. No respondas a este correo.</p>
      `,
    });

    // --- ENVÍA CORREO AL PACIENTE (sin botón WhatsApp) ---
    await transporter.sendMail({
      from: `BIO SKIN Salud y Estética <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "¡Hemos recibido tu cita en BIOSKIN!",
      html: `
        <div style="font-family:Segoe UI,Arial,sans-serif;">
          <h2 style="color:#ba9256;margin-bottom:4px;">¡Tu cita está en proceso!</h2>
          <p>Hola <b>${paciente}</b>,<br>
          Gracias por confiar en <b>BIO SKIN Salud y Estética</b>. Hemos recibido tu solicitud y la estamos procesando.</p>
          <h4 style="margin-top:18px;">Resumen de tu solicitud:</h4>
          <pre style="font-family:inherit;white-space:pre-wrap;background:#f5f5f5;padding:10px;border-radius:8px;">${message}</pre>
          <p style="margin-top:18px;">
            En breve nos contactaremos para confirmarte la hora exacta y resolver cualquier duda.<br>
            <b>Si tienes alguna consulta, puedes responder a este email o escribirnos por WhatsApp.</b>
          </p>
          <p style="margin-top:30px;font-size:15px;">— El equipo de <b>BIOSKIN</b> Cuenca</p>
          <img src="https://saludbioskin.vercel.app/images/logo_bioskin.png" style="height:36px;margin-top:18px;" alt="BIOSKIN logo"/>
        </div>
      `,
    });

    emailSuccess = true;
    console.log("✅ Correos enviados exitosamente");

  } catch (emailErr) {
    console.error('❌ Error enviando correos:', emailErr);
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
