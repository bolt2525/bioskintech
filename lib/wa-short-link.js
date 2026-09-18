// Links cortos propios que redirigen a wa.me — evita URLs kilométricas (con el mensaje
// precargado en la query string) rompiendo el diseño de los listados del bot en WhatsApp.
import { sql } from '@vercel/postgres';
import crypto from 'crypto';

const BASE_URL = () => (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();

/** Crea un link corto (`/r/<code>`) que redirige a `wa.me/<phone>?text=<message>`. */
export async function createShortWaLink(phone, message) {
  const code = crypto.randomBytes(5).toString('base64url');
  const target = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  await sql`INSERT INTO wa_short_links (code, target_url) VALUES (${code}, ${target})`;
  return `${BASE_URL()}/r/${code}`;
}

/** Resuelve un código corto a su URL destino, o null si no existe. */
export async function resolveShortWaLink(code) {
  const r = await sql`SELECT target_url FROM wa_short_links WHERE code = ${code}`;
  return r.rows[0]?.target_url || null;
}
