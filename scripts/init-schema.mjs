/**
 * Inicializa ambos schemas (auth + clinical) directamente via Node.js.
 * Uso: node --env-file=.env.local scripts/init-schema.mjs
 */
import { initMultiTenantSchema } from '../api/admin-auth.js';
import { initClinicalDatabase } from '../lib/neon-clinical-db.js';

async function run() {
  console.log('🔧 Inicializando schema auth (clinics, clinic_users, admin_sessions, ...)');
  await initMultiTenantSchema();
  console.log('✅ Schema auth listo\n');

  console.log('🔧 Inicializando schema clínico (patients, clinical_records, ...)');
  await initClinicalDatabase();
  console.log('✅ Schema clínico listo\n');

  console.log('🎉 Ambos schemas inicializados. Ahora ejecuta setup-bioskin-role.mjs');
  process.exit(0);
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
