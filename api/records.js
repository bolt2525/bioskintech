import pg from 'pg';
const { Pool, types } = pg;

// ── Solución real para bug de fechas -1 día ──────────────────────────────────
// El driver pg convierte DATE/TIMESTAMP a objetos JS Date en UTC.
// Al serializar a JSON quedan como "2026-05-15T00:00:00.000Z".
// En Ecuador (UTC-5) el navegador interpreta eso como el 14 a las 7 PM → día anterior.
// Solución: indicar a pg que devuelva estas columnas como strings tal como vienen de PG,
// sin conversión de zona horaria. Así el frontend siempre recibe "YYYY-MM-DD" o
// "YYYY-MM-DD HH:MM:SS" sin ambigüedad de timezone.
types.setTypeParser(1082, val => val); // DATE         → "YYYY-MM-DD"
types.setTypeParser(1114, val => val); // TIMESTAMP    → "YYYY-MM-DD HH:MM:SS"
types.setTypeParser(1184, val => val); // TIMESTAMPTZ  → "YYYY-MM-DD HH:MM:SS+00"

console.log('✅ [API] records.js loaded');

// Global flag to track initialization in the current container instance
let dbInitialized = false;
let poolInstance = null;

// Lazy migration for injectables table (runs once per container)
let injectablesMigrated = false;
async function ensureInjectablesSchema(pool) {
  if (injectablesMigrated) return;
  try {
    const migrations = [
      "ALTER TABLE injectables ADD COLUMN IF NOT EXISTS product_type VARCHAR(20) DEFAULT 'toxina'",
      "ALTER TABLE injectables ADD COLUMN IF NOT EXISTS units_used DECIMAL(6, 2)",
      "ALTER TABLE injectables ADD COLUMN IF NOT EXISTS needle_type VARCHAR(100)",
      "ALTER TABLE injectables ADD COLUMN IF NOT EXISTS mapping_data JSONB",
      "ALTER TABLE injectables ADD COLUMN IF NOT EXISTS treatment_id INTEGER REFERENCES treatments(id) ON DELETE SET NULL",
      "ALTER TABLE injectables ADD COLUMN IF NOT EXISTS dilution_volume DECIMAL(5, 2)",
      "ALTER TABLE injectables ADD COLUMN IF NOT EXISTS follow_up_date DATE"
    ];
    for (const sql of migrations) {
      try { await pool.query(sql); } catch(e) { /* column may already exist */ }
    }
    injectablesMigrated = true;
    console.log('✅ Injectables schema verified');
  } catch (e) {
    console.error('⚠️ Injectables migration warning:', e.message);
  }
}

