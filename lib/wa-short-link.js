// Links cortos propios que redirigen a wa.me — evita URLs kilométricas (con el mensaje
// precargado en la query string) rompiendo el diseño de los listados del bot en WhatsApp.
import { sql } from '@vercel/postgres';
import crypto from 'crypto';
import { getPool } from './neon-clinical-db.js';
import { loadSubscriptionLifecycle } from './subscription-lifecycle.js';

const BASE_URL = () => (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();

/** Crea un link corto (`/r/<code>`) que redirige a `wa.me/<phone>?text=<message>`. */
export async function createShortWaLink(phone, message, clinicId) {
  if (typeof clinicId !== 'string' || !/^[0-9a-f-]{36}$/i.test(clinicId) ||
      !(await loadSubscriptionLifecycle(getPool(), clinicId)).canoperate)
    throw Object.assign(new Error('La clínica no permite enlaces operativos.'), { status: 403 });
  // Fits the existing VARCHAR(64), with tenant attribution outside the message.
  const code = `${clinicId.toLowerCase()}.${crypto.randomBytes(16).toString('base64url')}`;
  const target = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  await sql`INSERT INTO wa_short_links (code, target_url) VALUES (${code}, ${target})`;
  return `${BASE_URL()}/r/${code}`;
}

/** Resuelve un código corto a su URL destino, o null si no existe. */
export async function resolveShortWaLink(code) {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{22}$/i.exec(code);
  // Old unscoped codes cannot prove tenant eligibility; regenerate, never guess.
  if (!match || !(await loadSubscriptionLifecycle(getPool(), match[1])).canoperate) return null;
  const r = await sql`
    SELECT target_url FROM wa_short_links
    WHERE code = ${code} AND created_at > NOW() - INTERVAL '30 days'
  `;
  return r.rows[0]?.target_url || null;
}
