/**
 * @file lib/db/index.js
 * @description Capa de acceso a base de datos — punto de entrada único.
 *
 * ─── Base de datos ───────────────────────────────────────────────────────────
 * BIOSKIN_2.0 usa ÚNICAMENTE Neon PostgreSQL.
 * NO hay SQLite, MongoDB, ni ninguna otra base de datos.
 *
 * ─── Dos clientes disponibles ────────────────────────────────────────────────
 *
 * 1. `getPool()` — driver `pg` (recomendado para queries complejas, fichas clínicas)
 *    - Permite `pool.query(sql, params)` con tipo seguro
 *    - Configura type parsers para evitar el bug de fechas -1 día (timezone Ecuador)
 *    - Importar desde: `import { getPool } from '../lib/db/index.js'`
 *
 * 2. `sql` — @vercel/postgres (recomendado para queries simples, auth, chatbot)
 *    - Template literal: `await sql\`SELECT * FROM table WHERE id = ${id}\``
 *    - Optimizado para Vercel Serverless
 *    - Importar desde: `import { sql } from '../lib/db/index.js'`
 *
 * ─── Variables de entorno requeridas ─────────────────────────────────────────
 *   NEON_DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
 *   POSTGRES_URL=(alternativa, usada por Vercel Postgres integration)
 *
 * ─── Cómo conectar en Vercel ─────────────────────────────────────────────────
 *   1. Crear una base de datos en https://neon.tech
 *   2. Copiar la connection string de Neon
 *   3. Agregarla como NEON_DATABASE_URL en Vercel → Settings → Environment Variables
 *   4. Re-deploy
 *
 * @see lib/neon-clinical-db.js — implementación del pool clínico
 * @see lib/neon-chatbot-db.js  — implementación de tablas del bot
 */

// Re-exporta el pool clínico (driver pg con type parsers de fechas)
export { getPool } from '../neon-clinical-db.js';

// Re-exporta el cliente sql de @vercel/postgres (para auth, bot, etc.)
export { sql } from '@vercel/postgres';

/**
 * Verifica que las variables de entorno de base de datos están configuradas.
 * Útil para diagnosticar en el arranque de funciones serverless.
 * @returns {{ ok: boolean, provider: string|null }}
 */
export function checkDbConfig() {
  const neon     = process.env.NEON_DATABASE_URL;
  const postgres  = process.env.POSTGRES_URL;

  if (neon)     return { ok: true, provider: 'NEON_DATABASE_URL' };
  if (postgres) return { ok: true, provider: 'POSTGRES_URL' };

  console.error('⚠️ DB config: ni NEON_DATABASE_URL ni POSTGRES_URL están configuradas');
  return { ok: false, provider: null };
}
