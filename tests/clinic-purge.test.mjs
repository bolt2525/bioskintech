import assert from 'node:assert/strict';
import test from 'node:test';
import { clinicPurgePreview, purgeClinic, purgeReasons, isPurgeKey, orderPurgeTables,
  updateClinicState, validatePurgeConfirmation } from '../lib/clinic-purge.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const actor = { id: 1, username: 'master-test', role: 'master_admin' };
const NOW = Date.parse('2026-10-07T12:00:00Z');
const body = { id: ID, confirmation: 'clinica-prueba', reason: 'Autorizacion ficticia de prueba',
  authorizationConfirmed: true, retentionConfirmed: true };

function database(options = {}) {
  const state = {
    clinic: { id: ID, name: 'Clinica ficticia', slug: body.confirmation, is_active: false,
      subscription_expires_at: '2026-08-01T00:00:00Z', ...options.clinic },
    job: options.job || null, counts: { clinical_photos: 2, patients: 1, clinic_users: 1, ...options.counts },
    columns: options.columns || ['clinical_photos', 'patients', 'clinic_users', 'clinic_settings', 'subscriptions']
      .map(table_name => ({ table_name, udt_name: 'uuid' })),
    statements: [], sessionsRevoked: false, signingRevoked: false,
  };
  let snapshot;
  const db = {
    async query(sql, params = []) {
      state.statements.push({ sql, params });
      if (sql === 'BEGIN') { snapshot = structuredClone({ job: state.job, clinic: state.clinic, counts: state.counts }); return { rows: [] }; }
      if (sql === 'ROLLBACK') { Object.assign(state, snapshot); return { rows: [] }; }
      if (sql === 'COMMIT' || sql.startsWith('SET LOCAL') || sql.startsWith('LOCK TABLE')) return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: !options.writerActive }] };
      if (sql.includes("to_regclass('public.annual_photo_backup_requests')"))
        return { rows: [{ table_name: options.annualPending ? 'annual_photo_backup_requests' : null }] };
      if (sql.includes('SELECT 1 FROM annual_photo_backup_requests'))
        return { rows: options.annualPending ? [{}] : [] };
      if (sql.includes('SELECT id,name,slug')) return { rows: [structuredClone(state.clinic)] };
      if (sql.startsWith('SELECT general FROM')) return { rows: [{ general: state.job ? { _purge: structuredClone(state.job) } : {} }] };
      if (sql.includes('information_schema.columns') && sql.includes("table_name='consent_forms'"))
        return { rows: state.columns.some(c => c.table_name === 'consent_forms') ? [{}] : [] };
      if (sql.includes('information_schema.columns') && sql.includes("table_name='clinic_settings'"))
        return { rows: ['general', 'treatments', 'email', 'agenda', 'finanzas', 'inventario', 'notificaciones']
          .map(column_name => ({ column_name, udt_name: 'jsonb' })) };
      if (sql.includes('information_schema.columns')) return { rows: state.columns };
      if (sql.includes('FROM pg_constraint')) return { rows: options.foreignKeys || [] };
      if (sql.includes('FROM pg_attribute')) return { rows: options.attrs || [] };
      if (sql.includes('JOIN') && sql.includes('clinic_id IS DISTINCT')) return { rows: options.crossed ? [{}] : [] };
      if (sql.includes('count(*) AS count')) {
        const table = sql.match(/FROM "([^"]+)"/)[1];
        return { rows: [{ count: state.counts[table] || 0 }] };
      }
      if (sql.startsWith('INSERT INTO clinic_settings')) { state.job = JSON.parse(params[1]); return { rows: [] }; }
      if (sql.startsWith('UPDATE admin_sessions')) { state.sessionsRevoked = true; return { rows: [] }; }
      if (sql.startsWith('UPDATE consent_forms SET signing_token=NULL')) {
        assert.equal(params[0], ID);
        state.signingRevoked = true;
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE clinics SET')) {
        if (params[5] !== null) state.clinic.is_active = params[5];
        return { rows: [structuredClone(state.clinic)] };
      }
      if (sql.startsWith('DELETE FROM')) {
        if (options.sqlFails) throw Object.assign(new Error('synthetic FK failure'), { code: '23503' });
        assert.equal(params[0], ID);
        const table = sql.match(/DELETE FROM "([^"]+)"/)[1];
        state.counts[table] = 0;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT 1 FROM "')) {
        const table = sql.match(/FROM "([^"]+)"/)[1];
        return { rows: state.counts[table] ? [{}] : [] };
      }
      if (sql.startsWith('UPDATE clinic_settings SET general=jsonb_build_object')) {
        state.job = JSON.parse(params[1]); return { rows: [] };
      }
      throw new Error(`Unexpected mock SQL: ${sql}`);
    },
    release() {},
  };
  return { state, pool: { connect: async () => db } };
}

