import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { readFileSync } from 'node:fs';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const USER = { id: 7, clinic_id: CLINIC, role: 'clinic_user' };
const STATE = 'a'.repeat(64);
const TOKEN = 'fictional-meta-business-token';
const calls = [];
let user;
let permission;
let attemptValid;
let channel;
let tokenApp;
let phones;
let rejectSync;
let lifecycleAllowed;
const locks = new Set();
const sql = async () => ({ rows: [] });
sql.query = async (text, values) => {
  calls.push({ text, values });
  if (text.includes('pg_try_advisory_xact_lock')) {
    const locked = !locks.has(values[0]);
    if (locked) locks.add(values[0]);
    return { rows: [{ locked }] };
  }
  if (text.includes('SELECT whatsapp_coexistence_enabled')) return { rows: [{ whatsapp_coexistence_enabled: permission }] };
  if (text.includes('DELETE FROM whatsapp_signup_attempts') && text.includes('RETURNING')) {
    const rows = attemptValid ? [{ user_id: 7 }] : [];
    attemptValid = false;
    return { rows };
  }
  if (text.includes('INSERT INTO whatsapp_signup_attempts')) return { rows: [{ user_id: 7 }] };
  if (text.includes('SELECT status FROM user_whatsapp_channels')) return { rows: channel ? [channel] : [] };
  if (text.includes('SELECT waba_id,')) return { rows: channel ? [channel] : [] };
  if (text.includes('INSERT INTO user_whatsapp_channels')) {
    assert.match(text, /clinic_id=\$2 AND is_active=true AND whatsapp_coexistence_enabled=true/);
    channel = { phone_number: values[4], token_encrypted: values[5], status: 'setup_failed' };
    return { rows: [{ user_id: 7 }] };
  }
  if (text.includes("SET status='pending_validation'")) {
    channel.status = 'pending_validation';
    return { rows: [{ user_id: 7 }] };
  }
  if (text.includes("token_encrypted=NULL") && channel) {
    channel.token_encrypted = null;
    channel.status = 'disconnected';
  }
  return { rows: [] };
};
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module(new URL('../lib/clinic-lifecycle.js', import.meta.url).href, { namedExports: {
  lockClinicWriters: async (_db, ids) => { assert.deepEqual(ids, [CLINIC]); },
  requireClinicWritable: async (_db, id) => {
    assert.equal(id, CLINIC);
    if (!lifecycleAllowed) throw Object.assign(new Error('Clínica bloqueada para operar'), { status: 409 });
  },
} });
mock.module(new URL('../lib/neon-clinical-db.js', import.meta.url).href, { namedExports: {
  getPool: () => ({ connect: async () => {
    let lockedUser;
    return { query: async (text, values) => {
      const result = await sql.query(text, values);
      if (text.includes('pg_try_advisory_xact_lock') && result.rows[0].locked) lockedUser = values[0];
      if (text === 'COMMIT' || text === 'ROLLBACK') {
        if (lockedUser !== undefined) locks.delete(lockedUser);
      }
      return result;
    }, release() {} };
  } }),
} });
mock.module(new URL('../lib/admin-auth.js', import.meta.url).href, {
  namedExports: { requireAuth: async (_req, res) => {
    if (!user) { res.status(401).json({ success: false }); return null; }
    return user;
  } },
});
const { handleWhatsAppChannelAction, encryptChannelToken, decryptChannelToken, initWhatsAppChannels,
  systemWhatsAppWebhook, processChannelLifecycle, withWhatsAppChannelLock } = await import('../lib/whatsapp-channels.js');

