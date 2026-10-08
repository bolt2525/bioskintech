import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test, { mock } from 'node:test';

const ID = '11111111-2222-4333-8444-555555555555';
const T = Date.parse('2026-08-01T00:00:00Z');
const DAY = 86400000;
let clock = T, role = 'clinic_admin', shared = 0, exclusive = false, sessionReadFailure = false, otpAvailable = false;
let clinic = {}, annual = [], statements = [], r2Calls = [];
const password = 'Fictitious-Password-123';
const features = [{ feature: 'finance', enabled: false }, { feature: 'calendar', enabled: true }];
const url = path => new URL(path, import.meta.url).href;
const session = () => ({ ...clinic, clinic_active: clinic.is_active, role, clinic_id: ID,
  clinic_user_id: 7, id: 7, username: 'qa-user', is_active: true, email: null, clinic_name: 'Fictitious',
  finance_enabled: false, expires_at: '2099-01-01', password_hash: createHash('sha256').update(password).digest('hex'), hash_algo: 'sha256' });

const db = {
  async query(statement, params = []) {
    statements.push({ statement, params });
    if (statement.includes('pg_try_advisory_xact_lock')) {
      const acquired = shared === 0 && !exclusive;
      if (acquired) exclusive = true;
      return { rows: [{ acquired }] };
    }
    if (/pg_advisory_(xact_lock_shared|lock_shared)/.test(statement)) { assert.equal(exclusive, false); shared++; }
    if (statement.includes('pg_advisory_unlock_shared')) shared--;
    if (statement === 'COMMIT' || statement === 'ROLLBACK') { shared = 0; exclusive = false; }
    if (statement.includes("to_regclass('public.annual_photo_backup_requests')"))
      return { rows: [{ requests: 'annual_photo_backup_requests', annual_schema_ready: true }] };
    if (statement.includes("information_schema.columns")) return { rows: [{ ready: true }] };
    if (statement.includes('FROM annual_photo_backup_requests r JOIN')) {
      if (statement.includes('WHERE r.id=$1')) return { rows: annual.map(row=>({
        id: params[0],clinic_id: ID,entitlement_kind: 'FREE',entitled: !row.unpaid,...row,
      })) };
      assert.ok(statement.includes('r.created_at < $2::timestamptz'));
      assert.ok(statement.includes("r.status IN ('REQUESTED','APPROVED','READY')"));
      assert.ok(statement.includes('r.created_at<r.entitlement_deadline_at'));
      return { rows: annual.filter(row => Date.parse(row.created_at) < Date.parse(params[1]) && !row.unpaid)
        .map(row=>({ entitlement_kind: 'FREE', entitlement_deadline_at: new Date(T+45*DAY).toISOString(),
          entitled: true, ...row })) };
    }
    if (statement.includes('SELECT id,ready_at FROM annual_photo_backup_requests'))
      return { rows: annual.filter(row => row.status === 'READY').map(row => ({ id: params[0], ready_at: row.ready_at })) };
    if (statement.includes('SELECT part_number,r2_key,size_bytes,sha256 FROM annual_photo_backup_parts'))
      return { rows: [{ part_number: 1, size_bytes: 10, sha256: 'a'.repeat(64) }] };
    if (statement.includes('SELECT subscription_expires_at,subscription_days FROM clinics'))
      return { rows: [{ subscription_expires_at: clinic.subscription_expires_at, subscription_days: 365 }] };
    if (statement.includes('SELECT c.id,cs.general FROM clinics')) return { rows: [{ id: ID, general: clinic.general }] };
    if (statement.startsWith('UPDATE clinics SET subscription_expires_at')) { clinic.subscription_expires_at = params[1]; return { rows: [] }; }
    if (statement.includes("jsonb_build_object('_subscription_policy'")) {
      clinic.general._subscription_policy = statement.includes('$2::jsonb')
        ? JSON.parse(params[1]) : { ...clinic.general._subscription_policy, kind: params[1] }; return { rows: [] };
    }
    if (statement.includes("jsonb_build_object('_subscription_lifecycle'")) {
      clinic.general._subscription_lifecycle = JSON.parse(params[1]); return { rows: [] };
    }
    if (statement.includes('FROM clinics c') && statement.includes('WHERE c.id=$1'))
      return { rows: [{ ...clinic, purging: Boolean(clinic.general._purge) }] };
    if (statement.startsWith('SELECT clinic_id FROM consent_forms')) return { rows: [{ clinic_id: ID }] };
    if (statement.includes('SELECT c.id,') && statement.includes('ORDER BY c.id')) return { rows: [clinic] };
    if (statement.includes('FROM whatsapp_contacts WHERE phone=')) return { rows: [{ clinic_id: ID }] };
    if (statement.includes("information_schema.tables")) return { rows: [] };
    if (statement.includes('SELECT name FROM clinics')) return { rows: [{ name: 'Fictitious' }] };
    if (statement.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
    return { rows: [] };
  },
  release() {},
};
const pool = { query: (...args) => db.query(...args), connect: async () => db };
const sql = async (strings, ...params) => {
  const statement = strings.reduce((text, part, i) => text + part + (i < params.length ? `$${i + 1}` : ''), '');
  if (statement.includes('FROM admin_sessions s')) {
    if (sessionReadFailure) throw new Error('Fictitious schema read failure');
    return { rows: [session()] };
  }
  if (statement.includes('SELECT username, expires_at, role, clinic_id, access_scope FROM admin_sessions'))
    return { rows: [session()] };
  if (statement.includes('FROM login_otp lo')) return { rows: otpAvailable
    ? [{ ...session(), user_id: 7, code: '123456', attempts: 0 }] : [] };
  if (statement.startsWith('UPDATE login_otp SET used=true')) {
    statements.push({ statement, params }); return { rows: [{ id: 7 }] };
  }
  if (statement.includes('FROM clinic_users cu') && statement.includes('password_hash')) return { rows: [session()] };
  if (statement.includes('SELECT feature, enabled FROM clinic_features')) return { rows: structuredClone(features) };
  if (statement.startsWith('SELECT clinic_id FROM invite_links')) return { rows: [{ clinic_id: ID }] };
  if (statement.includes('c.id,cs.general') && statement.includes('WHERE c.id=')) return { rows: [{ ...clinic, clinic_active: clinic.is_active }] };
  if (statement.includes('JOIN clinics c') && statement.includes('public_booking_enabled')) {
    return { rows: [{ id: 7, clinic_id: ID, public_booking_enabled: true }] };
  }
  return db.query(statement, params);
};
sql.query = (...args) => db.query(...args);
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module(url('../lib/neon-clinical-db.js'), { namedExports: {
  getPool: () => pool, getAppPool: () => pool, initClinicalDatabase: async () => {},
  withTenantContext: async (_id, fn) => fn(db),
} });
const noNetwork = async () => assert.fail('No remote network permitted');
mock.method(globalThis, 'fetch', noNetwork);
mock.module(url('../lib/r2-service.js'), { namedExports: Object.fromEntries([
  'generateUploadUrl','generateReadUrl','deleteR2Object','putR2Object','getR2ObjectBuffer',
  'r2ObjectExists','listR2Objects','listR2ObjectPage','generateDownloadUrl',
].map(name => [name, async (...args) => {
  r2Calls.push({ name, args });
  if (name === 'listR2Objects') return [];
  if (name === 'generateDownloadUrl') return 'https://example.invalid/download';
  if (name === 'putR2Object') return {};
  return noNetwork();
}])) });
mock.method(Date, 'now', () => clock);
process.env.CRON_SECRET = 'fictitious-local-cron';
process.env.BACKUP_ENCRYPTION_KEY = 'fictitious-local-backup-key'.padEnd(48, 'x');

const policy = await import('../lib/subscription-lifecycle.js');
const auth = await import('../lib/admin-auth.js');
const { default: admin } = await import('../api/admin-auth.js');
const { default: backup, runCron, createSnapshot } = await import('../api/backup.js');
const { default: records } = await import('../api/records.js');
const { default: calendar } = await import('../api/calendar.js');
const { default: ai } = await import('../api/ai-consultation.js');
const { default: finance } = await import('../api/external-finance.js');
const { default: email } = await import('../api/sendEmail.js');
const { default: whatsapp } = await import('../api/whatsapp-chatbot.js');
const { default: booking } = await import('../api/public-booking.js');

function reset(offset = 0) {
  clock = T + offset; role = 'clinic_admin'; shared = 0; exclusive = false;
  sessionReadFailure = false; otpAvailable = false;
  clinic = { id: ID, is_active: true, subscription_expires_at: new Date(T).toISOString(), paid_subscription: true,
    general: { _subscription_policy: {
      kind: 'paid', policy_version: policy.SUBSCRIPTION_POLICY_VERSION, opt_in: true, acceptance_confirmed: true,
      basis: 'new_contract', contract_reference: 'fictitious-signed-contract',
      accepted_at: new Date(T - 400 * DAY).toISOString(), effective_at: new Date(T - 365 * DAY).toISOString(),
      recorded_at: new Date(T - 400 * DAY).toISOString(), recorded_by: { role: 'master_admin', username: 'qa-provider' },
    } } };
  annual = []; statements = []; r2Calls = [];
}
const response = () => ({ code: null, body: null, setHeader() {},
  status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; }, end() { return this; }, redirect(code, body) { this.code = code; this.body = body; return this; } });