function storage() {
  const objects = [
    `clinics/${ID}/records/1/photos/ficticia.jpg`,
    `backup-tmp/${ID}/exports/ficticio.gz`,
    `annual-photo-backups/${ID}/request/part-0001.zip`,
    `backups/${ID}/auto/retener.json.gz.enc`,
    `clinics/${OTHER}/records/1/photos/ajena.jpg`,
  ];
  const deleted = [];
  return {
    objects, deleted,
    list: async prefix => ({ objects: objects.filter(key => key.startsWith(prefix)).slice(0, 100).map(key => ({ key })) }),
    remove: async key => { deleted.push(key); objects.splice(objects.indexOf(key), 1); },
  };
}

test('purge boundaries require inactive, 30 full days, destination and documented consent', () => {
  assert.equal(purgeReasons({ is_active: false, subscription_expires_at: new Date(NOW - 30 * 86400000).toISOString() }, NOW).length, 0);
  assert.equal(purgeReasons({ is_active: false, subscription_expires_at: new Date(NOW - 30 * 86400000 + 1).toISOString() }, NOW).length, 1);
  assert.equal(purgeReasons({ is_active: true, subscription_expires_at: null }, NOW).length, 2);
  for (const change of [{ confirmation: 'otra' }, { authorizationConfirmed: false },
    { retentionConfirmed: false }, { reason: 'corto' }]) {
    assert.throws(() => validatePurgeConfirmation({ ...body, ...change }, { slug: body.confirmation }), { status: 400 });
  }
});

test('object ownership rejects other clinics, backups, traversal and non-photo clinical keys', () => {
  assert.equal(isPurgeKey(`clinics/${ID}/records/1/photos/f.jpg`, ID, 'PHOTOS'), true);
  for (const key of [`clinics/${OTHER}/records/1/photos/f.jpg`, `backups/${ID}/auto/f.enc`,
    `clinics/${ID}/records/1/photos/../f.jpg`, `clinics/${ID}/records/1/not-photo/f.jpg`,
    `clinics/${ID}/records/1/photos/sub/f.jpg`]) assert.equal(isPurgeKey(key, ID, 'PHOTOS'), false);
  assert.equal(isPurgeKey(`annual-photo-backups/${ID}/request/part.zip`, ID, 'ANNUAL'), true);
});

test('SQL deletes children before parents, and fails closed on cycles', () => {
  assert.deepEqual(orderPurgeTables(['periods', 'requests', 'parts'], [
    { child: 'requests', parent: 'periods' }, { child: 'parts', parent: 'requests' },
  ]), ['parts', 'requests', 'periods']);
  assert.throws(() => orderPurgeTables(['a', 'b'], [{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }]), { status: 409 });
});

