import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL);

await sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS tipo_sangre VARCHAR(10)`;
await sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS estado_civil VARCHAR(30)`;
console.log('Migration OK: tipo_sangre + estado_civil added to patients');
