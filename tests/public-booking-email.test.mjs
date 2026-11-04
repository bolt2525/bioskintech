import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Real handler + real Nodemailer stream MIME; every external service is local.
const clinicId = '11111111-2222-4333-8444-555555555555';
const clinicName = 'Estética Biológica, "Cuenca" <b>equipo</b>';
const patientName = 'José <script>bad()</script>';
const professionalName = 'Dra. María <b>ficticia</b>';
const service = 'Sesión estética <em>facial</em>';
const mailbox = 'professional@example.test';
const sent = [];
const insertedEvents = [];
const queries = [];
let connected = true;
let turnstileOk = true;
let gmailError = null;
let ipSequence = 0;
const url = path => new URL(path, import.meta.url).href;
const fakePool = {};

mock.module(url('../lib/neon-clinical-db.js'), { namedExports: { getPool: () => fakePool } });
mock.module(url('../lib/subscription-lifecycle.js'), { namedExports: {
  loadSubscriptionLifecycle: async (pool, id) => {
    assert.equal(pool, fakePool);
    assert.equal(id, clinicId);
    return { canoperate: true };
  },
} });
mock.module(url('../lib/turnstile.js'), { namedExports: {
  getTurnstileAllowedHosts: () => ['example.test'],
  verifyTurnstileToken: async (_req, token) => {
    assert.equal(token, 'fictitious-turnstile-token');
    return turnstileOk ? { ok: true } : { ok: false, status: 403, error: 'Test anti-bot rejection' };
  },
} });
mock.module('@vercel/postgres', { namedExports: { sql: async (strings, ...params) => {
  const query = strings.join('?');
  queries.push({ query, params });
  if (query.includes('FROM clinic_users')) {
    assert.deepEqual(params, ['test-clinic', 'dra-test'], 'professional resolved from public link, not body clinicId');
    return { rows: [{
      id: 42, clinic_id: clinicId, full_name: professionalName, username: 'dra-test',
      public_booking_enabled: true, multi_resource_enabled: false,
      clinic_name: clinicName, clinic_slug: 'test-clinic',
    }] };
  }
  if (query.includes('FROM clinic_settings')) {
    assert.deepEqual(params, [clinicId]);
    return { rows: [{ treatments: [service], agenda: { treatment_durations: { [service]: 60 } } }] };
  }
  if (query.includes('FROM clinic_oauth_tokens')) {
    assert.deepEqual(params, [42], 'only linked professional mailbox');
    return { rows: connected ? [{ email: mailbox, access_token: 'fictitious-access-token' }] : [] };
  }
  throw new Error(`Unexpected SQL in local email test: ${query}`);
} } });
mock.module('googleapis', { namedExports: { google: {
  auth: { OAuth2: class {
    setCredentials() {}
    on() {}
  } },
  calendar: () => ({ events: {
    list: async () => ({ data: { items: [] } }),
    insert: async event => { insertedEvents.push(event); return { data: { id: 'fake-event' } }; },
  } }),
  gmail: () => ({ users: { messages: { send: async payload => {
    assert.equal(payload.userId, 'me');
    assert.equal(typeof payload.requestBody.raw, 'string', 'public handler must await real MIME composition');
    sent.push(Buffer.from(payload.requestBody.raw, 'base64url').toString('utf8'));
    if (gmailError) throw gmailError;
    return { data: { id: 'fake-message' } };
  } } } }),
} } });

Object.assign(process.env, { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
const { default: handler } = await import('../api/public-booking.js');
const response = () => ({ code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const request = () => ({
  method: 'POST', headers: { 'x-forwarded-for': `192.0.2.${++ipSequence}` },
  body: {
    clinicSlug: 'test-clinic', username: 'dra-test',
    clinicId: 'untrusted-tenant', from: 'untrusted@example.test',
    name: patientName, email: 'patient@example.test', phone: '0999999999', service,
    date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), time: '10:00',
    privacy_accepted: true, turnstileToken: 'fictitious-turnstile-token',
  },
});

function decodeQuotedPrintable(value) {
  return Buffer.from(value.replace(/=\r\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
}

function decodeHeader(value) {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, encoding, data) =>
      encoding.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8')
        : decodeQuotedPrintable(data.replace(/_/g, ' ')));
}

function parseMessage(wire) {
  const split = wire.indexOf('\r\n\r\n');
  assert.ok(split >= 0);
  const headerBlock = wire.slice(0, split);
  const headers = Object.fromEntries(headerBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n').map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  const body = wire.slice(split + 4);
  return {
    headerBlock, headers,
    html: headers['content-transfer-encoding'] === 'base64' ? Buffer.from(body, 'base64').toString('utf8') : decodeQuotedPrintable(body),
  };
}

test('public patient and clinic emails preserve accented sender, subjects and escaped HTML', async () => {
  sent.length = insertedEvents.length = queries.length = 0;
  const res = response();
  await handler(request(), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.message, 'Cita agendada correctamente.');
  assert.equal(insertedEvents.length, 1, 'calendar I/O is only a local fake');
  assert.equal(sent.length, 2);
  const messages = sent.map(parseMessage);
  assert.deepEqual(messages.map(message => message.headers.to).sort(), ['patient@example.test', mailbox].sort());
  for (const message of messages) {
    assert.equal(decodeHeader(message.headers.from), `${clinicName} <${mailbox}>`);
    assert.doesNotMatch(message.headerBlock, /[^\x00-\x7f]/);
    assert.match(message.headers['content-type'], /text\/html; charset=utf-8/i);
    assert.match(message.html, /Estética Biológica, &quot;Cuenca&quot; &lt;b&gt;equipo&lt;\/b&gt;/);
    assert.match(message.html, /José &lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.match(message.html, /Dra\. María &lt;b&gt;ficticia&lt;\/b&gt;/);
    assert.match(message.html, /Sesión estética &lt;em&gt;facial&lt;\/em&gt;/);
    assert.match(message.html, /BIOSKINTECH · GESTIÓN CLÍNICA/);
    assert.doesNotMatch(message.html, /<script>|<b>equipo<\/b>|<em>facial<\/em>|Ã|Â|�/);
    assert.doesNotMatch(message.headers.from, /untrusted/);
  }
  assert.equal(decodeHeader(messages.find(message => message.headers.to === 'patient@example.test').headers.subject),
    `Confirmación de cita en ${clinicName}`);
  assert.equal(decodeHeader(messages.find(message => message.headers.to === mailbox).headers.subject),
    `Nueva cita pública: ${patientName} - ${service}`);
});

test('public emails are not composed/sent without the linked professional OAuth mailbox', async () => {
  connected = false;
  sent.length = insertedEvents.length = 0;
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 503);
    assert.equal(sent.length, 0);
    assert.equal(insertedEvents.length, 0);
  } finally {
    connected = true;
  }
});

test('anti-bot rejection does not query data or compose/send public emails', async () => {
  turnstileOk = false;
  sent.length = insertedEvents.length = queries.length = 0;
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 403);
    assert.equal(queries.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(insertedEvents.length, 0);
  } finally {
    turnstileOk = true;
  }
});

test('public email delivery failure preserves existing partial-success response', async () => {
  sent.length = insertedEvents.length = 0;
  gmailError = new Error('Fictitious Gmail failure');
  try {
    const res = response();
    await handler(request(), res);
    // Promise.all may reject before the other local MIME stream has settled.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.message, /no se pudo enviar el correo/);
    assert.equal(insertedEvents.length, 1);
    assert.equal(sent.length, 2);
  } finally {
    gmailError = null;
  }
});