async function invoke(handler, path, action, { method = 'GET', body = {}, headers = {}, query = {} } = {}) {
  const res = response();
  await handler({ url: `${path}?action=${action}`, method, headers: { authorization: 'Bearer fictitious-session', ...headers },
    query: { action, ...query }, body,
    ...(typeof body === 'string' ? { [Symbol.asyncIterator]: async function* () { yield Buffer.from(body); } } : {}),
  }, res);
  return res;
}

test('verify API observes exact paid boundaries, keeps contracted features, and never promotes expired access', async () => {
  let baseline;
  for (const [offset, state, valid] of [
    [-1, 'ACTIVE', true], [0, 'GRACE', true], [15 * DAY - 60000, 'GRACE', true],
    [15 * DAY, 'RECOVERY', true], [45 * DAY - 60000, 'RECOVERY', true], [45 * DAY, 'CLOSED', false],
  ]) {
    reset(offset);
    const res = await invoke(admin, '/api/admin-auth', 'verify');
    assert.equal(res.code, valid ? 200 : 401);
    assert.equal(res.body.subscription_lifecycle.state, state);
    assert.equal(res.body.subscription_lifecycle.grace_ends_at, new Date(T + 15 * DAY).toISOString());
    assert.equal(res.body.subscription_lifecycle.recovery_ends_at, new Date(T + 45 * DAY).toISOString());
    if (valid) {
      assert.ok(!res.body.features.includes('finance'));
      if (!baseline) baseline = res.body.features;
      assert.deepEqual(res.body.features, baseline);
    }
  }
});

