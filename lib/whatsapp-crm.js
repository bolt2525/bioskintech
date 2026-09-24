import { sql } from '@vercel/postgres';

const DIRECTIONS = new Set(['entrante', 'saliente']);
const MEDIA_TYPES = new Set(['texto', 'imagen', 'audio']);
const STATUSES = new Set(['leido', 'enviado', 'fallido']);

export function normalizeCrmPhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  return phone.length >= 7 && phone.length <= 20 ? phone : '';
}

function normalizeEcuadorPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `593${digits.substring(1)}`;
  if (digits.startsWith('593')) return digits;
  return `593${digits}`;
}

/** Los números de soporte interno nunca reciben notificaciones de una clínica. */
export function isSystemStaffPhone(phone) {
  const normalized = normalizeEcuadorPhone(phone);
  return new Set(
    (process.env.WHATSAPP_SYSTEM_STAFF_PHONES || '')
      .split(',')
      .map(normalizeEcuadorPhone)
      .filter(Boolean)
  ).has(normalized);
}

/** true si el contacto escribió al negocio en las últimas 24h (ventana de servicio al cliente de Meta). */
export async function isWithinCustomerServiceWindow(phone) {
  const normalizedPhone = normalizeCrmPhone(phone);
  if (!normalizedPhone) return false;
  const result = await sql`
    SELECT 1 FROM whatsapp_messages m
    JOIN whatsapp_contacts c ON c.id = m.contact_id
    WHERE c.phone = ${normalizedPhone} AND m.direction = 'entrante'
      AND m.occurred_at > NOW() - INTERVAL '24 hours'
    LIMIT 1
  `;
  return result.rows.length > 0;
}

/** Contexto de la última confirmación enviada al paciente para responder dentro de la ventana gratuita. */
export async function getRecentAppointmentNotificationContext(phone) {
  const normalizedPhone = normalizeCrmPhone(phone);
  if (!normalizedPhone) return null;
  const result = await sql`
    SELECT cl.id AS clinic_id,
           cl.name AS clinic_name,
           cl.phone AS clinic_phone,
           cu.full_name AS professional_name,
           COALESCE(cu.whatsapp_staff_phone, cu.phone) AS professional_phone
    FROM whatsapp_messages m
    JOIN whatsapp_contacts c ON c.id = m.contact_id
    JOIN clinic_users cu ON cu.id = m.booked_by_user_id AND cu.is_active = true
    JOIN clinics cl ON cl.id = cu.clinic_id
    WHERE c.phone = ${normalizedPhone}
      AND m.direction = 'saliente'
      AND m.booked_by_user_id IS NOT NULL
      AND m.occurred_at > NOW() - INTERVAL '24 hours'
    ORDER BY m.occurred_at DESC
    LIMIT 1
  `;
  return result.rows[0] || null;
}

export async function getPendingAppointmentReplyContext(phone, eventId = null) {
  const normalizedPhone = normalizeCrmPhone(phone);
  if (!normalizedPhone) return null;
  const normalizedEventId = String(eventId || '').trim();
  const result = await sql`
    SELECT m.id AS message_id,
           m.appointment_event_id,
           m.appointment_start,
           m.booked_by_user_id,
           cl.id AS clinic_id,
           cl.name AS clinic_name,
           cl.phone AS clinic_phone,
           cu.full_name AS professional_name,
           cu.email AS professional_email,
           COALESCE(cu.whatsapp_staff_phone, cu.phone) AS professional_phone,
           c.name AS patient_name
    FROM whatsapp_messages m
    JOIN whatsapp_contacts c ON c.id = m.contact_id
    JOIN clinic_users cu ON cu.id = m.booked_by_user_id AND cu.is_active = true
    JOIN clinics cl ON cl.id = cu.clinic_id
    WHERE c.phone = ${normalizedPhone}
      AND m.direction = 'saliente'
      AND m.status = 'enviado'
      AND m.appointment_event_id IS NOT NULL
      AND m.appointment_start > NOW() - INTERVAL '24 hours'
      AND m.appointment_start < NOW() + INTERVAL '48 hours'
      AND (${normalizedEventId} = '' OR m.appointment_event_id = ${normalizedEventId})
    ORDER BY m.appointment_start ASC, m.occurred_at DESC
    LIMIT 2
  `;
  if (result.rows.length !== 1) return null;
  return result.rows[0];
}

