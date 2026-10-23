import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let events = [], readers = 0, writer = null, waiters = [], nextId = 0;
const reading = new Set();
const wake = () => { const waiting = waiters; waiters = []; waiting.forEach(resolve => resolve()); };
const until = async condition => { while (!condition()) await new Promise(resolve => waiters.push(resolve)); };
const pool = { connect: async () => {
  const id = ++nextId;
  return {
    async query(text) {
      events.push({ id, text });
      if (text.includes('pg_advisory_xact_lock_shared(')) {
        await until(() => writer == null); readers++; reading.add(id);
      } else if (text.includes('pg_advisory_xact_lock(')) {
        await until(() => readers === 0 && writer == null); writer = id;
      } else if (text === 'COMMIT' || text === 'ROLLBACK') {
        if (reading.delete(id)) readers--;
        if (writer === id) writer = null;
        wake();
      }
      return { rows: [] };
    },
    release(error) { events.push({ id, release: error || true }); },
  };
} };
mock.module(new URL('../lib/neon-clinical-db.js', import.meta.url).href, { namedExports: { getPool: () => pool } });
const { reserveIdentities, withIdentityReadLock, assertUserAliases, assertClinicAliases } = await import('../lib/identity-reservations.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test.beforeEach(() => { events = []; readers = 0; writer = null; waiters = []; nextId = 0; reading.clear(); });

test('real wrapper is reentrant, pins a transaction through external completion, and rolls back after errors', async () => {
  await assert.rejects(withIdentityReadLock(async () => {
    assert.equal(readers, 1);
    await withIdentityReadLock(async () => assert.equal(readers, 1));
    throw new Error('fictitious failure');
  }), /fictitious failure/);
  assert.equal(readers, 0);
  assert.equal(events.filter(e => e.text?.includes('pg_advisory_xact_lock_shared(')).length, 1);
  assert.equal(events.filter(e => e.text === 'ROLLBACK').length, 1);
  assert.equal(events.some(e => e.text?.includes('pg_advisory_lock_shared(')), false);
  assert.equal(events.filter(e => e.release).length, 1);
});

test('release cannot commit before an existing send finishes and a new reader waits for release COMMIT', async () => {
  const sending = deferred(), finish = deferred(), released = deferred(), commit = deferred();
  const send = withIdentityReadLock(async () => { sending.resolve(); await finish.promise; });
  await sending.promise;
  const db = await pool.connect();
  const purge = (async () => {
    await reserveIdentities(db); released.resolve(); await commit.promise;
    await db.query('COMMIT'); db.release();
  })();
  let purging = false;
  released.promise.then(() => { purging = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(purging, false);
  finish.resolve(); await send; await released.promise;
  let newReader = false;
  const incoming = withIdentityReadLock(async () => { newReader = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(newReader, false);
  commit.resolve(); await purge; await incoming;
  assert.equal(newReader, true);
  assert.equal(readers, 0);
});

test('alias checks compare normalized live aliases only, permit archived aliases and reserve technical namespace', async () => {
  const live = [{ id: 8, username: 'new_owner', email: 'new@example.test' }];
  const db = { query: async (text, values) => {
    if (text.includes('FROM clinic_users WHERE lower')) {
      const key = text.includes('btrim(email)') ? 'email' : 'username';
      return { rows: live.filter(row => row.id !== values[1] && row[key] === values[0]) };
    }
    if (text.includes('SELECT id,phone FROM clinics')) return { rows: [{ id: 'other', phone: '0999000111' }] };
    return { rows: [] };
  } };
  await assertUserAliases(db, { username: 'old_alias', email: 'old@example.test' });
  await assert.rejects(assertUserAliases(db, { username: ' NEW_OWNER ' }), { status: 409 });
  await assert.rejects(assertUserAliases(db, { email: ' NEW@EXAMPLE.TEST ' }), { status: 409 });
  await assert.rejects(assertUserAliases(db, { username: '!purged:123' }), { status: 400 });
  await assert.rejects(assertClinicAliases(db, { phone: '+593 999 000 111' }), { status: 409 });
});

test('clinic phone claims reject normalized active foreign contacts but allow own and retired contacts', async () => {
  const own = '11111111-2222-4333-8444-555555555555';
  const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let contacts = [{ phone: '0999000111', clinic_id: other, retired_at: null }];
  const db = { query: async (text, values) => {
    if (!text.includes('FROM whatsapp_contacts')) return { rows: [] };
    assert.match(text, /retired_at IS NULL/);
    assert.match(text, /clinic_id IS DISTINCT FROM \$1/);
    return { rows: contacts.filter(c => !c.retired_at && c.clinic_id && c.clinic_id !== values[0]) };
  } };
  await assert.rejects(assertClinicAliases(db, { id: own, phone: '+593 999 000 111' }), { status: 409 });
  await assert.rejects(assertClinicAliases(db, { phone: '00593999000111' }), { status: 409 });
  contacts = [{ phone: '0999000111', clinic_id: own, retired_at: null }];
  await assertClinicAliases(db, { id: own, phone: '+593999000111' });
  contacts = [{ phone: '0999000111', clinic_id: other, retired_at: new Date().toISOString() }];
  await assertClinicAliases(db, { id: own, phone: '+593999000111' });
});
