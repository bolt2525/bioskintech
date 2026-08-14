/**
 * @file api/admin-auth.js
 * @description API de autenticación y autorización multi-tenant para BIOSKIN Admin.
 *
 * Arquitectura de roles:
 *   master_admin  → clinic_id = NULL, acceso a todo
 *   clinic_admin  → acceso completo a su clínica
 *   clinic_user   → acceso limitado por access_scope ('own')
 *
 * Seguridad:
 *   - Hash: PBKDF2+salt (100k iter, sha512) vía Node crypto nativo — sin deps extra
 *   - Rate limit: 5 intentos fallidos → bloqueo 15 min
 *   - Tokens: 32 bytes random hex, expiran en 24h
 *   - Init schema protegido por x-setup-secret header
 *
 * ponytail: PBKDF2+salt → upgrade a Argon2 si compliance crece.
 */

import { sql } from '@vercel/postgres';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

// ─────────────────────────────────────────────────────────────────────────────
// Configuración de seguridad
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 horas
const LOCK_ATTEMPTS     = 5;                    // intentos antes de bloquear
const LOCK_MS           = 15 * 60 * 1000;       // 15 minutos de bloqueo

// Lista de features reconocidas — debe coincidir con src/constants/features.ts
const ALL_FEATURES = [
  'calendar', 'block_schedule', 'appointment',
  'clinical_records', 'finance', 'inventory', 'clinical_3d',
  'system_status', 'backup', 'ai_consultation', 'skin_explorer',
];

