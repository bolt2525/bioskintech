import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const clinicId = '11111111-2222-4333-8444-555555555555';
let actor, packages, sessions, postings, items, queries, mayAccess, auditFails, financeFails, snapshot;
const rows = values => ({ rows: values, rowCount: values.length });
const db = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql === 'BEGIN') {
      snapshot = structuredClone({ packages, sessions, postings, items });
      return rows([]);
    }
    if (sql === 'ROLLBACK' && snapshot) {
      ({ packages, sessions, postings, items } = snapshot);
      snapshot = null;
      return rows([]);
    }
    if (sql === 'COMMIT') snapshot = null;
    if (/^(BEGIN|COMMIT|ROLLBACK|SET)/.test(sql) || sql.includes('set_config')) return rows([]);
    if (sql.includes('INSERT INTO patient_audit_log')) {
      if (auditFails) throw new Error('Detalle interno de SQL');
      return rows([]);
    }
    if (sql.includes('FROM clinical_records cr')) return rows(mayAccess ? [{ id: 4, patient_name: 'Paciente ficticio QA' }] : []);
    if (sql.includes('SELECT record_id FROM treatment_packages')) return rows(packages.filter(p => p.id == params[0] && p.clinic_id === actor.clinic_id));
    if (sql.includes('FROM consultations')) return rows(params[0] === 7 && params[1] === 4 && params[2] === clinicId ? [{ id: 7 }] : []);
    if (sql.includes('FROM financial_records') && !sql.startsWith('DELETE')) {
      if (sql.includes('WHERE id = $1 AND source_module')) return rows(postings.filter(p => p.id === params[0]
        && p.clinic_id === actor.clinic_id && p.source_type === 'treatment_package_initial' && p.source_module === 'treatments'));
      if (sql.includes('fr.id = $1')) return rows(postings.filter(p => p.id === params[0]
        && p.clinic_id === params[1] && (!params[2] || p.created_by_user_id === params[3])));
      if (sql.includes('idempotency_key = $2')) return rows(postings.filter(p => p.clinic_id === params[0] && p.idempotency_key === params[1]));
      if (sql.includes('FOR UPDATE') && sql.includes('SELECT id, total')) {
        return rows(postings.filter(p => p.clinic_id === params[0] && p.source_module === 'treatments'
          && p.source_type === 'treatment_package_initial' && p.source_id === params[1]));
      }
      return rows(postings.filter(p => p.clinic_id === params[0] && (p.source_package_id === params[1]
        || (p.source_type === 'treatment_package_initial' && p.source_id === params[1]))));
    }
    if (sql.includes('INSERT INTO financial_records')) {
      if (financeFails) throw new Error('Fallo SQL financiero ficticio');
      const posting = { id: postings.length + 30, date: params[0], invoice_number: params[1],
        entity: params[2], description: params[3], subtotal: params[4], tax: params[5], total: params[6],
        clinic_id: params[8], created_by_user_id: params[9], tax_rate: params[10], source_module: 'treatments',
        source_type: params[11], source_id: params[12], source_package_id: params[13],
        source_record_id: params[14], source_consultation_id: params[15], idempotency_key: params[16] };
      postings.push(posting);
      return rows([structuredClone(posting)]);
    }
    if (sql.includes('UPDATE financial_records SET description')) {
      if (financeFails) throw new Error('Fallo SQL financiero ficticio');
      const found = postings.find(p => p.id === params[5] && p.clinic_id === params[6]);
      Object.assign(found, { description: params[0], subtotal: params[1], tax: params[2], total: params[3], tax_rate: params[4] });
      return rows([]);
    }
    if (sql.includes('UPDATE financial_records SET date = $1')) {
      const found = postings.find(p => p.id === params[2] && p.clinic_id === params[3]);
      Object.assign(found, { date: params[0], invoice_number: params[1] });
      return rows([]);
    }
    if (sql.includes('DELETE FROM financial_records')) {
      postings = postings.filter(p => !(p.id === params[0] && p.clinic_id === params[1]));
      return rows([]);
    }
    if (sql.includes('DELETE FROM financial_items')) {
      items = items.filter(i => !(i.record_id === params[0] && i.clinic_id === params[1]));
      return rows([]);
    }
    if (sql.includes('INSERT INTO financial_items')) {
      if (financeFails) throw new Error('Fallo SQL financiero ficticio');
      const updating = sql.includes('$4,$6,$7,0');
      items.push({ record_id: params[0], clinic_id: params[1], description: params[2],
        subtotal: updating ? params[3] : params[5], tax: updating ? params[5] : params[6],
        total: updating ? params[6] : params[7] });
      return rows([]);
    }
    if (sql.includes('SELECT 1 FROM treatments')) return rows(sessions.filter(t => t.package_id === params[0]).slice(0, 1));
    if (sql.includes('FROM treatments WHERE package_id')) {
      const found = sessions.filter(t => t.package_id === params[0] && t.record_id === params[1]
        && t.consultation_id === params[2] && t.clinic_id === params[3]);
      return rows([{ sessions_count: found.length, sessions_paid: found.reduce((sum, t) => sum + t.cost, 0) }]);
    }
    if (sql.includes('AS paid') && sql.includes('FROM treatments')) {
      const found = sessions.filter(t => t.package_id === params[0] && t.consultation_id === params[1]
        && t.clinic_id === params[2] && t.record_id === params[3] && t.id !== params[4]);
      return rows([{ paid: found.reduce((sum, t) => sum + t.cost, 0) }]);
    }
    if (sql.includes('FROM treatment_packages tp')) {
      assert.match(sql, /t\.clinic_id = tp\.clinic_id/);
      assert.doesNotMatch(sql, /tp\.treatment_mode =/);
      return rows(packages.filter(p => p.record_id === params[0] && p.consultation_id === params[1]
        && p.clinic_id === params[2] && Boolean(p.archived_at) === params[3]));
    }
    if (sql.includes('FROM treatment_packages') && sql.includes('FOR UPDATE')) {
      assert.doesNotMatch(sql, /GROUP BY/);
      return rows(packages.filter(p => p.id == params[0]
        && (sql.includes('record_id = $2')
          ? p.record_id === params[1] && p.clinic_id === params[2] && p.consultation_id === params[3]
          : p.clinic_id === params[1])
        && (!sql.includes('archived_at IS NULL') || !p.archived_at)).map(p => structuredClone(p)));
    }
    if (sql.startsWith('DELETE FROM treatment_packages')) {
      packages = packages.filter(p => !(p.id === params[0] && p.clinic_id === params[1]));
      return rows([]);
    }
    if (sql.startsWith('UPDATE treatment_packages SET archived_at')) {
      const found = packages.find(p => p.id === params[0] && p.clinic_id === params[1]);
      if (!found || (sql.includes('IS NOT NULL') && !found.archived_at)) return rows([]);
      found.archived_at = sql.includes('SET archived_at = NULL') ? null : '2026-10-12T00:00:00Z';
      return rows([found]);
    }
    if (sql.includes('UPDATE treatment_packages') && sql.includes('SET name')) {
      const found = packages.find(p => p.id === params[3] && p.clinic_id === params[4]);
      Object.assign(found, { name: params[0], total_cost: params[1], estimated_sessions: params[2], initial_payment: params[5] });
      return rows([structuredClone(found)]);
    }
    if (sql.includes('INSERT INTO treatment_packages')) {
      const created = { id: packages.length + 10, record_id: params[0], clinic_id: params[1],
        consultation_id: params[2], treatment_mode: params[3], name: params[4], total_cost: params[5],
        estimated_sessions: params[6], initial_payment: params[7], created_at: '2026-10-14', archived_at: null };
      packages.push(created);
      return rows([structuredClone(created)]);
    }
    if (sql.includes('SELECT * FROM treatment_packages WHERE id')) {
      return rows(packages.filter(p => p.id === params[0]));
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
  release() {},
};
const url = path => new URL(path, import.meta.url).href;
mock.module(url('../lib/neon-clinical-db.js'), { namedExports: {
  getPool: () => db, getAppPool: () => ({ connect: async () => db }),
  initClinicalDatabase: async () => {}, withTenantContext: async (_id, fn) => fn(db),
} });
mock.module(url('../lib/admin-auth.js'), { namedExports: {
  authenticateRequest: async () => actor, requireAuth: async () => null, requireRole: () => true,
} });
mock.module(url('../lib/clinic-lifecycle.js'), { namedExports: {
  lockClinicWriters: async () => {}, unlockClinicWriters: async () => {}, requireClinicWritable: async () => {},
} });
const { default: handler, assertPackagePaymentWithinBalance } = await import('../api/records.js');
const reset = () => {
  actor = { valid: true, id: 42, role: 'clinic_user', clinic_id: clinicId,
    effective_clinic_id: clinicId, clinical_records_enabled: true, finance_enabled: false, access_scope: 'all' };
  packages = [{ id: 9, record_id: 4, consultation_id: 7, clinic_id: clinicId,
    treatment_mode: 'facial', name: 'Depilación combinada', total_cost: 90, initial_payment: 30,
    estimated_sessions: 6, archived_at: null }];
  sessions = []; postings = []; items = []; queries = []; mayAccess = true; auditFails = false; financeFails = false; snapshot = null;
};
const request = async (action, method = 'GET', query = {}, body = {}) => {
  const res = { code: null, body: null, setHeader() {},
    status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method, headers: {}, query: { action, ...query }, body }, res);
  return res;
};

