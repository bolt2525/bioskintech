import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL);

const cols = await sql`
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_name IN ('patients','clinical_records','consultations','consultation_info','consultation_history','medical_history','physical_exams','diagnoses','treatments','injectables','prescriptions','consent_forms','patient_audit_log','financial_records','external_finance_records','financial_items','inventory_items','inventory_batches','inventory_movements')
  ORDER BY table_name, ordinal_position
`;
console.table(cols.map(r => ({ t: r.table_name, col: r.column_name, type: r.data_type })));
