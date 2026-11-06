import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const PHOTO = { id: 10, r2Key: `clinics/${CLINIC}/records/7/photos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpeg` };
const url = path => new URL(path, import.meta.url).href;
let failure, allowed, clinicalEnabled, puts, queries, receipt, stored, releases, tenant;
function reset() {
  failure = null; allowed = clinicalEnabled = true;
  puts = releases = 0; queries = []; receipt = stored = null; tenant = '';
}
reset();
const privateFailure = code => Object.assign(new Error('synthetic-private-detail'), {
  code, detail: 'synthetic-private-detail', query: 'synthetic-private-detail',
});
async function query(sql, params = []) {
  const text = sql.replace(/\s+/g, ' ').trim();
  queries.push(text);
  if (text.startsWith('SELECT set_config')) { tenant = params[0] ?? ''; return { rows: [] }; }
  if (/^(SET |BEGIN$|COMMIT$|ROLLBACK$)/.test(text) || text.includes('pg_advisory_xact_lock'))
    return { rows: [] };
  assert.equal(tenant, CLINIC, 'business SQL must use the tenant-scoped app client');
  if (text.startsWith('SELECT cr.id FROM clinical_records')) {
    assert.match(text, /cr\.clinic_id = \$2/);
    assert.match(text, /cr\.created_by_user_id = \$4 OR EXISTS.*patient_assignments/);
    return { rows: allowed && params[1] === CLINIC ? [{ id: 7 }] : [] };
  }
  if (text.startsWith('SELECT record_id, operation')) {
    if (failure && failure !== 'storage') throw privateFailure(failure);
    return { rows: receipt ? [receipt] : [] };
  }
  if (text.startsWith('SELECT cp.id, cp.r2_key')) {
    assert.deepEqual(params, [7, CLINIC, JSON.stringify([PHOTO])]);
    return { rows: [{ id: PHOTO.id, r2_key: PHOTO.r2Key }] };
  }
  if (text.startsWith('INSERT INTO facial_simulations')) {
    assert.equal(params[8], 'physical-exam');
    return { rows: [{ id: 90, record_id: 7, state_version: 1, scope: 'physical-exam' }] };
  }
  if (text.startsWith('INSERT INTO clinical_simulation_requests')) {
    receipt = { record_id: params[2], operation: params[3], fingerprint: params[4], result: JSON.parse(params[5]) };
    return { rows: [] };
  }
  assert.fail(`Unexpected synthetic SQL: ${text}`);
}
mock.module('@vercel/postgres', { namedExports: { sql: async () => assert.fail('No auth DB') } });
mock.module(url('../lib/admin-auth.js'), { namedExports: {
  authenticateRequest: async () => ({
    valid: true, role: 'clinic_user', clinic_id: CLINIC, id: 7, access_scope: 'all',
    clinical_records_enabled: clinicalEnabled, facial_simulation_enabled: false, skin_visual_ai_enabled: false,
  }),
} });
mock.module(url('../lib/neon-clinical-db.js'), { namedExports: {
  initClinicalDatabase: async () => {}, // Never execute DDL.
  getAppPool: () => ({ connect: async () => ({ query, release() { releases++; } }) }),
  getPool: () => ({ query: async () => assert.fail('No owner clinical queries') }),
} });
mock.module(url('../lib/clinic-lifecycle.js'), { namedExports: {
  lockClinicWriters: async () => {}, unlockClinicWriters: async () => {}, requireClinicWritable: async () => {},
} });
mock.module(url('../lib/r2-service.js'), { namedExports: {
  putR2Object: async (key, buffer, type) => {
    puts++;
    assert.match(key, new RegExp(`^clinics/${CLINIC}/records/7/facial-simulations/`));
    assert.equal(type, 'application/json');
    if (failure === 'storage') throw privateFailure('AccessDenied');
    stored = JSON.parse(buffer.toString());
  },
  getR2ObjectBuffer: async () => assert.fail('No read expected'),
  generateUploadUrl: async () => assert.fail('No uploads'),
  generateReadUrl: async () => assert.fail('No signed URLs'),
  deleteR2Object: async () => assert.fail('No deletes'),
} });
const network = mock.method(globalThis, 'fetch', async () => assert.fail('No network or AI'));
mock.method(console, 'log', () => {});
const logs = mock.method(console, 'error', () => {});
const { default: records } = await import('../api/records.js');
function body() {
  const glb = Buffer.alloc(12);
  glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(12, 8);
  return {
    action: 'saveFacialSimulation', record_id: 7, scope: 'physical-exam', requestId: randomUUID(),
    state: {
      version: 1, atlas: { modelId: 'face-v1', version: 1 },
      photos: [{ slot: 'front', photo: PHOTO, alignment: { confirmed: true } }], marks: [],
      mask: {
        view: 'front', glbBase64: glb.toString('base64'), depth: 0.2, depthDetails: 'Manual',
        diagnostics: [], closedHead: false,
        surface: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: [0, 0, 1, 0, 0, 1],
          indices: [0, 1, 2], projection: { cx: 0.5, cy: 0.5, k: 1, aspect: 1 } },
      },
    },
  };
}
async function call(payload = body()) {
  const res = {
    code: null, body: null, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; },
  };
  await records({ method: 'POST', headers: {}, query: {}, body: payload }, res);
  assert.equal(tenant, '', 'tenant is reset even after errors');
  return res;
}