test('login returns the same lifecycle as verify; collaborators cannot login or export in recovery', async () => {
  reset(15 * DAY - 1);
  const login = await invoke(admin, '/api/admin-auth', 'login', { method: 'POST', body: { username: 'qa-user', password } });
  assert.equal(login.code, 200);
  assert.equal(login.body.subscription_lifecycle.state, 'GRACE');
  const verified = await invoke(admin, '/api/admin-auth', 'verify');
  assert.deepEqual(login.body.subscription_lifecycle, verified.body.subscription_lifecycle);
  clock = T + 15 * DAY;
  role = 'clinic_user';
  assert.equal((await invoke(admin, '/api/admin-auth', 'login', { method: 'POST', body: { username: 'qa-user', password } })).code, 401);
  assert.equal((await invoke(admin, '/api/admin-auth', 'verify')).code, 401);
  assert.equal((await invoke(backup, '/api/backup', 'template')).code, 401);
  role = 'clinic_admin';
  assert.equal((await invoke(backup, '/api/backup', 'template')).code, 200);
});

test('OTP created before a boundary cannot create a collaborator session at T+15 or admin session at T+45', async () => {
  for (const [offset, currentRole, allowed] of [
    [15 * DAY - 1, 'clinic_user', true], [15 * DAY, 'clinic_user', false],
    [15 * DAY, 'clinic_admin', true], [45 * DAY, 'clinic_admin', false],
  ]) {
    reset(offset); role = currentRole; otpAvailable = true;
    const result = await invoke(admin, '/api/admin-auth', 'verifyOTP', {
      method: 'POST', body: { otpToken: 'fictitious-otp', code: '123456' },
    });
    assert.equal(result.body.success, allowed);
    assert.equal(statements.some(s => s.statement.includes('INSERT INTO admin_sessions')), allowed);
    assert.equal(statements.some(s => s.statement.startsWith('UPDATE login_otp SET used=true')), allowed);
    if (!allowed) assert.equal(result.body.sessionToken, undefined);
  }
});

