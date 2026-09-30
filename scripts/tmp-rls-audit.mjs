import pg from 'pg';

const ownerUrl = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
const appUrl = process.env.NEON_APP_URL?.trim();
const owner = new pg.Pool({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });

const show = (l, rows) => { console.log(`\n===== ${l} =====`); console.table(rows); };

show('roles', (await owner.query(`
  SELECT rolname, rolsuper, rolbypassrls, rolcreatedb
  FROM pg_roles WHERE rolname IN ('neondb_owner','bioskin_app')`)).rows);

show('tablas SIN RLS que contienen datos de pacientes o tenant', (await owner.query(`
  SELECT c.relname AS tabla,
         (SELECT count(*) FROM information_schema.columns col
           WHERE col.table_name = c.relname AND col.column_name = 'clinic_id') > 0 AS tiene_clinic_id,
         c.relrowsecurity AS rls,
         c.relforcerowsecurity AS forzado,
         (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS politicas,
         c.reltuples::bigint AS filas_aprox
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity = false
  ORDER BY tiene_clinic_id DESC, c.relname`)).rows);

show('privilegios de bioskin_app sobre tablas sin RLS', (await owner.query(`
  SELECT table_name, string_agg(DISTINCT privilege_type, ', ') AS permisos
  FROM information_schema.role_table_grants
  WHERE grantee = 'bioskin_app'
    AND table_name IN (SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                       WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false)
  GROUP BY table_name ORDER BY table_name`)).rows);

// ¿El owner está realmente sujeto a FORCE RLS en las tablas clínicas?
const ownerClient = await owner.connect();
try {
  const r = await ownerClient.query('SELECT count(*) FROM patients');
  console.log(`\n>> neondb_owner SIN contexto tenant lee ${r.rows[0].count} pacientes (si >0, el owner evade FORCE RLS)`);
} catch (e) { console.log('\n>> neondb_owner bloqueado en patients:', e.message); }
finally { ownerClient.release(); }

if (appUrl) {
  const app = new pg.Pool({ connectionString: appUrl, ssl: { rejectUnauthorized: false } });
  const c = await app.connect();
  for (const t of ['whatsapp_messages', 'whatsapp_contacts', 'whatsapp_bot_state', 'wa_short_links', 'clinic_users', 'admin_sessions']) {
    try {
      const r = await c.query(`SELECT count(*) FROM ${t}`);
      console.log(`>> bioskin_app SIN contexto tenant lee ${t}: ${r.rows[0].count} filas`);
    } catch (e) { console.log(`>> bioskin_app en ${t}: BLOQUEADO (${e.message.split('\n')[0]})`); }
  }
  c.release();
  await app.end();
} else { console.log('\n>> NEON_APP_URL no disponible localmente'); }

await owner.end();