async function invoke(action, body = {}, { method = action === 'channelConfig' ? 'GET' : 'POST', headers = {} } = {}) {
  const req = { method, query: { action }, headers: { authorization: 'Bearer fictional-session', ...headers } };
  const res = { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handleWhatsAppChannelAction(req, res, async () => Buffer.from(JSON.stringify(body)));
  return res;
}
const complete = () => invoke('channelComplete', { state: STATE, code: 'one-use-code', wabaId: '123456' });

test.beforeEach(t => {
  calls.length = 0;
  locks.clear();
  user = USER;
  permission = true;
  attemptValid = true;
  channel = null;
  tokenApp = '123456789';
  phones = [{ id: '987654321', display_phone_number: '+593 999 000 222', is_on_biz_app: true, platform_type: 'CLOUD_API' }];
  rejectSync = false;
  lifecycleAllowed = true;
  Object.assign(process.env, { WHATSAPP_COEXISTENCE_PILOT_ENABLED: 'true',
    WHATSAPP_META_APP_ID: tokenApp, WHATSAPP_SIGNUP_CONFIG_ID: '123456780', WHATSAPP_GRAPH_VERSION: 'v26.0',
    WHATSAPP_APP_SECRET: 'fictional-secret', WHATSAPP_CHANNEL_ENCRYPTION_KEY: 'b'.repeat(64),
    WHATSAPP_PHONE_NUMBER_ID: '111111111' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    let payload;
    if (url.includes('oauth/access_token')) payload = { access_token: TOKEN };
    else if (url.includes('debug_token')) payload = { data: { is_valid: true, app_id: tokenApp, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] } };
    else if (url.includes('phone_numbers')) payload = { data: phones };
    else if (url.includes('subscribed_apps')) payload = { success: true };
    else if (url.includes('smb_app_data')) payload = rejectSync ? { error: { code: 100, message: TOKEN } } : { request_id: 'request-fictional' };
    else assert.fail(`Unexpected URL ${url}`);
    return { ok: !payload.error, status: payload.error ? 400 : 200, json: async () => payload };
  });
});

test('migration is idempotent and credential tables are denied to the clinical role', async () => {
  const queries = [];
  await initWhatsAppChannels(async text => { queries.push(text); });
  assert.ok(queries.some(text => /ADD COLUMN IF NOT EXISTS whatsapp_coexistence_enabled.*DEFAULT false/.test(text)));
  for (const table of ['user_whatsapp_channels', 'whatsapp_signup_attempts']) {
    assert.ok(queries.some(text => text.includes(`CREATE TABLE IF NOT EXISTS ${table}`)));
    assert.ok(queries.some(text => text.includes(`REVOKE ALL ON ${table} FROM bioskin_app`)));
    assert.ok(queries.some(text => text.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)));
  }
});

test('AES-GCM binds token to clinic, user, WABA and number and rejects tampering', () => {
  const context = `${CLINIC}:7:123456:987654321`;
  const encrypted = encryptChannelToken(TOKEN, context);
  assert.ok(!encrypted.includes(TOKEN));
  assert.notEqual(encrypted, encryptChannelToken(TOKEN, context));
  assert.equal(decryptChannelToken(encrypted, context), TOKEN);
  assert.throws(() => decryptChannelToken(encrypted, `${CLINIC}:8:123456:987654321`));
  const parts = encrypted.split('.');
  parts[2] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptChannelToken(parts.join('.'), context));
});

test('auth, master impersonation and methods are enforced before any Meta call', async () => {
  user = null;
  assert.equal((await invoke('channelStart')).code, 401);
  user = { ...USER, role: 'master_admin' };
  assert.equal((await invoke('channelStart')).code, 403);
  user = USER;
  assert.equal((await invoke('channelStart', {}, { headers: { 'x-target-user-id': '8' } })).code, 403);
  assert.equal((await invoke('channelStart', {}, { method: 'GET' })).code, 405);
  assert.ok(!calls.some(call => call.url));
});

