import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createHmac } from 'node:crypto';
import { identityLockHeld, identityReaderCount, releaseTestIdentities } from './whatsapp-identity-lock.fixture.mjs';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PHONE = '593999000111';
const RELEASE = '2026-10-23T12:00:00.000Z';
const AFTER = '2026-10-23T12:00:01.000Z';
const BEFORE = '2026-10-23T11:59:59.000Z';
let data;
let calls;
let sent;
let failMessage;
let onFetch;
let snapshot;
const result = rows => ({ rows, rowCount: rows.length });
const active = contact => contact && !contact.retired_at;
const byMessage = message => data.contacts.find(contact => contact.id === message.contact_id);

// Stateful SQL boundary double: production WA functions execute unchanged.
// SQL shape assertions make an omitted retirement/tenant predicate fail the tests.
async function query(text, values = []) {
  calls.push({ text, values, locked: identityLockHeld() });
  if (text === 'BEGIN') { snapshot = structuredClone(data); return result([]); }
  if (text === 'ROLLBACK') { if (snapshot) data = snapshot; snapshot = null; return result([]); }
  if (text === 'COMMIT') { snapshot = null; return result([]); }
  if (/^(ALTER TABLE|SET LOCAL)|pg_advisory_/.test(text)) return result([]);
  if (text.includes('FROM clinic_identity_history')) {
    assert.match(text, /jsonb_array_elements/);
    assert.match(text, /whatsapp_staff_phone/);
    const releases = data.history.filter(history =>
      [history.clinic_aliases, ...history.user_aliases, ...(history.clinic_aliases.whatsapp_aliases || [])].some(alias =>
        [alias.phone, alias.whatsapp_staff_phone].some(phone => crm.normalizeEcuadorPhone(phone) === values[0])))
      .map(history => history.released_at).sort();
    return result([{ released_at: releases.at(-1) || null }]);
  }
  if (text.includes('FROM clinics c')) {
    return result([{ is_active: data.operational[values[0]] === true, general: {} }]);
  }
  if (text.includes('AS contact_clinic_id')) {
    const message = data.messages.find(message => message.provider_message_id === values[0]);
    const contact = message && byMessage(message);
    const owner = message && data.users.find(user => user.id === message.booked_by_user_id);
    return result(contact ? [{ contact_clinic_id: contact.clinic_id, retired_at: contact.retired_at,
      owner_clinic_id: owner?.clinic_id, booked_by_user_id: message.booked_by_user_id }] : []);
  }
  if (text.includes('SELECT clinic_id FROM clinic_users WHERE id=')) {
    return result(data.users.filter(user => user.id === values[0] && user.is_active));
  }
  if (text.includes('SELECT id FROM whatsapp_messages WHERE provider_message_id=')) {
    return result(data.messages.filter(message => message.provider_message_id === values[0]));
  }
  if (text.includes('INSERT INTO whatsapp_contacts')) {
    assert.ok(identityLockHeld());
    assert.match(text, /ON CONFLICT \(phone\) WHERE retired_at IS NULL/);
    assert.match(text, /whatsapp_contacts\.clinic_id = EXCLUDED\.clinic_id/);
    const isAudit = text.includes('(phone, name, clinic_id, last_message_at)');
    const [phone] = values;
    const clinicId = values[isAudit ? 2 : 1];
    let contact = data.contacts.find(contact => active(contact) && contact.phone === phone);
    if (contact && clinicId && contact.clinic_id !== clinicId) {
      if (contact.clinic_id || data.messages.some(message => message.contact_id === contact.id)) return result([]);
    }
    if (!contact) {
      contact = { id: Math.max(0, ...data.contacts.map(contact => contact.id)) + 1,
        phone, clinic_id: clinicId, name: isAudit ? values[1] : null, retired_at: null };
      data.contacts.push(contact);
    } else {
      contact.clinic_id ||= clinicId;
      if (isAudit) contact.name = values[1] || contact.name;
    }
    return result([contact]);
  }
  if (text.includes('INSERT INTO whatsapp_messages')) {
    assert.ok(identityLockHeld());
    if (failMessage) throw new Error('simulated insert failure');
    const [contact_id, direction, content, media_type, occurred_at, status, provider_message_id,
      error_detail, booked_by_user_id] = values;
    const message = { id: data.messages.length + 1, contact_id, direction, content, media_type,
      occurred_at, status, provider_message_id, error_detail, booked_by_user_id, read_notified: false };
    data.messages.push(message);
    return result([message]);
  }
  if (text.includes('SET read_notified = true')) {
    assert.match(text, /c\.retired_at IS NULL/);
    const message = data.messages.find(message => message.id === values[0] && !message.read_notified && active(byMessage(message)));
    if (message) message.read_notified = true;
    return result(message ? [message] : []);
  }
  if (text.includes('UPDATE whatsapp_messages')) {
    assert.ok(identityLockHeld());
    assert.match(text, /c\.retired_at IS NULL/);
    if (text.includes('WHERE m.provider_message_id')) {
      const message = data.messages.find(message => message.provider_message_id === values.at(-1) && active(byMessage(message)));
      if (message) message.status = values[0];
      return result(message ? [message] : []);
    }
    if (text.includes('provider_message_id = COALESCE')) {
      const message = data.messages.find(message => message.id === values[3] && active(byMessage(message)));
      assert.match(text, /COALESCE\(provider_message_id, /);
      if (message) Object.assign(message, { status: values[0], provider_message_id: message.provider_message_id || values[1] });
      return result(message ? [message] : []);
    }
    return result([]);
  }
  if (text.includes('UPDATE whatsapp_contacts c SET clinic_id=')) {
    assert.match(text, /c\.retired_at IS NULL/);
    assert.match(text, /NOT EXISTS/);
    const contact = data.contacts.find(contact => contact.id === values[1] && active(contact));
    if (!contact || (contact.clinic_id !== values[0] && (contact.clinic_id ||
        data.messages.some(message => message.contact_id === contact.id)))) return result([]);
    contact.clinic_id = values[0];
    return result([contact]);
  }
  if (text.includes('whatsapp_bot_state')) {
    assert.match(text, /retired_at IS NULL/);
    const state = data.states.find(state => !state.retired_at && state.phone === values[0]);
    if (text.includes('SELECT flow')) return result(state ? [state] : []);
    assert.ok(identityLockHeld());
    if (text.includes('INSERT')) {
      assert.match(text, /ON CONFLICT \(phone\) WHERE retired_at IS NULL/);
      if (state) Object.assign(state, { flow: values[1], data: JSON.parse(values[2]) });
      else data.states.push({ id: data.states.length + 1, phone: values[0], flow: values[1], data: JSON.parse(values[2]), retired_at: null });
    } else data.states = data.states.filter(row => row !== state);
    return result([]);
  }
  if (text.includes('INSERT INTO wa_short_links')) {
    assert.ok(identityLockHeld());
    data.links.push({ code: values[0], target_url: values[1], created_at: AFTER, retired_at: null });
    return result([]);
  }
  if (text.includes('FROM wa_short_links')) {
    assert.match(text, /retired_at IS NULL/);
    return result(data.links.filter(link => !link.retired_at &&
      (link.code === values[0] || link.code.replaceAll('_', '') === values[0])));
  }
  if (text.includes('SELECT DISTINCT COALESCE')) {
    assert.match(text, /c\.retired_at IS NULL/);
    return result(data.origins);
  }
  if (text.includes('UNION SELECT cu.clinic_id')) {
    assert.match(text, /retired_at IS NULL/);
    assert.ok(identityLockHeld());
    return result(data.users.filter(user => user.is_active &&
      crm.normalizeEcuadorPhone(user.phone) === values[0]).map(user => ({ clinic_id: user.clinic_id })));
  }
  if (text.trimStart().startsWith('SELECT cu.id, cu.clinic_id')) return result(data.users.filter(user => user.is_active));
  if (text.includes('FROM whatsapp_contacts') || text.includes('FROM whatsapp_messages')) {
    assert.match(text, /(?:c\.)?retired_at IS NULL/);
    const contacts = data.contacts.filter(active);
    const messages = data.messages.filter(message => active(byMessage(message)));
    if (text.includes('SELECT id, phone, name FROM whatsapp_contacts'))
      return result(contacts.filter(contact => contact.id === values[0]));
    if (text.includes('SELECT c.id, c.phone')) return result(contacts);
    if (text.includes('SELECT * FROM (')) return result(messages.filter(message => message.contact_id === values[0]));
    if (text.includes("m.direction = 'entrante'")) return result(messages.filter(message =>
      message.direction === 'entrante' && byMessage(message).phone === values[0]));
    return result([]);
  }
  assert.fail(`Unexpected offline query: ${text}`);
}

const sql = (parts, ...values) => query(parts.reduce((text, part, index) =>
  text + part + (index < values.length ? `$${index + 1}` : ''), ''), values);
sql.query = query;
const pool = { query, connect: async () => ({ query, release() {} }) };
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module(new URL('../lib/neon-clinical-db.js', import.meta.url).href, { namedExports: { getPool: () => pool } });
const crm = await import('../lib/whatsapp-crm.js');
const state = await import('../lib/whatsapp-bot-state.js');
const service = await import('../lib/whatsapp-service.js');
const links = await import('../lib/wa-short-link.js');
const { resolveOperationalWaLink, latestWaIdentityRelease } = await import('../lib/wa-link-resolver.js');
const bot = await import('../api/whatsapp-chatbot.js');

test.beforeEach(t => {
  calls = [];
  sent = [];
  failMessage = false;
  onFetch = null;
  snapshot = null;
  data = {
    operational: { [OLD]: false, [NEW]: true },
    contacts: [{ id: 1, phone: PHONE, name: 'Old identity', clinic_id: OLD, retired_at: RELEASE }],
    messages: [{ id: 1, contact_id: 1, direction: 'entrante', content: 'Old conversation', status: 'enviado',
      booked_by_user_id: 7, provider_message_id: 'wamid.old', read_notified: false }],
    states: [{ id: 1, phone: PHONE, flow: 'booking', data: { patientName: 'Old private name' }, retired_at: RELEASE }],
    users: [{ id: 7, clinic_id: OLD, phone: null, is_active: false },
      { id: 8, clinic_id: NEW, phone: '0999000111', is_active: true, full_name: 'New identity', whatsapp_bot_enabled: true }],
    history: [{ clinic_id: OLD, released_at: RELEASE, clinic_aliases: { phone: null },
      user_aliases: [{ id: 7, clinic_id: OLD, phone: '0999000111', whatsapp_staff_phone: null }] }],
    links: [], origins: [{ clinic_id: NEW }],
  };
  Object.assign(process.env, { WHATSAPP_TOKEN: 'offline-test-token', WHATSAPP_PHONE_NUMBER_ID: '111111111',
    WHATSAPP_APP_SECRET: 'offline-test-secret', WHATSAPP_SYSTEM_STAFF_PHONES: '' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/graph\.facebook\.com\//);
    assert.ok(identityLockHeld(), 'lock retained through Meta dispatch');
    sent.push(JSON.parse(options.body));
    if (onFetch) await onFetch();
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.new.${sent.length}` }] }) };
  });
});

const inbound = (timestamp = AFTER, id = 'wamid.inbound', type = 'reaction') => ({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111111111' },
    messages: [{ id, from: '0999000111', timestamp: timestamp == null ? undefined : String(Date.parse(timestamp) / 1000),
      type, text: { body: 'menu' }, reaction: { emoji: '👍' } }] } }] }],
});

test('Ecuador canonicalization matches live contacts and retained aliases, including international prefix', async () => {
  for (const phone of ['0999000111', '+593 999 000 111', '999000111', '00593999000111']) {
    assert.equal(crm.normalizeCrmPhone(phone), PHONE);
    assert.equal(await latestWaIdentityRelease(pool, phone), RELEASE);
  }
  assert.equal(crm.normalizeCrmPhone('bad'), '');
  data.history.push({ released_at: AFTER, clinic_aliases: { phone: '00593999000111' }, user_aliases: [] });
  assert.equal(await latestWaIdentityRelease(pool, PHONE), AFTER);
  assert.equal(await crm.isCurrentWhatsAppInbound(PHONE, AFTER), false);
});

test('retired state is neither readable nor removed; partial upsert creates a separate active state', async () => {
  const old = structuredClone(data.states[0]);
  assert.equal(await state.getBotState('0999000111'), null);
  await state.clearBotState('999000111');
  assert.deepEqual(data.states, [old]);
  await state.setBotState('+593 999 000 111', 'agendaMenu', { stage: 'fresh' });
  assert.deepEqual(await state.getBotState('00593999000111'), { flow: 'agendaMenu', stage: 'fresh' });
  await state.clearBotState(PHONE);
  assert.deepEqual(data.states, [old]);
});

test('CRM readers and service window cannot see retired conversation evidence', async () => {
  assert.equal(await crm.getContactById(1), null);
  assert.deepEqual(await crm.listWhatsAppMessages(1), []);
  assert.deepEqual(await crm.listWhatsAppContacts(), []);
  assert.equal(await crm.isWithinCustomerServiceWindow(PHONE), false);
  assert.equal(await crm.getRecentAppointmentNotificationContext(PHONE), null);
  assert.equal(await crm.getPendingAppointmentReplyContext(PHONE), null);
  assert.equal(await crm.hasRecentAppointmentSystemReply(PHONE), false);
  assert.deepEqual(await crm.getAppointmentReplyStatuses(['old-event'], 7), {});
  assert.deepEqual(await crm.getAppointmentDeliveryStatuses(['old-event'], 7), {});
});

test('new message and contact share one transaction without changing old contact or provider binding', async () => {
  const oldContact = structuredClone(data.contacts[0]);
  const oldMessage = structuredClone(data.messages[0]);
  await crm.recordWhatsAppMessage({ phone: '0999000111', clinicId: NEW, bookedByUserId: 8,
    direction: 'saliente', status: 'enviado', content: 'New conversation' });
  assert.equal(data.contacts.length, 2);
  assert.equal(data.messages.at(-1).contact_id, 2);
  assert.deepEqual(data.contacts[0], oldContact);
  assert.deepEqual(data.messages[0], oldMessage);
  const txCalls = calls.map(call => call.text);
  assert.ok(txCalls.indexOf('BEGIN') < txCalls.findIndex(text => text.includes('INSERT INTO whatsapp_contacts')));
  assert.ok(txCalls.findIndex(text => text.includes('INSERT INTO whatsapp_messages')) < txCalls.indexOf('COMMIT'));
  const replay = await crm.recordWhatsAppMessage({ phone: PHONE, direction: 'entrante', timestamp: AFTER,
    status: 'leido', providerMessageId: 'wamid.old' });
  assert.equal(replay.rows.length, 0);
  assert.equal(data.messages[0].contact_id, 1);
});

test('message insertion failure rolls back its contact; tenant conflicts and reattribution fail closed', async () => {
  failMessage = true;
  await assert.rejects(crm.recordWhatsAppMessage({ phone: PHONE, clinicId: NEW,
    direction: 'saliente', status: 'enviado' }), /simulated insert failure/);
  assert.equal(data.contacts.length, 1);
  assert.ok(calls.some(call => call.text === 'ROLLBACK'));
  failMessage = false;
  data.contacts.push({ id: 2, phone: PHONE, clinic_id: OLD, retired_at: null });
  const before = structuredClone(data);
  await assert.rejects(crm.ensureWhatsAppContactClinic(PHONE, NEW), /otra clínica/);
  await assert.rejects(crm.recordWhatsAppMessage({ phone: PHONE, clinicId: NEW,
    direction: 'saliente', status: 'enviado' }), /otra clínica/);
  await assert.rejects(crm.setWhatsAppContactClinic(2, NEW), /atribución bloqueada/);
  await assert.rejects(crm.setWhatsAppContactClinic(1, NEW), /atribución bloqueada/);
  assert.deepEqual(data, before);
});

test('outgoing old clinic or wrong booking owner cannot reach Meta; new identity can send', async () => {
  await assert.rejects(service.sendWhatsAppText(PHONE, 'Old private body', { clinicId: OLD }), /suscripción/);
  await assert.rejects(service.sendWhatsAppTemplate(PHONE, 'old', 'es', {}, { clinicId: NEW, bookedByUserId: 7 }), /identidad/);
  assert.equal(sent.length, 0);
  await service.sendWhatsAppText('0999000111', 'Fresh body', { clinicId: NEW, bookedByUserId: 8 });
  await service.sendWhatsAppTemplate(PHONE, 'fresh', 'es', {}, { clinicId: NEW });
  assert.equal(sent.length, 2);
  assert.ok(sent.every(message => message.to === PHONE));
  assert.ok(data.messages.slice(1).every(message => message.contact_id === 2));
  assert.ok(calls.filter(call => call.text.includes('UPDATE whatsapp_messages')).every(call => call.locked));
});

test('an outgoing provider ID is write-once and retired audit rows cannot be updated', async () => {
  await crm.recordWhatsAppMessage({ phone: PHONE, clinicId: NEW, direction: 'saliente', status: 'enviado',
    providerMessageId: 'wamid.bound' });
  assert.equal(await crm.updateOutgoingWhatsAppMessage(2, { status: 'leido', providerMessageId: 'wamid.replacement' }), true);
  assert.equal(data.messages[1].provider_message_id, 'wamid.bound');
  assert.equal(await crm.updateOutgoingWhatsAppMessage(1, { status: 'fallido', providerMessageId: 'wamid.replacement' }), false);
  assert.equal(data.messages[0].provider_message_id, 'wamid.old');
});

test('transport failure marks the original active audit failed before releasing the identity lock', async () => {
  onFetch = async () => { throw new Error('offline simulated transport failure'); };
  await assert.rejects(service.sendWhatsAppText(PHONE, 'Not delivered', { clinicId: NEW }), /simulated transport failure/);
  assert.equal(data.messages.at(-1).status, 'fallido');
  assert.equal(data.messages.at(-1).contact_id, 2);
  assert.ok(calls.filter(call => call.text.includes('UPDATE whatsapp_messages')).every(call => call.locked));
  assert.equal(identityReaderCount(), 0);
});

test('Meta dispatch and audit retain one reentrant lock; release waits until both finish', async () => {
  const order = [];
  let release;
  onFetch = async () => {
    assert.equal(identityReaderCount(), 1, 'send -> CRM reuses the same identity session');
    release = releaseTestIdentities(() => {
      assert.ok(data.messages.at(-1).provider_message_id.startsWith('wamid.new.'), 'provider audit finished before release');
      order.push('release');
      data.operational[NEW] = false;
      data.contacts.filter(active).forEach(contact => { contact.retired_at = AFTER; });
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, []);
  };
  await service.sendWhatsAppText(PHONE, 'In-flight', { clinicId: NEW });
  await release;
  assert.deepEqual(order, ['release']);
  await assert.rejects(service.sendWhatsAppText(PHONE, 'Stale local dispatch', { clinicId: NEW }), /suscripción/);
  assert.equal(sent.length, 1);
  assert.ok(data.messages.at(-1).provider_message_id.startsWith('wamid.new.'));
});

test('callback on original retired contact never updates, claims or notifies the new identity', async () => {
  await crm.ensureWhatsAppContactClinic(PHONE, NEW);
  const before = structuredClone(data.messages[0]);
  const notifications = [];
  const status = await bot.processWhatsAppDeliveryStatus({ providerMessageId: 'wamid.old', status: 'fallido' }, {
    pool, notify: async event => notifications.push(event),
  });
  assert.deepEqual(status, { blocked: true });
  assert.deepEqual(data.messages[0], before);
  assert.equal(notifications.length, 0);
  assert.equal(sent.length, 0);
  assert.ok(!calls.some(call => call.text.includes('SET read_notified')));
  assert.ok(!calls.some(call => call.text.includes('WHERE phone')));
});

test('active callback uses provider ID evidence, not the phone, and only notifies its original owner once', async () => {
  await crm.recordWhatsAppMessage({ phone: PHONE, clinicId: NEW, bookedByUserId: 8,
    direction: 'saliente', status: 'enviado', providerMessageId: 'wamid.current' });
  const notifications = [];
  const options = { pool, notify: async event => {
    assert.ok(identityLockHeld());
    notifications.push(event);
  } };
  assert.deepEqual(await bot.processWhatsAppDeliveryStatus({ providerMessageId: 'wamid.current', status: 'fallido' }, options), { blocked: false });
  await bot.processWhatsAppDeliveryStatus({ providerMessageId: 'wamid.current', status: 'fallido' }, options);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].bookedByUserId, 8);
  assert.equal(notifications[0].contactId, 2);
});

test('pre-release, equal-release, missing and invalid inbound time are dropped before any phone reader/writer', async () => {
  for (const time of [BEFORE, RELEASE, null, 'bad-date']) await bot.handleIncomingMessages(inbound(time));
  assert.equal(data.messages.length, 1);
  assert.equal(data.contacts.length, 1);
  assert.equal(sent.length, 0);
  assert.ok(calls.every(call => call.text.includes('FROM clinic_identity_history')));
  const dropped = await crm.recordWhatsAppMessage({ phone: PHONE, direction: 'entrante', timestamp: RELEASE, status: 'leido' });
  assert.equal(dropped.rows.length, 0);
});

test('contact-only release barrier survives deleted old contacts and blocks delayed old inbound', async () => {
  data.history = [{ released_at: RELEASE, clinic_aliases: { whatsapp_aliases: [{ phone: PHONE }] }, user_aliases: [] }];
  data.contacts = [];
  data.messages = [];
  assert.equal(await crm.isCurrentWhatsAppInbound(PHONE, BEFORE), false);
  assert.equal(await crm.isCurrentWhatsAppInbound(PHONE, RELEASE), false);
  assert.equal(await crm.isCurrentWhatsAppInbound(PHONE, AFTER), true);
});

test('new inbound staff flow uses new identity and never revives retired state or old conversation', async () => {
  await bot.handleIncomingMessages(inbound(AFTER, 'wamid.new.menu', 'text'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text.body, /New identity/);
  assert.doesNotMatch(sent[0].text.body, /Old private name|Old conversation/);
  assert.equal(data.contacts.length, 2);
  assert.equal(data.contacts[1].clinic_id, NEW, 'attribute only the fresh contact, not prior conversation');
  assert.ok(data.messages.slice(1).every(message => message.contact_id === 2));
  assert.equal(data.states.length, 1);
  assert.equal(data.states[0].retired_at, RELEASE);
  assert.ok(calls.filter(call => !call.text.startsWith('ALTER TABLE')).every(call => call.locked));
});

test('ambiguous live phone ownership cannot merge or dispatch to either tenant', async () => {
  data.users.push({ id: 9, clinic_id: OLD, phone: PHONE, is_active: true });
  data.operational[OLD] = true;
  await bot.handleIncomingMessages(inbound(AFTER, 'wamid.ambiguous', 'text'));
  assert.equal(data.contacts.length, 1);
  assert.equal(data.messages.length, 1);
  assert.equal(sent.length, 0);
});

test('signed webhook holds identity lock across channel lifecycle, inbound dispatch and audit', async () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', ...inbound(AFTER, 'wamid.signed', 'text') }));
  const req = { method: 'POST', query: {}, headers: {
    'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(body).digest('hex')}`,
  }, async *[Symbol.asyncIterator]() { yield body; } };
  const res = { code: 0, status(code) { this.code = code; return this; }, json() { return this; }, send() { return this; } };
  await bot.default(req, res);
  assert.equal(res.code, 200);
  assert.equal(sent.length, 1);
  assert.ok(calls.every(call => call.locked));
});

test('retired and pre-release links fail; only a new target and operational scoped clinic resolve', async () => {
  const target = `https://wa.me/${PHONE}?text=Private`;
  for (const [suffix, created_at, retired_at] of [
    ['a', BEFORE, null], ['b', RELEASE, null], ['c', AFTER, RELEASE], ['d', AFTER, null],
  ]) data.links.push({ code: `${NEW}.${suffix.repeat(22)}`, target_url: target, created_at, retired_at });
  for (const letter of ['a', 'b', 'c'])
    assert.equal(await resolveOperationalWaLink(`${NEW}.${letter.repeat(22)}`, pool), null);
  assert.equal(await resolveOperationalWaLink(`${NEW}.${'d'.repeat(22)}`, pool), target);
  data.operational[NEW] = false;
  assert.equal(await resolveOperationalWaLink(`${NEW}.${'d'.repeat(22)}`, pool), null);
  await assert.rejects(links.createShortWaLink(PHONE, 'Old private body', NEW), /enlaces operativos/);
  data.operational[NEW] = true;
  const url = await links.createShortWaLink('00593999000111', 'Fresh message', NEW);
  assert.equal(await links.resolveShortWaLink(url.split('/r/')[1]), `https://wa.me/${PHONE}?text=Fresh%20message`);
});

test('legacy links also respect latest target release, active attribution and current clinic lifecycle', async () => {
  data.links.push({ code: 'legacy-old', created_at: BEFORE, target_url: `https://wa.me/${PHONE}` },
    { code: 'legacy-fresh', created_at: AFTER, target_url: `https://wa.me/${PHONE}` });
  assert.equal(await resolveOperationalWaLink('legacy-old', pool), null);
  assert.equal(await resolveOperationalWaLink('legacy-fresh', pool), `https://wa.me/${PHONE}`);
  data.origins = [{ clinic_id: OLD }];
  assert.equal(await resolveOperationalWaLink('legacy-fresh', pool), null);
  data.origins = [{ clinic_id: NEW, conflicting: true }];
  assert.equal(await resolveOperationalWaLink('legacy-fresh', pool), null);
});
