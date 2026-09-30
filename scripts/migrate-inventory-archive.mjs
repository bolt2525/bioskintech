import pg from 'pg';

const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('NEON_DATABASE_URL o POSTGRES_URL es requerida');

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false');
  await client.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  await client.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS archived_by_user_id INTEGER');
  await client.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(300)');
  await client.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ');
  await client.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS restored_by_user_id INTEGER');
  await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_items_archived_clinic
    ON inventory_items(clinic_id, name) WHERE is_archived = true`);
  const columns = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items'
      AND column_name = ANY($1::text[])
  `, [['is_archived', 'archived_at', 'archived_by_user_id', 'archive_reason', 'restored_at', 'restored_by_user_id']]);
  if (columns.rows.length !== 6) throw new Error('Columnas de archivado incompletas');
  await client.query('COMMIT');
  console.log('Archivado de inventario preparado: 6 columnas verificadas; productos existentes conservan estado activo.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}