test('un paquete facial admite abonos faciales y corporales sin recrear cobros y limita el saldo global', async () => {
  reset();
  const identity = { packageId: 9, clinicId, recordId: 4, consultationId: 7 };
  for (const mode of ['facial', 'corporal', 'capilar']) {
    await assertPackagePaymentWithinBalance(db, { ...identity, treatmentMode: mode, amount: 20 });
    sessions.push({ id: sessions.length + 1, ...identity, package_id: 9, clinic_id: clinicId,
      record_id: 4, consultation_id: 7, treatment_mode: mode, cost: 20 });
  }
  await assert.rejects(assertPackagePaymentWithinBalance(db, { ...identity, amount: 0.01 }), /saldo pendiente.*0\.00/);
  await assertPackagePaymentWithinBalance(db, { ...identity, amount: 20, excludeTreatmentId: 2 });
  assert.ok(queries.filter(q => q.sql.includes('FOR UPDATE')).every(q => !q.sql.includes('treatment_mode')));
  assert.ok(queries.every(q => !q.sql.includes('INSERT INTO financial')));
});

test('paquetes de otra clínica, expediente, consulta o archivados no admiten sesiones', async () => {
  reset();
  const identity = { packageId: 9, clinicId, recordId: 4, consultationId: 7, amount: 0 };
  for (const mismatch of [{ clinicId: 'foreign' }, { recordId: 5 }, { consultationId: 8 }]) {
    await assert.rejects(assertPackagePaymentWithinBalance(db, { ...identity, ...mismatch }), /package_id inválido/);
  }
  packages[0].archived_at = '2026-10-12';
  await assert.rejects(assertPackagePaymentWithinBalance(db, identity), /package_id inválido/);
});

