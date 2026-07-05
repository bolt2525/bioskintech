
import { Pool } from '@neondatabase/serverless';

const ALLOWED_UPDATE_FIELDS = [
  'ticket_number',
  'document_type',
  'client_name',
  'client_contact',
  'client_cedula',
  'client_center',
  'equipment_data',
  'checklist_data',
  'diagnosis',
  'recommendations',
  'total_cost',
  'status'
];

const DOC_PREFIX = {
  reception: 'REC',
  technical_report: 'INF',
  proforma: 'PRO',
  delivery_receipt: 'ENT'
};

function toDbCost(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function generateTicketBase(docType) {
  const prefix = DOC_PREFIX[docType] || 'TEC';
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rnd = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}-${y}${m}${d}-${rnd}`;
}

async function generateUniqueTicket(pool, docType) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateTicketBase(docType);
    const exists = await pool.query(
      'SELECT 1 FROM technical_service_documents WHERE ticket_number = $1 LIMIT 1',
      [candidate]
    );
    if (exists.rows.length === 0) return candidate;
  }

  return `${generateTicketBase(docType)}-${Date.now().toString().slice(-3)}`;
}

let _migrated = false;

async function ensureColumns(pool) {
  if (_migrated) return;
  try {
    await pool.query('ALTER TABLE technical_service_documents ADD COLUMN IF NOT EXISTS client_cedula VARCHAR(20)');
    await pool.query('ALTER TABLE technical_service_documents ADD COLUMN IF NOT EXISTS client_center VARCHAR(200)');
    _migrated = true;
  } catch (e) {
    console.warn('Auto-migration warning:', e.message);
  }
}

export default async function handler(request, response) {
  const connectionString = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
  
  if (!connectionString) {
    return response.status(500).json({ error: 'Database configuration missing' });
  }

  const pool = new Pool({ connectionString });
  
  await ensureColumns(pool);
  
  if (request.method === 'GET') {
    const { id, type, status, search, client, mode, limit = 50 } = request.query;
    
    try {
      if (mode === 'clients') {
        const parsedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
        const rawSearch = String(search || '').trim();
        const like = `%${rawSearch}%`;
        const digits = rawSearch.replace(/\D/g, '');

        const result = await pool.query(
          `SELECT
             TRIM(client_name) AS client_name,
             MAX(NULLIF(client_contact, '')) AS client_contact,
             MAX(NULLIF(client_cedula, '')) AS client_cedula,
             MAX(NULLIF(client_center, '')) AS client_center,
             COUNT(*)::int AS documents_count,
             MAX(COALESCE(updated_at, created_at)) AS last_activity
           FROM technical_service_documents
           WHERE client_name IS NOT NULL
             AND TRIM(client_name) <> ''
             AND (
               $1 = ''
               OR client_name ILIKE $2
               OR COALESCE(client_contact, '') ILIKE $2
               OR (
                 $3 <> ''
                 AND regexp_replace(COALESCE(client_contact, ''), '[^0-9]', '', 'g') LIKE '%' || $3 || '%'
               )
             )
           GROUP BY TRIM(client_name)
           ORDER BY MAX(COALESCE(updated_at, created_at)) DESC
           LIMIT ${parsedLimit}`,
          [rawSearch, like, digits]
        );

        return response.status(200).json(result.rows);
      }

      if (id) {
         const result = await pool.query('SELECT * FROM technical_service_documents WHERE id = $1', [id]);
         if (result.rows.length === 0) return response.status(404).json({ error: 'Document not found' });
         return response.status(200).json(result.rows[0]);
      }

      let query = 'SELECT * FROM technical_service_documents WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (type) {
        query += ` AND document_type = $${paramIndex}`;
        params.push(type);
        paramIndex++;
      }
      
      if (status) {
        query += ` AND status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (search) {
        query += ` AND (client_name ILIKE $${paramIndex} OR ticket_number ILIKE $${paramIndex} OR COALESCE(client_contact, '') ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (client) {
        query += ` AND client_name ILIKE $${paramIndex}`;
        params.push(`%${client}%`);
        paramIndex++;
      }

      const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
      query += ` ORDER BY updated_at DESC, created_at DESC LIMIT ${parsedLimit}`;

      const result = await pool.query(query, params);
      return response.status(200).json(result.rows);
      
    } catch (error) {
       console.error('Error fetching documents:', error);
       return response.status(500).json({ error: 'Database error' });
    }
    
  } else if (request.method === 'POST') {
    const {
    copy_from_id,
    target_client_name,
    target_client_contact,
      ticket_number, 
      document_type, 
      client_name, 
      client_contact,
      client_cedula,
      client_center, 
      equipment_data, 
      checklist_data,
      diagnosis,
      recommendations,
      total_cost,
      status 
    } = request.body;

    try {
      if (copy_from_id) {
        const sourceResult = await pool.query(
          'SELECT * FROM technical_service_documents WHERE id = $1',
          [copy_from_id]
        );

        if (sourceResult.rows.length === 0) {
          return response.status(404).json({ error: 'Source document not found' });
        }

        const source = sourceResult.rows[0];
        const nextType = document_type || source.document_type;
        const nextTicket = ticket_number || await generateUniqueTicket(pool, nextType);

        const result = await pool.query(
          `INSERT INTO technical_service_documents
           (ticket_number, document_type, client_name, client_contact, client_cedula, client_center, equipment_data, checklist_data, diagnosis, recommendations, total_cost, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            nextTicket,
            nextType,
            target_client_name || client_name || source.client_name,
            target_client_contact || client_contact || source.client_contact,
            client_cedula || source.client_cedula || '',
            client_center || source.client_center || '',
            equipment_data || source.equipment_data || {},
            checklist_data || source.checklist_data || { checks: [] },
            diagnosis ?? source.diagnosis ?? '',
            recommendations ?? source.recommendations ?? '',
            toDbCost(total_cost ?? source.total_cost),
            status || 'draft'
          ]
        );

        return response.status(201).json(result.rows[0]);
      }

      const finalTicket = ticket_number || await generateUniqueTicket(pool, document_type);

      const result = await pool.query(
        `INSERT INTO technical_service_documents 
         (ticket_number, document_type, client_name, client_contact, client_cedula, client_center, equipment_data, checklist_data, diagnosis, recommendations, total_cost, status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
         RETURNING *`,
        [
          finalTicket,
          document_type,
          client_name,
          client_contact,
          client_cedula || '',
          client_center || '',
          equipment_data || {},
          checklist_data || { checks: [] },
          diagnosis || '',
          recommendations || '',
          toDbCost(total_cost),
          status || 'pending'
        ]
      );
      return response.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Error creating document:', error);
      return response.status(500).json({ error: 'Failed to create document' });
    }
  } else if (request.method === 'PUT') {
      const { id, ...updates } = request.body;
      if(!id) return response.status(400).json({ error: 'Document ID required' });

      const normalizedUpdates = { ...updates };
      if ('total_cost' in normalizedUpdates) {
        normalizedUpdates.total_cost = toDbCost(normalizedUpdates.total_cost);
      }

      const fields = Object.keys(normalizedUpdates).filter((field) => ALLOWED_UPDATE_FIELDS.includes(field));
      if(fields.length === 0) return response.status(400).json({ error: 'No fields to update' });

      const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
      const values = [id, ...fields.map((field) => normalizedUpdates[field])];

      try {
          const result = await pool.query(
              `UPDATE technical_service_documents SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
              values
          );
          if (result.rows.length === 0) return response.status(404).json({ error: 'Document not found' });
          return response.status(200).json(result.rows[0]);
      } catch (error) {
          console.error('Error updating document:', error);
          return response.status(500).json({ error: 'Failed to update document' });
      }
  }

  return response.status(405).json({ error: 'Method not allowed' });
}