test('policy/schema read failures cannot promote tenant sessions through the legacy fallback', async () => {
  reset(); sessionReadFailure = true;
  assert.equal((await invoke(admin, '/api/admin-auth', 'verify')).code, 401);
  assert.equal((await auth.authenticateRequest({
    url: '/api/records', headers: { authorization: 'Bearer fictitious-session' }, query: {},
  })).valid, false);
  const res = response();
  assert.equal(await auth.requireAuth({ headers: { authorization: 'Bearer fictitious-session' }, query: {} }, res), null);
  assert.equal(res.code, 500);
  role = 'master_admin';
  assert.equal((await invoke(admin, '/api/admin-auth', 'verify')).code, 200);
});

test('real direct operational APIs, forged action=verify and master target headers cannot bypass recovery', async () => {
  reset(15 * DAY);
  for (const [handler, path, action, method] of [
    [records,'/api/records','listPatients','GET'], [calendar,'/api/calendar','listEvents','GET'],
    [ai,'/api/ai-consultation','list','GET'], [finance,'/api/external-finance','list','GET'],
    [email,'/api/sendEmail','send','POST'], [whatsapp,'/api/whatsapp-chatbot','crmContacts','GET'],
    [records,'/api/records','verify','GET'],
  ]) {
    const res = await invoke(handler, path, action, { method });
    assert.ok([401,403].includes(res.code), `${path} must block, got ${res.code}`);
  }
  role = 'master_admin';
  assert.equal((await invoke(records, '/api/records', 'listPatients', { headers: { 'x-target-clinic-id': ID } })).code, 401);
  assert.equal((await invoke(admin, '/api/admin-auth', 'verify')).code, 200, 'master administrative control remains available');
  assert.deepEqual(r2Calls, []);
});

test('operational API use remains normal at 14d23h59m and stops exactly at 15d; demos receive no paid grace', async () => {
  reset(15 * DAY - 60000);
  assert.equal((await invoke(ai, '/api/ai-consultation', 'list')).code, 200);
  assert.equal((await auth.authenticateRequest({ url: '/api/records?action=listPatients', headers: {
    authorization: 'Bearer fictitious-session',
  }, query: { action: 'listPatients' } })).finance_enabled, false);
  clock = T + 15 * DAY;
  assert.equal((await invoke(ai, '/api/ai-consultation', 'list')).code, 401);
  reset(1);
  clinic.paid_subscription = false; clinic.trial_subscription = true;
  assert.equal((await invoke(admin, '/api/admin-auth', 'verify')).code, 401);
  clinic.paid_subscription = true; clinic.trial_subscription = false;
  clinic.is_demo = true; clinic.demo_expires_at = new Date(T).toISOString();
  assert.equal((await invoke(admin, '/api/admin-auth', 'verify')).body.demoExpired, true);
});

test('master malformed target headers fail closed instead of falling back to global scope', async () => {
  reset();
  role = 'master_admin';
  for (const target of ['', 'not-a-clinic', '-'.repeat(36), [ID], `${ID} `]) {
    assert.equal((await auth.authenticateRequest({
      url: '/api/records?action=listPatients', query: { action: 'listPatients' },
      headers: { authorization: 'Bearer fictitious-session', 'x-target-clinic-id': target },
    })).valid, false);
  }
  assert.equal((await auth.authenticateRequest({
    url: '/api/records?action=listPatients', query: { action: 'listPatients' },
    headers: { authorization: 'Bearer fictitious-session', 'x-target-clinic-id': ID },
  })).effective_clinic_id, ID);
});

