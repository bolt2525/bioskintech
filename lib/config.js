/**
 * @file lib/config.js
 * @description Configuración global del servidor para BIOSKIN Admin.
 * Solo constantes que se usan en múltiples funciones serverless.
 */

/** Números de WhatsApp del staff (formato internacional sin +)
 * Configurar vía variable de entorno STAFF_WHATSAPP_NUMBERS (separados por coma).
 */
export const STAFF_NUMBERS = (process.env.STAFF_WHATSAPP_NUMBERS || '593997061321,593969890689,593998653732')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
