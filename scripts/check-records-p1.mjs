import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL);
const r = await sql`
  SELECT cr.id, cr.patient_id, cr.created_by_user_id, cr.status, cr.created_at, cu.username
  FROM clinical_records cr
  LEFT JOIN clinic_users cu ON cu.id = cr.created_by_user_id
  WHERE cr.patient_id = 1
  ORDER BY cr.created_at
`;
console.table(r);
