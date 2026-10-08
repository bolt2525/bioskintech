import assert from 'node:assert/strict';
import test from 'node:test';
import { clinicPurgePreview, purgeClinic, purgeReasons, isPurgeKey, orderPurgeTables,
  purgeExpiredClinics, updateClinicState, validatePurgeConfirmation, planWhatsAppPurge, minimalSubscriptionReceipt } from '../lib/clinic-purge.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const actor = { id: 1, username: 'master-test', role: 'master_admin' };
const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86400000;
const dependenciesByPool = new WeakMap();
const body = { id: ID, confirmation: 'clinica-prueba', reason: 'Autorizacion ficticia de prueba',
  authorizationConfirmed: true, retentionConfirmed: true };

function database(options = {}) {
  const state = {
    clinic: { id: ID, name: 'Clinica ficticia', slug: body.confirmation, is_active: false,
      subscription_expires_at: '2026-08-01T00:00:00Z', ...options.clinic },
    job: options.job || null, counts: { clinical_photos: 2, patients: 1, clinic_users: 1, ...options.counts },
    columns: options.columns || ['clinical_photos', 'patients', 'clinic_users', 'clinic_settings', 'subscriptions', 'legal_acceptances']
      .map(table_name => ({ table_name, udt_name: 'uuid' })),
    statements: [], sessionsRevoked: false, signingRevoked: false, lifecyclePersisted: false,
    annualChecks: 0, annualDeadlines: [],
    schedule: null, wa: structuredClone(options.wa || null), receipts: structuredClone(options.receipts || []),
  };
  let snapshot;
  const db = {
    async query(sql, params = []) {
      state.statements.push({ sql, params });
      if (sql === 'BEGIN') { snapshot = structuredClone({ job: state.job, clinic: state.clinic, counts: state.counts,
        schedule: state.schedule, wa: state.wa, receipts: state.receipts }); return { rows: [] }; }
      if (sql === 'ROLLBACK') { Object.assign(state, snapshot); return { rows: [] }; }
      if (sql === 'COMMIT' || sql.startsWith('SET LOCAL') || sql.startsWith('LOCK TABLE')) return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: !options.writerActive }] };
      if (sql.startsWith('SELECT c.id FROM clinics c'))
        return { rows: options.candidates || [] };
      if (sql.includes('AS deferred')) return { rows: [{ deferred: 0 }] };
      if (sql.includes('table_name=ANY($1::text[])')) return { rows: state.wa ? params[0].map(table_name => ({ table_name })) : [] };
      if (sql.startsWith('SELECT id,phone,clinic_id FROM whatsapp_contacts')) return { rows: state.wa.contacts };
      if (sql.startsWith('SELECT id,clinic_id,phone,whatsapp_staff_phone')) return { rows: state.wa.users };
      if (sql.includes('u.clinic_id AS owner_clinic_id')) return { rows: state.wa.messages };
      if (sql.startsWith('SELECT phone,data FROM whatsapp_bot_state')) return { rows: state.wa.states };
      if (sql.startsWith('SELECT code,target_url FROM wa_short_links')) return { rows: state.wa.links };
      if (sql.startsWith('DELETE FROM whatsapp_messages')) {
        state.wa.messages = state.wa.messages.filter(m => !params[0].includes(m.contact_id)); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM whatsapp_contacts')) {
        state.wa.contacts = state.wa.contacts.filter(c => !(c.clinic_id === params[0] && params[1].includes(c.id))); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM whatsapp_bot_state')) {
        state.wa.states = state.wa.states.filter(s => !params[0].includes(s.phone)); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM wa_short_links')) {
        state.wa.links = state.wa.links.filter(s => !params[0].includes(s.code)); return { rows: [] };
      }
      if (sql.startsWith('SELECT id,payphone_response FROM subscriptions')) return { rows: state.receipts };
      if (sql.startsWith('UPDATE subscriptions SET payphone_response')) {
        state.receipts.find(r => r.id === params[0]).payphone_response = JSON.parse(params[1]); return { rows: [] };
      }
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
      if (sql.includes('information_schema.columns') && sql.includes("table_name='clinic_users'")) return { rows: [] };
      if (sql.includes('information_schema.columns')) return { rows: state.columns };
      if (sql.includes('FROM pg_constraint')) return { rows: options.foreignKeys || [] };
      if (sql.includes('FROM pg_attribute')) return { rows: options.attrs || [] };
      if (sql.includes('JOIN') && sql.includes('clinic_id IS DISTINCT')) return { rows: options.crossed ? [{}] : [] };
      if (sql.includes('count(*) AS count')) {
        const table = sql.match(/FROM "([^"]+)"/)[1];
        return { rows: [{ count: state.counts[table] || 0 }] };
      }
      if (sql.startsWith('INSERT INTO clinic_settings')) {
        if (sql.includes("'purge_schedule'")) state.schedule = JSON.parse(params[1]);
        else state.job = JSON.parse(params[1]);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE admin_sessions')) { state.sessionsRevoked = true; return { rows: [] }; }
      if (sql.startsWith('UPDATE clinic_users SET is_active=false')) return { rows: [] };
      if (sql.startsWith('UPDATE consent_forms SET signing_token=NULL')) {
        assert.equal(params[0], ID);
        state.signingRevoked = true;
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE clinics SET is_active=false')) {
        state.clinic.is_active = false;
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
  const pool = { connect: async () => db };
  const lifecycleDeps = {
    loadSubscriptionLifecycle: async (_db, _id, now) => {
      const expiry = Date.parse(state.clinic.subscription_expires_at);
      return options.lifecycle || {
        state: 'CLOSED', policy: 'demo', expires_at: state.clinic.subscription_expires_at,
        recovery_ends_at: Number.isFinite(expiry) ? new Date(expiry + 30 * DAY).toISOString() : null,
      };
    },
    annualPurgeProtection: async (_db, _id, deadline) => {
      state.annualChecks++;
      state.annualDeadlines.push(deadline);
      return options.annualPending || options.annualProtected
        ? { protected: true, until: new Date(NOW + DAY).toISOString(), reason: 'Existe una entrega anual pendiente.' }
        : { protected: false, until: null, reason: null };
    },
    persistSubscriptionLifecycle: async () => { state.lifecyclePersisted = true; },
  };
  dependenciesByPool.set(pool, lifecycleDeps);
  return { state, pool, lifecycleDeps };
}

function purge(bodyValue, actorValue, deps = {}) {
  return purgeClinic(bodyValue, actorValue, { ...dependenciesByPool.get(deps.pool), ...deps });
}

function purgePreview(id, pool) {
  return clinicPurgePreview(id, pool, dependenciesByPool.get(pool));
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

test('purge boundaries preserve demo retention but never apply an unaccepted legacy 30-day fallback', () => {
  assert.equal(purgeReasons({ is_active: false, subscription_expires_at: new Date(NOW - 30 * 86400000).toISOString() }, NOW).length, 1);
  assert.equal(purgeReasons({ is_active: false, subscription_expires_at: new Date(NOW - 30 * 86400000 + 1).toISOString() }, NOW).length, 2);
  assert.equal(purgeReasons({ is_active: true, subscription_expires_at: null }, NOW).length, 3);
  const paid = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 45 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 1).toISOString() };
  assert.equal(purgeReasons({ is_active: false }, NOW, paid).length, 0);
  assert.equal(purgeReasons({ is_active: false }, NOW,
    { ...paid, expires_at: new Date(NOW - 30 * DAY).toISOString() }).length, 1);
  assert.equal(purgeReasons({ is_active: false }, NOW, { ...paid, state: 'RECOVERY' }).length, 1);
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
    await assert.rejects(purge(body, actor, { pool, now: () => NOW,
      list: async () => { calls++; }, remove: async () => { calls++; } }), { status: 409 });
    assert.equal(calls, 0);
    assert.equal(state.job, null);
  }
  await assert.rejects(purge(body, { role: 'clinic_admin' }), { status: 403 });
});

