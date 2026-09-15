// Envío de mensajes vía WhatsApp Cloud API (Meta Graph API)

/** Envía un mensaje de texto de WhatsApp. Lanza si faltan credenciales o si la API responde con error. */
export async function sendWhatsAppText(to, body) {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID no configuradas');
  }
  const digits = String(to || '').replace(/\D/g, '');
  if (!digits) throw new Error('Número de destino inválido');

  const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
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

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`WhatsApp API respondió ${response.status}: ${detail.slice(0, 300)}`);
  }

  return true;
}
