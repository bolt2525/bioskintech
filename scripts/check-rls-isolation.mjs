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
      for (const table of ['patients', 'consent_forms', 'professional_signatures', 'prescription_templates',
        'patient_assignments', 'sharing_group_members']) {
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
    for (const table of ['patients', 'consent_forms', 'professional_signatures', 'prescription_templates',
      'patient_assignments', 'sharing_group_members']) {
      const result = await client.query(`SELECT clinic_id FROM ${table} LIMIT 100`);
      if (result.rows.length) throw new Error(`RLS devolvió filas de ${table} sin contexto tenant`);
      console.log(`PASS: ${table} sin contexto tenant no devuelve filas`);
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  // El rol clínico no debe poder escalar: una inyección en cualquier consulta clínica corre
  // con estos permisos, así que sesiones, credenciales y tokens OAuth deben estar fuera de alcance.
  const escalation = await app.connect();
  try {
    for (const table of ['admin_sessions', 'clinic_oauth_tokens', 'login_otp', 'password_setup_tokens',
      'trusted_devices', 'invite_links', 'registration_codes', 'clinics', 'clinic_features',
      'whatsapp_messages', 'whatsapp_contacts']) {
      await assertDenied(escalation, `SELECT 1 FROM ${table} LIMIT 1`, table);
    }
    await assertDenied(escalation, 'SELECT password_hash FROM clinic_users LIMIT 1', 'clinic_users.password_hash');
    await assertDenied(escalation, 'SELECT salt FROM clinic_users LIMIT 1', 'clinic_users.salt');
    await assertDenied(escalation, "UPDATE clinic_users SET role = 'master_admin'", 'clinic_users UPDATE');
    // El catálogo de inyectables es global: se lee, pero solo master_admin lo edita vía neondb_owner.
    await assertDenied(escalation, "UPDATE injectable_catalog SET activo = 0", 'injectable_catalog UPDATE');

    // Lo que el camino clínico sí necesita debe seguir funcionando.
    await escalation.query('SELECT id, full_name, role, access_scope FROM clinic_users LIMIT 1');
    console.log('PASS: clinic_users sigue legible en columnas no sensibles');
    for (const table of ['patient_assignments', 'sharing_group_members', 'clinic_settings',
      'user_module_overrides', 'prescription_templates', 'professional_signatures', 'injectable_catalog']) {
      await escalation.query(`SELECT 1 FROM ${table} LIMIT 1`);
      console.log(`PASS: ${table} sigue accesible para el camino clínico`);
    }
  } finally {
    escalation.release();
  }
} finally {
  await owner.end();
  await app.end();
}

async function assertDenied(client, query, label) {
  try {
    await client.query(query);
  } catch (err) {
    if (!/permission denied/i.test(err.message)) throw err;
    console.log(`PASS: bioskin_app no alcanza ${label}`);
    return;
  }
  throw new Error(`ESCALAMIENTO: bioskin_app pudo ejecutar "${label}"`);
}

function assertTenant(rows, tenantId) {
  for (const row of rows) {
    if (String(row.clinic_id) !== String(tenantId)) {
      throw new Error(`Fuga cross-tenant detectada: ${row.clinic_id} != ${tenantId}`);
    }
  }
}
