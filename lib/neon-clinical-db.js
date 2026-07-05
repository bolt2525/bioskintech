/**
 * @file lib/neon-clinical-db.js
 * @description Capa de base de datos para Fichas Clínicas — Neon PostgreSQL.
 *
 * Patrón: pool lazy singleton (se crea una vez por instancia serverless).
 * La función `initClinicalDatabase()` es idempotente (CREATE IF NOT EXISTS).
 *
 * Tablas gestionadas:
 *   patients, clinical_records, medical_history, consultation_info,
 *   consultation_history, physical_exams, diagnoses, treatments,
 *   prescriptions, prescription_templates, consent_forms, injectables
 *
 * Variables de entorno requeridas:
 *   NEON_DATABASE_URL  o  POSTGRES_URL
 */

import { Pool } from '@neondatabase/serverless';

// ─────────────────────────────────────────────────────────────────────────────
// Pool singleton
// ─────────────────────────────────────────────────────────────────────────────

/** @type {import('@neondatabase/serverless').Pool | null} */
let poolInstance = null;

/**
 * Devuelve el pool de conexiones (lo crea la primera vez).
 * Retorna null si la URL de conexión no está configurada.
 */
export function getPool() {
  if (poolInstance) return poolInstance;

  const connectionString = (process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if (!connectionString) {
    console.warn('⚠️  NEON_DATABASE_URL / POSTGRES_URL no configuradas. Fichas Clínicas no funcionará.');
    return null;
  }

  try {
    poolInstance = new Pool({ connectionString });
    return poolInstance;
  } catch (error) {
    console.error('❌ Error al crear Neon Pool:', error);
    return null;
  }
}

export default getPool;

// ─────────────────────────────────────────────────────────────────────────────
// Inicialización de esquema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crea todas las tablas de Fichas Clínicas si no existen.
 * Seguro para ejecutar múltiples veces (idempotente).
 */
export async function initClinicalDatabase() {
  const pool = getPool();
  if (!pool) return;

  console.log('🏥 Inicializando base de datos de Fichas Clínicas...');

  try {
    // ── Pacientes ────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id         SERIAL PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name  VARCHAR(100) NOT NULL,
        rut        VARCHAR(20)  UNIQUE,
        email      VARCHAR(150),
        phone      VARCHAR(50),
        birth_date DATE,
        gender     VARCHAR(20),
        address    TEXT,
        occupation VARCHAR(100),
        clinic_id  INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Expedientes clínicos (contenedor principal) ───────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinical_records (
        id         SERIAL PRIMARY KEY,
        patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
        status     VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Historia médica ───────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS medical_history (
        id                    SERIAL PRIMARY KEY,
        record_id             INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        pathological          TEXT,
        non_pathological      TEXT,
        family_history        TEXT,
        surgical_history      TEXT,
        allergies             TEXT,
        current_medications   TEXT,
        aesthetic_history     TEXT,
        gynecological_history TEXT,
        updated_at            TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Consulta actual (registro único por expediente) ───────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultation_info (
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE UNIQUE,
        reason          TEXT,
        current_illness TEXT,
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Historial de consultas (log) ──────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultation_history (
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        reason          TEXT,
        current_illness TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Examen físico ─────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS physical_exams (
        id               SERIAL PRIMARY KEY,
        record_id        INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        skin_type        VARCHAR(50),
        phototype        VARCHAR(255),
        glogau_scale     VARCHAR(255),
        hydration        VARCHAR(50),
        elasticity       VARCHAR(50),
        photoprotection  VARCHAR(50),
        texture          VARCHAR(50),
        pores            VARCHAR(50),
        pigmentation     VARCHAR(50),
        sensitivity      VARCHAR(50),
        lesions_description TEXT,
        face_map_data    JSONB,
        body_map_data    JSONB,
        created_at       TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Diagnósticos ──────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS diagnoses (
        id             SERIAL PRIMARY KEY,
        record_id      INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        date           TIMESTAMP DEFAULT NOW(),
        diagnosis_text TEXT NOT NULL,
        cie10_code     VARCHAR(20),
        type           VARCHAR(255) DEFAULT 'presumptive',
        severity       VARCHAR(255),
        notes          TEXT
      )
    `);

    // ── Tratamientos realizados ───────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS treatments (
        id               SERIAL PRIMARY KEY,
        record_id        INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        date             TIMESTAMP DEFAULT NOW(),
        procedure_name   VARCHAR(150) NOT NULL,
        equipment_used   VARCHAR(100),
        parameters       JSONB,
        area_treated     VARCHAR(100),
        duration_minutes INTEGER,
        cost             DECIMAL(10, 2),
        notes            TEXT,
        performed_by     VARCHAR(100)
      )
    `);

    // ── Recetas médicas ───────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prescriptions (
        id        SERIAL PRIMARY KEY,
        record_id INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        date      TIMESTAMP DEFAULT NOW(),
        diagnosis TEXT,
        items     JSONB,
        notes     TEXT
      )
    `);

    // ── Plantillas de recetas ─────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prescription_templates (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255),
        items_json JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Consentimientos informados ────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consent_forms (
        id             SERIAL PRIMARY KEY,
        record_id      INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        form_type      VARCHAR(100) NOT NULL,
        content_text   TEXT,
        signature_data TEXT,
        signed_at      TIMESTAMP DEFAULT NOW(),
        status         VARCHAR(20) DEFAULT 'signed'
      )
    `);

    // ── Inyectables (toxina botulínica, rellenos, etc.) ───────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS injectables (
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        treatment_id    INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
        date            TIMESTAMP DEFAULT NOW(),
        product_type    VARCHAR(20) DEFAULT 'toxina',
        product_name    VARCHAR(100),
        brand           VARCHAR(50),
        lot_number      VARCHAR(50),
        expiration_date DATE,
        volume_used     DECIMAL(5, 2),
        units_used      DECIMAL(6, 2),
        areas_treated   JSONB,
        technique       VARCHAR(100),
        needle_type     VARCHAR(100),
        mapping_data    JSONB,
        dilution_volume DECIMAL(5, 2),
        follow_up_date  DATE,
        notes           TEXT
      )
    `);

    // ── Migraciones incrementales (seguras en tablas preexistentes) ───────
    const migrations = [
      'ALTER TABLE physical_exams    ADD COLUMN IF NOT EXISTS face_map_data   JSONB',
      'ALTER TABLE physical_exams    ADD COLUMN IF NOT EXISTS body_map_data   JSONB',
      'ALTER TABLE consultation_history ADD COLUMN IF NOT EXISTS current_illness TEXT',
      'ALTER TABLE prescriptions     ADD COLUMN IF NOT EXISTS diagnosis       TEXT',
      'ALTER TABLE injectables       ADD COLUMN IF NOT EXISTS product_type    VARCHAR(20) DEFAULT \'toxina\'',
      'ALTER TABLE injectables       ADD COLUMN IF NOT EXISTS units_used      DECIMAL(6, 2)',
      'ALTER TABLE injectables       ADD COLUMN IF NOT EXISTS needle_type     VARCHAR(100)',
      'ALTER TABLE injectables       ADD COLUMN IF NOT EXISTS mapping_data    JSONB',
      'ALTER TABLE injectables       ADD COLUMN IF NOT EXISTS dilution_volume DECIMAL(5, 2)',
      'ALTER TABLE injectables       ADD COLUMN IF NOT EXISTS follow_up_date  DATE',
      'ALTER TABLE patients          ADD COLUMN IF NOT EXISTS clinic_id       INTEGER',
    ];
    for (const sql of migrations) {
      try { await pool.query(sql); } catch { /* columna ya existe */ }
    }

    console.log('✅ Base de datos de Fichas Clínicas inicializada correctamente');
  } catch (error) {
    console.error('❌ Error inicializando Fichas Clínicas DB:', error);
    throw error;
  }
}
