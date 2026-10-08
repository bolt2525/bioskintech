import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { mock } from 'node:test';

const ID = '11111111-2222-4333-8444-555555555555';
const url = path => new URL(path, import.meta.url).href;
const modules = ['finance', 'clinical_records', 'inventory'];
let role, clinicFeatures, overrides, permissionFlags, authFailure, sessionExists;
let authReads, poolReads, initializations, connections, businessQueries;
const reset = () => {
  role = 'clinic_user';
  clinicFeatures = {};
  overrides = {};
  permissionFlags = {};
  authFailure = false;
  sessionExists = true;
  authReads = poolReads = initializations = connections = businessQueries = 0;
};
reset();

// Verify the actual authorization SQL contract, then supply its result using
// local fixtures. No database, credentials, environment file or network needed.
const sql = async (strings, ...params) => {
  authReads++;
  const statement = strings.join('?');
  assert.ok(statement.includes('FROM admin_sessions s'));
  assert.deepEqual(params, ['fictitious-session']);
  for (const module of modules) {
    const features = module === 'finance'
      ? "feature IN \\('finance', 'finanzas_visible'\\)" : `feature = '${module}'`;
    assert.match(statement, new RegExp(
      `COALESCE\\(\\(\\s*SELECT enabled FROM clinic_features\\s*` +
      `WHERE clinic_id = s.clinic_id AND feature = '${module}'\\s*\\), true\\)\\s*` +
      `AND NOT EXISTS \\(\\s*SELECT 1 FROM user_module_overrides\\s*` +
      `WHERE clinic_user_id = s.clinic_user_id\\s*AND ${features}\\s*` +
      `AND enabled = false\\s*\\) AS ${module}_enabled`
    ));
  }
  if (authFailure) throw new Error('Fictitious authorization read failure');
  if (!sessionExists) return { rows: [] };
  return { rows: [{
    role, clinic_id: ID, clinic_user_id: 7, username: 'qa-user',
    clinic_active: true, subscription_expires_at: '2099-01-01', general: {},
    ...Object.fromEntries(modules.map(module => [`${module}_enabled`,
      Object.hasOwn(permissionFlags, module) ? permissionFlags[module]
        : (clinicFeatures[module] ?? true) && overrides[module] !== false
          && (module !== 'finance' || overrides.finanzas_visible !== false),
    ])),
  }] };
};
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module(url('../lib/neon-clinical-db.js'), { namedExports: {
  initClinicalDatabase: async () => { initializations++; },
  getPool: () => { businessQueries++; assert.fail('Owner DB must not be queried'); },
  getAppPool: () => {
    poolReads++;
    return { connect: async () => {
      connections++;
      return {
        query: async statement => {
          if (statement === 'SELECT NOW()') return { rows: [{ now: 'fictitious-time' }] };
          // Only lifecycle setup/cleanup is permitted; never business queries.
          assert.match(statement, /^(SET statement_timeout|SELECT set_config)/);
          return { rows: [] };
        },
        release() {},
      };
    } };
  },
} });
mock.module(url('../lib/clinic-lifecycle.js'), { namedExports: {
  lockClinicWriters: async () => {
    // Stop authorized requests at the business boundary, without executing
    // handlers or relying on complete synthetic patient/finance schemas.
    throw Object.assign(new Error('Fictitious lifecycle boundary'), { status: 409 });
  },
  unlockClinicWriters: async () => {},
  requireClinicWritable: async () => assert.fail('Must stop before business queries'),
  reserveClinicLifecycle: async () => assert.fail('No subscription mutation permitted'),
} });
mock.module(url('../lib/r2-service.js'), { namedExports: Object.fromEntries(
  ['generateUploadUrl', 'generateReadUrl', 'deleteR2Object', 'putR2Object']
    .map(name => [name, async () => assert.fail('No remote storage permitted')])
) });
mock.method(globalThis, 'fetch', async () => assert.fail('No network permitted'));
mock.method(console, 'log', () => {});
mock.method(console, 'error', () => {});

const { authenticateRequest } = await import('../lib/admin-auth.js');
const { default: records } = await import('../api/records.js');
const source = await readFile(new URL('../api/records.js', import.meta.url), 'utf8');
const privateActions = [...source.matchAll(/case '([^']+)'/g)]
  .map(match => match[1])
  .filter(action => !['getSigningSession', 'verifySigningCode', 'submitSignature'].includes(action));
const actionModule = action => action.startsWith('inventory') ? 'inventory'
  : action.startsWith('finance') || action === 'sendFinanceCsv' ? 'finance' : 'clinical_records';
