/**
 * @file lib/neon-chatbot-db-vercel.js
 * @description Alias de lib/neon-chatbot-db.js para compatibilidad con imports existentes.
 * Los archivos api/internal-bot-api.js y api/whatsapp-internal.js importan desde este path.
 *
 * Toda la lógica real está en lib/neon-chatbot-db.js.
 */
export * from './neon-chatbot-db.js';
