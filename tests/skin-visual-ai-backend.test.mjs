import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test, { mock } from 'node:test';

// NEVER load .env or instantiate a real DB/network client.
mock.module('@vercel/postgres', { namedExports: { sql: {
  query() { throw new Error('Unmocked auth DB'); }, connect() { throw new Error('Unmocked auth DB'); },
} } });
mock.module(new URL('../lib/admin-auth.js', import.meta.url).href, {
  namedExports: { authenticateRequest: async () => ({ valid: false }) },
});
mock.module(new URL('../lib/neon-clinical-db.js', import.meta.url).href, {
  namedExports: {
    getAppPool() { throw new Error('Unmocked clinical DB'); },
    getPool() { throw new Error('Owner pool forbidden'); },
  },
});
const net = mock.method(globalThis, 'fetch', () => { throw new Error('REAL HTTP FORBIDDEN'); });
const {
  createSkinVisualHandler, validateVisualInput, validateVisualOutput, readVisualBody,
  serviceConfig, verifiedTokenCost, RESPONSE_SCHEMA, MODEL, MAX_IMAGE_BYTES, MAX_BODY_BYTES, RESERVE_MICRO_USD,
} = await import('../lib/modules/ia/skin-visual-ai.js');
const CLINIC = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MONTH = '2026-11-01';
// Generated synthetic 1x1 PNG; not a patient photo or external fixture.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const env = () => ({
  SKIN_VISUAL_AI_ENABLED: 'true', GEMINI_API_KEY: 'fictitious-test-key',
  SKIN_VISUAL_AI_GLOBAL_MONTHLY_USD: '10',
});
const input = (overrides = {}) => ({
  recordId: 7, imageBase64: PNG, mimeType: 'image/png', consent: true, requestId: randomUUID(), ...overrides,
});
const request = (body = input(), extra = {}) => ({
  method: 'POST', headers: { authorization: 'Bearer fictitious-token', 'content-type': 'application/json' },
  body, ...extra,
});
const response = () => ({
  code: 0, body: null, headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});
