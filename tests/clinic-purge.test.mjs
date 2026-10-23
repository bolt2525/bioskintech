import assert from 'node:assert/strict';
import test from 'node:test';
import { clinicPurgePreview, purgeClinic, purgeReasons, isPurgeKey, orderPurgeTables,
  purgeExpiredClinics, updateClinicState, validatePurgeConfirmation, planWhatsAppPurge, minimalSubscriptionReceipt } from '../lib/clinic-purge.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const actor = { id: 1, username: 'master-test', role: 'master_admin' };
const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86400000;
const dependenciesByPool = new WeakMap();
const body = { id: ID, confirmation: 'clinica-prueba', reason: 'Autorizacion ficticia de prueba',
  authorizationConfirmed: true, retentionConfirmed: true };

function database(options = {}) {
  const state = {
    clinic: { id: ID, name: 'Clinica ficticia', slug: body.confirmation, is_active: false,
      subscription_expires_at: '2026-08-01T00:00:00Z', ...options.clinic },
    job: options.job || null, counts: { clinical_photos: 2, patients: 1, clinic_users: 1, ...options.counts },
    columns: options.columns || ['clinical_photos', 'patients', 'clinic_users', 'clinic_settings', 'subscriptions', 'legal_acceptances']
      .map(table_name => ({ table_name, udt_name: 'uuid' })),
    statements: [], sessionsRevoked: false, signingRevoked: false, lifecyclePersisted: false,
    annualChecks: 0, annualDeadlines: [],
    waLocks: 0,
    setupTokens: structuredClone(options.setupTokens || []),
    schedule: null, wa: structuredClone(options.wa || null), receipts: structuredClone(options.receipts || []),
  };
  state.identity = null;
  if (state.wa) state.wa.states.forEach((s, i) => { s.id ||= i + 1; options.wa.states[i].id ||= s.id; });
  if (state.job && !options.preMigration) {
    state.job = structuredClone(state.job);
    state.job.identifiersReleasedAt ||= new Date(NOW - DAY).toISOString();
    const plan = planWhatsAppPurge(state.clinic.id, state.wa || {});
    state.job.waScope ||= { contactIds: plan.contactIds, stateIds: plan.stateIds, linkCodes: plan.linkCodes };
  }
  let snapshot;
  const db = {
    async query(sql, params = []) {
      state.statements.push({ sql, params });
      if (options.failAt && sql.startsWith(options.failAt)) throw new Error('fictitious release failure');
      if (sql === 'BEGIN') { snapshot = structuredClone({ job: state.job, clinic: state.clinic, counts: state.counts,
        schedule: state.schedule, wa: state.wa, receipts: state.receipts, setupTokens: state.setupTokens,
        identity: state.identity, sessionsRevoked: state.sessionsRevoked, signingRevoked: state.signingRevoked }); return { rows: [] }; }
      if (sql === 'ROLLBACK') { Object.assign(state, snapshot); return { rows: [] }; }
      if (sql.startsWith('LOCK TABLE') && sql.includes('"wa_short_links"')) {
        state.waLocks++;
        options.onWhatsAppLock?.(state);
      }
      if (sql === 'COMMIT' || sql.startsWith('SET LOCAL') || sql.startsWith('LOCK TABLE')) return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: !options.writerActive }] };
      if (sql.includes('pg_advisory_xact_lock(68422')) return { rows: [] };
      if (sql.startsWith('SELECT clinic_aliases,released_at') || sql.startsWith('SELECT released_at FROM clinic_identity_history'))
        return { rows: state.identity ? [state.identity] : [] };
      if (sql.startsWith('INSERT INTO clinic_identity_history')) {
        state.identity = { released_at: params[1], clinic_aliases: JSON.parse(params[2]), user_aliases: JSON.parse(params[3]) };
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE clinic_identity_history SET clinic_aliases=')) {
        state.identity.clinic_aliases.whatsapp_aliases = JSON.parse(params[1]);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT name,slug,email,phone,created_at'))
        return { rows: [structuredClone(state.clinic)] };
      if (sql.startsWith('SELECT id,clinic_id,username,email,phone,whatsapp_staff_phone'))
        return { rows: structuredClone((state.wa?.users || []).filter(u => u.clinic_id === params[0])) };
      if (sql.startsWith("UPDATE clinics SET name='")) {
        Object.assign(state.clinic, { name: `Clínica eliminada ${state.clinic.id}`, slug: `!purged:${state.clinic.id}`, email: null, phone: null });
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE clinic_users SET username='!purged:'")) {
        for (const user of state.wa?.users || []) if (user.clinic_id === params[0])
          Object.assign(user, { username: `!purged:${user.id}`, email: null, phone: null, whatsapp_staff_phone: null,
            is_active: false, password_hash: '', salt: null, hash_algo: null });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id,phone,data FROM whatsapp_bot_state')) return { rows: state.wa.states };
      if (sql.startsWith('UPDATE whatsapp_contacts SET retired_at')) {
        state.wa.contacts.filter(c => params[0].includes(c.id)).forEach(c => { c.retired_at ||= params[1]; });
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE whatsapp_bot_state SET retired_at')) {
        state.wa.states.filter(s => params[0].includes(s.id)).forEach(s => { s.retired_at = params[1]; });
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE wa_short_links SET retired_at')) {
        state.wa.links.filter(l => params[0].includes(l.code)).forEach(l => { l.retired_at = params[1]; });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT c.id FROM clinics c'))
        return { rows: options.candidates || [] };
      if (sql.includes('AS deferred')) return { rows: [{ deferred: 0 }] };
      if (sql.includes('table_name=ANY($1::text[])')) return { rows: state.wa ? params[0].map(table_name => ({ table_name })) : [] };
      if (sql.startsWith('SELECT id,phone,clinic_id FROM whatsapp_contacts') ||
          sql.startsWith('SELECT id,phone,clinic_id,retired_at FROM whatsapp_contacts')) return { rows: state.wa.contacts };
      if (sql.startsWith('SELECT id,clinic_id,phone,whatsapp_staff_phone'))
        return { rows: [...state.wa.users, ...(state.identity?.user_aliases || [])] };
      if (sql.includes('u.clinic_id AS owner_clinic_id')) return { rows: state.wa.messages };
      if (sql.startsWith('SELECT phone,data,id FROM whatsapp_bot_state')) return { rows: state.wa.states };
      if (sql.startsWith('SELECT code,target_url FROM wa_short_links')) return { rows: state.wa.links };
      if (sql.startsWith('DELETE FROM whatsapp_messages')) {
        state.wa.messages = state.wa.messages.filter(m => !params[0].includes(m.contact_id)); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM whatsapp_contacts')) {
        state.wa.contacts = state.wa.contacts.filter(c => !(c.clinic_id === params[0] && params[1].includes(c.id))); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM whatsapp_bot_state')) {
        state.wa.states = state.wa.states.filter(s => !params[0].includes(s.id)); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM wa_short_links')) {
        state.wa.links = state.wa.links.filter(s => !params[0].includes(s.code)); return { rows: [] };
      }
      if (sql.startsWith('SELECT id,payphone_response FROM subscriptions')) return { rows: state.receipts };
      if (sql.startsWith('UPDATE subscriptions SET payphone_response')) {
        state.receipts.find(r => r.id === params[0]).payphone_response = JSON.parse(params[1]); return { rows: [] };
      }
      if (sql.includes("to_regclass('public.annual_photo_backup_requests')"))
        return { rows: [{ table_name: options.annualPending ? 'annual_photo_backup_requests' : null }] };
      if (sql.includes('SELECT 1 FROM annual_photo_backup_requests'))
        return { rows: options.annualPending ? [{}] : [] };
      if (sql.includes('SELECT id,name,slug')) return { rows: [structuredClone(state.clinic)] };
      if (sql.startsWith('SELECT general FROM')) return { rows: [{ general: state.job ? { _purge: structuredClone(state.job) } : {} }] };
      if (sql.includes('information_schema.columns') && sql.includes("table_name='consent_forms'"))
        return { rows: state.columns.some(c => c.table_name === 'consent_forms') ? [{}] : [] };
      if (sql.includes('information_schema.columns') && sql.includes("table_name='clinic_settings'"))
        return { rows: ['general', 'treatments', 'email', 'agenda', 'finanzas', 'inventario', 'notificaciones']
          .map(column_name => ({ column_name, udt_name: 'jsonb' })) };
      if (sql.includes('information_schema.columns') && sql.includes("table_name='clinic_users'"))
        return { rows: state.wa ? ['phone', 'whatsapp_staff_phone', 'google_refresh_token', 'password_reset_token']
          .map(column_name => ({ column_name, is_nullable: 'YES' })) : [] };
      if (sql.includes('information_schema.columns')) return { rows: state.columns };
      if (sql.includes('FROM pg_constraint')) return { rows: options.foreignKeys || [] };
      if (sql.includes('FROM pg_attribute')) return { rows: options.attrs || [] };
      if (/^SELECT \d+ AS check_id WHERE EXISTS/.test(sql))
        return { rows: sql.split('\nUNION ALL\n').flatMap(branch => {
          const check_id = Number(branch.match(/^SELECT (\d+)/)[1]);
          const child = branch.match(/FROM "([^"]+)"/)[1];
          const referenced = branch.includes('clinic_id IS DISTINCT')
            ? (options.crossedTables ? options.crossedTables.includes(child) : options.crossed)
            : state.counts[child];
          return referenced ? [{ check_id }] : [];
        }) };
      if (sql.includes('JOIN') && sql.includes('clinic_id IS DISTINCT')) return { rows: options.crossed ? [{}] : [] };
      if (sql.startsWith("SELECT '") && sql.includes('AS table_name,count(*) AS count'))
        return { rows: [...sql.matchAll(/SELECT '([a-z_]+)' AS table_name,count\(\*\) AS count/g)]
          .map(([, table_name]) => ({ table_name, count: String(state.counts[table_name] || 0) })) };
      if (sql.includes('count(*) AS count')) {
        const table = sql.match(/FROM "([^"]+)"/)[1];
        return { rows: [{ count: state.counts[table] || 0 }] };
      }
      if (sql.startsWith('INSERT INTO clinic_settings')) {
        if (sql.includes("'purge_schedule'")) state.schedule = JSON.parse(params[1]);
        else state.job = JSON.parse(params[1]);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM password_setup_tokens')) {
        state.setupTokens = state.setupTokens.filter(t => t.clinic_id !== params[0]);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE admin_sessions')) {
        if (options.revokeFails) throw new Error('fictitious revoke failure');
        state.sessionsRevoked = true; return { rows: [] };
      }
      if (sql.startsWith('UPDATE clinic_users SET is_active=false')) {
        for (const user of state.wa?.users || []) {
          if (user.clinic_id !== params[0]) continue;
          Object.assign(user, { is_active: false, password_hash: '', salt: null, hash_algo: null });
          for (const match of sql.matchAll(/"([a-z_]+)"=NULL/g)) user[match[1]] = null;
        }
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE consent_forms SET signing_token=NULL')) {
        assert.equal(params[0], ID);
        state.signingRevoked = true;
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE clinics SET is_active=false')) {
        state.clinic.is_active = false;
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE clinics SET')) {
        if (params[5] !== null) state.clinic.is_active = params[5];
        return { rows: [structuredClone(state.clinic)] };
      }
      if (sql.startsWith('DELETE FROM')) {
        if (options.sqlFails) throw Object.assign(new Error('synthetic FK failure'), { code: '23503' });
        assert.equal(params[0], state.clinic.id);
        const table = sql.match(/DELETE FROM "([^"]+)"/)[1];
        state.counts[table] = 0;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT 1 FROM "')) {
        const table = sql.match(/FROM "([^"]+)"/)[1];
        return { rows: state.counts[table] ? [{}] : [] };
      }
      if (sql.startsWith('UPDATE clinic_settings SET general=jsonb_build_object')) {
        state.job = JSON.parse(params[1]); return { rows: [] };
      }
      throw new Error(`Unexpected mock SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => db };
  const lifecycleDeps = {
    loadSubscriptionLifecycle: async (_db, _id, now) => {
      const expiry = Date.parse(state.clinic.subscription_expires_at);
      return options.lifecycle || {
        state: 'CLOSED', policy: 'demo', expires_at: state.clinic.subscription_expires_at,
        recovery_ends_at: Number.isFinite(expiry) ? new Date(expiry + 30 * DAY).toISOString() : null,
      };
    },
    annualPurgeProtection: async (_db, _id, deadline) => {
      state.annualChecks++;
      state.annualDeadlines.push(deadline);
      return options.annualPending || options.annualProtected
        ? { protected: true, until: new Date(NOW + DAY).toISOString(), reason: 'Existe una entrega anual pendiente.' }
        : { protected: false, until: null, reason: null };
    },
    persistSubscriptionLifecycle: async () => { state.lifecyclePersisted = true; },
  };
  dependenciesByPool.set(pool, lifecycleDeps);
  return { state, pool, lifecycleDeps };
}

function purge(bodyValue, actorValue, deps = {}) {
  return purgeClinic(bodyValue, actorValue, { ...dependenciesByPool.get(deps.pool), ...deps });
}

function purgePreview(id, pool) {
  return clinicPurgePreview(id, pool, dependenciesByPool.get(pool));
}

function storage() {
  const objects = [
    `clinics/${ID}/records/1/photos/ficticia.jpg`,
    `backup-tmp/${ID}/exports/ficticio.gz`,
    `annual-photo-backups/${ID}/request/part-0001.zip`,
    `backups/${ID}/auto/retener.json.gz.enc`,
    `clinics/${OTHER}/records/1/photos/ajena.jpg`,
  ];
  const deleted = [];
  return {
    objects, deleted,
    list: async prefix => ({ objects: objects.filter(key => key.startsWith(prefix)).slice(0, 100).map(key => ({ key })) }),
    remove: async key => { deleted.push(key); objects.splice(objects.indexOf(key), 1); },
  };
}

test('purge boundaries preserve demo retention but never apply an unaccepted legacy 30-day fallback', () => {
  assert.equal(purgeReasons({ is_active: false, subscription_expires_at: new Date(NOW - 30 * 86400000).toISOString() }, NOW).length, 1);
  assert.equal(purgeReasons({ is_active: false, subscription_expires_at: new Date(NOW - 30 * 86400000 + 1).toISOString() }, NOW).length, 2);
  assert.equal(purgeReasons({ is_active: true, subscription_expires_at: null }, NOW).length, 3);
  const paid = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 45 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 1).toISOString() };
  assert.equal(purgeReasons({ is_active: false }, NOW, paid).length, 0);
  assert.equal(purgeReasons({ is_active: false }, NOW,
    { ...paid, expires_at: new Date(NOW - 30 * DAY).toISOString() }).length, 1);
  assert.equal(purgeReasons({ is_active: false }, NOW, { ...paid, state: 'RECOVERY' }).length, 1);
  for (const change of [{ confirmation: 'otra' }, { authorizationConfirmed: false },
    { retentionConfirmed: false }, { reason: 'corto' }]) {
    assert.throws(() => validatePurgeConfirmation({ ...body, ...change }, { slug: body.confirmation }), { status: 400 });
  }
});

test('preview does not release identities; first valid durable QUIESCING archives originals and frees operational aliases', async () => {
  const wa = waExclusive();
  wa.users[0] = { ...wa.users[0], username: 'doctor_test', email: 'doctor@example.test',
    whatsapp_staff_phone: '0999000333', password_hash: 'old-hash', salt: 'old-salt', is_active: true };
  const db = database({ wa, clinic: { email: 'clinic@example.test', phone: '0999000111' } });
  const preview = await clinicPurgePreview(ID, db.pool, { ...db.lifecycleDeps, now: () => NOW });
  assert.equal(preview.identifiersReleasedAt, null);
  assert.equal(preview.manualLegacyAuthorizationRequired, false);
  assert.equal(db.state.identity, null);
  assert.equal(db.state.wa.users[0].phone, '0999000111');
  const result = await purge(body, actor, { pool: db.pool, now: () => NOW,
    list: async () => assert.fail('No storage call at initial commit') });
  assert.equal(result.purge.state, 'QUIESCING');
  assert.equal(result.identifiersReleasedAt, new Date(NOW).toISOString());
  assert.equal(result.requiredConfirmation, body.confirmation);
  assert.equal(db.state.identity.clinic_aliases.slug, body.confirmation);
  assert.equal(db.state.identity.user_aliases[0].phone, '0999000111');
  assert.equal(db.state.identity.user_aliases[0].whatsapp_staff_phone, '0999000333');
  assert.equal(db.state.wa.users[0].phone, null);
  assert.equal(db.state.wa.users[0].email, null);
  assert.equal(db.state.wa.users[0].password_hash, '');
  assert.equal(db.state.wa.contacts[0].retired_at, result.identifiersReleasedAt);
  assert.equal(db.state.wa.contacts[0].phone, '593999000111');
  assert.equal(db.state.wa.messages[0].contact_id, 1);
  assert.equal(result.purge.waScope, undefined, 'no internal IDs/aliases leaked in job API');
  assert.equal(JSON.stringify(result).includes('doctor@example.test'), false);
  const next = await purgePreview(ID, db.pool);
  assert.equal(next.requiredConfirmation, body.confirmation);
  assert.equal(next.identifiersReleasedAt, result.identifiersReleasedAt);
  assert.equal(next.retentionSnapshot.capturedAt, result.retentionSnapshot.capturedAt);
});

test('invalid start and every release/commit failure roll back history, aliases, phones and tombstone together', async () => {
  for (const failAt of ['INSERT INTO clinic_identity_history', 'UPDATE whatsapp_contacts SET retired_at',
    "UPDATE clinic_users SET username='!purged:'", "UPDATE clinics SET name='", 'COMMIT']) {
    const db = database({ wa: waExclusive(), failAt });
    const before = structuredClone({ clinic: db.state.clinic, wa: db.state.wa });
    await assert.rejects(purge(body, actor, { pool: db.pool, now: () => NOW }));
    assert.equal(db.state.identity, null, failAt);
    assert.equal(db.state.job, null, failAt);
    assert.deepEqual(db.state.clinic, before.clinic, failAt);
    assert.deepEqual(db.state.wa, before.wa, failAt);
  }
  const invalid = database({ wa: waExclusive() });
  await assert.rejects(purge({ ...body, authorizationConfirmed: false }, actor,
    { pool: invalid.pool, now: () => NOW }), { status: 400 });
  assert.equal(invalid.state.identity, null);
  assert.equal(invalid.state.job, null);
});

test('release retries are idempotent and do not retire a newly created contact/state using the same phone', async () => {
  const db = database({ wa: waExclusive() });
  await purge(body, actor, { pool: db.pool, now: () => NOW });
  db.state.wa.users.push({ id: 90, clinic_id: OTHER, phone: '0999000111', username: 'new_doctor' });
  db.state.wa.contacts.push({ id: 90, clinic_id: OTHER, phone: '593999000111', retired_at: null });
  db.state.wa.messages.push({ id: 90, contact_id: 90, booked_by_user_id: 90, owner_clinic_id: OTHER });
  db.state.wa.states.push({ id: 90, phone: '593999000111', data: { clinic_id: OTHER }, retired_at: null });
  const before = structuredClone(db.state.wa);
  const retry = await purge(body, actor, { pool: db.pool, now: () => NOW + 1 });
  assert.equal(retry.purge.state, 'QUIESCING');
  assert.equal(retry.requiredConfirmation, body.confirmation);
  assert.deepEqual(db.state.wa, before);
  assert.equal(db.state.statements.filter(s => s.sql.startsWith('INSERT INTO clinic_identity_history')).length, 1);
  const plan = planWhatsAppPurge(ID, { ...db.state.wa, users: [...db.state.wa.users, ...db.state.identity.user_aliases] });
  assert.equal(plan.contactIds.includes(90), false);
  assert.equal(plan.stateIds.includes(90), false);
});

test('release rejects foreign active contacts, declared states and scoped links before any WA retirement', async () => {
  for (const conflict of ['contact', 'state', 'mixed-state', 'link', 'declared-state-contact', 'contact-only-link']) {
    const wa = waExclusive();
    if (conflict === 'contact') wa.contacts.push({ id: 90, clinic_id: OTHER, phone: '0999000111' });
    if (conflict === 'state' || conflict === 'mixed-state')
      wa.states.push({ id: 90, phone: '0999000111', data: { nested: {
        clinic_id: OTHER, ...(conflict === 'mixed-state' ? { clinicId: ID } : {}),
      } } });
    if (conflict === 'link' || conflict === 'contact-only-link')
      wa.links.push({ code: `${OTHER}.${'z'.repeat(22)}`, target_url: 'https://wa.me/593999000111' });
    if (conflict === 'contact-only-link') wa.users = [];
    if (conflict === 'declared-state-contact') {
      wa.states.push({ id: 91, phone: '593999000555', data: { clinic_id: ID } });
      wa.contacts.push({ id: 91, clinic_id: OTHER, phone: '0999000555' });
    }
    const db = database({ wa });
    const before = structuredClone({ clinic: db.state.clinic, wa: db.state.wa });
    await assert.rejects(purge(body, actor, { pool: db.pool, now: () => NOW,
      list: async () => assert.fail('Conflict must not access storage'),
    }), { status: 409 }, conflict);
    assert.equal(db.state.identity, null, conflict);
    assert.equal(db.state.job, null, conflict);
    assert.deepEqual(db.state.clinic, before.clinic, conflict);
    assert.deepEqual(db.state.wa, before.wa, conflict);
    assert.equal(db.state.statements.some(s => /^UPDATE (whatsapp_contacts|whatsapp_bot_state|wa_short_links) SET retired_at/.test(s.sql)),
      false, conflict);
  }
});

test('release persists contact-only and declared-state-only phone barriers after SQL evidence can disappear', async () => {
  const wa = waExclusive();
  wa.users = [];
  wa.states.push({ id: 55, phone: '593999000555', data: { nested: { clinic_id: ID } } });
  const db = database({ wa });
  await purge(body, actor, { pool: db.pool, now: () => NOW });
  assert.ok(db.state.identity.clinic_aliases.whatsapp_aliases.some(a => a.phone === '593999000111'));
  assert.ok(db.state.identity.clinic_aliases.whatsapp_aliases.some(a => a.phone === '593999000555'));
  assert.equal(db.state.wa.states.find(s => s.id === 55).retired_at, new Date(NOW).toISOString());
  db.state.wa.contacts = [];
  db.state.wa.states = [];
  assert.ok(db.state.identity.clinic_aliases.whatsapp_aliases.length >= 2);
});

test('manual legacy requires explicit flag and 30 complete days, snapshots dates, and revalidates every batch without auto optin', async () => {
  for (const delta of [-1, 0]) {
    const expires = new Date(NOW - 30 * DAY - delta).toISOString();
    const lifecycle = { policy: 'legacy', state: 'CLOSED', auto_purge_eligible: false,
      expires_at: expires, recovery_ends_at: expires };
    const db = database({ lifecycle, clinic: { subscription_expires_at: expires } });
    const preview = await clinicPurgePreview(ID, db.pool, { ...db.lifecycleDeps, now: () => NOW });
    assert.equal(preview.manualLegacyAuthorizationRequired, true);
    if (delta === -1) {
      assert.equal(preview.eligible, false);
      await assert.rejects(purge({ ...body, legacyAuthorizationConfirmed: true }, actor,
        { pool: db.pool, now: () => NOW }), { status: 409 });
      continue;
    }
    assert.equal(preview.eligible, true);
    await assert.rejects(purge(body, actor, { pool: db.pool, now: () => NOW }), { status: 400 });
    const started = await purge({ ...body, legacyAuthorizationConfirmed: true }, actor, { pool: db.pool, now: () => NOW });
    assert.equal(started.retentionSnapshot.retentionDays, 30);
    assert.equal(started.retentionSnapshot.eligibleAt, new Date(NOW).toISOString());
    assert.equal(db.state.job.legacyAuthorizationConfirmed, true);
    let lists = 0;
    const resumed = await purge(body, actor, { pool: db.pool, now: () => NOW + 26 * 60000,
      list: async () => { lists++; return { objects: [] }; }, remove: async () => assert.fail('No objects') });
    assert.ok(lists > 0);
    assert.ok(['RUNNING', 'COMPLETE'].includes(resumed.purge.state));
  }
});

test('jobs started before identity migration are explicitly held in preview, manual POST and cron', async () => {
  const db = database({ preMigration: true, candidates: [{ id: ID }], job: {
    mode: 'AUTOMATIC', state: 'RUNNING', phase: 'PHOTOS', retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0,
  } });
  const preview = await purgePreview(ID, db.pool);
  assert.equal(preview.eligible, false);
  assert.equal(preview.identifiersReleasedAt, null);
  assert.ok(preview.reasons.some(reason => reason.includes('revisión asistida')));
  await assert.rejects(purge(body, actor, { pool: db.pool, now: () => NOW }), { status: 409 });
  const report = await purgeExpiredClinics({ pool: db.pool, ...db.lifecycleDeps, now: () => NOW,
    list: async () => assert.fail('No storage for old jobs') });
  assert.equal(report.results[0].reason, 'IDENTITY_MIGRATION_REVIEW_REQUIRED');
  assert.equal(db.state.identity, null);
});

test('object ownership rejects other clinics, backups, traversal and non-photo clinical keys', () => {
  assert.equal(isPurgeKey(`clinics/${ID}/records/1/photos/f.jpg`, ID, 'PHOTOS'), true);
  for (const key of [`clinics/${OTHER}/records/1/photos/f.jpg`, `backups/${ID}/auto/f.enc`,
    `clinics/${ID}/records/1/photos/../f.jpg`, `clinics/${ID}/records/1/not-photo/f.jpg`,
    `clinics/${ID}/records/1/photos/sub/f.jpg`]) assert.equal(isPurgeKey(key, ID, 'PHOTOS'), false);
  assert.equal(isPurgeKey(`annual-photo-backups/${ID}/request/part.zip`, ID, 'ANNUAL'), true);
});

test('SQL deletes children before parents, and fails closed on cycles', () => {
  assert.deepEqual(orderPurgeTables(['periods', 'requests', 'parts'], [
    { child: 'requests', parent: 'periods' }, { child: 'parts', parent: 'requests' },
  ]), ['parts', 'requests', 'periods']);
  assert.throws(() => orderPurgeTables(['a', 'b'], [{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }]), { status: 409 });
});

test('rejects non-master and SQL preconditions before any R2 call', async () => {
  for (const options of [
    { clinic: { is_active: true } }, { clinic: { subscription_expires_at: null } },
    { columns: [{ table_name: 'unknown_table', udt_name: 'uuid' }] },
    { columns: [{ table_name: 'ai_consultations', udt_name: 'int4' }] },
    { counts: { patients: 50001 } }, { writerActive: true }, { annualPending: true },
  ]) {
    const { pool, state } = database(options);
    let calls = 0;
    await assert.rejects(purge(body, actor, { pool, now: () => NOW,
      list: async () => { calls++; }, remove: async () => { calls++; } }), { status: 409 });
    assert.equal(calls, 0);
    assert.equal(state.job, null);
  }
  await assert.rejects(purge(body, { role: 'clinic_admin' }), { status: 403 });
});

test('first request stores irreversible authorization, revokes sessions and waits for issued leases', async () => {
  const { pool, state } = database();
  let calls = 0;
  const out = await purge(body, actor, { pool, now: () => NOW,
    list: async () => { calls++; }, remove: async () => { calls++; } });
  assert.equal(out.complete, false);
  assert.equal(out.purge.state, 'QUIESCING');
  assert.equal(Date.parse(out.purge.retryAfter), NOW + 25 * 60000);
  assert.equal(state.sessionsRevoked, true);
  assert.equal(calls, 0);
  assert.equal(state.job.actorId, actor.id);
  await assert.rejects(updateClinicState({ id: ID, is_active: true }, pool), { status: 409 });
});

test('annual delivery availability blocks purge without cancelling a pending request or its download window', async () => {
  const { pool, state } = database({ annualPending: true });
  const preview = await purgePreview(ID, pool);
  assert.equal(preview.eligible, false);
  assert.match(preview.reasons.join(' '), /entrega anual/);
  assert.equal(state.annualChecks, 1);
  await assert.rejects(purge(body, actor, { pool, now: () => NOW }), { status: 409 });
  assert.equal(state.job, null);
  assert.equal(state.statements.some(s => /^\s*(UPDATE|DELETE).*annual_photo_backup_requests/.test(s.sql)), false);
});

test('master purge keeps paid subscriptions in recovery until the complete T+45 boundary', async () => {
  const recovering = { policy: 'paid', auto_purge_eligible: true, state: 'RECOVERY',
    expires_at: new Date(NOW - 30 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW + 15 * DAY).toISOString() };
  const blocked = database({ lifecycle: recovering });
  await assert.rejects(purge(body, actor, { pool: blocked.pool, now: () => NOW }), { status: 409 });
  assert.equal(blocked.state.job, null);
  assert.equal(blocked.state.annualChecks, 0);

  const closed = { ...recovering, state: 'CLOSED',
    expires_at: new Date(NOW - 45 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 1).toISOString() };
  const eligible = database({ lifecycle: closed });
  const result = await purge(body, actor, { pool: eligible.pool, now: () => NOW });
  assert.equal(result.purge.state, 'QUIESCING');
  assert.equal(eligible.state.annualDeadlines[0], closed.recovery_ends_at);
});

test('every destructive batch reruns schema eligibility before touching R2', async () => {
  const { pool, state } = database({ job: { state: 'RUNNING', phase: 'PHOTOS',
    retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 } });
  const r2 = storage();
  await purge(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove });
  const before = r2.deleted.length;
  state.columns.push({ table_name: 'new_unreviewed_tenant_data', udt_name: 'uuid' });
  await assert.rejects(purge(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove }), { status: 409 });
  assert.equal(r2.deleted.length, before);
});

test('SQL preflight has a total bounded budget and aborts without calling R2 on exhaustion', async t => {
  const { pool, state } = database();
  let clock = NOW;
  t.mock.method(Date, 'now', () => { clock += 6001; return clock; });
  let r2Calls = 0;
  await assert.rejects(purge(body, actor, { pool, now: () => NOW,
    list: async () => { r2Calls++; }, remove: async () => { r2Calls++; } }), { status: 503 });
  assert.equal(r2Calls, 0);
  assert.equal(state.job, null);
  assert.equal(state.statements.some(s => s.sql === 'ROLLBACK'), true);
  assert.ok(state.statements.some(s => /SET LOCAL statement_timeout = '\d+ms'/.test(s.sql)));
});

test('bounded retries purge only approved prefixes then transactionally delete tenant data and retain tombstone', async () => {
  const { pool, state } = database();
  const r2 = storage();
  let clock = NOW;
  const deps = { pool, now: () => clock, list: r2.list, remove: r2.remove };
  await purge(body, actor, deps);
  clock += 26 * 60000;
  let result = await purge(body, actor, deps);
  for (let i = 0; i < 8 && result.purge.phase !== 'BACKUPS'; i++) result = await purge(body, actor, deps);
  result = await purge(body, actor, deps);
  assert.equal(result.complete, false);
  assert.equal(result.purge.state, 'WAITING_STORAGE');
  assert.equal(result.purge.waitingStorage.pendingObjects, 1);
  assert.equal(r2.deleted.some(key => key.startsWith(`backups/${ID}/`)), false);
  r2.objects.splice(r2.objects.indexOf(`backups/${ID}/auto/retener.json.gz.enc`), 1);
  clock = Date.parse(result.purge.retryAfter) + 1;
  await purge(body, actor, deps);
  result = await purge(body, actor, deps);
  assert.equal(result.complete, true);
  assert.equal(result.purge.deletedObjects, 3);
  assert.deepEqual(r2.objects, [`clinics/${OTHER}/records/1/photos/ajena.jpg`]);
  assert.deepEqual(state.counts, { clinical_photos: 0, patients: 0, clinic_users: 1 });
  assert.equal(state.clinic.id, ID);
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.statements.some(s => /DELETE FROM clinics/.test(s.sql)), false);
  assert.equal(state.statements.some(s => /DELETE FROM "legal_acceptances"/.test(s.sql)), false);
  assert.equal(state.statements.some(s => /DELETE FROM "clinic_users"/.test(s.sql)), false);
  assert.ok(state.statements.some(s => s.sql.includes('UPDATE clinic_users SET is_active=false')));
  assert.ok(state.statements.some(s => s.sql.startsWith('UPDATE clinic_settings SET general=jsonb_build_object') &&
    s.sql.includes("general->'_subscription_policy'")), 'purge retains contractual acceptance evidence');
  const preview = await purgePreview(ID, pool);
  assert.equal(preview.complete, true);
  assert.equal(preview.retainedBackups.retentionDays, 35);
  const again = await purge(body, actor, deps);
  assert.equal(again.complete, true);
  assert.equal(r2.deleted.length, 3);
});

test('R2 failure records FAILED, retains reserve and never deletes SQL data or reports success', async () => {
  const { pool, state } = database({ job: { state: 'RUNNING', phase: 'PHOTOS', retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 } });
  await assert.rejects(purge(body, actor, { pool, now: () => NOW,
    list: async () => ({ objects: [{ key: `clinics/${ID}/records/1/photos/test.jpg` }] }),
    remove: async () => { throw new Error('synthetic R2 outage'); } }), { status: 502 });
  assert.equal(state.job.state, 'FAILED');
  assert.equal(state.job.last_error, 'PURGE_BATCH_FAILED');
  assert.equal(Date.parse(state.job.leaseUntil), NOW + 300000);
  assert.equal(state.statements.some(s => s.sql.startsWith('DELETE FROM') && !s.sql.startsWith('DELETE FROM password_setup_tokens')), false);
  await assert.rejects(purge(body, actor, { pool, now: () => NOW }), { status: 409 });
});

test('SQL failure rolls back all tenant changes and preserves FAILED tombstone for assisted retry', async () => {
  const { pool, state } = database({ sqlFails: true, job: { state: 'RUNNING', phase: 'SQL',
    retryAfter: new Date(NOW - 1).toISOString(),
    backupRetentionUntil: new Date(NOW - 1).toISOString(), deletedObjects: 3 } });
  await assert.rejects(purge(body, actor, { pool, now: () => NOW }), { status: 502 });
  assert.equal(state.job.state, 'FAILED');
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.counts.patients, 1);
  assert.equal(state.statements.some(s => s.sql === 'ROLLBACK'), true);
});

test('retained receipt identities do not retain passwords or indirect authentication tokens', async () => {
  const children = ['login_otp', 'trusted_devices', 'password_setup_tokens', 'oauth_states', 'user_module_overrides'];
  const foreignKeys = children.map((child, index) => ({
    child, parent: 'clinic_users', delete_type: 'c', child_columns: [2], parent_columns: [1],
    child_oid: index + 100, parent_oid: 50,
  }));
  const attrs = [
    { attrelid: 50, attnum: 1, attname: 'id' },
    ...children.map((_, index) => ({ attrelid: index + 100, attnum: 2, attname: 'user_id' })),
  ];
  const { pool, state } = database({
    job: { state: 'RUNNING', phase: 'SQL', retryAfter: new Date(NOW - 1).toISOString(),
      backupRetentionUntil: new Date(NOW - 1).toISOString(), deletedObjects: 0 },
    foreignKeys, attrs, counts: Object.fromEntries(children.map(table => [table, 1])),
  });
  assert.equal((await purge(body, actor, { pool, now: () => NOW })).complete, true);
  for (const child of children) {
    assert.equal(state.counts[child], 0);
    const deletion = state.statements.find(s => s.sql.startsWith(`DELETE FROM "${child}"`));
    assert.ok(deletion.sql.includes('p.clinic_id=$1 AND c."user_id"=p."id"'));
    assert.deepEqual(deletion.params, [ID]);
    assert.ok(state.statements.some(s => s.sql.startsWith('LOCK TABLE') && s.sql.includes(`"${child}"`)));
  }
  const scrub = state.statements.find(s => s.sql.startsWith('UPDATE clinic_users SET is_active=false')).sql;
  assert.ok(scrub.includes("password_hash='',salt=NULL"));
  assert.ok(scrub.includes('hash_algo=NULL'));
  assert.ok(!scrub.includes("role='clinic_admin'"));
  assert.ok(!state.statements.some(s => s.sql.startsWith('DELETE FROM "legal_acceptances"')));
});

test('unclassified dependents of retained identities block storage deletion before purge starts', async () => {
  const { pool } = database({ foreignKeys: [{
    child: 'future_identity_data', parent: 'clinic_users', delete_type: 'c',
    child_columns: [2], parent_columns: [1], child_oid: 100, parent_oid: 50,
  }] });
  let storageCalls = 0;
  await assert.rejects(purge(body, actor, { pool, now: () => NOW,
    list: async () => { storageCalls++; return { objects: [] }; },
    remove: async () => { storageCalls++; },
  }), { status: 409 });
  assert.equal(storageCalls, 0);
});

test('preview batches tenant and auth counts in one scoped UNION ALL without changing limits', async () => {
  const { pool, state, lifecycleDeps } = database({
    columns: ['patients', 'clinical_photos', 'admin_sessions', 'clinic_users', 'clinic_settings']
      .map(table_name => ({ table_name, udt_name: 'uuid' })),
    counts: { patients: 12, clinical_photos: 34, admin_sessions: 2, login_otp: 3 },
    foreignKeys: [{ child: 'login_otp', parent: 'clinic_users', delete_type: 'c',
      child_columns: [2], parent_columns: [1], child_oid: 100, parent_oid: 50 }],
    attrs: [{ attrelid: 50, attnum: 1, attname: 'id' }, { attrelid: 100, attnum: 2, attname: 'user_id' }],
  });
  const result = await clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW });
  assert.equal(result.counts.patients, 12);
  assert.equal(result.counts.clinical_photos, 34);
  assert.equal(result.counts.admin_sessions, 2);
  assert.equal(result.counts.login_otp, 3);
  const queries = state.statements.filter(s => s.sql.includes('count(*) AS count'));
  assert.equal(queries.length, 1);
  assert.equal(queries[0].sql.split('UNION ALL').length, 4);
  assert.match(queries[0].sql, /FROM "login_otp" c WHERE EXISTS \(SELECT 1 FROM clinic_users p WHERE p.clinic_id=\$1 AND c\."user_id"=p\."id"\)/);
  assert.match(queries[0].sql, /FROM "admin_sessions" WHERE clinic_id=\$1 OR clinic_user_id IN \(SELECT id FROM clinic_users WHERE clinic_id=\$1\)/);
  assert.match(queries[0].sql, /FROM "patients" WHERE clinic_id=\$1/);
  assert.deepEqual(queries[0].params, [ID]);
  assert.equal(state.statements.some(s => /^(DELETE|UPDATE|INSERT)/.test(s.sql)), false);
});

test('preview batches multiple FK checks and attributes while detecting any real reference', async () => {
  const children = ['clinical_records', 'consultations', 'registration_codes', 'global_attributions'];
  const foreignKeys = children.map((child, i) => ({
    child, parent: i < 2 ? 'patients' : 'clinic_users', delete_type: 'a',
    child_oid: 100 + i, parent_oid: i < 2 ? 50 : 60,
    child_columns: i === 0 ? [2, 3] : [2], parent_columns: i === 0 ? [1, 3] : [1],
  }));
  const attrs = [
    { attrelid: 50, attnum: 1, attname: 'id' }, { attrelid: 50, attnum: 3, attname: 'clinic_id' },
    { attrelid: 60, attnum: 1, attname: 'id' },
    ...children.map((_, i) => ({ attrelid: 100 + i, attnum: 2, attname: i < 2 ? 'patient_id' : 'user_id' })),
    { attrelid: 100, attnum: 3, attname: 'clinic_id' },
  ];
  for (const reference of [null, ...children]) {
    const { pool, state, lifecycleDeps } = database({
      columns: ['patients', 'clinical_records', 'consultations', 'clinic_users', 'clinic_settings']
        .map(table_name => ({ table_name, udt_name: 'uuid' })),
      foreignKeys, attrs, crossedTables: reference ? [reference] : [],
      counts: { registration_codes: reference === 'registration_codes' ? 1 : 0,
        global_attributions: reference === 'global_attributions' ? 1 : 0 },
    });
    const preview = () => clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW });
    if (reference) await assert.rejects(preview(), error => error.status === 409 &&
      (children.indexOf(reference) < 2 ? /Referencias entre clínicas/ : /atribuciones globales/).test(error.message));
    else assert.equal((await preview()).eligible, true);
    const checks = state.statements.filter(s => s.sql.includes('AS check_id WHERE EXISTS'));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].sql.split('UNION ALL').length, 4);
    assert.deepEqual(checks[0].params, [ID]);
    assert.match(checks[0].sql, /c\."patient_id"=p\."id" AND c\."clinic_id"=p\."clinic_id"/);
    assert.equal(state.statements.filter(s => s.sql.includes('FROM pg_attribute')).length, 1);
    assert.equal(state.statements.some(s => /^(DELETE|UPDATE|INSERT)/.test(s.sql)), false);
  }
  for (const invalid of ['missing-column', 'invalid-identifier']) {
    const { pool, lifecycleDeps } = database({
      foreignKeys: invalid === 'invalid-identifier'
        ? [{ ...foreignKeys[2], child: 'registration_codes";invalid' }] : [foreignKeys[2]],
      attrs: invalid === 'missing-column' ? [] : attrs,
    });
    await assert.rejects(clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW }),
      error => error.status === 409 && /no verificable/.test(error.message));
  }
});

test('preview non-CASCADE registration references block only when scoped references exist', async () => {
  for (const delete_type of ['a', 'r', 'n', 'd']) {
    for (const referenced of [false, true]) {
      const { pool, state, lifecycleDeps } = database({
        foreignKeys: [{ child: 'registration_codes', parent: 'clinic_users', delete_type,
          child_columns: [2], parent_columns: [1], child_oid: 100, parent_oid: 50 }],
        attrs: [{ attrelid: 50, attnum: 1, attname: 'id' },
          { attrelid: 100, attnum: 2, attname: 'used_by_user_id' }],
        counts: { registration_codes: referenced ? 1 : 0 },
      });
      const preview = () => clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW });
      if (referenced) {
        await assert.rejects(preview(), error => error.status === 409 && /atribuciones globales/.test(error.message));
      } else {
        const result = await preview();
        assert.equal(result.eligible, true);
        assert.equal(Object.hasOwn(result.counts, 'registration_codes'), false);
      }
      const check = state.statements.find(s => s.sql.includes('AS check_id WHERE EXISTS') && s.sql.includes('FROM "registration_codes"'));
      assert.ok(check.sql.includes('JOIN "clinic_users" p ON c."used_by_user_id"=p."id"'));
      assert.ok(check.sql.includes('WHERE p.clinic_id=$1 LIMIT 1'));
      assert.deepEqual(check.params, [ID]);
      assert.equal(state.statements.some(s => /^(DELETE|UPDATE|INSERT)/.test(s.sql)), false);
      assert.equal(state.counts.registration_codes, referenced ? 1 : 0);
    }
  }
});

test('preview still rejects uncovered identity cascades and WhatsApp message FKs regardless of delete rule', async () => {
  for (const [child, delete_type] of [
    ['registration_codes', 'c'], ['whatsapp_messages', 'a'], ['whatsapp_messages', 'c'],
  ]) {
    const { pool, state, lifecycleDeps } = database({
      foreignKeys: [{ child, parent: 'clinic_users', delete_type,
        child_columns: [2], parent_columns: [1], child_oid: 100, parent_oid: 50 }],
    });
    await assert.rejects(clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW }),
      error => error.status === 409 && /Dependencia de identidad no cubierta/.test(error.message));
    assert.equal(state.statements.some(s => /^(DELETE|UPDATE|INSERT)/.test(s.sql)), false);
  }
});

test('a batch never deletes more than 100 keys and cannot delete an unexpected key', async () => {
  const ready = { state: 'RUNNING', phase: 'PHOTOS', retryAfter: new Date(NOW - 1).toISOString(), deletedObjects: 0 };
  const { pool } = database({ job: ready });
  const r2 = storage();
  r2.objects.unshift(...Array.from({ length: 110 }, (_, i) => `clinics/${ID}/records/1/photos/f-${i}.jpg`));
  const result = await purge(body, actor, { pool, now: () => NOW, list: r2.list, remove: r2.remove });
  assert.equal(r2.deleted.length, 100);
  assert.equal(result.complete, false);
  assert.equal(result.purge.phase, 'PHOTOS');
  const invalid = database({ job: { ...ready, leaseUntil: null } });
  const removed = [];
  await assert.rejects(purge(body, actor, { pool: invalid.pool, now: () => NOW,
    list: async () => ({ objects: [{ key: `clinics/${ID}/unexpected/file.jpg` }] }),
    remove: async key => removed.push(key) }), { status: 409 });
  assert.deepEqual(removed, []);
});

test('deactivation conserves tenant content and revokes sessions and setup tokens in the same SQL transaction', async () => {
  const { pool, state } = database({ clinic: { is_active: true },
    setupTokens: [{ clinic_id: ID, token: 'fictitious' }, { clinic_id: OTHER, token: 'other' }], columns: [
    'clinical_photos', 'patients', 'clinic_users', 'consent_forms', 'clinic_settings', 'subscriptions',
  ].map(table_name => ({ table_name, udt_name: 'uuid' })) });
  await updateClinicState({ id: ID, is_active: false }, pool);
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.sessionsRevoked, true);
  assert.equal(state.signingRevoked, true);
  assert.equal(state.counts.patients, 1);
  assert.equal(state.job, null);
  assert.deepEqual(state.setupTokens, [{ clinic_id: OTHER, token: 'other' }]);
  assert.equal(state.statements.some(s => s.sql.startsWith('DELETE') && !s.sql.startsWith('DELETE FROM password_setup_tokens')), false);
  const lock = state.statements.findIndex(s => s.sql.includes('pg_try_advisory_xact_lock'));
  const revoke = state.statements.findIndex(s => s.sql.startsWith('DELETE FROM password_setup_tokens'));
  assert.ok(lock >= 0 && revoke > lock);
  assert.equal(state.statements.at(-1).sql, 'COMMIT');
  await updateClinicState({ id: ID, is_active: true }, pool);
  assert.deepEqual(state.setupTokens, [{ clinic_id: OTHER, token: 'other' }], 'reactivation must not restore old links');
});

test('failed deactivation rolls back setup token revocation and active state together', async () => {
  const setupTokens = [{ clinic_id: ID, token: 'fictitious' }];
  const { pool, state } = database({ clinic: { is_active: true }, setupTokens, revokeFails: true });
  await assert.rejects(updateClinicState({ id: ID, is_active: false }, pool), /fictitious revoke failure/);
  assert.equal(state.clinic.is_active, true);
  assert.deepEqual(state.setupTokens, setupTokens);
  assert.equal(state.statements.at(-1).sql, 'ROLLBACK');
});

test('automatic purge closes only paid subscriptions after T+45 and records a quiescence tombstone without master claims', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  const { pool, state, lifecycleDeps } = database({
    clinic: { is_active: true },
    candidates: [{ id: ID }],
    lifecycle,
  });
  let calls = 0;
  const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => { calls++; return { objects: [] }; },
    remove: async () => { calls++; } });
  assert.equal(report.scanned, 1);
  assert.equal(report.waiting, 1);
  assert.equal(report.results[0].state, 'QUIESCING');
  assert.equal(state.clinic.is_active, false);
  assert.equal(state.sessionsRevoked, true);
  assert.equal(state.lifecyclePersisted, true);
  assert.equal(state.job.mode, 'AUTOMATIC');
  assert.equal(state.job.state, 'QUIESCING');
  assert.equal('actorId' in state.job, false);
  assert.equal('authorizationConfirmed' in state.job, false);
  assert.equal(Date.parse(state.job.retryAfter), NOW + 25 * 60000);
  assert.equal(calls, 0);
});

test('automatic purge rechecks writer locks and annual eligibility before creating any tombstone', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  for (const options of [{ writerActive: true }, { annualProtected: true }]) {
    const { pool, state, lifecycleDeps } = database({
      ...options, candidates: [{ id: ID }], lifecycle, clinic: { is_active: true },
    });
    let calls = 0;
    const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
      list: async () => { calls++; return { objects: [] }; },
      remove: async () => { calls++; } });
    assert.equal(calls, 0);
    assert.equal(state.job, null);
    assert.equal(state.clinic.is_active, true);
    if (options.annualProtected) {
      assert.equal(report.results[0].state, 'WAITING_ANNUAL');
      assert.equal(report.waiting, 1);
    } else {
      assert.equal(report.results[0].state, 'BLOCKED');
      assert.equal(report.failed, 1);
    }
  }
});

test('automatic purge never treats demo, legacy or recovery states as paid-closed evidence', async () => {
  const paidRecovery = { policy: 'paid', auto_purge_eligible: true, state: 'RECOVERY',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW + DAY).toISOString() };
  const unknownLegacy = { policy: 'legacy', state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  for (const lifecycle of [paidRecovery, unknownLegacy, { ...unknownLegacy, policy: 'demo' },
    { ...unknownLegacy, policy: 'paid', auto_purge_eligible: false }]) {
    const { pool, state, lifecycleDeps } = database({
      candidates: [{ id: ID }], lifecycle, clinic: { is_active: true },
    });
    const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps });
    assert.equal(report.skipped, 1);
    assert.equal(state.job, null);
    assert.equal(state.clinic.is_active, true);
  }
});

    test('manual legacy requires explicit authorization; paid manual does not retroactively require auto optin', async () => {
      for (const policy of ['legacy','paid']) {
        const lifecycle = { policy, state: 'CLOSED', auto_purge_eligible: false,
          expires_at: new Date(NOW - 100 * DAY).toISOString(),
          recovery_ends_at: new Date(NOW - 55 * DAY).toISOString() };
        const { pool, state } = database({ lifecycle });
        const run = () => purge(body, actor, { pool, now: () => NOW,
          list: async () => assert.fail('No R2 before quiescence') });
        if (policy === 'legacy') {
          await assert.rejects(run(), { status: 400 });
          assert.equal(state.job, null);
          assert.equal(state.sessionsRevoked, false);
        } else {
          assert.equal((await run()).purge.state, 'QUIESCING');
          assert.equal(state.sessionsRevoked, true);
        }
      }
    });

    test('SQL purge deletes verified WA PHI and sanitizes subscription JSON, keeping other-tenant rows unchanged', async () => {
      const wa = {
        contacts: [{ id: 1, clinic_id: ID, phone: '593999000111' }, { id: 2, clinic_id: OTHER, phone: '593999000222' }],
        users: [{ id: 7, clinic_id: ID, phone: '0999000111' }, { id: 8, clinic_id: OTHER, phone: '0999000222' }],
        messages: [{ id: 1, contact_id: 1, booked_by_user_id: 7, owner_clinic_id: ID },
          { id: 2, contact_id: 2, booked_by_user_id: 8, owner_clinic_id: OTHER }],
        states: [{ phone: '593999000111', data: { medicalNote: 'target' } }, { phone: '593999000222', data: { medicalNote: 'foreign' } }],
        links: [{ code: `${ID}.${'a'.repeat(22)}`, target_url: 'https://wa.me/593999000111?text=medical-target' },
          { code: `${OTHER}.${'b'.repeat(22)}`, target_url: 'https://wa.me/593999000222?text=medical-foreign' }],
      };
      const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
        expires_at: new Date(NOW - 50 * DAY).toISOString(), recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
      const { pool, state, lifecycleDeps } = database({ wa, lifecycle, candidates: [{ id: ID }],
        receipts: [{ id: 1, payphone_response: { transactionId: 123, customerName: 'Patient', clinicalNote: 'PHI' } }],
        job: { mode: 'AUTOMATIC', state: 'RUNNING', phase: 'SQL', retryAfter: new Date(NOW - 1).toISOString(),
          backupRetentionUntil: new Date(NOW - DAY).toISOString(), deletedObjects: 0 } });
      const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 15000, ...lifecycleDeps });
      assert.equal(report.completed, 1);
      assert.deepEqual(state.wa.contacts, [wa.contacts[1]]);
      assert.deepEqual(state.wa.messages, [wa.messages[1]]);
      assert.deepEqual(state.wa.states, [wa.states[1]]);
      assert.deepEqual(state.wa.links, [wa.links[1]]);
      assert.deepEqual(state.receipts[0].payphone_response, { transactionId: 123 });
      assert.ok(state.statements.some(s => s.sql.includes('LOCK TABLE') && s.sql.includes('"wa_short_links"')));
      const left = planWhatsAppPurge(ID, state.wa);
      assert.deepEqual(left.contactIds, []);
      assert.deepEqual(left.statePhones, []);
      assert.deepEqual(left.linkCodes, []);
      assert.equal(left.summary.blocked, false);
      assert.deepEqual(report.results[0].whatsapp, left.summary);
      assert.deepEqual(minimalSubscriptionReceipt(state.receipts[0].payphone_response), { transactionId: 123 });
    });

    test('global ambiguous WhatsApp links allow quiescing and are reported as retained', async () => {
      const { pool, state, lifecycleDeps } = database({
        lifecycle: { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
          expires_at: new Date(NOW - 50 * DAY).toISOString(), recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() },
        candidates: [{ id: ID }], wa: { contacts: [], users: [], messages: [], states: [],
          links: [{ code: 'unattributed', target_url: 'https://wa.me/593000000000?text=PHI' }] },
      });
      const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 15000, ...lifecycleDeps,
        list: async () => assert.fail('Never delete before ownership proof') });
      assert.equal(report.complete, false);
      assert.equal(report.results[0].state, 'QUIESCING');
      assert.equal(state.schedule.state, 'QUIESCING');
      assert.equal(state.job.whatsapp.policy, 'preserve_ambiguous');
      assert.equal(state.job.whatsapp.retained.wa_short_links, 1);
      assert.equal(report.results[0].whatsapp.retained.wa_short_links, 1);
      assert.equal(state.wa.links.length, 1);
    });

const waLifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
  expires_at: new Date(NOW - 50 * DAY).toISOString(), recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
const waSqlJob = { mode: 'AUTOMATIC', state: 'RUNNING', phase: 'SQL',
  retryAfter: new Date(NOW - 1).toISOString(), backupRetentionUntil: new Date(NOW - DAY).toISOString(), deletedObjects: 0 };
const waExclusive = () => ({
  contacts: [{ id: 1, clinic_id: ID, phone: '593999000111' }, { id: 2, clinic_id: OTHER, phone: '593999000222' }],
  users: [{ id: 7, clinic_id: ID, phone: '0999000111' }, { id: 8, clinic_id: OTHER, phone: '0999000222' }],
  messages: [{ id: 1, contact_id: 1, booked_by_user_id: 7, owner_clinic_id: ID },
    { id: 2, contact_id: 1, booked_by_user_id: null, owner_clinic_id: null },
    { id: 3, contact_id: 2, booked_by_user_id: 8, owner_clinic_id: OTHER }],
  states: [{ id: 1, phone: '593999000111', data: { clinic_id: ID } }],
  links: [{ code: 'legacy-target', target_url: 'https://wa.me/593999000111?text=private-target' }],
});

test('SQL preserve_ambiguous preview, completion and retries distinguish retained global data from deletable rows', async () => {
  const wa = waExclusive();
  wa.contacts.push({ id: 3, clinic_id: null, phone: '593000000000' });
  wa.messages.push({ id: 4, contact_id: 3, booked_by_user_id: 7, owner_clinic_id: ID },
    { id: 5, contact_id: 999, booked_by_user_id: 7, owner_clinic_id: ID });
  wa.states.push({ phone: '593000000000', data: { clinic_id: ID, medicalNote: 'private-state' } });
  wa.links.push({ code: 'unattributed', target_url: 'https://wa.me/593000000000?text=private-link' },
    { code: `${OTHER}.${'a'.repeat(22)}`, target_url: 'https://wa.me/593000000000' },
    { code: 'invalid', target_url: 'private-invalid-url' });
  const { pool, state, lifecycleDeps } = database({ wa, lifecycle: waLifecycle, candidates: [{ id: ID }], job: waSqlJob });
  const originalClinic = structuredClone(state.clinic);
  const preview = await clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW });
  assert.equal(preview.eligible, true);
  assert.equal(preview.counts.whatsapp_contacts, 1);
  assert.equal(preview.counts.whatsapp_messages, 2);
  assert.deepEqual(preview.whatsapp.retained, {
    whatsapp_contacts: 1, whatsapp_messages: 2, whatsapp_bot_state: 1, wa_short_links: 3,
  });
  const deps = { pool, now: () => NOW, budgetMs: 15000, ...lifecycleDeps,
    list: async () => assert.fail('SQL-only test must not access R2'),
    remove: async () => assert.fail('SQL-only test must not delete R2') };
  const result = await purgeExpiredClinics(deps);
  assert.equal(result.completed, 1);
  assert.equal(result.results[0].state, 'COMPLETE');
  assert.deepEqual(result.results[0].whatsapp.retained, preview.whatsapp.retained);
  assert.ok(Object.values(result.results[0].whatsapp.deletable).every(n => n === 0));
  assert.deepEqual(state.wa.contacts, wa.contacts.slice(1));
  assert.deepEqual(state.wa.messages, wa.messages.slice(2));
  assert.deepEqual(state.wa.states, wa.states.slice(1));
  assert.deepEqual(state.wa.links, wa.links.slice(1));
  assert.deepEqual(state.clinic, originalClinic, 'subscription dates and inactive status are unchanged');
  const remaining = structuredClone(state.wa);
  const deletions = state.statements.filter(s => s.sql.startsWith('DELETE')).length;
  const retry = await purgeExpiredClinics(deps);
  assert.equal(retry.results[0].state, 'COMPLETE');
  assert.deepEqual(retry.results[0].whatsapp, result.results[0].whatsapp);
  assert.deepEqual(state.wa, remaining);
  assert.equal(state.statements.filter(s => s.sql.startsWith('DELETE')).length, deletions);
  for (const publicData of [preview.whatsapp, result, state.job.whatsapp]) {
    const text = JSON.stringify(publicData);
    for (const secret of ['593', 'private-', 'https:', 'medicalNote', 'legacy-target'])
      assert.equal(text.includes(secret), false);
  }
});

test('target ambiguous plus exclusive purges independent rows only, retaining the entire conflicting cluster', async () => {
  for (const conflict of ['foreign-author', 'unknown-author', 'target-author-on-foreign-contact', 'shared-phone']) {
    const wa = waExclusive();
    if (conflict === 'foreign-author') wa.messages[0].owner_clinic_id = OTHER;
    if (conflict === 'unknown-author') wa.messages[0].owner_clinic_id = null;
    if (conflict === 'target-author-on-foreign-contact') wa.messages[2].owner_clinic_id = ID;
    if (conflict === 'shared-phone') wa.users[1].phone = wa.contacts[0].phone;
    wa.contacts.push({ id: 4, clinic_id: ID, phone: '593999000444' });
    wa.messages.push({ id: 4, contact_id: 4, booked_by_user_id: 7, owner_clinic_id: ID });
    wa.states.push({ phone: '593999000444', data: { clinic_id: ID } });
    wa.links.push({ code: 'exclusive', target_url: 'https://wa.me/593999000444' });
    const { pool, state, lifecycleDeps } = database({ wa, lifecycle: waLifecycle, candidates: [{ id: ID }], job: waSqlJob });
    const preview = await clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW });
    assert.equal(preview.eligible, true);
    assert.equal(preview.whatsapp.blocked, false);
    assert.equal(preview.whatsapp.retained.whatsapp_contacts, 1);
    assert.equal(preview.whatsapp.retained.whatsapp_messages, conflict === 'target-author-on-foreign-contact' ? 1 : 2);
    const result = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 15000, ...lifecycleDeps,
      list: async () => assert.fail('SQL-only test') });
    assert.equal(result.results[0].state, 'COMPLETE');
    assert.deepEqual(result.results[0].whatsapp.retained, preview.whatsapp.retained);
    const retainedContact = conflict === 'target-author-on-foreign-contact' ? 2 : 1;
    assert.deepEqual(state.wa.contacts, [wa.contacts.find(c => c.id === retainedContact),
      ...wa.contacts.filter(c => c.clinic_id === OTHER && c.id !== retainedContact)]);
    assert.deepEqual(state.wa.messages.filter(m => m.contact_id === retainedContact),
      wa.messages.filter(m => m.contact_id === retainedContact));
    assert.equal(state.wa.contacts.some(c => c.id === 4), false);
    assert.equal(state.wa.messages.some(m => m.contact_id === 4), false);
    if (retainedContact === 1) {
      assert.deepEqual(state.wa.states, [wa.states[0]]);
      assert.deepEqual(state.wa.links, [wa.links[0]]);
    }
  }
});

test('SQL revalidation under WhatsApp locks retains newly crossed target cluster and new global ambiguity', async () => {
  for (const crossed of ['history', 'scoped-link', null]) {
    const { pool, state, lifecycleDeps } = database({
      wa: waExclusive(), lifecycle: waLifecycle, candidates: [{ id: ID }], job: waSqlJob,
      onWhatsAppLock: current => {
        if (crossed === 'history') current.wa.messages[0].owner_clinic_id = OTHER;
        else if (crossed === 'scoped-link') current.wa.links.push({
          code: `${OTHER}.${'c'.repeat(22)}`, target_url: current.wa.links[0].target_url,
        });
        else current.wa.links.push({ code: 'new-global', target_url: 'not-attributable' });
      },
    });
    const result = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 15000, ...lifecycleDeps,
      list: async () => assert.fail('SQL-only test') });
    assert.equal(state.waLocks, 1);
    if (crossed) {
      assert.equal(result.results[0].state, 'COMPLETE');
      assert.equal(state.job.whatsapp.retained.whatsapp_messages, 2);
      const expected = waExclusive();
      if (crossed === 'history') expected.messages[0].owner_clinic_id = OTHER;
      else expected.links.push({ code: `${OTHER}.${'c'.repeat(22)}`, target_url: expected.links[0].target_url });
      for (const key of ['contacts', 'messages', 'states', 'links']) assert.deepEqual(state.wa[key], expected[key]);
    } else {
      assert.equal(result.results[0].state, 'COMPLETE');
      assert.equal(state.job.whatsapp.retained.wa_short_links, 1);
      assert.deepEqual(state.wa.links, [{ code: 'new-global', target_url: 'not-attributable' }]);
    }
  }
});

test('SQL consecutive A then B purges keep tombstone phone evidence and never claim shared states or links', async () => {
  const wa = waExclusive();
  // Neither shared phone has a contact: attribution depends entirely on users.
  const shared = ['593999000777', '593999000888'];
  wa.users[0] = { ...wa.users[0], phone: shared[0], whatsapp_staff_phone: shared[1],
    is_active: true, password_hash: 'secret', salt: 'salt', hash_algo: 'hash',
    google_refresh_token: 'oauth-secret', password_reset_token: 'reset-secret' };
  wa.users[1] = { ...wa.users[1], phone: shared[0], whatsapp_staff_phone: shared[1] };
  wa.states = shared.map(phone => ({ phone, data: { medicalNote: 'retained' } }));
  wa.links = shared.flatMap((phone, i) => [
    { code: `legacy-${i}`, target_url: `https://wa.me/${phone}?text=private` },
    { code: `${OTHER}.${String(i).repeat(22)}`, target_url: `https://wa.me/${phone}` },
  ]);
  const run = async (id, data) => {
    const db = database({ wa: data, lifecycle: waLifecycle, candidates: [{ id }],
      clinic: { id }, job: structuredClone(waSqlJob) });
    const result = await purgeExpiredClinics({ pool: db.pool, now: () => NOW, budgetMs: 15000, ...db.lifecycleDeps,
      list: async () => assert.fail('SQL-only A→B test'), remove: async () => assert.fail('No R2') });
    assert.equal(result.results[0].state, 'COMPLETE');
    assert.deepEqual(db.state.wa.states, wa.states);
    assert.deepEqual(db.state.wa.links, wa.links);
    return db;
  };
  const a = await run(ID, wa);
  const tombstone = a.state.wa.users.find(u => u.clinic_id === ID);
  assert.deepEqual([tombstone.phone, tombstone.whatsapp_staff_phone], shared);
  assert.equal(tombstone.is_active, false);
  assert.equal(tombstone.password_hash, '');
  for (const field of ['salt', 'hash_algo', 'google_refresh_token', 'password_reset_token'])
    assert.equal(tombstone[field], null);
  const b = await run(OTHER, a.state.wa);
  assert.deepEqual(b.state.wa.users.find(u => u.clinic_id === ID), tombstone);
  assert.equal(b.state.wa.contacts.length, 0);
  assert.equal(b.state.wa.messages.length, 0);
  assert.equal(b.state.job.whatsapp.retained.whatsapp_bot_state, 2);
  assert.equal(b.state.job.whatsapp.retained.wa_short_links, 4);
});

