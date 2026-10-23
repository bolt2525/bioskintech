import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { reserveClinicLifecycle } from '../lib/clinic-lifecycle.js';

// In-memory protocol double only: no .env, network, Neon or R2.
const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PHONE = '593999000111';
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
let state, calls, hook, failure, shares, mails, mutexes;
function reset() {
  state = { active: true, purging: false, userActive: true, used: false,
    password: 'original', code: true, clinics: [], users: [], features: [], settings: [],
    evidence: [], contacts: [] };
  calls = []; hook = async () => {}; failure = null; shares = 0; mails = 0; mutexes = new Map();
}
reset();
async function execute(statement, params = [], client) {
  const text = statement.replace(/\s+/g, ' ').trim();
  calls.push({ text, params, client });
  await hook(text, client);
  const rows = values => ({ rows: values });
  if (text === 'BEGIN') { client.inTransaction = true; return rows([]); }
  if (text === 'COMMIT' || text === 'ROLLBACK') {
    if (text === 'COMMIT' && failure === 'COMMIT') throw new Error('fictitious commit failure');
    if (text === 'ROLLBACK' && client.before) state = client.before;
    client.before = null; client.inTransaction = false;
    shares -= client.shares || 0; client.shares = 0;
    for (const unlock of client.unlocks.splice(0)) unlock();
    return rows([]);
  }
  if (text.includes('pg_advisory_xact_lock_shared')) {
    client.shares = (client.shares || 0) + 1; shares++;
  }
  if (text.includes('pg_advisory_xact_lock(68422') || text.includes('FOR UPDATE OF t, cu')) {
    const key = text.includes('68422') ? 'registration' : 'token';
    const previous = mutexes.get(key) || Promise.resolve();
    const next = deferred(); mutexes.set(key, next.promise);
    await previous; client.unlocks.push(next.resolve);
  }
  if (failure && text.includes(failure) && failure !== 'COMMIT')
    throw Object.assign(new Error('fictitious concurrent conflict'), {
      code: failure.includes('INSERT INTO') ? '23505' : 'XX000',
      constraint: failure.includes('INSERT INTO clinic_users') ? 'clinic_users_username_key'
        : failure.includes('INSERT INTO clinics') ? 'clinics_email_lower_unique' : 'fictitious',
    });
  if (/^(INSERT|UPDATE|DELETE) /.test(text) && client?.inTransaction && !client.before)
    client.before = structuredClone(state);
  if (text.includes('FROM admin_sessions s'))
    return rows([{ username: 'master-test', role: 'master_admin', clinic_id: null,
      clinic_user_id: 1, expires_at: '2099-01-01' }]);
  if (text.includes("SELECT c.is_active,cs.general ? '_purge'"))
    return rows([{ is_active: state.active, purging: state.purging }]);
  if (text.startsWith('SELECT cu.clinic_id FROM password_setup_tokens'))
    return rows([{ clinic_id: ID }]);
  if (text.includes('FOR UPDATE OF t, cu')) {
    assert.ok(client.inTransaction);
    assert.ok(shares > 0);
    assert.match(text, /t.used=false/);
    assert.match(text, /t.expires_at>NOW\(\)/);
    assert.match(text, /cu.is_active=true/);
    return rows(state.used || !state.userActive ? [] : [{ id: 5, user_id: 7, username: 'qa', email: 'qa@example.test' }]);
  }
  if (text.startsWith('UPDATE clinic_users SET password_hash=')) { state.password = params[0]; return rows([]); }
  if (text.startsWith('UPDATE password_setup_tokens SET used=true')) { state.used = true; return rows([]); }
  if (text.startsWith('SELECT clinic_id FROM clinic_users')) return rows([{ clinic_id: ID }]);
  if (text.startsWith('SELECT id FROM clinic_users') && text.includes('FOR UPDATE'))
    return rows(state.userActive ? [{ id: 7 }] : []);
  if (text.startsWith('SELECT id, phone, whatsapp_staff_phone FROM clinic_users')) {
    assert.doesNotMatch(text, /is_active|whatsapp_bot_enabled/);
    return rows(state.evidence);
  }
  if (text.startsWith('SELECT clinic_id FROM whatsapp_contacts')) return rows(state.contacts);
  if (text.startsWith('SELECT phone, whatsapp')) return rows([{ phone: PHONE, whatsapp_bot_enabled: true, whatsapp_staff_phone: '' }]);
  if (text.startsWith('SELECT whatsapp_bot_enabled')) return rows([{ whatsapp_bot_enabled: true, whatsapp_staff_phone: '' }]);
  if (text.startsWith('SELECT id FROM clinic_users WHERE email')) return rows(state.users.filter(u => u.email === params[0]));
  if (text.startsWith('SELECT id FROM clinic_users WHERE username')) return rows(state.users.filter(u => u.username === params[0]));
  if (text.startsWith('SELECT id FROM clinics')) return rows([]);
  if (text.startsWith('UPDATE registration_codes SET is_active')) {
    if (!state.code) return rows([]);
    state.code = false;
    return rows([{ id: 9, plan_name: 'QA', features: ['calendar'], access_scope: 'all' }]);
  }
  if (text.startsWith('INSERT INTO clinics')) { state.clinics.push(ID); return rows([{ id: ID }]); }
  if (text.startsWith('INSERT INTO clinic_users')) {
    state.users.push({ id: 7, username: params[1], email: params[6] });
    return rows([{ id: 7 }]);
  }
  if (text.startsWith('INSERT INTO clinic_features')) state.features.push(params[1]);
  if (text.startsWith('INSERT INTO clinic_settings')) state.settings.push(params[0]);
  return rows([]);
}
const connection = () => ({
  unlocks: [], shares: 0,
  query(text, params) { return execute(text, params, this); },
  release() { assert.equal(this.inTransaction, false); assert.equal(this.unlocks.length, 0); },
});
const sql = (parts, ...params) => execute(parts.reduce((s, part, i) => s + part + (i < params.length ? `$${i + 1}` : ''), ''), params);
sql.query = (text, params) => execute(text, params);
sql.connect = async () => connection();
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module(new URL('../lib/neon-clinical-db.js', import.meta.url).href, {
  namedExports: { getPool: () => ({ connect: async () => connection() }) },
});
mock.module('nodemailer', { defaultExport: { createTransport: () => ({
  sendMail: async () => { assert.ok(calls.some(c => c.text === 'COMMIT')); mails++; },
}) } });
process.env.EMAIL_USER = 'bolt2525@gmail.com';
process.env.EMAIL_PASS = 'fictitious-test-password';
const { default: handler, LEGAL_VERSION } = await import('../api/admin-auth.js');
async function request(action, body = {}, authenticated = false) {
  const res = { code: null, body: null, setHeader() {},
    status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'POST', query: { action }, headers: authenticated ? { authorization: 'Bearer fictitious' } : {}, body }, res);
  return res;
}
const claim = () => request('claimSetupToken', { token: 'a'.repeat(64), newPassword: 'Password123' });
const registration = extra => request('register', {
  code: 'QA', email: 'qa@example.test', password: 'Password123', username: 'qa_user',
  first_name: 'QA', last_name: 'Ficticio', clinic_name: 'Clinica QA',
  accepted_terms: true, accepted_legal_version: LEGAL_VERSION, ...extra,
});
test.beforeEach(t => { reset(); t.mock.method(console, 'error', () => {}); });

