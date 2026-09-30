// Migración idempotente: nombre del paciente de la cita en los mensajes de WhatsApp.
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

await pool.query('ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS appointment_patient_name VARCHAR(150)');
const r = await pool.query(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name = 'whatsapp_messages' AND column_name LIKE 'appointment%'
   ORDER BY ordinal_position`
);
console.table(r.rows);
await pool.end();
