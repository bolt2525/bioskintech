import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL);

const cols = await sql`
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_name IN ('patients','clinical_records','consultations','treatments','injectables','prescriptions')
  ORDER BY table_name, ordinal_position
`;
console.table(cols.map(r => ({ t: r.table_name, col: r.column_name, type: r.data_type })));