test('recovery backup API permits export/status/list/template but denies all operational backup actions', async () => {
  reset(15 * DAY);
  for (const action of ['stats','template','templateInfo','snapshots']) {
    assert.equal((await invoke(backup, '/api/backup', action)).code, 200, action);
  }
  const exported = await invoke(backup, '/api/backup', 'export', { method: 'POST', body: { modules: ['patients'] } });
  assert.equal(exported.code, 200);
  for (const action of ['snapshot','restore','importPatients','uploadUrl']) {
    assert.equal((await invoke(backup, '/api/backup', action, { method: 'POST' })).code, 401, action);
  }
  clock = T + 45 * DAY;
  assert.equal((await invoke(backup, '/api/backup', 'template')).code, 401);
});

test('recovery requestPhotoBackup is admin-only and remains gated by annual free eligibility/Worker OFF', async () => {
  reset(15 * DAY);
  const req = { url: '/api/backup?action=requestPhotoBackup', method: 'POST', query: { action: 'requestPhotoBackup' },
    headers: { authorization: 'Bearer fictitious-session' }, body: {} };
  assert.equal((await auth.authenticateRequest(req)).valid, true);
  assert.equal((await invoke(backup, '/api/backup', 'requestPhotoBackup', { method: 'POST' })).code, 503,
    'Worker is intentionally not configured: policy allowance does not provision service');
  role = 'clinic_user';
  assert.equal((await invoke(backup, '/api/backup', 'requestPhotoBackup', { method: 'POST' })).code, 401);
});

test('paid legacy contracts remain on original expiry without 45-day automatic eligibility until prospectively accepted', async () => {
  reset(15 * DAY);
  delete clinic.general._subscription_policy;
  const legacy = await invoke(admin, '/api/admin-auth', 'verify');
  assert.equal(legacy.code, 401);
  assert.equal(legacy.body.subscription_lifecycle.opt_in, false);
  assert.equal(legacy.body.subscription_lifecycle.auto_purge_eligible, false);
  assert.equal(legacy.body.subscription_lifecycle.enrollment_status, 'REQUIRES_CONTRACT_REVIEW');
  assert.equal(legacy.body.subscription_lifecycle.grace_ends_at, new Date(T).toISOString());
  role = 'master_admin';
  const newExpiry = new Date(clock + 365 * DAY).toISOString();
  const enrollment = {
    policy_version: policy.SUBSCRIPTION_POLICY_VERSION, opt_in: true, acceptance_confirmed: true,
    basis: 'addendum', contract_reference: 'signed-fictitious-addendum',
    accepted_at: new Date(clock - 1).toISOString(), effective_at: new Date(clock + DAY).toISOString(),
  };
  for (const change of [
    { acceptance_confirmed: false }, { policy_version: 'unknown' }, { basis: 'legacy_guess' },
    { effective_at: new Date(clock - 1).toISOString() }, { contract_reference: 'short' },
  ]) {
    const denied = await invoke(admin, '/api/admin-auth', 'updateClinicSubscription', { method: 'POST',
      body: { clinic_id: ID, expires_at: newExpiry, subscription_days: 365, policy_enrollment: { ...enrollment, ...change } } });
    assert.equal(denied.code, 400);
    assert.equal(clinic.general._subscription_policy, undefined);
  }
  const result = await invoke(admin, '/api/admin-auth', 'updateClinicSubscription', { method: 'POST',
    body: { clinic_id: ID, expires_at: newExpiry, subscription_days: 365, policy_enrollment: enrollment } });
  assert.equal(result.code, 200);
  assert.equal(result.body.subscription_lifecycle.policyVersion, policy.SUBSCRIPTION_POLICY_VERSION);
  assert.equal(result.body.subscription_lifecycle.policy_accepted, true);
  assert.equal(result.body.subscription_lifecycle.enrollment_status, 'SCHEDULED');
  assert.equal(result.body.subscription_lifecycle.auto_purge_eligible, false);
  clock += DAY;
  assert.equal((await policy.loadSubscriptionLifecycle(db, ID, clock)).auto_purge_eligible, true);
  assert.equal(clinic.general._subscription_policy.recorded_by.role, 'master_admin');
  assert.equal(clinic.general._subscription_policy.recorded_by.username, 'qa-user');
  const receipt = structuredClone(clinic.general._subscription_policy);
  await policy.renewClinicSubscription(pool, ID, new Date(clock + 400 * DAY), 365, 'paid');
  assert.deepEqual(clinic.general._subscription_policy, receipt, 'normal renewals cannot erase accepted policy evidence');
  assert.equal(statements.some(s => /INSERT INTO legal_acceptances/.test(s.statement)), false);
});

