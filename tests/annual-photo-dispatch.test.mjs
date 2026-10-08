import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const REQUEST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 's'.repeat(40);
Object.assign(process.env, {
  ANNUAL_PHOTO_BACKUP_ENABLED: 'true', ANNUAL_PHOTO_BACKUP_WORKER_URL: 'https://worker.example.test/dispatch',
  ANNUAL_PHOTO_BACKUP_SECRET: SECRET, EMAIL_USER: 'robot@example.test', EMAIL_PASS: 'x',
  ANNUAL_PHOTO_BACKUP_MASTER_EMAIL: 'master@example.test', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 'k',
});

let auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
let handleQuery = () => ({ rows: [] });
const signed = [];
const deleted = [];
let deleteFails = false;
let deleteHook = null;
let clinicActive = true;
let clinicPurging = false;
const tenantCalls = [];
const client = {
  query: async (sql, params = []) => sql.includes('AS annual_schema_ready')
    ? { rows: [{ annual_schema_ready: true }] }
    : sql.includes('AS entitled')
    ? { rows: [{ id: REQUEST, clinic_id: CLINIC, entitled: true, entitlement_kind: 'FREE' }] }
    : sql.includes('AS paid_subscription')
    ? { rows: [{ is_active: clinicActive, purging: clinicPurging,
      general: clinicPurging ? { _purge: {} } : {}, subscription_expires_at: new Date(Date.now()+86400000).toISOString() }] }
    : sql.includes('AS request_deadline_at')
    ? { rows: [{ id: REQUEST, starts_at: new Date(Date.now()-364*86400000).toISOString(),
      ends_at: new Date(Date.now()+86400000).toISOString(), request_deadline_at: new Date(Date.now()+86400000).toISOString() }] }
    : sql.includes("SELECT c.is_active,cs.general ? '_purge'")
    ? { rows: [{ is_active: clinicActive, purging: clinicPurging }] }
    : (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql.trim()) ? { rows: [] } : handleQuery(sql, params)),
  release() {},
};
const url = path => new URL(path, import.meta.url).href;
mock.module(url('../lib/admin-auth.js'), { namedExports: { authenticateRequest: async () => auth } });
mock.module(url('../lib/neon-clinical-db.js'), {
  namedExports: {
    getPool: () => ({ connect: async () => client, query: (...args) => client.query(...args) }),
    getAppPool: () => { throw new Error('No se esperaba appPool'); },
    withTenantContext: async (_clinicId, fn, options = {}) => { tenantCalls.push(options); return fn(client); },
  },
});
mock.module(url('../lib/r2-service.js'), {
  namedExports: {
    generateDownloadUrl: async (key, filename, ttl) => { signed.push({ key, ttl }); return `https://r2.example.test/${key}`; },
    r2ObjectExists: async () => true,
    putR2Object: async () => {},
    deleteR2Object: async key => {
      if (deleteHook) await deleteHook(key);
      if (deleteFails) throw new Error('R2');
      deleted.push(key);
    },
  },
});
mock.module(url('../lib/backup-service.js'), { namedExports: { collectClinicData: async () => ({}) } });
mock.module(url('../lib/portable-clinical-export.js'), { namedExports: { buildPortableDocuments: async () => [] } });

const { handleAnnualPhotoBackup, photoBackupDownloadTtl } = await import('../lib/annual-photo-backup.js');

const res = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const approveReq = () => ({ method: 'POST', headers: {}, query: {}, body: { requestId: REQUEST, clinicId: CLINIC } });

