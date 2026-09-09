import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

const { rows } = await pool.query(`
  SELECT id, record_id, consultation_id, procedure_name, equipment_used, parameters, cost, duration_minutes,
         length(notes) as notes_len, length(equipment_used) as equip_len
  FROM treatments
  ORDER BY id DESC
  LIMIT 10
`);
console.log(JSON.stringify(rows, null, 2));
await pool.end();
