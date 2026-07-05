/**
 * @file lib/neon-chatbot-db.js
 * @description Capa de base de datos para el bot interno y conversaciones.
 * Usa @vercel/postgres (optimizado para Vercel serverless).
 *
 * Tablas gestionadas:
 *   internal_bot_conversations, internal_bot_messages,
 *   chatbot_tracking, chatbot_templates, chatbot_app_states
 *
 * Variables de entorno requeridas (Vercel Postgres / Neon):
 *   POSTGRES_URL (auto-inyectada por Vercel) o NEON_DATABASE_URL
 *
 * IMPORTANTE: Todas las tablas están en la misma base de datos Neon Postgres
 * que el resto del sistema. NO hay bases de datos adicionales.
 */

import { sql } from '@vercel/postgres';

// ─────────────────────────────────────────────────────────────────────────────
// Inicialización del esquema del bot interno
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crea las tablas del bot interno si no existen (idempotente).
 * Debe llamarse una vez durante el setup inicial de la base de datos.
 */
export async function initChatbotDatabase() {
  try {
    // Conversaciones activas del bot
    await sql`
      CREATE TABLE IF NOT EXISTS internal_bot_conversations (
        id           SERIAL PRIMARY KEY,
        session_id   VARCHAR(255) UNIQUE NOT NULL,
        phone_number VARCHAR(50),
        created_at   TIMESTAMP DEFAULT NOW(),
        last_message_at TIMESTAMP DEFAULT NOW(),
        total_messages  INT DEFAULT 0,
        is_active    BOOLEAN DEFAULT true,
        preferences  JSONB DEFAULT '{}'
      )
    `;

    // Mensajes individuales de cada conversación
    await sql`
      CREATE TABLE IF NOT EXISTS internal_bot_messages (
        id         SERIAL PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL REFERENCES internal_bot_conversations(session_id) ON DELETE CASCADE,
        role       VARCHAR(50) NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TIMESTAMP DEFAULT NOW(),
        tokens_used INT DEFAULT 0,
        message_id VARCHAR(255)
      )
    `;

    // Eventos de tracking del chatbot
    await sql`
      CREATE TABLE IF NOT EXISTS chatbot_tracking (
        id         SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        event_type VARCHAR(100) NOT NULL,
        event_data JSONB,
        timestamp  TIMESTAMP DEFAULT NOW()
      )
    `;

    // Plantillas de mensajes predefinidos
    await sql`
      CREATE TABLE IF NOT EXISTS chatbot_templates (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        content    TEXT NOT NULL,
        category   VARCHAR(100),
        variables  JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Estado persistente de la aplicación del bot
    await sql`
      CREATE TABLE IF NOT EXISTS chatbot_app_states (
        id         SERIAL PRIMARY KEY,
        key        VARCHAR(255) UNIQUE NOT NULL,
        value      JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;

    console.log('✅ Esquema del chatbot/bot-interno inicializado');
  } catch (error) {
    console.error('❌ Error al inicializar chatbot DB:', error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operaciones de conversaciones
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Obtiene o crea una conversación para un número de teléfono.
 * @param {string} sessionId - ID único de sesión
 * @param {string} phoneNumber - Número de WhatsApp
 */
export async function getOrCreateConversation(sessionId, phoneNumber) {
  const existing = await sql`
    SELECT * FROM internal_bot_conversations WHERE session_id = ${sessionId}
  `;
  if (existing.rows.length > 0) return existing.rows[0];

  const created = await sql`
    INSERT INTO internal_bot_conversations (session_id, phone_number)
    VALUES (${sessionId}, ${phoneNumber})
    RETURNING *
  `;
  return created.rows[0];
}

/**
 * Guarda un mensaje en el historial de la conversación.
 */
export async function saveMessage(sessionId, role, content, messageId = null, tokensUsed = 0) {
  await sql`
    INSERT INTO internal_bot_messages (session_id, role, content, message_id, tokens_used)
    VALUES (${sessionId}, ${role}, ${content}, ${messageId}, ${tokensUsed})
  `;
  await sql`
    UPDATE internal_bot_conversations
    SET last_message_at = NOW(), total_messages = total_messages + 1
    WHERE session_id = ${sessionId}
  `;
}

/**
 * Recupera el historial de mensajes de una conversación (limitado a los últimos N).
 */
export async function getConversationHistory(sessionId, limit = 20) {
  const r = await sql`
    SELECT role, content FROM internal_bot_messages
    WHERE session_id = ${sessionId}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;
  return r.rows.reverse();
}

// ─────────────────────────────────────────────────────────────────────────────
// Estado de la aplicación (clave-valor persistente)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAppState(key) {
  const r = await sql`SELECT value FROM chatbot_app_states WHERE key = ${key}`;
  return r.rows[0]?.value ?? null;
}

export async function setAppState(key, value) {
  await sql`
    INSERT INTO chatbot_app_states (key, value)
    VALUES (${key}, ${JSON.stringify(value)})
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(value)}, updated_at = NOW()
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats (para dashboard y mantenimiento)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devuelve estadísticas generales del bot para monitoreo.
 * @returns {{ totalConversations, activeConversations, totalMessages, recentMessages }}
 */
export async function getDatabaseStats() {
  try {
    const [convR, msgR, activeR] = await Promise.all([
      sql`SELECT COUNT(*) as count FROM internal_bot_conversations`,
      sql`SELECT COUNT(*) as count FROM internal_bot_messages`,
      sql`SELECT COUNT(*) as count FROM internal_bot_conversations WHERE is_active = true`,
    ]);
    return {
      totalConversations:  parseInt(convR.rows[0]?.count  ?? '0'),
      totalMessages:       parseInt(msgR.rows[0]?.count   ?? '0'),
      activeConversations: parseInt(activeR.rows[0]?.count ?? '0'),
    };
  } catch (e) {
    console.error('getDatabaseStats error:', e.message);
    return { totalConversations: 0, totalMessages: 0, activeConversations: 0 };
  }
}

/**
 * Elimina conversaciones inactivas más antiguas de `daysOld` días.
 * @param {number} daysOld
 */
export async function cleanupOldConversations(daysOld = 30) {
  const r = await sql`
    DELETE FROM internal_bot_conversations
    WHERE is_active = false
      AND last_message_at < NOW() - (${daysOld} || ' days')::INTERVAL
  `;
  return r.rowCount;
}