test('subscription kind or forged settings cannot assign paid cycle without payment and signed enrollment evidence', async () => {
  reset();
  clinic.general = { _subscription_policy: { kind: 'paid' } };
  assert.equal((await policy.loadSubscriptionLifecycle(db, ID, clock)).auto_purge_eligible, false);
  role = 'master_admin';
  const forged = await invoke(admin, '/api/admin-auth', 'saveClinicSettings', { method: 'POST',
    body: { clinicId: ID, section: 'general', data: { _subscription_policy: { opt_in: true } } } });
  assert.equal(forged.code, 409);
  clinic.paid_subscription = false;
  const enrollment = { policy_version: policy.SUBSCRIPTION_POLICY_VERSION, opt_in: true, acceptance_confirmed: true,
    basis: 'new_contract', contract_reference: 'signed-fictitious-contract',
    accepted_at: new Date(clock).toISOString(), effective_at: new Date(clock).toISOString() };
  await assert.rejects(policy.renewClinicSubscription(pool, ID, new Date(clock + DAY), 365, 'paid',
    enrollment, { role: 'master_admin', username: 'qa-provider' }), { status: 409 });
  clinic.paid_subscription = true; clinic.trial_subscription = true;
  await assert.rejects(policy.renewClinicSubscription(pool, ID, new Date(clock + DAY), 365, 'paid',
    enrollment, { role: 'master_admin', username: 'qa-provider' }), { status: 409 });
});

test('paid annual hold excludes forged paid flags and requires persisted provider/payment metadata', () => {
  const deadline = new Date(T + 45 * DAY).toISOString();
  const request = { status: 'REQUESTED', created_at: new Date(T + 40 * DAY).toISOString(),
    entitlement_kind: 'PAID', payment_status: 'PENDING', provider_accepted_at: new Date(T + 41 * DAY).toISOString() };
  assert.equal(policy.annualDeliveryHold(request, deadline, T + 45 * DAY).protected, false);
  assert.equal(policy.annualDeliveryHold({ ...request, payment_status: 'PAID', provider_accepted_at: null }, deadline).protected, false);
  assert.equal(policy.annualDeliveryHold({ ...request, payment_status: 'PAID' }, deadline, T + 45 * DAY).protected, false);
  assert.equal(policy.annualDeliveryHold({ ...request, payment_status: 'PAID', confirmed_provider_id: 1, quote_provider_id: 1,
    payment_reference: 'provider-receipt-1', quote_total_cents: 1000, paid_at: new Date(T+42*DAY).toISOString() },
  deadline, T + 45 * DAY).protected, true);
  assert.equal(policy.annualDeliveryHold({ ...request, payment_status: 'PAID', provider_accepted_at: deadline }, deadline).protected, false);
});

test('public booking, short URLs and public consent token requests stop at T+15 before clinical reads or remote side effects', async () => {
  reset(15 * DAY);
  const res = await invoke(booking, '/api/public-booking', 'slots', { query: {
    clinicSlug: 'fictitious', username: 'qa-user', date: '2026-09-01', service: 'Fictitious',
  } });
  assert.equal(res.code, 403);
  for (const action of ['getSigningSession','verifySigningCode','submitSignature']) {
    const token = 'a'.repeat(64);
    const signed = await invoke(records, '/api/records', action, { query: { token }, body: { token }, method: action === 'getSigningSession' ? 'GET' : 'POST' });
    assert.equal(signed.code, 403);
  }
  const link = await invoke(whatsapp, '/api/whatsapp-chatbot', 'r', { query: { c: `${ID}.${'a'.repeat(22)}` } });
  assert.equal(link.code, 404);
  assert.equal(statements.some(s => s.statement.includes('UPDATE consent_forms')), false);
  assert.deepEqual(r2Calls, []);
  const invited = await invoke(admin, '/api/admin-auth', 'useInvite', { method: 'POST',
    body: { token: 'a'.repeat(64), accepted_terms: true, accepted_legal_version: '2026-10-07-r2' } });
  assert.equal(invited.code, 403);
  assert.equal(statements.some(s => s.statement.includes('UPDATE invite_links SET is_used = true')), false);
});

