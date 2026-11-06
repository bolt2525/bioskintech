import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let role = 'master_admin', userClinic = CLINIC, targetClinic = CLINIC, active = true;
let writes = [], queries = [];
async function execute(text, params = []) {
  text = text.replace(/\s+/g, ' ').trim();
  queries.push(text);
  if (text.includes('FROM admin_sessions s')) return { rows: active ? [{
    username: 'test-actor', role, clinic_id: role === 'master_admin' ? null : userClinic,
    clinic_user_id: 1, access_scope: 'all', expires_at: '2099-01-01',
  }] : [] };
  if (text.startsWith('SELECT clinic_id FROM clinic_users')) return { rows: [{ clinic_id: targetClinic }] };
  if (text.startsWith('SELECT 1 FROM clinic_users')) return { rows: params[1] === targetClinic ? [{ ok: 1 }] : [] };
  if (text.startsWith('INSERT INTO user_module_overrides')) writes.push(params);
  return { rows: [] };
}
const sql = (parts, ...params) => execute(parts.reduce((text, part, index) =>
  text + part + (index < params.length ? `$${index + 1}` : ''), ''), params);
sql.query = execute;
sql.connect = async () => ({ query: execute, release() {} });
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module(new URL('../lib/neon-clinical-db.js', import.meta.url).href, {
  namedExports: { getPool: () => ({ connect: sql.connect, query: execute }) },
});
mock.module(new URL('../lib/admin-auth.js', import.meta.url).href, {
  namedExports: {
    sessionPolicy: async () => ({ allowed: true, lifecycle: { state: 'ACTIVE', canoperate: true } }),
    requireAuth: async () => { throw new Error('Unexpected auth path'); },
    authenticateRequest: async () => { throw new Error('Unexpected auth path'); },
  },
});
mock.module(new URL('../lib/clinic-lifecycle.js', import.meta.url).href, {
  namedExports: {
    lockClinicWriters: async () => {}, unlockClinicWriters: async () => {},
    requireClinicWritable: async () => {}, reserveClinicLifecycle: async () => {},
    lifecycleClinicIds: values => values,
  },
});
const net = mock.method(globalThis, 'fetch', () => { throw new Error('HTTP forbidden'); });
const { default: handler } = await import('../api/admin-auth.js');
async function run(body, method = 'POST') {
  writes = []; queries = [];
  const res = {
    code: 0, body: null, setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({
    method, query: { action: 'setUserModuleOverride' },
    headers: { authorization: 'Bearer fictitious-session' }, body,
  }, res);
  return res;
}

test('only master may grant OR revoke cost-bearing permission, returns exact success true', async () => {
  for (const enabled of [true, false]) {
    role = 'master_admin';
    const r = await run({ userId: '7', feature: 'skin_visual_ai', enabled });
    assert.equal(r.code, 200);
    assert.deepEqual(r.body, { success: true });
    assert.deepEqual(writes, [[7, 'skin_visual_ai', enabled, enabled]]);
    role = 'clinic_admin';
    assert.equal((await run({ userId: 7, feature: 'skin_visual_ai', enabled })).code, 403);
    assert.equal(writes.length, 0);
    role = 'clinic_user';
    assert.equal((await run({ userId: 7, feature: 'skin_visual_ai', enabled })).code, 403);
    assert.equal(writes.length, 0);
  }
});

test('override feature, enabled and ID validate BEFORE target SQL, without coercion', async () => {
  role = 'master_admin';
  for (const body of [
    { userId: 7, feature: 'skin_visual_ai', enabled: 'false' },
    { userId: 7, feature: 'skin_visual_ai', enabled: 1 },
    { userId: 7, feature: 'skin_visual_ai' },
    { userId: '7 OR 1=1', feature: 'skin_visual_ai', enabled: true },
    { userId: -7, feature: 'skin_visual_ai', enabled: true },
    { userId: 7, feature: ['skin_visual_ai'], enabled: true },
    { userId: 7, feature: 'invented', enabled: true },
  ]) {
    assert.equal((await run(body)).code, 400);
    assert.ok(!queries.some(q => q.startsWith('SELECT clinic_id FROM clinic_users')));
    assert.equal(writes.length, 0);
  }
  assert.equal((await run({ userId: 7, feature: 'skin_visual_ai', enabled: true }, 'GET')).code, 405);
});

test('other overrides retain clinic-admin compatibility and tenant isolation; inactive session denied', async () => {
  role = 'clinic_admin';
  assert.equal((await run({ userId: 7, feature: 'clinical_records', enabled: false })).code, 200);
  assert.deepEqual(writes, [[7, 'clinical_records', false, false]]);
  targetClinic = OTHER;
  assert.equal((await run({ userId: 7, feature: 'clinical_records', enabled: true })).code, 403);
  assert.equal(writes.length, 0);
  targetClinic = CLINIC;
  active = false;
  assert.equal((await run({ userId: 7, feature: 'skin_visual_ai', enabled: true })).code, 401);
  assert.equal(writes.length, 0);
  active = true;
  assert.equal(net.mock.callCount(), 0);
});
