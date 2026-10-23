import { sql } from '@vercel/postgres';
import { getPool } from './neon-clinical-db.js';
import { withIdentityReadLock } from './identity-reservations.js';
import { requireSubscriptionOperation } from './subscription-lifecycle.js';
import { latestWaIdentityRelease, normalizeWaIdentityPhone } from './wa-link-resolver.js';

const DIRECTIONS = new Set(['entrante', 'saliente']);
const MEDIA_TYPES = new Set(['texto', 'imagen', 'audio']);
const STATUSES = new Set(['leido', 'enviado', 'fallido']);

export function normalizeCrmPhone(value) {
  const phone = normalizeEcuadorPhone(value);
  return phone.length >= 7 && phone.length <= 20 ? phone : '';
}

export function normalizeEcuadorPhone(value) {
  return normalizeWaIdentityPhone(value);
}

/** The external wrapper is reentrant: webhook -> send -> CRM never reacquires the session lock. */
async function withCrmWrite(operation) {
  return withIdentityReadLock(async () => {
    const db = await getPool().connect();
    let releaseError;
    try {
      await db.query('BEGIN');
      const result = await operation(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError; }
      throw error;
    } finally { db.release(releaseError); }
  });
}

/** Must run under the identity read lock, before any phone-based lookup or write. */
export async function isCurrentWhatsAppInbound(phone, timestamp, db = getPool()) {
  const normalized = normalizeCrmPhone(phone);
  const occurredAt = new Date(timestamp).getTime();
  if (!normalized || timestamp == null || !Number.isFinite(occurredAt)) return false;
  const release = await latestWaIdentityRelease(db, normalized);
  return !release || occurredAt > new Date(release).getTime();
}

async function validateMessageClinic(db, clinicId, bookedByUserId) {
  if (clinicId) await requireSubscriptionOperation(db, clinicId);
  if (bookedByUserId != null) {
    const owner = await db.query('SELECT clinic_id FROM clinic_users WHERE id=$1 AND is_active=true', [bookedByUserId]);
    if (!clinicId || owner.rows[0]?.clinic_id !== clinicId)
      throw Object.assign(new Error('La identidad de WhatsApp no corresponde a la clínica.'), { status: 409 });
  }
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
    WHERE c.phone = ${normalizedPhone} AND c.retired_at IS NULL AND m.direction = 'entrante'
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
      AND c.retired_at IS NULL
      AND c.clinic_id = cu.clinic_id
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
  await ensureWhatsAppCrmColumns();
  const normalizedEventId = String(eventId || '').trim();
  // `status` incluye 'leido': Meta marca el recordatorio como leído apenas el paciente lo abre,
  // y filtrar solo por 'enviado' descartaba silenciosamente su confirmación posterior.
  const result = await sql`
    SELECT m.id AS message_id,
           m.appointment_event_id,
           m.appointment_start,
           m.booked_by_user_id,
           m.appointment_reply_status,
           cl.id AS clinic_id,
           cl.name AS clinic_name,
           cl.phone AS clinic_phone,
           cu.full_name AS professional_name,
           cu.email AS professional_email,
           COALESCE(cu.whatsapp_staff_phone, cu.phone) AS professional_phone,
           COALESCE(NULLIF(m.appointment_patient_name, ''), NULLIF(c.name, ''), c.phone) AS patient_name
    FROM whatsapp_messages m
    JOIN whatsapp_contacts c ON c.id = m.contact_id
    JOIN clinic_users cu ON cu.id = m.booked_by_user_id AND cu.is_active = true
    JOIN clinics cl ON cl.id = cu.clinic_id
    WHERE c.phone = ${normalizedPhone}
      AND c.retired_at IS NULL
      AND c.clinic_id = cu.clinic_id
      AND m.direction = 'saliente'
      AND m.status IN ('enviado', 'leido')
      AND m.appointment_event_id IS NOT NULL
      AND m.appointment_start > NOW() - INTERVAL '6 hours'
      AND m.appointment_start < NOW() + INTERVAL '48 hours'
      AND (${normalizedEventId} = '' OR m.appointment_event_id = ${normalizedEventId})
    ORDER BY m.occurred_at DESC
    LIMIT 10
  `;
  if (normalizedEventId) return result.rows[0] || null;
  const eventIds = new Set(result.rows.map(row => row.appointment_event_id));
  return eventIds.size === 1 ? result.rows[0] : null;
}