function result(proposals = []) {
  return {
    proposals,
    summary: RESPONSE_SCHEMA.properties.summary.enum[proposals.length ? 0 : 1],
    limitations: [...RESPONSE_SCHEMA.properties.limitations.items.enum],
  };
}
function proposal(overrides = {}) {
  return {
    id: 'p1', category: 'acne',
    label: RESPONSE_SCHEMA.properties.proposals.items.properties.label.enum[0],
    note: RESPONSE_SCHEMA.properties.proposals.items.properties.note.enum[0],
    box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }, ...overrides,
  };
}
function providerEnvelope(value = result(), changes = {}) {
  return {
    modelVersion: MODEL,
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 },
    ...changes,
  };
}
const http = envelope => new Response(JSON.stringify(envelope), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

// Stateful SQL protocol double. The mutex mirrors the actual PostgreSQL advisory
// transaction lock, NOT a runtime memory quota. SQL predicates/rollback are asserted.
function fixture(options = {}) {
  const state = {
    clinic: true, override: true, active: true, session: true, scope: 'own', owned: true,
    assigned: false, recordClinic: CLINIC, targetClinic: CLINIC, utc: NOW, ledger: [],
    queries: [], fetches: [], authCalls: 0, commitFails: false, allowedUsers: [7],
    allowedTokens: ['fictitious-token'], recordChecks: 0, ...options.state,
  };
  let queue = Promise.resolve();
  const rows = r => ({ rows: r });
  async function query(text, params = [], client) {
    text = text.replace(/\s+/g, ' ').trim();
    state.queries.push({ text, params, clinical: !!client?.clinical });
    if (text === 'BEGIN') { client.inTx = true; return rows([]); }
    if (text === 'COMMIT' || text === 'ROLLBACK') {
      if (text === 'COMMIT' && state.commitFails) throw new Error('Commit unavailable');
      if (text === 'ROLLBACK' && client.snapshot) state.ledger = client.snapshot;
      client.snapshot = null;
      client.inTx = false;
      client.unlock?.();
      client.unlock = null;
      return rows([]);
    }
    if (text.startsWith('SET LOCAL')) return rows([]);
    if (text.includes('pg_advisory_xact_lock')) {
      assert.equal(client.inTx, true);
      assert.match(text, /pg_advisory_xact_lock\(738291, 2505\)/);
      const before = queue, next = deferred();
      queue = next.promise;
      await before;
      client.unlock = next.resolve;
      client.snapshot = structuredClone(state.ledger);
      return rows([]);
    }
    if (text.includes("set_config('app.current_tenant'")) {
      assert.equal(client.clinical, true);
      assert.equal(client.inTx, true);
      client.tenant = params[0];
      return rows([]);
    }
    if (text.includes('FROM clinical_records')) {
      assert.equal(client.clinical, true);
      assert.equal(client.tenant, CLINIC);
      assert.match(text, /cr\.clinic_id = \$2/);
      assert.match(text, /cr\.created_by_user_id = \$4 OR EXISTS.*patient_assignments/);
      assert.ok(state.allowedUsers.includes(params[3]));
      state.recordChecks++;
      await options.recordHook?.(state, params);
      return rows(state.recordClinic === params[1] && (!params[2] || state.owned || state.assigned) ? [{ id: 7 }] : []);
    }
    assert.equal(client?.clinical ?? false, false, 'clinical pool cannot query auth/usage');
    if (text.includes('FROM admin_sessions s')) {
      assert.match(text, /s\.expires_at > NOW\(\)/);
      assert.match(text, /cu\.is_active = true/);
      assert.match(text, /cf\.enabled = true/);
      assert.match(text, /umo\.enabled = true/);
      assert.match(text, /s\.clinic_user_id = cu\.id AND s\.clinic_id = c\.id/);
      assert.match(text, /FOR SHARE OF s, cu, c, cf, umo/);
      assert.ok(state.allowedTokens.includes(params[0]));
      return rows(state.clinic === true && state.override === true && state.active && state.session &&
        state.targetClinic === params[2] && state.allowedUsers.includes(params[1]) ?
        [{ id: params[1], access_scope: state.scope }] : []);
    }
    if (text.startsWith('UPDATE skin_visual_ai_usage SET status = \'uncertain\'')) {
      assert.ok(client.unlock);
      for (const r of state.ledger) if (r.status === 'reserved' && r.expires <= state.utc) r.status = 'uncertain';
      return rows([]);
    }
    if (text.startsWith('SELECT status FROM skin_visual_ai_usage')) {
      assert.ok(client.unlock);
      assert.match(text, /actor_key = \$1 OR effective_user_id = \$3/);
      return rows(state.ledger.filter(r => (r.actor === params[0] || r.user === params[2]) && r.id === params[1]));
    }
    if (text.startsWith('SELECT 1 FROM skin_visual_ai_usage')) {
      assert.ok(client.unlock);
      return rows(state.ledger.filter(r => r.status === 'reserved' && (r.user === params[0] || r.actor === params[1])));
    }
    if (text.includes('AS global_used')) {
      assert.match(text, /NOW\(\) AT TIME ZONE 'UTC'/);
      const month = params[2] ?? `${new Date(state.utc).toISOString().slice(0, 7)}-01`;
      const ledger = state.ledger.filter(r => r.month === month);
      const sum = predicate => String(ledger.filter(predicate).reduce((n, r) => n + r.cost, 0));
      return rows([{ global_used: sum(() => true), user_used: sum(r => r.user === params[0]),
        actor_used: sum(r => r.actor === params[1]) }]);
    }
    if (text.startsWith('INSERT INTO skin_visual_ai_usage')) {
      assert.ok(client.unlock, 'reserve must hold global lock');
      assert.match(text, /date_trunc\('month', NOW\(\) AT TIME ZONE 'UTC'\)/);
      assert.equal(params[4], RESERVE_MICRO_USD);
      assert.ok(!state.ledger.some(r => r.id === params[1] && (r.actor === params[0] || r.user === params[2])));
      const month = `${new Date(state.utc).toISOString().slice(0, 7)}-01`;
      state.ledger.push({ actor: params[0], id: params[1], user: params[2], clinic: params[3],
        month, cost: params[4], status: 'reserved', expires: state.utc + 45_000 });
      return rows([{ month_utc: month }]);
    }
    if (text.startsWith('UPDATE skin_visual_ai_usage SET status = $3')) {
      assert.ok(client.unlock);
      assert.match(text, /status = 'reserved' AND expires_at > NOW\(\)/);
      const r = state.ledger.find(r => r.actor === params[0] && r.id === params[1] &&
        r.status === 'reserved' && r.expires > state.utc);
      if (!r) return rows([]);
      Object.assign(r, { status: params[2], cost: params[3], input: params[4], output: params[5] });
      return rows([{ request_id: r.id }]);
    }
    throw new Error(`Unexpected SQL in mock: ${text}`);
  }
  const connection = clinical => ({
    clinical, query(text, params) { return query(text, params, this); },
    release() { assert.equal(this.inTx, false); assert.ok(!this.unlock); },
  });
  const db = { query, connect: async () => connection(false) };
  const app = { connect: async () => connection(true) };
  const auth = { valid: true, id: 7, username: 'test-user', role: 'clinic_user',
    clinic_id: CLINIC, effective_clinic_id: CLINIC, ...options.auth };
  const handler = createSkinVisualHandler({
    authenticate: async req => {
      state.authCalls++;
      await options.authHook?.(state, auth);
      return { ...(options.authForRequest?.(req) ?? auth), valid: auth.valid && state.session };
    },
    authDb: db, appPool: () => app, env: options.env ?? env(),
    providerTimeoutMs: options.timeout ?? 100,
    fetchImpl: async (url, init) => {
      assert.equal(state.ledger.at(-1)?.status, 'reserved', 'must commit reservation BEFORE HTTP');
      assert.ok(!state.queries.at(-1).text.includes('INSERT'), 'must recheck before dispatch');
      state.fetches.push({ url, init });
      return options.fetch ? options.fetch(state, url, init) : http(providerEnvelope());
    },
  });
  return {
    state, handler, auth,
    async run(body = input(), extra = {}, action = 'analyzeSkinVisual') {
      const res = response();
      await handler(request(body, extra), res, action);
      return res;
    },
  };
}
function seed(f, { user = 7, actor = 'user:7', cost, status = 'completed', month = MONTH, expires = NOW + 1000 } = {}) {
  f.state.ledger.push({ user, actor, cost, status, month, expires, id: randomUUID() });
}

test('temporary analysis requires explicit true with recordId absent, same fresh gates and no clinical ledger content', async () => {
  const temp = () => {
    const body = input({ temporary: true });
    delete body.recordId;
    return body;
  };
  assert.equal(validateVisualInput(temp()).recordId, null);
  for (const body of [input({ temporary: true }), { ...temp(), temporary: false },
    { ...temp(), temporary: 'true' }, { ...temp(), temporary: undefined }, { ...temp(), recordId: null }]) {
    assert.throws(() => validateVisualInput(body));
  }
  const f = fixture({ state: { owned: false } });
  const body = temp();
  assert.equal((await f.run(body)).code, 200);
  assert.equal(f.state.recordChecks, 0);
  assert.equal(f.state.authCalls, 2);
  assert.equal((await f.run(body)).code, 429);
  assert.equal(f.state.fetches.length, 1);
  const ledgerWrites = f.state.queries.filter(q => q.text.startsWith('INSERT INTO skin_visual_ai_usage'));
  assert.equal(ledgerWrites.length, 1);
  assert.doesNotMatch(ledgerWrites[0].text, /record_id|image|photo|prompt|result/i);
  for (const state of [{ override: false }, { clinic: false }, { session: false }]) {
    const denied = fixture({ state });
    assert.ok([401, 403].includes((await denied.run(temp())).code));
    assert.equal(denied.state.fetches.length, 0);
  }
  const revoked = fixture({ authHook(state) { if (state.authCalls === 2) state.override = false; } });
  assert.equal((await revoked.run(temp())).code, 403);
  assert.equal(revoked.state.fetches.length, 0);
  const limited = fixture();
  seed(limited, { cost: 4_900_000 });
  assert.equal((await limited.run(temp())).code, 429);
  assert.equal(limited.state.fetches.length, 0);
  const global = fixture({ env: { ...env(), SKIN_VISUAL_AI_GLOBAL_MONTHLY_USD: '0.1' } });
  assert.equal((await global.run(temp())).code, 429);
  assert.equal(global.state.fetches.length, 0);
});

test('default disabled / mandatory global limit / fixed GA successor without obsolete cutoff (no HTTP)', async () => {
  assert.equal(serviceConfig({}).reason, 'service_disabled');
  for (const raw of [undefined, '', '0', '-1', 'Infinity', 'NaN', '1e3', ' 5', '0.0000001'])
    assert.equal(serviceConfig({ ...env(), SKIN_VISUAL_AI_GLOBAL_MONTHLY_USD: raw }).reason, 'service_unavailable');
  assert.equal(MODEL, 'gemini-3.5-flash-lite');
  assert.ok(!serviceConfig(env()).reason);
  const f = fixture({ env: {} });
  const status = await f.run(null, { method: 'GET' }, 'skinVisualStatus');
  assert.deepEqual(status.body, { enabled: false, reason: 'service_disabled', usedUsd: 0,
    limitUsd: 5, remainingUsd: 5, model: MODEL });
  assert.equal((await f.run()).code, 503);
  assert.equal(f.state.fetches.length, 0);
});

test('fresh auth required; missing override and clinic permission DENY; no master bypass', async () => {
  const unauth = fixture({ auth: { valid: false } });
  assert.equal((await unauth.run()).code, 401);
  assert.equal(unauth.state.queries.length, 0);
  for (const state of [{ override: null }, { override: false }, { clinic: false }, { active: false }, { session: false }]) {
    for (const auth of [{}, { role: 'master_admin', id: null, username: 'master' }]) {
      const f = fixture({ state, auth });
      const r = await f.run(input(), auth.role ? {
        headers: { ...request().headers, 'x-target-user-id': '7' },
      } : {});
      assert.ok([401, 403].includes(r.code), JSON.stringify(r.body));
      assert.equal(f.state.fetches.length, 0);
      assert.equal(f.state.ledger.length, 0);
    }
  }
});

test('status contract, per-user true then revoked; stored usage retained on deny', async () => {
  const f = fixture();
  seed(f, { cost: 50_000 });
  const allowed = await f.run(null, { method: 'GET' }, 'skinVisualStatus');
  assert.deepEqual(allowed.body, { enabled: true, usedUsd: 0.05, limitUsd: 5, remainingUsd: 4.95, model: MODEL });
  f.state.override = false;
  const denied = await f.run(null, { method: 'GET' }, 'skinVisualStatus');
  assert.equal(denied.body.enabled, false);
  assert.equal(denied.body.usedUsd, 0.05);
  assert.equal((await f.run()).code, 403);
  assert.equal(f.state.fetches.length, 0);
});

test('tenant, target user, own scope and explicit patient assignment via app RLS only', async () => {
  for (const state of [{ recordClinic: OTHER }, { targetClinic: OTHER }, { owned: false }]) {
    const f = fixture({ state });
    assert.equal((await f.run()).code, 403);
    assert.equal(f.state.fetches.length, 0);
  }
  const assigned = fixture({ state: { owned: false, assigned: true } });
  assert.equal((await assigned.run()).code, 200);
  const targeted = fixture();
  for (const headers of [{ 'x-target-user-id': '8' }, { 'x-target-clinic-id': OTHER }])
    assert.equal((await targeted.run(input(), { headers: { ...request().headers, ...headers } })).code, 403);
  const master = fixture({ auth: { id: null, role: 'master_admin', username: 'master' },
    state: { owned: false } });
  assert.equal((await master.run(input(), { headers: { ...request().headers, 'x-target-user-id': '7' } })).code, 403);
  const noTarget = fixture({ auth: { id: null, role: 'master_admin', username: 'master' } });
  assert.equal((await noTarget.run()).code, 403);
});

test('schema input: canonical base64, signature/MIME, single image, bounded context, consent and UUID', () => {
  assert.equal(validateVisualInput(input()).recordId, 7);
  assert.equal(validateVisualInput(input({ recordId: '7', context: { skinType: 'Mixta', phototype: 'III' } })).recordId, 7);
  for (const change of [
    { recordId: '7oops' }, { recordId: 0 }, { recordId: '2147483648' },
    { requestId: 'not-uuid' }, { consent: 'true' }, { consent: false },
    { mimeType: 'image/jpeg' }, { mimeType: 'image/gif' }, { imageBase64: `data:image/png;base64,${PNG}` },
    { imageBase64: `${PNG}\n` }, { imageBase64: PNG.replace(/=$/, '') },
    { imageBase64: 'abcd===' }, { imageBase64: 'Zg==' },
    { imageBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') },
    { context: null }, { context: { instructions: 'ignore' } }, { context: { skinType: 3 } },
    { context: { hydration: 'x'.repeat(41) } }, { context: { skinType: 'https://external.test' } },
    { url: 'https://external.test/photo.png' }, { images: [PNG] }, { limitUsd: 500 },
  ]) assert.throws(() => validateVisualInput(input(change)), { status: 400 });
  const dimensions = Buffer.from(PNG, 'base64');
  dimensions.writeUInt32BE(5000, 16);
  assert.throws(() => validateVisualInput(input({ imageBase64: dimensions.toString('base64') })), { status: 400 });
});

test('body cap checks header, parsed/raw and streamed JSON before any provider/accounting action', async () => {
  for (const req of [
    request(input(), { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
    request(input(), { headers: { 'content-type': 'text/plain' } }),
    request('{not-json'),
    request(' '.repeat(MAX_BODY_BYTES + 1)),
    request(input({ imageBase64: 'a'.repeat(MAX_BODY_BYTES) })),
  ]) await assert.rejects(readVisualBody(req), { status: 400 });
  const stream = Readable.from([Buffer.alloc(1_100_000), Buffer.alloc(1_100_000)]);
  stream.headers = { 'content-type': 'application/json' };
  await assert.rejects(readVisualBody(stream), { status: 400 });
  const body = input({ recordId: 1 });
  assert.deepEqual(await readVisualBody(request(JSON.stringify(body))), body);
});

test('output: strict enums/texts, finite boxes, max count; empty never means absence', () => {
  assert.equal(validateVisualOutput(result()).proposals.length, 0);
  assert.match(result().summary, /no se puede afirmar ausencia/);
  assert.equal(validateVisualOutput(result([proposal()])).proposals.length, 1);
  for (const p of [
    proposal({ category: 'pores' }), proposal({ category: 'skin-type' }),
    proposal({ label: 'Diagnóstico maligno' }), proposal({ note: 'Recomiendo tratamiento' }),
    proposal({ box: { x: NaN, y: 0, width: 0.1, height: 0.2 } }),
    proposal({ box: { x: 0.9, y: 0, width: 0.2, height: 0.2 } }),
    proposal({ box: { x: 0, y: 0, width: 0, height: 0.2 } }),
    proposal({ extra: true }),
  ]) assert.throws(() => validateVisualOutput(result([p])), { status: 502 });
  assert.throws(() => validateVisualOutput(result([proposal(), proposal()])), { status: 502 });
  assert.throws(() => validateVisualOutput(result(Array.from({ length: 13 }, (_, i) =>
    proposal({ id: `p${i + 1}` })))), { status: 502 });
  assert.throws(() => validateVisualOutput({ ...result(), summary: 'No hay lesiones' }), { status: 502 });
});

test('success contract; bounded fixed-model single POST, no identifiers sent, verified token settlement', async () => {
  const f = fixture({ fetch: () => http(providerEnvelope(result([proposal()]))) });
  const body = input({ context: { hydration: 'Normal' } });
  const r = await f.run(body);
  assert.equal(r.code, 200);
  assert.equal(r.body.analysisId, body.requestId);
  assert.equal(r.body.model, MODEL);
  assert.deepEqual(r.body.usage, { usedUsd: 0.00055, limitUsd: 5, remainingUsd: 4.99945 });
  assert.equal(r.body.proposals.length, 1);
  assert.equal(r.headers['Cache-Control'], 'private, no-store');
  assert.equal(f.state.authCalls, 2);
  assert.equal(f.state.fetches.length, 1);
  assert.equal(f.state.ledger[0].cost, 550);
  assert.equal(f.state.ledger[0].status, 'completed');
  const { url, init } = f.state.fetches[0];
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
  assert.equal(init.redirect, 'error');
  assert.ok(!url.includes('key='));
  const payload = JSON.parse(init.body);
  assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL', includeThoughts: false });
  assert.ok(!Object.hasOwn(payload.generationConfig, 'candidateCount'));
  assert.ok(!Object.hasOwn(payload.generationConfig.thinkingConfig, 'thinkingBudget'));
  assert.equal(payload.generationConfig.maxOutputTokens, 4096);
  assert.deepEqual(payload.generationConfig.responseJsonSchema, RESPONSE_SCHEMA);
  for (const key of ['tools', 'cachedContent', 'recordId', 'clinicId', 'userId']) assert.ok(!(key in payload));
  assert.ok(!JSON.stringify(f.state.ledger).includes(PNG));
  assert.ok(!JSON.stringify(f.state.ledger).includes(r.body.summary));
  assert.ok(!JSON.stringify(f.state.ledger).includes('test-user'));
  assert.equal(net.mock.callCount(), 0, 'no real/global fetch ever');
});

test('clinic/user/session revocation after reservation prevents HTTP (no countTokens escape)', async () => {
  for (const revoked of ['clinic', 'override', 'active', 'session']) {
    const f = fixture({ authHook: state => { if (state.authCalls === 2) state[revoked] = false; } });
    assert.equal((await f.run()).code, 403);
    assert.equal(f.state.fetches.length, 0);
    assert.equal(f.state.ledger[0].cost, RESERVE_MICRO_USD);
    assert.equal(f.state.ledger[0].status, 'uncertain');
  }
});

test('HIGH regression: pause second clinical check, revoke permission, release => 403 and ZERO provider', async () => {
  for (const revoked of ['override', 'clinic', 'active', 'session']) {
    const entered = deferred(), release = deferred();
    const f = fixture({ recordHook: async state => {
      if (state.recordChecks === 2) { entered.resolve(); await release.promise; }
    } });
    const pending = f.run();
    await entered.promise;
    assert.equal(f.state.ledger.length, 1, 'reservation already committed');
    f.state[revoked] = false;
    release.resolve();
    const r = await pending;
    assert.equal(r.code, 403, revoked);
    assert.equal(f.state.recordChecks, 2);
    assert.equal(f.state.fetches.length, 0);
    assert.equal(f.state.ledger[0].cost, RESERVE_MICRO_USD, 'no uncertain refund');
  }
});

test('scope change during last clinical await denies rather than reusing a broader authorization', async () => {
  for (const initialScope of ['all', 'own']) {
    const entered = deferred(), release = deferred();
    const f = fixture({
      state: { scope: initialScope },
      recordHook: async state => {
        if (state.recordChecks === 2) { entered.resolve(); await release.promise; }
      },
    });
    const pending = f.run();
    await entered.promise;
    f.state.scope = initialScope === 'all' ? 'own' : 'all';
    release.resolve();
    const r = await pending;
    assert.equal(r.code, 403);
    assert.equal(r.body.error, 'permission_changed');
    assert.equal(f.state.fetches.length, 0);
  }
});

test('once dispatch starts, revocation cannot promise cancellation or avoid provider billing', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ fetch: async () => {
    entered.resolve();
    await release.promise;
    return http(providerEnvelope());
  } });
  const pending = f.run();
  await entered.promise;
  f.state.override = false;
  release.resolve();
  assert.equal((await pending).code, 200);
  assert.equal(f.state.fetches.length, 1);
  assert.equal(f.state.ledger[0].cost, 550);
  assert.equal((await f.run()).code, 403, 'subsequent dispatch must be denied');
  assert.equal(f.state.fetches.length, 1);
});

test('GA thinking tokens are included in settlement; unverified or over-cap totals retain reservation', async () => {
  const envelope = providerEnvelope(result(), {
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 200, totalTokenCount: 1300 },
  });
  assert.deepEqual(verifiedTokenCost(envelope), { cost: 1050, input: 1000, output: 300 });
  const f = fixture({ fetch: async () => http(envelope) });
  assert.equal((await f.run()).body.usage.usedUsd, 0.00105);
  assert.equal(f.state.ledger[0].output, 300);
  assert.equal(f.state.ledger[0].cost, 1050);
  assert.deepEqual(verifiedTokenCost(providerEnvelope(result(), {
    usageMetadata: { promptTokenCount: 1_048_576, candidatesTokenCount: 2048,
      thoughtsTokenCount: 2048, totalTokenCount: 1_052_672 },
  })), { cost: 324_813, input: 1_048_576, output: 4096 });
  for (const usageMetadata of [
    { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 200, totalTokenCount: 1100 },
    { promptTokenCount: 1000, candidatesTokenCount: 4096, thoughtsTokenCount: 1, totalTokenCount: 5097 },
    { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: -1, totalTokenCount: 1099 },
  ]) assert.throws(() => verifiedTokenCost({ usageMetadata }), { status: 502 });
});

