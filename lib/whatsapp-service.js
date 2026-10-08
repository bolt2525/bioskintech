// Envío de mensajes vía WhatsApp Cloud API (Meta Graph API)

import { normalizeCrmPhone, recordWhatsAppMessage, updateOutgoingWhatsAppMessage } from './whatsapp-crm.js';
import { getPool } from './neon-clinical-db.js';
import { requireSubscriptionOperation } from './subscription-lifecycle.js';

export function normalizeWhatsAppTemplateValue(value) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(normalized).slice(0, 1024).join('');
}

function normalizeContactPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('593')) return digits;
  if (digits.startsWith('0')) return `593${digits.substring(1)}`;
  return `593${digits}`;
}

export function resolveAppointmentContactPhone({ professionalPhone, userPhone, clinicPhone, patientPhone } = {}) {
  const patient = normalizeContactPhone(patientPhone);
  return [professionalPhone, userPhone, clinicPhone]
    .map(normalizeContactPhone)
    .find(phone => phone && phone !== patient) || '';
}

/** Los recordatorios al paciente enlazan exclusivamente al número público de la clínica. */
export function resolvePatientReminderContactPhone({ clinicPhone, patientPhone } = {}) {
  const clinic = normalizeContactPhone(clinicPhone);
  return clinic && clinic !== normalizeContactPhone(patientPhone) ? clinic : '';
}

export function buildAppointmentSystemNote({ clinicName, clinicPhone, professionalName, professionalPhone, patientPhone }) {
  const clinic = String(clinicName || 'la clínica').trim();
  const professionalContact = normalizeContactPhone(professionalPhone);
  const phone = resolveAppointmentContactPhone({ professionalPhone, clinicPhone, patientPhone });
  const contact = phone
    ? `${phone === professionalContact ? (professionalName || 'el profesional') : clinic}: https://wa.me/${phone}`
    : `${professionalName || clinic} por sus canales habituales`;
  return `ℹ️ Este es un mensaje automático del sistema de agenda de ${clinic}. Si tienes alguna duda o necesitas información, comunícate directamente con ${contact}.`;
}

/** Envía un mensaje de texto de WhatsApp. Lanza si faltan credenciales o si la API responde con error. */
export async function sendWhatsAppText(to, body, contact = {}) {
  if (contact.clinicId) await requireSubscriptionOperation(getPool(), contact.clinicId);
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
    bookedByUserId: contact.bookedByUserId,
    appointmentEventId: contact.appointmentEventId,
    appointmentStart: contact.appointmentStart,
    appointmentPatientName: contact.appointmentPatientName,
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
  if (contact.clinicId) await requireSubscriptionOperation(getPool(), contact.clinicId);
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID no configuradas');
  }
  const digits = normalizeCrmPhone(to);
  if (!digits) throw new Error('Número de destino inválido');

  const paramEntries = Object.entries(bodyParams).map(([name, value]) => [name, normalizeWhatsAppTemplateValue(value)]);
  const audit = await recordWhatsAppMessage({
    phone: digits,
    name: contact.name,
    clinicId: contact.clinicId,
    bookedByUserId: contact.bookedByUserId,
    appointmentEventId: contact.appointmentEventId,
    appointmentStart: contact.appointmentStart,
    appointmentPatientName: contact.appointmentPatientName,
    direction: 'saliente',
    content: `[plantilla:${templateName}] ${paramEntries.map(([k, v]) => `${k}=${v}`).join(' | ')}`,
    status: 'enviado',
  });
  const auditId = audit.rows[0]?.id;

  const buttonPayloads = Array.isArray(contact.buttonPayloads)
    ? contact.buttonPayloads.map(payload => String(payload || '').slice(0, 256)).filter(Boolean)
    : [];
  const components = [];
  if (paramEntries.length) {
    components.push({
      type: 'body',
      parameters: paramEntries.map(([name, text]) => ({ type: 'text', parameter_name: name, text: String(text) })),
    });
  }
  buttonPayloads.forEach((payload, index) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload }],
    });
  });

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
          components,
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
