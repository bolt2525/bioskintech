import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let role = 'master_admin';
let complete = false;
let purges = 0;
let previews = 0;
let purging = false;
let listedClinics = [];
let commitFails = false;
let duplicateAfterWrite = false;
const writerCalls = [];
const writer = {
  async query(statement, params) {
    writerCalls.push({ statement, params });
    if (statement === 'COMMIT' && commitFails) throw new Error('Fictitious commit failure');
    if (statement.includes('INSERT INTO clinic_users') && duplicateAfterWrite)
      throw new Error('duplicate fictitious username');
    if (statement.includes("SELECT c.is_active,cs.general ? '_purge'"))
      return { rows: [{ is_active: true, purging }] };
    if (statement.includes('RETURNING')) return { rows: [{ id: 2 }] };
    return { rows: [] };
  },
  release() {},
};
const sqlCalls = [];
const sql = async (strings, ...params) => {
  const statement = strings.join('?');
  sqlCalls.push({ statement, params });
  return { rows: statement.includes('FROM admin_sessions s') ? [
    { username: 'master-test', role, clinic_id: null, clinic_user_id: 1, expires_at: '2099-01-01' },
  ] : statement.includes('SELECT c.id FROM clinics c') ? listedClinics
    : statement.includes('SELECT clinic_id FROM clinic_users WHERE id=') ? [{ clinic_id: ID }] : [] };
};
sql.query = async () => ({ rows: [] });
const moduleUrl = path => new URL(path, import.meta.url).href;
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module(moduleUrl('../lib/neon-clinical-db.js'), { namedExports: {
  getPool: () => ({ connect: async () => writer }), getAppPool: () => null,
  withTenantContext: async () => {}, initClinicalDatabase: async () => {},
} });
mock.module(moduleUrl('../lib/clinic-purge.js'), { namedExports: {
  clinicPurgePreview: async id => { previews++; return { success: true, clinic: { id }, complete: false }; },
  purgeClinic: async () => { purges++; return { success: true, complete, purge: { state: complete ? 'COMPLETE' : 'QUIESCING' } }; },
  updateClinicState: async () => { throw new Error('Not expected'); },
} });
const { default: handler } = await import('../api/admin-auth.js');
const ID = '11111111-2222-4333-8444-555555555555';
async function request(action, method, authenticated = true, body = {}) {
  const response = { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) {
      this.body = body;
      this.responses = (this.responses || 0) + 1;
      this.statementsAtResponse = writerCalls.map(call => call.statement);
      return this;
    } };
  await handler({ method, headers: { ...(authenticated ? { authorization: 'Bearer test-only' } : {}) },
    query: { action, id: ID }, body: { id: ID, ...body } }, response);
  return response;
}

test('purge actions require a master session before invoking the purge service', async () => {
  const anonymous = await request('purgeClinic', 'POST', false);
  assert.equal(anonymous.code, 401);
  role = 'clinic_admin';
  assert.equal((await request('purgeClinic', 'POST')).code, 403);
  assert.equal((await request('clinicPurgePreview', 'GET')).code, 403);
  assert.equal(purges, 0);
  assert.equal(previews, 0);
  role = 'master_admin';
});

test('preview/purge enforce HTTP method and distinguish accepted work from completion', async () => {
  assert.equal((await request('purgeClinic', 'GET')).code, 405);
  assert.equal((await request('clinicPurgePreview', 'POST')).code, 405);
  const preview = await request('clinicPurgePreview', 'GET');
  assert.equal(preview.code, 200);
  assert.equal(preview.headers['Cache-Control'], 'no-store');
  assert.equal(preview.body.clinic.id, ID);
  const pending = await request('purgeClinic', 'POST');
  assert.equal(pending.code, 202);
  assert.equal(pending.body.complete, false);
  complete = true;
  const finished = await request('purgeClinic', 'POST');
  assert.equal(finished.code, 200);
  assert.equal(finished.body.complete, true);
});

test('legacy direct clinic deletion is blocked and never executes DELETE clinics or purge service', async () => {
  const before = purges;
  const result = await request('deleteClinic', 'POST');
  assert.equal(result.code, 409);
  assert.equal(result.body.success, false);
  assert.equal(purges, before);
  assert.equal(sqlCalls.some(call => /DELETE FROM clinics/i.test(call.statement)), false);
});

test('real admin createUser/setFeature writers cannot target a COMPLETE tombstone', async () => {
  purging = true;
  for (const [action, data] of [
    ['createUser', { clinic_id: ID, username: 'qa-ficticio', password: 'PasswordTest123', role: 'clinic_user' }],
    ['setFeature', { clinicId: ID, feature: 'backup', enabled: true }],
    ['updateClinicSubscription', { clinic_id: ID, subscription_days: 365 }],
  ]) {
    const start = writerCalls.length;
    const result = await request(action, 'POST', true, data);
    assert.equal(result.code, 409);
    const calls = writerCalls.slice(start).map(c => c.statement);
    assert.equal(calls[0], 'BEGIN');
    assert.ok(calls.some(c => c.includes('pg_advisory_xact_lock_shared')));
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.equal(calls.some(c => /^\s*(INSERT|UPDATE|DELETE)/.test(c)), false);
  }
  purging = false;
});

