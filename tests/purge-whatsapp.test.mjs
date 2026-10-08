import assert from 'node:assert/strict';
import test from 'node:test';
import { planWhatsAppPurge, minimalSubscriptionReceipt, purgeExpiredClinics } from '../lib/clinic-purge.js';
import { processWhatsAppDeliveryStatus } from '../api/whatsapp-chatbot.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86400000;
const fixture = () => ({
  contacts: [{ id: 1, phone: '593999000111', clinic_id: ID }, { id: 2, phone: '593999000222', clinic_id: OTHER }],
  users: [{ id: 7, clinic_id: ID, phone: '0999000111' }, { id: 8, clinic_id: OTHER, phone: '0999000222' }],
  messages: [{ id: 1, contact_id: 1, booked_by_user_id: 7, owner_clinic_id: ID },
    { id: 2, contact_id: 1, booked_by_user_id: null, owner_clinic_id: null },
    { id: 3, contact_id: 2, booked_by_user_id: 8, owner_clinic_id: OTHER }],
  states: [{ phone: '593999000111', data: { patientName: 'Fictitious target', clinic_id: ID } },
    { phone: '593999000222', data: { patientName: 'Fictitious foreign', clinicId: OTHER } }],
  links: [{ code: `${ID}.${'a'.repeat(22)}`, target_url: 'https://wa.me/593999000111?text=fictitious+target+medical+note' },
    { code: 'legacy-target', target_url: 'https://wa.me/593999000111?text=fictitious+target' },
    { code: `${OTHER}.${'b'.repeat(22)}`, target_url: 'https://wa.me/593999000222?text=fictitious+foreign' }],
});

test('WA attribution selects only exclusively owned contacts/state/links, leaving all foreign content intact', () => {
  const data = fixture();
  const before = structuredClone(data);
  assert.deepEqual(planWhatsAppPurge(ID, data), { contactIds: [1], statePhones: ['593999000111'],
    linkCodes: [`${ID}.${'a'.repeat(22)}`, 'legacy-target'] });
  assert.deepEqual(data, before, 'planner is side-effect-free');
  assert.deepEqual(planWhatsAppPurge(OTHER, data), { contactIds: [2], statePhones: ['593999000222'],
    linkCodes: [`${OTHER}.${'b'.repeat(22)}`] });
});

test('cross-tenant history, missing attribution and legacy PHI all block rather than claiming completion', () => {
  for (const mutate of [
    d => { d.messages[0].owner_clinic_id = OTHER; },
    d => { d.messages[2].owner_clinic_id = ID; },
    d => { d.messages[0].owner_clinic_id = null; },
    d => { d.contacts[0].clinic_id = null; },
    d => { d.messages[0].contact_id = 999; },
    d => { d.users[1].phone = d.contacts[0].phone; },
    d => { d.states[0].data.nested = { clinicId: OTHER }; },
    d => { d.states.push({ phone: '593000000000', data: { medicalNote: 'Unattributed' } }); },
    d => { d.links.push({ code: 'legacy-unattributed', target_url: 'https://wa.me/593000000000?text=PHI' }); },
    d => { d.links[0].code = `${OTHER}.${'c'.repeat(22)}`; },
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => planWhatsAppPurge(ID, data), error => error.status === 409 && /ASSIST|asistida/.test(error.message));
  }
});

test('minimal subscription provider receipt drops PHI, nested objects, unknown keys and arbitrary text', () => {
  const receipt = minimalSubscriptionReceipt({
    transactionId: 1234, authorizationCode: 'A-123', statusCode: 3, amount: 1000, currency: 'USD',
    customer: { name: 'Fictitious patient' }, email: 'patient@example.invalid', phoneNumber: '593999000111',
    medicalNote: 'private note', message: 'Fictitious patient', clientTransactionId: { notes: 'PHI' },
  });
  assert.deepEqual(receipt, { transactionId: 1234, authorizationCode: 'A-123', statusCode: 3, amount: 1000, currency: 'USD' });
  assert.deepEqual(minimalSubscriptionReceipt('provider free text'), {});
});