test('rejects non-master and SQL preconditions before any R2 call', async () => {
  for (const options of [
    { clinic: { is_active: true } }, { clinic: { subscription_expires_at: null } },
    { columns: [{ table_name: 'unknown_table', udt_name: 'uuid' }] },
    { columns: [{ table_name: 'ai_consultations', udt_name: 'int4' }] },
    { counts: { patients: 50001 } }, { writerActive: true }, { annualPending: true },
  ]) {
    const { pool, state } = database(options);
    let calls = 0;
    await assert.rejects(purgeClinic(body, actor, { pool, now: () => NOW,
      list: async () => { calls++; }, remove: async () => { calls++; } }), { status: 409 });
    assert.equal(calls, 0);
    assert.equal(state.job, null);
  }
  await assert.rejects(purgeClinic(body, { role: 'clinic_admin' }), { status: 403 });
});

test('first request stores irreversible authorization, revokes sessions and waits for issued leases', async () => {
  const { pool, state } = database();
  let calls = 0;
  const out = await purgeClinic(body, actor, { pool, now: () => NOW,
    list: async () => { calls++; }, remove: async () => { calls++; } });
  assert.equal(out.complete, false);
  assert.equal(out.purge.state, 'QUIESCING');
  assert.equal(Date.parse(out.purge.retryAfter), NOW + 25 * 60000);
  assert.equal(state.sessionsRevoked, true);
  assert.equal(calls, 0);
  assert.equal(state.job.actorId, actor.id);
  await assert.rejects(updateClinicState({ id: ID, is_active: true }, pool), { status: 409 });
});

test('annual delivery availability blocks purge without cancelling a pending request or its download window', async () => {
  const { pool, state } = database({ annualPending: true });
  const preview = await clinicPurgePreview(ID, pool);
  assert.equal(preview.eligible, false);
  assert.match(preview.reasons.join(' '), /entrega anual/);
  const predicate = state.statements.find(s => s.sql.includes('SELECT 1 FROM annual_photo_backup_requests')).sql;
  assert.match(predicate, /status='REQUESTED'/);
  assert.match(predicate, /status='APPROVED' AND expired_at IS NULL/);
  assert.match(predicate, /status='READY' AND ready_at \+ interval '24 hours 10 minutes' > now\(\)/);
  await assert.rejects(purgeClinic(body, actor, { pool, now: () => NOW }), { status: 409 });
  assert.equal(state.job, null);
  assert.equal(state.statements.some(s => /^\s*(UPDATE|DELETE).*annual_photo_backup_requests/.test(s.sql)), false);
});

test('every destructive batch reruns schema eligibility before touching R2', async () => {
  const { pool, state } = database({ job: { state: 'RUNNING', phase: 'PHOTOS',
    retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 } });
  const r2 = storage();
  await purgeClinic(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove });
  const before = r2.deleted.length;
  state.columns.push({ table_name: 'new_unreviewed_tenant_data', udt_name: 'uuid' });
  await assert.rejects(purgeClinic(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove }), { status: 409 });
  assert.equal(r2.deleted.length, before);
});

test('SQL preflight has a total bounded budget and aborts without calling R2 on exhaustion', async t => {
  const { pool, state } = database();
  let clock = NOW;
  t.mock.method(Date, 'now', () => { clock += 6001; return clock; });
  let r2Calls = 0;
  await assert.rejects(purgeClinic(body, actor, { pool, now: () => NOW,
    list: async () => { r2Calls++; }, remove: async () => { r2Calls++; } }), { status: 503 });
  assert.equal(r2Calls, 0);
  assert.equal(state.job, null);
  assert.equal(state.statements.some(s => s.sql === 'ROLLBACK'), true);
  assert.ok(state.statements.some(s => /SET LOCAL statement_timeout = '\d+ms'/.test(s.sql)));
});