test('setFeature executes writes on the same guarded transaction, not on the global SQL client', async () => {
  const start = writerCalls.length, globalStart = sqlCalls.length;
  const result = await request('setFeature', 'POST', true, { clinicId: ID, feature: 'backup', enabled: true });
  assert.equal(result.code, 200);
  const calls = writerCalls.slice(start).map(c => c.statement);
  const guard = calls.findIndex(c => c.includes("SELECT c.is_active,cs.general ? '_purge'"));
  const insert = calls.findIndex(c => c.includes('INSERT INTO clinic_features'));
  assert.ok(guard >= 0 && insert > guard);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(sqlCalls.slice(globalStart).some(c => c.statement.includes('INSERT INTO clinic_features')), false);
});

test('contradictory clinic aliases are rejected before acquiring the wrong tenant lock', async () => {
  const start = writerCalls.length;
  const result = await request('createUser', 'POST', true, {
    clinicId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', clinic_id: ID,
    username: 'qa-ficticio', password: 'PasswordTest123', role: 'clinic_user',
  });
  assert.equal(result.code, 400);
  assert.equal(writerCalls.length, start);
});

test('initFeatures never recreates features of a purged clinic', async () => {
  listedClinics = [{ id: ID }];
  purging = true;
  const start = writerCalls.length;
  const result = await request('initFeatures', 'POST');
  assert.equal(result.code, 200);
  assert.equal(result.body.initialized, 0);
  const calls = writerCalls.slice(start).map(call => call.statement);
  assert.ok(calls.some(statement => statement.includes('pg_advisory_xact_lock_shared')));
  assert.equal(calls.some(statement => statement.includes('INSERT INTO clinic_features')), false);
  assert.equal(calls.at(-1), 'COMMIT');
  listedClinics = [];
  purging = false;
});

test('returned 4xx after a write attempt rolls back rather than committing', async () => {
  duplicateAfterWrite = true;
  try {
    const start = writerCalls.length;
    const result = await request('createUser', 'POST', true, {
      clinic_id: ID, username: 'qa-ficticio', password: 'PasswordTest123', role: 'clinic_user',
    });
    assert.equal(result.code, 400);
    const calls = writerCalls.slice(start).map(call => call.statement);
    assert.ok(calls.some(statement => statement.includes('INSERT INTO clinic_users')));
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.equal(calls.includes('COMMIT'), false);
  } finally { duplicateAfterWrite = false; }
});

test('commit failure emits exactly one 500 and successful JSON waits for commit', async () => {
  commitFails = true;
  try {
    const failed = await request('setFeature', 'POST', true, { clinicId: ID, feature: 'backup', enabled: true });
    assert.equal(failed.code, 500);
    assert.equal(failed.body.success, false);
    assert.equal(failed.responses, 1);
  } finally { commitFails = false; }
  const result = await request('setFeature', 'POST', true, { clinicId: ID, feature: 'backup', enabled: true });
  assert.equal(result.code, 200);
  assert.equal(result.responses, 1);
  assert.equal(result.statementsAtResponse.at(-1), 'COMMIT');
});

test('updateDemoCredentials locks the tenant resolved from the target user and rejects discordant clinic fields', async () => {
  purging = true;
  const start = writerCalls.length;
  const result = await request('updateDemoCredentials', 'POST', true, { userId: 7, username: 'demo_qa' });
  assert.equal(result.code, 409);
  const calls = writerCalls.slice(start);
  assert.ok(calls.some(c => c.statement.includes('pg_advisory_xact_lock_shared') && JSON.stringify(c.params).includes(ID)));
  assert.equal(calls.some(c => /^\s*(INSERT|UPDATE|DELETE)/.test(c.statement)), false);
  purging = false;
  const before = writerCalls.length;
  const wrong = await request('updateDemoCredentials', 'POST', true, {
    userId: 7, clinicId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', username: 'demo_qa' });
  assert.equal(wrong.code, 400);
  assert.equal(writerCalls.length, before);
});

test('writer tenant comes from the action field only: setFeature ignores no alias and createUser never uses clinicId', async () => {
  const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const start = writerCalls.length;
  // createUser with only clinicId (not its field) must not lock OTHER.
  await request('createUser', 'POST', true, { clinicId: OTHER, username: 'qa', password: 'PasswordTest123', role: 'clinic_user' });
  assert.equal(writerCalls.slice(start).some(c => JSON.stringify(c.params || []).includes(OTHER)), false);
  const s2 = writerCalls.length;
  await request('setFeature', 'POST', true, { clinicId: ID, feature: 'backup', enabled: true });
  assert.ok(writerCalls.slice(s2).some(c => c.statement.includes('pg_advisory_xact_lock_shared') && JSON.stringify(c.params).includes(ID)));
});

test('initFeatures listing excludes inactive and tombstoned clinics before per-clinic locked recheck', async () => {
  const start = sqlCalls.length;
  await request('initFeatures', 'POST');
  const listing = sqlCalls.slice(start).find(c => c.statement.includes('FROM clinics c'));
  assert.match(listing.statement, /is_active = true/);
  assert.match(listing.statement, /_purge/);
});