test('first request stores irreversible authorization, revokes sessions and waits for issued leases', async () => {
  const { pool, state } = database();
  let calls = 0;
  const out = await purge(body, actor, { pool, now: () => NOW,
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
  const preview = await purgePreview(ID, pool);
  assert.equal(preview.eligible, false);
  assert.match(preview.reasons.join(' '), /entrega anual/);
  assert.equal(state.annualChecks, 1);
  await assert.rejects(purge(body, actor, { pool, now: () => NOW }), { status: 409 });
  assert.equal(state.job, null);
  assert.equal(state.statements.some(s => /^\s*(UPDATE|DELETE).*annual_photo_backup_requests/.test(s.sql)), false);
});

test('master purge keeps paid subscriptions in recovery until the complete T+45 boundary', async () => {
  const recovering = { policy: 'paid', auto_purge_eligible: true, state: 'RECOVERY',
    expires_at: new Date(NOW - 30 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW + 15 * DAY).toISOString() };
  const blocked = database({ lifecycle: recovering });
  await assert.rejects(purge(body, actor, { pool: blocked.pool, now: () => NOW }), { status: 409 });
  assert.equal(blocked.state.job, null);
  assert.equal(blocked.state.annualChecks, 0);

  const closed = { ...recovering, state: 'CLOSED',
    expires_at: new Date(NOW - 45 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 1).toISOString() };
  const eligible = database({ lifecycle: closed });
  const result = await purge(body, actor, { pool: eligible.pool, now: () => NOW });
  assert.equal(result.purge.state, 'QUIESCING');
  assert.equal(eligible.state.annualDeadlines[0], closed.recovery_ends_at);
});

test('every destructive batch reruns schema eligibility before touching R2', async () => {
  const { pool, state } = database({ job: { state: 'RUNNING', phase: 'PHOTOS',
    retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 } });
  const r2 = storage();
  await purge(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove });
  const before = r2.deleted.length;
  state.columns.push({ table_name: 'new_unreviewed_tenant_data', udt_name: 'uuid' });
  await assert.rejects(purge(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove }), { status: 409 });
  assert.equal(r2.deleted.length, before);
});

