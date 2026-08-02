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

    // ── Inventario (tablas de stock, lotes y movimientos) ─────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id                   SERIAL PRIMARY KEY,
        clinic_id            INTEGER,
        sku                  VARCHAR(50),
        name                 VARCHAR(200) NOT NULL,
        brand                VARCHAR(120),
        description          TEXT,
        category             VARCHAR(100),
        group_name           VARCHAR(100),
        unit_of_measure      VARCHAR(20),
        min_stock_level      NUMERIC(12,2) DEFAULT 0,
        requires_cold_chain  BOOLEAN DEFAULT false,
        sanitary_registration VARCHAR(100),
        cost_price           NUMERIC(12,2),
        sale_price           NUMERIC(12,2),
        preferred_display_unit VARCHAR(20) DEFAULT 'absolute',
        created_at           TIMESTAMP DEFAULT NOW(),
        updated_at           TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_batches (
        id               SERIAL PRIMARY KEY,
        item_id          INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
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
        id             SERIAL PRIMARY KEY,
        date           DATE NOT NULL DEFAULT CURRENT_DATE,
        invoice_number VARCHAR(100),
        entity         VARCHAR(255),
        description    TEXT,
        type           VARCHAR(20) NOT NULL DEFAULT 'ingreso',
        subtotal       NUMERIC(12,2) DEFAULT 0,
        tax            NUMERIC(12,2) DEFAULT 0,
        total          NUMERIC(12,2) DEFAULT 0,
        registered_by  VARCHAR(100),
        status         VARCHAR(20) DEFAULT 'confirmed',
        created_at     TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Items de factura (desglose de líneas) ─────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_items (
        id          SERIAL PRIMARY KEY,
        record_id   INTEGER NOT NULL,
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

    // consent_templates (plantillas globales) + asignación por clínica
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinic_consent_templates (
        clinic_id   INTEGER NOT NULL,
        template_id INTEGER NOT NULL REFERENCES consent_templates(id) ON DELETE CASCADE,
        PRIMARY KEY (clinic_id, template_id)
      )
    `);

    // ── Overrides de módulo por usuario (finanzas_visible, etc.) ─────────────
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
        clinic_user_id    INTEGER,
        user_display_name VARCHAR(255),
        action_type       VARCHAR(30) NOT NULL,
        module            VARCHAR(50) NOT NULL,
        summary           TEXT,
        field_changes     JSONB,
        created_at        TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_patient ON patient_audit_log(patient_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON patient_audit_log(created_at DESC)`);

    // ── Asignaciones de pacientes entre usuarios (traslado/copia) ─────────
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_patient_assignments_user ON patient_assignments(clinic_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_patient_assignments_patient ON patient_assignments(patient_id)`);

    // ── Grupos de compartición de inventario/finanzas ─────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sharing_groups (
        id          SERIAL PRIMARY KEY,
        clinic_id   INTEGER NOT NULL,
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sharing_member_user ON sharing_group_members(clinic_user_id)`);

    // ── Catálogo global de inyectables (seeds gestionados por master admin) ─
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

    // ── Consultas (hub de sesión por expediente) ─────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultations (
        id                  SERIAL PRIMARY KEY,
        record_id           INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        reason              TEXT,
        current_illness     TEXT,
        enable_injectables  BOOLEAN DEFAULT FALSE,
        enable_consents     BOOLEAN DEFAULT FALSE,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_consultations_record ON consultations(record_id)`);

    // ── Snapshots de antecedentes (historial de versiones) ───────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS medical_history_snapshots (
        id            SERIAL PRIMARY KEY,
        record_id     INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
        snapshot_data JSONB NOT NULL,
        changed_by    VARCHAR(100),
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_history_snapshots_record ON medical_history_snapshots(record_id)`);

    // ── Firmas profesionales (nombre, cédula, imagen de firma) ───────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS professional_signatures (
        id             SERIAL PRIMARY KEY,
        professional_name VARCHAR(150) NOT NULL UNIQUE,
        cedula         VARCHAR(50),
        signature_data TEXT,
        created_at     TIMESTAMP DEFAULT NOW(),
        updated_at     TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Migraciones incrementales: consultation_id en tablas dependientes ─
    const consultationMigrations = [
      'ALTER TABLE physical_exams  ADD COLUMN IF NOT EXISTS consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL',
      'ALTER TABLE diagnoses        ADD COLUMN IF NOT EXISTS consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL',
      'ALTER TABLE treatments       ADD COLUMN IF NOT EXISTS consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL',
      'ALTER TABLE prescriptions    ADD COLUMN IF NOT EXISTS consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL',
      'ALTER TABLE injectables      ADD COLUMN IF NOT EXISTS consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL',
      'ALTER TABLE consent_forms    ADD COLUMN IF NOT EXISTS consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL',
      'ALTER TABLE injectables      ADD COLUMN IF NOT EXISTS relleno_subtype VARCHAR(30)',
      // Migrar consultation_history → consultations (idempotente via NOT EXISTS)
      `INSERT INTO consultations (record_id, reason, current_illness, created_at, updated_at)
       SELECT h.record_id, h.reason, h.current_illness, h.created_at, h.created_at
       FROM consultation_history h
       WHERE NOT EXISTS (
         SELECT 1 FROM consultations c WHERE c.record_id = h.record_id AND c.created_at = h.created_at
       )`,
      'CREATE INDEX IF NOT EXISTS idx_physical_exams_consultation ON physical_exams(consultation_id)',
      'CREATE INDEX IF NOT EXISTS idx_diagnoses_consultation ON diagnoses(consultation_id)',
      'CREATE INDEX IF NOT EXISTS idx_treatments_consultation ON treatments(consultation_id)',
      'CREATE INDEX IF NOT EXISTS idx_prescriptions_consultation ON prescriptions(consultation_id)',
      'CREATE INDEX IF NOT EXISTS idx_injectables_consultation ON injectables(consultation_id)',
      'CREATE INDEX IF NOT EXISTS idx_consent_forms_consultation ON consent_forms(consultation_id)',
    ];
    for (const sql of consultationMigrations) {
      try { await pool.query(sql); } catch { /* ya existe */ }
    }

    console.log('✅ Base de datos de Fichas Clínicas inicializada correctamente');
  } catch (error) {
    console.error('❌ Error inicializando Fichas Clínicas DB:', error);
    throw error;
  }
}
