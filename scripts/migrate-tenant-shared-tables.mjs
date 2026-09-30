/**
 * Cierra la fuga cross-tenant de las tablas compartidas que nunca tuvieron `clinic_id`.
 *
 * Antes de esto, `professional_signatures` se indexaba solo por `professional_name`:
 * cualquier clínica podía leer la firma de un profesional de otra y, peor, registrar un
 * homónimo sobrescribía la firma ajena (el código hacía UPDATE ... WHERE professional_name = $1).
 * Lo mismo para `prescription_templates`, visible para todas las clínicas.
 *
 * Idempotente y transaccional. Ejecutar como neondb_owner:
 *   node --env-file=.env.local scripts/migrate-tenant-shared-tables.mjs [--dry-run]
 */
import pg from 'pg';

const url = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!url) { console.error('❌ NEON_DATABASE_URL / POSTGRES_URL no definida'); process.exit(1); }
const dryRun = process.argv.includes('--dry-run');

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const TENANT_EXPR = "clinic_id = NULLIF(current_setting('app.current_tenant', true),'')::uuid";

// Títulos profesionales que preceden al nombre; se quitan para emparejar con clinic_users.full_name.
const TITLE_RE = '^(dr|dra|md|lic|licda|ing|mg|msc|phd|sr|sra|srta)\\.?\\s+';

async function addTenantColumn(client, table) {
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS clinic_id UUID`);
  // El DEFAULT toma el tenant de la sesión: un INSERT del panel que olvide la columna
  // ya no crea filas huérfanas ni viola la política de RLS.
  await client.query(`ALTER TABLE ${table} ALTER COLUMN clinic_id
    SET DEFAULT NULLIF(current_setting('app.current_tenant', true),'')::uuid`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_${table}_clinic ON ${table}(clinic_id)`);
}

async function enableRls(client, table) {
  await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  for (const policy of ['p_select', 'p_insert', 'p_update', 'p_delete']) {
    await client.query(`DROP POLICY IF EXISTS ${policy} ON ${table}`);
  }
  await client.query(`CREATE POLICY p_select ON ${table} FOR SELECT TO bioskin_app USING (${TENANT_EXPR})`);
  await client.query(`CREATE POLICY p_insert ON ${table} FOR INSERT TO bioskin_app WITH CHECK (${TENANT_EXPR})`);
  await client.query(`CREATE POLICY p_update ON ${table} FOR UPDATE TO bioskin_app USING (${TENANT_EXPR}) WITH CHECK (${TENANT_EXPR})`);
  await client.query(`CREATE POLICY p_delete ON ${table} FOR DELETE TO bioskin_app USING (${TENANT_EXPR})`);
}

const client = await pool.connect();
const report = [];
try {
  await client.query('BEGIN');

  // ── 1. patient_assignments: la clínica es la del paciente asignado ──────
  await addTenantColumn(client, 'patient_assignments');
  const pa = await client.query(`
    UPDATE patient_assignments pa SET clinic_id = p.clinic_id
    FROM patients p WHERE p.id = pa.patient_id AND pa.clinic_id IS NULL AND p.clinic_id IS NOT NULL`);
  report.push(['patient_assignments', 'backfill desde patients', pa.rowCount]);

  // ── 2. sharing_group_members: la clínica es la del grupo ────────────────
  await addTenantColumn(client, 'sharing_group_members');
  const sgm = await client.query(`
    UPDATE sharing_group_members m SET clinic_id = g.clinic_id
    FROM sharing_groups g WHERE g.id = m.group_id AND m.clinic_id IS NULL`);
  report.push(['sharing_group_members', 'backfill desde sharing_groups', sgm.rowCount]);

  // ── 3. professional_signatures: emparejar el nombre con un usuario real ─
  await addTenantColumn(client, 'professional_signatures');
  const exact = await client.query(`
    UPDATE professional_signatures ps SET clinic_id = cu.clinic_id
    FROM clinic_users cu
    WHERE ps.clinic_id IS NULL AND cu.clinic_id IS NOT NULL
      AND lower(trim(ps.professional_name)) IN (
        lower(trim(concat_ws(' ', cu.gentilicio, cu.full_name))), lower(trim(cu.full_name)))`);
  report.push(['professional_signatures', 'backfill por nombre exacto', exact.rowCount]);

  // El gentilicio del usuario cambia con el tiempo ("Dra." → "Md."), dejando firmas antiguas
  // sin emparejar; el segundo paso ignora el título y compara solo el nombre.
  const fuzzy = await client.query(`
    UPDATE professional_signatures ps SET clinic_id = cu.clinic_id
    FROM clinic_users cu
    WHERE ps.clinic_id IS NULL AND cu.clinic_id IS NOT NULL
      AND regexp_replace(lower(trim(ps.professional_name)), $1, '') = lower(trim(cu.full_name))`,
    [TITLE_RE]);
  report.push(['professional_signatures', 'backfill ignorando el título', fuzzy.rowCount]);

  // La unicidad global permitía que una clínica pisara la firma de otra con un homónimo.
  await client.query('ALTER TABLE professional_signatures DROP CONSTRAINT IF EXISTS professional_signatures_professional_name_key');
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_professional_signatures_clinic_name
    ON professional_signatures(clinic_id, professional_name) WHERE clinic_id IS NOT NULL`);

  // ── 4. prescription_templates: sin columna de autor, no hay dueño derivable ─
  await addTenantColumn(client, 'prescription_templates');

  for (const table of ['patient_assignments', 'sharing_group_members', 'professional_signatures', 'prescription_templates']) {
    await enableRls(client, table);
  }

  // ── 5. injectable_catalog: catálogo global legítimo, gestionado por master_admin ─
  // Se queda sin tenant, pero el rol de aplicación pierde la escritura: las acciones
  // saveInjectableSeed/deleteInjectableSeed ya exigen master_admin y pasan por neondb_owner.
  await client.query('REVOKE INSERT, UPDATE, DELETE ON injectable_catalog FROM bioskin_app');
  await client.query('GRANT SELECT ON injectable_catalog TO bioskin_app');

  const orphans = await client.query(`
    SELECT 'professional_signatures' AS tabla, id::text, professional_name AS detalle FROM professional_signatures WHERE clinic_id IS NULL
    UNION ALL SELECT 'prescription_templates', id::text, name FROM prescription_templates WHERE clinic_id IS NULL
    UNION ALL SELECT 'patient_assignments', id::text, patient_id::text FROM patient_assignments WHERE clinic_id IS NULL
    UNION ALL SELECT 'sharing_group_members', group_id::text, clinic_user_id::text FROM sharing_group_members WHERE clinic_id IS NULL`);

  if (dryRun) { await client.query('ROLLBACK'); console.log('\n🔎 DRY RUN — sin cambios persistidos'); }
  else { await client.query('COMMIT'); console.log('\n✅ Migración aplicada'); }

  console.table(report.map(([tabla, paso, filas]) => ({ tabla, paso, filas })));

  if (orphans.rows.length) {
    console.log('\n⚠️  Filas sin clínica derivable. Quedan guardadas pero invisibles bajo RLS');
    console.log('   hasta que un master_admin les asigne clinic_id. No se borró nada:');
    console.table(orphans.rows);
  } else {
    console.log('\n✅ Todas las filas quedaron asignadas a una clínica');
  }
} catch (err) {
  await client.query('ROLLBACK');
  console.error('❌ Migración revertida:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
