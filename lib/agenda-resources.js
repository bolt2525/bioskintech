import { sql } from '@vercel/postgres';

// Agenda multi-recurso: un mismo calendario OAuth alberga al titular y a sus ayudantes.
// Cada evento se etiqueta con extendedProperties.private.resourceId.
// Los eventos previos a esta función no tienen la etiqueta y se atribuyen al titular.

export const ownerResourceId = (userId) => `owner:${userId}`;

export function eventResourceId(event, userId) {
  return event?.extendedProperties?.private?.resourceId || ownerResourceId(userId);
}

export function resourceExtendedProperties(resourceId, userId) {
  return { private: { resourceId: resourceId || ownerResourceId(userId), bioskinOwner: String(userId) } };
}

/** Valida que el resourceId pertenezca al usuario. Devuelve el id normalizado o null. */
export async function resolveResourceId(userId, resourceId) {
  if (!resourceId || resourceId === ownerResourceId(userId)) return ownerResourceId(userId);
  const m = /^staff:(\d+)$/.exec(String(resourceId));
  if (!m) return null;
  const r = await sql`
    SELECT id FROM clinic_staff_resources
    WHERE id = ${parseInt(m[1], 10)} AND owner_user_id = ${userId} AND active = true
  `;
  return r.rows.length ? `staff:${r.rows[0].id}` : null;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function isWithinWorkHours(time, durationMinutes, startHour, endHour) {
  const toMinutes = (value) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const appointmentStart = toMinutes(time);
  const workStart = toMinutes(startHour);
  const workEnd = toMinutes(endHour);
  const duration = Number(durationMinutes);
  if (appointmentStart === null || workStart === null || workEnd === null || !Number.isFinite(duration) || duration <= 0) return false;
  return appointmentStart >= workStart && appointmentStart + duration <= workEnd;
}

export function isValidFutureLocalDateTime(date, time, now = Date.now()) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
  if (!dateMatch || !timeMatch) return false;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return false;
  const timestamp = Date.parse(`${date}T${time}:00-05:00`);
  return Number.isFinite(timestamp) && timestamp > now;
}
