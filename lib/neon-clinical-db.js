/**
 * @file lib/neon-clinical-db.js
 * @description Capa de base de datos para Fichas Clínicas — Neon PostgreSQL.
 *
 * Dos pools:
 *   getPool()    → neondb_owner — para migrations, schema init, master_admin ops (bypasa RLS)
 *   getAppPool() → bioskin_app  — para queries clínicas con RLS enforced (NEON_APP_URL)
 *
 * withTenantContext(clinicId, queryFn) — inyecta app.current_tenant vía BEGIN/set_config/COMMIT
 *   ponytail: is_local=true revierte al fin de la TX, seguro con connection pooling.
 *
 * Variables de entorno:
 *   NEON_DATABASE_URL / POSTGRES_URL  → neondb_owner (admin)
 *   NEON_APP_URL                      → bioskin_app  (app, con RLS)
 */

import { Pool } from '@neondatabase/serverless';

// ─────────────────────────────────────────────────────────────────────────────
// Pools — neondb_owner (admin) + bioskin_app (app, RLS enforced)
// ─────────────────────────────────────────────────────────────────────────────

let poolInstance    = null;  // neondb_owner
let appPoolInstance = null;  // bioskin_app

function makePool(url) {
  return new Pool({ connectionString: url.trim() });
}

