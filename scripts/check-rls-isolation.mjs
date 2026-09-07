import { Pool } from '@neondatabase/serverless';

const ownerUrl = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
const appUrl = process.env.NEON_APP_URL;
if (!ownerUrl || !appUrl) { console.error('NEON_DATABASE_URL/POSTGRES_URL y NEON_APP_URL son requeridas'); process.exit(1); }

const owner = new Pool({ connectionString: ownerUrl });
const app = new Pool({ connectionString: appUrl });

try {
  const clinics = await owner.query('SELECT id FROM clinics ORDER BY id LIMIT 2');
  if (!clinics.rows.length) throw new Error('No hay clínicas para probar RLS');

  for (const { id } of clinics.rows) {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [String(id)]);
      const result = await client.query('SELECT clinic_id FROM patients LIMIT 100');
      assertTenant(result.rows, id);
      await client.query('ROLLBACK');
      console.log(`PASS: tenant ${id} solo ve ${result.rows.length} filas propias`);
    } finally {
      client.release();
    }
  }

  const client = await app.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT clinic_id FROM patients LIMIT 100');
    if (result.rows.length) throw new Error('RLS devolvió filas sin contexto tenant');
    await client.query('ROLLBACK');
    console.log('PASS: sin contexto tenant no hay filas clínicas');
  } finally {
    client.release();
  }
} finally {
  await owner.end();
  await app.end();
}

function assertTenant(rows, tenantId) {
  for (const row of rows) {
    if (String(row.clinic_id) !== String(tenantId)) {
      throw new Error(`Fuga cross-tenant detectada: ${row.clinic_id} != ${tenantId}`);
    }
  }
}