function dispatchDb(job) {
  return (sql, params) => {
    if (/SELECT id,clinic_id,status,/.test(sql)) return { rows: [{ id: REQUEST, clinic_id: CLINIC, status: 'APPROVED', expired: job.expired || false }] };
    if (/SET dispatch_status='DISPATCHING'/.test(sql)) {
      Object.assign(job, { dispatch_status: 'DISPATCHING', dispatch_token: params[2], last_error: null });
      return { rows: [{ id: REQUEST }] };
    }
    if (/SET dispatch_status=\$3,last_error=\$4/.test(sql)) {
      // Emulates the SQL predicate: only the owner of the current token may settle.
      const cas = /dispatch_status='DISPATCHING' AND dispatch_token=\$5/.test(sql);
      if (job.status !== 'APPROVED' || (cas && (job.dispatch_status !== 'DISPATCHING' || job.dispatch_token !== params[4]))) return { rows: [] };
      Object.assign(job, { dispatch_status: params[2], last_error: params[3] });
      return { rows: [{ id: REQUEST }] };
    }
    return { rows: [] };
  };
}

test('CAS: un Fail del Worker durante el despacho no se sobrescribe', async t => {
  const job = { status: 'APPROVED', dispatch_status: 'PENDING', last_error: null };
  handleQuery = dispatchDb(job);
  t.mock.method(globalThis, 'fetch', async () => {
    Object.assign(job, { dispatch_status: 'FAILED', last_error: 'UPLOAD_FAILED' }); // carrera: Worker Fail
    return { ok: true, body: null };
  });
  const r = res();
  await handleAnnualPhotoBackup(approveReq(), r, 'approvePhotoBackup');
  assert.equal(job.dispatch_status, 'FAILED');
  assert.equal(job.last_error, 'UPLOAD_FAILED');
  assert.equal(r.body.superseded, true);
});

test('CAS: sin carrera el despacho queda SENT; un fallo de red queda FAILED reintentable', async t => {
  const job = { status: 'APPROVED', dispatch_status: 'PENDING', last_error: null };
  handleQuery = dispatchDb(job);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body: null }));
  const ok = res();
  await handleAnnualPhotoBackup(approveReq(), ok, 'approvePhotoBackup');
  assert.equal(job.dispatch_status, 'SENT');
  assert.equal(ok.code, 200);
  assert.equal(fetchMock.mock.calls[0].arguments[1].redirect, 'error');

  Object.assign(job, { dispatch_status: 'FAILED' });
  fetchMock.mock.mockImplementation(async () => { throw new Error('network'); });
  const failed = res();
  await handleAnnualPhotoBackup(approveReq(), failed, 'approvePhotoBackup');
  assert.equal(job.dispatch_status, 'FAILED');
  assert.equal(job.last_error, 'DISPATCH_FAILED');
  assert.equal(failed.code, 502);
  assert.equal(failed.body.success, false);
});

test('TTL de descarga: min(300 s, resto de la ventana de 24 h)', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(photoBackupDownloadTtl(new Date(now - 3600000).toISOString(), now), 300);
  assert.equal(photoBackupDownloadTtl(new Date(now - 86400000 + 90000).toISOString(), now), 90);
  assert.ok(photoBackupDownloadTtl(new Date(now - 86400000).toISOString(), now) < 1);
  assert.equal(photoBackupDownloadTtl('invalid', now), 0);

  auth = { valid: true, id: 7, role: 'clinic_admin', clinic_id: CLINIC };
  const readyAt = new Date(Date.now() - 3600000).toISOString();
  handleQuery = sql => {
    if (/SELECT id,ready_at FROM annual_photo_backup_requests/.test(sql)) return { rows: [{ id: REQUEST, ready_at: readyAt }] };
    if (/SELECT part_number,r2_key/.test(sql)) return { rows: [{ part_number: 1, size_bytes: 10, sha256: 'a'.repeat(64) }] };
    return { rows: [] };
  };
  signed.length = 0;
  const post = res();
  await handleAnnualPhotoBackup({ method: 'POST', headers: {}, query: {}, body: { requestId: REQUEST, index: 0 } }, post, 'photoBackupDownload');
  assert.equal(post.body.expiresIn, 300);
  const get = res();
  await handleAnnualPhotoBackup({ method: 'GET', headers: {}, query: { requestId: REQUEST } }, get, 'photoBackupDownload');
  assert.deepEqual(signed.map(s => s.ttl), [300, 300]);
  assert.equal(signed[0].key, `annual-photo-backups/${CLINIC}/${REQUEST}/part-0001.zip`);
  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
});

