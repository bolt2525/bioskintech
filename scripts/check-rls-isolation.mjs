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
      for (const table of ['patients', 'consent_forms']) {
        const result = await client.query(`SELECT clinic_id FROM ${table} LIMIT 100`);
        assertTenant(result.rows, id);
        console.log(`PASS: ${table} tenant ${id} solo ve ${result.rows.length} filas propias`);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }

  const client = await app.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['patients', 'consent_forms']) {
      const result = await client.query(`SELECT clinic_id FROM ${table} LIMIT 100`);
      if (result.rows.length) throw new Error(`RLS devolvió filas de ${table} sin contexto tenant`);
      console.log(`PASS: ${table} sin contexto tenant no devuelve filas`);
    }
    await client.query('ROLLBACK');
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