test('concurrent requests: exactly one in-flight and duplicates never pay twice or return empty success', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ fetch: async () => { entered.resolve(); await release.promise; return http(providerEnvelope()); } });
  const body = input();
  const first = f.run(body);
  await entered.promise;
  const duplicates = await Promise.all([f.run(body), ...Array.from({ length: 8 }, () => f.run())]);
  assert.ok(duplicates.every(r => r.code === 429));
  assert.equal(f.state.ledger.length, 1);
  release.resolve();
  assert.equal((await first).code, 200);
  const replay = await f.run(body);
  assert.equal(replay.code, 429);
  assert.equal(replay.body.error, 'request_already_submitted');
  assert.equal(f.state.fetches.length, 1);
});

test('atomic global and user limits include pending/uncertain reservations, per real user not body', async () => {
  const user = fixture();
  seed(user, { cost: 4_800_000 });
  assert.equal((await user.run()).code, 429);
  assert.equal(user.state.fetches.length, 0);
  const actor = fixture({ auth: { id: null, username: 'master', role: 'master_admin' } });
  seed(actor, { cost: 4_800_000 });
  assert.equal((await actor.run(input(), { headers: { ...request().headers, 'x-target-user-id': '7' } })).code, 429);
  const f = fixture({ env: { ...env(), SKIN_VISUAL_AI_GLOBAL_MONTHLY_USD: '0.4' } });
  seed(f, { user: 8, actor: 'user:8', cost: 100_000, status: 'uncertain' });
  assert.equal((await f.run()).code, 429);
  assert.equal(f.state.fetches.length, 0);
  const forged = fixture();
  assert.equal((await forged.run(input({ userId: 8 }))).code, 400);
});

