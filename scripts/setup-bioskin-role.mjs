/**
 * Crea el rol limitado `bioskin_app` en Neon y configura RLS en todas las tablas clínicas.
 * Ejecutar UNA VEZ como neondb_owner DESPUÉS de que initClinicalDatabase() haya corrido.
 *
 * Uso: BIOSKIN_APP_PASSWORD=<password_seguro> node scripts/setup-bioskin-role.mjs
 *
 * Si bioskin_app ya existe, el script actualiza políticas sin recrear el rol.
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const url = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!url) { console.error('❌ NEON_DATABASE_URL / POSTGRES_URL no definida'); process.exit(1); }

// Solo se necesita al crear el rol; re-ejecutar para actualizar políticas y grants no lo exige.
const appPassword = process.env.BIOSKIN_APP_PASSWORD;

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

// Tablas clínicas con clinic_id UUID — reciben RLS
const TENANT_TABLES = [
  'patients',
  'clinical_records',
  'consultations',
  'consultation_history',
  'consultation_info',
  'medical_history',
  'physical_exams',
  'diagnoses',
  'treatments',
  'treatment_packages',
  'prescriptions',
  'injectables',
  'consent_forms',
  'medical_history_snapshots',
  'inventory_items',
  'inventory_groups',
  'inventory_batches',
  'inventory_movements',
  'financial_records',
  'financial_items',
  'external_finance_records',
  'sharing_groups',
  'patient_audit_log',
  'clinical_photos',
  // Migradas a tenant el 2026-09-30 por scripts/migrate-tenant-shared-tables.mjs
  'patient_assignments',
  'sharing_group_members',
  'professional_signatures',
  'prescription_templates',
];

// Sin clinic_id y compartidas a propósito. Vacío hoy: todo lo que tenía datos de clínica
// se migró a TENANT_TABLES; `injectable_catalog` es un catálogo global de solo lectura.
const SHARED_RW_TABLES = [];

// Solo lectura: el camino clínico las consulta, pero nunca las escribe (eso pasa por neondb_owner).
const READONLY_TABLES = [
  'clinic_settings',
  'user_module_overrides',
  'injectable_catalog',
];

// `clinic_users` se concede por columna: el rol necesita identificar autores y permisos,
// pero nunca debe poder leer credenciales. Sin esto, una inyección en cualquier consulta
// clínica (que corre como bioskin_app) alcanzaba password_hash, salt y tokens de cambio.
const CLINIC_USERS_READABLE = [
  'id', 'clinic_id', 'username', 'full_name', 'first_name', 'last_name', 'gentilicio',
  'email', 'role', 'access_scope', 'finance_scope', 'inventory_scope', 'calendar_scope',
  'is_active', 'created_at', 'last_login', 'profession', 'especialidad', 'cedula_profesional',
  'matricula_senescyt', 'registro_acess', 'avatar_url', 'phone', 'is_demo', 'demo_expires_at',
  'multi_resource_enabled', 'public_booking_enabled',
];

// Nunca deben quedar al alcance de bioskin_app: si aparecen con permisos, el setup falla.
const FORBIDDEN_TABLES = [
  'admin_sessions', 'clinic_oauth_tokens', 'login_otp', 'password_setup_tokens',
  'trusted_devices', 'registration_codes', 'invite_links', 'oauth_states',
  'subscriptions', 'clinics', 'clinic_features', 'clinic_notifications',
  'consent_templates', 'clinic_consent_templates', 'legal_acceptances',
  'whatsapp_messages', 'whatsapp_contacts', 'whatsapp_bot_state', 'wa_short_links',
];

async function run() {
  const client = await pool.connect();
  try {
    // ── Crear rol si no existe ───────────────────────────────────────────
    const exists = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'bioskin_app'`
    );
    if (!exists.rows.length) {
      if (!appPassword) { console.error('❌ BIOSKIN_APP_PASSWORD es requerida para crear el rol'); process.exit(1); }
      // El password se escapa manualmente porque pg no soporta bind params en DDL
      const safePw = appPassword.replace(/'/g, "''");
      await client.query(`CREATE ROLE bioskin_app WITH LOGIN PASSWORD '${safePw}'`);
      console.log('✅ Rol bioskin_app creado');
    } else {
      console.log('ℹ️  Rol bioskin_app ya existe — actualizando políticas y grants');
    }

    // ── Esquema real ────────────────────────────────────────────────
    // Los grants se calculan contra lo que existe, no contra lo que el script asume.
    const existingTables = new Set((await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    )).rows.map(r => r.table_name));
    const clinicUserColumns = new Set((await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'clinic_users'`
    )).rows.map(r => r.column_name));

    // ── Permisos de conexión ─────────────────────────────────────────────
    const dbName = new URL(url.replace('postgres://', 'http://')).pathname.slice(1);
    await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO bioskin_app`);
    await client.query(`GRANT USAGE ON SCHEMA public TO bioskin_app`);
    console.log('✅ Permisos de conexión otorgados');

    // ── RLS en tablas clínicas ───────────────────────────────────────────
    // ponytail: la expresión de tenant usa NULLIF para que string vacío = sin acceso
    const tenantExpr = `clinic_id = NULLIF(current_setting('app.current_tenant', true),'')::uuid`;

    for (const table of TENANT_TABLES) {
      // Verificar que la tabla existe
      const tableExists = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [table]
      );
      if (!tableExists.rows.length) {
        console.warn(`  ⚠ ${table}: no existe aún — omitiendo`);
        continue;
      }

      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);

      // Recrear políticas (DROP IF EXISTS + CREATE para idempotencia)
      for (const policy of ['p_select', 'p_insert', 'p_update', 'p_delete']) {
        await client.query(`DROP POLICY IF EXISTS ${policy} ON ${table}`);
      }

      await client.query(`CREATE POLICY p_select ON ${table} FOR SELECT TO bioskin_app USING (${tenantExpr})`);
      await client.query(`CREATE POLICY p_insert ON ${table} FOR INSERT TO bioskin_app WITH CHECK (${tenantExpr})`);
      await client.query(`CREATE POLICY p_update ON ${table} FOR UPDATE TO bioskin_app USING (${tenantExpr}) WITH CHECK (${tenantExpr})`);
      await client.query(`CREATE POLICY p_delete ON ${table} FOR DELETE TO bioskin_app USING (${tenantExpr})`);

      console.log(`  ✅ RLS configurado: ${table}`);
    }

    // ── Grants de tabla ──────────────────────────────────────────────────
    // Antes: `GRANT ... ON ALL TABLES IN SCHEMA public`. Ese grant en bloque le daba a bioskin_app
    // DML completo sobre admin_sessions, clinic_oauth_tokens, login_otp y clinic_users — es decir,
    // tokens de sesión, tokens de Google y hashes de contraseña de todas las clínicas. Eso anulaba
    // el propósito del rol limitado: una inyección en el camino clínico escalaba a toda la app.
    // Ahora se revoca todo y se concede solo lo que el camino clínico usa de verdad.
    await client.query('BEGIN');
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bioskin_app`);

    const writable = [...TENANT_TABLES, ...SHARED_RW_TABLES].filter(t => existingTables.has(t));
    for (const table of writable) {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO bioskin_app`);
    }
    for (const table of READONLY_TABLES.filter(t => existingTables.has(t))) {
      await client.query(`GRANT SELECT ON ${table} TO bioskin_app`);
    }
    if (existingTables.has('clinic_users')) {
      const cols = CLINIC_USERS_READABLE.filter(c => clinicUserColumns.has(c));
      await client.query(`GRANT SELECT (${cols.join(', ')}) ON clinic_users TO bioskin_app`);
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bioskin_app`);
    await client.query('COMMIT');
    console.log(`✅ Grants mínimos aplicados: ${writable.length} tablas con DML, ${READONLY_TABLES.length} de solo lectura, clinic_users por columna`);

    // ── Verificación: el rol no debe alcanzar credenciales ni sesiones ────
    const leaks = await client.query(`
      SELECT table_name, string_agg(DISTINCT privilege_type, ', ') AS permisos
      FROM information_schema.role_table_grants
      WHERE grantee = 'bioskin_app' AND table_name = ANY($1)
      GROUP BY table_name`, [FORBIDDEN_TABLES]);
    if (leaks.rows.length) {
      console.error('❌ El rol conserva acceso a tablas sensibles:', leaks.rows);
      process.exitCode = 1;
    } else {
      console.log('✅ Verificado: bioskin_app no tiene acceso a sesiones, credenciales ni tokens OAuth');
    }

    console.log('\n🎉 Setup completado. Agrega NEON_APP_URL a Vercel con las credenciales de bioskin_app.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