test('listado universal no filtra por modo y separa activos de archivados', async () => {
  reset();
  packages.push({ ...packages[0], id: 10, treatment_mode: 'corporal' },
    { ...packages[0], id: 11, archived_at: '2026-10-12' },
    { ...packages[0], id: 12, consultation_id: 8 },
    { ...packages[0], id: 13, clinic_id: 'foreign' });
  const query = { record_id: '4', consultation_id: '7' };
  const active = await request('listPackagesByRecord', 'GET', query);
  assert.equal(active.code, 200);
  assert.deepEqual(active.body.map(p => p.id), [9, 10]);
  const archive = await request('listPackagesByRecord', 'GET', { ...query, include_archived: 'true' });
  assert.deepEqual(archive.body.map(p => p.id), [11]);
  assert.equal((await request('listPackagesByRecord', 'GET', { ...query, include_archived: 'invalid' })).code, 400);
});

test('retirar paquete vacío con abono archiva y restaura sin cambiar un centavo ni las referencias financieras', async () => {
  reset();
  postings = [{ id: 30, clinic_id: clinicId, source_type: 'treatment_package_initial',
    source_id: 9, source_package_id: 9, total: 30, invoice_number: 'PRUEBA' }];
  const before = JSON.stringify(postings);
  const retired = await request('deletePackage', 'DELETE', { id: '9' });
  assert.equal(retired.code, 200);
  assert.equal(retired.body.archived, true);
  assert.equal(packages.length, 1);
  assert.ok(packages[0].archived_at);
  const restored = await request('restorePackage', 'POST', {}, { id: 9 });
  assert.equal(restored.code, 200);
  assert.equal(packages[0].archived_at, null);
  assert.equal(JSON.stringify(postings), before);
  assert.ok(!queries.some(q => /(?:UPDATE|DELETE FROM|INSERT INTO) financial/.test(q.sql)));
  assert.equal(queries.filter(q => q.sql.includes('INSERT INTO patient_audit_log')).length, 2);
});