test('SQL consecutive A then B retains contact-only evidence against contradictory scoped links', async () => {
  const wa = waExclusive();
  wa.users = []; // P is known only through A's contact, never through a tombstone.
  wa.contacts[0].name = 'Fictitious retained contact';
  wa.contacts.push({ id: 4, clinic_id: ID, phone: '593999000444' });
  wa.messages.push({ id: 4, contact_id: 4, booked_by_user_id: null, owner_clinic_id: null });
  wa.links.push({ code: `${OTHER}.${'c'.repeat(22)}`, target_url: wa.links[0].target_url });
  const cluster = {
    contacts: [structuredClone(wa.contacts[0])],
    messages: structuredClone(wa.messages.slice(0, 2)),
    states: structuredClone(wa.states),
    links: structuredClone(wa.links),
  };
  let remaining = wa;
  for (const id of [ID, OTHER, ID]) {
    const db = database({ wa: remaining, lifecycle: waLifecycle, candidates: [{ id }],
      clinic: { id }, job: structuredClone(waSqlJob) });
    const preview = await clinicPurgePreview(id, db.pool, { ...db.lifecycleDeps, now: () => NOW });
    assert.equal(preview.eligible, true);
    assert.deepEqual(preview.whatsapp.retained, {
      whatsapp_contacts: 1, whatsapp_messages: 2, whatsapp_bot_state: 1, wa_short_links: 2,
    });
    const result = await purgeExpiredClinics({ pool: db.pool, now: () => NOW, budgetMs: 15000, ...db.lifecycleDeps,
      list: async () => assert.fail('SQL-only A→B test'), remove: async () => assert.fail('No R2') });
    assert.equal(result.results[0].state, 'COMPLETE');
    assert.deepEqual(result.results[0].whatsapp.retained, preview.whatsapp.retained);
    assert.deepEqual(db.state.wa.contacts.filter(c => c.id === 1), cluster.contacts);
    assert.deepEqual(db.state.wa.messages.filter(m => m.contact_id === 1), cluster.messages);
    assert.deepEqual(db.state.wa.states, cluster.states);
    assert.deepEqual(db.state.wa.links, cluster.links);
    const deletion = db.state.statements.find(s => s.sql.startsWith('DELETE FROM whatsapp_messages'));
    assert.equal(deletion.params[0].includes(1), false);
    assert.equal(db.state.wa.contacts.some(c => c.id === 4), false);
    remaining = db.state.wa;
  }
  assert.deepEqual(remaining.contacts, cluster.contacts);
  assert.deepEqual(remaining.messages, cluster.messages);
});