// In-memory row emulating the reservation predicates: a reserved row is never
// handed out twice and only the reservation owner can settle it.
function maintenanceDb(updates, row = { status: 'READY', reserved: false, token: null }) {
  const base = `annual-photo-backups/${CLINIC}/${REQUEST}/`;
  return (sql, params) => {
    if (/SET snapshot_data=NULL,snapshot_purged_at=now\(\)\s+WHERE id IN/.test(sql)) return { rows: [], rowCount: 2 };
    if (/FOR UPDATE SKIP LOCKED/.test(sql) && /cleanup_lease_until IS NULL OR cleanup_lease_until <= now\(\)/.test(sql))
      return { rows: row.reserved || row.done ? [] : [{ id: REQUEST, clinic_id: CLINIC, status: row.status, sources: true, artifacts: true }] };
    if (/SET cleanup_token=\$3/.test(sql)) { Object.assign(row, { reserved: true, token: params[2] }); row.expired = row.status === 'APPROVED'; return { rows: [] }; }
    if (/SELECT expected_key,documents/.test(sql)) return { rows: [{
      expected_key: `${base}part-0001.zip`,
      documents: [{ key: `${base}source/bundle-0001.json` }, { key: `annual-photo-backups/${CLINIC}/otra/source/x.json` }, { key: `${base}source/../../x` }],
    }] };
    if (/sources_deleted_at=CASE/.test(sql)) {
      assert.match(sql, /cleanup_token=\$3/);
      if (params[2] === row.token) { updates.push(params); if (params[3] === null) Object.assign(row, { reserved: false, done: true }); }
      return { rows: [] };
    }
    if (/previous|cleaning/.test(sql)) return { rows: [{ id: REQUEST, status: 'APPROVED', last_error: 'SOURCES_EXPIRED',
      cleaning: row.reserved, expired_at: row.expired ? '2026-10-06T12:00:00Z' : null }] };
    if (/SELECT id FROM annual_photo_backup_periods/.test(sql)) return { rows: [{ id: 'p' }] };
    if (/SELECT email FROM clinic_users/.test(sql)) return { rows: [{ email: 'admin@example.test' }] };
    return { rows: [] };
  };
}
const maintenanceReq = auth => ({ method: 'POST', headers: { authorization: auth }, query: {}, body: {} });

test('Mantenimiento: exige secreto de servicio y solo borra claves del prefijo propio', async () => {
  const updates = [];
  handleQuery = maintenanceDb(updates);
  const denied = res();
  await handleAnnualPhotoBackup(maintenanceReq('Bearer incorrecto'), denied, 'photoBackupWorkerMaintenance');
  assert.equal(denied.code, 401);

  deleted.length = 0; deleteFails = false;
  const r = res();
  await handleAnnualPhotoBackup(maintenanceReq(`Bearer ${SECRET}`), r, 'photoBackupWorkerMaintenance');
  assert.equal(r.code, 200);
  assert.equal(r.body.state, 'maintenance_done');
  assert.equal(r.body.snapshotsPurged, 2);
  assert.deepEqual(deleted, [
    `annual-photo-backups/${CLINIC}/${REQUEST}/source/bundle-0001.json`,
    `annual-photo-backups/${CLINIC}/${REQUEST}/part-0001.zip`,
  ]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][3], null);
});

