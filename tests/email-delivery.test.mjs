import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { readFile } from 'node:fs/promises';

// Only external I/O is replaced. MIME is produced by the installed Nodemailer,
// using its real stream transport. No env files, databases or email servers.
const clinicId = '11111111-2222-4333-8444-555555555555';
let auth = { valid: true, id: 42, role: 'clinic_user', clinic_id: clinicId };
let connected = true;
const sent = [];
const queries = [];
const fromName = 'Estética Biológica, "Cuenca" <b>equipo</b>';
const url = path => new URL(path, import.meta.url).href;
mock.module(url('../lib/admin-auth.js'), { namedExports: { authenticateRequest: async () => auth } });
mock.module(url('../api/admin-auth.js'), { namedExports: { sendDeveloperAlert: async () => {} } });
mock.module(url('../lib/neon-clinical-db.js'), { namedExports: { getPool: () => { throw new Error('Unexpected database access'); } } });
mock.module(url('../lib/subscription-lifecycle.js'), { namedExports: { requireSubscriptionOperation: async () => {} } });
mock.module(url('../lib/whatsapp-service.js'), { namedExports: {
  sendWhatsAppText: () => { throw new Error('Unexpected WhatsApp send'); },
  sendWhatsAppTemplate: () => { throw new Error('Unexpected WhatsApp send'); },
} });
mock.module(url('../lib/whatsapp-crm.js'), { namedExports: {
  isWithinCustomerServiceWindow: async () => false,
  isSystemStaffPhone: () => false,
  ensureWhatsAppContactClinic: async () => {},
} });
mock.module('googleapis', { namedExports: { google: {
  auth: { OAuth2: class {
    setCredentials() {}
    on() {}
  } },
  gmail: () => ({ users: { messages: { send: async payload => {
    assert.equal(payload.userId, 'me');
    assert.equal(typeof payload.requestBody.raw, 'string', 'must await MIME composition');
    sent.push(Buffer.from(payload.requestBody.raw, 'base64url').toString('utf8'));
  } } } }),
  calendar: () => { throw new Error('Calendar is outside the email regression scope'); },
} } });
mock.module('@vercel/postgres', { namedExports: { sql: async (strings, ...params) => {
  const query = strings.join('?');
  queries.push({ query, params });
  if (query.includes('FROM clinic_users')) {
    assert.deepEqual(params, [42]);
    return { rows: [{ full_name: 'Dra. Ficticia', gentilicio: 'Dra.' }] };
  }
  if (query.includes('FROM clinic_settings')) {
    assert.deepEqual(params, [clinicId], 'request body cannot select a different tenant');
    return { rows: [{
      general: { name: 'Estética Biológica' },
      email: { from_name: fromName, staff_email: 'staff@example.test' },
    }] };
  }
  if (query.includes('FROM clinic_oauth_tokens')) {
    assert.deepEqual(params, [42], 'only authenticated user mailbox');
    return { rows: connected ? [{ email: 'connected@example.test', access_token: 'fake-test-token' }] : [] };
  }
  throw new Error(`Unexpected SQL in email-only test: ${query}`);
} } });

Object.assign(process.env, { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
const { default: handler } = await import('../api/sendEmail.js');
const response = () => ({ code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const request = () => ({
  method: 'POST', headers: {},
  body: {
    clinicId: 'other-tenant-must-be-ignored', name: 'José <script>bad()</script>', email: 'patient@example.test',
    message: 'Servicio: Sesión estética\nFecha: 4 de noviembre\nHora: 10:00', service: 'Sesión estética',
    selected_staff_email: 'doctor@example.test', selected_staff_name: 'Dra. Ana <b>ficticia</b>',
    additional_notify_emails: ['copy@example.test', 'staff@example.test', 'doctor@example.test'],
  },
});

function decodedBody(wire) {
  const body = wire.slice(wire.indexOf('\r\n\r\n') + 4);
  return Buffer.from(body.replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
}

test('authenticated email flow composes staff, doctor, CC and patient MIME locally', async () => {
  sent.length = 0;
  const res = response();
  await handler(request(), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.details.email, true);
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map(wire => wire.match(/^To: (.+)$/m)[1].trim()),
    ['staff@example.test', 'doctor@example.test', 'copy@example.test', 'patient@example.test']);
  for (const wire of sent) {
    const headers = wire.slice(0, wire.indexOf('\r\n\r\n'));
    assert.match(headers, /From: =\?UTF-8\?/);
    assert.match(headers, /<connected@example\.test>/);
    assert.doesNotMatch(headers, /[^\x00-\x7f]/);
    const body = decodedBody(wire);
    assert.match(body, /José &lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(body, /<script>|<b>equipo<\/b>|<b>ficticia<\/b>/);
    assert.match(body, /BIOSKINTECH · GESTIÓN CLÍNICA/);
    assert.doesNotMatch(body, /Ã|Â|�/);
  }
  assert.match(decodedBody(sent[0]), /Hola Estética Biológica, &quot;Cuenca&quot; &lt;b&gt;equipo&lt;\/b&gt;/);
  assert.match(decodedBody(sent[1]), /Hola Dra\. Ana &lt;b&gt;ficticia&lt;\/b&gt; — has sido asignado/);
});

test('unauthenticated requests neither query data nor compose/send messages', async () => {
  auth = { valid: false };
  queries.length = 0;
  sent.length = 0;
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 401);
    assert.equal(queries.length, 0);
    assert.equal(sent.length, 0);
  } finally {
    auth = { valid: true, id: 42, role: 'clinic_user', clinic_id: clinicId };
  }
});

test('missing user OAuth cannot fall back to another mailbox', async () => {
  connected = false;
  sent.length = 0;
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 500);
    assert.equal(res.body.success, false);
    assert.equal(sent.length, 0);
  } finally {
    connected = true;
  }
});

test('finance and chatbot Gmail call sites await shared MIME and preserve scoped senders', async () => {
  for (const path of ['../api/records.js', '../api/whatsapp-chatbot.js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /await buildGmailRaw\(/);
    assert.match(source, /from: \{ name: clinicName, address: oauth.email \}/);
    assert.match(source, /contentType: 'text\/csv; charset=utf-8'/);
    assert.doesNotMatch(source, /`From: \$\{from/);
    assert.doesNotMatch(source, /function buildRawEmailWithCsvAttachment/);
  }
});

test('all discovered Gmail raw producers use the shared composer or encoded consent MIME', async () => {
  for (const path of ['../api/sendEmail.js', '../api/public-booking.js', '../api/records.js', '../api/whatsapp-chatbot.js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /import \{ buildGmailRaw \} from '\.\.\/lib\/email-mime\.js'/);
    assert.match(source, /gmail\.users\.messages\.send/);
    assert.doesNotMatch(source, /MIME-Version:|`From:/, `${path} must not assemble unencoded MIME headers`);
    assert.doesNotMatch(source, /function buildRawEmail/);
  }
  const consent = await readFile(new URL('../lib/consent-signing.js', import.meta.url), 'utf8');
  assert.match(consent, /fromHeader = `\$\{encodeMimeHeader\(fromName \|\| 'BIOSKIN'\)\} <\$\{fromEmail\}>`/);
  assert.match(consent, /`Subject: \$\{encodeMimeHeader\(subject\)\}`/);
});