test('retirar conserva abonos no enviados a Finanzas y asientos legados sin source_package_id', async () => {
  for (const legacyPosting of [false, true]) {
    reset();
    if (legacyPosting) {
      packages[0].initial_payment = 0;
      postings = [{ clinic_id: clinicId, source_type: 'treatment_package_initial', source_id: 9 }];
    }
    const res = await request('deletePackage', 'DELETE', { id: 9 });
    assert.equal(res.code, 200);
    assert.equal(res.body.archived, true);
    assert.equal(packages.length, 1);
  }
});

test('solo se elimina un paquete vacío y sin pagos; tener sesiones no desvincula nada', async () => {
  reset();
  packages[0].initial_payment = 0;
  const res = await request('deletePackage', 'DELETE', { id: 9 });
  assert.equal(res.code, 200);
  assert.equal(res.body.archived, false);
  assert.equal(packages.length, 0);
  reset();
  sessions.push({ id: 1, package_id: 9 });
  const blocked = await request('deletePackage', 'DELETE', { id: 9 });
  assert.equal(blocked.code, 409);
  assert.equal(packages.length, 1);
  assert.equal(packages[0].archived_at, null);
  assert.equal(sessions[0].package_id, 9);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
});

test('retirar y restaurar respetan acceso propio, clínica, método e identificador', async () => {
  reset();
  actor.access_scope = 'own';
  mayAccess = false;
  for (const [action, method, query, body] of [
    ['deletePackage', 'DELETE', { id: 9 }, {}],
    ['restorePackage', 'POST', {}, { id: 9 }],
    ['listPackagesByRecord', 'GET', { record_id: 4, consultation_id: 7 }, {}],
  ]) assert.equal((await request(action, method, query, body)).code, 403);
  assert.ok(!queries.some(q => /^(DELETE|UPDATE)/.test(q.sql)));
  reset();
  actor.clinic_id = actor.effective_clinic_id = '22222222-2222-4333-8444-555555555555';
  assert.equal((await request('deletePackage', 'DELETE', { id: 9 })).code, 404);
  assert.equal((await request('restorePackage', 'POST', {}, { id: 9 })).code, 404);
  reset();
  assert.equal((await request('deletePackage', 'GET', { id: 9 })).code, 405);
  assert.equal((await request('restorePackage', 'GET', {}, { id: 9 })).code, 405);
  for (const id of ['invalid', 0, -1, 1.5, true, [9], {}]) {
    assert.equal((await request('deletePackage', 'DELETE', { id })).code, 400);
    assert.equal((await request('restorePackage', 'POST', {}, { id })).code, 400);
  }
  actor.access_scope = 'own';
  assert.equal((await request('restorePackage', 'POST', {}, { id: 'invalid' })).code, 400);
  assert.equal((await request('listPackagesByRecord', 'GET', { record_id: 'invalid', consultation_id: 7 })).code, 400);
});

