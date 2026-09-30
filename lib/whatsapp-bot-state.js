// Estado de conversación del bot de WhatsApp — persistente en Neon (no en memoria).
// ponytail: las funciones serverless son efímeras y pueden correr en instancias distintas
// entre mensajes; un Map en memoria pierde el flujo a mitad de una máquina de estados.
import { sql } from '@vercel/postgres';

// Un flujo abandonado no puede quedar vivo para siempre: al día siguiente, el "1" del usuario
// se interpretaba como opción de la conversación vieja en vez del menú principal.
const STATE_TTL = '2 hours';

/** Devuelve el estado activo del teléfono, o null si no hay ninguno o ya caducó. */
export async function getBotState(phone) {
  const r = await sql`
    SELECT flow, data FROM whatsapp_bot_state
    WHERE phone = ${phone} AND updated_at > NOW() - ${STATE_TTL}::interval
  `;
  if (!r.rows.length) return null;
  return { flow: r.rows[0].flow, ...(r.rows[0].data || {}) };
}

/** Guarda (o reemplaza) el estado activo del teléfono para un flujo dado. */
export async function setBotState(phone, flow, data = {}) {
  await sql`
    INSERT INTO whatsapp_bot_state (phone, flow, data, updated_at)
    VALUES (${phone}, ${flow}, ${JSON.stringify(data)}::jsonb, NOW())
    ON CONFLICT (phone) DO UPDATE SET flow = ${flow}, data = ${JSON.stringify(data)}::jsonb, updated_at = NOW()
  `;
}

/** Limpia el estado activo del teléfono (fin o cancelación de flujo). */
export async function clearBotState(phone) {
  await sql`DELETE FROM whatsapp_bot_state WHERE phone = ${phone}`;
}
