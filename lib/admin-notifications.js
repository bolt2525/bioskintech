/**
 * Servicio de notificaciones administrativas
 * Envía alertas al número de BIOSKIN cuando ocurren eventos importantes
 */

const BIOSKIN_ADMIN_NUMBER = '593969890689';
const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

/**
 * Envía un mensaje de WhatsApp al administrador
 */
export async function sendWhatsAppMessage(to, message) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.warn('⚠️ Credenciales de WhatsApp no configuradas para notificaciones');
    return false;
  }

  try {
    const response = await fetch(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Error enviando notificación:', data);
      return false;
    }

    console.log('✅ Notificación enviada al admin:', data);
    return true;
  } catch (error) {
    console.error('❌ Error enviando notificación WhatsApp:', error);
    return false;
  }
}

/**
 * Notifica al admin sobre una nueva conversación
 */
export async function notifyNewConversation(phoneNumber, firstMessage) {
  try {
    const adminUrl = 'https://saludbioskin.vercel.app/chatbot-manager.html';
    
    const message = `🆕 *Nueva conversación iniciada*\n\n` +
      `📱 Cliente: ${phoneNumber}\n` +
      `💬 Primer mensaje: "${firstMessage.substring(0, 100)}${firstMessage.length > 100 ? '...' : ''}"\n\n` +
      `👉 Gestionar conversación:\n${adminUrl}`;

    console.log('📤 Enviando notificación de nueva conversación al admin...');
    const success = await sendWhatsAppMessage(BIOSKIN_ADMIN_NUMBER, message);
    
    if (success) {
      console.log('✅ Notificación de nueva conversación enviada');
    }
    
    return success;
  } catch (error) {
    console.error('❌ Error notificando nueva conversación:', error);
    return false;
  }
}

/**
 * Notifica al admin sobre un agendamiento exitoso
 */
export async function notifyAppointmentCreated(phoneNumber, appointmentDetails) {
  try {
    const { date, time, service } = appointmentDetails;
    const adminUrl = 'https://saludbioskin.vercel.app/chatbot-manager.html';
    
    const message = `✅ *Cita agendada exitosamente*\n\n` +
      `📱 Cliente: ${phoneNumber}\n` +
      `📅 Fecha: ${date}\n` +
      `🕐 Hora: ${time}\n` +
      `💆 Servicio: ${service}\n\n` +
      `👉 Ver conversación:\n${adminUrl}`;

    console.log('📤 Enviando notificación de cita agendada al admin...');
    const success = await sendWhatsAppMessage(BIOSKIN_ADMIN_NUMBER, message);
    
    if (success) {
      console.log('✅ Notificación de cita enviada');
    }
    
    return success;
  } catch (error) {
    console.error('❌ Error notificando cita:', error);
    return false;
  }
}

/**
 * Verifica si es la primera conversación de un cliente
 */
export function isNewConversation(sessionId, conversationData) {
  // Si total_messages es 1 o menor, es una nueva conversación
  return conversationData?.total_messages <= 1;
}