test('modificar paquete bloquea la fila antes de agregar sesiones y respeta montos y progreso', async () => {
  reset();
  sessions = [{ id: 1, package_id: 9, record_id: 4, consultation_id: 7, clinic_id: clinicId, cost: 20 }];
  const result = await request('updatePackage', 'POST', {}, { id: 9, name: 'Dúo', total_cost: 90, estimated_sessions: 6 });
  assert.equal(result.code, 200);
  assert.equal(result.body.sessions_paid, 20);
  assert.equal(result.body.sessions_count, 1);
  const lock = queries.findIndex(q => q.sql.includes('FOR UPDATE'));
  const totals = queries.findIndex(q => q.sql.includes('COUNT(*)::int'));
  assert.ok(lock >= 0 && totals > lock);
  assert.equal((await request('updatePackage', 'POST', {}, { id: 9, name: 'Dúo', total_cost: 49.99, estimated_sessions: 6 })).code, 400);
  packages[0].archived_at = '2026-10-12';
  assert.equal((await request('updatePackage', 'POST', {}, { id: 9, name: 'Dúo', total_cost: 90, estimated_sessions: 6 })).code, 404);
});

test('retiro y restauración no anuncian éxito si falla la auditoría ni exponen errores SQL', async () => {
  for (const action of ['deletePackage', 'restorePackage']) {
    reset();
    if (action === 'restorePackage') packages[0].archived_at = '2026-10-12';
    auditFails = true;
    const result = await request(action, action === 'deletePackage' ? 'DELETE' : 'POST',
      action === 'deletePackage' ? { id: 9 } : {}, action === 'restorePackage' ? { id: 9 } : {});
    assert.equal(result.code, 500);
    assert.doesNotMatch(result.body.error, /SQL|Detalle interno/);
    assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
    assert.ok(!queries.some(q => q.sql === 'COMMIT'));
  }
});

const packageBody = overrides => ({ id: 9, name: 'Depilación combinada', total_cost: 90, estimated_sessions: 6, ...overrides });
const admin = () => Object.assign(actor, { role: 'clinic_admin', finance_enabled: true, finance_scope: 'all' });
const initialPosting = overrides => ({ id: 30, clinic_id: clinicId, source_module: 'treatments',
  source_type: 'treatment_package_initial', source_id: 9, source_package_id: 9,
  type: 'ingreso', entity: 'Paciente ficticio QA', subtotal: 26.09, tax: 3.91,
  total: 30, tax_rate: 15, invoice_number: 'QA-001', created_by_user_id: 42,
  description: 'Paquete Depilación combinada · abono inicial', ...overrides });

test('crear abono positivo registra ingreso e ítem automáticamente y reintentos no duplican', async () => {
  reset(); admin();
  const body = { record_id: 4, consultation_id: 7, treatment_mode: 'facial', name: 'Paquete QA',
    total_cost: 90, estimated_sessions: 6, initial_payment: 30,
    finance_posting: { enabled: false, includes_iva: true, invoice_number: 'QA-002',
      idempotency_key: '12345678-1234-4234-8234-123456789abc' } };
  const first = await request('createPackage', 'POST', {}, body);
  assert.equal(first.code, 201);
  assert.equal(postings.length, 1);
  assert.equal(postings[0].total, 30);
  assert.equal(postings[0].entity, 'Paciente ficticio QA');
  assert.equal(postings[0].source_id, first.body.id);
  assert.equal(postings[0].source_package_id, first.body.id);
  assert.equal(postings[0].source_record_id, 4);
  assert.equal(postings[0].source_consultation_id, 7);
  assert.equal(items[0].total, 30);
  assert.equal(items[0].subtotal + items[0].tax, 30);
  assert.equal((await request('createPackage', 'POST', {}, body)).code, 200);
  assert.equal(postings.length, 1);
  assert.equal(packages.length, 2);
  assert.equal((await request('createPackage', 'POST', {}, { ...body, initial_payment: 31 })).code, 409);
  assert.equal(postings[0].total, 30);
});