function getPool() {
  if (poolInstance) return poolInstance;
  
  const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
  
  if (!connectionString) {
    console.error('❌ No database connection string found (checked NEON_DATABASE_URL, POSTGRES_URL)');
    return null;
  }

  try {
    poolInstance = new Pool({ 
      connectionString,
      ssl: {
        rejectUnauthorized: false // Required for Neon/Vercel in some configs
      },
      max: 1, // Limit connections in serverless
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    return poolInstance;
  } catch (e) {
    console.error('❌ Error creating pool:', e);
    return null;
  }
}

// Obtiene usuario de sesión para tenant scoping.
// Retorna {role, clinic_id, user_id, access_scope, username} o null (pre-migración / sin auth).
async function getSessionUser(pool, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const r = await pool.query(`
      SELECT s.role, s.clinic_id, s.clinic_user_id as user_id, s.access_scope, s.username
      FROM admin_sessions s
      LEFT JOIN clinic_users cu ON cu.id = s.clinic_user_id
      WHERE s.session_token = $1
        AND s.is_active = true
        AND s.expires_at > NOW()
        AND (s.clinic_user_id IS NULL OR cu.is_active = true)
    `, [token]);
    if (!r.rows.length) return null;
    const s = r.rows[0];
    return { role: s.role || 'clinic_admin', clinic_id: s.clinic_id, user_id: s.user_id, access_scope: s.access_scope || 'all', username: s.username };
  } catch {
    return null; // pre-migración: columnas nuevas aún no existen, acceso irrestricto
  }
}

export default async function handler(req, res) {
  console.log(`[Clinical Records API] Request received: ${req.method} ${req.url}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    let { action } = req.query;
    const body = req.body || {};

    // Allow action to be passed in body for POST requests
    if (!action && body.action) {
      action = body.action;
    }

    // Get pool instance lazily
    const pool = getPool();

    if (!pool) {
      console.error('❌ Database connection missing');
      return res.status(500).json({ error: 'Database connection not configured. Check NEON_DATABASE_URL.' });
    }

    // Test connection on health check
    if (action === 'health') {
      try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        return res.status(200).json({ 
          status: 'ok', 
          message: 'Clinical Records API is running', 
          db_time: result.rows[0].now 
        });
      } catch (err) {
        console.error('❌ Health check failed:', err);
        return res.status(500).json({ error: 'Database connection failed', details: err.message });
      }
    }

    const normalizeOptionalText = (value) => {
      if (value == null) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    };

    const normalizeOptionalNumber = (value) => {
      if (value == null || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    switch (action) {
      case 'init':
        return res.status(200).json({ message: 'Database initialized (skipped)' });

      // ==========================================
      // INVENTORY MODULE ACTIONS
      // ==========================================

      case 'inventoryListMovements':
        try {
          const limit = req.query.limit || 100;
          const { type, startDate, endDate } = req.query;
          
          let query = `
            SELECT 
              m.*, 
              i.name as item_name, 
              i.sku,
              b.batch_number,
              b.expiration_date
            FROM inventory_movements m
            JOIN inventory_batches b ON m.batch_id = b.id
            JOIN inventory_items i ON b.item_id = i.id
            WHERE 1=1
          `;
          
          const params = [];
          let paramCount = 1;

          if (type && type !== 'all') {
            if (type === 'IN') {
              query += ` AND m.quantity_change > 0`;
            } else if (type === 'OUT') {
              query += ` AND m.quantity_change < 0`;
            }
          }

          if (startDate) {
            query += ` AND m.created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
          }

          if (endDate) {
            query += ` AND m.created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
          }

          query += ` ORDER BY m.created_at DESC LIMIT $${paramCount}`;
          params.push(limit);

          const movements = await pool.query(query, params);
          return res.status(200).json(movements.rows);
        } catch (err) {
          console.error('Error listing movements:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryDeleteMovement':
        try {
           const { id } = req.query;
           // This is a soft audit log, usually we don't delete movements to preserve traceability.
           // However, for admin cleanup it might be useful.
           // NOTE: Deleting a movement does NOT revert the stock change in this implementation 
           // to avoid complex inconsistencies. It's just a log cleanup.
           await pool.query('DELETE FROM inventory_movements WHERE id = $1', [id]);
           return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting movement:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryClearMovements':
        try {
          // Clear older than X days, or all if no param
          // For safety, let's just allow clearing by explicit ID array or single ID for now in UI,
          // but here we can implement a bulk clear.
          // Let's implement 'clear older than' logic
          const { days } = body;
          if (days) {
             await pool.query(`DELETE FROM inventory_movements WHERE created_at < NOW() - INTERVAL '${parseInt(days)} days'`);
          } else {
             // Dangerous: Clear all
             // await pool.query('DELETE FROM inventory_movements');
             return res.status(400).json({ error: 'Days parameter required for bulk cleanup' });
          }
          return res.status(200).json({ success: true });
        } catch (err) {
           console.error('Error clearing movements:', err);
           return res.status(500).json({ error: err.message });
        }

      case 'inventoryListBatches':
        try {
          // Returns all active batches, useful for expiry monitoring
          const batches = await pool.query(`
            SELECT 
              b.*, 
              i.name as item_name, 
              i.sku,
              i.category,
              i.unit_of_measure
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE b.status = 'active' AND b.quantity_current > 0
            ORDER BY b.expiration_date ASC
          `);
          return res.status(200).json(batches.rows);
        } catch (err) {
          console.error('Error listing batches:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryListItems':
        try {
          // Lazy migration: ensure price columns exist on inventory_items
          try {
            await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2)`);
            await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2)`);
            await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS brand VARCHAR(120)`);
          } catch (_) { /* columns already exist */ }
          const items = await pool.query(`
            SELECT 
              i.*,
              COALESCE(SUM(b.quantity_current), 0) as total_stock,
              COALESCE(SUM(b.quantity_initial), 0) as total_initial,
              COUNT(b.id) as batch_count,
              MIN(b.expiration_date) as next_expiry
            FROM inventory_items i
            LEFT JOIN inventory_batches b ON i.id = b.item_id AND b.status = 'active'
            GROUP BY i.id
            ORDER BY i.name ASC
          `);
          return res.status(200).json(items.rows);
        } catch (err) {
          console.error('Error listing inventory:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryStats':
        try {
          // Ensure preferred_display_unit column exists (lazy migration, safe if already present)
          try {
            await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS preferred_display_unit VARCHAR(20) DEFAULT 'absolute'`);
          } catch (migErr) { /* column may already exist */ }

          const statsResult = await pool.query(`
            SELECT
              COUNT(DISTINCT i.id)::int AS total_items,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) = 0 THEN i.id END)::int AS out_of_stock_count,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) > 0 AND COALESCE(stock.total_stock, 0) <= i.min_stock_level THEN i.id END)::int AS low_stock_count
            FROM inventory_items i
            LEFT JOIN (
              SELECT item_id, SUM(quantity_current) AS total_stock
              FROM inventory_batches
              WHERE status = 'active'
              GROUP BY item_id
            ) stock ON stock.item_id = i.id
          `);

          const batchStats = await pool.query(`
            SELECT
              COUNT(CASE WHEN expiration_date < CURRENT_DATE AND status = 'active' THEN 1 END)::int AS expired_count,
              COUNT(CASE WHEN expiration_date >= CURRENT_DATE AND expiration_date <= CURRENT_DATE + INTERVAL '30 days' AND status = 'active' THEN 1 END)::int AS expiring_soon_count
            FROM inventory_batches
            WHERE status = 'active'
          `);

          const movementsStats = await pool.query(`
            SELECT COUNT(*)::int AS movements_this_month
            FROM inventory_movements
            WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
          `);

          const alertBatches = await pool.query(`
            SELECT 
              b.id,
              b.batch_number,
              b.expiration_date,
              b.quantity_current,
              i.name AS item_name,
              i.sku,
              i.unit_of_measure,
              CASE 
                WHEN b.expiration_date < CURRENT_DATE THEN 'expired'
                WHEN b.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
              END AS alert_type
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE b.status = 'active'
              AND (b.expiration_date < CURRENT_DATE OR b.expiration_date <= CURRENT_DATE + INTERVAL '30 days')
            ORDER BY b.expiration_date ASC
            LIMIT 20
          `);

          return res.status(200).json({
            ...statsResult.rows[0],
            ...batchStats.rows[0],
            ...movementsStats.rows[0],
            alert_batches: alertBatches.rows
          });
        } catch (err) {
          console.error('Error fetching inventory stats:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryGetItem':
        try {
          const itemId = req.query.id;
          const itemResult = await pool.query('SELECT * FROM inventory_items WHERE id = $1', [itemId]);
          
          if (itemResult.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
          }

          const batchesResult = await pool.query(`
            SELECT * FROM inventory_batches 
            WHERE item_id = $1 AND status = 'active' 
            ORDER BY expiration_date ASC
          `, [itemId]);

          const movementsResult = await pool.query(`
            SELECT m.*, b.batch_number 
            FROM inventory_movements m
            JOIN inventory_batches b ON m.batch_id = b.id
            WHERE b.item_id = $1
            ORDER BY m.created_at DESC
            LIMIT 50
          `, [itemId]);

          return res.status(200).json({
            item: itemResult.rows[0],
            batches: batchesResult.rows,
            movements: movementsResult.rows
          });
        } catch (err) {
          console.error('Error getting inventory item:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryCreateItem':
        try {
          const { sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price } = body;
          const cleanSku = normalizeOptionalText(sku);
          const cleanBrand = normalizeOptionalText(brand);
          const cleanDescription = normalizeOptionalText(description);
          const cleanGroupName = normalizeOptionalText(group_name);
          const cleanSanitaryRegistration = normalizeOptionalText(sanitary_registration);
          const newItem = await pool.query(`
            INSERT INTO inventory_items (sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
          `, [cleanSku, name, cleanBrand, cleanDescription, category, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
              normalizeOptionalNumber(cost_price),
              normalizeOptionalNumber(sale_price)]);
          return res.status(201).json(newItem.rows[0]);
        } catch (err) {
          console.error('Error creating inventory item:', err);
          if (err.code === '23505' && err.constraint === 'inventory_items_sku_key') {
            return res.status(409).json({ error: 'El SKU ya existe. Usa otro código o deja el campo vacío.' });
          }
          return res.status(500).json({ error: 'Error al crear producto de inventario.' });
        }

      case 'inventoryUpdateItem':
        try {
          const { id, sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price } = body;
          const cleanSku = normalizeOptionalText(sku);
          const cleanBrand = normalizeOptionalText(brand);
          const cleanDescription = normalizeOptionalText(description);
          const cleanGroupName = normalizeOptionalText(group_name);
          const cleanSanitaryRegistration = normalizeOptionalText(sanitary_registration);
          const updatedItem = await pool.query(`
            UPDATE inventory_items 
            SET sku = $1, name = $2, brand = $3, description = $4, category = $5, group_name = $6, unit_of_measure = $7, min_stock_level = $8, requires_cold_chain = $9, sanitary_registration = $10,
                cost_price = $11, sale_price = $12
            WHERE id = $13
            RETURNING *
          `, [cleanSku, name, cleanBrand, cleanDescription, category, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
              normalizeOptionalNumber(cost_price),
              normalizeOptionalNumber(sale_price),
              id]);
          
          if (updatedItem.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
          return res.status(200).json(updatedItem.rows[0]);
        } catch (err) {
          console.error('Error updating inventory item:', err);
          if (err.code === '23505' && err.constraint === 'inventory_items_sku_key') {
            return res.status(409).json({ error: 'El SKU ya existe. Usa otro código o deja el campo vacío.' });
          }
          return res.status(500).json({ error: 'Error al actualizar producto de inventario.' });
        }

      case 'inventoryDeleteItem':
        try {
          const { id } = req.query;
          
          // Use a client for transaction to ensure clean cascading delete
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            // 1. Find associated batches to clean up linked movements properly
            const batchesCheck = await client.query('SELECT id FROM inventory_batches WHERE item_id = $1', [id]);
            const batchIds = batchesCheck.rows.map(b => b.id);

            if (batchIds.length > 0) {
              // 2. Delete linked movements (requires manual deletion as they might not cascade)
              await client.query('DELETE FROM inventory_movements WHERE batch_id = ANY($1)', [batchIds]);
              
              // 3. Delete batches (if not set to CASCADE in DB, this ensures it works)
              await client.query('DELETE FROM inventory_batches WHERE item_id = $1', [id]);
            }

            // 4. Finally delete the item
            await client.query('DELETE FROM inventory_items WHERE id = $1', [id]);
            
            await client.query('COMMIT');
            return res.status(200).json({ success: true });
          } catch (txError) {
            await client.query('ROLLBACK');
            throw txError;
          } finally {
            client.release();
          }
        } catch (err) {
          console.error('Error deleting inventory item:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryDeleteBatch':
        try {
          const { id } = req.query;
          
          await pool.query('DELETE FROM inventory_movements WHERE batch_id = $1', [id]);
          await pool.query('DELETE FROM inventory_batches WHERE id = $1', [id]);
          
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting batch:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryAddBatch':
        try {
          const { item_id, batch_number, expiration_date, quantity, cost_per_unit, user_id } = body;
          
          // Start transaction
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            
            // Create Batch
            const newBatch = await client.query(`
              INSERT INTO inventory_batches (item_id, batch_number, expiration_date, quantity_initial, quantity_current, cost_per_unit, status)
              VALUES ($1, $2, $3, $4, $4, $5, 'active')
              RETURNING *
            `, [item_id, batch_number, expiration_date, quantity, cost_per_unit]);

            // Record Movement
            await client.query(`
              INSERT INTO inventory_movements (batch_id, movement_type, quantity_change, reason, user_id)
              VALUES ($1, 'PURCHASE', $2, 'Ingreso inicial de lote', $3)
            `, [newBatch.rows[0].id, quantity, user_id]);

            await client.query('COMMIT');
            return res.status(201).json(newBatch.rows[0]);
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }
        } catch (err) {
          console.error('Error adding batch:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryConsume':
        try {
          const { batch_id, quantity, reason, user_id, reference_id, preferred_display_unit } = body;
          
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            
            // Check current stock
            const batchRes = await client.query('SELECT quantity_current, item_id FROM inventory_batches WHERE id = $1', [batch_id]);
            if (batchRes.rows.length === 0) throw new Error('Batch not found');
            
            const currentQty = parseFloat(batchRes.rows[0].quantity_current);
            const itemId = batchRes.rows[0].item_id;

            if (currentQty < quantity) throw new Error('Insufficient stock in this batch');

            const newQty = currentQty - quantity;
            const newStatus = newQty <= 0 ? 'depleted' : 'active';

            // Update Batch only if quantity > 0
            if (quantity > 0) {
              await client.query(`
                UPDATE inventory_batches 
                SET quantity_current = $1, status = $2 
                WHERE id = $3
              `, [newQty, newStatus, batch_id]);
            }

            // Update Item Preference if provided
            if (preferred_display_unit) {
              await client.query(`
                UPDATE inventory_items
                SET preferred_display_unit = $1
                WHERE id = $2
              `, [preferred_display_unit, itemId]);
            }

            // Record Movement only if quantity > 0
            if (quantity > 0) {
              await client.query(`
                INSERT INTO inventory_movements (batch_id, movement_type, quantity_change, reason, reference_id, user_id)
                VALUES ($1, 'CONSUMPTION', $2, $3, $4, $5)
              `, [batch_id, -quantity, reason, reference_id, user_id]);
            }

            await client.query('COMMIT');
            return res.status(200).json({ success: true, new_quantity: newQty });
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }
        } catch (err) {
          console.error('Error consuming inventory:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'listPatients': {
        const su = await getSessionUser(pool, req);
        const filterMine = req.query.filterMine === 'true';
        let pq, pp = [];
        if (!su || su.clinic_id == null) {
          // Pre-migración o sesión legacy → todos los pacientes (backwards compat)
          pq = 'SELECT * FROM patients ORDER BY last_name, first_name';
        } else if (su.role === 'master_admin') {
          const cf = req.query.clinicId ? parseInt(req.query.clinicId) : null;
          if (cf) { pq = 'SELECT * FROM patients WHERE clinic_id = $1 ORDER BY last_name, first_name'; pp = [cf]; }
          else { pq = 'SELECT * FROM patients ORDER BY last_name, first_name'; }
        } else if (su.access_scope === 'own' || (su.access_scope === 'all' && filterMine)) {
          pq = 'SELECT * FROM patients WHERE clinic_id = $1 AND (created_by_user_id = $2 OR created_by_user_id IS NULL) ORDER BY last_name, first_name';
          pp = [su.clinic_id, su.user_id];
        } else {
          pq = 'SELECT * FROM patients WHERE clinic_id = $1 ORDER BY last_name, first_name';
          pp = [su.clinic_id];
        }
        const patients = await pool.query(pq, pp);
        return res.status(200).json(patients.rows);
      }

      case 'getPatient': {
        const { id } = req.query;
        const patient = await pool.query('SELECT * FROM patients WHERE id = $1', [id]);
        if (patient.rows.length === 0) return res.status(404).json({ error: 'Patient not found' });
        // Clinic scope check
        const su = await getSessionUser(pool, req);
        if (su?.clinic_id != null && patient.rows[0].clinic_id != null && patient.rows[0].clinic_id !== su.clinic_id && su.role !== 'master_admin') {
          return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });
        }
        // Also fetch active record ID
        const record = await pool.query('SELECT id FROM clinical_records WHERE patient_id = $1 AND status = \'active\' LIMIT 1', [id]);
        return res.status(200).json({ ...patient.rows[0], active_record_id: record.rows[0]?.id || null });
      }

      case 'listRecords':
        const { patient_id } = req.query;
        const records = await pool.query(
          'SELECT * FROM clinical_records WHERE patient_id = $1 ORDER BY created_at DESC', 
          [patient_id]
        );
        return res.status(200).json(records.rows);

      case 'createRecord':
        const { patient_id: p_id } = body;
        const newRecord = await pool.query(
          'INSERT INTO clinical_records (patient_id, status) VALUES ($1, \'active\') RETURNING *',
          [p_id]
        );
        return res.status(201).json(newRecord.rows[0]);

      case 'createPatient':
        try {
          const { first_name, last_name, rut, email, phone, birth_date, gender, address, occupation } = body;
          
          console.log('📝 Creating patient:', { first_name, last_name, rut, email });

          // Handle empty strings as null for optional fields
          const cleanRut = rut && rut.trim() !== '' ? rut.trim() : null;
          const cleanBirthDate = birth_date && birth_date.trim() !== '' ? birth_date : null;

          // Obtener clinic_id y created_by_user_id desde sesión (post-migración)
          const suCreate = await getSessionUser(pool, req);
          const patientClinicId = suCreate?.clinic_id ?? null;
          const patientCreatedBy = suCreate?.user_id ?? null;

          // Usar INSERT con columnas de tenant si están disponibles
          let newPatient;
          if (patientClinicId != null) {
            newPatient = await pool.query(
              `INSERT INTO patients (first_name, last_name, rut, email, phone, birth_date, gender, address, occupation, clinic_id, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
              [first_name, last_name, cleanRut, email, phone, cleanBirthDate, gender, address, occupation, patientClinicId, patientCreatedBy]
            );
          } else {
            newPatient = await pool.query(
              `INSERT INTO patients (first_name, last_name, rut, email, phone, birth_date, gender, address, occupation)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
              [first_name, last_name, cleanRut, email, phone, cleanBirthDate, gender, address, occupation]
            );
          }
          // Create an initial clinical record for the patient
          await pool.query('INSERT INTO clinical_records (patient_id, status) VALUES ($1, \'active\')', [newPatient.rows[0].id]);
          
          return res.status(201).json(newPatient.rows[0]);
        } catch (err) {
          console.error('❌ Error creating patient:', err);
          
          if (err.code === '23505') {
            if (err.detail.includes('rut')) {
              return res.status(400).json({ error: 'El RUT ya está registrado en el sistema.' });
            }
            if (err.detail.includes('email')) {
              return res.status(400).json({ error: 'El correo electrónico ya está registrado.' });
            }
          }
          
          if (err.code === '22007') {
             return res.status(400).json({ error: 'Formato de fecha inválido.' });
          }

          return res.status(500).json({ error: `Error al crear paciente: ${err.message}` });
        }

      case 'updatePatient': {
        const { id: pid, ...updates } = body;
        // Whitelist de campos permitidos (previene SQL injection por nombres de columna)
        const ALLOWED_PATIENT_FIELDS = ['first_name', 'last_name', 'rut', 'email', 'phone', 'birth_date', 'gender', 'address', 'occupation'];
        const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED_PATIENT_FIELDS.includes(k)));
        // Clinic scope check
        const suUpd = await getSessionUser(pool, req);
        if (suUpd?.clinic_id != null) {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [pid]);
          if (chk.rows.length && chk.rows[0].clinic_id != null && chk.rows[0].clinic_id !== suUpd.clinic_id && suUpd.role !== 'master_admin') {
            return res.status(403).json({ error: 'Acceso no autorizado' });
          }
        }
        const fields = Object.keys(safe);
        if (!fields.length) return res.status(400).json({ error: 'Sin campos válidos para actualizar' });
        const values = Object.values(safe);
        const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        const updatedPatient = await pool.query(
          `UPDATE patients SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [pid, ...values]
        );
        return res.status(200).json(updatedPatient.rows[0]);
      }

      case 'deletePatient': {
        const { id: delPid } = req.query;
        // Clinic scope check
        const suDel = await getSessionUser(pool, req);
        if (suDel?.clinic_id != null) {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [delPid]);
          if (chk.rows.length && chk.rows[0].clinic_id != null && chk.rows[0].clinic_id !== suDel.clinic_id && suDel.role !== 'master_admin') {
            return res.status(403).json({ error: 'Acceso no autorizado' });
          }
        }
        try {
          await pool.query('DELETE FROM patients WHERE id = $1', [delPid]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting patient:', err);
          return res.status(500).json({ error: 'Error al eliminar paciente. Puede tener registros asociados.' });
        }
      }

      case 'deleteRecord':
        const { id: delRecordId } = req.query;
        try {
          await pool.query('DELETE FROM clinical_records WHERE id = $1', [delRecordId]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting record:', err);
          return res.status(500).json({ error: 'Error al eliminar expediente.' });
        }

      case 'getRecordData': {
        const { recordId, patientId } = req.query;
        let targetRecordId = recordId;

        // If no recordId provided, try to find one for the patient
        if ((!targetRecordId || targetRecordId === 'undefined' || targetRecordId === 'null') && patientId) {
           // Try to find active record first
           let r = await pool.query('SELECT id FROM clinical_records WHERE patient_id = $1 AND status = \'active\' LIMIT 1', [patientId]);
           
           // If no active record, try to find ANY record
           if (r.rows.length === 0) {
             r = await pool.query('SELECT id FROM clinical_records WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1', [patientId]);
           }
           
           // If still no record, create one
           if (r.rows.length === 0) {
             const newRec = await pool.query('INSERT INTO clinical_records (patient_id, status) VALUES ($1, \'active\') RETURNING id', [patientId]);
             targetRecordId = newRec.rows[0].id;
           } else {
             targetRecordId = r.rows[0].id;
           }
        }

        if (!targetRecordId || targetRecordId === 'undefined' || targetRecordId === 'null') {
          return res.status(404).json({ error: 'Record not found' });
        }

        const recordDetails = await pool.query('SELECT * FROM clinical_records WHERE id = $1', [targetRecordId]);
        
        if (recordDetails.rows.length === 0) {
           return res.status(404).json({ error: 'Record ID not found in database' });
        }

        const patientIdFromRecord = recordDetails.rows[0]?.patient_id;

        // Helper to safely query tables that might not exist yet
        const safeQuery = async (query, params) => {
          try {
            return await pool.query(query, params);
          } catch (err) {
            if (err.code === '42P01') { // undefined_table
              return { rows: [] };
            }
            if (err.code === '42703') { // undefined_column
              console.warn(`⚠️ Column missing in query: ${query}`, err.message);
              return { rows: [] };
            }
            throw err;
          }
        };

        const [
          history, 
          physical, 
          diagnoses, 
          treatments, 
          prescriptions, 
          consents, 
          injectables,
          consultation,
          consultationHistory
        ] = await Promise.all([
          safeQuery('SELECT * FROM medical_history WHERE record_id = $1', [targetRecordId]),
          safeQuery('SELECT * FROM physical_exams WHERE record_id = $1 ORDER BY created_at DESC', [targetRecordId]),
          safeQuery('SELECT * FROM diagnoses WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM treatments WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM prescriptions WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM consent_forms WHERE record_id = $1 ORDER BY id DESC', [targetRecordId]),
          safeQuery('SELECT * FROM injectables WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM consultation_info WHERE record_id = $1', [targetRecordId]),
          safeQuery('SELECT * FROM consultation_history WHERE record_id = $1 ORDER BY created_at DESC', [targetRecordId])
        ]);

        return res.status(200).json({
          recordId: targetRecordId,
          patientId: patientIdFromRecord,
          history: history.rows[0] || {},
          physicalExams: physical.rows,
          diagnoses: diagnoses.rows,
          treatments: treatments.rows,
          prescriptions: prescriptions.rows,
          consentForms: consents.rows,
          injectables: injectables.rows,
          consultation: consultation.rows[0] || {},
          consultationHistory: consultationHistory.rows || []
        });
      }

      case 'deleteConsultationHistory': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'ID required' });
        
        await pool.query('DELETE FROM consultation_history WHERE id = $1', [id]);
        return res.status(200).json({ success: true });
      }

      case 'saveConsultation': {
        const { recordId, reason, current_illness } = body;
        
        if (!recordId) return res.status(400).json({ error: 'Record ID required' });

        // Check if exists
        const existing = await pool.query('SELECT id FROM consultation_info WHERE record_id = $1', [recordId]);

        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE consultation_info SET reason = $1, current_illness = $2, updated_at = NOW() WHERE record_id = $3',
            [reason, current_illness, recordId]
          );
        } else {
          await pool.query(
            'INSERT INTO consultation_info (record_id, reason, current_illness) VALUES ($1, $2, $3)',
            [recordId, reason, current_illness]
          );
        }
        
        // Save to history
        if ((reason && reason.trim()) || (current_illness && current_illness.trim())) {
          try {
            await pool.query(
              'INSERT INTO consultation_history (record_id, reason, current_illness) VALUES ($1, $2, $3)',
              [recordId, reason, current_illness]
            );
          } catch (histErr) {
            console.error('Error saving consultation history:', histErr);
            // Don't fail the whole request
          }
        }
        
        return res.status(200).json({ success: true });
      }

      case 'saveHistory':
        const { record_id: hid, ...historyData } = body;
        
        // Remove system fields that shouldn't be updated manually
        delete historyData.id;
        delete historyData.created_at;
        delete historyData.updated_at;

        const existingHistory = await pool.query('SELECT id FROM medical_history WHERE record_id = $1', [hid]);
        if (existingHistory.rows.length > 0) {
           const hFields = Object.keys(historyData);
           const hValues = Object.values(historyData);
           const hSet = hFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
           await pool.query(`UPDATE medical_history SET ${hSet}, updated_at = NOW() WHERE record_id = $1`, [hid, ...hValues]);
        } else {
           const hFields = ['record_id', ...Object.keys(historyData)];
           const hValues = [hid, ...Object.values(historyData)];
           const hParams = hFields.map((_, i) => `$${i + 1}`).join(', ');
           await pool.query(`INSERT INTO medical_history (${hFields.join(', ')}) VALUES (${hParams})`, hValues);
        }
        return res.status(200).json({ success: true });

      case 'savePhysicalExam': {
        const { id: examId, record_id: pid_exam, created_at, ...examData } = body;
        
        if (examId) {
           const eFields = Object.keys(examData);
           const eValues = Object.values(examData);
           if (eFields.length > 0) {
             const eSet = eFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE physical_exams SET ${eSet} WHERE id = $1`, [examId, ...eValues]);
           }
        } else {
           if (!pid_exam) return res.status(400).json({ error: 'Falta el ID del expediente (record_id)' });
           const eFields = ['record_id', ...Object.keys(examData)];
           const eValues = [pid_exam, ...Object.values(examData)];
           const eParams = eFields.map((_, i) => `$${i + 1}`).join(', ');
           await pool.query(`INSERT INTO physical_exams (${eFields.join(', ')}) VALUES (${eParams})`, eValues);
        }
        return res.status(200).json({ success: true });
      }

      case 'deletePhysicalExam':
        const { id: delExamId } = req.query;
        await pool.query('DELETE FROM physical_exams WHERE id = $1', [delExamId]);
        return res.status(200).json({ success: true });

      case 'saveDiagnosis':
        const { id: diagId, record_id: did, date: diagDate, ...diagData } = body;
        if (diagId) {
           const dFields = Object.keys(diagData);
           const dValues = Object.values(diagData);
           if (dFields.length > 0) {
             const dSet = dFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE diagnoses SET ${dSet} WHERE id = $1`, [diagId, ...dValues]);
           }
           return res.status(200).json({ success: true });
        } else {
           const dFields = ['record_id', ...Object.keys(diagData)];
           const dValues = [did, ...Object.values(diagData)];
           const dParams = dFields.map((_, i) => `$${i + 1}`).join(', ');
           const newDiag = await pool.query(`INSERT INTO diagnoses (${dFields.join(', ')}) VALUES (${dParams}) RETURNING *`, dValues);
           return res.status(201).json(newDiag.rows[0]);
        }

      case 'deleteDiagnosis':
        const { id: delDiagId } = req.query;
        await pool.query('DELETE FROM diagnoses WHERE id = $1', [delDiagId]);
        return res.status(200).json({ success: true });

      case 'addTreatment':
        const { record_id: tid, ...treatData } = body;
        const tFields = ['record_id', ...Object.keys(treatData)];
        const tValues = [tid, ...Object.values(treatData)];
        const tParams = tFields.map((_, i) => `$${i + 1}`).join(', ');
        const newTreat = await pool.query(`INSERT INTO treatments (${tFields.join(', ')}) VALUES (${tParams}) RETURNING *`, tValues);
        return res.status(201).json(newTreat.rows[0]);

      case 'updateTreatment':
        const { id: upTreatId, ...upTreatData } = body;
        const upTFields = Object.keys(upTreatData);
        const upTValues = Object.values(upTreatData);
        const upTSet = upTFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        await pool.query(`UPDATE treatments SET ${upTSet} WHERE id = $1`, [upTreatId, ...upTValues]);
        return res.status(200).json({ success: true });

      case 'updateSchema':
        try {
          await pool.query('ALTER TABLE treatments ADD COLUMN IF NOT EXISTS ai_suggestion TEXT');
          return res.status(200).json({ message: 'Schema updated successfully' });
        } catch (err) {
          console.error('Schema update error:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'generateTreatmentAI': {
        const { patientName, patientAge, examData, treatmentContext } = body;
        
        try {
          // Gemini API used instead of OpenAI

          const systemPrompt = `Eres un experto en medicina estética y dermatología avanzada. Tu tarea es generar una sugerencia de tratamiento detallada y profesional.
          
          Contexto del Paciente:
          - Nombre: ${patientName}
          - Edad: ${patientAge}
          
          Examen Físico (Contexto Clínico):
          ${JSON.stringify(examData, null, 2)}
          
          Contexto del Tratamiento (Proporcionado por el médico):
          ${treatmentContext}
          
          Instrucciones:
          Genera una respuesta estructurada en formato JSON con los siguientes campos:
          1. "treatment_name": Nombre corto y técnico del tratamiento.
          2. "description": Descripción breve del procedimiento.
          3. "objective": UN SOLO objetivo principal, corto y conciso.
          4. "protocol": Protocolo completo pero CONCISO. Limita la respuesta a un máximo de 10-12 líneas. Si es aparatología, incluye parámetros específicos (energía, filtros, frecuencia, tiempos, pasadas, etc.). Si es inyectable o tópico, detalla productos, dosis y técnica.
          
          La respuesta debe ser profesional, segura y basada en estándares médicos actuales.`;

          const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
          if (!apiKey) throw new Error("Missing Gemini API Key");

          const model = 'gemini-flash-latest';
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [{ text: systemPrompt + "\n\nGenera la sugerencia de tratamiento." }]
              }],
              generationConfig: {
                response_mime_type: "application/json"
              }
            })
          });

          if (!response.ok) {
             const err = await response.json();
             throw new Error(err.error?.message || 'Gemini API Error');
          }

          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          const result = JSON.parse(text);
          return res.status(200).json(result);
        } catch (aiError) {
          console.error('AI Treatment Error:', aiError);
          return res.status(500).json({ error: 'Error generating treatment suggestion: ' + aiError.message });
        }
      }

      case 'deleteTreatment':
        const { id: delTreatId } = req.query;
        await pool.query('DELETE FROM treatments WHERE id = $1', [delTreatId]);
        return res.status(200).json({ success: true });

      // --- INYECTABLES ---

      case 'getInjectablesByRecord': {
        await ensureInjectablesSchema(pool);
        const { record_id: injRecordId } = req.query;
        if (!injRecordId) return res.status(400).json({ error: 'record_id required' });
        const injByRecord = await pool.query(
          'SELECT * FROM injectables WHERE record_id = $1 ORDER BY date DESC',
          [injRecordId]
        );
        return res.status(200).json(injByRecord.rows);
      }

      case 'getInjectablesByTreatment': {
        const { treatment_id: injTreatId } = req.query;
        if (!injTreatId) return res.status(400).json({ error: 'treatment_id required' });
        const injList = await pool.query(
          'SELECT * FROM injectables WHERE treatment_id = $1 ORDER BY date DESC',
          [injTreatId]
        );
        return res.status(200).json(injList.rows);
      }

      case 'addInjectable': {
        await ensureInjectablesSchema(pool);
        const { record_id: injRecId, treatment_id: injTid, ...injData } = body;
        if (!injRecId) return res.status(400).json({ error: 'record_id required' });

        // Sanitize fields
        const allowedFields = [
          'date', 'product_type', 'product_name', 'brand', 'lot_number',
          'expiration_date', 'volume_used', 'units_used', 'areas_treated',
          'technique', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date'
        ];
        const dateFields = ['date', 'expiration_date', 'follow_up_date'];
        const numericFields = ['volume_used', 'units_used', 'dilution_volume'];
        const cleanData = {};
        for (const key of allowedFields) {
          if (injData[key] !== undefined) {
            let val = injData[key];
            // Convert empty strings to null for date and numeric fields
            if (typeof val === 'string' && val.trim() === '' && (dateFields.includes(key) || numericFields.includes(key))) {
              val = null;
            }
            if (['areas_treated', 'mapping_data'].includes(key) && typeof val === 'object') {
              val = JSON.stringify(val);
            }
            // Skip null/empty optional fields to avoid type errors
            if (val === null && key !== 'date') continue;
            cleanData[key] = val;
          }
        }

        const fields = ['record_id', ...Object.keys(cleanData)];
        const values = [injRecId, ...Object.values(cleanData)];

        // Include treatment_id only if provided (column may not exist in older schemas)
        if (injTid) {
          fields.push('treatment_id');
          values.push(injTid);
        }

        const params = fields.map((_, i) => `$${i + 1}`).join(', ');
        const newInj = await pool.query(
          `INSERT INTO injectables (${fields.join(', ')}) VALUES (${params}) RETURNING *`,
          values
        );
        return res.status(201).json(newInj.rows[0]);
      }

      case 'updateInjectable': {
        const { id: updInjId, ...updInjData } = body;
        if (!updInjId) return res.status(400).json({ error: 'id required' });

        const allowedFields = [
          'date', 'product_type', 'product_name', 'brand', 'lot_number',
          'expiration_date', 'volume_used', 'units_used', 'areas_treated',
          'technique', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date'
        ];
        const cleanData = {};
        const dateFields = ['date', 'expiration_date', 'follow_up_date'];
        for (const key of allowedFields) {
          if (updInjData[key] !== undefined) {
            let val = updInjData[key];
            // Convertir string vacío a null en campos de tipo date
            if (dateFields.includes(key) && (val === '' || val === null)) {
              val = null;
            } else if (['areas_treated', 'mapping_data'].includes(key) && typeof val === 'object') {
              val = JSON.stringify(val);
            }
            cleanData[key] = val;
          }
        }

        const uFields = Object.keys(cleanData);
        const uValues = Object.values(cleanData);
        if (uFields.length === 0) return res.status(400).json({ error: 'No fields to update' });

        const uSet = uFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        await pool.query(`UPDATE injectables SET ${uSet} WHERE id = $1`, [updInjId, ...uValues]);
        return res.status(200).json({ success: true });
      }

      case 'deleteInjectable': {
        const { id: delInjId } = req.query;
        if (!delInjId) return res.status(400).json({ error: 'id required' });
        await pool.query('DELETE FROM injectables WHERE id = $1', [delInjId]);
        return res.status(200).json({ success: true });
      }

      case 'listPrescriptions':
        const { record_id: presc_record_id } = req.query;
        const prescriptionsList = await pool.query('SELECT * FROM prescriptions WHERE record_id = $1 ORDER BY date DESC, id DESC', [presc_record_id]);
        const mappedPrescriptions = prescriptionsList.rows.map(p => ({
          ...p,
          fecha: p.date,
          diagnostico: p.diagnosis
        }));
        return res.status(200).json(mappedPrescriptions);

      case 'getPrescription':
        const { id: getPrescId } = req.query;
        const presc = await pool.query('SELECT * FROM prescriptions WHERE id = $1', [getPrescId]);
        if (presc.rows.length === 0) return res.status(404).json({ error: 'Prescription not found' });
        const pData = presc.rows[0];
        return res.status(200).json({
          ...pData,
          fecha: pData.date,
          diagnostico: pData.diagnosis,
          items: pData.items || []
        });

      case 'createPrescription':
        const { ficha_id, fecha, diagnostico, items } = body;
        const newPresc = await pool.query(
          'INSERT INTO prescriptions (record_id, date, diagnosis, items) VALUES ($1, $2, $3, $4) RETURNING id',
          [ficha_id, fecha, diagnostico, JSON.stringify(items)]
        );
        return res.status(200).json({ id: newPresc.rows[0].id, message: 'Receta created' });

      case 'updatePrescription':
        const { id: updPrescId, fecha: updFecha, diagnostico: updDiag, items: updItems } = body;
        await pool.query(
          'UPDATE prescriptions SET date = $1, diagnosis = $2, items = $3 WHERE id = $4',
          [updFecha, updDiag, JSON.stringify(updItems), updPrescId]
        );
        return res.status(200).json({ message: 'Receta updated' });

      case 'deletePrescription':
        const { id: delPrescId } = req.query;
        await pool.query('DELETE FROM prescriptions WHERE id = $1', [delPrescId]);
        return res.status(200).json({ message: 'Receta deleted' });

      case 'getTemplates':
        const templates = await pool.query('SELECT * FROM prescription_templates ORDER BY name ASC');
        const mappedTemplates = templates.rows.map(t => ({
          ...t,
          nombre: t.name
        }));
        return res.status(200).json(mappedTemplates);

      case 'saveTemplate':
        const { nombre, items: tItems } = body;
        const newTempl = await pool.query(
          'INSERT INTO prescription_templates (name, items_json) VALUES ($1, $2) RETURNING id',
          [nombre, JSON.stringify(tItems)]
        );
        return res.status(200).json({ id: newTempl.rows[0].id, message: 'Template saved' });

      case 'deleteTemplate':
        const { id: delTemplId } = req.query;
        await pool.query('DELETE FROM prescription_templates WHERE id = $1', [delTemplId]);
        return res.status(200).json({ message: 'Template deleted' });

      // --- CONSENTIMIENTOS ---

      case 'migrateConsents':
        // Add signing columns if they don't exist
        try {
          await pool.query(`
            ALTER TABLE consent_forms 
            ADD COLUMN IF NOT EXISTS signing_token VARCHAR(100),
            ADD COLUMN IF NOT EXISTS signing_status VARCHAR(20) DEFAULT 'pending';
            CREATE INDEX IF NOT EXISTS idx_consent_forms_signing_token ON consent_forms(signing_token);
          `);
          return res.status(200).json({ message: 'Consent forms table migrated' });
        } catch (err) {
          console.error('Migration error:', err);
          return res.status(500).json({ error: 'Migration failed', details: err.message });
        }

      case 'initConsents':
        // WARNING: This drops the table! Use with caution.
        await pool.query(`
          DROP TABLE IF EXISTS consent_forms;
          CREATE TABLE consent_forms (
              id SERIAL PRIMARY KEY,
              record_id INTEGER REFERENCES clinical_records(id) ON DELETE CASCADE,
              patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
              status VARCHAR(20) DEFAULT 'draft',
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW(),
              created_by VARCHAR(100),
              procedure_type VARCHAR(150),
              zone VARCHAR(150),
              sessions INTEGER,
              objectives JSONB,
              description TEXT,
              risks JSONB,
              benefits JSONB,
              alternatives JSONB,
              pre_care JSONB,
              post_care JSONB,
              contraindications JSONB,
              critical_antecedents JSONB,
              authorizations JSONB,
              declarations JSONB,
              signatures JSONB,
              attachments JSONB,
              signing_token VARCHAR(100),
              signing_status VARCHAR(20) DEFAULT 'pending'
          );
          CREATE INDEX idx_consent_forms_record_id ON consent_forms(record_id);
          CREATE INDEX idx_consent_forms_patient_id ON consent_forms(patient_id);
          CREATE INDEX idx_consent_forms_signing_token ON consent_forms(signing_token);
        `);
        return res.status(200).json({ message: 'Consent forms table initialized' });

      case 'initProfessionalSignatures':
        await pool.query(`
          CREATE TABLE IF NOT EXISTS professional_signatures (
            id SERIAL PRIMARY KEY,
            professional_name VARCHAR(150),
            signature_data TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
          );
        `);
        return res.status(200).json({ message: 'Professional signatures table initialized' });

      case 'saveProfessionalSignature': {
        const { name, signature } = body;
        // Upsert based on name (simple approach for single doctor/admin)
        // Check if exists
        const existing = await pool.query('SELECT id FROM professional_signatures WHERE professional_name = $1', [name]);
        
        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE professional_signatures SET signature_data = $1, updated_at = NOW() WHERE professional_name = $2',
            [signature, name]
          );
        } else {
          await pool.query(
            'INSERT INTO professional_signatures (professional_name, signature_data) VALUES ($1, $2)',
            [name, signature]
          );
        }
        return res.status(200).json({ success: true });
      }

      case 'getProfessionalSignature': {
        const { name } = req.query;
        const result = await pool.query('SELECT signature_data FROM professional_signatures WHERE professional_name = $1', [name]);
        return res.status(200).json({ signature: result.rows[0]?.signature_data || null });
      }

      case 'generateSigningToken': {
        const { id: signId } = body;
        if (!signId) return res.status(400).json({ error: 'Consent ID required' });
        
        // Generate a simple random token
        const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        
        await pool.query(
          'UPDATE consent_forms SET signing_token = $1, signing_status = $2 WHERE id = $3',
          [token, 'pending', signId]
        );
        
        return res.status(200).json({ token, url: `/consent-signing/${token}` });
      }

      case 'getSigningSession': {
        const { token } = req.query;
        if (!token) return res.status(400).json({ error: 'Token required' });
        
        const session = await pool.query(
          'SELECT * FROM consent_forms WHERE signing_token = $1',
          [token]
        );
        
        if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
        
        const data = session.rows[0];
        
        // Fetch patient details
        const patient = await pool.query(
          'SELECT first_name, last_name, rut, phone, birth_date FROM patients WHERE id = $1',
          [data.patient_id]
        );
        
        return res.status(200).json({
          ...data,
          patient: patient.rows[0] || {}
        });
      }

      case 'submitSignature': {
        const { token, signature, declarations, authorizations } = body;
        if (!token || !signature) return res.status(400).json({ error: 'Token and signature required' });
        
        // Get current signatures to preserve professional signature if exists
        const current = await pool.query('SELECT signatures FROM consent_forms WHERE signing_token = $1', [token]);
        if (current.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
        
        const currentSigs = current.rows[0].signatures || {};
        const newSigs = {
          ...currentSigs,
          patient_sig_data: signature,
          patient_signed_at: new Date().toISOString()
        };
        
        await pool.query(
          'UPDATE consent_forms SET signatures = $1, declarations = $2, authorizations = $3, signing_status = $4, status = $5, updated_at = NOW() WHERE signing_token = $6',
          [JSON.stringify(newSigs), JSON.stringify(declarations), JSON.stringify(authorizations || {}), 'signed', 'finalized', token]
        );
        
        return res.status(200).json({ success: true });
      }

      case 'listConsents': {
        const { patient_id: pid, record_id: rid } = req.query;
        let query = 'SELECT * FROM consent_forms WHERE ';
        let params = [];
        if (rid) {
          query += 'record_id = $1';
          params.push(rid);
        } else if (pid) {
          query += 'patient_id = $1';
          params.push(pid);
        } else {
          return res.status(400).json({ error: 'Missing patient_id or record_id' });
        }
        query += ' ORDER BY created_at DESC';
        const consents = await pool.query(query, params);
        return res.status(200).json(consents.rows);
      }

      case 'getConsent':
        const { id: cid } = req.query;
        const consent = await pool.query('SELECT * FROM consent_forms WHERE id = $1', [cid]);
        if (consent.rows.length === 0) return res.status(404).json({ error: 'Consent not found' });
        return res.status(200).json(consent.rows[0]);

      case 'saveConsent': {
        const { 
          id: saveCid, 
          record_id: saveRid, 
          patient_id: savePid,
          status,
          created_by,
          procedure_type,
          zone,
          sessions,
          objectives,
          description,
          risks,
          benefits,
          alternatives,
          pre_care,
          post_care,
          contraindications,
          critical_antecedents,
          authorizations,
          declarations,
          signatures,
          attachments
        } = body;

        if (saveCid) {
          // Update
          const updateQuery = `
            UPDATE consent_forms SET
              status = COALESCE($1, status),
              updated_at = NOW(),
              procedure_type = COALESCE($2, procedure_type),
              zone = COALESCE($3, zone),
              sessions = COALESCE($4, sessions),
              objectives = COALESCE($5, objectives),
              description = COALESCE($6, description),
              risks = COALESCE($7, risks),
              benefits = COALESCE($8, benefits),
              alternatives = COALESCE($9, alternatives),
              pre_care = COALESCE($10, pre_care),
              post_care = COALESCE($11, post_care),
              contraindications = COALESCE($12, contraindications),
              critical_antecedents = COALESCE($13, critical_antecedents),
              authorizations = COALESCE($14, authorizations),
              declarations = COALESCE($15, declarations),
              signatures = COALESCE($16, signatures),
              attachments = COALESCE($17, attachments)
            WHERE id = $18 RETURNING *
          `;
          const updated = await pool.query(updateQuery, [
            status, procedure_type, zone, sessions, 
            JSON.stringify(objectives), description, JSON.stringify(risks), JSON.stringify(benefits), JSON.stringify(alternatives),
            JSON.stringify(pre_care), JSON.stringify(post_care), JSON.stringify(contraindications),
            JSON.stringify(critical_antecedents), JSON.stringify(authorizations), JSON.stringify(declarations),
            JSON.stringify(signatures), JSON.stringify(attachments),
            saveCid
          ]);
          return res.status(200).json(updated.rows[0]);
        } else {
          // Create
          const insertQuery = `
            INSERT INTO consent_forms (
              record_id, patient_id, status, created_by,
              procedure_type, zone, sessions,
              objectives, description, risks, benefits, alternatives,
              pre_care, post_care, contraindications,
              critical_antecedents, authorizations, declarations,
              signatures, attachments
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7,
              $8, $9, $10, $11, $12,
              $13, $14, $15,
              $16, $17, $18,
              $19, $20
            ) RETURNING *
          `;
          const created = await pool.query(insertQuery, [
            saveRid, savePid, status || 'draft', created_by,
            procedure_type, zone, sessions,
            JSON.stringify(objectives || []), description || '', JSON.stringify(risks || []), JSON.stringify(benefits || []), JSON.stringify(alternatives || []),
            JSON.stringify(pre_care || []), JSON.stringify(post_care || []), JSON.stringify(contraindications || []),
            JSON.stringify(critical_antecedents || {}), JSON.stringify(authorizations || {}), JSON.stringify(declarations || {}),
            JSON.stringify(signatures || {}), JSON.stringify(attachments || [])
          ]);
          return res.status(200).json(created.rows[0]);
        }
      }

      case 'deleteConsent':
        const { id: delCid } = req.query;
        await pool.query('DELETE FROM consent_forms WHERE id = $1', [delCid]);
        return res.status(200).json({ message: 'Consent deleted' });

      case 'getDiagnosisContext': {
        const { examData, patientName } = body;
        if (!examData) return res.status(400).json({ error: 'Missing exam data' });

        try {
          let lesions = [];
          try {
            const faceMarks = typeof examData.face_map_data === 'string' ? JSON.parse(examData.face_map_data || '[]') : (examData.face_map_data || []);
            const bodyMarks = typeof examData.body_map_data === 'string' ? JSON.parse(examData.body_map_data || '[]') : (examData.body_map_data || []);
            lesions = [...faceMarks, ...bodyMarks];
          } catch (e) {
            console.error('Error parsing map data:', e);
          }

          const lesionNames = [...new Set(lesions.map(l => l.category))];
          let linkedDiagnostics = [];

          if (lesionNames.length > 0) {
            try {
              const tableCheck = await pool.query("SELECT to_regclass('public.lesiones_maestras')");
              if (tableCheck.rows[0].to_regclass) {
                const placeholders = lesionNames.map((_, i) => `$${i + 1}`).join(',');
                const query = `SELECT diagnosticos_vinculados FROM lesiones_maestras WHERE nombre IN (${placeholders})`;
                const results = await pool.query(query, lesionNames);
                
                results.rows.forEach(row => {
                  if (row.diagnosticos_vinculados) {
                    const diags = row.diagnosticos_vinculados.split(';').map(d => d.trim());
                    linkedDiagnostics.push(...diags);
                  }
                });
              }
            } catch (dbError) {
              console.warn('Warning: Could not fetch linked diagnostics from DB:', dbError.message);
            }
          }
          linkedDiagnostics = [...new Set(linkedDiagnostics)];

          const context = `
          - Datos del paciente: ${patientName || 'Paciente'}
          - Tipo de piel: ${examData.skin_type || 'No especificado'}
          - Fototipo: ${examData.phototype || 'No especificado'}
          - Escala Glogau: ${examData.glogau_scale || 'No especificado'}
          - Descripción de lesiones: ${examData.lesions_description || 'Sin descripción adicional'}
          - Lesiones identificadas: ${lesionNames.join(', ') || 'Ninguna'}
          - Diagnósticos asociados (BD): ${linkedDiagnostics.join(', ') || 'Ninguno (Usar conocimiento médico general)'}
          `;

          return res.status(200).json({ context });
        } catch (error) {
          console.error('Error generating context:', error);
          return res.status(500).json({ error: error.message });
        }
      }

      case 'generateDiagnosisAI': {
        const { examData, patientName, customContext } = body;
        if (!examData && !customContext) return res.status(400).json({ error: 'Missing data' });

        try {
          // Gemini API used instead of OpenAI
          
          let contextToUse = customContext;

          if (!contextToUse) {
            // Fallback logic if no custom context provided (same as getDiagnosisContext)
            let lesions = [];
            try {
              const faceMarks = typeof examData.face_map_data === 'string' ? JSON.parse(examData.face_map_data || '[]') : (examData.face_map_data || []);
              const bodyMarks = typeof examData.body_map_data === 'string' ? JSON.parse(examData.body_map_data || '[]') : (examData.body_map_data || []);
              lesions = [...faceMarks, ...bodyMarks];
            } catch (e) {
              console.error('Error parsing map data:', e);
            }

            const lesionNames = [...new Set(lesions.map(l => l.category))];
            let linkedDiagnostics = [];

            if (lesionNames.length > 0) {
              try {
                const tableCheck = await pool.query("SELECT to_regclass('public.lesiones_maestras')");
                if (tableCheck.rows[0].to_regclass) {
                  const placeholders = lesionNames.map((_, i) => `$${i + 1}`).join(',');
                  const query = `SELECT diagnosticos_vinculados FROM lesiones_maestras WHERE nombre IN (${placeholders})`;
                  const results = await pool.query(query, lesionNames);
                  
                  results.rows.forEach(row => {
                    if (row.diagnosticos_vinculados) {
                      const diags = row.diagnosticos_vinculados.split(';').map(d => d.trim());
                      linkedDiagnostics.push(...diags);
                    }
                  });
                }
              } catch (dbError) {
                console.warn('Warning: Could not fetch linked diagnostics from DB:', dbError.message);
              }
            }
            linkedDiagnostics = [...new Set(linkedDiagnostics)];

            contextToUse = `
            - Datos del paciente: ${patientName || 'Paciente'}
            - Tipo de piel: ${examData.skin_type || 'No especificado'}
            - Fototipo: ${examData.phototype || 'No especificado'}
            - Escala Glogau: ${examData.glogau_scale || 'No especificado'}
            - Descripción de lesiones: ${examData.lesions_description || 'Sin descripción adicional'}
            - Lesiones identificadas: ${lesionNames.join(', ') || 'Ninguna'}
            - Diagnósticos asociados (BD): ${linkedDiagnostics.join(', ') || 'Ninguno (Usar conocimiento médico general)'}
            `;
          }

          const systemPrompt = `Eres un dermatólogo experto y asistente médico de IA. Tu tarea es analizar los datos del examen físico de un paciente y sugerir un diagnóstico preliminar y notas clínicas detalladas.
          
          Utiliza la siguiente información:
          ${contextToUse}
          
          Instrucciones:
          1. Genera un "Diagnóstico Preliminar" conciso basado en las lesiones y los diagnósticos asociados. Si hay múltiples posibilidades, lístalas por probabilidad.
          2. Genera "Notas/Observaciones" que justifiquen el diagnóstico. IMPORTANTE: Limita la respuesta a un MÁXIMO de 6 o 7 líneas. Sé directo y conciso.
          3. Mantén un tono profesional, médico y objetivo.
          4. Responde SOLAMENTE en formato JSON válido con las claves "diagnosis" y "notes".`;

          const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
          if (!apiKey) throw new Error("Missing Gemini API Key");

          const model = 'gemini-flash-latest';
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [{ text: systemPrompt + "\n\nGenera el diagnóstico y las notas clínicas." }]
              }],
              generationConfig: {
                response_mime_type: "application/json"
              }
            })
          });

          if (!response.ok) {
             const err = await response.json();
             throw new Error(err.error?.message || 'Gemini API Error');
          }

          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          const result = JSON.parse(text);
          return res.status(200).json(result);
        } catch (aiError) {
          console.error('AI Service Error:', aiError);
          return res.status(500).json({ error: 'Error generating diagnosis: ' + aiError.message });
        }
      }

      // ==========================================
      // FINANCE MODULE ACTIONS
      // ==========================================

      case 'financeList': {
        const { startDate, endDate, registered_by } = req.query;
        let query = `SELECT * FROM financial_records WHERE 1=1`;
        const params = [];
        let paramCount = 1;

        // Filtros opcionales
        if (startDate && startDate !== 'null' && startDate !== 'undefined') {
          query += ` AND date >= $${paramCount}`;
          params.push(startDate);
          paramCount++;
        }
        if (endDate && endDate !== 'null' && endDate !== 'undefined') {
          query += ` AND date <= $${paramCount}`;
          params.push(endDate);
          paramCount++;
        }
        if (registered_by && registered_by !== 'all' && registered_by !== 'null') {
          query += ` AND registered_by = $${paramCount}`;
          params.push(registered_by);
          paramCount++;
        }

        query += ` ORDER BY date DESC, created_at DESC`;
        
        try {
          const result = await pool.query(query, params);
          return res.status(200).json(result.rows);
        } catch (err) {
          console.error('Error listing finance records:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeDelete': {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        try {
          await pool.query('DELETE FROM financial_records WHERE id = $1', [id]);
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeStats': {
        // Stats generales y por usuario
        const { startDate, endDate } = req.query;
        let query = `
          SELECT 
            type, 
            registered_by,
            SUM(total) as total_amount,
            COUNT(*) as count
          FROM financial_records
          WHERE status = 'confirmed'
        `;
        const params = [];
        let paramCount = 1;

        if (startDate && startDate !== 'null') {
          query += ` AND date >= $${paramCount}`;
          params.push(startDate);
          paramCount++;
        }
        if (endDate && endDate !== 'null') {
          query += ` AND date <= $${paramCount}`;
          params.push(endDate);
          paramCount++;
        }
        
        query += ` GROUP BY type, registered_by`;

        try {
          const result = await pool.query(query, params);
          return res.status(200).json(result.rows);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeUpdate': {
        const { id, date, invoice_number, entity, description, type, subtotal, tax, total } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });

        try {
          await pool.query(`
            UPDATE financial_records 
            SET 
              date = $1, 
              invoice_number = $2, 
              entity = $3, 
              description = $4, 
              type = $5, 
              subtotal = $6, 
              tax = $7, 
              total = $8
            WHERE id = $9
          `, [date, invoice_number, entity, description, type, subtotal, tax, total, id]);
          
          return res.status(200).json({ success: true, message: 'Record updated' });
        } catch (err) {
          console.error('Error updating finance record:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Clinical Records API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
