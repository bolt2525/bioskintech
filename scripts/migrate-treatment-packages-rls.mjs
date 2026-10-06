// Habilita RLS y otorga permisos a bioskin_app sobre treatment_packages.
// La tabla fue creada por neondb_owner (initClinicalDatabase) sin RLS ni GRANT,
// por lo que las queries de la app (api/records.js vía getAppPool) fallaban con
// "permission denied for table treatment_packages".
import pg from 'pg';

const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('NEON_DATABASE_URL o POSTGRES_URL es requerida');

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'bioskin_app'");
  if (!role.rows.length) throw new Error('Falta el rol bioskin_app; aplicar setup-bioskin-role primero');

  await client.query('ALTER TABLE treatment_packages ENABLE ROW LEVEL SECURITY');
  await client.query('ALTER TABLE treatment_packages FORCE ROW LEVEL SECURITY');
  for (const policy of ['p_select', 'p_insert', 'p_update', 'p_delete']) {
    await client.query(`DROP POLICY IF EXISTS ${policy} ON treatment_packages`);
  }
  const tenant = "clinic_id = NULLIF(current_setting('app.current_tenant', true),'')::uuid";
  await client.query(`CREATE POLICY p_select ON treatment_packages FOR SELECT TO bioskin_app USING (${tenant})`);
  await client.query(`CREATE POLICY p_insert ON treatment_packages FOR INSERT TO bioskin_app WITH CHECK (${tenant})`);
  await client.query(`CREATE POLICY p_update ON treatment_packages FOR UPDATE TO bioskin_app USING (${tenant}) WITH CHECK (${tenant})`);
  await client.query(`CREATE POLICY p_delete ON treatment_packages FOR DELETE TO bioskin_app USING (${tenant})`);
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON treatment_packages TO bioskin_app');
  await client.query('GRANT USAGE, SELECT ON SEQUENCE treatment_packages_id_seq TO bioskin_app');

  const count = await client.query('SELECT COUNT(*)::int AS total FROM treatment_packages');
  await client.query('COMMIT');
  console.log(`treatment_packages: RLS y permisos aplicados. Filas existentes: ${count.rows[0].total}.`);

  if (process.env.NEON_APP_URL) {
    const appPool = new pg.Pool({ connectionString: process.env.NEON_APP_URL });
    let appClient;
    try {
      appClient = await appPool.connect();
      const withoutTenant = await appClient.query('SELECT COUNT(*)::int AS total FROM treatment_packages');
      if (withoutTenant.rows[0].total !== 0) {
        throw new Error('Aislamiento RLS de treatment_packages no verificado (filas visibles sin tenant)');
      }
      console.log('RLS verificado: sin clínica configurada, bioskin_app ve 0 filas (como se espera).');
    } finally {
      appClient?.release();
      await appPool.end();
    }
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