test('crear paquete sin abono conserva acceso clínico y no inventa un ingreso de cero', async () => {
  reset();
  const result = await request('createPackage', 'POST', {}, { record_id: 4, consultation_id: 7,
    name: 'QA sin abono', total_cost: 90, estimated_sessions: 6, initial_payment: 0 });
  assert.equal(result.code, 201);
  assert.equal(result.body.initial_payment, 0);
  assert.equal(postings.length, 0);
  assert.equal(items.length, 0);
});

test('editar abono sincroniza ingreso e ítem sin cambiar factura, fecha, ID ni otros cobros', async () => {
  reset(); admin();
  postings = [initialPosting({ date: '2026-10-01', idempotency_key: 'original' }),
    initialPosting({ id: 31, source_type: 'treatment_session', source_id: 77, total: 20 })];
  sessions = [{ id: 77, package_id: 9, record_id: 4, consultation_id: 7, clinic_id: clinicId, cost: 20 }];
  items = [{ record_id: 30, clinic_id: clinicId, total: 30 }, { record_id: 31, clinic_id: clinicId, total: 20 }];
  const result = await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 46, name: 'Nuevo nombre QA' }));
  assert.equal(result.code, 200);
  assert.equal(result.body.initial_payment, 46);
  assert.equal(result.body.sessions_paid, 20);
  assert.equal(postings[0].total, 46);
  assert.equal(postings[0].subtotal, 40);
  assert.equal(postings[0].tax, 6);
  assert.equal(postings[0].invoice_number, 'QA-001');
  assert.equal(postings[0].idempotency_key, 'original');
  assert.equal(postings[0].date, '2026-10-01');
  assert.equal(postings[0].description, 'Paquete Nuevo nombre QA · abono inicial');
  assert.equal(postings[1].total, 20);
  assert.equal(items.find(i => i.record_id === 30).total, 46);
  assert.equal(items.find(i => i.record_id === 31).total, 20);
});

test('cero exige confirmación y elimina solo ingreso inicial e ítem; puede recrear el abono', async () => {
  reset(); admin();
  postings = [initialPosting(), initialPosting({ id: 31, source_type: 'treatment_session', source_id: 77, total: 20 })];
  items = [{ record_id: 30, clinic_id: clinicId, total: 30 }, { record_id: 31, clinic_id: clinicId, total: 20 }];
  const body = packageBody({ initial_payment: 0 });
  for (const confirm of [undefined, false, 'true']) {
    const result = await request('updatePackage', 'POST', {}, { ...body, confirm_remove_initial_payment: confirm });
    assert.equal(result.code, 409);
    assert.equal(result.body.code, 'INITIAL_PAYMENT_CONFIRMATION_REQUIRED');
    assert.equal(packages[0].initial_payment, 30);
    assert.equal(postings.length, 2);
  }
  assert.equal((await request('updatePackage', 'POST', {}, { ...body, confirm_remove_initial_payment: true })).code, 200);
  assert.equal(packages[0].initial_payment, 0);
  assert.deepEqual(postings.map(p => p.id), [31]);
  assert.deepEqual(items.map(i => i.record_id), [31]);
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 15 }))).code, 200);
  assert.equal(postings.find(p => p.source_type === 'treatment_package_initial').total, 15);
  reset(); admin(); packages[0].initial_payment = 0; postings = [initialPosting()];
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 0 }))).code, 409);
  assert.equal(postings[0].total, 30);
});