test('SQL failure rolls back exclusive deletions and leaves conflicting clusters and target-authored orphans intact', async () => {
  const wa = waExclusive();
  wa.users = [];
  wa.links.push({ code: `${OTHER}.${'c'.repeat(22)}`, target_url: wa.links[0].target_url });
  wa.contacts.push({ id: 4, clinic_id: ID, phone: '593999000444' },
    { id: 5, clinic_id: null, phone: '593999000555' });
  wa.messages.push({ id: 4, contact_id: 4, booked_by_user_id: 7, owner_clinic_id: ID },
    { id: 5, contact_id: 5, booked_by_user_id: 7, owner_clinic_id: ID },
    { id: 6, contact_id: 999, booked_by_user_id: 7, owner_clinic_id: ID });
  const db = database({ wa, sqlFails: true, lifecycle: waLifecycle, candidates: [{ id: ID }], job: waSqlJob });
  const report = await purgeExpiredClinics({ pool: db.pool, now: () => NOW, budgetMs: 15000, ...db.lifecycleDeps,
    list: async () => assert.fail('SQL-only test') });
  assert.equal(report.results[0].state, 'FAILED');
  assert.deepEqual(db.state.wa, wa, 'rollback restores exclusive rows too, preserving all original evidence');
  assert.equal(db.state.job.state, 'FAILED');
  assert.ok(db.state.statements.some(s => s.sql === 'ROLLBACK'));
  const deleted = db.state.statements.find(s => s.sql.startsWith('DELETE FROM whatsapp_messages'));
  assert.deepEqual(deleted.params[0], [4], 'no conflicting cluster or orphan is ever selected, even before rollback');
});

