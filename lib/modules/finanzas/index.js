/**
 * @file lib/modules/finanzas/index.js
 * @description Módulo de Finanzas — ingresos, egresos y reportes.
 *
 * ─── Funcionalidades ─────────────────────────────────────────────────────────
 *  - Registro de transacciones (income / expense)
 *  - Estadísticas mensuales y por categoría
 *  - Análisis con IA (parseo de notas médicas)
 *  - Integración con bot WhatsApp interno (finance-bot-handler)
 *
 * ─── Base de datos ───────────────────────────────────────────────────────────
 * Tabla: external_finance_records (Neon PostgreSQL)
 *
 * @see api/external-finance.js     — Handler HTTP de finanzas
 * @see lib/finance-db.js           — Queries de finanzas
 * @see lib/finance-ai-service.js   — IA para análisis de notas
 * @see lib/medical-finance-service.js — Cálculos médicos financieros
 * @see lib/finance-bot-handler.js  — Procesador de mensajes del bot
 */
export * from '../../finance-db.js';
export * from '../../finance-ai-service.js';
export * from '../../medical-finance-service.js';