test('master permission is independent of chatbot and global pilot flag fails closed', async () => {
  permission = false;
  const config = await invoke('channelConfig');
  assert.equal(config.body.authorized, false);
  assert.equal((await invoke('channelStart')).code, 403);
  permission = true;
  process.env.WHATSAPP_COEXISTENCE_PILOT_ENABLED = 'false';
  assert.equal((await invoke('channelConfig')).body.enabled, false);
  assert.equal((await invoke('channelStart')).code, 403);
  assert.ok(!calls.some(call => call.url));
});

test('clinic lifecycle is checked under writer lock before any code exchange or credential write', async () => {
  lifecycleAllowed = false;
  const res = await complete();
  assert.equal(res.code, 409);
  assert.match(res.body.error, /Clínica bloqueada/);
  assert.ok(!calls.some(call => call.url));
  assert.equal(channel, null);
});

test('start creates one-use session-bound expiring challenge and no secrets in response', async () => {
  const res = await invoke('channelStart');
  assert.equal(res.code, 200);
  assert.match(res.body.state, /^[a-f0-9]{64}$/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  const query = calls.find(call => call.text?.includes('INSERT INTO whatsapp_signup_attempts'));
  assert.match(query.text, /INTERVAL '10 minutes'/);
  assert.match(query.text, /INTERVAL '1 minute'/);
  assert.equal(query.values[0], USER.id);
  assert.equal(query.values[1], CLINIC);
  assert.notEqual(query.values[3], res.body.state);
  assert.ok(!JSON.stringify(res.body).includes('fictional-secret'));
});

test('complete exchanges code, verifies app, validates number and syncs without registering or sending', async () => {
  const res = await complete();
  assert.equal(res.code, 200);
  assert.equal(channel.status, 'pending_validation');
  assert.equal(decryptChannelToken(channel.token_encrypted, `${CLINIC}:7:123456:987654321`), TOKEN);
  const urls = calls.filter(call => call.url).map(call => call.url);
  assert.equal(urls.length, 6);
  assert.ok(urls.every(url => !url.includes('/register') && !url.includes('/messages')));
  assert.ok(calls.some(call => call.options?.body?.includes('"sync_type":"history"')));
  assert.ok(calls.some(call => call.options?.body?.includes('"sync_type":"smb_app_state_sync"')));
  assert.ok(!JSON.stringify(res.body).includes(TOKEN));
  assert.equal((await complete()).code, 409);
  assert.equal(calls.filter(call => call.url).length, 6);
});

test('expired/replayed state and malformed input cannot exchange credentials', async () => {
  attemptValid = false;
  assert.equal((await complete()).code, 409);
  for (const body of [null, [], { state: STATE, code: 'code', wabaId: '../other' }, { token: TOKEN }]) {
    assert.equal((await invoke('channelComplete', body)).code, 400);
  }
  assert.ok(!calls.some(call => call.url));
});

test('wrong Meta app, personal app, ambiguous numbers and system number are rejected', async () => {
  tokenApp = '999999999';
  assert.equal((await complete()).code, 403);
  tokenApp = process.env.WHATSAPP_META_APP_ID;
  for (const nextPhones of [
    [{ ...phones[0], is_on_biz_app: false }],
    [phones[0], { ...phones[0], id: '222222222' }],
    [{ ...phones[0], id: process.env.WHATSAPP_PHONE_NUMBER_ID }],
  ]) {
    attemptValid = true;
    phones = nextPhones;
    assert.equal((await complete()).code, 409);
  }
  assert.equal(channel, null);
});

test('failed sync remains visibly incomplete and never exposes Meta payload or sends messages', async () => {
  rejectSync = true;
  const res = await complete();
  assert.equal(res.code, 502);
  assert.equal(channel.status, 'setup_failed');
  assert.ok(!JSON.stringify(res.body).includes(TOKEN));
  assert.ok(!calls.some(call => call.url?.endsWith('/messages')));
});

test('disconnect clears own secret even when master permission or global pilot are off', async () => {
  channel = { status: 'pending_validation', token_encrypted: 'encrypted' };
  permission = false;
  process.env.WHATSAPP_COEXISTENCE_PILOT_ENABLED = 'false';
  const res = await invoke('channelDisconnect');
  assert.equal(res.code, 200);
  assert.equal(channel.token_encrypted, null);
  const query = calls.find(call => call.text?.includes('token_encrypted=NULL'));
  assert.deepEqual(query.values, [7, CLINIC]);
  assert.ok(!calls.some(call => call.url));
});

test('a concurrent connection cannot be disconnected or revoked with a false success', async () => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = withWhatsAppChannelLock(USER.id, async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
  });
  await ready;
  assert.equal((await invoke('channelDisconnect')).code, 409);
  await assert.rejects(withWhatsAppChannelLock(USER.id, async () => {}), { statusCode: 409 });
  await withWhatsAppChannelLock(8, async () => {});
  release();
  await held;
  assert.equal((await invoke('channelDisconnect')).code, 200);
  assert.equal(locks.size, 0);
});