test('different real users racing for the final global reservation cannot overspend', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({
    env: { ...env(), SKIN_VISUAL_AI_GLOBAL_MONTHLY_USD: '0.5' },
    state: { allowedUsers: [7, 8], allowedTokens: ['fictitious-token', 'token-eight'] },
    authForRequest: req => ({
      valid: true, id: req.headers.authorization === 'Bearer token-eight' ? 8 : 7,
      role: 'clinic_user', clinic_id: CLINIC, effective_clinic_id: CLINIC,
    }),
    fetch: async () => { entered.resolve(); await release.promise; return http(providerEnvelope()); },
  });
  const first = f.run();
  await entered.promise;
  const other = await f.run(input(), { headers: { ...request().headers, authorization: 'Bearer token-eight' } });
  assert.equal(other.code, 429);
  assert.equal(other.body.error, 'budget_exhausted');
  assert.equal(f.state.ledger.length, 1);
  assert.equal(f.state.ledger[0].cost, RESERVE_MICRO_USD);
  release.resolve();
  assert.equal((await first).code, 200);
  assert.equal(f.state.fetches.length, 1);
});

test('master actor budget cannot reset through target changes; effective user idempotency survives actor changes', async () => {
  const f = fixture({ auth: { id: null, username: 'master', role: 'master_admin' } });
  const body = input();
  const headers = { ...request().headers, 'x-target-user-id': '7' };
  assert.equal((await f.run(body, { headers })).code, 200);
  assert.match(f.state.ledger[0].actor, /^master:[0-9a-f]{64}$/);
  // A prior charge incurred on a different effective target still counts for this actor.
  f.state.ledger[0].user = 8;
  f.state.ledger[0].cost = 4_800_000;
  assert.equal((await f.run(input(), { headers })).code, 429);
  // Same effective user + UUID must not be re-billed by a different actor either.
  f.state.ledger[0].user = 7;
  f.state.ledger[0].cost = 550;
  f.state.ledger[0].actor = 'user:7';
  const replay = await f.run(body, { headers });
  assert.equal(replay.body.error, 'request_already_submitted');
  assert.equal(f.state.fetches.length, 1);
});