/** Descarta la confirmación previa de una cita: tras reprogramarla, esa respuesta ya no aplica. */
export async function clearAppointmentReplyStatus(eventId, bookedByUserId) {
  return withIdentityReadLock(() => clearActiveAppointmentReplyStatus(eventId, bookedByUserId));
}

async function clearActiveAppointmentReplyStatus(eventId, bookedByUserId) {
  const normalizedEventId = String(eventId || '').trim();
  const normalizedUserId = Number(bookedByUserId);
  if (!normalizedEventId || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return false;
  await ensureWhatsAppCrmColumns();
  const result = await sql`
    UPDATE whatsapp_messages SET appointment_reply_status = NULL
    WHERE appointment_event_id = ${normalizedEventId}
      AND booked_by_user_id = ${normalizedUserId}
      AND appointment_reply_status IS NOT NULL
      AND EXISTS (SELECT 1 FROM whatsapp_contacts c WHERE c.id=whatsapp_messages.contact_id AND c.retired_at IS NULL)
  `;
  return result.rowCount > 0;
}

export async function setAppointmentReplyStatus(phone, eventId, status, bookedByUserId) {
  return withIdentityReadLock(() => setActiveAppointmentReplyStatus(phone, eventId, status, bookedByUserId));
}

async function setActiveAppointmentReplyStatus(phone, eventId, status, bookedByUserId) {
  const normalizedPhone = normalizeCrmPhone(phone);
  const normalizedEventId = String(eventId || '').trim();
  const normalizedUserId = Number(bookedByUserId);
  if (!normalizedPhone || !normalizedEventId || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0 || !['confirmed', 'needs_contact'].includes(status)) return false;
  const result = await sql.query(
    `UPDATE whatsapp_messages m
     SET appointment_reply_status = $1
     FROM whatsapp_contacts c
     WHERE c.id = m.contact_id
       AND c.phone = $2
       AND c.retired_at IS NULL
       AND m.appointment_event_id = $3
       AND m.booked_by_user_id = $4
       AND m.direction = 'saliente'`,
     [status, normalizedPhone, normalizedEventId, normalizedUserId]
  );
  return result.rowCount > 0;
}

export async function getAppointmentReplyStatuses(eventIds, bookedByUserId) {
  const ids = [...new Set((Array.isArray(eventIds) ? eventIds : []).map(id => String(id || '').trim()).filter(Boolean))];
  const normalizedUserId = Number(bookedByUserId);
  if (!ids.length || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return {};
  const result = await sql.query(
    `SELECT DISTINCT ON (appointment_event_id) appointment_event_id, appointment_reply_status
     FROM whatsapp_messages
     WHERE appointment_event_id = ANY($1::varchar[])
       AND EXISTS (SELECT 1 FROM whatsapp_contacts c WHERE c.id=whatsapp_messages.contact_id AND c.retired_at IS NULL)
       AND booked_by_user_id = $2
       AND appointment_reply_status IS NOT NULL
     ORDER BY appointment_event_id, occurred_at DESC`,
    [ids, normalizedUserId]
  );
  return Object.fromEntries(result.rows.map(row => [row.appointment_event_id, row.appointment_reply_status]));
}

export async function getAppointmentDeliveryStatuses(eventIds, bookedByUserId) {
  const ids = [...new Set((Array.isArray(eventIds) ? eventIds : []).map(id => String(id || '').trim()).filter(Boolean))];
  const normalizedUserId = Number(bookedByUserId);
  if (!ids.length || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return {};
  const result = await sql.query(
    `SELECT DISTINCT ON (appointment_event_id) appointment_event_id, status
     FROM whatsapp_messages
     WHERE appointment_event_id = ANY($1::varchar[])
       AND EXISTS (SELECT 1 FROM whatsapp_contacts c WHERE c.id=whatsapp_messages.contact_id AND c.retired_at IS NULL)
       AND booked_by_user_id = $2
       AND direction = 'saliente'
     ORDER BY appointment_event_id, occurred_at DESC`,
    [ids, normalizedUserId]
  );
  return Object.fromEntries(result.rows.map(row => [row.appointment_event_id, row.status]));
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
      AND c.retired_at IS NULL
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
    // Nombre del paciente tal como está en la cita: el perfil de WhatsApp suele ser un apodo
    // ("Cole") o estar vacío, y el staff necesita ver el mismo nombre que en su agenda.
    'ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS appointment_patient_name VARCHAR(150)',
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
  appointmentPatientName = null,
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
  const safeAppointmentPatientName = String(appointmentPatientName || '').trim().slice(0, 150) || null;
  const occurredAt = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('Timestamp de mensaje inválido');
  const safeAppointmentStart = appointmentStart ? new Date(appointmentStart) : null;
  if (safeAppointmentStart && Number.isNaN(safeAppointmentStart.getTime())) throw new Error('Inicio de cita inválido');

  return withCrmWrite(async db => {
    if (direction === 'entrante' && !(await isCurrentWhatsAppInbound(normalizedPhone, occurredAt, db)))
      return { rows: [], rowCount: 0 };
    await validateMessageClinic(db, clinicId, bookedByUserId);
    // Replayed provider IDs belong to their original contact, including retired evidence.
    if (providerMessageId) {
      const existing = await db.query('SELECT id FROM whatsapp_messages WHERE provider_message_id=$1', [providerMessageId]);
      if (existing.rows.length) return { rows: [], rowCount: 0 };
    }
    const contact = await db.query(`
      INSERT INTO whatsapp_contacts (phone, name, clinic_id, last_message_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (phone) WHERE retired_at IS NULL DO UPDATE SET
        name = COALESCE(EXCLUDED.name, whatsapp_contacts.name),
        clinic_id = COALESCE(whatsapp_contacts.clinic_id, EXCLUDED.clinic_id),
        last_message_at = GREATEST(whatsapp_contacts.last_message_at, EXCLUDED.last_message_at)
      WHERE (EXCLUDED.clinic_id IS NULL OR whatsapp_contacts.clinic_id = EXCLUDED.clinic_id
        OR (whatsapp_contacts.clinic_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM whatsapp_messages prior WHERE prior.contact_id=whatsapp_contacts.id)))
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_messages m LEFT JOIN clinic_users u ON u.id=m.booked_by_user_id
          WHERE m.contact_id=whatsapp_contacts.id AND m.booked_by_user_id IS NOT NULL
            AND EXCLUDED.clinic_id IS NOT NULL AND u.clinic_id IS DISTINCT FROM EXCLUDED.clinic_id
        )
      RETURNING id, clinic_id
    `, [normalizedPhone, safeName, clinicId, occurredAt]);
    if (!contact.rows.length)
      throw Object.assign(new Error('El contacto pertenece a otra clínica.'), { status: 409 });
    if (contact.rows[0].clinic_id) await requireSubscriptionOperation(db, contact.rows[0].clinic_id);
    return db.query(`
      INSERT INTO whatsapp_messages
        (contact_id, direction, content, media_type, occurred_at, status, provider_message_id, error_detail,
         booked_by_user_id, appointment_event_id, appointment_start, appointment_patient_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
      RETURNING id, contact_id
    `, [contact.rows[0].id, direction, safeContent, mediaType, occurredAt, status, providerMessageId,
      safeError, bookedByUserId, safeAppointmentEventId, safeAppointmentStart, safeAppointmentPatientName]);
  });
}

export async function updateOutgoingWhatsAppMessage(messageId, { status, providerMessageId = null, errorDetail = null }) {
  return withIdentityReadLock(() => updateActiveOutgoingMessage(messageId, { status, providerMessageId, errorDetail }));
}

async function updateActiveOutgoingMessage(messageId, { status, providerMessageId, errorDetail }) {
  if (!Number.isSafeInteger(Number(messageId)) || !STATUSES.has(status)) return false;
  const result = await sql`
    UPDATE whatsapp_messages
    SET status = ${status},
        provider_message_id = COALESCE(provider_message_id, ${providerMessageId}),
        error_detail = ${String(errorDetail || '').slice(0, 500) || null}
    WHERE id = ${Number(messageId)}
      AND EXISTS (SELECT 1 FROM whatsapp_contacts c WHERE c.id=whatsapp_messages.contact_id AND c.retired_at IS NULL)
  `;
  return result.rowCount > 0;
}

export async function updateWhatsAppMessageStatus(providerMessageId, status, errorDetail = null, db = null) {
  return withIdentityReadLock(() => updateActiveMessageStatus(providerMessageId, status, errorDetail, db));
}

async function updateActiveMessageStatus(providerMessageId, status, errorDetail, db) {
  if (!providerMessageId || !STATUSES.has(status)) return null;
  if (!db) await ensureWhatsAppCrmColumns();
  const execute = db ? (parts, ...values) => db.query(parts.reduce((text, part, i) =>
    text + part + (i < values.length ? `$${i + 1}` : ''), ''), values) : sql;
  const result = await execute`
    UPDATE whatsapp_messages m
    SET status = CASE
          WHEN m.status = 'fallido' OR ${status} = 'fallido' THEN 'fallido'
          WHEN m.status = 'leido' OR ${status} = 'leido' THEN 'leido'
          ELSE 'enviado'
        END,
        error_detail = COALESCE(${String(errorDetail || '').slice(0, 500) || null}, m.error_detail)
    WHERE m.provider_message_id = ${String(providerMessageId)}
      AND EXISTS (SELECT 1 FROM whatsapp_contacts c WHERE c.id=m.contact_id AND c.retired_at IS NULL)
    RETURNING m.id, m.status, m.booked_by_user_id, m.read_notified, m.contact_id,
              m.appointment_patient_name, m.appointment_event_id, m.appointment_start
  `;
  return result.rows[0] || null;
}

/**
 * Reserva el aviso de estado para este mensaje. Devuelve true solo la primera vez: Meta reintenta
 * el mismo webhook y dos invocaciones concurrentes podrían avisar dos veces al staff por el mismo fallo.
 */
export async function claimMessageStatusNotification(messageId, db = null) {
  return withIdentityReadLock(() => claimActiveMessageNotification(messageId, db));
}

async function claimActiveMessageNotification(messageId, db) {
  const execute = db ? (parts, ...values) => db.query(parts.reduce((text, part, i) =>
    text + part + (i < values.length ? `$${i + 1}` : ''), ''), values) : sql;
  const result = await execute`
    UPDATE whatsapp_messages SET read_notified = true
    WHERE id = ${Number(messageId)} AND read_notified = false
      AND EXISTS (SELECT 1 FROM whatsapp_contacts c WHERE c.id=whatsapp_messages.contact_id AND c.retired_at IS NULL)
    RETURNING id
  `;
  return result.rowCount > 0;
}

/** Datos mínimos del contacto para armar la notificación al staff que reservó la cita. */
export async function getContactById(contactId) {
  const result = await sql`SELECT id, phone, name FROM whatsapp_contacts WHERE id = ${Number(contactId)} AND retired_at IS NULL`;
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
          SELECT CASE WHEN n.digits LIKE '0%' THEN '593' || substring(n.digits FROM 2)
            WHEN length(n.digits)=9 THEN '593' || n.digits ELSE n.digits END
          FROM (VALUES (cu.phone), (cu.whatsapp_staff_phone)) p(phone)
          CROSS JOIN LATERAL (SELECT regexp_replace(COALESCE(p.phone,''),'[^0-9]','','g') AS digits) d
          CROSS JOIN LATERAL (SELECT CASE WHEN d.digits LIKE '00%' THEN substring(d.digits FROM 3)
            ELSE d.digits END AS digits) n
        )
      ORDER BY cu.id
      LIMIT 1
    ) cu ON true
    LEFT JOIN clinics user_clinic ON user_clinic.id = cu.clinic_id
    LEFT JOIN LATERAL (
      SELECT p.first_name, p.last_name, p.clinic_id
      FROM patients p
      CROSS JOIN LATERAL (SELECT regexp_replace(COALESCE(p.phone,''),'[^0-9]','','g') AS digits) d
      CROSS JOIN LATERAL (SELECT CASE WHEN d.digits LIKE '00%' THEN substring(d.digits FROM 3)
        ELSE d.digits END AS digits) n
      WHERE c.phone = CASE WHEN n.digits LIKE '0%' THEN '593' || substring(n.digits FROM 2)
        WHEN length(n.digits)=9 THEN '593' || n.digits ELSE n.digits END
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
    WHERE c.retired_at IS NULL
      AND (${safeSearch} = '' OR c.phone ILIKE ${pattern} OR COALESCE(c.name, '') ILIKE ${pattern})
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
    // Un contacto con clínica asignada (al agendar o manualmente) es paciente aunque aún no tenga ficha.
    const isPatient = Boolean(row.patient_name || row.clinic_id);
    return {
      ...row,
      category: isSystemStaff ? 'staff_sistema' : isClinicUser ? 'usuario_clinico' : isPatient ? 'paciente_clinica' : 'sin_clasificar',
      category_label: isSystemStaff ? 'Staff del sistema' : isClinicUser ? `Usuario clínico · ${row.clinic_name || 'Sin clínica'}` : isPatient ? `Paciente${row.patient_name ? '' : ' sin ficha'} · ${row.clinic_name || 'Sin clínica'}` : 'Sin clasificar',
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
  return withCrmWrite(async db => {
    await validateMessageClinic(db, clinicId, null);
    const result = await db.query(`
      INSERT INTO whatsapp_contacts (phone, clinic_id, last_message_at) VALUES ($1,$2,NOW())
      ON CONFLICT (phone) WHERE retired_at IS NULL DO UPDATE SET
        clinic_id = COALESCE(whatsapp_contacts.clinic_id, EXCLUDED.clinic_id)
      WHERE (whatsapp_contacts.clinic_id = EXCLUDED.clinic_id OR (whatsapp_contacts.clinic_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages prior WHERE prior.contact_id=whatsapp_contacts.id)))
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m LEFT JOIN clinic_users u ON u.id=m.booked_by_user_id
          WHERE m.contact_id=whatsapp_contacts.id AND m.booked_by_user_id IS NOT NULL
            AND u.clinic_id IS DISTINCT FROM EXCLUDED.clinic_id)
      RETURNING id
    `, [normalizedPhone, clinicId]);
    if (!result.rows.length) throw Object.assign(new Error('El contacto pertenece a otra clínica.'), { status: 409 });
  });
}

/** Solo completa atribuciones vacías: nunca mueve una conversación entre tenants. */
export async function setWhatsAppContactClinic(contactId, clinicId) {
  const safeContactId = Number(contactId);
  if (!Number.isSafeInteger(safeContactId) || safeContactId <= 0) throw new Error('Contacto inválido');
  const normalizedClinicId = clinicId ? String(clinicId) : null;
  if (normalizedClinicId && !/^[0-9a-f-]{36}$/i.test(normalizedClinicId)) throw new Error('Clínica inválida');
  return withCrmWrite(async db => {
    if (normalizedClinicId) await validateMessageClinic(db, normalizedClinicId, null);
    const result = await db.query(`
      UPDATE whatsapp_contacts c SET clinic_id=$1
      WHERE c.id=$2 AND c.retired_at IS NULL
        AND (c.clinic_id IS NOT DISTINCT FROM $1::uuid OR
          (c.clinic_id IS NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.contact_id=c.id)))
      RETURNING id
    `, [normalizedClinicId, safeContactId]);
    if (!result.rows.length) throw Object.assign(new Error('Contacto no encontrado o atribución bloqueada'), { status: 409 });
    return true;
  });
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
      AND EXISTS (SELECT 1 FROM whatsapp_contacts c WHERE c.id=whatsapp_messages.contact_id AND c.retired_at IS NULL)
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${safeLimit}
    ) recent
    ORDER BY occurred_at ASC, id ASC
  `;
  return result.rows;
}