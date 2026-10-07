import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  console.error('NEON_DATABASE_URL / POSTGRES_URL no definida');
  process.exit(1);
}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: true } });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const clinicIdType = await client.query(`
    SELECT udt_name
    FROM information_schema.columns
    WHERE table_name = 'financial_records' AND column_name = 'clinic_id'
  `);
  if (clinicIdType.rows[0]?.udt_name !== 'uuid') {
    throw new Error(`financial_records.clinic_id debe ser UUID; tipo actual: ${clinicIdType.rows[0]?.udt_name || 'ausente'}`);
  }
  await client.query(`
    ALTER TABLE financial_records
      ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS source_module VARCHAR(40),
      ADD COLUMN IF NOT EXISTS source_type VARCHAR(60),
      ADD COLUMN IF NOT EXISTS source_id INTEGER,
      ADD COLUMN IF NOT EXISTS source_package_id INTEGER,
      ADD COLUMN IF NOT EXISTS source_record_id INTEGER,
      ADD COLUMN IF NOT EXISTS source_consultation_id INTEGER,
      ADD COLUMN IF NOT EXISTS idempotency_key UUID
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_records_treatment_source
      ON financial_records(clinic_id, source_type, source_id)
      WHERE source_module = 'treatments'
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_records_idempotency
      ON financial_records(clinic_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_financial_records_treatment_package
      ON financial_records(clinic_id, source_package_id, date)
      WHERE source_module = 'treatments'
  `);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE financial_items
        ADD CONSTRAINT financial_items_record_fk
        FOREIGN KEY (record_id) REFERENCES financial_records(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await client.query('COMMIT');
  console.log('Migración tratamientos → finanzas aplicada correctamente');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('No se pudo aplicar la migración tratamientos → finanzas:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
