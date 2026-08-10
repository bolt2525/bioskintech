import crypto from 'crypto';
import { initClinicalDatabase, getPool, getAppPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';
import { generateUploadUrl, generateReadUrl, deleteR2Object } from '../lib/r2-service.js';

console.log('✅ [API] records.js loaded');

// Global flag to track initialization in the current container instance
let dbInitialized = false;

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper — reads session from admin_sessions via @vercel/postgres (neondb_owner)
// ─────────────────────────────────────────────────────────────────────────────

/** Builds the normalized session-user object from authenticateRequest result. */
function buildSu(auth) {
  if (!auth?.valid) return null;
  return {
    role:                auth.role,
    clinic_id:           auth.clinic_id,           // UUID string
    effective_clinic_id: auth.effective_clinic_id, // UUID string (may differ for master)
    user_id:             auth.id,
    access_scope:        auth.access_scope || 'all',
    username:            auth.username,
  };
}

/**
 * Registra un evento de auditoría en patient_audit_log.
 * Silencioso si falla — la auditoría nunca debe interrumpir la operación principal.
 */
async function logAudit(client, { patientId, recordId, sessionUser, actionType, module, summary, fieldChanges }) {
  try {
    await client.query(
      `INSERT INTO patient_audit_log (patient_id, record_id, clinic_user_id, user_display_name, action_type, module, summary, field_changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        patientId || null,
        recordId  || null,
        sessionUser?.user_id  || null,
        sessionUser?.username || 'Sistema',
        actionType,
        module,
        summary,
        fieldChanges ? JSON.stringify(fieldChanges) : null,
      ]
    );
  } catch { /* silencioso — auditoría no bloquea operaciones */ }
}

export default async function handler(req, res) {
  console.log(`[Clinical Records API] Request received: ${req.method} ${req.url}`);

  // CORS headers
  const requestOrigin = req.headers.origin || '';
  const allowedOrigins = (process.env.ADMIN_CORS_ORIGIN || 'https://bioskintech.vercel.app,http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim());
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-Clinic-Id');

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

    // ── Auth ──────────────────────────────────────────────────────────────
    // ponytail: whitelist mínima pública; cualquier acción nueva requiere auth por defecto
    const PUBLIC_ACTIONS = new Set(['health', 'submitSignature', 'getSigningSession']);
    let auth = null;
    if (!PUBLIC_ACTIONS.has(action)) {
      auth = await authenticateRequest(req);
      if (!auth?.valid) return res.status(401).json({ error: 'No autenticado' });
    }

    // Session user object compatible con código existente
    const su = buildSu(auth);
    // ponytail: aliases — auth ya fue verificada arriba, ambas devuelven el mismo su
    const getSessionUserOnce = async () => su;
    const getSessionUser = async (_pool, _req) => su;

    const appPool = getAppPool();
    if (!appPool) {
      return res.status(500).json({ error: 'Database connection not configured. Check NEON_DATABASE_URL.' });
    }

    // ── Health check ──────────────────────────────────────────────────────
    if (action === 'health') {
      try {
        const client = await appPool.connect();
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

    // Auto-inicializar el schema clínico en el primer uso del contenedor
    if (!dbInitialized) {
      try {
        await initClinicalDatabase();
        dbInitialized = true;
      } catch (e) {
        console.error('⚠️ Clinical DB init warning:', e.message);
      }
    }

    // ── Acquire tenant-scoped client ──────────────────────────────────────
    // is_local=false → session-level; se resetea a '' en el finally antes de release.
    // ponytail: más simple que BEGIN/COMMIT y compatible con early-return en cada case.
    const effectiveClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
    const client = await appPool.connect();

    try {
      await client.query(
        "SELECT set_config('app.current_tenant', $1, false)",
        [effectiveClinicId ? String(effectiveClinicId) : '']
      );

      // ponytail: pool alias para los pocos handlers que usan pool.connect() internamente
      const pool = { query: (...a) => client.query(...a), connect: () => appPool.connect() };

      switch (action) {
      case 'init':
      case 'initClinical':
        return res.status(200).json({ success: true, message: 'Clinical database initialized' });

      // ==========================================
      // INVENTORY MODULE ACTIONS
      // ==========================================

      case 'inventoryListMovements':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const limit = req.query.limit || 100;
          const { type, startDate, endDate } = req.query;
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

          const params = [];
          let paramCount = 1;
          let query = `
            SELECT m.*, i.name as item_name, i.sku, b.batch_number, b.expiration_date
            FROM inventory_movements m
            JOIN inventory_batches b ON m.batch_id = b.id
            JOIN inventory_items i ON b.item_id = i.id
            WHERE 1=1
          `;
          // Filtro tenant via JOIN
          if (invClinicId) {
            query += ` AND (i.clinic_id = $${paramCount} OR i.clinic_id IS NULL)`;
            params.push(invClinicId);
            paramCount++;
          }
          if (type && type !== 'all') {
            if (type === 'IN')  query += ` AND m.quantity_change > 0`;
            if (type === 'OUT') query += ` AND m.quantity_change < 0`;
          }
          if (startDate) { query += ` AND m.created_at >= $${paramCount}`; params.push(startDate); paramCount++; }
          if (endDate)   { query += ` AND m.created_at <= $${paramCount}`; params.push(endDate);   paramCount++; }
          query += ` ORDER BY m.created_at DESC LIMIT $${paramCount}`;
          params.push(Math.min(parseInt(limit) || 100, 500));

          const movements = await pool.query(query, params);
          return res.status(200).json(movements.rows);
        } catch (err) {
          console.error('Error listing movements:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryDeleteMovement':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Sin permiso' });
          const { id } = req.query;
          await pool.query('DELETE FROM inventory_movements WHERE id = $1', [id]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting movement:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryClearMovements':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (su.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
          const { days } = body;
          const daysInt = parseInt(days, 10);
          if (!Number.isFinite(daysInt) || daysInt <= 0)
            return res.status(400).json({ error: 'days debe ser un entero positivo' });
          // Usar parámetro — sin interpolación de string (previene inyección con días negativos)
          await pool.query(`DELETE FROM inventory_movements WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`, [daysInt]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error clearing movements:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryListBatches':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          const params = [];
          let whereClause = `b.status = 'active' AND b.quantity_current > 0`;
          if (invClinicId) {
            whereClause += ` AND (i.clinic_id = $1 OR i.clinic_id IS NULL)`;
            params.push(invClinicId);
          }
          const batches = await pool.query(`
            SELECT b.*, i.name as item_name, i.sku, i.category, i.unit_of_measure
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE ${whereClause}
            ORDER BY b.expiration_date ASC
          `, params);
          return res.status(200).json(batches.rows);
        } catch (err) {
          console.error('Error listing batches:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryListItems':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          const filterByUserId = ['clinic_admin','master_admin'].includes(su?.role) && req.query.filterByUserId
            ? parseInt(req.query.filterByUserId, 10) : null;

          const params = [];
          let pCount = 1;
          const wheres = [];

          if (invClinicId) {
            wheres.push(`(i.clinic_id = $${pCount} OR i.clinic_id IS NULL)`);
            params.push(invClinicId);
            pCount++;
          }
          if (filterByUserId) {
            // Admin filtrando por profesional → ítems propios + ítems compartidos de la clínica
            const fu = invClinicId ? await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 LIMIT 1', [filterByUserId, invClinicId]) : { rows: [{}] };
            if (fu.rows.length) {
              wheres.push(`(i.created_by_user_id = $${pCount} OR i.created_by_user_id IS NULL)`);
              params.push(filterByUserId);
              pCount++;
            }
          } else if (su.access_scope === 'own') {
            // Usuario scope propio: ve sus ítems + ítems de compañeros del mismo grupo + ítems compartidos sin dueño
            wheres.push(`(
              i.created_by_user_id = $${pCount}
              OR i.created_by_user_id IS NULL
              OR i.created_by_user_id IN (
                SELECT sgm2.clinic_user_id
                FROM sharing_group_members sgm1
                JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
                WHERE sgm1.clinic_user_id = $${pCount}
              )
            )`);
            params.push(su.user_id);
            pCount++;
          }

          const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
          const items = await pool.query(`
            SELECT i.*,
              cu.full_name AS created_by_user_name, cu.username AS created_by_username,
              COALESCE(SUM(b.quantity_current), 0) as total_stock,
              COALESCE(SUM(b.quantity_initial), 0) as total_initial,
              COUNT(b.id) as batch_count,
              MIN(b.expiration_date) as next_expiry
            FROM inventory_items i
            LEFT JOIN inventory_batches b ON i.id = b.item_id AND b.status = 'active'
            LEFT JOIN clinic_users cu ON cu.id = i.created_by_user_id
            ${whereClause}
            GROUP BY i.id, cu.full_name, cu.username
            ORDER BY i.name ASC
          `, params);
          return res.status(200).json(items.rows);
        } catch (err) {
          console.error('Error listing inventory:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryStats':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

          // Usar parámetros $1 — sin interpolación de string para clinic_id
          const clinicParam = invClinicId ? [invClinicId] : [];
          const iWhere = invClinicId ? `AND (i.clinic_id = $1 OR i.clinic_id IS NULL)` : '';
          const bWhere = invClinicId ? `JOIN inventory_items ii ON ii.id = b.item_id AND (ii.clinic_id = $1 OR ii.clinic_id IS NULL)` : '';
          const alertWhere = invClinicId ? `AND (i.clinic_id = $1 OR i.clinic_id IS NULL)` : '';

          const statsResult = await pool.query(`
            SELECT
              COUNT(DISTINCT i.id)::int AS total_items,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) = 0 THEN i.id END)::int AS out_of_stock_count,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) > 0 AND COALESCE(stock.total_stock, 0) <= i.min_stock_level THEN i.id END)::int AS low_stock_count
            FROM inventory_items i
            LEFT JOIN (
              SELECT item_id, SUM(quantity_current) AS total_stock
              FROM inventory_batches WHERE status = 'active'
              GROUP BY item_id
            ) stock ON stock.item_id = i.id
            WHERE 1=1 ${iWhere}
          `, clinicParam);

          const batchStats = await pool.query(`
            SELECT
              COUNT(CASE WHEN b.expiration_date < CURRENT_DATE THEN 1 END)::int AS expired_count,
              COUNT(CASE WHEN b.expiration_date >= CURRENT_DATE AND b.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN 1 END)::int AS expiring_soon_count
            FROM inventory_batches b ${bWhere}
            WHERE b.status = 'active'
          `, clinicParam);

          const movementsStats = await pool.query(`
            SELECT COUNT(*)::int AS movements_this_month
            FROM inventory_movements
            WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
          `);

          const alertBatches = await pool.query(`
            SELECT b.id, b.batch_number, b.expiration_date, b.quantity_current,
              i.name AS item_name, i.sku, i.unit_of_measure,
              CASE WHEN b.expiration_date < CURRENT_DATE THEN 'expired'
                   WHEN b.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
              END AS alert_type
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE b.status = 'active'
              AND (b.expiration_date < CURRENT_DATE OR b.expiration_date <= CURRENT_DATE + INTERVAL '30 days')
              ${alertWhere}
            ORDER BY b.expiration_date ASC LIMIT 20
          `, clinicParam);

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
          const su = await getSessionUserOnce();
          const cid = su?.effective_clinic_id ?? su?.clinic_id;
          // Tenant check: restrict item visibility to the user's clinic (A-1 fix)
          const itemResult = cid
            ? await pool.query('SELECT * FROM inventory_items WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)', [itemId, cid])
            : await pool.query('SELECT * FROM inventory_items WHERE id = $1', [itemId]);
          
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
          const suInv = await getSessionUserOnce();
          const invClinicId = suInv?.effective_clinic_id ?? suInv?.clinic_id ?? null;
          const newItem = await pool.query(`
            INSERT INTO inventory_items (clinic_id, sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price, created_by_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
          `, [invClinicId, cleanSku, name, cleanBrand, cleanDescription, category, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
              normalizeOptionalNumber(cost_price),
              normalizeOptionalNumber(sale_price),
              suInv?.user_id ?? null]);
          return res.status(201).json(newItem.rows[0]);
        } catch (err) {
          console.error('Error creating inventory item:', err);
          if (err.code === '23505') {
            return res.status(409).json({ error: 'El SKU ya existe en esta clínica. Usa otro código o deja el campo vacío.' });
          }
          return res.status(500).json({ error: 'Error al crear producto de inventario.' });
        }

      case 'inventoryUpdateItem':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const { id, sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price } = body;
          const cleanSku = normalizeOptionalText(sku);
          const cleanBrand = normalizeOptionalText(brand);
          const cleanDescription = normalizeOptionalText(description);
          const cleanGroupName = normalizeOptionalText(group_name);
          const cleanSanitaryRegistration = normalizeOptionalText(sanitary_registration);
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          // Verificar que el item pertenece a la clínica del usuario
          const clinicCheck = invClinicId
            ? ` AND (clinic_id = $13 OR clinic_id IS NULL)`
            : '';
          const params = [cleanSku, name, cleanBrand, cleanDescription, category, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
            normalizeOptionalNumber(cost_price), normalizeOptionalNumber(sale_price), id];
          if (invClinicId) params.push(invClinicId);
          const updatedItem = await pool.query(
            `UPDATE inventory_items SET sku=$1, name=$2, brand=$3, description=$4, category=$5, group_name=$6, unit_of_measure=$7, min_stock_level=$8, requires_cold_chain=$9, sanitary_registration=$10, cost_price=$11, sale_price=$12 WHERE id=$13${clinicCheck} RETURNING *`,
            params
          );
          if (updatedItem.rows.length === 0) return res.status(404).json({ error: 'Item not found or not in your clinic' });
          return res.status(200).json(updatedItem.rows[0]);
        } catch (err) {
          console.error('Error updating inventory item:', err);
          if (err.code === '23505') return res.status(409).json({ error: 'El SKU ya existe. Usa otro código o deja el campo vacío.' });
          return res.status(500).json({ error: 'Error al actualizar producto de inventario.' });
        }

      case 'inventoryDeleteItem':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Solo administradores pueden eliminar productos' });
          const { id } = req.query;
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          // Verificar ownership antes de eliminar
          if (invClinicId) {
            const check = await pool.query('SELECT id FROM inventory_items WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)', [id, invClinicId]);
            if (check.rows.length === 0) return res.status(403).json({ error: 'Producto no encontrado en tu clínica' });
          }
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const batchesCheck = await client.query('SELECT id FROM inventory_batches WHERE item_id = $1', [id]);
            const batchIds = batchesCheck.rows.map(b => b.id);
            if (batchIds.length > 0) {
              await client.query('DELETE FROM inventory_movements WHERE batch_id = ANY($1)', [batchIds]);
              await client.query('DELETE FROM inventory_batches WHERE item_id = $1', [id]);
            }
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
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Solo administradores pueden eliminar lotes' });
          const { id } = req.query;
          // Tenant check: verify batch belongs to user's clinic (A-1 fix)
          const cid = su?.effective_clinic_id ?? su?.clinic_id;
          if (cid != null && su.role !== 'master_admin') {
            const chk = await pool.query(
              'SELECT i.clinic_id FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id WHERE b.id = $1',
              [id]
            );
            if (chk.rows.length && chk.rows[0].clinic_id !== cid)
              return res.status(403).json({ error: 'Lote no pertenece a esta clínica' });
          }
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
          // Tenant check: verify item belongs to user's clinic before adding stock (A-1 fix)
          const suBatch = await getSessionUserOnce();
          const batchCid = suBatch?.effective_clinic_id ?? suBatch?.clinic_id;
          if (batchCid != null && suBatch?.role !== 'master_admin') {
            const itemChk = await pool.query('SELECT clinic_id FROM inventory_items WHERE id = $1', [item_id]);
            if (itemChk.rows.length && itemChk.rows[0].clinic_id !== batchCid)
              return res.status(403).json({ error: 'Ítem no pertenece a esta clínica' });
          }
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
          // Tenant check: verify batch belongs to user's clinic before consuming (A-1 fix)
          const suCons = await getSessionUserOnce();
          const consCid = suCons?.effective_clinic_id ?? suCons?.clinic_id;
          if (consCid != null && suCons?.role !== 'master_admin') {
            const tenantChk = await pool.query(
              'SELECT i.clinic_id FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id WHERE b.id = $1',
              [batch_id]
            );
            if (tenantChk.rows.length && tenantChk.rows[0].clinic_id !== consCid)
              return res.status(403).json({ error: 'Lote no pertenece a esta clínica' });
          }
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
        // viewAsUserId: master_admin navegando AS un usuario específico → ver exactamente lo que ve ese usuario
        const viewAsUserId  = su?.role === 'master_admin' && req.query.viewAsUserId  ? parseInt(req.query.viewAsUserId,  10) : null;
        // filterByUserId: admin filtrando la vista clínica por profesional (no impersonación)
        const filterByUserId = ['master_admin','clinic_admin'].includes(su?.role) && req.query.filterByUserId ? parseInt(req.query.filterByUserId, 10) : null;

        let pq, pp = [];
        const effectiveClinicId = su?.effective_clinic_id ?? su?.clinic_id;

        // ponytail: helper para queries con owner JOIN — evita repetición
        const fromOwner = `FROM patients p LEFT JOIN clinic_users cu ON cu.id = p.created_by_user_id`;
        const selOwner  = `SELECT p.*, cu.full_name AS created_by_user_name, cu.username AS created_by_username`;
        // filtro de pacientes propios + asignados
        const ownFilter = `AND (p.created_by_user_id = $2 OR EXISTS (SELECT 1 FROM patient_assignments pa WHERE pa.patient_id = p.id AND pa.clinic_user_id = $2))`;

        if (!su || effectiveClinicId == null) {
          // Pre-migración o master sin contexto de clínica
          const cf = req.query.clinicId ? parseInt(req.query.clinicId) : null;
          if (cf) { pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`; pp = [cf]; }
          else    { pq = `${selOwner} ${fromOwner} ORDER BY p.last_name, p.first_name`; }

        } else if (viewAsUserId) {
          // Impersonación: aplicar scope real del usuario destino
          const vu = await pool.query(
            'SELECT access_scope FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true LIMIT 1',
            [viewAsUserId, effectiveClinicId]
          );
          if (vu.rows.length && vu.rows[0].access_scope === 'own') {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId, viewAsUserId];
          } else {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId];
          }

        } else if (filterByUserId) {
          // Filtro por profesional en vista clínica — validar que el usuario pertenezca a esta clínica
          const fu = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 LIMIT 1', [filterByUserId, effectiveClinicId]);
          if (fu.rows.length) {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId, filterByUserId];
          } else {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId];
          }

        } else if (su.access_scope === 'own' || (su.access_scope === 'all' && filterMine)) {
          pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
          pp = [effectiveClinicId, su.user_id];

        } else {
          pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
          pp = [effectiveClinicId];
        }

        // Búsqueda por texto — usar alias p. para evitar ambigüedad con el JOIN
        const searchTerm = req.query.search?.trim();
        if (searchTerm && pp.length > 0) {
          const idx = pp.length + 1;
          pq = pq.replace('ORDER BY', `AND (p.first_name ILIKE $${idx} OR p.last_name ILIKE $${idx} OR p.rut ILIKE $${idx}) ORDER BY`);
          pp.push(`%${searchTerm}%`);
        } else if (searchTerm) {
          pq = `${selOwner} ${fromOwner} WHERE (p.first_name ILIKE $1 OR p.last_name ILIKE $1 OR p.rut ILIKE $1) ORDER BY p.last_name, p.first_name`;
          pp = [`%${searchTerm}%`];
        }

        const limitVal = parseInt(req.query.limit || '500');
        pq += ` LIMIT ${Math.min(limitVal, 1000)}`;
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
        // own-scope: solo permite acceso a pacientes propios o asignados explícitamente
        if (su?.access_scope === 'own' && su.user_id != null) {
          const owned = patient.rows[0].created_by_user_id === su.user_id;
          if (!owned) {
            const asgn = await pool.query(
              'SELECT 1 FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2 LIMIT 1',
              [patient.rows[0].id, su.user_id]
            );
            if (!asgn.rows.length) return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });
          }
        }
        // Also fetch active record ID
        const record = await pool.query('SELECT id FROM clinical_records WHERE patient_id = $1 AND status = \'active\' LIMIT 1', [id]);
        return res.status(200).json({ ...patient.rows[0], active_record_id: record.rows[0]?.id || null });
      }

      case 'listRecords': {
        const { patient_id } = req.query;
        const su = await getSessionUserOnce();
        const cid = su?.effective_clinic_id ?? su?.clinic_id;
        if (cid != null && su?.role !== 'master_admin') {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [patient_id]);
          if (chk.rows.length && chk.rows[0].clinic_id !== cid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        const records = await pool.query(
          'SELECT * FROM clinical_records WHERE patient_id = $1 ORDER BY created_at DESC',
          [patient_id]
        );
        return res.status(200).json(records.rows);
      }

      case 'createRecord': {
        const { patient_id: p_id } = body;
        const su = await getSessionUserOnce();
        const cid = su?.effective_clinic_id ?? su?.clinic_id;
        if (cid != null && su?.role !== 'master_admin') {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [p_id]);
          if (chk.rows.length && chk.rows[0].clinic_id !== cid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        const newRecord = await pool.query(
          "INSERT INTO clinical_records (patient_id, clinic_id, status) VALUES ($1, $2, 'active') RETURNING *",
          [p_id, cid]
        );
        return res.status(201).json(newRecord.rows[0]);
      }

      case 'createPatient':
        try {
          const { first_name, last_name, rut, email, phone, birth_date, gender, address, occupation } = body;
          
          console.log('📝 Creating patient:', { first_name, last_name, rut, email });

          // Handle empty strings as null for optional fields
          const cleanRut = rut && rut.trim() !== '' ? rut.trim() : null;
          const cleanBirthDate = birth_date && birth_date.trim() !== '' ? birth_date : null;

          // Obtener clinic_id y created_by_user_id desde sesión (post-migración)
          const suCreate = await getSessionUser(pool, req);
          // Para master admin viendo una clínica, usar effective_clinic_id
          const patientClinicId = suCreate?.effective_clinic_id ?? suCreate?.clinic_id ?? null;
          const patientCreatedBy = suCreate?.user_id ?? null;

          // Verificar duplicado dentro de la misma clínica antes de insertar
          if (cleanRut && patientClinicId != null) {
            const dup = await pool.query(
              'SELECT id, first_name, last_name, rut, created_by_user_id FROM patients WHERE rut = $1 AND clinic_id = $2',
              [cleanRut, patientClinicId]
            );
            if (dup.rows.length > 0) {
              const conflictType = dup.rows[0].created_by_user_id === patientCreatedBy ? 'same_user' : 'same_clinic';
              return res.status(409).json({ conflict: conflictType, patient: dup.rows[0] });
            }
          }

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
          await pool.query('INSERT INTO clinical_records (patient_id, clinic_id, status) VALUES ($1, $2, \'active\')', [newPatient.rows[0].id, patientClinicId]);
          // Audit
          await logAudit(pool, { patientId: newPatient.rows[0].id, sessionUser: suCreate, actionType: 'create', module: 'patient', summary: `Paciente creado: ${first_name} ${last_name}` });
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
        const suUpd = await getSessionUser(pool, req);
        const ALLOWED_PATIENT_FIELDS = ['first_name', 'last_name', 'rut', 'email', 'phone', 'birth_date', 'gender', 'address', 'occupation'];
        // master_admin puede reasignar clinic_id (para corregir pacientes huérfanos)
        if (suUpd?.role === 'master_admin') ALLOWED_PATIENT_FIELDS.push('clinic_id');
        const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED_PATIENT_FIELDS.includes(k)));
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

      // ─── Importar snapshot de paciente (datos básicos + antecedentes) ────
      case 'importPatientSnapshot': {
        const { source_patient_id, import_fields = ['basic', 'history'] } = body;
        if (!source_patient_id) return res.status(400).json({ error: 'source_patient_id requerido' });

        const suImp = await getSessionUser(pool, req);
        if (!suImp) return res.status(401).json({ error: 'No autenticado' });
        const targetClinicId = suImp.effective_clinic_id ?? suImp.clinic_id;
        if (!targetClinicId) return res.status(400).json({ error: 'Sin clínica activa' });

        // Seguridad: source_patient debe pertenecer a la misma clínica
        const srcChk = await pool.query(
          'SELECT * FROM patients WHERE id = $1 AND clinic_id = $2',
          [source_patient_id, targetClinicId]
        );
        if (!srcChk.rows.length) return res.status(403).json({ error: 'Paciente fuente no encontrado en tu clínica' });
        const src = srcChk.rows[0];

        // Crear nuevo paciente con los datos básicos (sin RUT para evitar conflicto)
        const newRut = import_fields.includes('basic') ? null : null; // RUT se omite; usuario lo asignará
        const insertFields = import_fields.includes('basic')
          ? { first_name: src.first_name, last_name: src.last_name, email: src.email, phone: src.phone,
              birth_date: src.birth_date, gender: src.gender, address: src.address, occupation: src.occupation,
              clinic_id: targetClinicId, created_by_user_id: suImp.user_id }
          : { clinic_id: targetClinicId, created_by_user_id: suImp.user_id, first_name: src.first_name, last_name: src.last_name };

        const newPatient = await pool.query(
          `INSERT INTO patients (first_name, last_name, rut, email, phone, birth_date, gender, address, occupation, clinic_id, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [insertFields.first_name, insertFields.last_name, src.rut,
           insertFields.email || null, insertFields.phone || null,
           insertFields.birth_date || null, insertFields.gender || null,
           insertFields.address || null, insertFields.occupation || null,
           targetClinicId, suImp.user_id || null]
        );
        const newPatientRow = newPatient.rows[0];

        // Crear expediente inicial
        const newRecord = await pool.query(
          "INSERT INTO clinical_records (patient_id, clinic_id, status) VALUES ($1, $2, 'active') RETURNING *",
          [newPatientRow.id, targetClinicId]
        );
        const newRecordRow = newRecord.rows[0];

        // Copiar antecedentes si se solicita
        if (import_fields.includes('history')) {
          const srcRec = await pool.query(
            'SELECT id FROM clinical_records WHERE patient_id = $1 ORDER BY created_at LIMIT 1',
            [source_patient_id]
          );
          if (srcRec.rows.length > 0) {
            const hist = await pool.query(
              'SELECT * FROM medical_history WHERE record_id = $1 ORDER BY updated_at DESC LIMIT 1',
              [srcRec.rows[0].id]
            );
            if (hist.rows.length > 0) {
              const h = hist.rows[0];
              await pool.query(
                `INSERT INTO medical_history
                 (record_id, pathological, non_pathological, family_history, surgical_history,
                  allergies, current_medications, aesthetic_history, gynecological_history)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT DO NOTHING`,
                [newRecordRow.id, h.pathological, h.non_pathological, h.family_history,
                 h.surgical_history, h.allergies, h.current_medications, h.aesthetic_history, h.gynecological_history]
              );
            }
          }
        }

        await logAudit(pool, { patientId: newPatientRow.id, sessionUser: suImp, actionType: 'create', module: 'patient', summary: `Paciente importado desde ID ${source_patient_id}: ${src.first_name} ${src.last_name}` });
        return res.status(201).json({ patient: newPatientRow, record: newRecordRow });
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

      // ─── Listar usuarios de la clínica actual (para UI de asignación) ────
      case 'listClinicUsers': {
        const suLU = await getSessionUser(pool, req);
        if (!suLU) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suLU.role)) return res.status(403).json({ error: 'Sin permisos' });
        const clinicId = suLU.effective_clinic_id ?? suLU.clinic_id;
        if (clinicId == null) return res.status(400).json({ error: 'Sin clínica activa' });
        const usersRes = await pool.query(
          `SELECT id, username, full_name, role, access_scope
           FROM clinic_users WHERE clinic_id = $1 AND is_active = true ORDER BY full_name`,
          [clinicId]
        );
        return res.status(200).json(usersRes.rows);
      }

      // ─── Grupos de compartición (inventario + finanzas) ───────────────────
      case 'listSharingGroups': {
        const suSG = await getSessionUser(pool, req);
        if (!suSG) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suSG.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suSG.effective_clinic_id ?? suSG.clinic_id;
        if (!sgClinic) return res.status(400).json({ error: 'Sin clínica activa' });
        const groups = await pool.query(
          `SELECT sg.id, sg.name, sg.description,
             COALESCE(json_agg(json_build_object('id', cu.id, 'username', cu.username, 'full_name', cu.full_name)
               ORDER BY cu.full_name) FILTER (WHERE cu.id IS NOT NULL), '[]') AS members
           FROM sharing_groups sg
           LEFT JOIN sharing_group_members sgm ON sgm.group_id = sg.id
           LEFT JOIN clinic_users cu ON cu.id = sgm.clinic_user_id
           WHERE sg.clinic_id = $1
           GROUP BY sg.id ORDER BY sg.name`,
          [sgClinic]
        );
        return res.status(200).json(groups.rows);
      }

      case 'manageSharingGroup': {
        // mode: 'create' | 'update' | 'delete'
        const suMSG = await getSessionUser(pool, req);
        if (!suMSG) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suMSG.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suMSG.effective_clinic_id ?? suMSG.clinic_id;
        const { mode, group_id, name, description } = body;
        if (mode === 'create') {
          if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
          const r = await pool.query(
            'INSERT INTO sharing_groups (clinic_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description',
            [sgClinic, name.trim(), description?.trim() || null]
          );
          return res.status(201).json(r.rows[0]);
        }
        if (mode === 'update') {
          await pool.query('UPDATE sharing_groups SET name=$1, description=$2 WHERE id=$3 AND clinic_id=$4', [name?.trim(), description?.trim() || null, group_id, sgClinic]);
          return res.status(200).json({ success: true });
        }
        if (mode === 'delete') {
          await pool.query('DELETE FROM sharing_groups WHERE id=$1 AND clinic_id=$2', [group_id, sgClinic]);
          return res.status(200).json({ success: true });
        }
        return res.status(400).json({ error: 'mode inválido' });
      }

      case 'manageSharingMember': {
        // mode: 'add' | 'remove'
        const suMSM = await getSessionUser(pool, req);
        if (!suMSM) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suMSM.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suMSM.effective_clinic_id ?? suMSM.clinic_id;
        const { mode: mMode, group_id: gId, clinic_user_id: mUid } = body;
        // Verificar que el grupo pertenece a la clínica
        const gChk = await pool.query('SELECT id FROM sharing_groups WHERE id=$1 AND clinic_id=$2', [gId, sgClinic]);
        if (!gChk.rows.length) return res.status(403).json({ error: 'Grupo no encontrado en esta clínica' });
        if (mMode === 'add') {
          await pool.query('INSERT INTO sharing_group_members (group_id, clinic_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gId, mUid]);
        } else if (mMode === 'remove') {
          await pool.query('DELETE FROM sharing_group_members WHERE group_id=$1 AND clinic_user_id=$2', [gId, mUid]);
        }
        return res.status(200).json({ success: true });
      }

      // ─── Asignar/copiar paciente a otro usuario de la clínica ─────────────
      case 'assignPatient': {
        const suAsgn = await getSessionUser(pool, req);
        if (!suAsgn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suAsgn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: asgnPid, target_user_id } = body;
        if (!asgnPid || !target_user_id) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        // Verificar que el paciente pertenece a la clínica del admin
        const clinicIdAsgn = suAsgn.effective_clinic_id ?? suAsgn.clinic_id;
        const patChk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [asgnPid]);
        if (!patChk.rows.length || patChk.rows[0].clinic_id !== clinicIdAsgn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        // Verificar que el usuario destino pertenece a la misma clínica
        const userChk = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true', [target_user_id, clinicIdAsgn]);
        if (!userChk.rows.length) return res.status(404).json({ error: 'Usuario destino no encontrado en esta clínica' });
        await pool.query(
          `INSERT INTO patient_assignments (patient_id, clinic_user_id, assigned_by)
           VALUES ($1, $2, $3) ON CONFLICT (patient_id, clinic_user_id) DO NOTHING`,
          [asgnPid, target_user_id, suAsgn.user_id]
        );
        await logAudit(pool, { patientId: asgnPid, sessionUser: suAsgn, actionType: 'assign', module: 'patient', summary: `Paciente asignado al usuario ID ${target_user_id}` });
        return res.status(200).json({ success: true });
      }

      // ─── Remover asignación de un paciente a un usuario ──────────────────
      case 'unassignPatient': {
        const suUnasgn = await getSessionUser(pool, req);
        if (!suUnasgn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suUnasgn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: unasgnPid, target_user_id: unasgnUid } = body;
        if (!unasgnPid || !unasgnUid) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        const clinicIdUnasgn = suUnasgn.effective_clinic_id ?? suUnasgn.clinic_id;
        const patChkU = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [unasgnPid]);
        if (!patChkU.rows.length || patChkU.rows[0].clinic_id !== clinicIdUnasgn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        await pool.query('DELETE FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2', [unasgnPid, unasgnUid]);
        await logAudit(pool, { patientId: unasgnPid, sessionUser: suUnasgn, actionType: 'unassign', module: 'patient', summary: `Asignación removida del usuario ID ${unasgnUid}` });
        return res.status(200).json({ success: true });
      }

      // ─── Trasladar paciente: cambia el propietario (created_by_user_id) ──
      case 'transferPatient': {
        const suTrn = await getSessionUser(pool, req);
        if (!suTrn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suTrn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: trnPid, target_user_id: trnUid } = body;
        if (!trnPid || !trnUid) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        const clinicIdTrn = suTrn.effective_clinic_id ?? suTrn.clinic_id;
        const patChkT = await pool.query('SELECT clinic_id, created_by_user_id FROM patients WHERE id = $1', [trnPid]);
        if (!patChkT.rows.length || patChkT.rows[0].clinic_id !== clinicIdTrn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        const userChkT = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true', [trnUid, clinicIdTrn]);
        if (!userChkT.rows.length) return res.status(404).json({ error: 'Usuario destino no encontrado en esta clínica' });
        const prevOwner = patChkT.rows[0].created_by_user_id;
        await pool.query('UPDATE patients SET created_by_user_id = $1, updated_at = NOW() WHERE id = $2', [trnUid, trnPid]);
        // Eliminar asignación previa del nuevo propietario si existía (evita duplicado lógico)
        await pool.query('DELETE FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2', [trnPid, trnUid]);
        await logAudit(pool, { patientId: trnPid, sessionUser: suTrn, actionType: 'transfer', module: 'patient', summary: `Paciente trasladado de usuario ID ${prevOwner} a ID ${trnUid}` });
        return res.status(200).json({ success: true });
      }

      case 'deleteRecord': {
        const { id: delRecordId } = req.query;
        // Tenant check: verify record belongs to user's clinic (C-3 fix)
        const suDR = await getSessionUserOnce();
        const drCid = suDR?.effective_clinic_id ?? suDR?.clinic_id;
        if (drCid != null && suDR?.role !== 'master_admin') {
          const chk = await pool.query(
            'SELECT p.clinic_id FROM patients p JOIN clinical_records cr ON cr.patient_id = p.id WHERE cr.id = $1',
            [delRecordId]
          );
          if (chk.rows.length && chk.rows[0].clinic_id !== drCid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        try {
          await pool.query('DELETE FROM clinical_records WHERE id = $1', [delRecordId]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting record:', err);
          return res.status(500).json({ error: 'Error al eliminar expediente.' });
        }
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
             const newRec = await pool.query('INSERT INTO clinical_records (patient_id, clinic_id, status) VALUES ($1, $2, \'active\') RETURNING id', [patientId, effectiveClinicId]);
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

        // Tenant check: verify the record's patient belongs to the authenticated user's clinic (C-1 fix)
        const suGrd = await getSessionUserOnce();
        const grdCid = suGrd?.effective_clinic_id ?? suGrd?.clinic_id;
        if (grdCid != null && suGrd?.role !== 'master_admin') {
          const pChk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [patientIdFromRecord]);
          if (pChk.rows.length && pChk.rows[0].clinic_id !== grdCid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }

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
          safeQuery('SELECT * FROM consultations WHERE record_id = $1 ORDER BY created_at DESC', [targetRecordId])
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
          consultations: consultationHistory.rows || []
        });
      }

      case 'deleteConsultationHistory': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'ID required' });
        await pool.query('DELETE FROM consultation_history WHERE id = $1', [id]);
        return res.status(200).json({ success: true });
      }

      // ── Consultas (hub de sesión) ────────────────────────────────────────

      case 'listConsultations': {
        const { record_id: lcRid } = req.query;
        if (!lcRid) return res.status(400).json({ error: 'record_id required' });
        const lcRes = await pool.query(
          'SELECT * FROM consultations WHERE record_id = $1 ORDER BY created_at DESC',
          [lcRid]
        );
        return res.status(200).json(lcRes.rows);
      }

      case 'createConsultation': {
        const { record_id: ccRid, reason: ccReason, current_illness: ccIllness,
                enable_injectables: ccInj = false, enable_consents: ccCons = false } = body;
        if (!ccRid) return res.status(400).json({ error: 'record_id required' });
        const newCons = await pool.query(
          `INSERT INTO consultations (record_id, clinic_id, reason, current_illness, enable_injectables, enable_consents)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [ccRid, effectiveClinicId, ccReason, ccIllness, ccInj, ccCons]
        );
        await logAudit(pool, { recordId: ccRid, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'consultation', summary: `Nueva consulta: ${ccReason || ''}` });
        return res.status(201).json(newCons.rows[0]);
      }

      case 'updateConsultation': {
        const { id: ucId, ...ucFields } = body;
        if (!ucId) return res.status(400).json({ error: 'id required' });
        const allowed = ['reason', 'current_illness', 'enable_injectables', 'enable_consents'];
        const safe = Object.fromEntries(Object.entries(ucFields).filter(([k]) => allowed.includes(k)));
        if (!Object.keys(safe).length) return res.status(400).json({ error: 'No valid fields' });
        const setClause = Object.keys(safe).map((f, i) => `${f} = $${i + 2}`).join(', ');
        const ucRow = await pool.query(
          `UPDATE consultations SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [ucId, ...Object.values(safe)]
        );
        return res.status(200).json(ucRow.rows[0] || { success: true });
      }

      case 'deleteConsultation': {
        const { id: dcId } = req.query;
        if (!dcId) return res.status(400).json({ error: 'id required' });
        await pool.query('DELETE FROM consultations WHERE id = $1', [dcId]);
        return res.status(200).json({ success: true });
      }

      case 'listHistorySnapshots': {
        const { record_id: lhsRid } = req.query;
        if (!lhsRid) return res.status(400).json({ error: 'record_id required' });
        const snaps = await pool.query(
          'SELECT id, changed_by, created_at, snapshot_data FROM medical_history_snapshots WHERE record_id = $1 ORDER BY created_at DESC',
          [lhsRid]
        );
        return res.status(200).json(snaps.rows);
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
            'INSERT INTO consultation_info (record_id, clinic_id, reason, current_illness) VALUES ($1, $2, $3, $4)',
            [recordId, effectiveClinicId, reason, current_illness]
          );
        }
        
        // Save to history
        if ((reason && reason.trim()) || (current_illness && current_illness.trim())) {
          try {
            await pool.query(
              'INSERT INTO consultation_history (record_id, clinic_id, reason, current_illness) VALUES ($1, $2, $3, $4)',
              [recordId, effectiveClinicId, reason, current_illness]
            );
          } catch (histErr) {
            console.error('Error saving consultation history:', histErr);
          }
        }
        await logAudit(pool, { recordId, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'consultation', summary: 'Guardó Motivo de Consulta' });
        return res.status(200).json({ success: true });
      }

      case 'saveHistory': {
        const { record_id: hid, ...historyData } = body;
        delete historyData.id;
        delete historyData.created_at;
        delete historyData.updated_at;
        // Whitelist: solo identificadores SQL válidos (\w+) — previene SQL injection por nombres de columna
        const safeHistData = Object.fromEntries(Object.entries(historyData).filter(([k]) => /^\w+$/.test(k)));

        const existingHistory = await pool.query('SELECT id FROM medical_history WHERE record_id = $1', [hid]);
        if (existingHistory.rows.length > 0) {
           const hFields = Object.keys(safeHistData);
           const hValues = Object.values(safeHistData);
           if (hFields.length > 0) {
             const hSet = hFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE medical_history SET ${hSet}, updated_at = NOW() WHERE record_id = $1`, [hid, ...hValues]);
           }
        } else {
           const safeHistNoClinic = Object.fromEntries(Object.entries(safeHistData).filter(([k]) => k !== 'clinic_id'));
           const hFields = ['record_id', 'clinic_id', ...Object.keys(safeHistNoClinic)];
           const hValues = [hid, effectiveClinicId, ...Object.values(safeHistNoClinic)];
           const hParams = hFields.map((_, i) => `$${i + 1}`).join(', ');
           await pool.query(`INSERT INTO medical_history (${hFields.join(', ')}) VALUES (${hParams})`, hValues);
        }
        await logAudit(pool, { recordId: hid, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'history', summary: 'Guardó Antecedentes Médicos' });
        // Save full snapshot for version history
        try {
          const snapUser = (await getSessionUserOnce())?.username || 'unknown';
          await pool.query(
            'INSERT INTO medical_history_snapshots (record_id, clinic_id, snapshot_data, changed_by) VALUES ($1, $2, $3, $4)',
            [hid, effectiveClinicId, JSON.stringify(safeHistData), snapUser]
          );
        } catch (snapErr) { console.warn('Snapshot save warning:', snapErr.message); }
        return res.status(200).json({ success: true });
      }

      case 'savePhysicalExam': {
        const { id: examId, record_id: pid_exam, created_at, ...examData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        const safeExamData = Object.fromEntries(Object.entries(examData).filter(([k]) => /^\w+$/.test(k)));
        
        if (examId) {
           const eFields = Object.keys(safeExamData);
           const eValues = Object.values(safeExamData);
           if (eFields.length > 0) {
             const eSet = eFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE physical_exams SET ${eSet} WHERE id = $1`, [examId, ...eValues]);
           }
        } else {
           if (!pid_exam) return res.status(400).json({ error: 'Falta el ID del expediente (record_id)' });
           const eFields = ['record_id', ...Object.keys(safeExamData)];
           const eValues = [pid_exam, ...Object.values(safeExamData)];
           const eParams = eFields.map((_, i) => `$${i + 1}`).join(', ');
           await pool.query(`INSERT INTO physical_exams (${eFields.join(', ')}) VALUES (${eParams})`, eValues);
        }
        return res.status(200).json({ success: true });
      }

      case 'deletePhysicalExam':
        const { id: delExamId } = req.query;
        await pool.query('DELETE FROM physical_exams WHERE id = $1', [delExamId]);
        return res.status(200).json({ success: true });

      case 'saveDiagnosis': {
        const { id: diagId, record_id: did, date: diagDate, ...diagData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        const safeDiagData = Object.fromEntries(Object.entries(diagData).filter(([k]) => /^\w+$/.test(k)));
        if (diagId) {
           const dFields = Object.keys(safeDiagData);
           const dValues = Object.values(safeDiagData);
           if (dFields.length > 0) {
             const dSet = dFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE diagnoses SET ${dSet} WHERE id = $1`, [diagId, ...dValues]);
           }
           return res.status(200).json({ success: true });
        } else {
           const dFields = ['record_id', ...Object.keys(safeDiagData)];
           const dValues = [did, ...Object.values(safeDiagData)];
           const dParams = dFields.map((_, i) => `$${i + 1}`).join(', ');
           const newDiag = await pool.query(`INSERT INTO diagnoses (${dFields.join(', ')}) VALUES (${dParams}) RETURNING *`, dValues);
           await logAudit(pool, { recordId: did, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'diagnosis', summary: 'Registró Diagnóstico' });
           return res.status(201).json(newDiag.rows[0]);
        }
      }

      case 'deleteDiagnosis':
        const { id: delDiagId } = req.query;
        await pool.query('DELETE FROM diagnoses WHERE id = $1', [delDiagId]);
        return res.status(200).json({ success: true });

      case 'addTreatment': {
        const { record_id: tid, ...treatData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        const safeTreatData = Object.fromEntries(Object.entries(treatData).filter(([k]) => /^\w+$/.test(k)));
        const tFields = ['record_id', ...Object.keys(safeTreatData)];
        const tValues = [tid, ...Object.values(safeTreatData)];
        const tParams = tFields.map((_, i) => `$${i + 1}`).join(', ');
        const newTreat = await pool.query(`INSERT INTO treatments (${tFields.join(', ')}) VALUES (${tParams}) RETURNING *`, tValues);
        await logAudit(pool, { recordId: tid, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'treatment', summary: `Agregó tratamiento: ${safeTreatData.name || safeTreatData.procedure_name || ''}` });
        return res.status(201).json(newTreat.rows[0]);
      }

      case 'updateTreatment': {
        const { id: upTreatId, ...upTreatData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        const safeUpTreat = Object.fromEntries(Object.entries(upTreatData).filter(([k]) => /^\w+$/.test(k)));
        const upTFields = Object.keys(safeUpTreat);
        const upTValues = Object.values(safeUpTreat);
        if (upTFields.length > 0) {
          const upTSet = upTFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
          await pool.query(`UPDATE treatments SET ${upTSet} WHERE id = $1`, [upTreatId, ...upTValues]);
        }
        return res.status(200).json({ success: true });
      }

      case 'updateSchema':
        try {
          await pool.query('ALTER TABLE treatments ADD COLUMN IF NOT EXISTS ai_suggestion TEXT');
          return res.status(200).json({ message: 'Schema updated successfully' });
        } catch (err) {
          console.error('Schema update error:', err);
          return res.status(500).json({ error: err.message });
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
          'technique', 'injection_plane', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date', 'relleno_subtype', 'consultation_id'
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
        await logAudit(pool, { recordId: injRecId, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'injectable', summary: `Registró inyectable: ${cleanData.product_name || ''} (${cleanData.product_type || ''})` });
        return res.status(201).json(newInj.rows[0]);
      }

      case 'updateInjectable': {
        const { id: updInjId, ...updInjData } = body;
        if (!updInjId) return res.status(400).json({ error: 'id required' });

        const allowedFields = [
          'date', 'product_type', 'product_name', 'brand', 'lot_number',
          'expiration_date', 'volume_used', 'units_used', 'areas_treated',
          'technique', 'injection_plane', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date', 'relleno_subtype', 'consultation_id'
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

      // ── Catálogo global de inyectables (seeds gestionados por master admin) ──

      case 'listInjectableCatalog': {
        const cat = await pool.query(
          'SELECT id, categoria, elemento, descripcion FROM injectable_catalog WHERE activo = 1 ORDER BY categoria, elemento'
        );
        return res.status(200).json(cat.rows);
      }

      case 'saveInjectableSeed': {
        const sess = await getSessionUserOnce();
        if (!sess || sess.role !== 'master_admin') return res.status(403).json({ error: 'Forbidden' });
        const { id: seedId, categoria: seedCat, elemento: seedEl, descripcion: seedDesc } = body;
        if (!seedCat || !seedEl) return res.status(400).json({ error: 'categoria y elemento requeridos' });
        if (seedId) {
          await pool.query(
            'UPDATE injectable_catalog SET categoria=$2, elemento=$3, descripcion=$4 WHERE id=$1',
            [seedId, seedCat.trim(), seedEl.trim(), seedDesc || null]
          );
          return res.status(200).json({ success: true });
        }
        const newSeed = await pool.query(
          'INSERT INTO injectable_catalog(categoria, elemento, descripcion) VALUES($1,$2,$3) RETURNING id',
          [seedCat.trim(), seedEl.trim(), seedDesc || null]
        );
        return res.status(201).json(newSeed.rows[0]);
      }

      case 'deleteInjectableSeed': {
        const sess = await getSessionUserOnce();
        if (!sess || sess.role !== 'master_admin') return res.status(403).json({ error: 'Forbidden' });
        const { id: delSeedId } = req.query;
        if (!delSeedId) return res.status(400).json({ error: 'id required' });
        await pool.query('UPDATE injectable_catalog SET activo=0 WHERE id=$1', [delSeedId]);
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

      case 'createPrescription': {
        const { ficha_id, fecha, diagnostico, items, consultation_id: prescConsId } = body;
        const prescFields = ['record_id', 'date', 'diagnosis', 'items'];
        const prescValues = [ficha_id, fecha, diagnostico, JSON.stringify(items)];
        if (prescConsId) { prescFields.push('consultation_id'); prescValues.push(prescConsId); }
        const prescParams = prescFields.map((_, i) => `$${i + 1}`).join(', ');
        const newPresc = await pool.query(
          `INSERT INTO prescriptions (${prescFields.join(', ')}) VALUES (${prescParams}) RETURNING id`,
          prescValues
        );
        await logAudit(pool, { recordId: ficha_id, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'prescription', summary: `Creó receta médica` });
        return res.status(200).json({ id: newPresc.rows[0].id, message: 'Receta created' });
      }

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
        const { name, signature, cedula } = body;
        const existing = await pool.query('SELECT id FROM professional_signatures WHERE professional_name = $1', [name]);
        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE professional_signatures SET signature_data = $1, cedula = $2, updated_at = NOW() WHERE professional_name = $3',
            [signature, cedula || null, name]
          );
        } else {
          await pool.query(
            'INSERT INTO professional_signatures (professional_name, signature_data, cedula) VALUES ($1, $2, $3)',
            [name, signature, cedula || null]
          );
        }
        return res.status(200).json({ success: true });
      }

      case 'getProfessionalSignature': {
        const { name } = req.query;
        const result = await pool.query(
          'SELECT signature_data, cedula FROM professional_signatures WHERE professional_name = $1',
          [name]
        );
        return res.status(200).json({
          signature: result.rows[0]?.signature_data || null,
          cedula: result.rows[0]?.cedula || null
        });
      }

      case 'listProfessionalSignatures': {
        const sigList = await pool.query(
          'SELECT id, professional_name, cedula, created_at FROM professional_signatures ORDER BY professional_name ASC'
        );
        return res.status(200).json(sigList.rows);
      }

      case 'generateSigningToken': {
        const { id: signId } = body;
        if (!signId) return res.status(400).json({ error: 'Consent ID required' });
        // ponytail: Math.random() es predecible — usar randomBytes para tokens de firma médica
        const token = crypto.randomBytes(32).toString('hex');
        
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

      case 'listAuditLog': {
        const { patient_id: auditPid, record_id: auditRid, limit: auditLimit } = req.query;
        if (!auditPid && !auditRid) return res.status(400).json({ error: 'patient_id o record_id requerido' });
        const q = auditPid
          ? `SELECT * FROM patient_audit_log WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2`
          : `SELECT l.* FROM patient_audit_log l
             JOIN clinical_records cr ON cr.id = l.record_id
             WHERE cr.patient_id = (SELECT patient_id FROM clinical_records WHERE id = $1)
               OR l.record_id = $1
             ORDER BY l.created_at DESC LIMIT $2`;
        const logs = await pool.query(q, [auditPid || auditRid, parseInt(auditLimit || '50')]);
        return res.status(200).json(logs.rows);
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

      // ==========================================
      // FINANCE MODULE ACTIONS
      // ==========================================

      case 'financeCreate': {
        const su = await getSessionUserOnce();
        const { date, invoice_number, entity, description, type, subtotal, tax, total } = body;
        if (!entity || !type) return res.status(400).json({ error: 'Entidad y tipo son requeridos' });
        const clinicId   = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        const regBy      = su?.username ?? 'manual';
        const sub  = parseFloat(subtotal || 0);
        const taxV = parseFloat(tax  || 0);
        const tot  = parseFloat(total || 0) || (sub + taxV);
        try {
          const r = await pool.query(
            `INSERT INTO financial_records (date, invoice_number, entity, description, type, subtotal, tax, total, registered_by, clinic_id, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [date || new Date().toISOString().split('T')[0], invoice_number || null, entity, description || null, type, sub, taxV, tot, regBy, clinicId, su?.user_id ?? null]
          );
          return res.status(201).json(r.rows[0]);
        } catch (err) {
          console.error('Error creating finance record:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeUsers': {
        // Devuelve los usuarios de la clínica con su estado de visibilidad de finanzas
        const su = await getSessionUserOnce();
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        if (!clinicId && su?.role !== 'master_admin') return res.status(403).json({ error: 'Sin contexto de clínica' });
        try {
          // Usuarios de la clínica (excluyendo master_admin)
          let usersQuery = `SELECT id, username, full_name, role FROM clinic_users WHERE role != 'master_admin' AND is_active = true`;
          const usersParams = [];
          if (clinicId) { usersQuery += ` AND clinic_id = $1`; usersParams.push(clinicId); }
          // ponytail: @vercel/postgres no está disponible aquí — usamos pool (neon-clinical-db)
          // La tabla clinic_users vive en la misma BD (misma NEON_DATABASE_URL)
          const usersRes = await pool.query(usersQuery, usersParams);

          // Overrides de visibilidad de finanzas por usuario
          const userIds  = usersRes.rows.map(u => u.id);
          let overrides = {};
          if (userIds.length) {
            try {
              const ovr = await pool.query(
                `SELECT clinic_user_id, enabled FROM user_module_overrides WHERE feature = 'finanzas_visible' AND clinic_user_id = ANY($1)`,
                [userIds]
              );
              ovr.rows.forEach(r => { overrides[r.clinic_user_id] = r.enabled; });
            } catch (ovrErr) {
              // ponytail: si la tabla aun no existe, ignorar — todos visibles por defecto
              if (ovrErr.code !== '42P01') throw ovrErr;
            }
          }

          const users = usersRes.rows.map(u => ({
            id:         u.id,
            username:   u.username,
            full_name:  u.full_name || u.username,
            role:       u.role,
            // Si no hay override → visible (true). Si hay override con enabled=false → no visible
            finance_visible: overrides[u.id] !== false,
          }));
          return res.status(200).json(users);
        } catch (err) {
          console.error('Error fetching finance users:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeItemsGet': {
        const { record_id } = req.query;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        // Verificar que el record pertenece a la clínica
        const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
        if (clinicId) {
          const chk = await pool.query('SELECT id FROM financial_records WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)', [record_id, clinicId]);
          if (!chk.rows.length) return res.status(403).json({ error: 'Sin acceso' });
        }
        try {
          const items = await pool.query(
            'SELECT * FROM financial_items WHERE record_id = $1 ORDER BY sort_order, id ASC',
            [record_id]
          );
          return res.status(200).json(items.rows);
        } catch (err) {
          if (err.code === '42P01') return res.status(200).json([]); // tabla no existe aún
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeItemsSave': {
        // Guarda/reemplaza los items de una factura y recalcula totales del record
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        const { record_id, items } = body;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un array' });

        const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
        // Verificar ownership
        if (clinicId) {
          const chk = await pool.query('SELECT id FROM financial_records WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)', [record_id, clinicId]);
          if (!chk.rows.length) return res.status(403).json({ error: 'Sin acceso' });
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Borrar items anteriores
          await client.query('DELETE FROM financial_items WHERE record_id = $1', [record_id]);

          let totalSubtotal = 0, totalTax = 0, totalTotal = 0;

          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const qty      = parseFloat(it.quantity  || 1);
            const uprice   = parseFloat(it.unit_price || 0);
            const ivaRate  = parseFloat(it.iva_rate   || 0);
            const subtotal = parseFloat((qty * uprice).toFixed(2));
            const tax      = parseFloat((subtotal * ivaRate / 100).toFixed(2));
            const total    = parseFloat((subtotal + tax).toFixed(2));
            totalSubtotal += subtotal;
            totalTax      += tax;
            totalTotal    += total;
            await client.query(
              `INSERT INTO financial_items (record_id, description, quantity, unit_price, iva_rate, subtotal, tax, total, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [record_id, it.description, qty, uprice, ivaRate,
               subtotal, tax, total, i]
            );
          }

          // Si hay items, actualizar totales del record padre
          if (items.length > 0) {
            await client.query(
              `UPDATE financial_records SET subtotal=$1, tax=$2, total=$3 WHERE id=$4`,
              [totalSubtotal.toFixed(2), totalTax.toFixed(2), totalTotal.toFixed(2), record_id]
            );
          }

          await client.query('COMMIT');
          return res.status(200).json({ success: true, subtotal: totalSubtotal, tax: totalTax, total: totalTotal });
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('Error saving finance items:', err);
          return res.status(500).json({ error: err.message });
        } finally {
          client.release();
        }
      }

      case 'financeList': {
        const su = await getSessionUserOnce();
        const { startDate, endDate, registered_by } = req.query;
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

        let query = `SELECT * FROM financial_records WHERE 1=1`;
        const params = [];
        let paramCount = 1;

        // Filtro por clínica (multi-tenant)
        if (clinicId) {
          query += ` AND (clinic_id = $${paramCount} OR clinic_id IS NULL)`;
          params.push(clinicId);
          paramCount++;
        }

        // Respetar access_scope: 'own' restringe al usuario actual + grupo; 'all' permite ver toda la clínica
        if (su?.access_scope === 'own') {
          query += ` AND (
            registered_by = $${paramCount}
            OR registered_by IN (
              SELECT cu2.username
              FROM sharing_group_members sgm1
              JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
              JOIN clinic_users cu2 ON cu2.id = sgm2.clinic_user_id
              WHERE sgm1.clinic_user_id = $${paramCount + 1}
            )
          )`;
          params.push(su.username, su.user_id);
          paramCount += 2;
        } else if (registered_by && registered_by !== 'all' && registered_by !== 'null' && registered_by !== 'undefined') {
          // Soporta lista separada por comas: "user1,user2,user3"
          const users = String(registered_by).split(',').map(u => u.trim()).filter(Boolean);
          if (users.length === 1) {
            query += ` AND registered_by = $${paramCount}`;
            params.push(users[0]);
            paramCount++;
          } else if (users.length > 1) {
            // ponytail: unnest con ANY es idiomático en PostgreSQL y previene SQL injection
            query += ` AND registered_by = ANY($${paramCount}::text[])`;
            params.push(users);
            paramCount++;
          }
        }

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
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(su.role))
          return res.status(403).json({ error: 'Solo administradores pueden eliminar registros' });
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        try {
          const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
          if (su.role === 'master_admin') {
            await pool.query('DELETE FROM financial_records WHERE id = $1', [id]);
          } else {
            await pool.query('DELETE FROM financial_records WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)', [id, clinicId]);
          }
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
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(su.role))
          return res.status(403).json({ error: 'Solo administradores pueden editar registros' });
        const { id, date, invoice_number, entity, description, type, subtotal, tax, total } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        if (!['ingreso', 'egreso'].includes(type))
          return res.status(400).json({ error: 'Tipo inválido. Use ingreso o egreso' });

        try {
          const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
          if (su.role === 'master_admin') {
            await pool.query(
              `UPDATE financial_records SET date=$1, invoice_number=$2, entity=$3, description=$4, type=$5, subtotal=$6, tax=$7, total=$8 WHERE id=$9`,
              [date, invoice_number, entity, description, type, subtotal, tax, total, id]
            );
          } else {
            await pool.query(
              `UPDATE financial_records SET date=$1, invoice_number=$2, entity=$3, description=$4, type=$5, subtotal=$6, tax=$7, total=$8 WHERE id=$9 AND (clinic_id=$10 OR clinic_id IS NULL)`,
              [date, invoice_number, entity, description, type, subtotal, tax, total, id, clinicId]
            );
          }
          return res.status(200).json({ success: true, message: 'Record updated' });
        } catch (err) {
          console.error('Error updating finance record:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });

      // ==========================================
      // PHOTOS MODULE (Cloudflare R2)
      // ==========================================

      case 'getPhotoUploadUrl': {
        // Returns a presigned PUT URL — the client uploads directly to R2, never via server
        const { record_id, content_type, photo_type, consultation_id } = body;
        if (!record_id || !content_type) return res.status(400).json({ error: 'record_id y content_type requeridos' });
        const allowed = ['image/jpeg','image/png','image/webp','image/heic'];
        if (!allowed.includes(content_type)) return res.status(400).json({ error: 'Tipo de archivo no permitido' });

        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        const r2Key = `clinics/${clinicId}/records/${record_id}/photos/${crypto.randomUUID()}.${content_type.split('/')[1]}`;
        try {
          const presignedUrl = await generateUploadUrl(r2Key, content_type);
          return res.status(200).json({ presignedUrl, r2Key });
        } catch (err) {
          console.error('R2 upload URL error:', err);
          return res.status(503).json({ error: 'Almacenamiento no configurado — Configure R2_ACCESS_KEY_ID en Vercel' });
        }
      }

      case 'confirmPhotoUpload': {
        const { record_id, r2_key, photo_type = 'general', face_zone, body_zone, session_label, notes, consultation_id, taken_at } = body;
        if (!record_id || !r2_key) return res.status(400).json({ error: 'record_id y r2_key requeridos' });
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        try {
          const result = await pool.query(
            `INSERT INTO clinical_photos (record_id, consultation_id, clinic_id, r2_key, photo_type, face_zone, body_zone, session_label, notes, taken_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, r2_key, photo_type, created_at`,
            [record_id, consultation_id||null, clinicId, r2_key, photo_type, face_zone||null, body_zone||null, session_label||null, notes||null, taken_at||null]
          );
          return res.status(201).json(result.rows[0]);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'listPhotos': {
        const { record_id } = req.query;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        try {
          const result = await pool.query(
            `SELECT id, r2_key, photo_type, face_zone, body_zone, session_label, notes, taken_at, created_at
             FROM clinical_photos WHERE record_id = $1 ORDER BY taken_at DESC`,
            [record_id]
          );
          // Generar read URLs firmadas (1h) para cada foto
          const photos = await Promise.all(result.rows.map(async (p) => {
            try { return { ...p, url: await generateReadUrl(p.r2_key) }; }
            catch { return { ...p, url: null }; }
          }));
          return res.status(200).json(photos);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'updatePhoto': {
        const { id, photo_type, face_zone, body_zone, session_label, notes } = body;
        if (!id) return res.status(400).json({ error: 'id requerido' });
        try {
          await pool.query(
            `UPDATE clinical_photos SET photo_type=$1, face_zone=$2, body_zone=$3, session_label=$4, notes=$5 WHERE id=$6`,
            [photo_type||null, face_zone||null, body_zone||null, session_label||null, notes||null, id]
          );
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'deletePhoto': {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id requerido' });
        try {
          const r = await pool.query('SELECT r2_key FROM clinical_photos WHERE id = $1', [id]);
          if (!r.rows.length) return res.status(404).json({ error: 'Foto no encontrada' });
          await deleteR2Object(r.rows[0].r2_key);
          await pool.query('DELETE FROM clinical_photos WHERE id = $1', [id]);
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }
    }
    } finally {
      // Limpiar tenant antes de devolver la conexión al pool
      try { await client.query("SELECT set_config('app.current_tenant', '', false)"); } catch {}
      client.release();
    }
  } catch (error) {
    console.error('Clinical Records API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
