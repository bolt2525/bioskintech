/**
 * @file lib/modules/bot-interno/index.js
 * @description Módulo del Bot WhatsApp Interno — agenda diaria y notificaciones al staff.
 *
 * ─── Funcionalidades ─────────────────────────────────────────────────────────
 *  - Envío de agenda diaria a staff vía WhatsApp
 *  - Procesamiento de mensajes entrantes del staff
 *  - Sub-módulos: médico, técnico, citas, finanzas
 *  - Limpieza automática de conversaciones antiguas (cleanup)
 *
 * ─── Cron ────────────────────────────────────────────────────────────────────
 * Configurado en vercel.json:
 *   POST /api/internal-bot-api?type=internal-chat&action=daily-agenda
 *   Schedule: 0 12 * * * (12:00 UTC = 7:00 EC)
 *
 * ─── Variables de entorno ────────────────────────────────────────────────────
 *   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *   WHATSAPP_GROUP_ID, INTERNAL_BOT_SECRET
 *   OPENAI_API_KEY
 *
 * @see api/internal-bot-api.js          — Handler HTTP del bot
 * @see api/whatsapp-internal.js         — Webhook de WhatsApp
 * @see lib/internal-bot-service.js      — Lógica principal del bot
 * @see lib/neon-chatbot-db.js           — Persistencia de conversaciones
 */
export * from '../../internal-bot-service.js';