test('setup rejects inactive accounts, inactive clinics and active or inactive tombstones without credential writes', async () => {
  for (const flags of [{ userActive: false }, { active: false },
    { active: true, purging: true }, { active: false, purging: true }]) {
    reset(); Object.assign(state, flags);
    const res = await claim();
    assert.ok([400, 409].includes(res.code));
    assert.equal(state.password, 'original'); assert.equal(state.used, false);
    assert.equal(calls.at(-1).text, 'ROLLBACK'); assert.equal(shares, 0);
  }
});
test('deactivation/purge winning between setup lookup and lock is revalidated transactionally', async () => {
  for (const flag of ['active', 'purging']) {
    reset();
    hook = async text => {
      if (text.includes('pg_advisory_xact_lock_shared')) state[flag] = flag === 'purging';
    };
    assert.equal((await claim()).code, 409);
    assert.equal(state.password, 'original');
    assert.equal(calls.some(c => c.text.startsWith('UPDATE clinic_users')), false);
  }
});
test('setup holds lifecycle reservation through credential write and concurrent token claims have one winner', async () => {
  const entered = deferred(), resume = deferred();
  hook = async text => {
    if (text.startsWith('UPDATE clinic_users SET password_hash=')) { entered.resolve(); await resume.promise; }
  };
  const first = claim();
  await entered.promise;
  await assert.rejects(reserveClinicLifecycle({
    query: async () => ({ rows: [{ acquired: shares === 0 }] }),
  }, ID), { status: 409 });
  const second = claim();
  resume.resolve();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(r => r.code).sort(), [200, 400]);
  assert.equal(state.used, true); assert.notEqual(state.password, 'original'); assert.equal(shares, 0);
  assert.equal(calls.filter(c => c.text.startsWith('UPDATE clinic_users SET password_hash=')).length, 1);
});
test('setup credential and token consumption rollback together on error', async () => {
  failure = 'UPDATE password_setup_tokens';
  assert.equal((await claim()).code, 500);
  assert.equal(state.password, 'original'); assert.equal(state.used, false);
});
test('setup generation is blocked after deactivation or tombstone and checks target account activity', async () => {
  for (const flags of [{ active: false }, { purging: true }, { userActive: false }]) {
    reset(); Object.assign(state, flags);
    const res = await request('generateSetupToken', { user_id: 7, email: 'qa@example.test' }, true);
    assert.equal(res.code, 409);
    assert.equal(calls.some(c => c.text.startsWith('INSERT INTO password_setup_tokens')), false);
  }
});
test('active account setup generation locks and commits before sending the link', async () => {
  const res = await request('generateSetupToken', { user_id: 7, email: 'qa@example.test' }, true);
  assert.equal(res.code, 200);
  const lock = calls.findIndex(c => c.text.includes('pg_advisory_xact_lock_shared'));
  const insert = calls.findIndex(c => c.text.startsWith('INSERT INTO password_setup_tokens'));
  const commit = calls.findIndex(c => c.text === 'COMMIT');
  assert.ok(lock >= 0 && insert > lock && commit > insert);
  assert.equal(mails, 1);
});
test('registration rolls back clinic, user, features, settings and code for every failed stage; retry succeeds', async () => {
  for (const stage of ['INSERT INTO clinics', 'INSERT INTO clinic_users', 'INSERT INTO clinic_features',
    'INSERT INTO clinic_settings', 'UPDATE registration_codes SET used_by', 'COMMIT']) {
    reset(); failure = stage;
    const res = await registration();
    assert.ok([400, 500].includes(res.code), `${stage}: ${res.code}`);
    if (stage === 'INSERT INTO clinics') assert.equal(res.body.field, 'clinic_email');
    if (stage === 'INSERT INTO clinic_users') assert.equal(res.body.field, 'username');
    assert.equal(state.code, true, stage);
    for (const table of ['clinics', 'users', 'features', 'settings']) assert.deepEqual(state[table], [], `${stage}: ${table}`);
    assert.equal(mails, 0); assert.equal(calls.at(-1).text, 'ROLLBACK');
    failure = null;
    assert.equal((await registration()).code, 201);
    assert.equal(state.code, false); assert.equal(state.clinics.length, 1);
    assert.equal(state.settings.length, 1); assert.equal(mails, 2);
  }
});
test('concurrent registrations serialize availability and create exactly one clinic without stranding the code', async () => {
  const entered = deferred(), resume = deferred();
  hook = async text => {
    if (text.startsWith('INSERT INTO clinics')) { entered.resolve(); await resume.promise; }
  };
  const first = registration();
  await entered.promise;
  const second = registration({ email: 'other@example.test', username: 'other_user', clinic_name: 'Otra QA' });
  resume.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(r => r.code).sort(), [201, 400]);
  assert.match(results.find(r => r.code === 400).body.error, /Código inválido/);
  assert.equal(state.clinics.length, 1); assert.equal(state.users.length, 1);
  assert.equal(state.settings.length, 1); assert.equal(mails, 2);
});
test('concurrent failed registration releases its code for the waiting registration', async () => {
  const entered = deferred(), resume = deferred();
  let failFirst = true;
  hook = async text => {
    if (text.startsWith('INSERT INTO clinic_users') && failFirst) {
      failFirst = false; entered.resolve(); await resume.promise;
      throw Object.assign(new Error('fictitious competing username'), { code: '23505', constraint: 'clinic_users_username_key' });
    }
  };
  const first = registration();
  await entered.promise;
  const second = registration({ username: 'other_user' });
  resume.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].code, 400); assert.equal(results[0].body.field, 'username');
  assert.equal(results[1].code, 201); assert.equal(state.code, false);
  assert.equal(state.clinics.length, 1); assert.equal(state.users.length, 1);
  assert.equal(state.users[0].username, 'other_user'); assert.equal(mails, 2);
});
test('WA rejects retained primary AND alternative phones regardless of account activity, on all write paths', async () => {
  const actions = [
    ['createUser', { clinic_id: ID, username: 'new_user', password: 'Password123', role: 'clinic_user', phone: PHONE }],
    ['updateUser', { id: 7, phone: PHONE }],
    ['updateOwnProfile', { phone: PHONE }],
    ['saveWhatsAppBotConfig', { staff_phone: PHONE }],
    ['setWhatsAppBotEnabled', { id: 7, enabled: true }],
  ];
  for (const active of [false, true]) for (const field of ['phone', 'whatsapp_staff_phone']) {
    for (const [action, body] of actions) {
      reset();
      state.evidence = [{ id: 88, clinic_id: OTHER, is_active: active, [field]: '0999000111' }];
      const res = await request(action, body, true);
      assert.ok([400, 409].includes(res.code), `${action}: ${res.code}`);
      assert.match(res.body.error, /retenido/);
      assert.equal(calls.some(c => /^(UPDATE|INSERT INTO) clinic_users/.test(c.text)), false);
      assert.deepEqual(state.evidence[0][field], '0999000111');
    }
  }
});
test('WA fails closed for foreign/global conversation evidence and lookup errors, without reassignment', async () => {
  for (const clinic_id of [OTHER, null]) {
    reset(); state.contacts = [{ clinic_id }];
    const res = await request('saveWhatsAppBotConfig', { staff_phone: PHONE }, true);
    assert.equal(res.code, 409); assert.match(res.body.error, /retenido/);
    assert.equal(calls.some(c => /^(UPDATE|DELETE).*whatsapp_contacts/.test(c.text)), false);
  }
  reset(); failure = 'SELECT clinic_id FROM whatsapp_contacts';
  assert.equal((await request('saveWhatsAppBotConfig', { staff_phone: PHONE }, true)).code, 500);
  assert.equal(calls.some(c => c.text.startsWith('UPDATE clinic_users')), false);
});
test('WA accepts an unclaimed number and same-clinic active conversation; blocks that conversation if clinic is inactive', async () => {
  for (const contacts of [[], [{ clinic_id: ID }]]) {
    reset(); state.contacts = contacts;
    assert.equal((await request('saveWhatsAppBotConfig', { staff_phone: PHONE }, true)).code, 200);
  }
  reset(); state.contacts = [{ clinic_id: ID }]; state.active = false;
  assert.equal((await request('saveWhatsAppBotConfig', { staff_phone: PHONE }, true)).code, 409);
});
