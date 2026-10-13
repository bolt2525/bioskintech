import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const clinicId = '11111111-2222-4333-8444-555555555555';
let actor, packages, sessions, postings, queries, mayAccess, auditFails;
const rows = values => ({ rows: values, rowCount: values.length });
const db = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK|SET)/.test(sql) || sql.includes('set_config')) return rows([]);
    if (sql.includes('INSERT INTO patient_audit_log')) {
      if (auditFails) throw new Error('Detalle interno de SQL');
      return rows([]);
    }
    if (sql.includes('FROM clinical_records cr')) return rows(mayAccess ? [{ id: 4 }] : []);
    if (sql.includes('SELECT record_id FROM treatment_packages')) return rows(packages.filter(p => p.id == params[0] && p.clinic_id === actor.clinic_id));
    if (sql.includes('FROM consultations')) return rows(params[0] === 7 && params[1] === 4 && params[2] === clinicId ? [{ id: 7 }] : []);
    if (sql.includes('FROM financial_records')) {
      return rows(postings.filter(p => p.clinic_id === params[0] && (p.source_package_id === params[1]
        || (p.source_type === 'treatment_package_initial' && p.source_id === params[1]))));
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
        && (!sql.includes('archived_at IS NULL') || !p.archived_at)));
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
      Object.assign(found, { name: params[0], total_cost: params[1], estimated_sessions: params[2] });
      return rows([found]);
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
  sessions = []; postings = []; queries = []; mayAccess = true; auditFails = false;
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
