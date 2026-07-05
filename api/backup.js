
import { getPool } from '../lib/neon-clinical-db.js';
import adminAuth from './admin-auth.js';

// Helper to verify session reuse from admin-auth
const verifyToken = async (req) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.split(' ')[1];
    return !!token; 
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const isAuthorized = await verifyToken(req);
    if (!isAuthorized) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not configured' });
    }

    const { modules } = req.query; // 'patients,finance,chat,inventory'
    const selectedModules = modules ? modules.split(',') : ['patients', 'finance', 'chat', 'inventory'];

    const backupData = {
        timestamp: new Date().toISOString(),
        modules: {},
    };

    // 1. Patients & Clinical Records
    if (selectedModules.includes('patients')) {
        try {
            const patientsRes = await pool.query('SELECT * FROM patients LIMIT 1000');
            const recordsRes = await pool.query('SELECT * FROM clinical_records LIMIT 5000');
            
            // Detailed Clinical Data
            const medicalHistoryRes = await pool.query('SELECT * FROM medical_history LIMIT 5000');
            const consultationInfoRes = await pool.query('SELECT * FROM consultation_info LIMIT 5000');
            const consultationHistoryRes = await pool.query('SELECT * FROM consultation_history LIMIT 5000');
            const physicalExamsRes = await pool.query('SELECT * FROM physical_exams LIMIT 5000');
            const diagnosesRes = await pool.query('SELECT * FROM diagnoses LIMIT 5000');
            const treatmentsRes = await pool.query('SELECT * FROM treatments LIMIT 5000');
            const prescriptionsRes = await pool.query('SELECT * FROM prescriptions LIMIT 5000');
            const consentFormsRes = await pool.query('SELECT * FROM consent_forms LIMIT 5000');

            backupData.modules.patients = {
                count: patientsRes.rows.length,
                data: patientsRes.rows,
                records: recordsRes.rows,
                details: {
                    medical_history: medicalHistoryRes.rows,
                    consultation_info: consultationInfoRes.rows,
                    consultation_history: consultationHistoryRes.rows,
                    physical_exams: physicalExamsRes.rows,
                    diagnoses: diagnosesRes.rows,
                    treatments: treatmentsRes.rows,
                    prescriptions: prescriptionsRes.rows,
                    consent_forms: consentFormsRes.rows
                }
            };
        } catch (e) {
            console.error('Error backing up patients:', e);
            backupData.modules.patients = { error: e.message };
        }
    }

    // 2. Finance
    if (selectedModules.includes('finance')) {
         try {
            const financeRes = await pool.query('SELECT * FROM external_finance_records LIMIT 5000');
             backupData.modules.finance = {
                count: financeRes.rows.length,
                records: financeRes.rows
            };
        } catch (e) {
             backupData.modules.finance = { note: 'Finance tables not found or accessible', details: e.message };
        }
    }

    // 3. Chat History (Internal Bot)
    if (selectedModules.includes('chats')) {
        try {
            const conversations = await pool.query('SELECT * FROM internal_bot_conversations LIMIT 500');
            const messages = await pool.query('SELECT * FROM internal_bot_messages ORDER BY created_at DESC LIMIT 2000');
            backupData.modules.chats = {
                conversations: conversations.rows,
                messages: messages.rows
            };
        } catch (e) {
            backupData.modules.chats = { error: e.message };
        }
    }
    
    // 4. Inventory (Products)
    if (selectedModules.includes('inventory')) {
        backupData.modules.inventory = { note: 'Inventory backup requires Database migration first' };
    }

    const filename = `bioskin-backup-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).json(backupData);

  } catch (error) {
    console.error('Backup generation failed:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