test('signed webhook acknowledges inactive operational traffic without writing incoming messages or replying', async () => {
  reset(15 * DAY);
  process.env.WHATSAPP_APP_SECRET = 'fictitious-whatsapp-secret';
  const body = { entry: [{ changes: [{ value: { messages: [{ id: 'fictitious-msg', from: '593999000111', type: 'text', text: { body: 'menu' }, timestamp: '1785542400' }] } }] }] };
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
  const res = await invoke(whatsapp, '/api/whatsapp-chatbot', '', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signature } });
  assert.equal(res.code, 200);
  assert.equal(statements.some(s => s.statement.includes('INSERT INTO whatsapp_messages')), false);
});

test('renewal uses the exclusive lifecycle lock, rejects tombstones, and preserves exact feature rows', async () => {
  reset(44 * DAY + 23 * 3600000);
  const before = await invoke(admin, '/api/admin-auth', 'verify');
  role = 'master_admin';
  shared = 1;
  await assert.rejects(policy.renewClinicSubscription(pool, ID, new Date(T + 400 * DAY), 365), { status: 409 });
  shared = 0;
  const renewed = await invoke(admin, '/api/admin-auth', 'updateClinicSubscription', {
    method: 'POST', body: { clinic_id: ID, expires_at: new Date(T + 400 * DAY).toISOString(), subscription_days: 365 },
  });
  assert.equal(renewed.code, 200);
  assert.equal(renewed.body.subscription_lifecycle.state, 'ACTIVE');
  role = 'clinic_admin';
  assert.deepEqual((await invoke(admin, '/api/admin-auth', 'verify')).body.features, before.body.features);
  assert.equal(statements.some(s => /UPDATE clinic_features|INSERT INTO clinic_features/.test(s.statement)), false);
  assert.equal(clinic.general._subscription_lifecycle.state, 'ACTIVE');
  clinic.general._purge = { state: 'QUIESCING' };
  await assert.rejects(policy.renewClinicSubscription(pool, ID, new Date(T + 500 * DAY), 365), { status: 409 });
});

test('cron persists recovery and stops automatic snapshots exactly at T+15, including a renewal between list and lock', async () => {
  for (const offset of [15 * DAY - 1, 15 * DAY]) {
    reset(offset);
    let snapshots = 0;
    const res = response();
    await runCron({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} }, res, pool, {
      now: () => clock, snapshot: async () => { snapshots++; },
      purgePhotos: async () => ({ complete: true }), purgeWhatsApp: async () => ({}),
    });
    assert.equal(snapshots, offset < 15 * DAY ? 1 : 0);
    assert.equal(clinic.general._subscription_lifecycle.state, offset < 15 * DAY ? 'GRACE' : 'RECOVERY');
  }
  reset(15 * DAY);
  await assert.rejects(createSnapshot(pool, ID, 'auto', 'cron', { collect: async () => ({}) }), { status: 403 });
  assert.deepEqual(r2Calls, []);
  clinic.subscription_expires_at = new Date(T + 100 * DAY).toISOString();
  assert.equal((await policy.syncSubscriptionLifecycle(pool, clinic, clock)).state, 'ACTIVE');
});