/** Pool neondb_owner — bypasa RLS. Solo para migrations, schema init y master_admin ops. */
export function getPool() {
  if (poolInstance) return poolInstance;
  const url = (process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if (!url) { console.warn('⚠️  NEON_DATABASE_URL no configurada'); return null; }
  try { poolInstance = makePool(url); return poolInstance; }
  catch (e) { console.error('❌ Error creando pool admin:', e); return null; }
}

/** Pool bioskin_app — con RLS enforced. Usar para TODAS las queries clínicas. */
export function getAppPool() {
  if (appPoolInstance) return appPoolInstance;
  const url = (process.env.NEON_APP_URL || '').trim();
  if (!url) { console.warn('⚠️  NEON_APP_URL no configurada. Usando neondb_owner (sin RLS).'); return getPool(); }
  try { appPoolInstance = makePool(url); return appPoolInstance; }
  catch (e) { console.error('❌ Error creando pool app:', e); return getPool(); }
}

export default getPool;

/**
 * Ejecuta queryFn dentro de una transacción con el tenant RLS configurado.
 * set_config is_local=true → la config se revierte automáticamente al COMMIT/ROLLBACK.
 *
 * @param {string|null} clinicId - UUID de la clínica. Null = master op sin tenant.
 * @param {(client: import('@neondatabase/serverless').PoolClient) => Promise<any>} queryFn
 */
export async function withTenantContext(clinicId, queryFn) {
  const pool = getAppPool();
  if (!pool) throw new Error('App pool no disponible');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant', $1, true)",
      [clinicId ? String(clinicId) : '']
    );
    const result = await queryFn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inicialización de esquema — usa neondb_owner para CREATE TABLE y RLS setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crea todas las tablas de Fichas Clínicas con schema UUID limpio.
 * Idempotente — safe para ejecutar múltiples veces.
 * Llama a esta función una vez con el pool neondb_owner antes de usar getAppPool().
 */
export async function initClinicalDatabase() {
  const pool = getPool();
  if (!pool) return;

  console.log('🏥 Inicializando base de datos de Fichas Clínicas...');

  try {
    // ── Pacientes ────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id                  SERIAL PRIMARY KEY,
        first_name          VARCHAR(100) NOT NULL,
        last_name           VARCHAR(100) NOT NULL,
        rut                 VARCHAR(20),
        email               VARCHAR(150),
        phone               VARCHAR(50),
        birth_date          DATE,
        gender              VARCHAR(20),
        address             TEXT,
        occupation          VARCHAR(100),
        clinic_id           UUID,
        created_by_user_id  INTEGER,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_rut_clinic
        ON patients(rut, clinic_id)
        WHERE rut IS NOT NULL AND clinic_id IS NOT NULL
    `);

    // ── Expedientes clínicos — clinic_id denormalizado para RLS eficiente ─
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinical_records (
        id                  SERIAL PRIMARY KEY,
        patient_id          INTEGER REFERENCES patients(id) ON DELETE CASCADE,
        clinic_id           UUID,
        created_by_user_id  INTEGER,
        status              VARCHAR(20) DEFAULT 'active',
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE clinical_records ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clinical_records_clinic ON clinical_records(clinic_id)`);

    // ── Historia médica ───────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS medical_history (
        id                    SERIAL PRIMARY KEY,
        record_id             INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        clinic_id             UUID,
        pathological          TEXT,
        non_pathological      TEXT,
        family_history        TEXT,
        surgical_history      TEXT,
        allergies             TEXT,
        current_medications   TEXT,
        aesthetic_history     TEXT,
        gynecological_history TEXT,
        facial_routine        TEXT,
        updated_at            TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Consulta actual (registro único por expediente) ───────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultation_info (
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE UNIQUE,
        clinic_id       UUID,
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
        clinic_id       UUID,
        reason          TEXT,
        current_illness TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Examen físico ─────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS physical_exams (
        id                  SERIAL PRIMARY KEY,
        record_id           INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        clinic_id           UUID,
        consultation_id     INTEGER,
        skin_type           VARCHAR(50),
        phototype           VARCHAR(255),
        glogau_scale        VARCHAR(255),
        hydration           VARCHAR(50),
        elasticity          VARCHAR(50),
        photoprotection     VARCHAR(50),
        texture             VARCHAR(50),
        pores               VARCHAR(50),
        pigmentation        VARCHAR(50),
        sensitivity         VARCHAR(50),
        lesions_description TEXT,
        face_map_data       JSONB,
        body_map_data       JSONB,
        created_at          TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Diagnósticos ──────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS diagnoses (
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        clinic_id       UUID,
        consultation_id INTEGER,
        date            TIMESTAMP DEFAULT NOW(),
        diagnosis_text  TEXT NOT NULL,
        cie10_code      VARCHAR(20),
        type            VARCHAR(255) DEFAULT 'presumptive',
        severity        VARCHAR(255),
        notes           TEXT
      )
    `);

    // ── Tratamientos realizados ───────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS treatments (
        id               SERIAL PRIMARY KEY,
        record_id        INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        clinic_id        UUID,
        consultation_id  INTEGER,
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
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        clinic_id       UUID,
        consultation_id INTEGER,
        date            TIMESTAMP DEFAULT NOW(),
        diagnosis       TEXT,
        items           JSONB,
        notes           TEXT
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
        id                   SERIAL PRIMARY KEY,
        record_id            INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        patient_id           INTEGER REFERENCES patients(id) ON DELETE CASCADE,
        clinic_id            UUID,
        consultation_id      INTEGER,
        form_type            VARCHAR(100),
        content_text         TEXT,
        signature_data       TEXT,
        signed_at            TIMESTAMP,
        status               VARCHAR(20) DEFAULT 'signed',
        created_at           TIMESTAMP DEFAULT NOW(),
        updated_at           TIMESTAMP DEFAULT NOW(),
        created_by           VARCHAR(100),
        procedure_type       VARCHAR(150),
        zone                 VARCHAR(150),
        sessions             INTEGER,
        objectives           JSONB,
        description          TEXT,
        risks                JSONB,
        benefits             JSONB,
        alternatives         JSONB,
        pre_care             JSONB,
        post_care            JSONB,
        contraindications    JSONB,
        critical_antecedents JSONB,
        authorizations       JSONB,
        declarations         JSONB,
        signatures           JSONB,
        attachments          JSONB,
        signing_token        VARCHAR(100),
        signing_status       VARCHAR(20) DEFAULT 'pending'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_consent_forms_patient ON consent_forms(patient_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_consent_forms_token   ON consent_forms(signing_token)`);

    // ── Inyectables (toxina botulínica, rellenos, etc.) ───────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS injectables (
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        treatment_id    INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
        clinic_id       UUID,
        consultation_id INTEGER,
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
        injection_plane VARCHAR(100),
        mapping_data    JSONB,
        dilution_volume DECIMAL(5, 2),
        follow_up_date  DATE,
        relleno_subtype VARCHAR(30),
        notes           TEXT
      )
    `);

    // ── Inventario (tablas de stock, lotes y movimientos) ─────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id                     SERIAL PRIMARY KEY,
        clinic_id              UUID,
        sku                    VARCHAR(50),
        name                   VARCHAR(200) NOT NULL,
        brand                  VARCHAR(120),
        description            TEXT,
        category               VARCHAR(100),
        group_name             VARCHAR(100),
        unit_of_measure        VARCHAR(20),
        min_stock_level        NUMERIC(12,2) DEFAULT 0,
        requires_cold_chain    BOOLEAN DEFAULT false,
        sanitary_registration  VARCHAR(100),
        cost_price             NUMERIC(12,2),
        sale_price             NUMERIC(12,2),
        preferred_display_unit VARCHAR(20) DEFAULT 'absolute',
        created_by_user_id     INTEGER,
        created_at             TIMESTAMP DEFAULT NOW(),
        updated_at             TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_items_clinic ON inventory_items(clinic_id)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_sku_clinic
        ON inventory_items(clinic_id, sku)
        WHERE sku IS NOT NULL AND clinic_id IS NOT NULL
    `);
    // ── Lotes de inventario ───────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_batches (
        id               SERIAL PRIMARY KEY,
        item_id          INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
        clinic_id        UUID,
        batch_number     VARCHAR(100),
        expiration_date  DATE,
        quantity_initial NUMERIC(12,2) NOT NULL,
        quantity_current NUMERIC(12,2) NOT NULL,
        cost_per_unit    NUMERIC(12,4),
        status           VARCHAR(20) DEFAULT 'active',
        created_at       TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id              SERIAL PRIMARY KEY,
        batch_id        INTEGER REFERENCES inventory_batches(id) ON DELETE CASCADE,
        clinic_id       UUID,
        movement_type   VARCHAR(30) NOT NULL,
        quantity_change NUMERIC(12,2) NOT NULL,
        reason          TEXT,
        reference_id    INTEGER,
        user_id         INTEGER,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Finanzas clínica (ingresos / egresos internos) ────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_records (
        id                 SERIAL PRIMARY KEY,
        clinic_id          UUID,
        date               DATE NOT NULL DEFAULT CURRENT_DATE,
        invoice_number     VARCHAR(100),
        entity             VARCHAR(255),
        description        TEXT,
        type               VARCHAR(20) NOT NULL DEFAULT 'ingreso',
        subtotal           NUMERIC(12,2) DEFAULT 0,
        tax                NUMERIC(12,2) DEFAULT 0,
        total              NUMERIC(12,2) DEFAULT 0,
        registered_by      VARCHAR(100),
        created_by_user_id INTEGER,
        status             VARCHAR(20) DEFAULT 'confirmed',
        created_at         TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_financial_records_clinic ON financial_records(clinic_id)`);

    // ── Items de factura (desglose de líneas) ─────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_items (
        id          SERIAL PRIMARY KEY,
        record_id   INTEGER NOT NULL,
        clinic_id   UUID,
        description TEXT NOT NULL,
        quantity    NUMERIC(10,2) DEFAULT 1,
        unit_price  NUMERIC(12,4) NOT NULL,
        iva_rate    NUMERIC(5,2)  DEFAULT 0,
        subtotal    NUMERIC(12,2) NOT NULL,
        tax         NUMERIC(12,2) DEFAULT 0,
        total       NUMERIC(12,2) NOT NULL,
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_financial_items_record ON financial_items(record_id)`);

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
      'ALTER TABLE injectables       ADD COLUMN IF NOT EXISTS injection_plane VARCHAR(100)',
      'ALTER TABLE patients          ADD COLUMN IF NOT EXISTS clinic_id         INTEGER',
      'ALTER TABLE patients          ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER',
      // Columnas extendidas de antecedentes médicos
      'ALTER TABLE medical_history   ADD COLUMN IF NOT EXISTS facial_routine    TEXT',
      // consent_forms: upgrade del schema simple al schema completo con firma remota
      'ALTER TABLE consent_forms ALTER COLUMN form_type DROP NOT NULL',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS patient_id        INTEGER REFERENCES patients(id) ON DELETE CASCADE',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS created_at        TIMESTAMP DEFAULT NOW()',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMP DEFAULT NOW()',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS created_by        VARCHAR(100)',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS procedure_type    VARCHAR(150)',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS zone              VARCHAR(150)',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS sessions          INTEGER',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS objectives        JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS description       TEXT',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS risks             JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS benefits          JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS alternatives      JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS pre_care          JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS post_care         JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS contraindications JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS critical_antecedents JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS authorizations    JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS declarations      JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signatures        JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS attachments       JSONB',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_token     VARCHAR(100)',
      'ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signing_status    VARCHAR(20) DEFAULT \'pending\'',
      'CREATE INDEX IF NOT EXISTS idx_consent_forms_patient ON consent_forms(patient_id)',
      'CREATE INDEX IF NOT EXISTS idx_consent_forms_token   ON consent_forms(signing_token)',
      // Inventario — columnas añadidas después de la creación inicial de las tablas
      'ALTER TABLE inventory_items   ADD COLUMN IF NOT EXISTS cost_price             NUMERIC(12,2)',
      'ALTER TABLE inventory_items   ADD COLUMN IF NOT EXISTS sale_price             NUMERIC(12,2)',
      'ALTER TABLE inventory_items   ADD COLUMN IF NOT EXISTS brand                  VARCHAR(120)',
      'ALTER TABLE inventory_items   ADD COLUMN IF NOT EXISTS preferred_display_unit VARCHAR(20) DEFAULT \'absolute\'',
      // Finanzas multi-tenant
      'ALTER TABLE financial_records ADD COLUMN IF NOT EXISTS clinic_id INTEGER',
      'CREATE INDEX IF NOT EXISTS idx_financial_records_clinic ON financial_records(clinic_id)',
      // Items de factura (FK idempotente)
      'ALTER TABLE financial_items ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0',
      'CREATE INDEX IF NOT EXISTS idx_financial_items_record ON financial_items(record_id)',
      // Inventario multi-tenant
      'ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS clinic_id INTEGER',
      'CREATE INDEX IF NOT EXISTS idx_inventory_items_clinic ON inventory_items(clinic_id)',
      // Eliminar constraint UNIQUE global de SKU → reemplazar por UNIQUE por clínica
      'ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_sku_key',
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_sku_clinic
         ON inventory_items(clinic_id, sku)
         WHERE sku IS NOT NULL AND clinic_id IS NOT NULL`,
      // Audit log: clinic_id para queries rápidos sin JOIN
      'ALTER TABLE patient_audit_log ADD COLUMN IF NOT EXISTS clinic_id INTEGER',
      // Inventario y finanzas — columna de propietario para scope por usuario
      'ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER',
      'ALTER TABLE financial_records ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER',
    ];
    for (const sql of migrations) {
      try { await pool.query(sql); } catch { /* columna ya existe */ }
    }

    // ── Consent templates (plantillas globales, sin tenant) ──────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consent_templates (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(255) NOT NULL,
        procedure_type    VARCHAR(150),
        zone              VARCHAR(150),
        sessions          INTEGER DEFAULT 1,
        objectives        JSONB DEFAULT '[]',
        description       TEXT,
        risks             JSONB DEFAULT '[]',
        benefits          JSONB DEFAULT '[]',
        alternatives      JSONB DEFAULT '[]',
        pre_care          JSONB DEFAULT '[]',
        post_care         JSONB DEFAULT '[]',
        contraindications JSONB DEFAULT '[]',
        is_active         BOOLEAN DEFAULT true,
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Overrides de módulo por usuario ───────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_module_overrides (
        clinic_user_id INTEGER NOT NULL,
        feature        VARCHAR(50) NOT NULL,
        enabled        BOOLEAN DEFAULT false,
        PRIMARY KEY (clinic_user_id, feature)
      )
    `);

    // ── Audit log de pacientes ─────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patient_audit_log (
        id                SERIAL PRIMARY KEY,
        patient_id        INTEGER REFERENCES patients(id) ON DELETE CASCADE,
        record_id         INTEGER REFERENCES clinical_records(id) ON DELETE SET NULL,
        clinic_id         UUID,
        clinic_user_id    INTEGER,
        user_display_name VARCHAR(255),
        action_type       VARCHAR(30) NOT NULL,
        module            VARCHAR(50) NOT NULL,
        summary           TEXT,
        field_changes     JSONB,
        created_at        TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_patient  ON patient_audit_log(patient_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_clinic   ON patient_audit_log(clinic_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_created  ON patient_audit_log(created_at DESC)`);

    // ── Asignaciones de pacientes ─────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patient_assignments (
        id             SERIAL PRIMARY KEY,
        patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        clinic_user_id INTEGER NOT NULL,
        assigned_by    INTEGER,
        assigned_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE (patient_id, clinic_user_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_patient_assignments_user    ON patient_assignments(clinic_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_patient_assignments_patient ON patient_assignments(patient_id)`);

    // ── Grupos de compartición ────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sharing_groups (
        id          SERIAL PRIMARY KEY,
        clinic_id   UUID NOT NULL,
        name        VARCHAR(100) NOT NULL,
        description VARCHAR(255),
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sharing_group_members (
        group_id       INTEGER NOT NULL REFERENCES sharing_groups(id) ON DELETE CASCADE,
        clinic_user_id INTEGER NOT NULL,
        added_at       TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (group_id, clinic_user_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sharing_group_clinic ON sharing_groups(clinic_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sharing_member_user  ON sharing_group_members(clinic_user_id)`);

    // ── Catálogo global de inyectables ────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS injectable_catalog (
        id          SERIAL PRIMARY KEY,
        categoria   VARCHAR(100) NOT NULL,
        elemento    VARCHAR(200) NOT NULL,
        descripcion TEXT,
        activo      INTEGER DEFAULT 1,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Consultas (hub de sesión por expediente) ──────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultations (
        id                  SERIAL PRIMARY KEY,
        record_id           INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        clinic_id           UUID,
        reason              TEXT,
        current_illness     TEXT,
        enable_injectables  BOOLEAN DEFAULT FALSE,
        enable_consents     BOOLEAN DEFAULT FALSE,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_consultations_record ON consultations(record_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_consultations_clinic ON consultations(clinic_id)`);

    // ── Snapshots de antecedentes ─────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS medical_history_snapshots (
        id            SERIAL PRIMARY KEY,
        record_id     INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        clinic_id     UUID,
        snapshot_data JSONB NOT NULL,
        changed_by    VARCHAR(100),
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_history_snapshots_record ON medical_history_snapshots(record_id)`);

    // ── Firmas profesionales (global, sin tenant) ─────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS professional_signatures (
        id                SERIAL PRIMARY KEY,
        professional_name VARCHAR(150) NOT NULL UNIQUE,
        cedula            VARCHAR(50),
        signature_data    TEXT,
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Fotos clínicas (Cloudflare R2) ────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinical_photos (
        id              SERIAL PRIMARY KEY,
        record_id       INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        consultation_id INTEGER,
        clinic_id       UUID,
        r2_key          VARCHAR(500) NOT NULL,
        photo_type      VARCHAR(50) DEFAULT 'general',
        face_zone       VARCHAR(100),
        body_zone       VARCHAR(100),
        session_label   VARCHAR(100),
        notes           TEXT,
        taken_at        TIMESTAMP DEFAULT NOW(),
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_photos_record ON clinical_photos(record_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_photos_clinic ON clinical_photos(clinic_id)`);

    // ── Firmas profesionales ──────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS professional_signatures (
        id                SERIAL PRIMARY KEY,
        professional_name VARCHAR(150),
        signature_data    TEXT,
        cedula            VARCHAR(50),
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Índices de clinic_id en tablas FK-chain ───────────────────────────
    for (const t of ['consultations','physical_exams','diagnoses','treatments',
                     'prescriptions','injectables','consent_forms',
                     'medical_history_snapshots','medical_history',
                     'consultation_history','consultation_info',
                     'inventory_batches','inventory_movements','financial_items']) {
      try {
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_${t}_clinic ON ${t}(clinic_id)`);
      } catch { /* tabla aún no tiene la columna — migrará con setup-bioskin-role.mjs */ }
    }

    // ── Backfill clinic_id en filas antiguas (guardadas antes de que se agregara) ─
    // Usa neondb_owner (BYPASSRLS) para actualizar filas con clinic_id IS NULL.
    const TENANT_CHILD_TABLES = [
      'physical_exams', 'diagnoses', 'treatments', 'prescriptions',
      'injectables', 'consultation_history', 'consultation_info', 'medical_history',
    ];
    for (const t of TENANT_CHILD_TABLES) {
      try {
        await pool.query(`
          UPDATE ${t} child
          SET    clinic_id = cr.clinic_id
          FROM   clinical_records cr
          WHERE  child.record_id = cr.id
            AND  child.clinic_id IS NULL
            AND  cr.clinic_id IS NOT NULL
        `);
      } catch { /* tabla sin record_id o sin clinic_id — omitir silenciosamente */ }
    }
    // consent_forms tiene patient_id también; mejor unir por record_id
    try {
      await pool.query(`
        UPDATE consent_forms cf
        SET    clinic_id = cr.clinic_id
        FROM   clinical_records cr
        WHERE  cf.record_id = cr.id
          AND  cf.clinic_id IS NULL
          AND  cr.clinic_id IS NOT NULL
      `);
    } catch { /* omitir */ }

    console.log('✅ Base de datos de Fichas Clínicas inicializada correctamente');
  } catch (error) {
    console.error('❌ Error inicializando Fichas Clínicas DB:', error);
    throw error;
  }
}