test('SQL preflight has a total bounded budget and aborts without calling R2 on exhaustion', async t => {
  const { pool, state } = database();
  let clock = NOW;
  t.mock.method(Date, 'now', () => { clock += 6001; return clock; });
  let r2Calls = 0;
  await assert.rejects(purge(body, actor, { pool, now: () => NOW,
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
  await purge(body, actor, deps);
  clock += 26 * 60000;
  let result = await purge(body, actor, deps);
  for (let i = 0; i < 8 && result.purge.phase !== 'BACKUPS'; i++) result = await purge(body, actor, deps);
  result = await purge(body, actor, deps);
  assert.equal(result.complete, false);
  assert.equal(result.purge.state, 'WAITING_STORAGE');
  assert.equal(result.purge.waitingStorage.pendingObjects, 1);
  assert.equal(r2.deleted.some(key => key.startsWith(`backups/${ID}/`)), false);
  r2.objects.splice(r2.objects.indexOf(`backups/${ID}/auto/retener.json.gz.enc`), 1);
  clock = Date.parse(result.purge.retryAfter) + 1;
  await purge(body, actor, deps);
  result = await purge(body, actor, deps);
  assert.equal(result.complete, true);
  assert.equal(result.purge.deletedObjects, 3);
  assert.deepEqual(r2.objects, [`clinics/${OTHER}/records/1/photos/ajena.jpg`]);
  assert.deepEqual(state.counts, { clinical_photos: 0, patients: 0, clinic_users: 1 });
  assert.equal(state.clinic.id, ID);
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.statements.some(s => /DELETE FROM clinics/.test(s.sql)), false);
  assert.equal(state.statements.some(s => /DELETE FROM "legal_acceptances"/.test(s.sql)), false);
  assert.equal(state.statements.some(s => /DELETE FROM "clinic_users"/.test(s.sql)), false);
  assert.ok(state.statements.some(s => s.sql.includes('UPDATE clinic_users SET is_active=false')));
  assert.ok(state.statements.some(s => s.sql.startsWith('UPDATE clinic_settings SET general=jsonb_build_object') &&
    s.sql.includes("general->'_subscription_policy'")), 'purge retains contractual acceptance evidence');
  const preview = await purgePreview(ID, pool);
  assert.equal(preview.complete, true);
  assert.equal(preview.retainedBackups.retentionDays, 35);
  const again = await purge(body, actor, deps);
  assert.equal(again.complete, true);
  assert.equal(r2.deleted.length, 3);
});

test('R2 failure records FAILED, retains reserve and never deletes SQL data or reports success', async () => {
  const { pool, state } = database({ job: { state: 'RUNNING', phase: 'PHOTOS', retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 } });
  await assert.rejects(purge(body, actor, { pool, now: () => NOW,
    list: async () => ({ objects: [{ key: `clinics/${ID}/records/1/photos/test.jpg` }] }),
    remove: async () => { throw new Error('synthetic R2 outage'); } }), { status: 502 });
  assert.equal(state.job.state, 'FAILED');
  assert.equal(state.job.last_error, 'PURGE_BATCH_FAILED');
  assert.equal(Date.parse(state.job.leaseUntil), NOW + 300000);
  assert.equal(state.statements.some(s => s.sql.startsWith('DELETE FROM')), false);
  await assert.rejects(purge(body, actor, { pool, now: () => NOW }), { status: 409 });
});

test('SQL failure rolls back all tenant changes and preserves FAILED tombstone for assisted retry', async () => {
  const { pool, state } = database({ sqlFails: true, job: { state: 'RUNNING', phase: 'SQL',
    retryAfter: new Date(NOW - 1).toISOString(),
    backupRetentionUntil: new Date(NOW - 1).toISOString(), deletedObjects: 3 } });
  await assert.rejects(purge(body, actor, { pool, now: () => NOW }), { status: 502 });
  assert.equal(state.job.state, 'FAILED');
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.counts.patients, 1);
  assert.equal(state.statements.some(s => s.sql === 'ROLLBACK'), true);
});

test('retained receipt identities do not retain passwords or indirect authentication tokens', async () => {
  const children = ['login_otp', 'trusted_devices', 'password_setup_tokens', 'oauth_states', 'user_module_overrides'];
  const foreignKeys = children.map((child, index) => ({
    child, parent: 'clinic_users', delete_type: 'c', child_columns: [2], parent_columns: [1],
    child_oid: index + 100, parent_oid: 50,
  }));
  const attrs = [
    { attrelid: 50, attnum: 1, attname: 'id' },
    ...children.map((_, index) => ({ attrelid: index + 100, attnum: 2, attname: 'user_id' })),
  ];
  const { pool, state } = database({
    job: { state: 'RUNNING', phase: 'SQL', retryAfter: new Date(NOW - 1).toISOString(),
      backupRetentionUntil: new Date(NOW - 1).toISOString(), deletedObjects: 0 },
    foreignKeys, attrs, counts: Object.fromEntries(children.map(table => [table, 1])),
  });
  assert.equal((await purge(body, actor, { pool, now: () => NOW })).complete, true);
  for (const child of children) {
    assert.equal(state.counts[child], 0);
    const deletion = state.statements.find(s => s.sql.startsWith(`DELETE FROM "${child}"`));
    assert.ok(deletion.sql.includes('p.clinic_id=$1 AND c."user_id"=p."id"'));
    assert.deepEqual(deletion.params, [ID]);
    assert.ok(state.statements.some(s => s.sql.startsWith('LOCK TABLE') && s.sql.includes(`"${child}"`)));
  }
  const scrub = state.statements.find(s => s.sql.startsWith('UPDATE clinic_users SET is_active=false')).sql;
  assert.ok(scrub.includes("password_hash='',salt=NULL"));
  assert.ok(scrub.includes('hash_algo=NULL'));
  assert.ok(!scrub.includes("role='clinic_admin'"));
  assert.ok(!state.statements.some(s => s.sql.startsWith('DELETE FROM "legal_acceptances"')));
});

test('unclassified dependents of retained identities block storage deletion before purge starts', async () => {
  const { pool } = database({ foreignKeys: [{
    child: 'future_identity_data', parent: 'clinic_users', delete_type: 'c',
    child_columns: [2], parent_columns: [1], child_oid: 100, parent_oid: 50,
  }] });
  let storageCalls = 0;
  await assert.rejects(purge(body, actor, { pool, now: () => NOW,
    list: async () => { storageCalls++; return { objects: [] }; },
    remove: async () => { storageCalls++; },
  }), { status: 409 });
  assert.equal(storageCalls, 0);
});

test('a batch never deletes more than 100 keys and cannot delete an unexpected key', async () => {
  const ready = { state: 'RUNNING', phase: 'PHOTOS', retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 };
  const { pool } = database({ job: ready });
  const r2 = storage();
  r2.objects.unshift(...Array.from({ length: 110 }, (_, i) => `clinics/${ID}/records/1/photos/f-${i}.jpg`));
  const result = await purge(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove });
  assert.equal(r2.deleted.length, 100);
  assert.equal(result.complete, false);
  assert.equal(result.purge.phase, 'PHOTOS');
  const invalid = database({ job: { ...ready, leaseUntil: null } });
  const removed = [];
  await assert.rejects(purge(body, actor, { pool: invalid.pool, now: () => NOW,
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

test('automatic purge closes only paid subscriptions after T+45 and records a quiescence tombstone without master claims', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  const { pool, state, lifecycleDeps } = database({
    clinic: { is_active: true },
    candidates: [{ id: ID }],
    lifecycle,
  });
  let calls = 0;
  const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => { calls++; return { objects: [] }; },
    remove: async () => { calls++; } });
  assert.equal(report.scanned, 1);
  assert.equal(report.waiting, 1);
  assert.equal(report.results[0].state, 'QUIESCING');
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.sessionsRevoked, true);
  assert.equal(state.lifecyclePersisted, true);
  assert.equal(state.job.mode, 'AUTOMATIC');
  assert.equal(state.job.state, 'QUIESCING');
  assert.equal('actorId' in state.job, false);
  assert.equal('authorizationConfirmed' in state.job, false);
  assert.equal(Date.parse(state.job.retryAfter), NOW + 25 * 60000);
  assert.equal(calls, 0);
});

test('automatic purge rechecks writer locks and annual eligibility before creating any tombstone', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  for (const options of [{ writerActive: true }, { annualProtected: true }]) {
    const { pool, state, lifecycleDeps } = database({
      ...options, candidates: [{ id: ID }], lifecycle, clinic: { is_active: true },
    });
    let calls = 0;
    const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
      list: async () => { calls++; return { objects: [] }; },
      remove: async () => { calls++; } });
    assert.equal(calls, 0);
    assert.equal(state.job, null);
    assert.equal(state.clinic.is_active, true);
    if (options.annualProtected) {
      assert.equal(report.results[0].state, 'WAITING_ANNUAL');
      assert.equal(report.waiting, 1);
    } else {
      assert.equal(report.results[0].state, 'BLOCKED');
      assert.equal(report.failed, 1);
    }
  }
});