export async function setAppointmentReplyStatus(phone, eventId, status) {
  const normalizedPhone = normalizeCrmPhone(phone);
  const normalizedEventId = String(eventId || '').trim();
  if (!normalizedPhone || !normalizedEventId || !['confirmed', 'needs_contact'].includes(status)) return false;
  const result = await sql.query(
    `UPDATE whatsapp_messages m
     SET appointment_reply_status = $1
     FROM whatsapp_contacts c
     WHERE c.id = m.contact_id
       AND c.phone = $2
       AND m.appointment_event_id = $3
       AND m.direction = 'saliente'`,
    [status, normalizedPhone, normalizedEventId]
  );
  return result.rowCount > 0;
}

export async function getAppointmentReplyStatuses(eventIds) {
  const ids = [...new Set((Array.isArray(eventIds) ? eventIds : []).map(id => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return {};
  const result = await sql.query(
    `SELECT DISTINCT ON (appointment_event_id) appointment_event_id, appointment_reply_status
     FROM whatsapp_messages
     WHERE appointment_event_id = ANY($1::varchar[])
       AND appointment_reply_status IS NOT NULL
     ORDER BY appointment_event_id, occurred_at DESC`,
    [ids]
  );
  return Object.fromEntries(result.rows.map(row => [row.appointment_event_id, row.appointment_reply_status]));
}

/** Evita repetir la nota automática ante varios mensajes del paciente. */
export async function hasRecentAppointmentSystemReply(phone) {
  const normalizedPhone = normalizeCrmPhone(phone);
  if (!normalizedPhone) return false;
  const result = await sql`
    SELECT 1
    FROM whatsapp_messages m
    JOIN whatsapp_contacts c ON c.id = m.contact_id
    WHERE c.phone = ${normalizedPhone}
      AND m.direction = 'saliente'
      AND m.content LIKE 'ℹ️ Este es un mensaje automático del sistema de agenda%'
      AND m.occurred_at > NOW() - INTERVAL '24 hours'
    LIMIT 1
  `;
  return result.rows.length > 0;
}

// ponytail: flag de módulo — instancias serverless son de corta vida, seguro repetir en cold start
let _crmColumnsMigrated = false;
async function ensureWhatsAppCrmColumns() {
  if (_crmColumnsMigrated) return;
  _crmColumnsMigrated = true;
  const migrations = [
    'ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS booked_by_user_id INTEGER',
    'ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS read_notified BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS appointment_event_id VARCHAR(255)',
    'ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS appointment_start TIMESTAMPTZ',
    'ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS appointment_reply_status VARCHAR(30)',
  ];
  for (const stmt of migrations) {
    try { await sql.query(stmt); } catch { /* columna ya existe — seguro ignorar */ }
  }
}

export async function recordWhatsAppMessage({
  phone,
  name = null,
  clinicId = null,
  bookedByUserId = null,
  appointmentEventId = null,
  appointmentStart = null,
  direction,
  content = '',
  mediaType = 'texto',
  timestamp = new Date(),
  status,
  providerMessageId = null,
  errorDetail = null,
}) {
  await ensureWhatsAppCrmColumns();
  const normalizedPhone = normalizeCrmPhone(phone);
  if (!normalizedPhone) throw new Error('Teléfono de WhatsApp inválido');
  if (!DIRECTIONS.has(direction)) throw new Error('Dirección de mensaje inválida');
  if (!MEDIA_TYPES.has(mediaType)) throw new Error('Tipo de medio inválido');
  if (!STATUSES.has(status)) throw new Error('Estado de mensaje inválido');

  const safeName = String(name || '').trim().slice(0, 150) || null;
  const safeContent = String(content || '').slice(0, 10000);
  const safeError = String(errorDetail || '').slice(0, 500) || null;
  const safeAppointmentEventId = String(appointmentEventId || '').trim().slice(0, 255) || null;
  const occurredAt = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('Timestamp de mensaje inválido');
  const safeAppointmentStart = appointmentStart ? new Date(appointmentStart) : null;
  if (safeAppointmentStart && Number.isNaN(safeAppointmentStart.getTime())) throw new Error('Inicio de cita inválido');

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
      (contact_id, direction, content, media_type, occurred_at, status, provider_message_id, error_detail, booked_by_user_id, appointment_event_id, appointment_start)
    VALUES
      (${contact.rows[0].id}, ${direction}, ${safeContent}, ${mediaType}, ${occurredAt}, ${status}, ${providerMessageId}, ${safeError}, ${bookedByUserId}, ${safeAppointmentEventId}, ${safeAppointmentStart})
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
  if (!providerMessageId || !STATUSES.has(status)) return null;
  await ensureWhatsAppCrmColumns();
  const result = await sql`
    UPDATE whatsapp_messages m
    SET status = CASE
          WHEN m.status = 'fallido' OR ${status} = 'fallido' THEN 'fallido'
          WHEN m.status = 'leido' OR ${status} = 'leido' THEN 'leido'
          ELSE 'enviado'
        END,
        error_detail = COALESCE(${String(errorDetail || '').slice(0, 500) || null}, m.error_detail)
    WHERE m.provider_message_id = ${String(providerMessageId)}
    RETURNING m.id, m.status, m.booked_by_user_id, m.read_notified, m.contact_id
  `;
  return result.rows[0] || null;
}

/** Marca una notificación de estado como ya enviada al staff — evita avisar dos veces por el mismo mensaje. */
export async function markMessageReadNotified(messageId) {
  await sql`UPDATE whatsapp_messages SET read_notified = true WHERE id = ${Number(messageId)}`;
}

/** Datos mínimos del contacto para armar la notificación al staff que reservó la cita. */
export async function getContactById(contactId) {
  const result = await sql`SELECT id, phone, name FROM whatsapp_contacts WHERE id = ${Number(contactId)}`;
  return result.rows[0] || null;
}

export async function listWhatsAppContacts(search = '', limit = 100) {
  const safeSearch = String(search || '').trim().slice(0, 100);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const pattern = `%${safeSearch}%`;
  const result = await sql`
    SELECT c.id, c.phone, c.name, c.created_at, c.last_message_at,
           COALESCE(c.clinic_id, cu.clinic_id, patient.clinic_id) AS clinic_id,
           COALESCE(contact_clinic.name, user_clinic.name, patient_clinic.name) AS clinic_name,
           cu.full_name AS clinic_user_name,
           patient.first_name || ' ' || patient.last_name AS patient_name,
           m.content AS last_message, m.direction AS last_direction,
           m.media_type AS last_media_type, m.status AS last_status
    FROM whatsapp_contacts c
    LEFT JOIN clinics contact_clinic ON contact_clinic.id = c.clinic_id
    LEFT JOIN LATERAL (
      SELECT cu.id, cu.clinic_id, cu.full_name
      FROM clinic_users cu
      WHERE cu.is_active = true
        AND c.phone IN (
          regexp_replace(COALESCE(cu.phone, ''), '\\D', '', 'g'),
          regexp_replace(COALESCE(cu.whatsapp_staff_phone, ''), '\\D', '', 'g'),
          CASE WHEN regexp_replace(COALESCE(cu.phone, ''), '\\D', '', 'g') LIKE '0%'
            THEN '593' || substring(regexp_replace(COALESCE(cu.phone, ''), '\\D', '', 'g') FROM 2)
            ELSE regexp_replace(COALESCE(cu.phone, ''), '\\D', '', 'g') END,
          CASE WHEN regexp_replace(COALESCE(cu.whatsapp_staff_phone, ''), '\\D', '', 'g') LIKE '0%'
            THEN '593' || substring(regexp_replace(COALESCE(cu.whatsapp_staff_phone, ''), '\\D', '', 'g') FROM 2)
            ELSE regexp_replace(COALESCE(cu.whatsapp_staff_phone, ''), '\\D', '', 'g') END
        )
      ORDER BY cu.id
      LIMIT 1
    ) cu ON true
    LEFT JOIN clinics user_clinic ON user_clinic.id = cu.clinic_id
    LEFT JOIN LATERAL (
      SELECT p.first_name, p.last_name, p.clinic_id
      FROM patients p
      WHERE c.phone IN (
        regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g'),
        CASE WHEN regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE '0%'
          THEN '593' || substring(regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') FROM 2)
          ELSE regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') END
      )
      ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
      LIMIT 1
    ) patient ON true
    LEFT JOIN clinics patient_clinic ON patient_clinic.id = patient.clinic_id
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
  const systemStaffPhones = new Set(
    (process.env.WHATSAPP_SYSTEM_STAFF_PHONES || '')
      .split(',')
      .map(normalizeEcuadorPhone)
      .filter(Boolean)
  );
  return result.rows.map(row => {
    const isSystemStaff = systemStaffPhones.has(normalizeEcuadorPhone(row.phone));
    const isClinicUser = Boolean(row.clinic_user_name);
    return {
      ...row,
      category: isSystemStaff ? 'staff_sistema' : isClinicUser ? 'usuario_clinico' : row.patient_name ? 'paciente_clinica' : 'sin_clasificar',
      category_label: isSystemStaff ? 'Staff del sistema' : isClinicUser ? `Usuario clínico · ${row.clinic_name || 'Sin clínica'}` : row.patient_name ? `Paciente · ${row.clinic_name || 'Sin clínica'}` : 'Sin clasificar',
    };
  });
}

/**
 * Asocia el teléfono de un paciente a una clínica al momento de agendar, sin registrar un
 * mensaje. Se ejecuta SIEMPRE (no depende de si el bot de confirmación por WhatsApp está
 * habilitado) — de lo contrario el contacto solo se crea cuando el paciente escribe primero
 * (`handleIncomingMessages` no conoce la clínica) y queda "sin clasificar" para siempre si
 * el paciente tampoco está registrado en `patients`.
 */
export async function ensureWhatsAppContactClinic(phone, clinicId) {
  const normalizedPhone = normalizeCrmPhone(phone);
  if (!normalizedPhone || !clinicId) return;
  await sql`
    INSERT INTO whatsapp_contacts (phone, clinic_id, last_message_at)
    VALUES (${normalizedPhone}, ${clinicId}, NOW())
    ON CONFLICT (phone) DO UPDATE SET
      clinic_id = COALESCE(whatsapp_contacts.clinic_id, EXCLUDED.clinic_id)
  `;
}

/** Reasigna manualmente la clínica de un contacto (fix para chats "sin clasificar" o mal apuntados). */
export async function setWhatsAppContactClinic(contactId, clinicId) {
  const safeContactId = Number(contactId);
  if (!Number.isSafeInteger(safeContactId) || safeContactId <= 0) throw new Error('Contacto inválido');
  const normalizedClinicId = clinicId ? String(clinicId) : null;
  if (normalizedClinicId && !/^[0-9a-f-]{36}$/i.test(normalizedClinicId)) throw new Error('Clínica inválida');
  const result = await sql`
    UPDATE whatsapp_contacts SET clinic_id = ${normalizedClinicId}
    WHERE id = ${safeContactId}
    RETURNING id
  `;
  if (!result.rows.length) throw new Error('Contacto no encontrado');
  return true;
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