// Planes de suscripción predefinidos (precio en centavos USD)
const SUBSCRIPTION_PLANS = {
  plan_lanzamiento: {
    name: 'Plan Lanzamiento BioskinTech',
    features: ['calendar','block_schedule','appointment','clinical_records','finance','inventory','clinical_3d','system_status','backup'],
    access_scope: 'all',
    amount_cents: 26450,       // $264.50/año
    description: 'Plan especial de lanzamiento con módulos principales',
  },
  plan_completo: {
    name: 'Plan Completo',
    features: ALL_FEATURES,
    access_scope: 'all',
    amount_cents: 9900,        // $99.00/mes
    description: 'Todos los módulos, pacientes ilimitados, IA incluida',
  },
  plan_clinica: {
    name: 'Plan Clínica',
    features: ['calendar', 'block_schedule', 'appointment', 'clinical_records', 'finance', 'inventory'],
    access_scope: 'all',
    amount_cents: 6900,        // $69.00/mes
    description: 'Módulos principales, todos los pacientes de la clínica',
  },
  plan_personal: {
    name: 'Plan Personal',
    features: ['clinical_records', 'appointment'],
    access_scope: 'own',
    amount_cents: 2900,        // $29.00/mes
    description: 'Solo tus propios pacientes y citas',
  },
  plan_trial: {
    name: 'Plan Trial 30 días',
    features: ALL_FEATURES,
    access_scope: 'all',
    amount_cents: 0,           // gratis
    description: 'Acceso completo por 30 días',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Auto-migración ligera — columnas nuevas que pueden no existir en instancias viejas
// ─────────────────────────────────────────────────────────────────────────────

// ponytail: flag de módulo — serverless instances are short-lived, safe to skip on subsequent requests
let _newColumnsMigrated = false;
async function ensureNewColumns() {
  if (_newColumnsMigrated) return;
  // Each ALTER is independent so one failure cannot skip the remaining migrations
  const migrations = [
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS finance_scope VARCHAR(20) DEFAULT 'all'",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS inventory_scope VARCHAR(20) DEFAULT 'all'",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS cedula_profesional VARCHAR(50)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS matricula_senescyt VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS especialidad VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS gentilicio VARCHAR(50)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS profession VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
    "ALTER TABLE invite_links ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20) DEFAULT 'own'",
    "ALTER TABLE invite_links ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE",
  ];
  for (const stmt of migrations) {
    try { await sql.query(stmt); } catch { /* column already exists — safe to ignore */ }
  }
  _newColumnsMigrated = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de criptografía
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera un hash PBKDF2 de la contraseña.
 * Si no se proporciona salt, genera uno nuevo (para creación de usuarios).
 */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(password, s, 100_000, 64, 'sha512').toString('hex');
  return { hash: h, salt: s };
}

/**
 * Verifica una contraseña contra su hash almacenado.
 * Soporta migración desde el algoritmo SHA-256 legado (sin salt).
 * Usa timingSafeEqual en ambos paths para prevenir timing attacks.
 */
function verifyPassword(password, storedHash, salt, algo) {
  try {
    const computed = algo === 'sha256'
      ? crypto.createHash('sha256').update(password).digest('hex')
      : hashPassword(password, salt).hash;
    // timingSafeEqual requiere buffers de igual longitud; el catch captura hashes corruptos
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

/** Genera un token de sesión de 32 bytes aleatorios */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Inicialización del esquema multi-tenant
// ─────────────────────────────────────────────────────────────────────────────

/** Crea todas las tablas necesarias (idempotente — safe to re-run) */
export async function initMultiTenantSchema() {
  // Tabla de clínicas (tenants) — PK UUID
  await sql`
    CREATE TABLE IF NOT EXISTS clinics (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       VARCHAR(255) NOT NULL,
      slug       VARCHAR(100) UNIQUE NOT NULL,
      email      VARCHAR(255),
      phone      VARCHAR(50),
      address    TEXT,
      is_active  BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Migraciones idempotentes en clinics
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP`;
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS subscription_days INTEGER NOT NULL DEFAULT 365`;

  // Usuarios por clínica (clinic_id = NULL → master_admin)
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_users (
      id              SERIAL PRIMARY KEY,
      clinic_id       UUID REFERENCES clinics(id) ON DELETE CASCADE,
      username        VARCHAR(100) UNIQUE NOT NULL,
      password_hash   VARCHAR(255) NOT NULL,
      salt            VARCHAR(64),
      hash_algo       VARCHAR(20) DEFAULT 'pbkdf2',
      full_name       VARCHAR(255),
      email           VARCHAR(255),
      role            VARCHAR(30) NOT NULL DEFAULT 'clinic_user',
      access_scope    VARCHAR(20) DEFAULT 'own',
      failed_attempts INTEGER DEFAULT 0,
      locked_until    TIMESTAMP,
      is_active       BOOLEAN DEFAULT true,
      last_login      TIMESTAMP,
      created_at      TIMESTAMP DEFAULT NOW()
    )
  `;

  // Sesiones activas
  await sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id             SERIAL PRIMARY KEY,
      session_token  VARCHAR(255) UNIQUE NOT NULL,
      username       VARCHAR(100) NOT NULL,
      created_at     TIMESTAMP DEFAULT NOW(),
      expires_at     TIMESTAMP NOT NULL,
      ip_address     VARCHAR(100),
      user_agent     TEXT,
      is_active      BOOLEAN DEFAULT true,
      clinic_user_id INTEGER,
      role           VARCHAR(30),
      clinic_id      UUID,
      access_scope   VARCHAR(20)
    )
  `;

  // Features habilitadas por clínica
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_features (
      clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      feature   VARCHAR(50) NOT NULL,
      enabled   BOOLEAN DEFAULT true,
      PRIMARY KEY (clinic_id, feature)
    )
  `;

  // Tokens OAuth de Google por clínica (Calendar + Gmail)
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_oauth_tokens (
      id            SERIAL PRIMARY KEY,
      clinic_id     UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE UNIQUE,
      access_token  TEXT,
      refresh_token TEXT NOT NULL,
      token_expiry  TIMESTAMP,
      email         VARCHAR(255),
      connected_at  TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `;

  // Configuración personalizable por clínica (JSONB para evitar migraciones futuras)
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_settings (
      clinic_id  UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
      general    JSONB NOT NULL DEFAULT '{}',
      treatments JSONB NOT NULL DEFAULT '[]',
      email      JSONB NOT NULL DEFAULT '{}',
      agenda     JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Plantillas globales de consentimiento (gestionadas por master_admin)
  await sql`
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
  `;

  // Asignación de plantillas por clínica
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_consent_templates (
      clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      template_id INTEGER NOT NULL REFERENCES consent_templates(id) ON DELETE CASCADE,
      PRIMARY KEY (clinic_id, template_id)
    )
  `;

  // Overrides de módulos por usuario (complementa los permisos de clínica)
  // Si no existe override, el usuario hereda los features de la clínica.
  await sql`
    CREATE TABLE IF NOT EXISTS user_module_overrides (
      clinic_user_id INTEGER NOT NULL REFERENCES clinic_users(id) ON DELETE CASCADE,
      feature        VARCHAR(50) NOT NULL,
      enabled        BOOLEAN DEFAULT false,
      PRIMARY KEY (clinic_user_id, feature)
    )
  `;

  // Códigos únicos de registro (generados por master_admin)
  await sql`
    CREATE TABLE IF NOT EXISTS registration_codes (
      id           SERIAL PRIMARY KEY,
      code         VARCHAR(32) UNIQUE NOT NULL,
      plan_name    VARCHAR(100) NOT NULL DEFAULT 'Plan Completo',
      features     JSONB DEFAULT '[]',
      access_scope VARCHAR(20) DEFAULT 'all',
      max_patients INTEGER DEFAULT -1,
      is_active    BOOLEAN DEFAULT TRUE,
      used_by      INTEGER REFERENCES clinic_users(id),
      used_at      TIMESTAMP,
      expires_at   TIMESTAMP,
      note         TEXT,
      created_by   INTEGER REFERENCES clinic_users(id),
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `;

  // Suscripciones PayPhone (pagos de registro)
  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                      SERIAL PRIMARY KEY,
      clinic_id               UUID REFERENCES clinics(id),
      plan_name               VARCHAR(100),
      amount_cents            INTEGER NOT NULL DEFAULT 0,
      currency                VARCHAR(10) DEFAULT 'USD',
      status                  VARCHAR(30) DEFAULT 'pending',
      payphone_transaction_id VARCHAR(100),
      payphone_client_id      VARCHAR(100),
      payphone_response       JSONB,
      registration_code_id    INTEGER REFERENCES registration_codes(id),
      created_at              TIMESTAMP DEFAULT NOW(),
      paid_at                 TIMESTAMP,
      expires_at              TIMESTAMP
    )
  `;

  // Links de invitación para agregar usuarios a clínicas existentes
  await sql`
    CREATE TABLE IF NOT EXISTS invite_links (
      id          SERIAL PRIMARY KEY,
      token       VARCHAR(64) UNIQUE NOT NULL,
      clinic_id   UUID REFERENCES clinics(id) ON DELETE CASCADE,
      role        VARCHAR(30) DEFAULT 'clinic_user',
      email       VARCHAR(255),
      features    JSONB DEFAULT '[]',
      is_used     BOOLEAN DEFAULT FALSE,
      used_by     INTEGER REFERENCES clinic_users(id),
      created_by  INTEGER REFERENCES clinic_users(id),
      expires_at  TIMESTAMP NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `;

  // Estados OAuth transitorios (prevención CSRF en Google OAuth)
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_states (
      id         SERIAL PRIMARY KEY,
      state      VARCHAR(64) UNIQUE NOT NULL,
      purpose    VARCHAR(20) DEFAULT 'login',
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // OTP de verificación en dos pasos (2FA por email)
  await sql`
    CREATE TABLE IF NOT EXISTS login_otp (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES clinic_users(id) ON DELETE CASCADE,
      email      VARCHAR(255) NOT NULL,
      otp_token  VARCHAR(64) UNIQUE NOT NULL,
      code       VARCHAR(6) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES clinic_users(id) ON DELETE CASCADE,
      device_token VARCHAR(64) UNIQUE NOT NULL,
      user_agent   TEXT,
      ip_address   VARCHAR(100),
      expires_at   TIMESTAMP NOT NULL,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS password_setup_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES clinic_users(id) ON DELETE CASCADE,
      token      VARCHAR(64) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS clinic_notifications (
      id         SERIAL PRIMARY KEY,
      clinic_id  UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      type       VARCHAR(30) DEFAULT 'info',
      message    TEXT NOT NULL,
      is_read    BOOLEAN DEFAULT FALSE,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Columnas extras en caso de migración de tabla preexistente
  for (const col of [
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS clinic_user_id INTEGER",
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS role VARCHAR(30)",
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS clinic_id INTEGER",
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20)",
    "ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS finanzas JSONB NOT NULL DEFAULT '{}'",
    "ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS inventario JSONB NOT NULL DEFAULT '{}'",
    "ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS notificaciones JSONB NOT NULL DEFAULT '{}'",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS cedula_profesional VARCHAR(50)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS matricula_senescyt VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS especialidad VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS gentilicio VARCHAR(50)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS profession VARCHAR(100)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS avatar_url TEXT",
    "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS logo_url TEXT",
    "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS ruc VARCHAR(20)",
    "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
    "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT 'Ecuador'",
    "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS website VARCHAR(255)",
    "ALTER TABLE clinics ADD COLUMN IF NOT EXISTS description TEXT",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT FALSE",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMP",
    "ALTER TABLE login_otp ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0",
    "ALTER TABLE invite_links ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20) DEFAULT 'own'",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS finance_scope VARCHAR(20) DEFAULT 'all'",
    "ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS inventory_scope VARCHAR(20) DEFAULT 'all'",
  ]) {
    try { await sql.query(col); } catch { /* ya existe */ }
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS clinics_email_lower_unique
    ON clinics (LOWER(email))
    WHERE email IS NOT NULL
  `;

  await sql`
    UPDATE clinic_settings cs
    SET general = cs.general || jsonb_strip_nulls(jsonb_build_object(
          'name',    CASE WHEN COALESCE(cs.general->>'name', '') = '' THEN c.name END,
          'city',    CASE WHEN COALESCE(cs.general->>'city', '') = '' THEN c.city END,
          'phone',   CASE WHEN COALESCE(cs.general->>'phone', '') = '' THEN c.phone END,
          'address', CASE WHEN COALESCE(cs.general->>'address', '') = '' THEN c.address END,
          'tax_id',  CASE WHEN COALESCE(cs.general->>'tax_id', '') = '' THEN c.ruc END
        )),
        email = cs.email || jsonb_strip_nulls(jsonb_build_object(
          'staff_email', CASE WHEN COALESCE(cs.email->>'staff_email', '') = '' THEN c.email END,
          'from_name',   CASE WHEN COALESCE(cs.email->>'from_name', '') = '' THEN c.name END,
          'signature',   CASE WHEN COALESCE(cs.email->>'signature', '') = '' THEN 'El equipo de ' || c.name END
        )),
        updated_at = NOW()
    FROM clinics c
    WHERE cs.clinic_id = c.id
      AND (
        COALESCE(cs.general->>'name', '') = '' OR COALESCE(cs.general->>'city', '') = '' OR
        COALESCE(cs.general->>'phone', '') = '' OR COALESCE(cs.general->>'address', '') = '' OR
        COALESCE(cs.general->>'tax_id', '') = '' OR COALESCE(cs.email->>'staff_email', '') = '' OR
        COALESCE(cs.email->>'from_name', '') = '' OR COALESCE(cs.email->>'signature', '') = ''
      )
  `;

  // Índices de rendimiento
  await sql`CREATE INDEX IF NOT EXISTS idx_clinic_users_username ON clinic_users(username) WHERE is_active = true`;
  try { await sql`CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id)`; } catch { /* patients aún no existe */ }
  await sql`CREATE INDEX IF NOT EXISTS idx_session_token ON admin_sessions(session_token) WHERE is_active = true`;
}

/**
 * Crea datos iniciales:
 *  - Clínica BIOSKIN (slug 'bioskin')
 *  - master_admin desde env MASTER_ADMIN_USERNAME / MASTER_ADMIN_PASSWORD
 *  - clinic_admin desde env ADMIN_USERNAME / ADMIN_PASSWORD
 *  - Features habilitadas para clínica bioskin
 */
export async function seedData() {
  // Clínica bioskin
  const existing = await sql`SELECT id FROM clinics WHERE slug = 'bioskin'`;
  let bioskinId;
  if (existing.rows.length === 0) {
    const r = await sql`
      INSERT INTO clinics (name, slug, email, phone, address)
      VALUES ('BIOSKIN', 'bioskin', 'info@bioskin.com', '', '')
      RETURNING id
    `;
    bioskinId = r.rows[0].id;
  } else {
    bioskinId = existing.rows[0].id;
  }

  // master_admin — credenciales SIEMPRE desde env vars, nunca en código
  const mu = (process.env.MASTER_ADMIN_USERNAME || '').trim();
  const mp = (process.env.MASTER_ADMIN_PASSWORD || '').trim();
  if (mu && mp) {
    const exM = await sql`SELECT id FROM clinic_users WHERE username = ${mu}`;
    if (exM.rows.length === 0) {
      const { hash, salt } = hashPassword(mp);
      await sql`
        INSERT INTO clinic_users
          (clinic_id, username, password_hash, salt, hash_algo, full_name, role, access_scope)
        VALUES
          (NULL, ${mu}, ${hash}, ${salt}, 'pbkdf2', 'Master Admin', 'master_admin', 'all')
      `;
      console.log(`✅ master_admin creado: ${mu}`);
    }
  }

  // clinic_admin de bioskin
  const au = (process.env.ADMIN_USERNAME || 'admin').trim();
  const ap = (process.env.ADMIN_PASSWORD || '').trim();
  if (ap) {
    const exA = await sql`SELECT id FROM clinic_users WHERE username = ${au}`;
    if (exA.rows.length === 0) {
      const { hash, salt } = hashPassword(ap);
      await sql`
        INSERT INTO clinic_users
          (clinic_id, username, password_hash, salt, hash_algo, full_name, role, access_scope)
        VALUES
          (${bioskinId}, ${au}, ${hash}, ${salt}, 'pbkdf2', 'BIOSKIN Admin', 'clinic_admin', 'all')
      `;
      console.log(`✅ clinic_admin creado: ${au}`);
    }
  }

  // Migrar pacientes sin clínica → bioskin (tabla puede no existir en install fresco)
  try { await sql`UPDATE patients SET clinic_id = ${bioskinId} WHERE clinic_id IS NULL`; } catch { /* patients aún no existe */ }

  await seedFeatures(bioskinId);

  // Rotar contraseña de master_admin si hay nueva en env var
  const newMasterPwd = (process.env.MASTER_ADMIN_NEW_PASSWORD || '').trim();
  if (newMasterPwd && mu) {
    const { hash, salt } = hashPassword(newMasterPwd);
    const rotated = await sql`
      UPDATE clinic_users SET password_hash=${hash}, salt=${salt}, hash_algo='pbkdf2',
        failed_attempts=0, locked_until=NULL
      WHERE username=${mu} AND role='master_admin' RETURNING id
    `;
    if (rotated.rows.length) {
      await sql`UPDATE admin_sessions SET is_active=false WHERE username=${mu}`;
      console.log('✅ Master admin password rotated via MASTER_ADMIN_NEW_PASSWORD — remove env var after login');
    }
  }

  return { bioskinId };
}

/** Habilita todas las features para una clínica (idempotente) */
async function seedFeatures(clinicId) {
  for (const f of ALL_FEATURES) {
    await sql`
      INSERT INTO clinic_features (clinic_id, feature, enabled)
      VALUES (${clinicId}, ${f}, true)
      ON CONFLICT (clinic_id, feature) DO NOTHING
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature queries
// ─────────────────────────────────────────────────────────────────────────────

/** Devuelve las features habilitadas para una clínica (master_admin → todas) */
async function getFeatures(clinicId) {
  if (!clinicId) return ALL_FEATURES;
  try {
    // ponytail: tomar TODAS las rows y filtrar deshabilitadas → soporta clínicas con registros parciales
    const r = await sql`SELECT feature, enabled FROM clinic_features WHERE clinic_id = ${clinicId}`;
    if (!r.rows.length) return ALL_FEATURES; // nunca configurado → todo habilitado
    const disabled = new Set(r.rows.filter(x => !x.enabled).map(x => x.feature));
    return ALL_FEATURES.filter(f => !disabled.has(f));
  } catch {
    return ALL_FEATURES; // fallback si la tabla no existe aún
  }
}

/** Activa o desactiva una feature para una clínica */
async function setFeature(clinicId, feature, enabled) {
  if (!clinicId || !feature) return { error: 'clinicId y feature son requeridos' };
  if (!ALL_FEATURES.includes(feature)) return { error: `Feature desconocida: ${feature}` };
  await sql`
    INSERT INTO clinic_features (clinic_id, feature, enabled)
    VALUES (${clinicId}, ${feature}, ${!!enabled})
    ON CONFLICT (clinic_id, feature) DO UPDATE SET enabled = ${!!enabled}
  `;
  return { success: true };
}

/** Lista todas las features de todas las clínicas (para el Master Admin dashboard) */
async function getAllClinicFeatures() {
  const r = await sql`
    SELECT cf.clinic_id, cf.feature, cf.enabled, c.name as clinic_name
    FROM clinic_features cf
    JOIN clinics c ON c.id = cf.clinic_id
    ORDER BY c.name, cf.feature
  `;
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Autentica un usuario y crea una sesión en base de datos.
 * Implementa rate-limiting (5 intentos → bloqueo 15 min).
 */
async function loginUser(username, password, ip, ua, req) {
  cleanupExpiredDemos().catch(() => {});
  // ensureNewColumns already called at handler start — no need to repeat here
  // Verificar si multi-tenant está inicializado
  let count = 0;
  try {
    const r = await sql`SELECT COUNT(*) as cnt FROM clinic_users`;
    count = parseInt(r.rows[0].cnt);
  } catch { /* tabla no existe aún */ }

  // Fallback pre-migración (solo variables de entorno)
  if (count === 0) {
    const validU = (process.env.ADMIN_USERNAME || process.env.MASTER_ADMIN_USERNAME || 'admin').trim();
    const validP = (process.env.ADMIN_PASSWORD || process.env.MASTER_ADMIN_PASSWORD || '').trim();
    if (!validP || username.trim() !== validU || password.trim() !== validP) {
      return { success: false, error: 'Credenciales inválidas' };
    }
    await ensureSessionsTable();
    const token = generateToken();
    const exp   = new Date(Date.now() + SESSION_EXPIRY_MS);
    await sql`
      INSERT INTO admin_sessions
        (session_token, username, expires_at, ip_address, user_agent, role, access_scope)
      VALUES
        (${token}, ${username}, ${exp}, ${ip}, ${ua}, 'clinic_admin', 'all')
    `;
    return {
      success: true, sessionToken: token, expiresAt: exp,
      user: { username, role: 'clinic_admin', clinic_id: null, access_scope: 'all', full_name: 'Administrador' },
    };
  }

  // Login contra DB — join con clinics para obtener slug y name
  // SECURITY: antes de verificar password, validar master_key si el usuario es master_admin
  const r = await sql`
    SELECT cu.id, cu.username, cu.password_hash, cu.salt, cu.hash_algo, cu.role, cu.clinic_id, cu.access_scope,
           cu.finance_scope, cu.inventory_scope,
           cu.failed_attempts, cu.locked_until, cu.is_active, cu.full_name, cu.email,
           cu.cedula_profesional, cu.matricula_senescyt, cu.especialidad, cu.gentilicio, cu.profession, cu.first_name, cu.last_name,
           cu.is_demo, cu.demo_expires_at, c.slug AS clinic_slug, c.name AS clinic_name
    FROM clinic_users cu
    LEFT JOIN clinics c ON c.id = cu.clinic_id
    WHERE (cu.username = ${username} OR cu.email = ${username})
  `;
  if (!r.rows.length) return { success: false, error: 'Credenciales inválidas' };

  const u = r.rows[0];
  if (!u.is_active) return { success: false, error: 'Cuenta desactivada. Contacta al administrador.' };

  // SECURITY: master_admin requiere MASTER_LOGIN_KEY adicional para autenticarse.
  // Si la variable no está configurada, el login master queda bloqueado en producción.
  if (u.role === 'master_admin') {
    const masterKey = (process.env.MASTER_LOGIN_KEY || '').trim();
    const providedKey = (req?.body?.master_key || '').trim();
    if (!masterKey) {
      console.error('[SECURITY] MASTER_LOGIN_KEY no configurado — login master bloqueado');
      return { success: false, error: 'Credenciales inválidas' }; // no revelar razón
    }
    // Comparación de tiempo constante — evitar timing attacks aunque las longitudes difieran
    const keyA = Buffer.from(crypto.createHash('sha256').update(providedKey).digest('hex'), 'hex');
    const keyB = Buffer.from(crypto.createHash('sha256').update(masterKey).digest('hex'), 'hex');
    if (!crypto.timingSafeEqual(keyA, keyB)) {
      return { success: false, error: 'Credenciales inválidas' };
    }
  }

  // Block demo users whose time has expired
  if (u.is_demo && u.demo_expires_at && new Date(u.demo_expires_at) < new Date()) {
    return { success: false, error: 'La cuenta demo ha expirado.' };
  }

  // Verificar bloqueo por intentos
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    const min = Math.ceil((new Date(u.locked_until) - Date.now()) / 60000);
    return { success: false, error: `Cuenta bloqueada. Intenta en ${min} minuto(s).` };
  }

  // Verificar contraseña
  if (!verifyPassword(password, u.password_hash, u.salt, u.hash_algo)) {
    const attempts = (u.failed_attempts || 0) + 1;
    if (attempts >= LOCK_ATTEMPTS) {
      const lockUntil = new Date(Date.now() + LOCK_MS);
      await sql`UPDATE clinic_users SET failed_attempts = ${attempts}, locked_until = ${lockUntil} WHERE id = ${u.id}`;
      return { success: false, error: 'Demasiados intentos. Cuenta bloqueada 15 minutos.' };
    }
    await sql`UPDATE clinic_users SET failed_attempts = ${attempts} WHERE id = ${u.id}`;
    return { success: false, error: `Credenciales inválidas. Intentos restantes: ${LOCK_ATTEMPTS - attempts}` };
  }

  // Migrar hash SHA-256 legacy → PBKDF2 en el primer login exitoso
  if (u.hash_algo === 'sha256') {
    try {
      const { hash: newHash, salt: newSalt } = hashPassword(password);
      await sql`UPDATE clinic_users SET password_hash = ${newHash}, salt = ${newSalt}, hash_algo = 'pbkdf2' WHERE id = ${u.id}`;
    } catch { /* non-fatal: se reintentará en el siguiente login */ }
  }

  // Éxito: resetear intentos y registrar sesión provisional
  await sql`UPDATE clinic_users SET failed_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = ${u.id}`;

  const token = generateToken();
  const exp   = new Date(Date.now() + SESSION_EXPIRY_MS);
  await sql`
    INSERT INTO admin_sessions
      (session_token, username, expires_at, ip_address, user_agent, clinic_user_id, role, clinic_id, access_scope)
    VALUES
      (${token}, ${username}, ${exp}, ${ip}, ${ua}, ${u.id}, ${u.role}, ${u.clinic_id}, ${u.access_scope})
  `;

  // Check if device is already trusted → skip OTP entirely
  if (u.email) {
    const deviceToken = req?.body?.device_token || '';
    const trusted = deviceToken ? await checkTrustedDevice(u.id, deviceToken) : false;
    if (trusted) {
      await sql`UPDATE admin_sessions SET is_active=true WHERE session_token=${token}`;
      return {
        success: true, sessionToken: token, expiresAt: exp,
        user: { id: u.id, username: u.username, full_name: u.full_name,
          email: u.email, role: u.role, clinic_id: u.clinic_id, access_scope: u.access_scope,
          finance_scope: u.finance_scope || 'all', inventory_scope: u.inventory_scope || 'all',
          clinic_slug: u.clinic_slug || null, clinic_name: u.clinic_name || null,
          cedula_profesional: u.cedula_profesional || null, matricula_senescyt: u.matricula_senescyt || null, especialidad: u.especialidad || null,
          gentilicio: u.gentilicio || null, profession: u.profession || null,
          first_name: u.first_name || null, last_name: u.last_name || null,
          is_demo: u.is_demo || false, demo_expires_at: u.demo_expires_at || null },
        features: await getFeatures(u.clinic_id),
        user_module_overrides: await (async () => {
          try { const o = await sql`SELECT feature, enabled FROM user_module_overrides WHERE clinic_user_id = ${u.id}`; return o.rows; }
          catch { return []; }
        })(),
        deviceTrusted: true,
      };
    }
  }

  // 2FA: enviar OTP por email si el usuario tiene email configurado
  if (u.email) {
    const otpCode  = String(Math.floor(100000 + Math.random() * 900000));
    const otpToken = generateToken();
    const otpExp   = new Date(Date.now() + 10 * 60 * 1000);
    try {
      await sql`
        INSERT INTO login_otp (user_id, email, otp_token, code, expires_at)
        VALUES (${u.id}, ${u.email}, ${otpToken}, ${otpCode}, ${otpExp})
      `;
      // Sesión provisional inactivada hasta que se verifique el OTP
      await sql`UPDATE admin_sessions SET is_active=false WHERE session_token=${token}`;
      const maskedEmail = u.email.replace(/^(.{2}).*@(.{1}).*(\.\w+)$/, '$1***@$2***$3');
      await sendAuthEmail(u.email,
        'Tu código de verificación BioskinTech',
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#deb887;margin:0 0 8px">BioskinTech</h2>
          <p style="margin:0 0 16px">Hola <b>${u.full_name || u.username}</b>,</p>
          <p style="margin:0 0 8px">Tu código de acceso:</p>
          <div style="font-size:2.8rem;font-weight:900;letter-spacing:10px;color:#deb887;
                      text-align:center;padding:20px;background:#fdf8f0;border-radius:12px;margin:16px 0">
            ${otpCode}
          </div>
          <p style="color:#999;font-size:13px;margin:0">Expira en <b>10 minutos</b>. Si no intentaste acceder, ignora este email.</p>
        </div>`
      );
      return { success: true, requiresOTP: true, otpToken, maskedEmail };
    } catch {
      console.error('[2FA] No se pudo enviar el código de verificación');
      await Promise.allSettled([
        sql`DELETE FROM login_otp WHERE otp_token=${otpToken}`,
        sql`DELETE FROM admin_sessions WHERE session_token=${token}`,
      ]);
      return { success: false, error: 'No se pudo enviar el código de verificación. Intenta nuevamente.' };
    }
  }

  return {
    success: true,
    sessionToken: token,
    expiresAt: exp,
    user: {
      id: u.id, username: u.username, full_name: u.full_name,
      email: u.email, role: u.role, clinic_id: u.clinic_id, access_scope: u.access_scope,
      finance_scope: u.finance_scope || 'all', inventory_scope: u.inventory_scope || 'all',
      clinic_slug: u.clinic_slug || null, clinic_name: u.clinic_name || null,
      cedula_profesional: u.cedula_profesional || null, matricula_senescyt: u.matricula_senescyt || null, especialidad: u.especialidad || null,
      gentilicio: u.gentilicio || null, profession: u.profession || null,
      first_name: u.first_name || null, last_name: u.last_name || null,
      is_demo: u.is_demo || false, demo_expires_at: u.demo_expires_at || null,
    },
    features: await getFeatures(u.clinic_id),
    user_module_overrides: await (async () => {
      try { const o = await sql`SELECT feature, enabled FROM user_module_overrides WHERE clinic_user_id = ${u.id}`; return o.rows; }
      catch { return []; }
    })(),
  };
}

/** Valida un token de sesión y devuelve los datos del usuario */
async function verifySession(token) {
  if (!token) return { valid: false, error: 'Token no proporcionado' };
  try {
    const r = await sql`
      SELECT s.username, s.expires_at, s.role, s.clinic_id, s.access_scope, s.clinic_user_id,
             cu.full_name, cu.email, cu.is_demo, cu.demo_expires_at,
             cu.cedula_profesional, cu.matricula_senescyt, cu.especialidad, cu.gentilicio, cu.profession, cu.first_name, cu.last_name,
             c.name as clinic_name, c.slug as clinic_slug,
             c.subscription_expires_at
      FROM admin_sessions s
      LEFT JOIN clinic_users cu ON cu.id = s.clinic_user_id
      LEFT JOIN clinics c ON c.id = s.clinic_id
      WHERE s.session_token  = ${token}
        AND s.is_active       = true
        AND s.expires_at      > NOW()
        AND (s.clinic_user_id IS NULL OR cu.is_active = true)
    `;
    if (!r.rows.length) return { valid: false, error: 'Sesión inválida o expirada' };
    const s = r.rows[0];
    // Bloquear acceso si la suscripción de la clínica está vencida (master_admin siempre pasa)
    if (s.role !== 'master_admin' && s.clinic_id && s.subscription_expires_at) {
      if (new Date(s.subscription_expires_at) < new Date()) {
        return { valid: false, error: 'Suscripción vencida. Contacta al administrador para renovarla.', subscriptionExpired: true };
      }
    }
    // Block demo users whose account has expired
    if (s.is_demo && s.demo_expires_at && new Date(s.demo_expires_at) < new Date()) {
      return { valid: false, error: 'Cuenta demo expirada.', demoExpired: true };
    }
    return {
      valid: true,
      user: {
        id: s.clinic_user_id, username: s.username, full_name: s.full_name,
        email: s.email, role: s.role || 'clinic_admin', clinic_id: s.clinic_id,
        clinic_name: s.clinic_name, clinic_slug: s.clinic_slug, access_scope: s.access_scope || 'all',
        cedula_profesional: s.cedula_profesional || null, matricula_senescyt: s.matricula_senescyt || null, especialidad: s.especialidad || null,
        gentilicio: s.gentilicio || null, profession: s.profession || null,
        first_name: s.first_name || null, last_name: s.last_name || null,
        is_demo: s.is_demo || false,
        demo_expires_at: s.demo_expires_at || null,
      },
      expiresAt: s.expires_at,
      subscriptionWarningDays: (() => {
        if (!s.subscription_expires_at) return null;
        const days = Math.ceil((new Date(s.subscription_expires_at).getTime() - Date.now()) / 86400000);
        return days <= 21 ? days : null;
      })(),
    };
  } catch {
    // Fallback para tablas pre-migración — incluye role para no romper permisos
    try {
      const r = await sql`
        SELECT username, expires_at, role, clinic_id, access_scope FROM admin_sessions
        WHERE session_token = ${token} AND is_active = true AND expires_at > NOW()
      `;
      if (!r.rows.length) return { valid: false, error: 'Sesión inválida o expirada' };
      const s = r.rows[0];
      return {
        valid: true,
        user: { username: s.username, role: s.role || 'clinic_admin', clinic_id: s.clinic_id, access_scope: s.access_scope || 'all' },
        expiresAt: s.expires_at,
      };
    } catch {
      return { valid: false, error: 'Error al verificar sesión' };
    }
  }
}

// ─── Trusted device helpers ────────────────────────────────────────────────

async function checkTrustedDevice(userId, deviceToken) {
  if (!deviceToken) return false;
  try {
    const r = await sql`
      SELECT id FROM trusted_devices
      WHERE user_id=${userId} AND device_token=${deviceToken} AND expires_at > NOW()
    `;
    return r.rows.length > 0;
  } catch { return false; }
}

async function recordTrustedDevice(userId, deviceToken, ip, ua) {
  const exp = new Date(Date.now() + 30 * 86400000); // 30 days
  await sql`
    INSERT INTO trusted_devices (user_id, device_token, ip_address, user_agent, expires_at)
    VALUES (${userId}, ${deviceToken}, ${ip||null}, ${ua||null}, ${exp})
    ON CONFLICT (device_token) DO UPDATE SET expires_at=${exp}, ip_address=${ip||null}
  `;
}

// ─── Demo account cleanup ──────────────────────────────────────────────────

async function cleanupExpiredDemos() {
  try {
    await sql`
      DELETE FROM clinic_users
      WHERE is_demo = true AND demo_expires_at IS NOT NULL AND demo_expires_at < NOW()
    `;
  } catch { /* non-fatal */ }
}

// ─── Password setup tokens ─────────────────────────────────────────────────

async function generateSetupTokenFn(userId, email, adminUser) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp   = new Date(Date.now() + 48 * 3600000); // 48h
  await sql`
    INSERT INTO password_setup_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${exp})
    ON CONFLICT DO NOTHING
  `;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).trim();
  const setupLink = `${appUrl}/#/admin/setup-password?token=${token}`;
  await sendAuthEmail(email,
    'Configura tu contraseña — BioskinTech',
    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#deb887;margin:0 0 8px">BioskinTech</h2>
      <p style="margin:0 0 16px">Hola, tu cuenta ha sido creada en el panel BioskinTech.</p>
      <p style="margin:0 0 8px">Haz clic en el siguiente botón para configurar tu contraseña:</p>
      <div style="text-align:center;margin:20px 0">
        <a href="${setupLink}" style="background:#deb887;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
          Configurar contraseña
        </a>
      </div>
      <p style="color:#999;font-size:12px">Este enlace expira en 48 horas. Si no esperabas este correo, ignóralo.</p>
    </div>`
  );
  return { token, setupLink };
}

async function claimSetupTokenFn(token, newPassword) {
  if (!token || !newPassword) return { error: 'token y newPassword son requeridos' };
  if (newPassword.length < 8) return { error: 'La contraseña debe tener al menos 8 caracteres' };
  const r = await sql`
    SELECT t.*, cu.username, cu.email FROM password_setup_tokens t
    JOIN clinic_users cu ON cu.id = t.user_id
    WHERE t.token=${token} AND t.used=false AND t.expires_at > NOW()
  `;
  if (!r.rows.length) return { error: 'Enlace inválido o expirado' };
  const row = r.rows[0];
  const { hash, salt } = hashPassword(newPassword);
  await sql`UPDATE clinic_users SET password_hash=${hash}, salt=${salt}, hash_algo='pbkdf2' WHERE id=${row.user_id}`;
  await sql`UPDATE password_setup_tokens SET used=true WHERE id=${row.id}`;
  return { success: true, username: row.username, email: row.email };
}

/** Extrae el usuario autenticado del header Authorization */
async function getRequestUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || req.body?.sessionToken;
  if (!token) return null;
  const r = await verifySession(token);
  return r.valid ? r.user : null;
}

/** Verifica que el usuario tenga al menos uno de los roles indicados */
function requireRole(user, ...roles) {
  return user && roles.includes(user.role);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gestión de usuarios
// ─────────────────────────────────────────────────────────────────────────────

async function listUsers(requestUser, clinicIdFilter) {
  if (requestUser.role === 'master_admin') {
    if (clinicIdFilter) {
      return (await sql`
        SELECT cu.id, cu.username, cu.full_name, cu.email, cu.role, cu.access_scope,
               cu.finance_scope, cu.inventory_scope,
               cu.is_active, cu.last_login, cu.clinic_id, c.name as clinic_name, c.slug as clinic_slug,
               cu.cedula_profesional, cu.matricula_senescyt, cu.especialidad, cu.is_demo, cu.demo_expires_at,
               cu.first_name, cu.last_name, cu.gentilicio, cu.profession
        FROM clinic_users cu LEFT JOIN clinics c ON cu.clinic_id = c.id
        WHERE cu.clinic_id = ${clinicIdFilter}
        ORDER BY cu.role, cu.username
      `).rows;
    }
    return (await sql`
      SELECT cu.id, cu.username, cu.full_name, cu.email, cu.role, cu.access_scope,
             cu.finance_scope, cu.inventory_scope,
             cu.is_active, cu.last_login, cu.clinic_id, c.name as clinic_name, c.slug as clinic_slug,
             cu.cedula_profesional, cu.matricula_senescyt, cu.especialidad, cu.is_demo, cu.demo_expires_at,
             cu.first_name, cu.last_name, cu.gentilicio, cu.profession
      FROM clinic_users cu LEFT JOIN clinics c ON cu.clinic_id = c.id
      ORDER BY c.name NULLS LAST, cu.role, cu.username
    `).rows;
  }
  // clinic_admin: solo su clínica
  return (await sql`
    SELECT id, username, full_name, email, role, access_scope, finance_scope, inventory_scope,
           is_active, last_login, clinic_id,
           is_demo, demo_expires_at, first_name, last_name, gentilicio, profession,
           cedula_profesional, matricula_senescyt, especialidad
    FROM clinic_users WHERE clinic_id = ${requestUser.clinic_id}
    ORDER BY role, username
  `).rows;
}

async function createUser(requestUser, body) {
  const { username, password, full_name, first_name, last_name, gentilicio, profession,
          email, role, access_scope, finance_scope, inventory_scope,
          clinic_id, cedula_profesional, matricula_senescyt, especialidad,
          is_demo, demo_expires_at, send_setup_link } = body;
  if (!username?.trim() || !role)
    return { error: 'username y role son requeridos' };

  const isDemo = !!is_demo;
  // For demos: use provided password or generate one; caller receives temp_password in response
  const effectivePassword = isDemo ? (password?.trim() || crypto.randomBytes(10).toString('base64url')) : (password || '');
  if (!isDemo && effectivePassword.length < 8)
    return { error: 'La contraseña debe tener al menos 8 caracteres' };
  if (isDemo && effectivePassword.length < 6)
    return { error: 'La contraseña demo debe tener al menos 6 caracteres' };
  if (requestUser.role === 'clinic_admin' && !['clinic_admin', 'clinic_user'].includes(role))
    return { error: 'Solo puedes crear usuarios de tipo clinic_admin o clinic_user' };

  const targetClinicId = requestUser.role === 'master_admin'
    ? (role === 'master_admin' ? null : (clinic_id ?? null))
    : requestUser.clinic_id;

  const { hash, salt } = hashPassword(effectivePassword);
  const effectiveScope = isDemo ? 'own' : (access_scope || 'own');
  const effectiveFinanceScope   = isDemo ? 'own' : (finance_scope   || 'all');
  const effectiveInventoryScope = isDemo ? 'own' : (inventory_scope || 'all');

  try {
    const r = await sql`
      INSERT INTO clinic_users
        (clinic_id, username, password_hash, salt, hash_algo, full_name, first_name, last_name,
         gentilicio, profession, email, role, access_scope, finance_scope, inventory_scope,
         cedula_profesional, matricula_senescyt, especialidad, is_demo, demo_expires_at)
      VALUES
        (${targetClinicId}, ${username.trim()}, ${hash}, ${salt}, 'pbkdf2',
         ${full_name || null}, ${first_name || null}, ${last_name || null},
         ${gentilicio || null}, ${profession || null}, ${email || null},
         ${role}, ${effectiveScope}, ${effectiveFinanceScope}, ${effectiveInventoryScope},
         ${cedula_profesional || null}, ${matricula_senescyt || null}, ${especialidad || null},
         ${isDemo}, ${demo_expires_at || null})
      RETURNING id, username, full_name, email, role, access_scope, finance_scope, inventory_scope,
                clinic_id, is_active, is_demo, demo_expires_at
    `;
    const user = r.rows[0];
    let setupLinkSent = false;
    if (email && send_setup_link && !isDemo) {
      try { await generateSetupTokenFn(user.id, email, requestUser); setupLinkSent = true; } catch { /* non-fatal */ }
    }
    return { success: true, user, setupLinkSent, ...(isDemo ? { temp_password: effectivePassword } : {}) };
  } catch (e) {
    if (e.message?.includes('unique') || e.message?.includes('duplicate'))
      return { error: 'El nombre de usuario ya existe' };
    throw e;
  }
}

async function updateUser(requestUser, body) {
  const { id, full_name, first_name, last_name, gentilicio, profession,
          email, role, access_scope, finance_scope, inventory_scope,
          is_active, cedula_profesional, matricula_senescyt, especialidad } = body;
  if (!id) return { error: 'id requerido' };

  if (requestUser.role === 'clinic_admin') {
    const t = await sql`SELECT clinic_id, role FROM clinic_users WHERE id = ${id}`;
    if (!t.rows.length || t.rows[0].clinic_id !== requestUser.clinic_id) return { error: 'Sin permiso' };
    if (t.rows[0].role === 'master_admin') return { error: 'Sin permiso' };
  } else if (requestUser.role !== 'master_admin') {
    return { error: 'Sin permiso' };
  }

  await sql`
    UPDATE clinic_users SET
      full_name           = COALESCE(NULLIF(${full_name           ?? ''}, ''), full_name),
      first_name          = COALESCE(NULLIF(${first_name          ?? ''}, ''), first_name),
      last_name           = COALESCE(NULLIF(${last_name           ?? ''}, ''), last_name),
      gentilicio          = COALESCE(NULLIF(${gentilicio          ?? ''}, ''), gentilicio),
      profession          = COALESCE(NULLIF(${profession          ?? ''}, ''), profession),
      email               = COALESCE(NULLIF(${email               ?? ''}, ''), email),
      access_scope        = COALESCE(NULLIF(${access_scope        ?? ''}, ''), access_scope),
      finance_scope       = COALESCE(NULLIF(${finance_scope       ?? ''}, ''), finance_scope),
      inventory_scope     = COALESCE(NULLIF(${inventory_scope     ?? ''}, ''), inventory_scope),
      is_active           = COALESCE(${is_active           ?? null}, is_active),
      cedula_profesional  = COALESCE(NULLIF(${cedula_profesional  ?? ''}, ''), cedula_profesional),
      matricula_senescyt  = COALESCE(NULLIF(${matricula_senescyt  ?? ''}, ''), matricula_senescyt),
      especialidad        = COALESCE(NULLIF(${especialidad        ?? ''}, ''), especialidad)
    WHERE id = ${id}
  `;
  if (requestUser.role === 'master_admin' && role != null) {
    await sql`UPDATE clinic_users SET role = ${role} WHERE id = ${id}`;
  }

  const updated = await sql`
    SELECT id, username, full_name, first_name, last_name, gentilicio, profession,
           email, role, access_scope, finance_scope, inventory_scope,
           is_active, clinic_id, cedula_profesional, matricula_senescyt, especialidad
    FROM clinic_users WHERE id = ${id}
  `;
  return { success: true, user: updated.rows[0] };
}

async function resetPassword(requestUser, body) {
  const { id, newPassword } = body;
  if (!id || !newPassword) return { error: 'id y newPassword son requeridos' };
  if (newPassword.length < 8) return { error: 'Mínimo 8 caracteres' };

  if (requestUser.role === 'clinic_admin') {
    const t = await sql`SELECT clinic_id FROM clinic_users WHERE id = ${id}`;
    if (!t.rows.length || t.rows[0].clinic_id !== requestUser.clinic_id) return { error: 'Sin permiso' };
  } else if (requestUser.role !== 'master_admin') {
    return { error: 'Sin permiso' };
  }

  const { hash, salt } = hashPassword(newPassword);
  await sql`
    UPDATE clinic_users
    SET password_hash = ${hash}, salt = ${salt}, hash_algo = 'pbkdf2',
        failed_attempts = 0, locked_until = NULL
    WHERE id = ${id}
  `;
  // Invalidar todas las sesiones activas del usuario cuya contraseña fue reseteada
  await sql`UPDATE admin_sessions SET is_active = false WHERE clinic_user_id = ${id}`;
  return { success: true };
}

async function deleteUser(requestUser, userId) {
  if (!userId) return { error: 'id requerido' };
  if (requestUser.role === 'clinic_admin') {
    const t = await sql`SELECT clinic_id, role FROM clinic_users WHERE id = ${userId}`;
    if (!t.rows.length || t.rows[0].clinic_id !== requestUser.clinic_id) return { error: 'Sin permiso' };
    if (t.rows[0].role === 'master_admin') return { error: 'Sin permiso' };
  } else if (requestUser.role !== 'master_admin') {
    return { error: 'Sin permiso' };
  }
  // Limpiar FK sin CASCADE antes del DELETE
  await sql`UPDATE invite_links SET used_by = NULL WHERE used_by = ${userId}`;
  await sql`UPDATE invite_links SET created_by = NULL WHERE created_by = ${userId}`;
  await sql`DELETE FROM admin_sessions WHERE clinic_user_id = ${userId}`;
  await sql`DELETE FROM clinic_users WHERE id = ${userId}`;
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Email helper (invitaciones, registro, códigos)
// ─────────────────────────────────────────────────────────────────────────────

async function sendAuthEmail(to, subject, html) {
  const user = (process.env.EMAIL_USER || '').trim();
  const pass = (process.env.EMAIL_PASS || '').trim();
  if (!user || !pass) throw new Error('EMAIL_USER/EMAIL_PASS no configurados en variables de entorno');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  await transporter.sendMail({ from: `"BIOSKIN Admin" <${user}>`, to, subject, html });
}

async function sendWelcomeEmail(userEmail, firstName, username, clinicName, clinicGmail) {
  const appUrl = (process.env.APP_URL || 'https://bioskintechapp.com').replace(/\/$/, '');
  const loginUrl = `${appUrl}/gestionestetica/admin/login?redirect=system-status`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <div style="background:#deb887;padding:24px;text-align:center;border-radius:8px 8px 0 0;">
        <h1 style="color:white;margin:0;font-size:26px;font-weight:bold;">BIOSKIN</h1>
        <p style="color:rgba(255,255,255,0.9);margin:6px 0 0;font-size:13px;">Sistema de Gestión Clínica</p>
      </div>
      <div style="padding:30px;background:white;border:1px solid #eee;border-top:none;">
        <h2 style="color:#222;margin-top:0;">¡Bienvenido, ${firstName}! 🎉</h2>
        <p>Tu clínica <strong>${clinicName}</strong> ha sido registrada exitosamente en BIOSKIN.</p>

        <div style="background:#fdf8f0;border:1px solid #deb887;border-radius:8px;padding:18px;margin:20px 0;">
          <h3 style="color:#c9a876;margin-top:0;font-size:14px;">Tus datos de acceso</h3>
          <p style="margin:4px 0;font-size:14px;"><strong>URL:</strong> <a href="${appUrl}/gestionestetica/admin/login" style="color:#deb887;">${appUrl}/gestionestetica/admin/login</a></p>
          <p style="margin:4px 0;font-size:14px;"><strong>Usuario:</strong> <code style="background:#f5f5f5;padding:2px 6px;border-radius:4px;">${username}</code></p>
          <p style="margin:4px 0;font-size:14px;"><strong>Email de login:</strong> ${userEmail}</p>
          <p style="color:#e55;font-size:12px;margin-top:10px;">⚠️ Guarda estos datos. Los necesitarás para acceder a tu cuenta.</p>
        </div>

        <div style="background:#f0f7ff;border:1px solid #b3d4f5;border-radius:8px;padding:18px;margin:20px 0;">
          <h3 style="color:#1a6bb5;margin-top:0;font-size:14px;">📅 Conecta tu Gmail con Google Calendar</h3>
          <p style="font-size:14px;">Para enviar correos de agendamiento y sincronizar citas con Google Calendar, conecta tu cuenta: <strong>${clinicGmail}</strong></p>
          <a href="${loginUrl}" style="display:inline-block;background:#deb887;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;margin-top:10px;">Conectar Gmail →</a>
          <p style="color:#888;font-size:12px;margin-top:12px;">También puedes hacerlo luego desde: <b>Panel → Estado del Sistema</b></p>
        </div>

        <p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:15px;margin-top:20px;">
          Si este correo llegó a Spam, márcalo como "No es spam" para futuros mensajes.<br>
          ¿Necesitas ayuda? WhatsApp: +593 984 232 889
        </p>
      </div>
    </div>
  `;
  await sendAuthEmail(userEmail, `¡Bienvenido a BIOSKIN! Tu clínica "${clinicName}" está lista`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth — login / registro de usuarios
// ─────────────────────────────────────────────────────────────────────────────

/** Genera la URL de Google OAuth para login o registro */
async function getGoogleAuthUrl(purpose = 'login') {
  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return { error: 'Google OAuth no configurado' };

  // Estado CSRF: guardamos en DB con TTL de 10 min
  const state = crypto.randomBytes(24).toString('hex');
  const exp   = new Date(Date.now() + 10 * 60 * 1000);
  await sql`INSERT INTO oauth_states (state, purpose, expires_at) VALUES (${state}, ${purpose}, ${exp}) ON CONFLICT (state) DO NOTHING`;

  const appUrl    = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).trim();
  const redirectUri = `${appUrl}/api/admin-auth?action=googleCallback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         'openid email profile',
    access_type:   'online',
    state,
    prompt:        'select_account',
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state };
}

/** Maneja el callback de Google OAuth y crea/busca el usuario */
async function handleGoogleCallback(code, state, ip, ua) {
  if (!code || !state) return { success: false, error: 'Parámetros inválidos' };

  // Verificar estado CSRF
  const stateRow = await sql`SELECT purpose FROM oauth_states WHERE state=${state} AND expires_at > NOW()`;
  if (!stateRow.rows.length) return { success: false, error: 'Estado OAuth inválido o expirado' };
  await sql`DELETE FROM oauth_states WHERE state=${state}`;
  const purpose = stateRow.rows[0].purpose;

  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const appUrl       = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).trim();
  const redirectUri  = `${appUrl}/api/admin-auth?action=googleCallback`;

  // Intercambiar code → tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!tokenRes.ok) return { success: false, error: 'Error al intercambiar código Google' };
  const tokens = await tokenRes.json();

  // Obtener info del usuario de Google
  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) return { success: false, error: 'Error al obtener perfil de Google' };
  const gUser = await infoRes.json(); // { sub, email, name, given_name, family_name, picture }

  if (!gUser.email) return { success: false, error: 'Google no proporcionó email' };

  // Buscar usuario existente por google_id o email
  let user = (await sql`SELECT * FROM clinic_users WHERE (google_id=${gUser.sub} OR username=${gUser.email}) AND is_active=true`).rows[0];

  if (!user) {
    if (purpose === 'login') {
      return { success: false, error: 'No existe una cuenta con este correo de Google. Regístrate primero.', needsRegister: true, googleData: { email: gUser.email, name: gUser.name, given_name: gUser.given_name, family_name: gUser.family_name, picture: gUser.picture, google_id: gUser.sub } };
    }
    // purpose === 'register': devolver datos para completar registro
    return { success: false, needsClinicSetup: true, googleData: { email: gUser.email, name: gUser.name, given_name: gUser.given_name, family_name: gUser.family_name, picture: gUser.picture, google_id: gUser.sub } };
  }

  // Vincular google_id si aún no está vinculado
  if (!user.google_id) {
    await sql`UPDATE clinic_users SET google_id=${gUser.sub}, avatar_url=${gUser.picture} WHERE id=${user.id}`;
  }

  // Crear sesión
  const token = generateToken();
  const exp   = new Date(Date.now() + SESSION_EXPIRY_MS);
  await sql`
    INSERT INTO admin_sessions (session_token, username, expires_at, ip_address, user_agent, clinic_user_id, role, clinic_id, access_scope)
    VALUES (${token}, ${user.username}, ${exp}, ${ip}, ${ua}, ${user.id}, ${user.role}, ${user.clinic_id}, ${user.access_scope})
  `;
  await sql`UPDATE clinic_users SET failed_attempts=0, locked_until=NULL, last_login=NOW() WHERE id=${user.id}`;

  return {
    success: true, sessionToken: token, expiresAt: exp,
    user: { id: user.id, username: user.username, full_name: user.full_name, email: user.email, role: user.role, clinic_id: user.clinic_id, access_scope: user.access_scope, gentilicio: user.gentilicio, profession: user.profession, avatar_url: user.avatar_url || gUser.picture },
    features: await getFeatures(user.clinic_id),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registro de clínicas (flujo público con código único o pago)
// ─────────────────────────────────────────────────────────────────────────────

/** Valida un código de registro y devuelve el plan asociado */
async function validateRegistrationCode(code) {
  if (!code?.trim()) return { valid: false, error: 'Código requerido' };
  const r = await sql`
    SELECT id, plan_name, features, access_scope, max_patients, expires_at
    FROM registration_codes
    WHERE code=${code.trim().toUpperCase()} AND is_active=true AND used_by IS NULL
  `;
  if (!r.rows.length) return { valid: false, error: 'Código inválido o ya utilizado' };
  const c = r.rows[0];
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { valid: false, error: 'Código expirado' };
  const planKey = Object.keys(SUBSCRIPTION_PLANS).find(k => SUBSCRIPTION_PLANS[k].name === c.plan_name) || 'plan_completo';
  return { valid: true, code: r.rows[0], plan: SUBSCRIPTION_PLANS[planKey] };
}

/**
 * Registra una nueva clínica y su administrador.
 * Requiere código de registro válido O subscription_id de pago confirmado.
 */
async function registerClinic(body) {
  const { code, subscription_id, email, password, username: rawUsername, clinic_email,
          first_name, last_name, gentilicio, profession,
          clinic_name, clinic_phone, clinic_address, clinic_city, clinic_country,
          clinic_ruc, clinic_website, cedula_profesional, matricula_senescyt, especialidad } = body;

  if (!email?.trim() || !password?.trim() || !first_name?.trim() || !last_name?.trim())
    return { error: 'email, password, first_name y last_name son requeridos' };
  if (!rawUsername?.trim())
    return { error: 'El nombre de usuario es requerido' };
  if (!clinic_name?.trim())
    return { error: 'El nombre de la clínica es requerido' };

  // Validar formato de contraseña: 8+ chars, al menos 1 letra y 1 número
  if (password.length < 8) return { error: 'La contraseña debe tener al menos 8 caracteres' };
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return { error: 'La contraseña debe contener al menos una letra y un número' };

  const emailNorm    = email.trim().toLowerCase();
  const usernameNorm = rawUsername.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const clinicContactEmail = clinic_email?.trim().toLowerCase() || emailNorm;

  // Validar email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))
    return { error: 'El correo electrónico no es válido' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clinicContactEmail))
    return { error: 'El correo electrónico de la clínica no es válido' };

  // Validar username
  if (usernameNorm.length < 3 || usernameNorm.length > 20)
    return { error: 'El nombre de usuario debe tener entre 3 y 20 caracteres' };

  // Verificar email disponible (por email y username)
  const existingEmail = await sql`SELECT id FROM clinic_users WHERE email = ${emailNorm}`;
  if (existingEmail.rows.length) return { error: 'Ya existe una cuenta con ese correo electrónico' };

  const existingClinicEmail = await sql`SELECT id FROM clinics WHERE LOWER(email) = ${clinicContactEmail}`;
  if (existingClinicEmail.rows.length) return { error: 'Ese correo electrónico ya está vinculado a otra clínica' };

  // Verificar username disponible
  const existingUser = await sql`SELECT id FROM clinic_users WHERE username = ${usernameNorm}`;
  if (existingUser.rows.length) return { error: 'El nombre de usuario ya está en uso. Elige otro.' };

  let codeRow = null;
  let planFeatures = ALL_FEATURES;
  let accessScope   = 'all';

  // Validar vía código único — claim atómico previene race conditions
  if (code) {
    const claimed = await sql`
      UPDATE registration_codes
      SET is_active = false, used_at = NOW()
      WHERE code = ${code.trim().toUpperCase()}
        AND is_active = true
        AND used_by IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING id, plan_name, features, access_scope
    `;
    if (!claimed.rows.length) return { error: 'Código inválido, ya utilizado o expirado' };
    codeRow      = claimed.rows[0];
    planFeatures = Array.isArray(codeRow.features) && codeRow.features.length ? codeRow.features : ALL_FEATURES;
    accessScope  = codeRow.access_scope || 'all';
  } else if (subscription_id) {
    // Validar vía pago confirmado (status='paid' — no 'registered' ni otro estado)
    const sub = await sql`SELECT * FROM subscriptions WHERE id=${subscription_id} AND status='paid'`;
    if (!sub.rows.length) return { error: 'Pago no confirmado, ya utilizado o expirado' };
    const plan = Object.values(SUBSCRIPTION_PLANS).find(p => p.name === sub.rows[0].plan_name) || SUBSCRIPTION_PLANS.plan_completo;
    planFeatures = plan.features;
    accessScope  = plan.access_scope;
  } else {
    return { error: 'Se requiere un código de registro o un pago confirmado' };
  }

  // Crear clínica (usar clinic_email si se proporcionó, si no el email del usuario)
  const slug = clinic_name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  const subExpires = new Date(Date.now() + 365 * 86400000); // 365 días desde hoy
  let clinicId;
  try {
    const clinicR = await sql`
      INSERT INTO clinics (name, slug, email, phone, address, city, country, ruc, website, subscription_expires_at)
      VALUES (${clinic_name.trim()}, ${slug}, ${clinicContactEmail}, ${clinic_phone||null}, ${clinic_address||null}, ${clinic_city||null}, ${clinic_country||'Ecuador'}, ${clinic_ruc||null}, ${clinic_website||null}, ${subExpires})
      RETURNING id
    `;
    clinicId = clinicR.rows[0].id;
  } catch (e) {
    if (e.constraint === 'clinics_email_lower_unique')
      return { error: 'Ese correo electrónico ya está vinculado a otra clínica' };
    if (e.code === '23505') return { error: 'Ya existe una clínica con ese nombre' };
    throw e;
  }

  // Crear usuario admin de la clínica (username = nombre de usuario personalizado)
  const { hash, salt } = hashPassword(password);
  const fullName = `${first_name.trim()} ${last_name.trim()}`;
  const userR = await sql`
    INSERT INTO clinic_users
      (clinic_id, username, password_hash, salt, hash_algo, full_name, email,
       first_name, last_name, gentilicio, profession, cedula_profesional, matricula_senescyt, especialidad, role, access_scope)
    VALUES
      (${clinicId}, ${usernameNorm}, ${hash}, ${salt}, 'pbkdf2', ${fullName}, ${emailNorm},
       ${first_name.trim()}, ${last_name.trim()}, ${gentilicio||null}, ${profession||null},
       ${cedula_profesional||null}, ${matricula_senescyt||null}, ${especialidad||null}, 'clinic_admin', ${accessScope})
    RETURNING id
  `;
  const userId = userR.rows[0].id;

  // Habilitar features según plan
  for (const f of planFeatures) {
    await sql`INSERT INTO clinic_features (clinic_id, feature, enabled) VALUES (${clinicId}, ${f}, true) ON CONFLICT (clinic_id, feature) DO NOTHING`;
  }

  // Marcar código como usado
  if (codeRow) {
    await sql`UPDATE registration_codes SET used_by=${userId}, used_at=NOW(), is_active=false WHERE id=${codeRow.id}`;
  }
  // Marcar suscripción como usada (previene double-use del mismo subscription_id)
  if (subscription_id) {
    await sql`UPDATE subscriptions SET status='registered' WHERE id=${subscription_id} AND status='paid'`;
  }

  // Enviar email de bienvenida (sin bloquear la respuesta si falla)
  sendWelcomeEmail(emailNorm, first_name.trim(), usernameNorm, clinic_name.trim(), clinicContactEmail)
    .catch(e => console.error('[register] sendWelcomeEmail error:', e.message));

  return {
    success: true,
    user: { username: usernameNorm, email: emailNorm, full_name: fullName, role: 'clinic_admin', clinic_id: clinicId },
    clinic: { id: clinicId, name: clinic_name.trim(), slug },
    features: planFeatures,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de registro (generados por master_admin)
// ─────────────────────────────────────────────────────────────────────────────

async function generateRegistrationCode(requestUser, body) {
  if (!requireRole(requestUser, 'master_admin')) return { error: 'Solo master_admin' };
  const { plan_name = 'Plan Lanzamiento BioskinTech', expires_days = 30, note } = body || {};

  const plan = Object.values(SUBSCRIPTION_PLANS).find(p => p.name === plan_name) || SUBSCRIPTION_PLANS.plan_completo;
  const code = crypto.randomBytes(6).toString('hex').toUpperCase(); // 12 chars hex
  const exp  = expires_days > 0 ? new Date(Date.now() + expires_days * 86400000) : null;

  const r = await sql`
    INSERT INTO registration_codes (code, plan_name, features, access_scope, is_active, expires_at, note, created_by)
    VALUES (${code}, ${plan.name}, ${JSON.stringify(plan.features)}, ${plan.access_scope}, true, ${exp}, ${note||null}, ${requestUser.id})
    RETURNING *
  `;
  return { success: true, code: r.rows[0] };
}

async function listRegistrationCodes(requestUser) {
  if (!requireRole(requestUser, 'master_admin')) return { error: 'Solo master_admin' };
  const r = await sql`
    SELECT rc.*, cu.username as used_by_username, cu.full_name as used_by_name
    FROM registration_codes rc
    LEFT JOIN clinic_users cu ON cu.id = rc.used_by
    ORDER BY rc.created_at DESC
  `;
  return r.rows;
}

async function revokeRegistrationCode(requestUser, id) {
  if (!requireRole(requestUser, 'master_admin')) return { error: 'Solo master_admin' };
  if (!id) return { error: 'id requerido' };
  await sql`UPDATE registration_codes SET is_active=false WHERE id=${id}`;
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Links de invitación (para agregar usuarios a clínicas existentes)
// ─────────────────────────────────────────────────────────────────────────────

async function generateInviteLink(requestUser, body) {
  if (!requireRole(requestUser, 'master_admin', 'clinic_admin')) return { error: 'Sin permiso' };
  const { email, role = 'clinic_user', clinic_id, expires_hours = 72, access_scope = 'own', features = [] } = body || {};

  const targetClinicId = requestUser.role === 'master_admin' ? (clinic_id ?? requestUser.clinic_id) : requestUser.clinic_id;
  if (!targetClinicId) return { error: 'clinic_id requerido' };
  if (!['clinic_admin', 'clinic_user'].includes(role)) return { error: 'Rol inválido para invitación' };

  const emailNorm = email?.trim().toLowerCase() || null;
  if (emailNorm && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))
    return { error: 'Email inválido' };

  const token = crypto.randomBytes(32).toString('hex');
  const exp   = new Date(Date.now() + expires_hours * 3600000);
  const featuresJson = JSON.stringify(Array.isArray(features) ? features.filter(f => ALL_FEATURES.includes(f)) : []);

  const r = await sql`
    INSERT INTO invite_links (token, clinic_id, role, email, access_scope, features, expires_at, created_by)
    VALUES (${token}, ${targetClinicId}, ${role}, ${emailNorm}, ${access_scope}, ${featuresJson}::jsonb, ${exp}, ${requestUser.id})
    RETURNING id, token, role, email, access_scope, features, expires_at
  `;

  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const link   = `${appUrl}/gestionestetica/admin/invite?token=${token}`;

  if (emailNorm) {
    const clinicRow = await sql`SELECT name FROM clinics WHERE id=${targetClinicId}`;
    const clinicName = clinicRow.rows[0]?.name || 'BIOSKIN';
    const roleLabel = role === 'clinic_admin' ? 'Administrador de Clínica' : 'Usuario';
    try {
      await sendAuthEmail(emailNorm, `Invitación para unirte a ${clinicName} — BioskinTech`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
          <div style="background:#deb887;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:white;margin:0;font-size:24px;">BIOSKIN</h1>
            <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px;">Sistema de Gestión Clínica</p>
          </div>
          <div style="padding:28px;background:white;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
            <h2 style="color:#222;margin-top:0;">¡Fuiste invitado a unirte a ${clinicName}!</h2>
            <p>Has recibido una invitación para crear tu cuenta en BioskinTech como <strong>${roleLabel}</strong> de la clínica <strong>${clinicName}</strong>.</p>
            <p style="color:#777;font-size:13px;">Este enlace es de <strong>un solo uso</strong> y expira en <strong>${expires_hours} horas</strong>.</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${link}" style="display:inline-block;background:#deb887;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Crear mi cuenta →</a>
            </div>
            <p style="color:#bbb;font-size:11px;">Si no esperabas esta invitación, puedes ignorar este correo.</p>
          </div>
        </div>`
      );
    } catch { /* non-fatal — link is still returned */ }
  }

  return { success: true, invite: r.rows[0], link };
}

async function getInviteDetails(token) {
  if (!token || typeof token !== 'string' || token.length !== 64)
    return { valid: false, error: 'Token inválido' };
  if (!/^[0-9a-f]{64}$/.test(token)) return { valid: false, error: 'Token inválido' };
  const r = await sql`
    SELECT il.role, il.email, il.is_used, il.expires_at, il.access_scope, il.features,
           c.name as clinic_name
    FROM invite_links il
    LEFT JOIN clinics c ON c.id = il.clinic_id
    WHERE il.token = ${token}
  `;
  if (!r.rows.length) return { valid: false, error: 'Enlace no encontrado' };
  const inv = r.rows[0];
  if (inv.is_used) return { valid: false, error: 'Este enlace ya fue utilizado', used: true };
  if (new Date(inv.expires_at) < new Date()) return { valid: false, error: 'Este enlace ha expirado', expired: true };
  const maskedEmail = inv.email
    ? inv.email.replace(/^(.{2}).*@(.{1,2}).*(\.\w+)$/, '$1***@$2***$3')
    : null;
  return {
    valid: true,
    clinic_name: inv.clinic_name || 'Clínica',
    role: inv.role,
    access_scope: inv.access_scope || 'own',
    features: Array.isArray(inv.features) ? inv.features : [],
    email: maskedEmail,
  };
}

async function listInviteLinks(requestUser) {
  if (!requireRole(requestUser, 'master_admin', 'clinic_admin')) return { error: 'Sin permiso' };
  const r = requestUser.role === 'master_admin'
    ? await sql`
        SELECT il.id, il.token, il.role, il.email, il.access_scope, il.is_used, il.expires_at, il.created_at,
               cu.username as used_by_username, c.name as clinic_name
        FROM invite_links il
        LEFT JOIN clinic_users cu ON cu.id = il.used_by
        LEFT JOIN clinics c ON c.id = il.clinic_id
        ORDER BY il.created_at DESC LIMIT 100
      `
    : await sql`
        SELECT il.id, il.token, il.role, il.email, il.access_scope, il.is_used, il.expires_at, il.created_at,
               cu.username as used_by_username, c.name as clinic_name
        FROM invite_links il
        LEFT JOIN clinic_users cu ON cu.id = il.used_by
        LEFT JOIN clinics c ON c.id = il.clinic_id
        WHERE il.clinic_id = ${requestUser.clinic_id}
        ORDER BY il.created_at DESC
      `;
  return r.rows;
}

async function revokeInvite(requestUser, id) {
  if (!requireRole(requestUser, 'master_admin', 'clinic_admin')) return { error: 'Sin permiso' };
  if (!id) return { error: 'id requerido' };
  // Revoke marks as used without recording a user — prevents the link from being claimed
  await sql`UPDATE invite_links SET is_used = true WHERE id = ${id} AND is_used = false`;
  return { success: true };
}

/** Usa un invite link para registrar un nuevo usuario en una clínica existente */
async function useInviteLink(token, body) {
  if (!token || typeof token !== 'string') return { error: 'Token requerido' };
  if (!/^[0-9a-f]{64}$/.test(token)) return { error: 'Token inválido' };

  // Atomic claim — prevents race condition (two simultaneous requests using the same token)
  const claimed = await sql`
    UPDATE invite_links SET is_used = true
    WHERE token = ${token} AND is_used = false AND expires_at > NOW()
    RETURNING *
  `;
  if (!claimed.rows.length) return { error: 'Enlace inválido, ya utilizado o expirado' };
  const invite = claimed.rows[0];

  const { email, password, first_name, last_name, gentilicio, profession,
          especialidad, cedula_profesional, matricula_senescyt, username } = body || {};

  // Undo claim helper — called if validation fails after atomic claim
  const undoClaim = () => sql`UPDATE invite_links SET is_used = false, used_by = NULL WHERE id = ${invite.id}`;

  if (!email?.trim() || !password?.trim() || !first_name?.trim() || !last_name?.trim()) {
    await undoClaim();
    return { error: 'email, contraseña, nombre y apellido son requeridos' };
  }
  if (password.length < 8) { await undoClaim(); return { error: 'La contraseña debe tener al menos 8 caracteres' }; }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    await undoClaim();
    return { error: 'La contraseña debe tener al menos una letra y un número' };
  }

  const emailNorm = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) { await undoClaim(); return { error: 'Email inválido' }; }

  // Enforce scoped email if invite was issued for a specific address
  if (invite.email && invite.email.toLowerCase() !== emailNorm) {
    await undoClaim();
    return { error: 'Este enlace fue emitido para otro correo electrónico' };
  }

  // Build username — use provided or derive from email prefix
  const usernameFinal = (username?.trim().toLowerCase().replace(/[^a-z0-9_]/g, '') || emailNorm.split('@')[0].replace(/[^a-z0-9_]/g, '')).substring(0, 30);
  if (usernameFinal.length < 3) { await undoClaim(); return { error: 'El nombre de usuario debe tener al menos 3 caracteres' }; }

  const existing = await sql`SELECT id FROM clinic_users WHERE username = ${usernameFinal} OR email = ${emailNorm}`;
  if (existing.rows.length) { await undoClaim(); return { error: 'Ya existe una cuenta con ese email o nombre de usuario' }; }

  const { hash, salt } = hashPassword(password);
  const fullName    = `${first_name.trim()} ${last_name.trim()}`;
  const accessScope = invite.access_scope || 'own';

  const userR = await sql`
    INSERT INTO clinic_users
      (clinic_id, username, password_hash, salt, hash_algo, full_name, email, first_name, last_name,
       gentilicio, profession, especialidad, cedula_profesional, matricula_senescyt, role, access_scope)
    VALUES
      (${invite.clinic_id}, ${usernameFinal}, ${hash}, ${salt}, 'pbkdf2', ${fullName}, ${emailNorm},
       ${first_name.trim()}, ${last_name.trim()}, ${gentilicio||null}, ${profession||null},
       ${especialidad||null}, ${cedula_profesional||null}, ${matricula_senescyt||null},
       ${invite.role}, ${accessScope})
    RETURNING id
  `;
  const userId = userR.rows[0].id;
  await sql`UPDATE invite_links SET used_by = ${userId} WHERE id = ${invite.id}`;

  // Apply feature restrictions from invite (disable features NOT in the allowed list)
  const inviteFeatures = Array.isArray(invite.features) ? invite.features : [];
  if (inviteFeatures.length > 0) {
    for (const feat of ALL_FEATURES) {
      if (!inviteFeatures.includes(feat)) {
        await sql`
          INSERT INTO user_module_overrides (clinic_user_id, feature, enabled)
          VALUES (${userId}, ${feat}, false)
          ON CONFLICT (clinic_user_id, feature) DO UPDATE SET enabled = false
        `;
      }
    }
  }

  const sessionToken = generateToken();
  const exp = new Date(Date.now() + SESSION_EXPIRY_MS);
  await sql`
    INSERT INTO admin_sessions (session_token, username, expires_at, clinic_user_id, role, clinic_id, access_scope, is_active)
    VALUES (${sessionToken}, ${usernameFinal}, ${exp}, ${userId}, ${invite.role}, ${invite.clinic_id}, ${accessScope}, true)
  `;

  return {
    success: true, sessionToken, expiresAt: exp,
    user: { id: userId, username: usernameFinal, full_name: fullName, email: emailNorm,
            role: invite.role, clinic_id: invite.clinic_id, access_scope: accessScope,
            first_name: first_name.trim(), last_name: last_name.trim(), gentilicio, profession },
    features: await getFeatures(invite.clinic_id),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificación OTP (segundo paso de login 2FA)
// ─────────────────────────────────────────────────────────────────────────────

/** Verifica el código OTP enviado por email y crea la sesión definitiva */
async function verifyOTP(otpToken, code, ip, ua) {
  if (!otpToken?.trim() || !code?.trim()) return { success: false, error: 'Datos requeridos' };
  if (!/^\d{6}$/.test(code.trim())) return { success: false, error: 'El código debe tener 6 dígitos' };

  const r = await sql`
    SELECT lo.id, lo.code, lo.attempts, lo.user_id,
           cu.username, cu.full_name, cu.email, cu.role, cu.clinic_id, cu.access_scope,
           cu.cedula_profesional, cu.matricula_senescyt, cu.especialidad, cu.gentilicio, cu.profession, cu.first_name, cu.last_name,
           cu.is_demo, cu.demo_expires_at, c.slug AS clinic_slug, c.name AS clinic_name
    FROM login_otp lo
    JOIN clinic_users cu ON cu.id = lo.user_id
    LEFT JOIN clinics c ON c.id = cu.clinic_id
    WHERE lo.otp_token = ${otpToken.trim()}
      AND lo.used = false
      AND lo.expires_at > NOW()
  `;
  if (!r.rows.length) return { success: false, error: 'Código expirado o inválido. Inicia sesión nuevamente.' };
  const row = r.rows[0];

  // Rate limit: max 5 attempts per OTP
  if ((row.attempts || 0) >= 5) {
    return { success: false, error: 'Demasiados intentos. Solicita un nuevo código.' };
  }
  await sql`UPDATE login_otp SET attempts = COALESCE(attempts, 0) + 1 WHERE id=${row.id}`;

  // Comparación timing-safe — previene ataques de temporización
  const inputBuf    = Buffer.from(code.trim());
  const expectedBuf = Buffer.from(row.code);
  if (inputBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(inputBuf, expectedBuf))
    return { success: false, error: 'Código incorrecto' };

  // UPDATE atómico — previene replay si dos requests llegan simultáneamente
  const marked = await sql`UPDATE login_otp SET used=true WHERE id=${row.id} AND used=false RETURNING id`;
  if (!marked.rows.length) return { success: false, error: 'Código ya utilizado' };

  // Crear sesión real
  const token = generateToken();
  const exp   = new Date(Date.now() + SESSION_EXPIRY_MS);
  await sql`
    INSERT INTO admin_sessions
      (session_token, username, expires_at, ip_address, user_agent, clinic_user_id, role, clinic_id, access_scope)
    VALUES
      (${token}, ${row.username}, ${exp}, ${ip}, ${ua}, ${row.user_id}, ${row.role}, ${row.clinic_id}, ${row.access_scope})
  `;
  await sql`UPDATE clinic_users SET failed_attempts=0, locked_until=NULL, last_login=NOW() WHERE id=${row.user_id}`;

  return {
    success: true, sessionToken: token, expiresAt: exp,
    user: {
      id: row.user_id, username: row.username, full_name: row.full_name,
      email: row.email, role: row.role, clinic_id: row.clinic_id, access_scope: row.access_scope,
      clinic_slug: row.clinic_slug, clinic_name: row.clinic_name,
      cedula_profesional: row.cedula_profesional || null, matricula_senescyt: row.matricula_senescyt || null, especialidad: row.especialidad || null,
      gentilicio: row.gentilicio, profession: row.profession,
      first_name: row.first_name, last_name: row.last_name,
      is_demo: row.is_demo || false, demo_expires_at: row.demo_expires_at || null,
    },
    features: await getFeatures(row.clinic_id),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuración de clínica post-registro
// ─────────────────────────────────────────────────────────────────────────────

async function setupClinicDetails(requestUser, body) {
  if (!requireRole(requestUser, 'master_admin', 'clinic_admin')) return { error: 'Sin permiso' };
  const { name, email, phone, address, city, country, ruc, website, description, logo_url } = body;
  const id = requestUser.clinic_id;
  if (!id && requestUser.role !== 'master_admin') return { error: 'Sin clínica asignada' };
  const targetId = requestUser.role === 'master_admin' ? (body.clinic_id || id) : id;
  if (!targetId) return { error: 'clinic_id requerido' };

  await sql`
    UPDATE clinics SET
      name        = COALESCE(${name        ?? null}, name),
      email       = COALESCE(${email       ?? null}, email),
      phone       = COALESCE(${phone       ?? null}, phone),
      address     = COALESCE(${address     ?? null}, address),
      city        = COALESCE(${city        ?? null}, city),
      country     = COALESCE(${country     ?? null}, country),
      ruc         = COALESCE(${ruc         ?? null}, ruc),
      website     = COALESCE(${website     ?? null}, website),
      description = COALESCE(${description ?? null}, description),
      logo_url    = COALESCE(${logo_url    ?? null}, logo_url)
    WHERE id = ${targetId}
  `;
  const r = await sql`SELECT * FROM clinics WHERE id = ${targetId}`;
  return { success: true, clinic: r.rows[0] };
}

async function listClinics() {
  return (await sql`
    SELECT c.*,
           COUNT(DISTINCT cu.id) FILTER (WHERE cu.is_active = true)::int AS user_count,
           COALESCE((SELECT COUNT(*)::int FROM patients p WHERE p.clinic_id = c.id), 0) AS patient_count
    FROM clinics c
    LEFT JOIN clinic_users cu ON cu.clinic_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).rows;
}

async function createClinic(body) {
  const { name, email, phone, address } = body;
  if (!name?.trim()) return { error: 'El nombre de la clínica es requerido' };
  // Auto-genera slug desde el nombre si no se proporciona
  const slug = (body.slug?.trim() || name.trim())
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  try {
    const r = await sql`
      INSERT INTO clinics (name, slug, email, phone, address)
      VALUES (${name.trim()}, ${slug}, ${email || null}, ${phone || null}, ${address || null})
      RETURNING *
    `;
    return { success: true, clinic: r.rows[0] };
  } catch (e) {
    if (e.message?.includes('unique') || e.message?.includes('duplicate'))
      return { error: 'Ya existe una clínica con ese nombre o identificador' };
    throw e;
  }
}

async function updateClinic(body) {
  const { id, name, email, phone, address, is_active } = body;
  if (!id) return { error: 'id requerido' };
  await sql`
    UPDATE clinics SET
      name      = COALESCE(${name      ?? null}, name),
      email     = COALESCE(${email     ?? null}, email),
      phone     = COALESCE(${phone     ?? null}, phone),
      address   = COALESCE(${address   ?? null}, address),
      is_active = COALESCE(${is_active ?? null}, is_active)
    WHERE id = ${id}
  `;
  const r = await sql`SELECT * FROM clinics WHERE id = ${id}`;
  return { success: true, clinic: r.rows[0] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabla de sesiones (init mínimo, backwards-compat)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureSessionsTable() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id             SERIAL PRIMARY KEY,
        session_token  VARCHAR(255) UNIQUE NOT NULL,
        username       VARCHAR(100) NOT NULL,
        created_at     TIMESTAMP DEFAULT NOW(),
        expires_at     TIMESTAMP NOT NULL,
        ip_address     VARCHAR(100),
        user_agent     TEXT,
        is_active      BOOLEAN DEFAULT true,
        clinic_user_id INTEGER,
        role           VARCHAR(30),
        clinic_id      INTEGER,
        access_scope   VARCHAR(20)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_session_token ON admin_sessions(session_token) WHERE is_active = true`;
  } catch (e) {
    console.error('ensureSessionsTable:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — Bearer tokens no usan cookies, por lo que Allow-Credentials no aplica.
  // Allow-Credentials: true + wildcard es rechazado por spec CORS (y navegadores).
  const requestOrigin = req.headers.origin || '';
  const allowedOrigins = (process.env.ADMIN_CORS_ORIGIN || 'https://bioskintech.vercel.app,http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim());
  const corsOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-setup-secret, x-target-clinic-id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Garantiza que las columnas nuevas existan antes de cualquier query
  await ensureNewColumns();

  const action = req.query.action || req.body?.action;

  try {
    // ── Inicialización del esquema (protegida por secret) ──────────────────
    if (action === 'initMultiTenant') {
      const secret = (req.headers['x-setup-secret'] || req.query.secret || '').trim();
      const expected = (process.env.ADMIN_SETUP_SECRET || '').trim();
      if (!expected || secret !== expected)
        return res.status(403).json({ error: 'Unauthorized — requiere x-setup-secret válido' });
      await initMultiTenantSchema();
      const { bioskinId } = await seedData();
      return res.status(200).json({ success: true, message: 'Multi-tenant inicializado', bioskinId });
    }

    if (action === 'init') {
      await ensureSessionsTable();
      return res.status(200).json({ success: true, message: 'Tabla de sesiones inicializada' });
    }

    // Re-hashea MASTER_ADMIN_PASSWORD actual en la DB y desbloquea la cuenta
    if (action === 'resetMasterPassword') {
      const secret = (req.headers['x-setup-secret'] || req.query.secret || '').trim();
      const expected = (process.env.ADMIN_SETUP_SECRET || '').trim();
      if (!expected || secret !== expected)
        return res.status(403).json({ error: 'Unauthorized — requiere x-setup-secret válido' });
      const mu = (process.env.MASTER_ADMIN_USERNAME || '').trim();
      const mp = (process.env.MASTER_ADMIN_PASSWORD || '').trim();
      if (!mu || !mp) return res.status(400).json({ error: 'MASTER_ADMIN_USERNAME o MASTER_ADMIN_PASSWORD no configurados' });
      const { hash, salt } = hashPassword(mp);
      const r = await sql`
        UPDATE clinic_users
        SET password_hash=${hash}, salt=${salt}, hash_algo='pbkdf2',
            failed_attempts=0, locked_until=NULL
        WHERE username=${mu} AND role='master_admin'
        RETURNING id, username
      `;
      if (!r.rows.length) return res.status(404).json({ error: `master_admin '${mu}' no encontrado en la DB — ejecuta initMultiTenant primero` });
      await sql`UPDATE admin_sessions SET is_active=false WHERE username=${mu}`;
      return res.status(200).json({ success: true, message: `Contraseña actualizada y cuenta desbloqueada para '${mu}'` });
    }

    // ── Acciones públicas (no requieren autenticación) ─────────────────────

    // Verificar disponibilidad de email (registro)
    if (action === 'checkEmail') {
      const email = (req.query.email || req.body?.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email requerido' });
      const r = await sql`SELECT id FROM clinic_users WHERE username=${email}`;
      return res.status(200).json({ available: r.rows.length === 0 });
    }

    if (action === 'checkClinicEmail') {
      const email = (req.query.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'email inválido' });
      const r = await sql`SELECT id FROM clinics WHERE LOWER(email) = ${email}`;
      return res.status(200).json({ available: r.rows.length === 0 });
    }

    if (action === 'claimSetupToken') {
      const { token, newPassword } = req.body || {};
      const result = await claimSetupTokenFn(token, newPassword);
      return res.status(result.error ? 400 : 200).json(result);
    }

    // Validar código de registro (paso previo al formulario)
    if (action === 'validateCode') {
      const code = (req.query.code || req.body?.code || '').trim();
      const result = await validateRegistrationCode(code);
      return res.status(result.valid ? 200 : 400).json(result);
    }

    // Registro completo de nueva clínica
    if (action === 'register') {
      const result = await registerClinic(req.body || {});
      return res.status(result.error ? 400 : 201).json(result);
    }

    // Detalles públicos de una invitación (sin consumirla)
    if (action === 'getInvite') {
      const token = (req.query.token || '').trim();
      const result = await getInviteDetails(token);
      return res.status(result.valid === false ? 400 : 200).json(result);
    }

    // Usar invite link para registro en clínica existente
    if (action === 'useInvite') {
      const token = req.query.token || req.body?.token;
      const result = await useInviteLink(token, req.body || {});
      return res.status(result.error ? 400 : 201).json(result);
    }

    // Planes de suscripción disponibles (público)
    if (action === 'getPlans') {
      return res.status(200).json({ plans: SUBSCRIPTION_PLANS });
    }

    // ── Login ──────────────────────────────────────────────────────────────
    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username?.trim() || !password?.trim())
        return res.status(400).json({ success: false, error: 'Usuario y contraseña son requeridos' });
      const ip     = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
      const ua     = req.headers['user-agent'] || '';
      const result = await loginUser(username.trim(), password.trim(), ip, ua, req);
      return res.status(result.success ? 200 : 401).json(result);
    }

    // ── Verificar sesión ───────────────────────────────────────────────────
    if (action === 'verify') {
      const token  = (req.headers.authorization || '').replace('Bearer ', '').trim()
                     || req.query.token || req.body?.sessionToken;
      const result = await verifySession(token);
      if (result.valid) {
        result.features = await getFeatures(result.user.clinic_id);
        // Cargar overrides de módulo del usuario (qué módulos están restringidos individualmente)
        if (result.user?.id) {
          try {
            const ovr = await sql`SELECT feature, enabled FROM user_module_overrides WHERE clinic_user_id = ${result.user.id}`;
            result.user_module_overrides = ovr.rows; // [{feature, enabled}]
          } catch { result.user_module_overrides = []; }
        }
      }
      return res.status(result.valid ? 200 : 401).json({ success: result.valid, ...result });
    }

    // ── Logout ─────────────────────────────────────────────────────────────
    if (action === 'logout') {
      const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || req.body?.sessionToken;
      if (token) await sql`UPDATE admin_sessions SET is_active = false WHERE session_token = ${token}`;
      return res.status(200).json({ success: true });
    }

    // ── Limpiar sesiones expiradas ─────────────────────────────────────────
    if (action === 'cleanup') {
      // Requiere autenticación — evita que actores externos invoquen operaciones de mantenimiento (M-2 fix)
      const cleanupUser = await getRequestUser(req);
      if (!cleanupUser) return res.status(401).json({ success: false, error: 'No autenticado' });
      const r = await sql`UPDATE admin_sessions SET is_active = false WHERE expires_at < NOW() AND is_active = true`;
      return res.status(200).json({ success: true, count: r.rowCount });
    }

    // ── Acciones públicas de registro y OAuth ──────────────────────────────

    if (action === 'checkEmail') {
      const email = (req.query.email || req.body?.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email requerido' });
      // Verifica tanto el campo email como username (algunos usuarios tienen email como username)
      const r = await sql`SELECT id FROM clinic_users WHERE email = ${email} OR username = ${email}`;
      return res.status(200).json({ available: r.rows.length === 0 });
    }

    // Verificar username disponible (público — sin autenticación requerida)
    if (action === 'checkUsernamePublic') {
      const u = (req.query.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!u || u.length < 3) return res.status(400).json({ error: 'username inválido (mín. 3 caracteres, solo letras, números y _)' });
      const r = await sql`SELECT id FROM clinic_users WHERE username = ${u}`;
      return res.status(200).json({ available: r.rows.length === 0, username: u });
    }

    if (action === 'validateCode') {
      const { code } = req.body || {};
      return res.status(200).json(await validateRegistrationCode(code));
    }

    if (action === 'verifyOTP') {
      const { otpToken, code } = req.body || {};
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ua = req.headers['user-agent'] || '';
      return res.status(200).json(await verifyOTP(otpToken, code, ip, ua));
    }

    if (action === 'register') {
      const result = await registerClinic(req.body || {});
      return res.status(result.error ? 400 : 201).json(result);
    }

    if (action === 'useInvite') {
      const { token: invToken, ...userData } = req.body || {};
      if (!invToken) return res.status(400).json({ error: 'token requerido' });
      const result = await useInviteLink(invToken, { ...userData });
      return res.status(result.error ? 400 : 201).json(result);
    }

    // ── Planes de suscripción (público) ───────────────────────────────────
    if (action === 'getPlans') {
      return res.status(200).json({ plans: SUBSCRIPTION_PLANS });
    }

    // ── Acciones autenticadas ──────────────────────────────────────────────
    const user = await getRequestUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'No autenticado o sesión expirada' });

    // Gestión de usuarios
    if (action === 'listUsers') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const clinicIdFilter = req.query.clinicId || null; // UUID — no parseInt
      return res.status(200).json(await listUsers(user, clinicIdFilter));
    }
    if (action === 'createUser') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const result = await createUser(user, req.body || {});
      return res.status(result.error ? 400 : 201).json(result);
    }
    if (action === 'updateUser') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const result = await updateUser(user, req.body || {});
      return res.status(result.error ? 400 : 200).json(result);
    }
    if (action === 'resetPassword') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const result = await resetPassword(user, req.body || {});
      return res.status(result.error ? 400 : 200).json(result);
    }

    // Cambio de contraseña propio (cualquier usuario autenticado)
    if (action === 'changePassword') {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Campos requeridos' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      const u = await sql`SELECT password_hash, salt, hash_algo FROM clinic_users WHERE id = ${user.id}`;
      if (!u.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
      const row = u.rows[0];
      if (!verifyPassword(currentPassword, row.password_hash, row.salt, row.hash_algo))
        return res.status(401).json({ error: 'Contraseña actual incorrecta' });
      const { hash, salt } = hashPassword(newPassword);
      await sql`UPDATE clinic_users SET password_hash = ${hash}, salt = ${salt}, hash_algo = 'pbkdf2' WHERE id = ${user.id}`;
      // Invalidar todas las sesiones activas del usuario salvo la actual
      const currentToken = (req.headers.authorization || '').replace('Bearer ', '').trim() || req.body?.sessionToken;
      await sql`UPDATE admin_sessions SET is_active = false WHERE clinic_user_id = ${user.id} AND session_token != ${currentToken}`;
      return res.status(200).json({ success: true, message: 'Contraseña actualizada' });
    }

    // Verificar disponibilidad de username
    if (action === 'checkUsername') {
      const { username } = req.query;
      if (!username) return res.status(400).json({ error: 'username requerido' });
      const r = await sql`SELECT id FROM clinic_users WHERE username = ${username.toLowerCase().trim()}`;
      return res.status(200).json({ available: r.rows.length === 0, taken: r.rows.length > 0 });
    }
    if (action === 'deleteUser') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const userId = req.query.id || req.body?.id;
      const result = await deleteUser(user, userId);
      return res.status(result.error ? 400 : 200).json(result);
    }

    // Gestión de clínicas (solo master_admin)
    if (action === 'listClinics') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      return res.status(200).json(await listClinics());
    }
    if (action === 'createClinic') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const result = await createClinic(req.body || {});
      return res.status(result.error ? 400 : 201).json(result);
    }
    if (action === 'updateClinic') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const result = await updateClinic(req.body || {});
      return res.status(result.error ? 400 : 200).json(result);
    }
    if (action === 'deleteClinic') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const clinicId = req.query.id || req.body?.id;
      if (!clinicId) return res.status(400).json({ error: 'id requerido' });
      // Null out subscriptions.clinic_id (no CASCADE on that FK)
      await sql`UPDATE subscriptions SET clinic_id = NULL WHERE clinic_id = ${clinicId}`;
      // DELETE cascades to: clinic_users, clinic_features, clinic_settings,
      // clinic_notifications, invite_links, consent_templates via clinic_consent_templates
      await sql`DELETE FROM clinics WHERE id = ${clinicId}`;
      return res.status(200).json({ success: true });
    }
    if (action === 'updateClinicSubscription') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const { clinic_id, expires_at, subscription_days } = req.body || {};
      if (!clinic_id) return res.status(400).json({ error: 'clinic_id requerido' });
      const newExp = expires_at ? new Date(expires_at) : (subscription_days > 0 ? new Date(Date.now() + subscription_days * 86400000) : null);
      const days   = subscription_days ?? 365;
      await sql`UPDATE clinics SET subscription_expires_at=${newExp}, subscription_days=${days} WHERE id=${clinic_id}`;
      return res.status(200).json({ success: true, subscription_expires_at: newExp });
    }

    // Gestión de features
    if (action === 'getFeatures') {
      const clinicId = req.query.clinicId ? parseInt(req.query.clinicId) : (user.clinic_id || null);
      if (user.role !== 'master_admin' && clinicId !== user.clinic_id)
        return res.status(403).json({ error: 'Sin permiso' });
      return res.status(200).json({ success: true, features: await getFeatures(clinicId), allFeatures: ALL_FEATURES });
    }
    if (action === 'setFeature') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const { clinicId, feature, enabled } = req.body || {};
      const result = await setFeature(clinicId, feature, enabled);
      return res.status(result.error ? 400 : 200).json(result);
    }
    if (action === 'getClinicFeatures') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      return res.status(200).json({ success: true, data: await getAllClinicFeatures() });
    }
    if (action === 'initFeatures') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const clinics = await sql`SELECT id FROM clinics`;
      for (const c of clinics.rows) await seedFeatures(c.id);
      return res.status(200).json({ success: true, message: `Features inicializados para ${clinics.rows.length} clínica(s)` });
    }

    // ── OAuth Google por clínica ───────────────────────────────────────────
    if (action === 'oauthStart') {
      const { clinicId } = req.body || {};
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      // clinic_admin puede conectar solo su propia clínica; master_admin puede conectar cualquiera
      if (user.role === 'clinic_admin' && String(user.clinic_id) !== String(clinicId))
        return res.status(403).json({ error: 'Solo puedes conectar tu propia clínica' });
      if (!requireRole(user, 'master_admin', 'clinic_admin'))
        return res.status(403).json({ error: 'Sin permiso' });
      const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
      if (!clientId) return res.status(503).json({ error: 'GOOGLE_CLIENT_ID no configurado' });
      const appBase = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
      const redirectUri = `${appBase}/api/calendar`;
      const { returnPath } = req.body || {};
      const state = Buffer.from(JSON.stringify({ clinicId, ts: Date.now(), returnPath: returnPath || '/admin/master' })).toString('base64url');
      // URLSearchParams codifica correctamente sin double-encoding
      const params = new URLSearchParams({
        response_type: 'code',
        client_id:     clientId,
        redirect_uri:  redirectUri,
        scope:         'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send openid email profile',
        access_type:   'offline',
        prompt:        'consent',
        state,
      });
      const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      return res.status(200).json({ success: true, url });
    }

    if (action === 'oauthStatus') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const rows = await sql`SELECT clinic_id, email, connected_at, updated_at FROM clinic_oauth_tokens`;
      return res.status(200).json({ success: true, data: rows.rows });
    }

    if (action === 'oauthRevoke') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const { clinicId } = req.body || {};
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      await sql`DELETE FROM clinic_oauth_tokens WHERE clinic_id = ${clinicId}`;
      return res.status(200).json({ success: true, message: 'Conexión OAuth revocada' });
    }

    // Estado de conexión del email de la clínica (clinic_admin propia clínica o master_admin)
    if (action === 'getEmailConnectionStatus') {
      const clinicId = parseInt(req.query.clinicId || user.clinic_id || 0);
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      if (user.role === 'clinic_admin' && clinicId !== user.clinic_id)
        return res.status(403).json({ error: 'Sin permiso' });
      if (!requireRole(user, 'master_admin', 'clinic_admin'))
        return res.status(403).json({ error: 'Sin permiso' });
      const [tokRow, clinicRow] = await Promise.all([
        sql`SELECT email, connected_at FROM clinic_oauth_tokens WHERE clinic_id = ${clinicId}`,
        sql`SELECT email as clinic_email FROM clinics WHERE id = ${clinicId}`,
      ]);
      return res.status(200).json({
        success: true,
        connected:    tokRow.rows.length > 0,
        email:        tokRow.rows[0]?.email || null,
        connected_at: tokRow.rows[0]?.connected_at || null,
        clinic_email: clinicRow.rows[0]?.clinic_email || null,
      });
    }

    // Reenviar enlace de conexión de email por correo
    if (action === 'sendEmailConnectionLink') {
      const clinicId = parseInt(req.body?.clinicId || user.clinic_id || 0);
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      if (user.role === 'clinic_admin' && clinicId !== user.clinic_id)
        return res.status(403).json({ error: 'Solo puedes reenviar para tu propia clínica' });
      if (!requireRole(user, 'master_admin', 'clinic_admin'))
        return res.status(403).json({ error: 'Sin permiso' });
      // Obtener datos de la clínica y admin
      const r = await sql`
        SELECT c.name, c.email as clinic_email, u.email as admin_email, u.first_name
        FROM clinics c
        JOIN clinic_users u ON u.clinic_id = c.id
        WHERE c.id = ${clinicId} AND u.role = 'clinic_admin' AND u.is_active = true
        ORDER BY u.created_at LIMIT 1
      `;
      if (!r.rows.length) return res.status(404).json({ error: 'Clínica no encontrada' });
      const clinic = r.rows[0];
      const appUrl = (process.env.APP_URL || 'https://bioskintechapp.com').replace(/\/$/, '');
      const loginUrl = `${appUrl}/gestionestetica/admin/login?redirect=system-status`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
          <div style="background:#deb887;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:white;margin:0;font-size:24px;">BIOSKIN</h1>
          </div>
          <div style="padding:28px;background:white;border:1px solid #eee;border-top:none;">
            <h2 style="color:#222;margin-top:0;">Conecta el Gmail de tu clínica</h2>
            <p>Hola ${clinic.first_name}, recuerda conectar tu cuenta de Gmail <strong>${clinic.clinic_email || ''}</strong> para activar Google Calendar y correos automáticos de citas.</p>
            <a href="${loginUrl}" style="display:inline-block;background:#deb887;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:10px;">Conectar Gmail →</a>
            <p style="color:#888;font-size:12px;margin-top:15px;">Ir al panel → Estado del Sistema → Conectar Gmail</p>
          </div>
        </div>
      `;
      await sendAuthEmail(clinic.admin_email, 'BIOSKIN: Conecta el Gmail de tu clínica', html);
      return res.status(200).json({ success: true, message: 'Enlace enviado por correo' });
    }

    // ── Configuración por clínica ─────────────────────────────────────────
    const DEFAULT_TREATMENTS = [
      'Consulta + Escáner Facial','Botox / Toxina Botulínica','Relleno de Labios',
      'Relleno de Ojeras','Relleno de Pómulos','Limpieza Facial Profunda',
      'Peeling Químico','Mesoterapia Facial','Láser CO2 Fraccionado',
      'Radiofrecuencia','Hidratación Profunda','Depilación Láser',
      'Tratamiento Anti-Acné','Carboxiterapia','Otro'
    ];
    const DEFAULT_FINANZAS    = { currency: 'USD', currency_symbol: '$', tax_percent: 15, invoice_prefix: 'INV', payment_methods: ['Efectivo','Transferencia','Tarjeta de crédito','Tarjeta de débito'], invoice_notes: '' };
    const DEFAULT_INVENTARIO  = { expiry_alert_days: 30, low_stock_alert: true, require_batch: true, categories: ['Inyectable','Consumibles','Venta','Toxinas','Rellenos','Skincare','Equipos','Medicamentos','Otros'] };
    const DEFAULT_NOTIFICACIONES = { appointment_confirmation: true, appointment_reminder: true, low_stock_notification: false, whatsapp_enabled: false, reminder_hours_before: 24 };

    if (action === 'getClinicSettings') {
      const clinicId = req.query.clinicId || req.body?.clinicId;
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      // master_admin puede ver cualquier clínica; clinic_admin solo la suya
      if (user.role !== 'master_admin' && String(clinicId) !== String(user.clinic_id))
        return res.status(403).json({ error: 'Sin permiso' });

      const r = await sql`SELECT * FROM clinic_settings WHERE clinic_id = ${clinicId}`;
      if (!r.rows.length) {
        // Crear con defaults si no existe
        const clinicR = await sql`SELECT name, email, phone, address, city, ruc, logo_url FROM clinics WHERE id = ${clinicId}`;
        const clinic  = clinicR.rows[0] || {};
        const defaults = {
          general:    { name: clinic.name || '', city: clinic.city || '', tagline: '', logo_url: clinic.logo_url || '', phone: clinic.phone || '', address: clinic.address || '', tax_id: clinic.ruc || '' },
          treatments: DEFAULT_TREATMENTS,
          email:      { staff_email: clinic.email || '', from_name: clinic.name || '', signature: `El equipo de ${clinic.name || 'la clínica'}`, whatsapp_number: '' },
          agenda:     { start_hour: '08:00', end_hour: '19:00', slot_minutes: 60, calendar_prefix: clinic.name || 'CLINICA' },
          finanzas:         DEFAULT_FINANZAS,
          inventario:       DEFAULT_INVENTARIO,
          notificaciones:   DEFAULT_NOTIFICACIONES,
        };
        await sql`INSERT INTO clinic_settings (clinic_id, general, treatments, email, agenda)
          VALUES (${clinicId}, ${JSON.stringify(defaults.general)}, ${JSON.stringify(defaults.treatments)}, ${JSON.stringify(defaults.email)}, ${JSON.stringify(defaults.agenda)})
          ON CONFLICT (clinic_id) DO NOTHING`;
        return res.status(200).json({ success: true, settings: defaults });
      }
      const s = r.rows[0];
      return res.status(200).json({ success: true, settings: {
        general:        s.general,
        treatments:     s.treatments,
        email:          s.email,
        agenda:         s.agenda,
        finanzas:       { ...DEFAULT_FINANZAS,    ...(s.finanzas       || {}) },
        inventario:     { ...DEFAULT_INVENTARIO,  ...(s.inventario     || {}) },
        notificaciones: { ...DEFAULT_NOTIFICACIONES, ...(s.notificaciones || {}) },
      } });
    }

    if (action === 'saveClinicSettings') {
      const { clinicId, section, data } = req.body || {};
      if (!clinicId || !section || !data) return res.status(400).json({ error: 'clinicId, section y data son requeridos' });
      if (!['general','treatments','email','agenda','finanzas','inventario','notificaciones'].includes(section))
        return res.status(400).json({ error: 'section inválida' });
      if (user.role !== 'master_admin' && String(clinicId) !== String(user.clinic_id))
        return res.status(403).json({ error: 'Sin permiso' });

      const dataStr = JSON.stringify(data);

      // Validación de seguridad para logo: magic bytes + tamaño + rechazo de URLs externas
      if (section === 'general' && data.logo_url) {
        const logoUrl = data.logo_url;
        if (logoUrl.startsWith('data:')) {
          const m = logoUrl.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
          if (!m) return res.status(400).json({ error: 'Imagen inválida. Solo JPEG, PNG o WebP.' });
          const imgBuf = Buffer.from(m[3], 'base64');
          if (imgBuf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'La imagen supera el límite de 2MB.' });
          const MAGIC = { 'image/jpeg': [0xFF,0xD8,0xFF], 'image/png': [0x89,0x50,0x4E,0x47], 'image/webp': [0x52,0x49,0x46,0x46] };
          if (!MAGIC[m[1]].every((b, i) => imgBuf[i] === b))
            return res.status(400).json({ error: 'Firma de bytes inválida — el archivo no es una imagen real.' });
          if (m[1] === 'image/webp' && ![0x57,0x45,0x42,0x50].every((b, i) => imgBuf[8 + i] === b))
            return res.status(400).json({ error: 'Archivo WebP inválido.' });
          // Rechazo de SVG / HTML embebido disfrazado de imagen
          if (/<svg|<!doctype|<html/i.test(imgBuf.slice(0, 100).toString('utf8')))
            return res.status(400).json({ error: 'Tipo de archivo no permitido.' });
        } else if (logoUrl.startsWith('http')) {
          // Solo dominios propios — rechaza tracking pixels y contenido externo
          try {
            const host = new URL(logoUrl).hostname;
            if (!['bioskintech.com','www.bioskintech.com','bioskintech.vercel.app'].includes(host))
              return res.status(400).json({ error: 'Sube la imagen directamente. URLs externas no permitidas.' });
          } catch { return res.status(400).json({ error: 'URL de logo inválida.' }); }
        }
      }

      // ponytail: whitelist explícita — no usar eval ni dynamic SQL con el nombre de sección
      if (section === 'general')
        await sql`INSERT INTO clinic_settings (clinic_id, general, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET general = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'treatments')
        await sql`INSERT INTO clinic_settings (clinic_id, treatments, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET treatments = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'email')
        await sql`INSERT INTO clinic_settings (clinic_id, email, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET email = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'agenda')
        await sql`INSERT INTO clinic_settings (clinic_id, agenda, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET agenda = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'finanzas')
        await sql`INSERT INTO clinic_settings (clinic_id, finanzas, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET finanzas = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'inventario')
        await sql`INSERT INTO clinic_settings (clinic_id, inventario, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET inventario = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'notificaciones')
        await sql`INSERT INTO clinic_settings (clinic_id, notificaciones, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET notificaciones = ${dataStr}::jsonb, updated_at = NOW()`;

      return res.status(200).json({ success: true, message: `${section} guardado` });
    }

    // ── Gestión de plantillas de consentimiento ─────────────────────────────

    if (action === 'listConsentTemplates') {
      const result = await sql`SELECT * FROM consent_templates WHERE is_active = true ORDER BY name ASC`;
      return res.status(200).json({ templates: result.rows });
    }

    if (action === 'saveConsentTemplate') {
      if (user.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
      const { id: tid, name, procedure_type, zone, sessions, objectives, description,
              risks, benefits, alternatives, pre_care, post_care, contraindications } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
      const obj   = JSON.stringify(objectives   || []);
      const rsk   = JSON.stringify(risks        || []);
      const ben   = JSON.stringify(benefits     || []);
      const alt   = JSON.stringify(alternatives || []);
      const pre   = JSON.stringify(pre_care     || []);
      const post  = JSON.stringify(post_care    || []);
      const contra = JSON.stringify(contraindications || []);
      if (tid) {
        await sql`UPDATE consent_templates SET name=${name}, procedure_type=${procedure_type||null},
          zone=${zone||null}, sessions=${sessions||1}, objectives=${obj}::jsonb,
          description=${description||null}, risks=${rsk}::jsonb, benefits=${ben}::jsonb,
          alternatives=${alt}::jsonb, pre_care=${pre}::jsonb, post_care=${post}::jsonb,
          contraindications=${contra}::jsonb, updated_at=NOW() WHERE id=${tid}`;
        return res.status(200).json({ success: true });
      }
      const ins = await sql`INSERT INTO consent_templates
        (name, procedure_type, zone, sessions, objectives, description, risks, benefits,
         alternatives, pre_care, post_care, contraindications)
        VALUES (${name}, ${procedure_type||null}, ${zone||null}, ${sessions||1}, ${obj}::jsonb,
          ${description||null}, ${rsk}::jsonb, ${ben}::jsonb, ${alt}::jsonb,
          ${pre}::jsonb, ${post}::jsonb, ${contra}::jsonb) RETURNING id`;
      return res.status(200).json({ success: true, id: ins.rows[0].id });
    }

    if (action === 'deleteConsentTemplate') {
      if (user.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
      const { id: tid } = req.body || {};
      if (!tid) return res.status(400).json({ error: 'id requerido' });
      await sql`UPDATE consent_templates SET is_active = false WHERE id = ${tid}`;
      return res.status(200).json({ success: true });
    }

    if (action === 'getClinicConsentTemplates') {
      const { clinicId } = req.query;
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      if (user.role !== 'master_admin' && String(clinicId) !== String(user.clinic_id))
        return res.status(403).json({ error: 'Sin permiso' });
      const result = await sql`
        SELECT ct.* FROM consent_templates ct
        JOIN clinic_consent_templates cct ON ct.id = cct.template_id
        WHERE cct.clinic_id = ${clinicId} AND ct.is_active = true
        ORDER BY ct.name ASC`;
      return res.status(200).json({ templates: result.rows });
    }

    if (action === 'getClinicTemplateAssignments') {
      if (user.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
      const { clinicId } = req.query;
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      const result = await sql`SELECT template_id FROM clinic_consent_templates WHERE clinic_id = ${clinicId}`;
      return res.status(200).json({ assigned: result.rows.map(r => r.template_id) });
    }

    if (action === 'assignConsentTemplate') {
      if (user.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
      const { clinicId, templateId, assign } = req.body || {};
      if (!clinicId || !templateId) return res.status(400).json({ error: 'clinicId y templateId requeridos' });
      if (assign) {
        await sql`INSERT INTO clinic_consent_templates (clinic_id, template_id)
          VALUES (${clinicId}, ${templateId}) ON CONFLICT DO NOTHING`;
      } else {
        await sql`DELETE FROM clinic_consent_templates WHERE clinic_id = ${clinicId} AND template_id = ${templateId}`;
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'seedConsentTemplates') {
      if (user.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
      const { force } = req.body || {};

      // Asegurar que las tablas existen antes de consultar
      try {
        await sql`CREATE TABLE IF NOT EXISTS consent_templates (
          id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL,
          procedure_type VARCHAR(150), zone VARCHAR(150), sessions INTEGER DEFAULT 1,
          objectives JSONB DEFAULT '[]', description TEXT,
          risks JSONB DEFAULT '[]', benefits JSONB DEFAULT '[]',
          alternatives JSONB DEFAULT '[]', pre_care JSONB DEFAULT '[]',
          post_care JSONB DEFAULT '[]', contraindications JSONB DEFAULT '[]',
          is_active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
        )`;
      } catch { /* ya existe */ }

      const count = await sql`SELECT COUNT(*) FROM consent_templates WHERE is_active = true`;
      if (parseInt(count.rows[0].count) > 0 && !force) {
        return res.status(200).json({ message: `${count.rows[0].count} plantillas ya sembradas` });
      }

      let seeds = [];
      try {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const seedPath = join(process.cwd(), 'data', 'consent-templates-seed.json');
        seeds = JSON.parse(readFileSync(seedPath, 'utf8'));
      } catch (e) {
        console.error('Seed file not found, using inline fallback:', e.message);
        // Fallback mínimo inline — el archivo completo viene de data/ via includeFiles
        seeds = [
          { name: 'Consentimiento Informado General', procedure_type: 'Procedimiento Estético', description: 'Consentimiento informado para procedimientos de medicina y estética.', objectives: ['Mejorar la apariencia estética'], risks: ['Reacciones alérgicas leves','Enrojecimiento temporal'], benefits: ['Mejora estética','Procedimiento mínimamente invasivo'], alternatives: ['No realizar el tratamiento'], pre_care: ['No aplicar maquillaje el día del procedimiento'], post_care: ['Evitar exposición solar 48h','Aplicar protector solar'] },
          { name: 'HIFU Facial', procedure_type: 'HIFU Facial (Ultrasonido Focalizado de Alta Intensidad)', description: 'HIFU aplica energía de ultrasonido focalizada para efecto tensor sin cirugía.', objectives: ['Tensado de piel y efecto lifting no quirúrgico','Definición del contorno mandibular'], risks: ['Sensación de calor durante aplicación','Enrojecimiento leve'], benefits: ['Rejuvenecimiento sin cirugía','Sin tiempo de inactividad'], pre_care: ['Piel completamente limpia'], post_care: ['Usar protector solar FPS 50+'] },
        ];
      }

      let inserted = 0;
      for (const t of seeds) {
        const obj   = JSON.stringify(t.objectives   || []);
        const rsk   = JSON.stringify(t.risks        || []);
        const ben   = JSON.stringify(t.benefits     || []);
        const alt   = JSON.stringify(t.alternatives || []);
        const pre   = JSON.stringify(t.pre_care     || []);
        const post  = JSON.stringify(t.post_care    || []);
        const contra = JSON.stringify(t.contraindications || []);
        const name  = (t.name || t.procedure_type || 'Plantilla').substring(0, 254);
        try {
          await sql`INSERT INTO consent_templates
            (name, procedure_type, zone, sessions, objectives, description, risks, benefits,
             alternatives, pre_care, post_care, contraindications)
            VALUES (${name}, ${t.procedure_type||null}, ${t.zone||null}, ${t.sessions||1},
              ${obj}::jsonb, ${t.description||null}, ${rsk}::jsonb, ${ben}::jsonb,
              ${alt}::jsonb, ${pre}::jsonb, ${post}::jsonb, ${contra}::jsonb)`;
          inserted++;
        } catch { /* skip on error */ }
      }
      return res.status(200).json({ success: true, inserted, message: `${inserted} plantillas sembradas correctamente` });
    }

    // ── Gestión de permisos de módulo por usuario ───────────────────────────

    if (action === 'getUserModuleOverrides') {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId requerido' });
      // Solo master_admin o clinic_admin de la misma clínica puede ver esto
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const ovr = await sql`SELECT feature, enabled FROM user_module_overrides WHERE clinic_user_id = ${userId}`;
      return res.status(200).json({ overrides: ovr.rows });
    }

    if (action === 'setUserModuleOverride') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const { userId, feature, enabled } = req.body || {};
      if (!userId || !feature) return res.status(400).json({ error: 'userId y feature requeridos' });
      if (enabled) {
        // enabled: false significa "quitado para este usuario"
        await sql`INSERT INTO user_module_overrides (clinic_user_id, feature, enabled)
          VALUES (${userId}, ${feature}, ${enabled}) ON CONFLICT (clinic_user_id, feature)
          DO UPDATE SET enabled = ${enabled}`;
      } else {
        // Si se vuelve a habilitar (sin override), se elimina el override para que herede clínica
        await sql`DELETE FROM user_module_overrides WHERE clinic_user_id = ${userId} AND feature = ${feature}`;
      }
      return res.status(200).json({ success: true });
    }

    // ── Registro de clínicas (autenticado — para setupClinic y codes) ──────

    if (action === 'setupClinic') {
      const result = await setupClinicDetails(user, req.body || {});
      return res.status(result.error ? 400 : 200).json(result);
    }

    // ── Códigos de registro (master_admin) ────────────────────────────────
    if (action === 'generateCode') {
      const result = await generateRegistrationCode(user, req.body || {});
      return res.status(result.error ? 403 : 201).json(result);
    }
    if (action === 'listCodes') {
      const result = await listRegistrationCodes(user);
      return res.status(result?.error ? 403 : 200).json(result);
    }
    if (action === 'revokeCode') {
      const id = req.query.id || req.body?.id;
      const result = await revokeRegistrationCode(user, id);
      return res.status(result.error ? 400 : 200).json(result);
    }

    // ── Dispositivos de confianza ──────────────────────────────────────────────
    if (action === 'trustDevice') {
      const { device_token } = req.body || {};
      if (!device_token || device_token.length < 16) return res.status(400).json({ error: 'device_token inválido' });
      await recordTrustedDevice(user.id, device_token, req.headers['x-forwarded-for'] || req.socket?.remoteAddress, req.headers['user-agent']);
      return res.status(200).json({ success: true });
    }

    // ── Setup tokens ──────────────────────────────────────────────────────
    if (action === 'generateSetupToken') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const { user_id, email } = req.body || {};
      if (!user_id || !email) return res.status(400).json({ error: 'user_id y email requeridos' });
      const result = await generateSetupTokenFn(user_id, email, user);
      return res.status(200).json({ success: true, ...result });
    }

    // ── Demo users cleanup ────────────────────────────────────────────────
    if (action === 'cleanupDemos') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      await cleanupExpiredDemos();
      return res.status(200).json({ success: true });
    }

    // ── Demo helpers ─────────────────────────────────────────────────────
    if (action === 'getNextDemoUsername') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const r = await sql`
        SELECT COALESCE(MAX(SUBSTRING(username FROM 5)::INTEGER), 0) AS max_seq
        FROM clinic_users WHERE is_demo = true AND username ~ '^demo\\d+$'
      `;
      const next = (r.rows[0]?.max_seq || 0) + 1;
      return res.status(200).json({ username: `demo${String(next).padStart(4, '0')}` });
    }

    if (action === 'listDemoUsers') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const clinicId = parseInt(req.query.clinicId);
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      const r = await sql`
        SELECT id, username, is_active, demo_expires_at, last_login
        FROM clinic_users WHERE clinic_id = ${clinicId} AND is_demo = true
        ORDER BY created_at DESC
      `;
      return res.status(200).json({ users: r.rows });
    }

    if (action === 'updateDemoCredentials') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const { userId, username: newUsername, password: newPassword, demo_expires_at: newExpiry } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId requerido' });
      const check = await sql`SELECT id, is_demo FROM clinic_users WHERE id = ${userId}`;
      if (!check.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (!check.rows[0].is_demo) return res.status(400).json({ error: 'El usuario no es una cuenta demo' });
      if (newUsername?.trim()) {
        const clean = newUsername.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!clean) return res.status(400).json({ error: 'Nombre de usuario inválido' });
        try {
          await sql`UPDATE clinic_users SET username = ${clean} WHERE id = ${userId}`;
        } catch (e) {
          if (e.message?.includes('unique') || e.message?.includes('duplicate'))
            return res.status(400).json({ error: 'El nombre de usuario ya existe' });
          throw e;
        }
      }
      let tempPassword = null;
      if (newPassword) {
        if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        tempPassword = newPassword;
        const { hash, salt } = hashPassword(newPassword);
        await sql`UPDATE clinic_users SET password_hash = ${hash}, salt = ${salt}, hash_algo = 'pbkdf2' WHERE id = ${userId}`;
      }
      if (newExpiry !== undefined) {
        const expiryVal = newExpiry ? new Date(newExpiry) : null;
        await sql`UPDATE clinic_users SET demo_expires_at = ${expiryVal} WHERE id = ${userId}`;
      }
      return res.status(200).json({ success: true, ...(tempPassword ? { temp_password: tempPassword } : {}) });
    }

    // ── Notificaciones de clínica ─────────────────────────────────────────
    if (action === 'getNotifications') {
      const clinicId = user.clinic_id;
      if (!clinicId) return res.status(200).json([]);
      const r = await sql`
        SELECT id, type, message, is_read, created_at
        FROM clinic_notifications
        WHERE clinic_id=${clinicId} AND is_read=false AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC LIMIT 20
      `;
      return res.status(200).json(r.rows);
    }

    if (action === 'markNotificationRead') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requerido' });
      await sql`UPDATE clinic_notifications SET is_read=true WHERE id=${id}`;
      return res.status(200).json({ success: true });
    }

    if (action === 'sendSubscriptionWarning') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const { clinic_id, message } = req.body || {};
      if (!clinic_id || !message) return res.status(400).json({ error: 'clinic_id y message requeridos' });
      await sql`
        INSERT INTO clinic_notifications (clinic_id, type, message, expires_at)
        VALUES (${clinic_id}, 'subscription_warning', ${message}, ${new Date(Date.now() + 30 * 86400000)})
      `;
      return res.status(201).json({ success: true });
    }

    // ── Links de invitación ───────────────────────────────────────────────
    if (action === 'generateInvite') {
      const result = await generateInviteLink(user, req.body || {});
      return res.status(result.error ? 400 : 201).json(result);
    }
    if (action === 'listInvites') {
      const result = await listInviteLinks(user);
      return res.status(result?.error ? 403 : 200).json(result);
    }
    if (action === 'revokeInvite') {
      const id = req.body?.id || req.query.id;
      const result = await revokeInvite(user, id);
      return res.status(result.error ? 400 : 200).json(result);
    }

    // ── Suscripciones (solo master_admin) ────────────────────────────────
    if (action === 'listSubscriptions') {
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const r = await sql`SELECT s.*, c.name as clinic_name FROM subscriptions s LEFT JOIN clinics c ON c.id = s.clinic_id ORDER BY s.created_at DESC`;
      return res.status(200).json(r.rows);
    }

    return res.status(400).json({ success: false, error: 'Acción no válida' });

  } catch (error) {
    console.error('❌ Error en admin-auth:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
}
