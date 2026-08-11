import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL);

console.log('--- admin_sessions column types ---');
const types = await sql`
  SELECT column_name, data_type, udt_name
  FROM information_schema.columns
  WHERE table_name = 'admin_sessions'
  ORDER BY ordinal_position
`;
console.table(types.map(r => ({ col: r.column_name, type: r.data_type })));

console.log('--- Active sessions with clinic_id ---');
const sessions = await sql`
  SELECT clinic_id, role, username,
         pg_typeof(clinic_id) as typeof_clinic_id,
         expires_at
  FROM admin_sessions
  WHERE is_active = true AND clinic_id IS NOT NULL
  ORDER BY expires_at DESC
  LIMIT 10
`;
console.table(sessions);

console.log('--- Clinics sample ---');
const clinics = await sql`SELECT id, name, pg_typeof(id) as typeof_id FROM clinics LIMIT 5`;
console.table(clinics);