test('automatic purge never treats demo, legacy or recovery states as paid-closed evidence', async () => {
  const paidRecovery = { policy: 'paid', auto_purge_eligible: true, state: 'RECOVERY',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW + DAY).toISOString() };
  const unknownLegacy = { policy: 'legacy', state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  for (const lifecycle of [paidRecovery, unknownLegacy, { ...unknownLegacy, policy: 'demo' },
    { ...unknownLegacy, policy: 'paid', auto_purge_eligible: false }]) {
    const { pool, state, lifecycleDeps } = database({
      candidates: [{ id: ID }], lifecycle, clinic: { is_active: true },
    });

    test('manual confirmed purge cannot retroactively apply 30 or 45 days to legacy or paid unaccepted contracts', async () => {
      for (const policy of ['legacy','paid']) {
        const lifecycle = { policy, state: 'CLOSED', auto_purge_eligible: false,
          expires_at: new Date(NOW - 100 * DAY).toISOString(),
          recovery_ends_at: new Date(NOW - 55 * DAY).toISOString() };
        const { pool, state } = database({ lifecycle });
        await assert.rejects(purge(body, actor, { pool, now: () => NOW,
          list: async () => assert.fail('No R2 before contractual eligibility') }), { status: 409 });
        assert.equal(state.job, null);
        assert.equal(state.sessionsRevoked, false);
      }
    });

    test('SQL purge deletes verified WA PHI and sanitizes subscription JSON, keeping other-tenant rows unchanged', async () => {
      const wa = {
        contacts: [{ id: 1, clinic_id: ID, phone: '593999000111' }, { id: 2, clinic_id: OTHER, phone: '593999000222' }],
        users: [{ id: 7, clinic_id: ID, phone: '0999000111' }, { id: 8, clinic_id: OTHER, phone: '0999000222' }],
        messages: [{ id: 1, contact_id: 1, booked_by_user_id: 7, owner_clinic_id: ID },
          { id: 2, contact_id: 2, booked_by_user_id: 8, owner_clinic_id: OTHER }],
        states: [{ phone: '593999000111', data: { medicalNote: 'target' } }, { phone: '593999000222', data: { medicalNote: 'foreign' } }],
        links: [{ code: `${ID}.${'a'.repeat(22)}`, target_url: 'https://wa.me/593999000111?text=medical-target' },
          { code: `${OTHER}.${'b'.repeat(22)}`, target_url: 'https://wa.me/593999000222?text=medical-foreign' }],
      };
      const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
        expires_at: new Date(NOW - 50 * DAY).toISOString(), recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
      const { pool, state, lifecycleDeps } = database({ wa, lifecycle, candidates: [{ id: ID }],
        receipts: [{ id: 1, payphone_response: { transactionId: 123, customerName: 'Patient', clinicalNote: 'PHI' } }],
        job: { mode: 'AUTOMATIC', state: 'RUNNING', phase: 'SQL', retryAfter: new Date(NOW - 1).toISOString(),
          backupRetentionUntil: new Date(NOW - DAY).toISOString(), deletedObjects: 0 } });
      const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 15000, ...lifecycleDeps });
      assert.equal(report.completed, 1);
      assert.deepEqual(state.wa.contacts, [wa.contacts[1]]);
      assert.deepEqual(state.wa.messages, [wa.messages[1]]);
      assert.deepEqual(state.wa.states, [wa.states[1]]);
      assert.deepEqual(state.wa.links, [wa.links[1]]);
      assert.deepEqual(state.receipts[0].payphone_response, { transactionId: 123 });
      assert.ok(state.statements.some(s => s.sql.includes('LOCK TABLE') && s.sql.includes('"wa_short_links"')));
      assert.deepEqual(planWhatsAppPurge(ID, state.wa), { contactIds: [], statePhones: [], linkCodes: [] });
      assert.deepEqual(minimalSubscriptionReceipt(state.receipts[0].payphone_response), { transactionId: 123 });
    });

    test('ambiguous WhatsApp attribution is durably BLOCKED for assisted review before any storage deletion', async () => {
      const { pool, state, lifecycleDeps } = database({
        lifecycle: { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
          expires_at: new Date(NOW - 50 * DAY).toISOString(), recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() },
        candidates: [{ id: ID }], wa: { contacts: [], users: [], messages: [], states: [],
          links: [{ code: 'unattributed', target_url: 'https://wa.me/593000000000?text=PHI' }] },
      });
      const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 15000, ...lifecycleDeps,
        list: async () => assert.fail('Never delete before ownership proof') });
      assert.equal(report.complete, false);
      assert.equal(report.results[0].state, 'BLOCKED');
      assert.equal(state.schedule.state, 'BLOCKED');
      assert.equal(state.schedule.reason, 'ASSISTED_REVIEW_REQUIRED');
      assert.equal(state.job, null);
    });
    const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps });
    assert.equal(report.skipped, 1);
    assert.equal(state.job, null);
    assert.equal(state.clinic.is_active, true);
  }
});

