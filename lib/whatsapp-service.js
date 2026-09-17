// Envío de mensajes vía WhatsApp Cloud API (Meta Graph API)

import { normalizeCrmPhone, recordWhatsAppMessage, updateOutgoingWhatsAppMessage } from './whatsapp-crm.js';

/** Envía un mensaje de texto de WhatsApp. Lanza si faltan credenciales o si la API responde con error. */
export async function sendWhatsAppText(to, body, contact = {}) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID no configuradas');
  }
  const digits = normalizeCrmPhone(to);
  if (!digits) throw new Error('Número de destino inválido');

  const audit = await recordWhatsAppMessage({
    phone: digits,
    name: contact.name,
    clinicId: contact.clinicId,
    direction: 'saliente',
    content: body,
    status: 'enviado',
  });
  const auditId = audit.rows[0]?.id;

  let response;
  try {
    response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: digits,
        type: 'text',
        text: { body },
      }),
    });
  } catch (error) {
    await updateOutgoingWhatsAppMessage(auditId, { status: 'fallido', errorDetail: error.message });
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    await updateOutgoingWhatsAppMessage(auditId, { status: 'fallido', errorDetail: `Meta API ${response.status}: ${detail}` });
    throw new Error(`WhatsApp API respondió ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = await response.json().catch(() => ({}));
  await updateOutgoingWhatsAppMessage(auditId, {
    status: 'enviado',
    providerMessageId: payload.messages?.[0]?.id || null,
  });

  return payload.messages?.[0]?.id || true;
}

/**
 * Envía un mensaje de plantilla aprobada (obligatorio para mensajes iniciados por el negocio
 * fuera de la ventana de servicio al cliente de 24h — ver Meta Cloud API docs).
 * `bodyParams` es un objeto de parámetros nombrados, ej. { nombre_paciente: 'Ana' },
 * que debe coincidir con los `{{nombre_variable}}` definidos en la plantilla de Meta.
 */
export async function sendWhatsAppTemplate(to, templateName, languageCode, bodyParams = {}, contact = {}) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID no configuradas');
  }
  const digits = normalizeCrmPhone(to);
  if (!digits) throw new Error('Número de destino inválido');

  const paramEntries = Object.entries(bodyParams);
  const audit = await recordWhatsAppMessage({
    phone: digits,
    name: contact.name,
    clinicId: contact.clinicId,
    direction: 'saliente',
    content: `[plantilla:${templateName}] ${paramEntries.map(([k, v]) => `${k}=${v}`).join(' | ')}`,
    status: 'enviado',
  });
  const auditId = audit.rows[0]?.id;

  let response;
  try {
    response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: digits,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: paramEntries.length
            ? [{ type: 'body', parameters: paramEntries.map(([name, text]) => ({ type: 'text', parameter_name: name, text: String(text) })) }]
            : [],
        },
      }),
    });
  } catch (error) {
    await updateOutgoingWhatsAppMessage(auditId, { status: 'fallido', errorDetail: error.message });
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    await updateOutgoingWhatsAppMessage(auditId, { status: 'fallido', errorDetail: `Meta API ${response.status}: ${detail}` });
    throw new Error(`WhatsApp API respondió ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = await response.json().catch(() => ({}));
  await updateOutgoingWhatsAppMessage(auditId, {
    status: 'enviado',
    providerMessageId: payload.messages?.[0]?.id || null,
  });

  return payload.messages?.[0]?.id || true;
}