test('paquete legado crea ingreso faltante al editar y conservar abono', async () => {
  reset(); admin();
  assert.equal((await request('updatePackage', 'POST', {}, packageBody())).code, 200);
  assert.equal(postings[0].total, 30);
  assert.equal(items[0].total, 30);
  assert.equal((await request('updatePackage', 'POST', {}, packageBody())).code, 200);
  assert.equal(postings.length, 1);
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 32.45 }))).code, 200);
  assert.equal(postings[0].tax, 0);
  assert.equal(postings[0].subtotal, 32.45);
  assert.equal(items[0].total, 32.45);
});

test('permisos financieros, alcance propio y clínica bloquean abonos sin escrituras persistentes', async () => {
  for (const permissions of [{ role: 'clinic_user', finance_enabled: true }, { role: 'clinic_admin', finance_enabled: false }]) {
    reset(); Object.assign(actor, permissions);
    assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 40 }))).code, 403);
    assert.equal(packages[0].initial_payment, 30);
    assert.equal((await request('createPackage', 'POST', {}, { record_id: 4, consultation_id: 7,
      name: 'QA', total_cost: 90, estimated_sessions: 6, initial_payment: 10,
      finance_posting: { idempotency_key: '12345678-1234-4234-8234-123456789abc' } })).code, 403);
    assert.equal(packages.length, 1);
  }
  reset(); admin(); actor.finance_scope = 'own';
  postings = [initialPosting({ created_by_user_id: 99 })];
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 40 }))).code, 403);
  assert.equal(packages[0].initial_payment, 30);
  assert.equal(postings[0].total, 30);
  reset(); admin(); packages[0].clinic_id = 'foreign';
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 40 }))).code, 404);
  reset(); actor.access_scope = 'own'; mayAccess = false;
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 40 }))).code, 403);
  assert.ok(!queries.some(q => /^(UPDATE|INSERT|DELETE)/.test(q.sql)));
  reset(); postings = [initialPosting()];
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ name: 'Renombrado QA' }))).code, 403);
  assert.equal(packages[0].name, 'Depilación combinada');
});

test('validación de abono conserva pagos por sesión, rechaza entradas inválidas y usa centavos', async () => {
  for (const amount of [-1, 'abc', '', true, [], {}, Infinity, NaN, null, 10000001]) {
    reset(); admin();
    assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: amount }))).code, 400);
    assert.equal(packages[0].initial_payment, 30);
  }
  reset(); admin();
  sessions = [{ id: 77, package_id: 9, record_id: 4, consultation_id: 7, clinic_id: clinicId, cost: 20 }];
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 70.01 }))).code, 400);
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 70 }))).code, 200);
  reset(); admin(); packages[0].initial_payment = 0.1;
  sessions = [{ id: 77, package_id: 9, record_id: 4, consultation_id: 7, clinic_id: clinicId, cost: 0.2 }];
  assert.equal((await request('updatePackage', 'POST', {}, packageBody({ total_cost: 0.3, initial_payment: 0.1 }))).code, 200);
});

test('fallos financieros o de auditoría revierten paquete, abono, ingreso e ítems sin falso éxito', async () => {
  for (const failure of ['finance', 'audit']) {
    reset(); admin(); postings = [initialPosting()]; items = [{ record_id: 30, clinic_id: clinicId, total: 30 }];
    financeFails = failure === 'finance'; auditFails = failure === 'audit';
    const result = await request('updatePackage', 'POST', {}, packageBody({ initial_payment: 40 }));
    assert.equal(result.code, 500);
    assert.doesNotMatch(result.body.error, /SQL|ficticio/);
    assert.equal(packages[0].initial_payment, 30);
    assert.equal(postings[0].total, 30);
    assert.equal(items[0].total, 30);
    assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
    assert.ok(!queries.some(q => q.sql === 'COMMIT'));
  }
  reset(); admin(); financeFails = true;
  assert.equal((await request('createPackage', 'POST', {}, { record_id: 4, consultation_id: 7,
    name: 'QA', total_cost: 90, estimated_sessions: 6, initial_payment: 10,
    finance_posting: { idempotency_key: '12345678-1234-4234-8234-123456789abc' } })).code, 500);
  assert.equal(packages.length, 1);
  assert.equal(postings.length, 0);
});

