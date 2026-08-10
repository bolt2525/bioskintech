/**
 * Siembra la clínica BIOSKIN, master_admin y clinic_admin desde env vars.
 * Uso: node --env-file=.env.local scripts/seed-data.mjs
 * Requiere: MASTER_ADMIN_USERNAME, MASTER_ADMIN_PASSWORD, ADMIN_USERNAME, ADMIN_PASSWORD
 */
import { seedData } from '../api/admin-auth.js';

async function run() {
  console.log('🌱 Sembrando datos iniciales...');
  await seedData();
  console.log('✅ Seed completado');
  process.exit(0);
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