test('timeouts/network/HTTP/invalid JSON/schema/usage/model keep FULL reservation, no automatic retries', async () => {
  const cases = [
    async () => { throw new Error('provider secret or patient name must not leak'); },
    async () => new Response('provider secret', { status: 429 }),
    async () => new Response('not json'),
    async () => new Response('x'.repeat(70_000)),
    async () => http(providerEnvelope({ ...result(), summary: 'No se observan hallazgos' })),
    async () => http(providerEnvelope(result(), { usageMetadata: undefined })),
    async () => http(providerEnvelope(result(), {
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100, thoughtsTokenCount: 100 },
    })),
    async () => http(providerEnvelope(result(), { modelVersion: 'gemini-2.5-flash' })),
    async () => http(providerEnvelope(result(), { modelVersion: 'gemini-3.5-flash-lite-preview' })),
    async () => http(providerEnvelope(result(), { candidates: [{ finishReason: 'MAX_TOKENS' }] })),
    async () => new Promise(() => {}), // transport ignores abort; race still terminates
  ];
  for (const fetch of cases) {
    const f = fixture({ fetch, timeout: 10 });
    const body = input(), r = await f.run(body);
    assert.equal(r.code, 502, JSON.stringify(r.body));
    assert.equal(f.state.ledger[0].cost, RESERVE_MICRO_USD);
    assert.equal(f.state.ledger[0].status, 'uncertain');
    assert.equal(f.state.fetches.length, 1);
    assert.equal((await f.run(body)).code, 429);
    assert.ok(!JSON.stringify(r.body).includes('secret'));
  }
});