test('Mantenimiento: caduca APPROVED antiguo y bloquea la reapertura mientras borra', async () => {
  const updates = [];
  const row = { status: 'APPROVED', reserved: false, token: null };
  handleQuery = maintenanceDb(updates, row);
  let reopenDuringDelete;
  deleted.length = 0;
  deleteHook = async () => {
    auth = { valid: true, id: 7, role: 'clinic_admin', clinic_id: CLINIC };
    const r = res();
    await handleAnnualPhotoBackup({ method: 'POST', headers: {}, query: {}, body: {} }, r, 'requestPhotoBackup');
    auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
    reopenDuringDelete = r;
  };
  const r = res();
  await handleAnnualPhotoBackup(maintenanceReq(`Bearer ${SECRET}`), r, 'photoBackupWorkerMaintenance');
  deleteHook = null;
  assert.equal(r.body.expired, 1);
  assert.equal(row.expired, true);
  assert.equal(reopenDuringDelete.code, 409);
  assert.match(reopenDuringDelete.body.error, /Limpieza/);
  assert.equal(deleted.length, 2);
  assert.equal(row.reserved, false);
  auth = { valid: true, id: 7, role: 'clinic_admin', clinic_id: CLINIC };
  const expired = res();
  await handleAnnualPhotoBackup({ method: 'POST', headers: {}, query: {}, body: {} }, expired, 'requestPhotoBackup');
  assert.equal(expired.code, 409);
  assert.match(expired.body.error, /caducó/);
  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
});

test('Mantenimiento: un borrado colgado expira a los 10 s y conserva la reserva', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-06T12:00:00Z') });
  const updates = [];
  const row = { status: 'READY', reserved: false, token: null };
  handleQuery = maintenanceDb(updates, row);
  deleteHook = () => new Promise(() => {});
  const pending = (async () => { const r = res(); await handleAnnualPhotoBackup(maintenanceReq(`Bearer ${SECRET}`), r, 'photoBackupWorkerMaintenance'); return r; })();
  for (let i = 0; i < 20 && !updates.length; i++) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(5000); }
  const r = await pending;
  deleteHook = null;
  assert.equal(r.body.failures, 1);
  assert.equal(updates[0][3], 'R2_DELETE_FAILED');
  assert.equal(row.reserved, true);
});

test('Mantenimiento: un fallo de R2 no marca limpieza ni reporta éxito', async () => {
  const updates = [];
  handleQuery = maintenanceDb(updates);
  deleteFails = true;
  const r = res();
  await handleAnnualPhotoBackup(maintenanceReq(`Bearer ${SECRET}`), r, 'photoBackupWorkerMaintenance');
  deleteFails = false;
  assert.equal(r.body.failures, 1);
  assert.equal(r.body.sourcesDeleted, 0);
  assert.equal(updates[0][3], 'R2_DELETE_FAILED');
});

test('Purga: un tombstone cancela callbacks del Worker y bloquea aprobación/descarga', async () => {
  handleQuery = sql => sql.includes("FROM clinic_settings WHERE clinic_id=$1 AND general ? '_purge'")
    ? { rows: [{}] } : { rows: [] };
  const callback = res();
  await handleAnnualPhotoBackup({ method: 'POST', headers: { 'x-photo-backup-secret': SECRET },
    body: { clinicId: CLINIC, requestId: REQUEST }, query: {} }, callback, 'photoBackupWorkerClaim');
  assert.equal(callback.code, 200);
  assert.equal(callback.body.state, 'cancelled');
  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
  const approval = res();
  await handleAnnualPhotoBackup(approveReq(), approval, 'approvePhotoBackup');
  assert.equal(approval.code, 409);
  auth.effective_clinic_id = CLINIC;
  const download = res();
  await handleAnnualPhotoBackup({ method: 'GET', headers: {}, query: { requestId: REQUEST },
    body: {} }, download, 'photoBackupDownload');
  assert.equal(download.code, 409);
});

