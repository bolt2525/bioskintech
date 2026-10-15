import assert from 'node:assert/strict';
import test from 'node:test';
import { attachTreatmentFinanceSummary } from '../api/records.js';

const clinicId = '11111111-2222-4333-8444-555555555555';
const treatments = [1, 2, 3, 4, 5].map(id => ({ id, cost: id === 5 ? 0 : 10, package_id: 9 }));
const packages = [{ id: 9, initial_payment: 0, sessions_paid: 40, total_cost: 60 }];
const actor = { role: 'clinic_admin', finance_enabled: true, finance_scope: 'all', user_id: 42 };
const options = { treatments, packages, recordId: 4, consultationId: 7, clinicId, sessionUser: actor };
const fixture = (overrides = {}) => ({
  source_type: 'treatment_session', source_id: 4, package_id: 9,
  total: '10.00', type: 'ingreso', finance_visible: true, ...overrides,
});
const database = postings => ({
  calls: [],
  async query(sql, params) {
    this.calls.push({ sql, params });
    assert.match(sql, /fr\.clinic_id = \$1/);
    assert.match(sql, /fr\.source_module = 'treatments'/);
    assert.match(sql, /t\.record_id = \$2/);
    assert.match(sql, /tp\.record_id = \$2/);
    assert.match(sql, /t\.consultation_id = \$3/);
    assert.match(sql, /tp\.consultation_id = \$3/);
    assert.match(sql, /t\.clinic_id = fr\.clinic_id/);
    assert.match(sql, /tp\.clinic_id = fr\.clinic_id/);
    assert.match(sql, /JOIN sharing_group_members/);
    assert.doesNotMatch(sql, /SELECT \*|invoice_number|entity|patient_name/);
    return { rows: postings };
  },
});

test('40 anotados y 10 en Finanzas se distinguen por paquete y sesión sin crear asientos', async () => {
  const db = database([fixture()]);
  const result = await attachTreatmentFinanceSummary(db, options);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, [clinicId, 4, 7, false, 42]);
  assert.equal(result.packages[0].sessions_paid, 40);
  assert.equal(result.packages[0].finance_registered_total, 10);
  assert.equal(result.packages[0].finance_record_count, 1);
  assert.equal(result.packages[0].initial_finance_registered_total, 0);
  assert.deepEqual(result.treatments.map(t => t.finance_registered_total), [0, 0, 0, 10, 0]);
  assert.deepEqual(result.treatments.map(t => t.finance_record_count), [0, 0, 0, 1, 0]);
  assert.equal(treatments[3].finance_registered_total, undefined);
});

test('abono inicial, sesiones, IVA incluido y egresos se agregan en centavos sin duplicarlos', async () => {
  const db = database([
    fixture({ source_type: 'treatment_package_initial', source_id: 9, total: '0.10' }),
    fixture({ total: '0.20' }),
    fixture({ source_id: 2, total: '0.05', type: 'egreso' }),
  ]);
  const result = await attachTreatmentFinanceSummary(db, options);
  assert.equal(result.packages[0].finance_registered_total, 0.25);
  assert.equal(result.packages[0].finance_record_count, 3);
  assert.equal(result.packages[0].initial_finance_registered_total, 0.1);
  assert.equal(result.packages[0].initial_finance_record_count, 1);
  assert.equal(result.treatments[3].finance_registered_total, 0.2);
  assert.equal(result.treatments[1].finance_registered_total, -0.05);
});

test('sin permiso de Finanzas no consulta asientos ni revela importes o conteos', async () => {
  for (const user of [undefined, { ...actor, finance_enabled: false }, { role: 'clinic_user' }]) {
    const db = database([fixture()]);
    const result = await attachTreatmentFinanceSummary(db, { ...options, sessionUser: user });
    assert.equal(db.calls.length, 0);
    for (const row of [...result.treatments, ...result.packages]) {
      assert.equal(row.finance_registered_total, null);
      assert.equal(row.finance_record_count, null);
    }
    assert.equal(result.packages[0].initial_finance_registered_total, null);
    assert.equal(result.packages[0].initial_finance_record_count, null);
  }
});

test('alcance propio oculta todo agregado parcial, pero conserva sesiones visibles y ausencia confirmada', async () => {
  const db = database([fixture(), fixture({ source_id: 2, total: '99.00', finance_visible: false })]);
  const result = await attachTreatmentFinanceSummary(db, {
    ...options, sessionUser: { ...actor, finance_scope: 'own' },
  });
  assert.equal(db.calls[0].params[3], true);
  assert.equal(result.packages[0].finance_registered_total, null);
  assert.equal(result.packages[0].finance_record_count, null);
  assert.equal(result.treatments[1].finance_registered_total, null);
  assert.equal(result.treatments[1].finance_record_count, null);
  assert.equal(result.treatments[3].finance_registered_total, 10);
  assert.equal(result.treatments[0].finance_registered_total, 0);
});

test('master y usuario clínico con permiso pueden leer sin requerir permiso administrativo de escritura', async () => {
  for (const user of [{ ...actor, role: 'clinic_user' }, { ...actor, role: 'master_admin', finance_enabled: false, finance_scope: 'own' }]) {
    const db = database([fixture()]);
    const result = await attachTreatmentFinanceSummary(db, { ...options, sessionUser: user });
    assert.equal(result.packages[0].finance_registered_total, 10);
    assert.equal(db.calls[0].params[3], false);
  }
});

test('sin datos evita consulta adicional y sesiones independientes nunca se atribuyen a un paquete', async () => {
  const db = database([fixture({ source_id: 1, package_id: null, total: 7 })]);
  const empty = await attachTreatmentFinanceSummary(db, { ...options, treatments: [], packages: [] });
  assert.deepEqual(empty, { treatments: [], packages: [] });
  assert.equal(db.calls.length, 0);
  const result = await attachTreatmentFinanceSummary(db, { ...options, consultationId: null });
  assert.equal(db.calls[0].params[2], null);
  assert.equal(result.treatments[0].finance_registered_total, 7);
  assert.equal(result.packages[0].finance_registered_total, 0);
});

test('fallos financieros se notifican sin éxito falso, cero de respaldo ni detalles SQL', async () => {
  await assert.rejects(attachTreatmentFinanceSummary({
    query: async () => { throw Object.assign(new Error('SELECT SQL privado'), { code: '42P01' }); },
  }, options), error => {
    assert.match(error.message, /No se pudieron consultar los cobros/);
    assert.doesNotMatch(error.message, /SELECT|SQL|privado|42P01/);
    return true;
  });
});