test('expired flights retain charge across UTC months; same requestId never repeats', async () => {
  const f = fixture();
  const old = randomUUID();
  f.state.ledger.push({ id: old, user: 7, actor: 'user:7', month: MONTH,
    cost: RESERVE_MICRO_USD, status: 'reserved', expires: NOW - 1 });
  assert.equal((await f.run()).code, 200);
  assert.equal(f.state.ledger[0].status, 'uncertain');
  assert.equal(f.state.ledger[0].cost, RESERVE_MICRO_USD);
  assert.equal((await f.run(input({ requestId: old }))).code, 429);
  // November's charge is never refunded or moved. GA successor has no artificial December cutoff.
  f.state.utc = Date.parse('2026-12-01T00:01:00Z');
  const status = await f.run(null, { method: 'GET' }, 'skinVisualStatus');
  assert.equal(status.body.usedUsd, 0);
  assert.equal(status.body.enabled, true);
  assert.equal((await f.run(input({ requestId: old }))).code, 429);
  assert.equal((await f.run()).code, 200);
  assert.equal(f.state.ledger[0].cost, RESERVE_MICRO_USD);
});

test('DB unavailable fails closed without leaking or HTTP; safe dedicated API routing and migration', async () => {
  const f = fixture({ state: { commitFails: true } });
  const r = await f.run();
  assert.equal(r.code, 503);
  assert.deepEqual(r.body, { error: 'service_unavailable' });
  assert.equal(f.state.ledger.length, 0, 'transaction rollback before dispatch');
  assert.equal(f.state.fetches.length, 0);
  const source = readFileSync(new URL('../api/ai-consultation.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('return handleSkinVisual(') < source.indexOf('const pool = getPool()'));
  const migration = readFileSync(new URL('../scripts/skin-visual-ai-schema.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS/);
  assert.match(migration, /UNIQUE \(effective_user_id, request_id\)/);
  assert.match(migration, /ON CONFLICT \(clinic_id, feature\) DO NOTHING/);
  assert.match(migration, /REVOKE ALL ON skin_visual_ai_usage FROM bioskin_app/);
});
