
import { parseMedicalNote } from '../lib/medical-finance-service.js';
import { 
  saveFinanceRecord, 
  getFinanceRecords, 
  updateFinanceRecord, 
  deleteFinanceRecord 
} from '../lib/finance-db.js';

export default async function handler(req, res) {
  // CORS basics
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;

  try {
    // --- POST Actions ---
    if (req.method === 'POST') {
      if (action === 'process-note') {
        const { note, assistant } = req.body;
        if (!note || !assistant) {
          return res.status(400).json({ error: 'Missing note or assistant name' });
        }
        
        // AI now returns an ARRAY of records
        const parsedData = await parseMedicalNote(note);
        
        // Ensure we handle both single object and array return types from the service
        // The service logic was updated to return array, but keeping it robust here
        const records = Array.isArray(parsedData) ? parsedData : [parsedData];
        
        // Add assistant and raw_note to *each* record
        const completeRecords = records.map(r => ({
          ...r,
          assistant_name: assistant,
          raw_note: note 
        }));

        return res.status(200).json(completeRecords);
      } 
      
      else if (action === 'save-record') {
        const record = req.body;
        if (!record || !record.patient_name) {
          return res.status(400).json({ error: 'Missing required record fields' });
        }
        const savedRecord = await saveFinanceRecord(record);
        return res.status(200).json({ success: true, id: savedRecord.id });
      }
    }

    // --- GET Actions ---
    if (req.method === 'GET') {
      if (action === 'list') {
        const filters = {
          assistant: req.query.assistant,
          month: req.query.month
        };
        const records = await getFinanceRecords(filters);
        return res.status(200).json(records);
      }
    }

    // --- PATCH/UPDATE Actions ---
    if (req.method === 'PATCH' || (req.method === 'POST' && action === 'update')) {
      const { id, updates } = req.body;
      if (!id || !updates) {
        return res.status(400).json({ error: 'Missing id or updates' });
      }
      const updated = await updateFinanceRecord(id, updates);
      return res.status(200).json({ success: true, data: updated });
    }

    // --- DELETE Actions ---
    if (req.method === 'DELETE' || (req.method === 'POST' && action === 'delete')) {
      const { id } = req.body || req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      
      await deleteFinanceRecord(id);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action or method' });

  } catch (error) {
    console.error(`Error in external-finance [${action}]:`, error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
