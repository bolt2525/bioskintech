import pg from 'pg';

const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('NEON_DATABASE_URL o POSTGRES_URL es requerida');

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_sale_price NUMERIC(12,2)');
  await client.query('ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS sale_total NUMERIC(14,2)');
  await client.query('ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS cost_total NUMERIC(14,2)');
  await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_sales_clinic_date
    ON inventory_movements(clinic_id, created_at DESC) WHERE sale_total IS NOT NULL`);
  const columns = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_movements'
      AND column_name IN ('unit_sale_price', 'sale_total', 'cost_total')
  `);
  if (columns.rows.length !== 3) throw new Error('Columnas de ventas incompletas');
  await client.query('COMMIT');
  console.log('Historial de ventas preparado: 3 columnas verificadas; movimientos anteriores sin precio no se alteraron.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}