test('WA bounds still reject oversized global scans and tenant deletion counts without writes', async () => {
  const largeGlobal = waExclusive();
  largeGlobal.contacts = Array.from({ length: 50001 }, (_, id) => ({ id, phone: '', clinic_id: null }));
  for (const options of [{ wa: largeGlobal }, { wa: waExclusive(), counts: { patients: 50001 } }]) {
    const { pool, state, lifecycleDeps } = database({ ...options, lifecycle: waLifecycle });
    await assert.rejects(clinicPurgePreview(ID, pool, { ...lifecycleDeps, now: () => NOW }),
      error => error.status === 409 && /50.000/.test(error.message));
    assert.equal(state.job, null);
    assert.equal(state.statements.some(s => /^(DELETE|UPDATE|INSERT)/.test(s.sql)), false);
  }
});

test('automatic backup phase durably waits and retries without deleting encrypted backups or reporting completion', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  const { pool, state, lifecycleDeps } = database({
    candidates: [{ id: ID }], lifecycle,
    job: { mode: 'AUTOMATIC', state: 'RUNNING', phase: 'BACKUPS',
      retryAfter: new Date(NOW - 1).toISOString(), backupRetentionUntil: new Date(NOW + 30 * DAY).toISOString(),
      deletedObjects: 0 },
  });
  let lists = 0, deletes = 0;
  const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async prefix => {
      lists++;
      assert.equal(prefix, `backups/${ID}/`);
      return { objects: [{ key: `backups/${ID}/auto/2026-10-01.json.gz.enc` }], truncated: false };
    },
    remove: async () => { deletes++; } });
  assert.equal(report.completed, 0);
  assert.equal(report.waiting, 1);
  assert.equal(report.results[0].state, 'WAITING_STORAGE');
  assert.equal(state.job.state, 'WAITING_STORAGE');
  assert.equal(state.job.phase, 'BACKUPS');
  assert.equal(state.job.waitingStorage.pendingObjects, 1);
  assert.equal(Date.parse(state.job.retryAfter), NOW + 24 * 60 * 60000);
  assert.equal(lists, 1);
  assert.equal(deletes, 0);

  const retry = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => { lists++; return { objects: [] }; },
    remove: async () => { deletes++; } });
  assert.equal(retry.results[0].state, 'WAITING_STORAGE');
  assert.equal(lists, 1, 'the persisted retry time avoids an early storage poll');
  assert.equal(deletes, 0);
});

