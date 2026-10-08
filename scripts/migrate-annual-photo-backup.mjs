import pg from 'pg';
import { createAnnualPhotoBackupSchema } from '../lib/annual-photo-backup.js';

// Explicit operator invocation only. Uses the existing Neon database.
if (!process.argv.includes('--apply'))
  throw new Error('Migración NO ejecutada. Requiere invocación explícita --apply; no activar Worker.');
const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('NEON_DATABASE_URL / POSTGRES_URL requerida');
const pool = new pg.Pool({ connectionString });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await createAnnualPhotoBackupSchema(client);
  await client.query('COMMIT');
  console.log('Tablas de respaldo anual y RLS preparadas. No se infirieron períodos ni contratos.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migración de respaldo anual falló:', error.code || error.name);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
