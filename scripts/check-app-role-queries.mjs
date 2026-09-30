// Smoke test: ejecuta como bioskin_app las consultas reales de api/records.js que tocan
// tablas compartidas, para confirmar que el hardening de permisos no rompió el panel.
import pg from 'pg';

const owner = new pg.Pool({ connectionString: process.env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = new pg.Pool({ connectionString: process.env.NEON_APP_URL.trim(), ssl: { rejectUnauthorized: false } });

// Se elige una clínica con datos reales: una vacía devolvería 0 filas y ocultaría un error de columna.
const clinic = (await owner.query(`
  SELECT clinic_id FROM patients GROUP BY clinic_id ORDER BY count(*) DESC LIMIT 1
`)).rows[0]?.clinic_id ?? (await owner.query('SELECT id AS clinic_id FROM clinics LIMIT 1')).rows[0].clinic_id;
const c = await app.connect();
await c.query("SELECT set_config('app.current_tenant', $1, false)", [String(clinic)]);

const QUERIES = [
  ['listPatients (records.js:1683)', `SELECT p.*, cu.full_name AS created_by_user_name, cu.username AS created_by_username,
      ROW_NUMBER() OVER (PARTITION BY p.clinic_id ORDER BY p.id) AS seq
    FROM patients p LEFT JOIN clinic_users cu ON cu.id = p.created_by_user_id LIMIT 5`],
  ['listRecords (records.js:1791)', `SELECT cr.*, cu.full_name AS created_by_full_name, cu.username AS created_by_username,
      cu.gentilicio AS created_by_gentilicio
    FROM clinical_records cr LEFT JOIN clinic_users cu ON cu.id = cr.created_by_user_id LIMIT 5`],
  ['listUsers (records.js:2047)', `SELECT id, username, full_name, role, access_scope FROM clinic_users
    WHERE clinic_id = '${clinic}' AND is_active = true ORDER BY full_name`],
  ['sharingGroups (records.js:2062)', `SELECT sg.id,
      COALESCE(json_agg(json_build_object('id', cu.id, 'username', cu.username, 'full_name', cu.full_name)
        ORDER BY cu.full_name) FILTER (WHERE cu.id IS NOT NULL), '[]') AS members
    FROM sharing_groups sg
    LEFT JOIN sharing_group_members sgm ON sgm.group_id = sg.id
    LEFT JOIN clinic_users cu ON cu.id = sgm.clinic_user_id GROUP BY sg.id LIMIT 5`],
  ['inventoryMovements (records.js:913)', `SELECT m.*, i.name AS item_name, b.batch_number, cu.full_name AS user_name
    FROM inventory_movements m
    JOIN inventory_batches b ON m.batch_id = b.id
    JOIN inventory_items i ON b.item_id = i.id
    LEFT JOIN clinic_users cu ON cu.id = m.user_id AND cu.clinic_id = i.clinic_id LIMIT 5`],
  ['inventoryList (records.js:1125)', `SELECT i.id, cu.full_name AS created_by_user_name, cu.username AS created_by_username
    FROM inventory_items i LEFT JOIN clinic_users cu ON cu.id = i.created_by_user_id
    GROUP BY i.id, cu.full_name, cu.username LIMIT 5`],
  ['inventorySettings (records.js:1155)', `SELECT inventario->>'expiry_alert_days' AS d FROM clinic_settings WHERE clinic_id = '${clinic}'`],
  ['financeVisibility (records.js:3583)', `SELECT clinic_user_id, enabled FROM user_module_overrides WHERE feature = 'finanzas_visible'`],
  ['patientAssignments (records.js:310)', `SELECT 1 FROM patients p WHERE EXISTS (
      SELECT 1 FROM patient_assignments pa WHERE pa.patient_id = p.id) LIMIT 5`],
  ['financeCsv (records.js:441)', `SELECT * FROM financial_records WHERE clinic_id = '${clinic}'
    AND created_by_user_id IN (SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
      JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id WHERE sgm1.clinic_user_id = 1) LIMIT 5`],
];

let failed = 0;
for (const [label, q] of QUERIES) {
  try { const r = await c.query(q); console.log(`PASS: ${label} -> ${r.rows.length} filas`); }
  catch (e) { failed++; console.error(`FAIL: ${label} -> ${e.message.split('\n')[0]}`); }
}

c.release();
await app.end();
await owner.end();
console.log(failed ? `\n${failed} consulta(s) rotas` : '\nTodas las consultas reales del panel siguen funcionando');
process.exit(failed ? 1 : 0);
