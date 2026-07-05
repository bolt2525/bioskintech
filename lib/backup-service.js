
import { getPool } from './neon-clinical-db.js';

/**
 * Generates a full backup of the database
 * @returns {Promise<Object>} The full backup object
 */
export async function generateFullBackup() {
  const pool = getPool();
  if (!pool) {
    throw new Error('Database connection not available');
  }

  const backupData = {
    metadata: {
      timestamp: new Date().toISOString(),
      version: '1.0',
      type: 'full_backup'
    },
    tables: {},
    sqlite: {} // Kept for structure compatibility, but empty
  };

  // List of tables to backup
  // We use a safe list to avoid trying to query non-existent tables if possible,
  // but for a robust backup we might want to query information_schema.
  // However, explicit list is safer for now to avoid leaking system tables.
  const tables = [
    // Clinical
    'patients',
    'clinical_records',
    'medical_history',
    'consultation_info',
    'consultation_history',
    'physical_exams',
    'diagnoses',
    'treatments',
    
    // Finance
    'external_finance_records',
    
    // Chatbot
    'internal_bot_conversations',
    'internal_bot_messages',
    'chatbot_tracking',
    'chatbot_templates',
    'chatbot_app_states',

    // Inventory
    'inventory_categories',
    'suppliers',
    'inventory_items',
    'inventory_batches',

    // Admin
    'admin_users'
  ];

  const client = await pool.connect();

  try {
    for (const table of tables) {
      try {
        // Check if table exists first to avoid error spam
        const checkQuery = `
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = $1
          );
        `;
        const checkResult = await client.query(checkQuery, [table]);
        
        if (checkResult.rows[0].exists) {
          console.log(`Backing up table: ${table}`);
          const result = await client.query(`SELECT * FROM ${table}`);
          backupData.tables[table] = result.rows;
        } else {
          console.log(`Table skipped (not found): ${table}`);
        }
      } catch (err) {
        console.error(`Error backing up table ${table}:`, err);
        // We continue with other tables even if one fails
        backupData.tables[table] = { error: err.message };
      }
    }
    
    return backupData;
  } finally {
    client.release();
  }
}
