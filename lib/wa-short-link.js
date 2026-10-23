// Links cortos propios que redirigen a wa.me — evita URLs kilométricas (con el mensaje
// precargado en la query string) rompiendo el diseño de los listados del bot en WhatsApp.
import { sql } from '@vercel/postgres';
import crypto from 'crypto';
import { getPool } from './neon-clinical-db.js';
import { loadSubscriptionLifecycle } from './subscription-lifecycle.js';
import { resolveOperationalWaLink } from './wa-link-resolver.js';
import { normalizeCrmPhone } from './whatsapp-crm.js';
import { withIdentityReadLock } from './identity-reservations.js';

const BASE_URL = () => (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();

/** Crea un link corto (`/r/<code>`) que redirige a `wa.me/<phone>?text=<message>`. */
export async function createShortWaLink(phone, message, clinicId) {
  return withIdentityReadLock(() => createCurrentShortWaLink(phone, message, clinicId));
}

async function createCurrentShortWaLink(phone, message, clinicId) {
  phone = normalizeCrmPhone(phone);
  if (!phone) throw Object.assign(new Error('Teléfono de WhatsApp inválido'), { status: 400 });
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
  return resolveOperationalWaLink(code, getPool());
}
