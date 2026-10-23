import { loadSubscriptionLifecycle } from './subscription-lifecycle.js';

const SCOPED_CODE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{16,22}$/i;
const LEGACY_CODE = /^[A-Za-z0-9_-]{4,64}$/;

// Edge-compatible: shared with CRM, state and webhook; no Node/DB client imports.
export function normalizeWaIdentityPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `593${digits.slice(1)}`;
  else if (digits.length === 9) digits = `593${digits}`;
  if (digits.startsWith('5930')) digits = `593${digits.slice(4)}`;
  return digits;
}

/** Release evidence survives the removal of the live clinic/user phone fields. */
export async function latestWaIdentityRelease(db, phone) {
  const result = await db.query(`
    SELECT MAX(h.released_at) AS released_at
    FROM clinic_identity_history h
    CROSS JOIN LATERAL jsonb_array_elements(
      jsonb_build_array(h.clinic_aliases) || COALESCE(h.user_aliases, '[]'::jsonb) ||
        COALESCE(h.clinic_aliases->'whatsapp_aliases', '[]'::jsonb)
    ) AS a(alias)
    CROSS JOIN LATERAL (VALUES (a.alias->>'phone'), (a.alias->>'whatsapp_staff_phone')) AS p(phone)
    CROSS JOIN LATERAL (SELECT regexp_replace(COALESCE(p.phone,''), '[^0-9]', '', 'g') AS digits) d
    CROSS JOIN LATERAL (SELECT CASE WHEN d.digits LIKE '00%' THEN substring(d.digits FROM 3)
      ELSE d.digits END AS digits) international
    WHERE h.released_at IS NOT NULL AND
      CASE WHEN international.digits LIKE '0%' THEN '593' || substring(international.digits FROM 2)
        WHEN international.digits LIKE '5930%' THEN '593' || substring(international.digits FROM 5)
        WHEN length(international.digits)=9 THEN '593' || international.digits
        ELSE international.digits END = $1
  `, [normalizeWaIdentityPhone(phone)]);
  return result.rows[0]?.released_at || null;
}

/** Compartido por middleware y API: no devuelve destinos sin clínica verificable y operativa. */
export async function resolveOperationalWaLink(code, db) {
  if (typeof code !== 'string' || (!SCOPED_CODE.test(code) && !LEGACY_CODE.test(code))) return null;
  const scoped = SCOPED_CODE.exec(code);
  const result = await db.query(`
    SELECT code, target_url, created_at, retired_at FROM wa_short_links
    WHERE (code = $1 OR replace(code, '_', '') = $1)
      AND retired_at IS NULL
      AND created_at > NOW() - INTERVAL '30 days'
    ORDER BY (code = $1) DESC
    LIMIT 2
  `, [code]);
  const exact = result.rows.find(row => row.code === code);
  const link = exact || (result.rows.length === 1 ? result.rows[0] : null);
  if (!link || link.retired_at || !/^https:\/\/wa\.me\/[0-9]{7,15}(?:\?text=[^\s]*)?$/.test(link.target_url)) return null;
  const createdAt = new Date(link.created_at).getTime();
  if (!Number.isFinite(createdAt)) return null;
  const releasedAt = await latestWaIdentityRelease(db, new URL(link.target_url).pathname.slice(1));
  if (releasedAt && (!Number.isFinite(new Date(releasedAt).getTime()) || createdAt <= new Date(releasedAt).getTime())) return null;

  // Use the stored code, including recovered underscore variants.
  let clinicId = SCOPED_CODE.exec(link.code)?.[1] || scoped?.[1];
  if (!clinicId) {
    // Legacy: solo el historial de envío atribuye el enlace; nunca se infiere por el teléfono destino.
    const origins = await db.query(`
      SELECT DISTINCT COALESCE(u.clinic_id, c.clinic_id) AS clinic_id,
        (u.clinic_id IS NOT NULL AND c.clinic_id IS NOT NULL AND u.clinic_id <> c.clinic_id) AS conflicting
      FROM whatsapp_messages m
      JOIN whatsapp_contacts c ON c.id = m.contact_id
      LEFT JOIN clinic_users u ON u.id = m.booked_by_user_id
      WHERE m.direction = 'saliente'
        AND c.retired_at IS NULL
        AND m.content ~ ('/r/' || $1 || '([^A-Za-z0-9._-]|$)')
    `, [link.code]);
    if (origins.rows.length !== 1 || !origins.rows[0].clinic_id || origins.rows[0].conflicting) return null;
    clinicId = origins.rows[0].clinic_id;
  }
  try {
    return (await loadSubscriptionLifecycle(db, clinicId)).canoperate ? link.target_url : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}
