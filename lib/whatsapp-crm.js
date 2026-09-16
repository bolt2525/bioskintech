import { sql } from '@vercel/postgres';

const DIRECTIONS = new Set(['entrante', 'saliente']);
const MEDIA_TYPES = new Set(['texto', 'imagen', 'audio']);
const STATUSES = new Set(['leido', 'enviado', 'fallido']);

export function normalizeCrmPhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  return phone.length >= 7 && phone.length <= 20 ? phone : '';
}

export async function recordWhatsAppMessage({
  phone,
  name = null,
  clinicId = null,
  direction,
  content = '',
  mediaType = 'texto',
  timestamp = new Date(),
  status,
  providerMessageId = null,
  errorDetail = null,
}) {
  const normalizedPhone = normalizeCrmPhone(phone);
  if (!normalizedPhone) throw new Error('Teléfono de WhatsApp inválido');
  if (!DIRECTIONS.has(direction)) throw new Error('Dirección de mensaje inválida');
  if (!MEDIA_TYPES.has(mediaType)) throw new Error('Tipo de medio inválido');
  if (!STATUSES.has(status)) throw new Error('Estado de mensaje inválido');

  const safeName = String(name || '').trim().slice(0, 150) || null;
  const safeContent = String(content || '').slice(0, 10000);
  const safeError = String(errorDetail || '').slice(0, 500) || null;
  const occurredAt = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('Timestamp de mensaje inválido');

  const contact = await sql`
    INSERT INTO whatsapp_contacts (phone, name, clinic_id, last_message_at)
    VALUES (${normalizedPhone}, ${safeName}, ${clinicId}, ${occurredAt})
    ON CONFLICT (phone) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, whatsapp_contacts.name),
      clinic_id = COALESCE(EXCLUDED.clinic_id, whatsapp_contacts.clinic_id),
      last_message_at = GREATEST(whatsapp_contacts.last_message_at, EXCLUDED.last_message_at)
    RETURNING id
  `;

  return sql`
    INSERT INTO whatsapp_messages
      (contact_id, direction, content, media_type, occurred_at, status, provider_message_id, error_detail)
    VALUES
      (${contact.rows[0].id}, ${direction}, ${safeContent}, ${mediaType}, ${occurredAt}, ${status}, ${providerMessageId}, ${safeError})
    ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
    RETURNING id, contact_id
  `;
}

export async function updateOutgoingWhatsAppMessage(messageId, { status, providerMessageId = null, errorDetail = null }) {
  if (!Number.isSafeInteger(Number(messageId)) || !STATUSES.has(status)) return false;
  const result = await sql`
    UPDATE whatsapp_messages
    SET status = ${status},
        provider_message_id = COALESCE(${providerMessageId}, provider_message_id),
        error_detail = ${String(errorDetail || '').slice(0, 500) || null}
    WHERE id = ${Number(messageId)}
  `;
  return result.rowCount > 0;
}

export async function updateWhatsAppMessageStatus(providerMessageId, status, errorDetail = null) {
  if (!providerMessageId || !STATUSES.has(status)) return false;
  const result = await sql`
    UPDATE whatsapp_messages
    SET status = CASE
          WHEN status = 'fallido' OR ${status} = 'fallido' THEN 'fallido'
          WHEN status = 'leido' OR ${status} = 'leido' THEN 'leido'
          ELSE 'enviado'
        END,
        error_detail = COALESCE(${String(errorDetail || '').slice(0, 500) || null}, error_detail)
    WHERE provider_message_id = ${String(providerMessageId)}
  `;
  return result.rowCount > 0;
}

export async function listWhatsAppContacts(search = '', limit = 100) {
  const safeSearch = String(search || '').trim().slice(0, 100);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const pattern = `%${safeSearch}%`;
  const result = await sql`
    SELECT c.id, c.phone, c.name, c.created_at, c.last_message_at,
           m.content AS last_message, m.direction AS last_direction,
           m.media_type AS last_media_type, m.status AS last_status
    FROM whatsapp_contacts c
    LEFT JOIN LATERAL (
      SELECT content, direction, media_type, status
      FROM whatsapp_messages
      WHERE contact_id = c.id
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    ) m ON true
    WHERE (${safeSearch} = '' OR c.phone ILIKE ${pattern} OR COALESCE(c.name, '') ILIKE ${pattern})
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ${safeLimit}
  `;
  return result.rows;
}

export async function listWhatsAppMessages(contactId, limit = 500) {
  const safeContactId = Number(contactId);
  if (!Number.isSafeInteger(safeContactId) || safeContactId <= 0) {
    throw new Error('Contacto inválido');
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const result = await sql`
    SELECT * FROM (
    SELECT id, contact_id, direction, content, media_type, occurred_at, status,
           provider_message_id, error_detail
    FROM whatsapp_messages
    WHERE contact_id = ${safeContactId}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${safeLimit}
    ) recent
    ORDER BY occurred_at ASC, id ASC
  `;
  return result.rows;
}