test('Master may reject an inactive pending annual request without reopening access; tombstones still reject it', async () => {
  clinicActive = false;
  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
  const queries = [];
  handleQuery = sql => {
    queries.push(sql);
    if (sql.includes("status='REJECTED'") && sql.includes('RETURNING *'))
      return { rows: [{ id: REQUEST, clinic_id: CLINIC, requester_email: 'qa@example.test' }] };
    return { rows: [] };
  };
  try {
    const rejected = res();
    await handleAnnualPhotoBackup({ ...approveReq(), body: {
      clinicId: CLINIC, requestId: REQUEST, reason: 'Cierre ficticio autorizado',
    } }, rejected, 'rejectPhotoBackup');
    assert.equal(rejected.code, 200);
    assert.equal(rejected.body.status, 'REJECTED');
    assert.equal(queries.some(sql => /UPDATE clinics/.test(sql)), false);
    clinicPurging = true;
    const denied = res();
    await handleAnnualPhotoBackup({ ...approveReq(), body: {
      clinicId: CLINIC, requestId: REQUEST, reason: 'Cierre ficticio autorizado',
    } }, denied, 'rejectPhotoBackup');
    assert.equal(denied.code, 409);
  } finally { clinicActive = true; clinicPurging = false; }
});

test('Inactive clinic: only the terminal Fail callback is processed; Claim/Part/Complete cancel; tombstone cancels Fail', async () => {
  clinicActive = false;
  const updates = [];
  handleQuery = sql => {
    if (/SELECT id,status FROM annual_photo_backup_requests/.test(sql)) return { rows: [{ id: REQUEST, status: 'APPROVED' }] };
    if (/UPDATE annual_photo_backup_requests SET lease_hash=NULL/.test(sql)) updates.push(sql);
    if (/annual_photo_backup_parts/.test(sql)) throw new Error('parts must not be touched on inactive clinics');
    return { rows: [] };
  };
  const call = async (action, body = {}) => {
    const out = res();
    await handleAnnualPhotoBackup({ method: 'POST', headers: { 'x-photo-backup-secret': SECRET }, query: {},
      body: { clinicId: CLINIC, requestId: REQUEST, ...body } }, out, action);
    return out;
  };
  try {
    for (const action of ['photoBackupWorkerClaim', 'photoBackupWorkerPart', 'photoBackupWorkerComplete'])
      assert.equal((await call(action, { leaseToken: 'a'.repeat(64) })).body.state, 'cancelled', action);
    const failed = await call('photoBackupWorkerFail', { code: 'LEASE_LOST' });
    assert.equal(failed.body.state, 'failed');
    assert.equal(updates.length, 1);
    clinicPurging = true;
    assert.equal((await call('photoBackupWorkerFail', { code: 'LEASE_LOST' })).body.state, 'cancelled');
    assert.equal(updates.length, 1);
  } finally { clinicActive = true; clinicPurging = false; }
});

test('Inactive reject notification uses only the terminal tenant allowance and is suppressed by a tombstone', async () => {
  clinicActive = false;
  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
  let purgedAtNotify = false;
  const claims = [];
  handleQuery = sql => {
    if (sql.includes("status='REJECTED'") && sql.includes('RETURNING *'))
      return { rows: [{ id: REQUEST, clinic_id: CLINIC, requester_email: 'qa@example.test' }] };
    if (sql.includes("FROM clinic_settings") && sql.includes("general ? '_purge'")) return { rows: purgedAtNotify ? [{}] : [] };
    if (sql.includes("SET status='SENDING'")) { claims.push(sql); return { rows: [] }; }
    return { rows: [] };
  };
  try {
    tenantCalls.length = 0;
    const out = res();
    await handleAnnualPhotoBackup({ ...approveReq(), body: { clinicId: CLINIC, requestId: REQUEST, reason: 'Cierre ficticio' } }, out, 'rejectPhotoBackup');
    assert.equal(out.code, 200);
    assert.deepEqual(tenantCalls, [{ lifecycleTerminal: true }]);
    assert.equal(claims.length, 1);
    purgedAtNotify = true;
    const again = res();
    await handleAnnualPhotoBackup({ ...approveReq(), body: { clinicId: CLINIC, requestId: REQUEST, reason: 'Cierre ficticio' } }, again, 'rejectPhotoBackup');
    assert.equal(again.code, 409);
    assert.equal(claims.length, 1);
  } finally { clinicActive = true; }
});
