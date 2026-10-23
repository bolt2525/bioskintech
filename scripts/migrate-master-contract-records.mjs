import 'dotenv/config';
import pg from 'pg';

const connectionString = process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
if (!connectionString) throw new Error('POSTGRES_URL o NEON_DATABASE_URL no está configurada.');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('BEGIN');
  await client.query(`
    CREATE TABLE IF NOT EXISTS master_contract_records (
      id BIGSERIAL PRIMARY KEY,
      contract_reference VARCHAR(120) NOT NULL UNIQUE,
      client_name VARCHAR(200) NOT NULL,
      tax_id VARCHAR(13) NOT NULL,
      clinic_name VARCHAR(200) NOT NULL,
      contact_email VARCHAR(254) NOT NULL,
      legal_version VARCHAR(40) NOT NULL,
      annual_total NUMERIC(12, 2) NOT NULL CHECK (annual_total >= 0),
      contract_data JSONB NOT NULL,
      created_by_user_id INTEGER REFERENCES clinic_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const appRoleExists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'bioskin_app'");
  if (appRoleExists.rows.length) {
    await client.query('REVOKE ALL ON TABLE master_contract_records FROM bioskin_app');
    await client.query('REVOKE ALL ON SEQUENCE master_contract_records_id_seq FROM bioskin_app');
  }
  await client.query('COMMIT');
  console.log('Tabla master_contract_records lista en Neon.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
