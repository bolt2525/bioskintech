/**
 * Reset completo de la base de datos — elimina todas las tablas.
 * SOLO ejecutar en entornos de desarrollo con datos de prueba.
 * Requiere NEON_DATABASE_URL o POSTGRES_URL en el entorno.
 *
 * Uso: node scripts/reset-database.mjs
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const url = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!url) { console.error('❌ NEON_DATABASE_URL / POSTGRES_URL no definida'); process.exit(1); }

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

// Orden inverso a las FKs
const DROP_ORDER = [
  'medical_history_snapshots',
  'sharing_group_members',
  'patient_assignments',
  'patient_audit_log',
  'user_module_overrides',
  'consent_forms',
  'injectables',
  'prescriptions',
  'prescription_templates',
  'treatments',
  'diagnoses',
  'physical_exams',
  'consultation_history',
  'consultation_info',
  'consultations',
  'medical_history',
  'clinical_photos',
  'clinical_records',
  'inventory_movements',
  'inventory_batches',
  'inventory_items',
  'financial_items',
  'financial_records',
  'sharing_groups',
  'patients',
  'injectable_catalog',
  'professional_signatures',
  // Auth tables
  'subscriptions',
  'registration_codes',
  'admin_sessions',
  'user_module_overrides',
  'clinic_consent_templates',
  'consent_templates',
  'clinic_settings',
  'clinic_oauth_tokens',
  'clinic_features',
  'clinic_users',
  'clinics',
  // External finance
  'external_finance_records',
];

async function run() {
  console.log('⚠️  Iniciando reset de base de datos...');
  const client = await pool.connect();
  try {
    for (const table of DROP_ORDER) {
      try {
        await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
        console.log(`  ✓ DROP ${table}`);
      } catch (e) {
        console.warn(`  ⚠ ${table}: ${e.message}`);
      }
    }
    console.log('\n✅ Reset completado. Ejecuta initMultiTenant + primer request a /api/records para recrear el schema.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
