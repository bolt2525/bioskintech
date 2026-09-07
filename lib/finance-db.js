
import { Pool } from '@neondatabase/serverless';

let poolInstance = null;

function getPool() {
  if (poolInstance) return poolInstance;

  const connectionString = process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;

  if (!connectionString) {
    throw new Error('Database connection string is missing');
  }

  poolInstance = new Pool({ connectionString });
  return poolInstance;
}

export async function saveFinanceRecord(record, clinicId) {
  const pool = getPool();
  if (!clinicId) throw new Error('Clinic context is required');
  
  const query = `
    INSERT INTO external_finance_records (
      assistant_name,
      patient_name,
      intervention_date,
      clinic,
      total_payment,
      abono,
      doctor_fees,
      expenses,
      additional_income,
      net_income_juan_pablo,
      raw_note,
      intervention_type,
      details,
      payment_method,
      clinic_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id
  `;

  // Calculate default clinic logic for expenses
  // If it's an expense (total_payment = 0, expenses > 0) and clinic is null/undefined, leave it empty or use specialized logic
  let clinicValue = record.clinic || 'HSJD';
  if ((record.total_payment === 0 && record.expenses > 0) && (!record.clinic || record.clinic === 'HSJD')) {
     // If it's an expense and no specific place was detected (default was applied), try to see if it makes sense to clear it
     // However, user asked: "cuando son gastos en clinica deja vacio a menos que se especifique en donde se realiza ese gasto compra o ingreso adicional"
     // The AI prompt sets clinic default to 'HSJD'. We should check if the AI *found* a clinic or if we are falling back.
     // Better approach: In the AI Service we can set default to null for expenses.
     // Here we just respect what comes in. If the user clears it in UI, it comes as empty string.
     if (!record.clinic) clinicValue = ''; 
  }

  const values = [
    record.assistant_name,
    record.patient_name,
    record.intervention_date || record.date, // Handle both key names
    clinicValue, 
    record.total_payment ?? 0, // IMPORTANT: Use ?? 0 because || 0 is fine, but if it is undefined we want 0. The error says violations of not-null.
    record.abono || 0,
    JSON.stringify(record.doctor_fees || {}), 
    record.expenses || 0,
    record.additional_income || 0,
    record.net_income_juan_pablo || 0, // Default to 0 if not calculated yet
    record.raw_note,
    record.intervention_type || 'Consulta', // Default type
    record.details || '',
    record.payment_method || 'Efectivo', // Default payment method
    clinicId
  ];

  try {
    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving finance record:', error);
    throw error;
  }
}

export async function getFinanceRecords(filters = {}, clinicId) {
  const pool = getPool();
  if (!clinicId) throw new Error('Clinic context is required');
  let query = `SELECT * FROM external_finance_records WHERE clinic_id = $1`;
  const values = [clinicId];
  let index = 2;

  if (filters.assistant) {
    query += ` AND assistant_name = $${index++}`;
    values.push(filters.assistant);
  }
  
  if (filters.month) {
    // Expects 'YYYY-MM'
    query += ` AND TO_CHAR(intervention_date, 'YYYY-MM') = $${index++}`;
    values.push(filters.month);
  }

  query += ` ORDER BY intervention_date DESC`;

  try {
    const result = await pool.query(query, values);
    return result.rows.map(row => ({
      ...row,
      // Parse doctor_fees in case it comes as a string, default to [] if null/undefined
      doctor_fees: typeof row.doctor_fees === 'string' 
        ? JSON.parse(row.doctor_fees || '[]')
        : (row.doctor_fees || [])
    }));
  } catch (error) {
    console.error('Error fetching finance records:', error);
    throw error;
  }
}

export function buildFinanceUpdateQuery(updates, id, clinicId) {
  const allowedFields = new Set([
    'assistant_name', 'patient_name', 'intervention_date', 'clinic',
    'total_payment', 'abono', 'doctor_fees', 'expenses',
    'additional_income', 'net_income_juan_pablo', 'raw_note',
    'intervention_type', 'details', 'payment_method'
  ]);
  const fields = [];
  const values = [];
  let index = 1;

  for (const [key, value] of Object.entries(updates || {})) {
    if (!allowedFields.has(key)) continue;
    fields.push(`${key} = $${index++}`);
    values.push(key === 'doctor_fees' ? JSON.stringify(value) : value);
  }
  if (fields.length === 0) return null;
  values.push(id, clinicId);
  return {
    query: `UPDATE external_finance_records SET ${fields.join(', ')} WHERE id = $${index} AND clinic_id = $${index + 1} RETURNING *`,
    values,
  };
}

export async function updateFinanceRecord(id, updates, clinicId) {
  const pool = getPool();
  if (!clinicId) throw new Error('Clinic context is required');
  const statement = buildFinanceUpdateQuery(updates, id, clinicId);
  if (!statement) return null;

  try {
    const result = await pool.query(statement.query, statement.values);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating finance record:', error);
    throw error;
  }
}

export async function deleteFinanceRecord(id, clinicId) {
  const pool = getPool();
  if (!clinicId) throw new Error('Clinic context is required');
  try {
    const result = await pool.query('DELETE FROM external_finance_records WHERE id = $1 AND clinic_id = $2 RETURNING id', [id, clinicId]);
    return result.rowCount > 0;
  } catch (error) {
    console.error('Error deleting finance record:', error);
    throw error;
  }
}
