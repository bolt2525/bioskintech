import assert from 'node:assert/strict';
import test from 'node:test';
import { lockClinicWriters, reserveClinicLifecycle, requireClinicWritable, unlockClinicWriters } from '../lib/clinic-lifecycle.js';
import { createSnapshot, restoreBackupDocument } from '../api/backup.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
process.env.BACKUP_ENCRYPTION_KEY = 'test-key-'.padEnd(48, 'x');
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function lifecycleDatabase() {
  const state = { shares: 0, exclusive: false, active: true, purging: false, statements: [] };
  const connection = () => {
    let shares = 0;
    let exclusive = false;
    return {
      async query(sql, params = []) {
        state.statements.push({ sql, params });
        if (sql.includes('pg_try_advisory_xact_lock')) {
          const acquired = !state.shares && !state.exclusive;
          if (acquired) state.exclusive = exclusive = true;
          return { rows: [{ acquired }] };
        }
        if (/pg_advisory_(xact_lock_shared|lock_shared)/.test(sql)) {
          assert.equal(state.exclusive, false, 'the writer must never enter a reserved lifecycle transition');
          state.shares++; shares++;
          return { rows: [] };
        }
        if (sql.includes('pg_advisory_unlock_shared')) {
          state.shares--; shares--;
          return { rows: [] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          state.shares -= shares; shares = 0;
          if (exclusive) { state.exclusive = exclusive = false; }
          return { rows: [] };
        }
        if (sql.includes("SELECT c.is_active,cs.general ? '_purge'"))
          return { rows: [{ is_active: state.active, purging: state.purging }] };
        if (sql.includes('SELECT true AS purge')) return { rows: state.purging ? [{ purge: true }] : [] };
        if (sql.startsWith('SELECT name FROM clinics')) return { rows: [{ name: 'Clinica ficticia' }] };
        if (sql.includes('information_schema.columns')) return { rows: ['id', 'first_name', 'clinic_id', 'rut', 'identification_number'].map(column_name => ({ column_name })) };
        if (sql.startsWith('SELECT clinic_id FROM patients')) return { rows: [] };
        if (sql.startsWith('INSERT INTO patients')) return { rows: [], rowCount: 1 };
        return { rows: [] };
      },
      release() { assert.equal(shares, 0); assert.equal(exclusive, false); },
    };
  };
  return { state, connection, pool: { connect: async () => connection(), query: async (...args) => connection().query(...args) } };
}

test('session-scoped signing writers serialize deactivation and token revocation across nested transactions', async () => {
  const { connection, state } = lifecycleDatabase();
  const signing = connection(), deactivate = connection();
  await lockClinicWriters(signing, [ID], { session: true });
  await requireClinicWritable(signing, ID);
  await assert.rejects(reserveClinicLifecycle(deactivate, ID), { status: 409 });
  assert.equal(state.shares, 1);
  // The actual record handler holds this session lock while generating/verifying/submitting a token.
  await unlockClinicWriters(signing, [ID]);
  await reserveClinicLifecycle(deactivate, ID);
  state.active = false;
  await deactivate.query('COMMIT');
  await lockClinicWriters(signing, [ID], { session: true });
  await assert.rejects(requireClinicWritable(signing, ID), { status: 409 });
  await unlockClinicWriters(signing, [ID]);
});

test('restore acquires sorted source/destination locks in its writing transaction before tombstone checks and INSERT', async () => {
  const { pool, state, connection } = lifecycleDatabase();
  const insertStarted = deferred(), finishInsert = deferred();
  const originalConnect = pool.connect;
  pool.connect = async () => {
    const db = await originalConnect(), query = db.query.bind(db);
    db.query = async (sql, params) => {
      if (sql.startsWith('INSERT INTO patients')) {
        insertStarted.resolve();
        await finishInsert.promise;
      }
      return query(sql, params);
    };
    return db;
  };
  const restore = restoreBackupDocument(pool, { metadata: { clinic_id: OTHER },
    modules: { patients: { tables: { patients: [{ id: 1, first_name: 'Ficticio' }] } } } }, ID, { dryRun: false });
  await insertStarted.promise;
  assert.equal(state.shares, 2);
  const purge = connection();
  await assert.rejects(reserveClinicLifecycle(purge, ID), { status: 409 });
  finishInsert.resolve();
  assert.equal((await restore).committed, true);
  await reserveClinicLifecycle(purge, ID);
  state.purging = true;
  await purge.query('COMMIT');
  await assert.rejects(restoreBackupDocument(pool, { metadata: { clinic_id: OTHER }, modules: {} }, ID), { status: 409 });
  const locks = state.statements.filter(s => s.sql.includes('pg_advisory_xact_lock_shared'));
  assert.deepEqual(locks.slice(0, 2).map(s => s.params[0]), [ID, OTHER].sort());
  assert.equal(state.statements.filter(s => s.sql.startsWith('INSERT INTO patients')).length, 1);
});

test('snapshot collected before purge cannot PUT after a tombstone is committed', async () => {
  const { pool, connection, state } = lifecycleDatabase();
  const collected = deferred(), finishCollect = deferred();
  let puts = 0;
  const snapshot = createSnapshot(pool, ID, 'auto', 'qa', {
    collect: async () => { collected.resolve(); await finishCollect.promise; return {}; },
    put: async () => { puts++; },
  });
  await collected.promise;
  const purge = connection();
  await reserveClinicLifecycle(purge, ID);
  state.purging = true;
  await purge.query('COMMIT');
  finishCollect.resolve();
  await assert.rejects(snapshot, { status: 409 });
  assert.equal(puts, 0);
});

test('snapshot in-flight PUT holds the shared reservation; purge cannot begin until it settles', async () => {
  const previous = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_ENCRYPTION_KEY = 'test-key-'.padEnd(48, 'x');
  try {
    const { pool, connection, state } = lifecycleDatabase();
    const putting = deferred(), finishPut = deferred();
    const snapshot = createSnapshot(pool, ID, 'manual', 'qa', {
      collect: async () => ({}),
      put: async (_key, _body, _type, options) => {
        assert.ok(options.abortSignal);
        putting.resolve();
        await finishPut.promise;
      },
    });
    await putting.promise;
    assert.equal(state.shares, 1);
    const purge = connection();
    await assert.rejects(reserveClinicLifecycle(purge, ID), { status: 409 });
    finishPut.resolve();
    assert.match((await snapshot).key, new RegExp(`^backups/${ID}/manual/`));
    assert.equal(state.shares, 0);
    await reserveClinicLifecycle(purge, ID);
    await purge.query('COMMIT');
  } finally {
    if (previous === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = previous;
  }
});
