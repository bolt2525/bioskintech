import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL);

// Delete orphaned clinical_records with NULL created_by_user_id that have no clinical data
// These were created by the broken import code during the SyntaxError period
const orphans = await sql`
  SELECT cr.id, cr.patient_id, cr.created_at
  FROM clinical_records cr
  WHERE cr.created_by_user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM medical_history WHERE record_id = cr.id)
    AND NOT EXISTS (SELECT 1 FROM consultations WHERE record_id = cr.id)
    AND NOT EXISTS (SELECT 1 FROM treatments WHERE record_id = cr.id)
    AND NOT EXISTS (SELECT 1 FROM physical_exams WHERE record_id = cr.id)
    AND NOT EXISTS (SELECT 1 FROM diagnoses WHERE record_id = cr.id)
`;
console.log(`Found ${orphans.length} orphaned empty records with NULL created_by_user_id:`);
console.table(orphans);

if (orphans.length > 0) {
  const ids = orphans.map(r => r.id);
  const deleted = await sql`DELETE FROM clinical_records WHERE id = ANY(${ids}) RETURNING id`;
  console.log(`Deleted: ${deleted.map(r => r.id).join(', ')}`);
} else {
  console.log('Nothing to delete.');
}