test('real dispatcher saves a manual mask without facial_simulation/AI and retries without a second upload', async () => {
  reset();
  const payload = body(), saved = await call(payload);
  assert.equal(saved.code, 200);
  assert.equal(saved.body.id, 90);
  assert.equal(saved.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(stored, payload.state);
  assert.deepEqual((await call(payload)).body, saved.body);
  assert.equal(puts, 1);
  assert.equal(releases, 2);
  assert.equal(network.mock.callCount(), 0);
  assert.ok(!queries.some(q => /skin_visual_ai|usage|CREATE |ALTER |GRANT |REVOKE /.test(q)));
});

test('missing optional schema/column and app-role grants return safe actionable errors with no upload', async () => {
  for (const [pgCode, code, message] of [
    ['42P01', 'SIMULATION_SCHEMA_UNAVAILABLE', /administrador.*migración/i],
    ['42703', 'SIMULATION_SCHEMA_UNAVAILABLE', /administrador.*migración/i],
    ['42501', 'SIMULATION_DATABASE_PERMISSIONS', /administrador.*permisos/i],
  ]) {
    reset(); logs.mock.resetCalls(); failure = pgCode;
    const res = await call();
    assert.equal(res.code, 503);
    assert.equal(res.body.code, code);
    assert.match(res.body.error, message);
    assert.equal(puts, 0);
    assert.ok(queries.includes('ROLLBACK'));
    assert.equal(releases, 1);
    assert.ok(logs.mock.calls.some(c => JSON.stringify(c.arguments).includes(pgCode)));
    assert.doesNotMatch(JSON.stringify([res.body, logs.mock.calls.map(c => c.arguments)]), /synthetic-private-detail/);
  }
});

test('storage failure rolls back and tells the user to verify private storage; same request can retry', async () => {
  reset(); logs.mock.resetCalls(); failure = 'storage';
  const payload = body(), res = await call(payload);
  assert.equal(res.code, 503);
  assert.match(res.body.error, /almacenamiento privado.*administrador/i);
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(receipt, null);
  assert.doesNotMatch(JSON.stringify([res.body, logs.mock.calls.map(c => c.arguments)]), /synthetic-private-detail/);
  failure = null;
  assert.equal((await call(payload)).code, 200);
  assert.equal(puts, 2);
});

test('unknown failures stay generic; permission and validation denials do not become infrastructure errors', async () => {
  reset(); logs.mock.resetCalls(); failure = 'synthetic-private-detail';
  assert.equal((await call()).code, 500);
  assert.doesNotMatch(JSON.stringify(logs.mock.calls.map(c => c.arguments)), /synthetic-private-detail/);
  reset(); allowed = false;
  assert.equal((await call()).code, 403);
  assert.equal(puts, 0);
  reset(); clinicalEnabled = false;
  assert.equal((await call()).code, 403);
  assert.equal(queries.length, 0);
  reset();
  const invalid = body(); invalid.state.photos[0].photo = { ...PHOTO, r2Key: 'clinics/another-tenant/photo.jpeg' };
  assert.equal((await call(invalid)).code, 403);
  assert.equal(puts, 0);
});
