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
