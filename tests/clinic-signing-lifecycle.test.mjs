import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { reserveClinicLifecycle } from '../lib/clinic-lifecycle.js';

const ID = '11111111-2222-4333-8444-555555555555';
const token = 'a'.repeat(64);
let active = true, purging = false, shared = 0, released = 0;
let onLock = () => {};
let queryHook = async () => {};
const writes = [];
const statements = [];
const app = {
  async query(sql) {
    statements.push(sql);
    await queryHook(sql);
    if (sql.includes('pg_advisory_lock_shared')) { onLock(); shared++; }
    if (sql.includes('pg_advisory_unlock_shared')) shared--;
    if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) writes.push(sql);
    return { rows: [] };
  },
  release() { released++; },
};
const owner = {
  async query(sql) {
    statements.push(sql);
    await queryHook(sql);
    if (sql.startsWith('SELECT clinic_id FROM consent_forms')) return { rows: [{ clinic_id: ID }] };
    if (sql.includes("SELECT c.is_active,cs.general ? '_purge'"))
      return { rows: [{ is_active: active, purging }] };
    if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) writes.push(sql);
    return { rows: [] };
  },
};
const moduleUrl = path => new URL(path, import.meta.url).href;
mock.module(moduleUrl('../lib/neon-clinical-db.js'), { namedExports: {
  initClinicalDatabase: async () => {},
  getPool: () => owner, getAppPool: () => ({ connect: async () => app }),
  withTenantContext: async (_id, fn) => fn(app),
} });
mock.module(moduleUrl('../lib/admin-auth.js'), { namedExports: {
  authenticateRequest: async () => ({ valid: true, id: 1, role: 'master_admin', clinic_id: ID, effective_clinic_id: ID }),
  requireAuth: async () => null, requireRole: () => true,
} });
const { default: records } = await import('../api/records.js');
const response = () => ({ code: null, body: null, setHeader() {},
  status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

test('deactivation winning before signing generation locks cannot publish a new token', async () => {
  active = true; purging = false; onLock = () => { active = false; };
  const res = response();
  await records({ method: 'POST', headers: {}, query: { action: 'generateSigningToken' }, body: { id: 1 } }, res);
  assert.equal(res.code, 409);
  assert.deepEqual(writes, []);
  assert.equal(shared, 0);
  assert.equal(released, 1);
});

test('purge winning after public token lookup blocks all signing reads and writers on fresh state', async () => {
  const before = released;
  for (const action of ['getSigningSession', 'verifySigningCode', 'submitSignature']) {
    active = true; purging = false;
    onLock = () => { purging = true; };
    const res = response();
    await records({ method: action === 'getSigningSession' ? 'GET' : 'POST', headers: {},
      query: { action, token }, body: { token } }, res);
    assert.equal(res.code, 409);
    assert.deepEqual(writes, []);
    assert.equal(shared, 0);
  }
  assert.equal(released, before + 3);
  assert.equal(statements.some(sql => sql.includes('SET signing_token =')), false);
});

test('real generateSigningToken and submitSignature handlers hold the common lock at their sensitive consent query', async () => {
  const previous = process.env.ADMIN_SETUP_SECRET;
  process.env.ADMIN_SETUP_SECRET = 'fictitious-test-secret';
  const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
  try {
    for (const action of ['generateSigningToken', 'submitSignature']) {
      active = true; purging = false; onLock = () => {};
      let reached, resume;
      const entered = new Promise(resolve => { reached = resolve; });
      const continuation = new Promise(resolve => { resume = resolve; });
      queryHook = async sql => {
        if ((action === 'generateSigningToken' && sql.includes('pg_advisory_lock(68420')) ||
            (action === 'submitSignature' && sql.includes('SELECT signatures, signing_snapshot'))) {
          reached();
          await continuation;
        }
      };
      const result = response();
      const pending = records({ method: 'POST', headers: {}, query: { action },
        body: action === 'generateSigningToken' ? { id: 1 } : { token, signature,
          declarations: { understanding: true, authorization: true, questions: true,
            results: true, revocation: true, alternatives: true },
          authorizations: { image_use: false, photo_video: false, privacy_policy: true } } }, result);
      await Promise.race([entered, pending.then(() => {
        throw new Error(`Handler returned ${result.code} before reaching the interleaving point`);
      })]);
      assert.equal(shared, 1);
      await assert.rejects(reserveClinicLifecycle({
        query: async sql => {
          assert.match(sql, /pg_try_advisory_xact_lock/);
          return { rows: [{ acquired: shared === 0 }] };
        },
      }, ID), { status: 409 });
      resume();
      await pending;
      assert.equal(shared, 0);
      assert.ok([404, 409].includes(result.code));
      assert.deepEqual(writes, []);
    }
  } finally {
    queryHook = async () => {};
    if (previous === undefined) delete process.env.ADMIN_SETUP_SECRET;
    else process.env.ADMIN_SETUP_SECRET = previous;
  }
});
