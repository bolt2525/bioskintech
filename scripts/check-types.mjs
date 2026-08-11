import { neon } from '@neondatabase/serverless';

const url = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!url) { console.error('No DB URL found'); process.exit(1); }

const sql = neon(url);
const rows = await sql`
  SELECT table_name, column_name, data_type, udt_name
  FROM information_schema.columns
  WHERE table_name IN ('clinics','invite_links','clinic_users','admin_sessions')
    AND column_name IN ('id','clinic_id')
  ORDER BY table_name, column_name
`;
console.table(rows.map(r => ({
  table: r.table_name,
  column: r.column_name,
  data_type: r.data_type,
  udt: r.udt_name,
})));
