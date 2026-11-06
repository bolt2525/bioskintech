/**
 * Prepared operator command (never run by the API):
 * node --env-file=.env.local scripts/migrate-skin-visual-ai.mjs
 * Node loads the operator's environment; this script never reads/dumps .env files.
 */
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

class MigrationError extends Error {}

function neonIdentity(value) {
  const invalid = () => {
    throw new MigrationError('Configuración DB inválida o ambigua: use un endpoint Neon y nombre de base explícitos.');
  };
  if (typeof value !== 'string' || !value.trim()) invalid();
  let parsed, database;
  try {
    parsed = new URL(value.trim());
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch { invalid(); }
  const host = parsed.hostname.toLowerCase();
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hash ||
      (parsed.port && parsed.port !== '5432') || !database || /[/\\\u0000]/u.test(database) ||
      !/^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)*neon\.tech$/.test(host)) invalid();
  // Reject query parameters that could override the host/database parsed above.
  // Credentials and TLS options may differ, but can never alter DB identity.
  const nonRouting = new Set([
    'user', 'password', 'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword',
    'channel_binding', 'application_name', 'connect_timeout', 'pgbouncer',
  ]);
  if ([...parsed.searchParams.keys()].some(key => !nonRouting.has(key))) invalid();
  const [endpoint, ...suffix] = host.split('.');
  return { host: [endpoint.replace(/-pooler$/, ''), ...suffix].join('.'), database };
}

async function migrationSql(name) {
  const source = await readFile(new URL(name, import.meta.url), 'utf8');
  // Both prepared files have their own outer transaction for SQL-editor use.
  // The runner always owns ONE transaction for both DDL files on ONE Neon DB.
  if (!/^BEGIN;\s*$/m.test(source) || !/^COMMIT;\s*$/m.test(source))
    throw new Error('Archivo de migración sin transacción reconocida.');
  return source.replace(/^BEGIN;[ \t]*\r?\n/m, '').replace(/^COMMIT;[ \t]*$/m, '');
}

export async function migrateSkinVisualAi({ env = process.env, Client = pg.Client } = {}) {
  const configured = [env.NEON_DATABASE_URL, env.POSTGRES_URL].filter(value => value !== undefined);
  if (!configured.length) throw new MigrationError('Falta NEON_DATABASE_URL o POSTGRES_URL para migrar la base única.');
  const identities = configured.map(neonIdentity);
  if (identities.some(identity => identity.host !== identities[0].host || identity.database !== identities[0].database))
    throw new MigrationError('NEON_DATABASE_URL y POSTGRES_URL no identifican la misma base Neon; migración bloqueada.');
  // Select owner URL exactly as getPool(); never connect to a second target.
  // Validate ALL supplied URLs before reading DDL, constructing clients or issuing queries.
  const connectionString = (env.NEON_DATABASE_URL || env.POSTGRES_URL).trim();
  const authSql = await migrationSql('skin-visual-ai-schema.sql');
  const clinicalSql = await migrationSql('skin-visual-review-schema.sql');
  let client;
  try {
    client = new Client({ connectionString });
    await client.connect();
    await client.query('BEGIN');
    await client.query(authSql);
    await client.query(clinicalSql);
    await client.query('COMMIT');
  } catch {
    try { await client?.query('ROLLBACK'); } catch { /* no secret-bearing DB error output */ }
    throw new MigrationError('Falló la migración única de auth y clínica. Revise permisos/esquema mediante un canal seguro; puede reintentar.');
  } finally { await client?.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrateSkinVisualAi();
    console.log('Migración visual IA y revisión clínica completada; ninguna feature fue activada.');
  } catch (error) {
    // Only our fixed migration errors are exposed, never PG payloads/URLs/credentials.
    console.error(error instanceof MigrationError
      ? error.message : 'No se pudo preparar la migración. Revise los archivos SQL locales.');
    process.exitCode = 1;
  }
}
