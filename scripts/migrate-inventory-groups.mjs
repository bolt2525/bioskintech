import pg from 'pg';

const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('NEON_DATABASE_URL o POSTGRES_URL es requerida');

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(`
    CREATE TABLE IF NOT EXISTS inventory_groups (
      id SERIAL PRIMARY KEY,
      clinic_id UUID NOT NULL,
      category VARCHAR(100) NOT NULL,
      name VARCHAR(100) NOT NULL,
      name_key VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (clinic_id, category, name_key)
    )
  `);
  const existing = await client.query(`
    SELECT DISTINCT clinic_id, COALESCE(TRIM(category), '') AS category, group_name
    FROM inventory_items
    WHERE clinic_id IS NOT NULL AND NULLIF(TRIM(group_name), '') IS NOT NULL
    ORDER BY clinic_id, category, group_name
  `);
  for (const row of existing.rows) {
    const name = row.group_name.trim().replace(/\s+/g, ' ');
    const nameKey = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
    await client.query(`
      INSERT INTO inventory_groups (clinic_id, category, name, name_key)
      VALUES ($1, $2, $3, $4) ON CONFLICT (clinic_id, category, name_key) DO NOTHING
    `, [row.clinic_id, row.category, name, nameKey]);
  }
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'bioskin_app'");
  if (!role.rows.length) throw new Error('Falta el rol bioskin_app; aplicar setup-bioskin-role primero');
  await client.query('ALTER TABLE inventory_groups ENABLE ROW LEVEL SECURITY');
  await client.query('ALTER TABLE inventory_groups FORCE ROW LEVEL SECURITY');
  for (const policy of ['p_select', 'p_insert', 'p_update', 'p_delete']) {
    await client.query(`DROP POLICY IF EXISTS ${policy} ON inventory_groups`);
  }
  const tenant = "clinic_id = NULLIF(current_setting('app.current_tenant', true),'')::uuid";
  await client.query(`CREATE POLICY p_select ON inventory_groups FOR SELECT TO bioskin_app USING (${tenant})`);
  await client.query(`CREATE POLICY p_insert ON inventory_groups FOR INSERT TO bioskin_app WITH CHECK (${tenant})`);
  await client.query(`CREATE POLICY p_update ON inventory_groups FOR UPDATE TO bioskin_app USING (${tenant}) WITH CHECK (${tenant})`);
  await client.query(`CREATE POLICY p_delete ON inventory_groups FOR DELETE TO bioskin_app USING (${tenant})`);
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_groups TO bioskin_app');
  await client.query('GRANT USAGE, SELECT ON SEQUENCE inventory_groups_id_seq TO bioskin_app');
  const count = await client.query('SELECT COUNT(*)::int AS total FROM inventory_groups');
  const sampleClinic = await client.query('SELECT clinic_id FROM inventory_groups LIMIT 1');
  await client.query('COMMIT');
  console.log(`Catálogo de grupos migrado: ${count.rows[0].total} subcategorías; RLS y permisos aplicados.`);

  if (process.env.NEON_APP_URL && sampleClinic.rows.length) {
    const appPool = new pg.Pool({ connectionString: process.env.NEON_APP_URL });
    let appClient;
    try {
      appClient = await appPool.connect();
      const withoutTenant = await appClient.query('SELECT COUNT(*)::int AS total FROM inventory_groups');
      await appClient.query('BEGIN');
      await appClient.query("SELECT set_config('app.current_tenant', $1, true)", [sampleClinic.rows[0].clinic_id]);
      const withTenant = await appClient.query('SELECT COUNT(*)::int AS total FROM inventory_groups');
      const existingGroup = await appClient.query('SELECT category, name, name_key FROM inventory_groups LIMIT 1');
      const group = existingGroup.rows[0];
      const writable = await appClient.query(`
        INSERT INTO inventory_groups (clinic_id, category, name, name_key)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (clinic_id, category, name_key) DO UPDATE SET name = inventory_groups.name
        RETURNING name
      `, [sampleClinic.rows[0].clinic_id, group.category, group.name, group.name_key]);
      await appClient.query('ROLLBACK');
      if (withoutTenant.rows[0].total !== 0 || withTenant.rows[0].total < 1) {
        throw new Error('Aislamiento RLS de inventory_groups no verificado');
      }
      if (writable.rows[0]?.name !== group.name) throw new Error('Escritura de grupos por bioskin_app no verificada');
      console.log(`RLS verificado: sin clínica 0 filas; con clínica ${withTenant.rows[0].total} filas. Upsert transaccional verificado y revertido.`);
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