test('automatic cron reports a partial run when its execution budget expires', async () => {
  const { pool, state, lifecycleDeps } = database({ candidates: [{ id: ID }] });
  let ticks = 0;
  const report = await purgeExpiredClinics({ pool, now: () => ticks++ ? NOW + 2 : NOW,
    budgetMs: 1, ...lifecycleDeps });
  assert.equal(report.scanned, 1);
  assert.equal(report.budgetExhausted, true);
  assert.equal(report.results.length, 0);
  assert.equal(state.job, null);
});

test('mature encrypted backups delete only after unlock, and SQL waits for a fresh empty listing', async () => {
  const lifecycle = { policy: 'paid', auto_purge_eligible: true, state: 'CLOSED',
    expires_at: new Date(NOW - 50 * DAY).toISOString(),
    recovery_ends_at: new Date(NOW - 5 * DAY).toISOString() };
  const { pool, state, lifecycleDeps } = database({
    candidates: [{ id: ID }], lifecycle,
    job: { mode: 'AUTOMATIC', state: 'RUNNING', phase: 'BACKUPS',
      retryAfter: new Date(NOW - 1).toISOString(),
      backupRetentionUntil: new Date(NOW - 1).toISOString(), deletedObjects: 0 },
  });
  const retainedKey = `backups/${ID}/auto/old.json.gz.enc`;
  let deletes = 0;
  const report = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => ({ objects: [{ key: retainedKey, lastModified: new Date(NOW - 30 * DAY).toISOString() }], truncated: false }),
    remove: async () => { deletes++; } });
  assert.equal(report.completed, 0);
  assert.equal(state.job.phase, 'BACKUPS');
  assert.equal(deletes, 1);
  const retry = await purgeExpiredClinics({ pool, now: () => NOW, budgetMs: 10000, ...lifecycleDeps,
    list: async () => ({ objects: [], truncated: false }), remove: async () => assert.fail('Already empty') });
  assert.equal(retry.completed, 1);
  assert.equal(state.job.state, 'COMPLETE');
});
