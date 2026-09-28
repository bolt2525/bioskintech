import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('NEON_DATABASE_URL o POSTGRES_URL es requerida');

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

const migrations = [
  'ALTER TABLE patients ADD COLUMN IF NOT EXISTS identification_type VARCHAR(16)',
  'ALTER TABLE patients ADD COLUMN IF NOT EXISTS identification_number VARCHAR(20)',
  'UPDATE patients SET identification_number = rut WHERE identification_number IS NULL AND rut IS NOT NULL',
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_identification_clinic
     ON patients(identification_type, identification_number, clinic_id)
     WHERE identification_type IS NOT NULL AND identification_number IS NOT NULL AND clinic_id IS NOT NULL`,
  'ALTER TABLE patient_audit_log ADD COLUMN IF NOT EXISTS clinic_id UUID',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_expires_at TIMESTAMPTZ',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_sender_user_id INTEGER',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_email VARCHAR(254)',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_otp_hash VARCHAR(64)',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_otp_attempts INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_verified_at TIMESTAMPTZ',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_session_hash VARCHAR(64)',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_session_expires_at TIMESTAMPTZ',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_snapshot JSONB',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_snapshot_hash VARCHAR(64)',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_hash VARCHAR(64)',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_signed_at TIMESTAMPTZ',
  'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_copy_sent_at TIMESTAMPTZ',
  `UPDATE consent_forms SET signing_status = 'signed'
   WHERE (status IN ('signed', 'finalized') OR signature_data IS NOT NULL OR signed_at IS NOT NULL
     OR signing_signed_at IS NOT NULL OR NULLIF(signatures->>'patient_sig_data', '') IS NOT NULL
     OR NULLIF(signatures->>'patient_signed_at', '') IS NOT NULL)
     AND COALESCE(signing_status, 'pending') <> 'signed'`,
  'CREATE INDEX IF NOT EXISTS idx_consent_forms_patient ON consent_forms(patient_id)',
  'CREATE INDEX IF NOT EXISTS idx_consent_forms_token ON consent_forms(signing_token)',
];

try {
  await client.query('BEGIN');
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [['patients', 'clinical_records', 'consent_forms', 'patient_audit_log']]
  );
  const found = new Set(tables.rows.map(row => row.table_name));
  const missing = ['patients', 'clinical_records', 'consent_forms', 'patient_audit_log'].filter(table => !found.has(table));
  if (missing.length) throw new Error(`Tablas clínicas requeridas no encontradas: ${missing.join(', ')}`);

  for (const migration of migrations) await client.query(migration);

  const verification = await client.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND (
       (table_name = 'patients' AND column_name IN ('identification_type', 'identification_number')) OR
       (table_name = 'patient_audit_log' AND column_name = 'clinic_id') OR
       (table_name = 'consent_forms' AND column_name IN (
         'signing_token', 'signing_status', 'signing_expires_at', 'signing_sender_user_id', 'signing_email',
         'signing_otp_hash', 'signing_otp_attempts', 'signing_verified_at',
         'signing_session_hash', 'signing_session_expires_at', 'signing_snapshot',
         'signing_snapshot_hash', 'signing_hash', 'signing_signed_at', 'signing_copy_sent_at'
       ))
     ) ORDER BY table_name, column_name`
  );
  await client.query('COMMIT');
  console.log(`Migración aplicada y verificada: ${verification.rows.length} columnas; sin imprimir datos clínicos.`);
  console.table(verification.rows);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}