test('automatic backup phase durably waits and retries without deleting encrypted backups or reporting completion', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  const { pool, state, lifecycleDeps } = database({
    candidates: [{ id: ID }], lifecycle,
    job: { mode: 'AUTOMATIC', state: 'RUNNING', phase: 'BACKUPS',
      retryAfter: new Date(NOW - 1).toISOString(), backupRetentionUntil: new Date(NOW + 30 * DAY).toISOString(),
      deletedObjects: 0 },
  });
  let lists = 0, deletes = 0;
  const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async prefix => {
      lists++;
      assert.equal(prefix, `backups/${ID}/`);
      return { objects: [{ key: `backups/${ID}/auto/2026-10-01.json.gz.enc` }], truncated: false };
    },
    remove: async () => { deletes++; } });
  assert.equal(report.completed, 0);
  assert.equal(report.waiting, 1);
  assert.equal(report.results[0].state, 'WAITING_STORAGE');
  assert.equal(state.job.state, 'WAITING_STORAGE');
  assert.equal(state.job.phase, 'BACKUPS');
  assert.equal(state.job.waitingStorage.pendingObjects, 1);
  assert.equal(Date.parse(state.job.retryAfter), NOW + 24 * 60 * 60000);
  assert.equal(lists, 1);
  assert.equal(deletes, 0);

  const retry = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => { lists++; return { objects: [] }; },
    remove: async () => { deletes++; } });
  assert.equal(retry.results[0].state, 'WAITING_STORAGE');
  assert.equal(lists, 1, 'the persisted retry time avoids an early storage poll');
  assert.equal(deletes, 0);
});