test('crear abonos exige clave estable para no duplicar cobros por reintentos', async () => {
  reset(); admin();
  const body = { record_id: 4, consultation_id: 7, name: 'QA', total_cost: 90, estimated_sessions: 6, initial_payment: 30 };
  for (const key of [undefined, '', 'invalid']) {
    assert.equal((await request('createPackage', 'POST', {}, { ...body, finance_posting: { idempotency_key: key } })).code, 400);
    assert.equal(packages.length, 1);
    assert.equal(postings.length, 0);
  }
});

test('Finanzas bloquea cambios directos del abono e ítems y permite solo fecha y factura', async () => {
  reset(); admin(); postings = [initialPosting()];
  items = [{ record_id: 30, clinic_id: clinicId, total: 30 }];
  assert.equal((await request('financeDelete', 'POST', {}, { id: 30 })).code, 409);
  for (const details of [[], [{ description: 'QA', quantity: 1, unit_price: 40, iva_rate: 0 }]]) {
    assert.equal((await request('financeItemsSave', 'POST', {}, { record_id: 30, items: details })).code, 409);
  }
  const body = { id: 30, date: '2026-10-14', invoice_number: 'QA-NEW', entity: postings[0].entity,
    description: postings[0].description, type: 'ingreso', subtotal: 26.09, tax: 3.91, total: 30 };
  for (const mutation of [{ total: 31 }, { subtotal: 25 }, { tax: 5 }, { type: 'egreso' },
    { description: 'Otro tratamiento' }, { entity: 'Otro paciente' }, { total: true }]) {
    assert.equal((await request('financeUpdate', 'POST', {}, { ...body, ...mutation })).code, 409);
  }
  assert.equal(postings[0].total, 30);
  assert.equal(items[0].total, 30);
  assert.equal((await request('financeUpdate', 'POST', {}, body)).code, 200);
  assert.equal(postings[0].invoice_number, 'QA-NEW');
  assert.equal(postings[0].date, '2026-10-14');
  assert.equal(packages[0].initial_payment, 30);
  assert.equal(postings[0].total, 30);
  const metadataOnly = { id: 30, date: '2026-10-15', invoice_number: 'QA-METADATA' };
  assert.equal((await request('financeUpdate', 'POST', {}, metadataOnly)).code, 200);
  assert.equal(postings[0].invoice_number, 'QA-METADATA');
  assert.equal(postings[0].total, 30);
  for (const invalid of [{ date: '2026-02-30' }, { date: 'invalid' }, { invoice_number: {} }, { invoice_number: 'x'.repeat(101) }]) {
    assert.equal((await request('financeUpdate', 'POST', {}, { ...metadataOnly, ...invalid })).code, 400);
    assert.equal(postings[0].invoice_number, 'QA-METADATA');
  }
  const metadataUpdate = queries.find(q => q.sql.includes('UPDATE financial_records SET date = $1'));
  assert.doesNotMatch(metadataUpdate.sql, /subtotal|tax|total|description/);
  reset(); admin(); actor.finance_scope = 'own'; postings = [initialPosting({ created_by_user_id: 99 })];
  for (const action of ['financeDelete', 'financeUpdate', 'financeItemsSave']) {
    assert.equal((await request(action, 'POST', {}, { ...body, record_id: 30, items: [] })).code, 403);
  }
});