test('100 held earliest clinics do not starve later eligible clinic; durable retry selection works across invocations', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `11111111-2222-4333-8444-${String(i + 1).padStart(12, '0')}`);
  const eligible = ids[100], schedules = new Map(), jobs = new Map(), queries = [];
  const db = {
    async query(sql, params = []) {
      queries.push(sql);
      if (sql.startsWith('SELECT c.id FROM clinics c')) {
        assert.ok(sql.includes("'{_subscription_policy,purge_schedule,retry_at}'"));
        assert.ok(sql.includes("ORDER BY coalesce(cs.general #>> '{_subscription_policy,purge_schedule,attempted_at}'"));
        return { rows: ids.filter(id => !schedules.has(id) || schedules.get(id).retry_at <= params[0])
          .sort((a,b) => (schedules.get(a)?.attempted_at || '').localeCompare(schedules.get(b)?.attempted_at || ''))
          .slice(0, params[1]).map(id => ({ id })) };
      }
      if (sql.includes('AS deferred')) {
        const deferred = [...schedules.values()].filter(s => s.retry_at > params[0]);
        return { rows: [{ deferred: deferred.length, next_retry_at: deferred.map(s => s.retry_at).sort()[0] || null }] };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT id,name,slug')) return { rows: [{ id: params[0], name: 'Fictitious', slug: 'fictitious',
        is_active: true, subscription_expires_at: new Date(NOW - 50 * DAY).toISOString() }] };
      if (sql.startsWith('SELECT general FROM')) return { rows: [{ general: jobs.has(params[0]) ? { _purge: jobs.get(params[0]) } : {} }] };
      if (sql.startsWith('INSERT INTO clinic_settings')) {
        const map = sql.includes("'purge_schedule'") ? schedules : jobs;
        map.set(params[0], JSON.parse(params[1]));
      }
      return { rows: [] };
    },
    release() {},
  };
  const deps = { pool: { connect: async () => db }, now: () => NOW, budgetMs: 15000,
    loadSubscriptionLifecycle: async () => ({ policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
      expires_at: new Date(NOW - 50 * DAY).toISOString(), recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() }),
    annualPurgeProtection: async (_db, id) => ({ protected: id !== eligible, until: null, reason: 'ANNUAL_DELIVERY_PENDING' }),
    persistSubscriptionLifecycle: async () => {},
    list: async () => assert.fail('Quiescence must drain first'),
  };
  const first = await purgeExpiredClinics(deps);
  assert.equal(first.waiting, 100);
  assert.equal(first.possiblyMore, true);
  assert.equal(schedules.size, 100);
  assert.ok([...schedules.values()].every(s => Date.parse(s.retry_at) === NOW + DAY));
  const second = await purgeExpiredClinics(deps);
  assert.equal(second.scanned, 1);
  assert.equal(second.results[0].id, eligible);
  assert.equal(second.results[0].state, 'QUIESCING');
  assert.equal(jobs.has(eligible), true);
  const deferred = await purgeExpiredClinics(deps);
  assert.equal(deferred.scanned, 0);
  assert.equal(deferred.deferred, 101);
  assert.equal(deferred.complete, false, 'future scheduled holds must never be reported as fully purged');
});

test('WA status callback fresh lock-gate runs before any update, claim or notification after grace or ambiguous owner', async () => {
  for (const scenario of ['RECOVERY','CLOSED','FOREIGN_OWNER','PURGE_AFTER_LOOKUP','ACTIVE']) {
    let reads = 0, locks = 0, updates = 0, claims = 0, notices = 0;
    const db = {
      async query(sql) {
        if (sql.includes('pg_advisory_lock_shared')) locks++;
        if (sql.includes('m.provider_message_id=$1')) {
          reads++;
          return { rows: [{ contact_clinic_id: ID, booked_by_user_id: 7,
            owner_clinic_id: scenario === 'FOREIGN_OWNER' || (scenario === 'PURGE_AFTER_LOOKUP' && reads > 1) ? OTHER : ID }] };
        }
        return { rows: [] };
      }, release() {},
    };
    const result = await processWhatsAppDeliveryStatus({ providerMessageId: 'fictitious', status: 'fallido' }, {
      pool: { connect: async () => db },
      load: async () => ({ canoperate: scenario === 'ACTIVE' }),
      update: async (_id, _status, _error, connection) => { assert.equal(connection, db); assert.equal(locks, 1); updates++; return { id: 1, status: 'fallido' }; },
      claim: async (_id, connection) => { assert.equal(connection, db); claims++; return true; }, notify: async () => { notices++; },
    });
    assert.equal(result.blocked, scenario !== 'ACTIVE');
    assert.equal(updates, scenario === 'ACTIVE' ? 1 : 0);
    assert.equal(claims, updates);
    assert.equal(notices, updates);
  }
});