test('automatic cron reports a partial run when its execution budget expires', async () => {
  const { pool, state, lifecycleDeps } = database({ candidates: [{ id: ID }] });
  let ticks = 0;
  const report = await purgeExpiredClinics({ pool, now: () => ticks++ ? NOW + 2 : NOW,
    budgetMs: 1, ...lifecycleDeps });
  assert.equal(report.scanned, 1);
  assert.equal(report.budgetExhausted, true);
  assert.equal(report.results.length, 0);
  assert.equal(state.job, null);
});

test('mature encrypted backups delete only after unlock, and SQL waits for a fresh empty listing', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  const { pool, state, lifecycleDeps } = database({
    candidates: [{ id: ID }], lifecycle,
    job: { mode: 'AUTOMATIC', state: 'RUNNING', phase: 'BACKUPS',
      retryAfter: new Date(NOW - 1).toISOString(),
      backupRetentionUntil: new Date(NOW - 1).toISOString(), deletedObjects: 0 },
  });
  const retainedKey = `backups/${ID}/auto/old.json.gz.enc`;
  let deletes = 0;
  const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => ({ objects: [{ key: retainedKey, lastModified: new Date(NOW - 30 * DAY).toISOString() }], truncated: false }),
    remove: async () => { deletes++; } });
  assert.equal(report.completed, 0);
  assert.equal(state.job.phase, 'BACKUPS');
  assert.equal(deletes, 1);
  const retry = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => ({ objects: [], truncated: false }), remove: async () => assert.fail('Already empty') });
  assert.equal(retry.completed, 1);
  assert.equal(state.job.state, 'COMPLETE');
});
