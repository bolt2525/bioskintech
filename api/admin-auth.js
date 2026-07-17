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

// ─────────────────────────────────────────────────────────────────────────────
// Configuración de seguridad
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 horas
const LOCK_ATTEMPTS     = 5;                    // intentos antes de bloquear
const LOCK_MS           = 15 * 60 * 1000;       // 15 minutos de bloqueo

// Lista de features reconocidas — debe coincidir con src/constants/features.ts
const ALL_FEATURES = [
  'calendar', 'block_schedule', 'appointment', 'diagnosis', 'protocols',
  'chat_assistant', 'clinical_records', 'finance', 'inventory',
  'clinical_3d', 'technical', 'backup', 'blog',
];

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
 */
function verifyPassword(password, storedHash, salt, algo) {
  if (algo === 'sha256') {
    return crypto.createHash('sha256').update(password).digest('hex') === storedHash;
  }
  return hashPassword(password, salt).hash === storedHash;
}

/** Genera un token de sesión de 32 bytes aleatorios */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Inicialización del esquema multi-tenant
// ─────────────────────────────────────────────────────────────────────────────

/** Crea todas las tablas necesarias (idempotente — safe to re-run) */
async function initMultiTenantSchema() {
  // Tabla de clínicas (tenants)
  await sql`
    CREATE TABLE IF NOT EXISTS clinics (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      slug       VARCHAR(100) UNIQUE NOT NULL,
      email      VARCHAR(255),
      phone      VARCHAR(50),
      address    TEXT,
      is_active  BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Usuarios por clínica (clinic_id = NULL → master_admin)
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_users (
      id              SERIAL PRIMARY KEY,
      clinic_id       INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
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
      clinic_id      INTEGER,
      access_scope   VARCHAR(20)
    )
  `;

  // Features habilitadas por clínica
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_features (
      clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      feature   VARCHAR(50) NOT NULL,
      enabled   BOOLEAN DEFAULT true,
      PRIMARY KEY (clinic_id, feature)
    )
  `;

  // Tokens OAuth de Google por clínica (Calendar + Gmail)
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_oauth_tokens (
      id            SERIAL PRIMARY KEY,
      clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE UNIQUE,
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
      clinic_id  INTEGER PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
      general    JSONB NOT NULL DEFAULT '{}',
      treatments JSONB NOT NULL DEFAULT '[]',
      email      JSONB NOT NULL DEFAULT '{}',
      agenda     JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Columnas extras en caso de migración de tabla preexistente
  for (const col of [
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS clinic_user_id INTEGER",
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS role VARCHAR(30)",
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS clinic_id INTEGER",
    "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20)",
  ]) {
    try { await sql.query(col); } catch { /* ya existe */ }
  }

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
async function seedData() {
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
    const r = await sql`
      SELECT feature FROM clinic_features
      WHERE clinic_id = ${clinicId} AND enabled = true
    `;
    return r.rows.length ? r.rows.map(x => x.feature) : ALL_FEATURES;
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
async function loginUser(username, password, ip, ua) {
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

  // Login contra DB
  const r = await sql`
    SELECT id, username, password_hash, salt, hash_algo, role, clinic_id, access_scope,
           failed_attempts, locked_until, is_active, full_name, email
    FROM clinic_users WHERE username = ${username}
  `;
  if (!r.rows.length) return { success: false, error: 'Credenciales inválidas' };

  const u = r.rows[0];
  if (!u.is_active) return { success: false, error: 'Cuenta desactivada. Contacta al administrador.' };

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

  // Éxito: resetear intentos y registrar sesión
  await sql`UPDATE clinic_users SET failed_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = ${u.id}`;

  const token = generateToken();
  const exp   = new Date(Date.now() + SESSION_EXPIRY_MS);
  await sql`
    INSERT INTO admin_sessions
      (session_token, username, expires_at, ip_address, user_agent, clinic_user_id, role, clinic_id, access_scope)
    VALUES
      (${token}, ${username}, ${exp}, ${ip}, ${ua}, ${u.id}, ${u.role}, ${u.clinic_id}, ${u.access_scope})
  `;

  return {
    success: true,
    sessionToken: token,
    expiresAt: exp,
    user: {
      id: u.id, username: u.username, full_name: u.full_name,
      email: u.email, role: u.role, clinic_id: u.clinic_id, access_scope: u.access_scope,
    },
    features: await getFeatures(u.clinic_id),
  };
}

/** Valida un token de sesión y devuelve los datos del usuario */
async function verifySession(token) {
  if (!token) return { valid: false, error: 'Token no proporcionado' };
  try {
    const r = await sql`
      SELECT s.username, s.expires_at, s.role, s.clinic_id, s.access_scope, s.clinic_user_id,
             cu.full_name, cu.email, c.name as clinic_name, c.slug as clinic_slug
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
    return {
      valid: true,
      user: {
        id: s.clinic_user_id, username: s.username, full_name: s.full_name,
        email: s.email, role: s.role || 'clinic_admin', clinic_id: s.clinic_id,
        clinic_name: s.clinic_name, clinic_slug: s.clinic_slug, access_scope: s.access_scope || 'all',
      },
      expiresAt: s.expires_at,
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
               cu.is_active, cu.last_login, cu.clinic_id, c.name as clinic_name
        FROM clinic_users cu LEFT JOIN clinics c ON cu.clinic_id = c.id
        WHERE cu.clinic_id = ${clinicIdFilter}
        ORDER BY cu.role, cu.username
      `).rows;
    }
    return (await sql`
      SELECT cu.id, cu.username, cu.full_name, cu.email, cu.role, cu.access_scope,
             cu.is_active, cu.last_login, cu.clinic_id, c.name as clinic_name
      FROM clinic_users cu LEFT JOIN clinics c ON cu.clinic_id = c.id
      ORDER BY c.name NULLS LAST, cu.role, cu.username
    `).rows;
  }
  // clinic_admin: solo su clínica
  return (await sql`
    SELECT id, username, full_name, email, role, access_scope, is_active, last_login, clinic_id
    FROM clinic_users WHERE clinic_id = ${requestUser.clinic_id}
    ORDER BY role, username
  `).rows;
}

async function createUser(requestUser, body) {
  const { username, password, full_name, email, role, access_scope, clinic_id } = body;
  if (!username?.trim() || !password?.trim() || !role)
    return { error: 'username, password y role son requeridos' };
  if (password.length < 6)
    return { error: 'La contraseña debe tener al menos 6 caracteres' };
  if (requestUser.role === 'clinic_admin' && !['clinic_admin', 'clinic_user'].includes(role))
    return { error: 'Solo puedes crear usuarios de tipo clinic_admin o clinic_user' };

  const targetClinicId = requestUser.role === 'master_admin'
    ? (role === 'master_admin' ? null : (clinic_id ?? null))
    : requestUser.clinic_id;

  const { hash, salt } = hashPassword(password);
  try {
    const r = await sql`
      INSERT INTO clinic_users
        (clinic_id, username, password_hash, salt, hash_algo, full_name, email, role, access_scope)
      VALUES
        (${targetClinicId}, ${username.trim()}, ${hash}, ${salt}, 'pbkdf2',
         ${full_name || null}, ${email || null}, ${role}, ${access_scope || 'own'})
      RETURNING id, username, full_name, email, role, access_scope, clinic_id, is_active
    `;
    return { success: true, user: r.rows[0] };
  } catch (e) {
    if (e.message?.includes('unique') || e.message?.includes('duplicate'))
      return { error: 'El nombre de usuario ya existe' };
    throw e;
  }
}

async function updateUser(requestUser, body) {
  const { id, full_name, email, role, access_scope, is_active } = body;
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
      full_name    = COALESCE(${full_name    ?? null}, full_name),
      email        = COALESCE(${email        ?? null}, email),
      access_scope = COALESCE(${access_scope ?? null}, access_scope),
      is_active    = COALESCE(${is_active    ?? null}, is_active)
    WHERE id = ${id}
  `;
  if (requestUser.role === 'master_admin' && role != null) {
    await sql`UPDATE clinic_users SET role = ${role} WHERE id = ${id}`;
  }

  const updated = await sql`
    SELECT id, username, full_name, email, role, access_scope, is_active, clinic_id
    FROM clinic_users WHERE id = ${id}
  `;
  return { success: true, user: updated.rows[0] };
}

async function resetPassword(requestUser, body) {
  const { id, newPassword } = body;
  if (!id || !newPassword) return { error: 'id y newPassword son requeridos' };
  if (newPassword.length < 6) return { error: 'Mínimo 6 caracteres' };

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
  await sql`UPDATE clinic_users SET is_active = false WHERE id = ${userId}`;
  await sql`UPDATE admin_sessions SET is_active = false WHERE clinic_user_id = ${userId}`;
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gestión de clínicas (solo master_admin)
// ─────────────────────────────────────────────────────────────────────────────

async function listClinics() {
  return (await sql`
    SELECT c.*,
           COUNT(DISTINCT cu.id) FILTER (WHERE cu.is_active = true)::int AS user_count,
           0::int AS patient_count
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
  // CORS — en producción, limitar origin al dominio del admin
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-setup-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

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

    // ── Login ──────────────────────────────────────────────────────────────
    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username?.trim() || !password?.trim())
        return res.status(400).json({ success: false, error: 'Usuario y contraseña son requeridos' });
      const ip     = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
      const ua     = req.headers['user-agent'] || '';
      const result = await loginUser(username.trim(), password.trim(), ip, ua);
      return res.status(result.success ? 200 : 401).json(result);
    }

    // ── Verificar sesión ───────────────────────────────────────────────────
    if (action === 'verify') {
      const token  = (req.headers.authorization || '').replace('Bearer ', '').trim()
                     || req.query.token || req.body?.sessionToken;
      const result = await verifySession(token);
      if (result.valid) result.features = await getFeatures(result.user.clinic_id);
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
      const r = await sql`UPDATE admin_sessions SET is_active = false WHERE expires_at < NOW() AND is_active = true`;
      return res.status(200).json({ success: true, count: r.rowCount });
    }

    // ── Acciones autenticadas ──────────────────────────────────────────────
    const user = await getRequestUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'No autenticado o sesión expirada' });

    // Gestión de usuarios
    if (action === 'listUsers') {
      if (!requireRole(user, 'master_admin', 'clinic_admin')) return res.status(403).json({ error: 'Sin permiso' });
      const clinicIdFilter = req.query.clinicId ? parseInt(req.query.clinicId) : null;
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
      if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const u = await sql`SELECT password_hash, salt, hash_algo FROM clinic_users WHERE id = ${user.id}`;
      if (!u.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
      const row = u.rows[0];
      if (!verifyPassword(currentPassword, row.password_hash, row.salt, row.hash_algo))
        return res.status(401).json({ error: 'Contraseña actual incorrecta' });
      const { hash, salt } = hashPassword(newPassword);
      await sql`UPDATE clinic_users SET password_hash = ${hash}, salt = ${salt}, hash_algo = 'pbkdf2' WHERE id = ${user.id}`;
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
      if (!requireRole(user, 'master_admin')) return res.status(403).json({ error: 'Solo master_admin' });
      const { clinicId } = req.body || {};
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
      if (!clientId) return res.status(503).json({ error: 'GOOGLE_CLIENT_ID no configurado' });
      const redirectUri = `https://${(process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app').trim()}/api/calendar`;
      const state = Buffer.from(JSON.stringify({ clinicId, ts: Date.now() })).toString('base64url');
      // URLSearchParams codifica correctamente sin double-encoding
      const params = new URLSearchParams({
        response_type: 'code',
        client_id:     clientId,
        redirect_uri:  redirectUri,
        scope:         'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send openid email profile',
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

    // ── Configuración por clínica ─────────────────────────────────────────
    const DEFAULT_TREATMENTS = [
      'Consulta + Escáner Facial','Botox / Toxina Botulínica','Relleno de Labios',
      'Relleno de Ojeras','Relleno de Pómulos','Limpieza Facial Profunda',
      'Peeling Químico','Mesoterapia Facial','Láser CO2 Fraccionado',
      'Radiofrecuencia','Hidratación Profunda','Depilación Láser',
      'Tratamiento Anti-Acné','Carboxiterapia','Otro'
    ];

    if (action === 'getClinicSettings') {
      const clinicId = req.query.clinicId || req.body?.clinicId;
      if (!clinicId) return res.status(400).json({ error: 'clinicId requerido' });
      // master_admin puede ver cualquier clínica; clinic_admin solo la suya
      if (user.role !== 'master_admin' && parseInt(clinicId) !== user.clinic_id)
        return res.status(403).json({ error: 'Sin permiso' });

      const r = await sql`SELECT * FROM clinic_settings WHERE clinic_id = ${clinicId}`;
      if (!r.rows.length) {
        // Crear con defaults si no existe
        const clinicR = await sql`SELECT name, email, phone, address FROM clinics WHERE id = ${clinicId}`;
        const clinic  = clinicR.rows[0] || {};
        const defaults = {
          general:    { name: clinic.name || '', city: '', tagline: '', logo_url: '', phone: clinic.phone || '', address: clinic.address || '', tax_id: '' },
          treatments: DEFAULT_TREATMENTS,
          email:      { staff_email: clinic.email || '', from_name: clinic.name || '', signature: `El equipo de ${clinic.name || 'la clínica'}`, whatsapp_number: '' },
          agenda:     { start_hour: '08:00', end_hour: '19:00', slot_minutes: 60, calendar_prefix: clinic.name || 'CLINICA' }
        };
        await sql`INSERT INTO clinic_settings (clinic_id, general, treatments, email, agenda) VALUES (${clinicId}, ${JSON.stringify(defaults.general)}, ${JSON.stringify(defaults.treatments)}, ${JSON.stringify(defaults.email)}, ${JSON.stringify(defaults.agenda)})`;
        return res.status(200).json({ success: true, settings: defaults });
      }
      const s = r.rows[0];
      return res.status(200).json({ success: true, settings: { general: s.general, treatments: s.treatments, email: s.email, agenda: s.agenda } });
    }

    if (action === 'saveClinicSettings') {
      const { clinicId, section, data } = req.body || {};
      if (!clinicId || !section || !data) return res.status(400).json({ error: 'clinicId, section y data son requeridos' });
      if (!['general','treatments','email','agenda'].includes(section))
        return res.status(400).json({ error: 'section inválida' });
      if (user.role !== 'master_admin' && parseInt(clinicId) !== user.clinic_id)
        return res.status(403).json({ error: 'Sin permiso' });

      const dataStr = JSON.stringify(data);
      // Upsert seguro — columna determinada por whitelist, no por input directo
      if (section === 'general')
        await sql`INSERT INTO clinic_settings (clinic_id, general, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET general = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'treatments')
        await sql`INSERT INTO clinic_settings (clinic_id, treatments, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET treatments = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'email')
        await sql`INSERT INTO clinic_settings (clinic_id, email, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET email = ${dataStr}::jsonb, updated_at = NOW()`;
      else if (section === 'agenda')
        await sql`INSERT INTO clinic_settings (clinic_id, agenda, updated_at) VALUES (${clinicId}, ${dataStr}::jsonb, NOW()) ON CONFLICT (clinic_id) DO UPDATE SET agenda = ${dataStr}::jsonb, updated_at = NOW()`;

      return res.status(200).json({ success: true, message: `${section} guardado` });
    }

    return res.status(400).json({ success: false, error: 'Acción no válida' });

  } catch (error) {
    console.error('❌ Error en admin-auth:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
}
