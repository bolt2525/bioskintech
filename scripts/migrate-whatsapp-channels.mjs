import pg from 'pg';
import { initWhatsAppChannels } from '../lib/whatsapp-channels.js';

const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('NEON_DATABASE_URL / POSTGRES_URL requerida');
const pool = new pg.Pool({ connectionString });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await initWhatsAppChannels((text, values) => client.query(text, values));
  await client.query('COMMIT');
  console.log('Canales y estados de WhatsApp creados; permisos clínicos revocados.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