const request = (action, body = {}, inBody = false) => ({
  method: 'POST', headers: { authorization: 'Bearer fictitious-session' },
  query: inBody ? {} : { action }, body: inBody ? { ...body, action } : body,
});
const response = () => ({
  code: null, body: null, setHeader() {}, end() { return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});
const call = async (action, body, inBody) => {
  const res = response();
  await records(request(action, body, inBody), res);
  return res;
};
const assertNoBusiness = () => {
  assert.equal(poolReads, 0);
  assert.equal(initializations, 0);
  assert.equal(connections, 0);
  assert.equal(businessQueries, 0);
};

test('authenticateRequest: clinic disable wins over allow override; user deny wins over clinic enable', async () => {
  for (const module of modules) {
    for (const [clinic, override, expected] of [
      [undefined, undefined, true], [true, undefined, true],
      [true, true, true], [true, false, false], [undefined, false, false],
      [false, undefined, false], [false, true, false], [false, false, false],
    ]) {
      reset();
      clinicFeatures[module] = clinic;
      overrides[module] = override;
      const auth = await authenticateRequest(request('listPatients'));
      assert.equal(auth.valid, true);
      assert.equal(auth[`${module}_enabled`], expected, `${module}: ${clinic}/${override}`);
      assertNoBusiness();
    }
  }
  reset();
  overrides.finanzas_visible = false;
  assert.equal((await authenticateRequest(request('financeList'))).finance_enabled, false);
});

test('every private dispatcher action denies its disabled module before initialization or business access', async () => {
  assert.ok(privateActions.length > 90);
  for (const action of privateActions) {
    for (const disabledBy of ['clinic', 'user']) {
      reset();
      const module = actionModule(action);
      if (disabledBy === 'clinic') {
        clinicFeatures[module] = false;
        overrides[module] = true; // An override cannot enable a disabled clinic module.
      } else {
        overrides[module] = false;
      }
      const res = await call(action);
      assert.equal(res.code, 403, `${action}/${disabledBy}`);
      assert.match(res.body.error, new RegExp(module));
      assertNoBusiness();
    }
  }
});

test('enabled actions reach the existing lifecycle boundary independently of unrelated disabled modules', async () => {
  for (const action of privateActions) {
    reset();
    for (const module of modules) clinicFeatures[module] = module === actionModule(action);
    const res = await call(action);
    assert.equal(res.code, 409, action);
    assert.equal(poolReads, 1, action);
    assert.equal(connections, 1, action);
    assert.equal(businessQueries, 0);
  }
});

test('master_admin retains module bypass for all private actions and clinical finance postings', async () => {
  for (const action of privateActions) {
    reset();
    role = 'master_admin';
    for (const module of modules) clinicFeatures[module] = overrides[module] = false;
    const res = await call(action, { finance_posting: { enabled: true } });
    assert.equal(res.code, 409, action);
    assert.equal(poolReads, 1);
  }
});

test('clinical finance posting gates both modules and existing admin role before business access', async () => {
  for (const action of ['addTreatment', 'updateTreatment', 'createPackage']) {
    for (const [testRole, finance, clinical, allowed] of [
      ['clinic_admin', false, true, false], ['clinic_user', true, true, false],
      ['clinic_admin', true, false, false], ['clinic_admin', true, true, true],
    ]) {
      reset();
      role = testRole;
      clinicFeatures.finance = finance;
      clinicFeatures.clinical_records = clinical;
      const res = await call(action, { finance_posting: { enabled: true } });
      assert.equal(res.code, allowed ? 409 : 403);
      if (!allowed) assertNoBusiness();
    }
    reset();
    clinicFeatures.finance = false;
    assert.equal((await call(action, { finance_posting: { enabled: false } })).code, 409);
  }
});

test('missing or non-boolean permission flags fail closed; action in body cannot bypass gating', async () => {
  for (const [module, action] of [['finance', 'financeList'], ['inventory', 'inventoryStats'], ['clinical_records', 'listPatients']]) {
    for (const flag of [undefined, null, 'true', 1, false]) {
      reset();
      permissionFlags[module] = flag;
      const res = await call(action, {}, true);
      assert.equal(res.code, 403);
      assertNoBusiness();
    }
  }
  reset();
  clinicFeatures.clinical_records = false;
  assert.equal((await call('unknownPrivateAction')).code, 403);
  assertNoBusiness();
});

test('failed authorization reads and invalid sessions never reach initialization or business access', async () => {
  for (const failedRead of [true, false]) {
    reset();
    authFailure = failedRead;
    sessionExists = failedRead;
    const res = await call('financeList');
    assert.equal(res.code, 401);
    assert.equal(res.body.error, 'No autenticado');
    assertNoBusiness();
  }
});

test('health, public consent actions and preflight do not acquire session authorization', async () => {
  for (const action of ['health', 'getSigningSession', 'verifySigningCode', 'submitSignature']) {
    reset();
    authFailure = true;
    const res = await call(action); // Signing token intentionally absent.
    assert.equal(res.code, action === 'health' ? 200 : 404, action);
    assert.equal(authReads, 0);
  }
  reset();
  const res = response();
  await records({ method: 'OPTIONS', headers: {}, query: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(authReads, 0);
  assertNoBusiness();
});

test('scheduled finance cron retains separate authentication and cannot be invoked without its secret', async () => {
  reset();
  const res = response();
  await records({ method: 'GET', headers: {}, query: { action: 'sendScheduledFinanceCsv' } }, res);
  assert.equal(res.code, 401);
  assert.equal(authReads, 0);
  assertNoBusiness();
});