test('batched webhooks isolate every client change from global chatbot and CRM', () => {
  const body = { object: 'whatsapp_business_account', entry: [
    { id: '123456', changes: [
      { field: 'messages', value: { metadata: { phone_number_id: '111111111' }, messages: [{ text: { body: 'menu' } }] } },
      { field: 'messages', value: { metadata: { phone_number_id: '987654321' }, messages: [{ text: { body: 'menu' } }] } },
      { field: 'history', value: { metadata: { phone_number_id: '111111111' }, messages: [{ text: { body: 'menu' } }] } },
      { field: 'messages', value: { messages: [{ text: { body: 'menu' } }] } },
    ] }, { id: '654321', changes: [{ field: 'smb_message_echoes', value: {} }] },
  ] };
  const result = systemWhatsAppWebhook(body);
  assert.equal(result.entry.length, 1);
  assert.equal(result.entry[0].changes.length, 1);
  assert.equal(body.entry[0].changes.length, 4);
  assert.equal(systemWhatsAppWebhook(body, '').entry.length, 0);
});

test('provider offboarding invalidates credentials only for the affected messaging account', async () => {
  await processChannelLifecycle({ entry: [{ id: '123456', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] });
  assert.deepEqual(calls[0].values, ['123456']);
  assert.match(calls[0].text, /WHERE waba_id=\$1/);
});

test('pilot cannot be activated from UI or auto-send reminders using the system channel', () => {
  const bot = readFileSync(new URL('../api/whatsapp-chatbot.js', import.meta.url), 'utf8');
  assert.match(bot, /whatsapp_confirm_enabled = true[\s\S]*?AND false/);
  assert.match(bot, /paused: true, reason:/);
  const ui = readFileSync(new URL('../src/pages/AdminSystemStatus.tsx', import.meta.url), 'utf8');
  assert.match(ui, /<WhatsAppCoexistence \/>/);
  const dashboard = readFileSync(new URL('../src/pages/AdminDashboard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(dashboard, /WhatsAppCoexistence|whatsapp_coexistence|action=channelConfig/);
  const component = readFileSync(new URL('../src/components/admin/WhatsAppCoexistence.tsx', import.meta.url), 'utf8');
  assert.match(component, /onClick=\{disconnect\}/);
  assert.match(component, /Confirmar desconexión/);
  assert.doesNotMatch(component, /mode ===|dashboard → Ajustes/);
  const api = readFileSync(new URL('../api/admin-auth.js', import.meta.url), 'utf8');
  const action = api.slice(api.indexOf("if (action === 'setWhatsAppCoexistenceEnabled')"));
  assert.match(action, /requireRole\(user, 'master_admin'\)/);
  assert.match(action, /typeof req.body\?\.enabled !== 'boolean'/);
  assert.ok(api.indexOf("if (action === 'setWhatsAppCoexistenceEnabled')") < api.indexOf('const suppliedClinics'));
});
