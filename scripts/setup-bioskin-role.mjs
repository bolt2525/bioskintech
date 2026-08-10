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

const appPassword = process.env.BIOSKIN_APP_PASSWORD;
if (!appPassword) { console.error('❌ BIOSKIN_APP_PASSWORD no definida'); process.exit(1); }

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
  'prescriptions',
  'injectables',
  'consent_forms',
  'medical_history_snapshots',
  'inventory_items',
  'inventory_batches',
  'inventory_movements',
  'financial_records',
  'financial_items',
  'sharing_groups',
  'patient_audit_log',
  'clinical_photos',
];

// Tablas sin RLS (auth o globales — accesibles por neondb_owner)
// clinics, clinic_users, admin_sessions, clinic_features, etc.

async function run() {
  const client = await pool.connect();
  try {
    // ── Crear rol si no existe ───────────────────────────────────────────
    const exists = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'bioskin_app'`
    );
    if (!exists.rows.length) {
      // El password se escapa manualmente porque pg no soporta bind params en DDL
      const safePw = appPassword.replace(/'/g, "''");
      await client.query(`CREATE ROLE bioskin_app WITH LOGIN PASSWORD '${safePw}'`);
      console.log('✅ Rol bioskin_app creado');
    } else {
      console.log('ℹ️  Rol bioskin_app ya existe — actualizando políticas');
    }

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
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bioskin_app`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bioskin_app`);
    console.log('✅ Grants de tabla otorgados a bioskin_app');

    console.log('\n🎉 Setup completado. Agrega NEON_APP_URL a Vercel con las credenciales de bioskin_app.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