test('annual free eligible jobs protect pending and READY+24h, but not late or unpaid requests; CLOSED delivery is admin-only', async () => {
  reset(45 * DAY);
  annual = [{ status: 'REQUESTED', created_at: new Date(T + 40 * DAY).toISOString() }];
  assert.equal((await policy.annualPurgeProtection(db, ID, new Date(T + 45 * DAY).toISOString(), clock)).protected, true);
  const verified = await invoke(admin, '/api/admin-auth', 'verify');
  assert.equal(verified.code, 200);
  assert.equal(verified.body.delivery_only, true);
  assert.equal(verified.body.subscription_lifecycle.state, 'CLOSED');
  assert.equal((await invoke(backup, '/api/backup', 'template')).code, 401);
  role = 'clinic_user';
  assert.equal((await invoke(admin, '/api/admin-auth', 'verify')).code, 401);
  role = 'clinic_admin';
  annual[0] = { ...annual[0], status: 'READY', ready_at: new Date(clock).toISOString() };
  clock += DAY - 1;
  assert.equal((await policy.annualPurgeProtection(db, ID, new Date(T + 45 * DAY), clock)).protected, true);
  clock++;
  assert.equal((await policy.annualPurgeProtection(db, ID, new Date(T + 45 * DAY), clock)).protected, false);
  annual = [{ status: 'REQUESTED', created_at: new Date(T + 45 * DAY).toISOString() },
    { status: 'REQUESTED', unpaid: true, created_at: new Date(T + 40 * DAY).toISOString() }];
  assert.equal((await policy.annualPurgeProtection(db, ID, new Date(T + 45 * DAY), clock)).protected, false);
});

test('missing/legacy and invalid dates are explicit policies, not evidence for paid grace or automatic purge', () => {
  assert.equal(policy.subscriptionLifecycle({}).policy, 'legacy');
  assert.equal(policy.subscriptionLifecycle({}).state, 'ACTIVE');
  assert.equal(policy.subscriptionLifecycle({ paid_subscription: true }).state, 'CLOSED');
  assert.equal(policy.subscriptionLifecycle({ subscription_expires_at: 'invalid' }).policy, 'invalid');
  assert.equal(policy.subscriptionLifecycle({ subscription_expires_at: new Date(T), trial_subscription: true }, T).state, 'CLOSED');
  assert.equal(policy.subscriptionLifecycle({ subscription_expires_at: new Date(T) }, T).state, 'CLOSED');
});

test('configured annual status/download handlers honor CLOSED delivery and deny at READY+24h without remote access', async t => {
  const config = {
    ANNUAL_PHOTO_BACKUP_ENABLED: 'true', ANNUAL_PHOTO_BACKUP_WORKER_URL: 'https://example.invalid/worker',
    ANNUAL_PHOTO_BACKUP_SECRET: 'fictitious-annual-secret'.padEnd(40, 'x'),
    EMAIL_USER: 'qa@example.invalid', EMAIL_PASS: 'fictitious-mail',
    ANNUAL_PHOTO_BACKUP_MASTER_EMAIL: 'provider@example.invalid',
    R2_ACCESS_KEY_ID: 'fictitious-r2', R2_SECRET_ACCESS_KEY: 'fictitious-r2',
  };
  const saved = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  reset(45 * DAY);
  const readyAt = clock;
  const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  annual = [{ status: 'READY', created_at: new Date(T + 40 * DAY).toISOString(), ready_at: new Date(readyAt).toISOString() }];
  assert.equal((await invoke(backup, '/api/backup', 'photoBackupStatus')).code, 200);
  clock = readyAt + DAY - 1000;
  const downloaded = await invoke(backup, '/api/backup', 'photoBackupDownload', {
    method: 'POST', body: { requestId, index: 0 },
  });
  assert.equal(downloaded.code, 200);
  assert.equal(downloaded.body.expiresIn, 1);
  assert.equal(r2Calls.filter(call => call.name === 'generateDownloadUrl').length, 1);
  clock = readyAt + DAY;
  assert.equal((await invoke(backup, '/api/backup', 'photoBackupDownload', {
    method: 'POST', body: { requestId, index: 0 },
  })).code, 401);
  assert.equal(r2Calls.filter(call => call.name === 'generateDownloadUrl').length, 1);
  role = 'clinic_user'; clock = readyAt;
  assert.equal((await invoke(backup, '/api/backup', 'photoBackupStatus')).code, 401);
});