test('bounded retries purge only approved prefixes then transactionally delete tenant data and retain tombstone', async () => {
  const { pool, state } = database();
  const r2 = storage();
  let clock = NOW;
  const deps = { pool, now: () => clock, list: r2.list, remove: r2.remove };
  await purgeClinic(body, actor, deps);
  clock += 26 * 60000;
  let result;
  for (let i = 0; i < 8; i++) {
    result = await purgeClinic(body, actor, deps);
    if (result.complete) break;
  }
  assert.equal(result.complete, true);
  assert.equal(result.purge.deletedObjects, 3);
  assert.deepEqual(r2.objects, [`backups/${ID}/auto/retener.json.gz.enc`, `clinics/${OTHER}/records/1/photos/ajena.jpg`]);
  assert.deepEqual(state.counts, { clinical_photos: 0, patients: 0, clinic_users: 0 });
  assert.equal(state.clinic.id, ID);
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.statements.some(s => /DELETE FROM clinics/.test(s.sql)), false);
  const preview = await clinicPurgePreview(ID, pool);
  assert.equal(preview.complete, true);
  assert.equal(preview.retainedBackups.retentionDays, 35);
  const again = await purgeClinic(body, actor, deps);
  assert.equal(again.complete, true);
  assert.equal(r2.deleted.length, 3);
});

test('R2 failure records FAILED, retains reserve and never deletes SQL data or reports success', async () => {
  const { pool, state } = database({ job: { state: 'RUNNING', phase: 'PHOTOS', retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 } });
  await assert.rejects(purgeClinic(body, actor, { pool, now: () => NOW,
    list: async () => ({ objects: [{ key: `clinics/${ID}/records/1/photos/test.jpg` }] }),
    remove: async () => { throw new Error('synthetic R2 outage'); } }), { status: 502 });
  assert.equal(state.job.state, 'FAILED');
  assert.equal(state.job.last_error, 'PURGE_BATCH_FAILED');
  assert.equal(Date.parse(state.job.leaseUntil), NOW + 300000);
  assert.equal(state.statements.some(s => s.sql.startsWith('DELETE FROM')), false);
  await assert.rejects(purgeClinic(body, actor, { pool, now: () => NOW }), { status: 409 });
});

test('SQL failure rolls back all tenant changes and preserves FAILED tombstone for assisted retry', async () => {
  const { pool, state } = database({ sqlFails: true, job: { state: 'RUNNING', phase: 'SQL',
    retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 3 } });
  await assert.rejects(purgeClinic(body, actor, { pool, now: () => NOW }), { status: 502 });
  assert.equal(state.job.state, 'FAILED');
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.counts.patients, 1);
  assert.equal(state.statements.some(s => s.sql === 'ROLLBACK'), true);
});

test('a batch never deletes more than 100 keys and cannot delete an unexpected key', async () => {
  const ready = { state: 'RUNNING', phase: 'PHOTOS', retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 };
  const { pool } = database({ job: ready });
  const r2 = storage();
  r2.objects.unshift(...Array.from({ length: 110 }, (_, i) => `clinics/${ID}/records/1/photos/f-${i}.jpg`));
  const result = await purgeClinic(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove });
  assert.equal(r2.deleted.length, 100);
  assert.equal(result.complete, false);
  assert.equal(result.purge.phase, 'PHOTOS');
  const invalid = database({ job: { ...ready, leaseUntil: null } });
  const removed = [];
  await assert.rejects(purgeClinic(body, actor, { pool: invalid.pool, now: () => NOW,
    list: async () => ({ objects: [{ key: `clinics/${ID}/unexpected/file.jpg` }] }),
    remove: async key => removed.push(key) }), { status: 409 });
  assert.deepEqual(removed, []);
});

test('deactivation conserves tenant content and revokes all sessions in the same SQL transaction', async () => {
  const { pool, state } = database({ clinic: { is_active: true }, columns: [
    'clinical_photos', 'patients', 'clinic_users', 'consent_forms', 'clinic_settings', 'subscriptions',
  ].map(table_name => ({ table_name, udt_name: 'uuid' })) });
  await updateClinicState({ id: ID, is_active: false }, pool);
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.sessionsRevoked, true);
  assert.equal(state.signingRevoked, true);
  assert.equal(state.counts.patients, 1);
  assert.equal(state.job, null);
  assert.equal(state.statements.some(s => s.sql.startsWith('DELETE')), false);
});
