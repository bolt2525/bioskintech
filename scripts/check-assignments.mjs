import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL);

// Check patient_assignments table
const pa = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='patient_assignments' ORDER BY ordinal_position`;
console.log('patient_assignments columns:'); console.table(pa);

// Check clinical_records constraints
const cr = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='clinical_records' ORDER BY ordinal_position`;
console.log('clinical_records columns:'); console.table(cr);
