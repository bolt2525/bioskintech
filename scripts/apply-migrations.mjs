/**
 * Script para aplicar migraciones pendientes directamente a Neon PostgreSQL.
 * Corre con: node scripts/apply-migrations.mjs
 */
import { readFileSync } from 'fs';
import { parse } from 'dotenv';
import pg from 'pg';

// Cargar .env.local manualmente
const envFile = readFileSync('.env.local', 'utf-8');
const env = parse(envFile);
const connString = env.POSTGRES_URL || env.NEON_DATABASE_URL;
if (!connString) { console.error('❌ No se encontró POSTGRES_URL en .env.local'); process.exit(1); }

const client = new pg.Client({ connectionString: connString, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = { query: (q) => client.query(q) };

const migrations = [
  // Columnas faltantes en clinic_users
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS cedula_profesional VARCHAR(50)",
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS especialidad VARCHAR(100)",
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS gentilicio VARCHAR(50)",
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS profession VARCHAR(100)",
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)",
  "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS avatar_url TEXT",
  // Columnas en clinics
  "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS logo_url TEXT",
  "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS ruc VARCHAR(20)",
  "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
  "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT 'Ecuador'",
  "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS website VARCHAR(255)",
  "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS description TEXT",
  // Columnas en admin_sessions
  "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS clinic_user_id INTEGER",
  "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS role VARCHAR(30)",
  "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS clinic_id INTEGER",
  "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20)",
  // Columnas en clinic_settings
  "ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS finanzas JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS inventario JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS notificaciones JSONB NOT NULL DEFAULT '{}'",
];

const newTables = [
  // Códigos de registro
  `CREATE TABLE IF NOT EXISTS registration_codes (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(32) UNIQUE NOT NULL,
    plan_name    VARCHAR(100) NOT NULL DEFAULT 'Plan Completo',
    features     JSONB DEFAULT '[]',
    access_scope VARCHAR(20) DEFAULT 'all',
    max_patients INTEGER DEFAULT -1,
    is_active    BOOLEAN DEFAULT TRUE,
    used_by      INTEGER,
    used_at      TIMESTAMP,
    expires_at   TIMESTAMP,
    note         TEXT,
    created_by   INTEGER,
    created_at   TIMESTAMP DEFAULT NOW()
  )`,
  // Suscripciones (PayPhone)
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id                      SERIAL PRIMARY KEY,
    clinic_id               INTEGER,
    plan_name               VARCHAR(100),
    amount_cents            INTEGER NOT NULL DEFAULT 0,
    currency                VARCHAR(10) DEFAULT 'USD',
    status                  VARCHAR(30) DEFAULT 'pending',
    payphone_transaction_id VARCHAR(100),
    payphone_client_id      VARCHAR(100),
    payphone_response       JSONB,
    registration_code_id    INTEGER,
    created_at              TIMESTAMP DEFAULT NOW(),
    paid_at                 TIMESTAMP,
    expires_at              TIMESTAMP
  )`,
  // Links de invitación
  `CREATE TABLE IF NOT EXISTS invite_links (
    id          SERIAL PRIMARY KEY,
    token       VARCHAR(64) UNIQUE NOT NULL,
    clinic_id   INTEGER,
    role        VARCHAR(30) DEFAULT 'clinic_user',
    email       VARCHAR(255),
    features    JSONB DEFAULT '[]',
    is_used     BOOLEAN DEFAULT FALSE,
    used_by     INTEGER,
    created_by  INTEGER,
    expires_at  TIMESTAMP NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
  )`,
  // Estados OAuth (prevención CSRF)
  `CREATE TABLE IF NOT EXISTS oauth_states (
    id         SERIAL PRIMARY KEY,
    state      VARCHAR(64) UNIQUE NOT NULL,
    purpose    VARCHAR(20) DEFAULT 'login',
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  // OTP de verificación en dos pasos (2FA)
  `CREATE TABLE IF NOT EXISTS login_otp (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES clinic_users(id) ON DELETE CASCADE,
    email      VARCHAR(255) NOT NULL,
    otp_token  VARCHAR(64) UNIQUE NOT NULL,
    code       VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used       BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
];

async function run() {
  console.log('🔧 Aplicando migraciones a Neon PostgreSQL...\n');

  for (const q of newTables) {
    const name = q.match(/TABLE IF NOT EXISTS (\w+)/)?.[1] || 'tabla';
    try {
      await sql.query(q);
      console.log(`✅ Tabla: ${name}`);
    } catch (e) {
      console.log(`⚠️  Tabla ${name}: ${e.message}`);
    }
  }

  for (const q of migrations) {
    const col = q.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1] || q;
    try {
      await sql.query(q);
      console.log(`✅ Columna: ${col}`);
    } catch (e) {
      console.log(`⚠️  ${col}: ${e.message}`);
    }
  }

  await client.end();
  console.log('\n✅ Migraciones completadas.');
  process.exit(0);
}

run().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
