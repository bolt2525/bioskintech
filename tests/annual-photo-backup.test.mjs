import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { mock } from 'node:test';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const OTHER_CLINIC = '99999999-2222-4333-8444-555555555555';
const REQUEST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENV_KEYS = [
  'ANNUAL_PHOTO_BACKUP_ENABLED', 'ANNUAL_PHOTO_BACKUP_WORKER_URL', 'ANNUAL_PHOTO_BACKUP_SECRET',
  'ANNUAL_BACKUP_SERVICE_SECRET', 'EMAIL_USER', 'EMAIL_PASS', 'ANNUAL_PHOTO_BACKUP_MASTER_EMAIL',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
];

let auth = { valid: true, id: 42, role: 'clinic_admin', clinic_id: CLINIC };
let poolFactory = () => null;
const isolatedModule = path => new URL(path, import.meta.url).href;

mock.module(isolatedModule('../lib/admin-auth.js'), {
  namedExports: { authenticateRequest: async () => auth },
});
mock.module(isolatedModule('../lib/neon-clinical-db.js'), {
  namedExports: {
    getPool: () => poolFactory(),
    getAppPool: () => { throw new Error('No se esperaba acceso a Neon'); },
    withTenantContext: async () => { throw new Error('No se esperaba acceso a Neon'); },
  },
});
mock.module(isolatedModule('../lib/r2-service.js'), {
  namedExports: {
    generateDownloadUrl: async () => { throw new Error('No se esperaba acceso a R2'); },
    r2ObjectExists: async () => { throw new Error('No se esperaba acceso a R2'); },
    putR2Object: async () => { throw new Error('No se esperaba acceso a R2'); },
  },
});
mock.module(isolatedModule('../lib/backup-service.js'), {
  namedExports: { collectClinicData: async () => { throw new Error('No se esperaba exportar datos'); } },
});
mock.module(isolatedModule('../lib/portable-clinical-export.js'), {
  namedExports: { buildPortableDocuments: async () => { throw new Error('No se esperaba exportar documentos'); } },
});

const {
  buildDocumentBundles,
  buildPhotoBackupParts,
  handleAnnualPhotoBackup,
  photoBackupExpectedKey,
  safeDocumentName,
  suggestAnnualPhotoPeriod,
} = await import('../lib/annual-photo-backup.js');

function photo(index, overrides = {}) {
  return {
    id: index,
    record_id: 7,
    clinic_id: CLINIC,
    r2_key: `clinics/${CLINIC}/records/7/photos/photo-${index}.jpg`,
    file_size: 10,
    mime_type: 'image/jpeg',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    method: 'GET',
    headers: {},
    query: {},
    body: undefined,
    ...overrides,
  };
}

async function invoke(action, req) {
  let statusCode;
  let responseBody;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; return this; },
  };
  await handleAnnualPhotoBackup(req, res, action);
  return { statusCode, body: responseBody };
}

function useFeatureConfig(enabled) {
  for (const key of ENV_KEYS) delete process.env[key];
  if (!enabled) return;
  process.env.ANNUAL_PHOTO_BACKUP_ENABLED = 'true';
  process.env.ANNUAL_PHOTO_BACKUP_WORKER_URL = 'https://worker.example.test';
  process.env.ANNUAL_PHOTO_BACKUP_SECRET = 'x'.repeat(32);
  process.env.EMAIL_USER = 'qa@example.test';
  process.env.EMAIL_PASS = 'test-only';
  process.env.ANNUAL_PHOTO_BACKUP_MASTER_EMAIL = 'master@example.test';
  process.env.R2_ACCESS_KEY_ID = 'test-only';
  process.env.R2_SECRET_ACCESS_KEY = 'test-only';
}

function preserveEnvironment(t) {
  const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function mockDatabase(t, { validPeriod = true } = {}) {
  const queries = [];
  let released = false;
  poolFactory = () => ({
    connect: async () => ({
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (sql.includes('AS annual_schema_ready')) return { rows: [{ annual_schema_ready: true }] };
        if (sql.includes("SELECT c.is_active,cs.general ? '_purge'")) return { rows: [{ is_active: true, purging: false }] };
        if (sql.includes('SELECT id FROM clinics')) return { rows: [{ id: CLINIC }] };
        if (sql.includes("$1::timestamptz + interval '12 months'")) return { rows: [{ valid: validPeriod }] };
        if (sql.includes('FROM annual_photo_backup_periods') && sql.includes('tstzrange')) return { rows: [] };
        if (sql.includes('INSERT INTO annual_photo_backup_periods')) {
          return { rows: [{
            id: REQUEST, clinic_id: params[1], starts_at: params[2], ends_at: params[3], created_by: params[4],
          }] };
        }
        return { rows: [] };
      },
      release() { released = true; },
    }),
  });
  t.after(() => { poolFactory = () => null; });
  return { queries, wasReleased: () => released };
}

test('expected storage keys are tenant-scoped and validate UUIDs and part bounds', () => {
  assert.equal(
    photoBackupExpectedKey(CLINIC, REQUEST, 1),
    `annual-photo-backups/${CLINIC}/${REQUEST}/part-0001.zip`,
  );
  assert.equal(photoBackupExpectedKey(CLINIC, REQUEST, 9999).endsWith('part-9999.zip'), true);
  for (const partNumber of [0, -1, 1.5, 10000]) {
    assert.throws(() => photoBackupExpectedKey(CLINIC, REQUEST, partNumber), { status: 400 });
  }
  assert.throws(() => photoBackupExpectedKey('not-a-clinic', REQUEST, 1), { status: 400 });
  assert.throws(() => photoBackupExpectedKey(CLINIC, 'not-a-request', 1), { status: 400 });
});

test('annual period suggestion derives only from stored subscription expiry and duration and requires confirmation', () => {
  const suggestion = suggestAnnualPhotoPeriod({
    subscription_expires_at: '2026-10-07T18:00:00.000Z',
    subscription_days: 365,
  });
  assert.deepEqual(suggestion, {
    starts_at: '2025-10-07T18:00:00.000Z',
    ends_at: '2026-10-07T18:00:00.000Z',
    source: 'subscription_expires_at - subscription_days',
    duration_days: 365,
    requires_master_confirmation: true,
  });
  assert.equal(suggestAnnualPhotoPeriod({ subscription_expires_at: null, subscription_days: 365 }), null);
  assert.equal(suggestAnnualPhotoPeriod({ subscription_expires_at: '2026-10-07', subscription_days: 0 }), null);
  assert.equal(suggestAnnualPhotoPeriod({
    subscription_expires_at: '2024-02-29T12:00:00.000Z',
    subscription_days: 365,
  }), null);
  assert.deepEqual(suggestAnnualPhotoPeriod({
    subscription_expires_at: '2025-02-28T12:00:00.000Z',
    subscription_days: 365,
  }), {
    starts_at: '2024-02-29T12:00:00.000Z',
    ends_at: '2025-02-28T12:00:00.000Z',
    source: 'subscription_expires_at - subscription_days',
    duration_days: 365,
    requires_master_confirmation: true,
  });
});

test('photo manifests reject foreign clinics, foreign keys, traversal, and invalid sizes', () => {
  assert.throws(
    () => buildPhotoBackupParts([photo(1, { clinic_id: OTHER_CLINIC })], CLINIC, REQUEST),
    { status: 409 },
  );
  assert.throws(
    () => buildPhotoBackupParts([photo(1, {
      r2_key: `clinics/${OTHER_CLINIC}/records/7/photos/private.jpg`,
    })], CLINIC, REQUEST),
    { status: 409 },
  );
  for (const unsafeKey of [
    `clinics/${CLINIC}/records/7/photos/../private.jpg`,
    `clinics/${CLINIC}/records/7/photos\\private.jpg`,
    `clinics/${CLINIC}/records/7/photos/bad\nname.jpg`,
  ]) {
    assert.throws(
      () => buildPhotoBackupParts([photo(1, { r2_key: unsafeKey })], CLINIC, REQUEST),
      { status: 409 },
    );
  }
  for (const fileSize of [0, -1, 20 * 1024 * 1024 + 1, Number.NaN]) {
    assert.throws(
      () => buildPhotoBackupParts([photo(1, { file_size: fileSize })], CLINIC, REQUEST),
      { status: 409 },
    );
  }
});

test('photo parts stay within source-size and photo-count limits', () => {
  const sizeLimited = buildPhotoBackupParts(
    Array.from({ length: 23 }, (_, index) => photo(index, { file_size: null })),
    CLINIC,
    REQUEST,
  );
  assert.deepEqual(sizeLimited.map(part => part.photoCount), [22, 1]);
  assert.equal(sizeLimited[0].sourceBytes, 22 * 20 * 1024 * 1024);
  assert.ok(sizeLimited.every(part => part.sourceBytes <= 448 * 1024 * 1024));
  assert.ok(sizeLimited.every(part => part.expectedKey.startsWith(`annual-photo-backups/${CLINIC}/${REQUEST}/`)));

  const countLimited = buildPhotoBackupParts(
    Array.from({ length: 201 }, (_, index) => photo(index)),
    CLINIC,
    REQUEST,
  );
  assert.deepEqual(countLimited.map(part => part.photoCount), [200, 1]);
  assert.deepEqual(countLimited.map(part => part.partNumber), [1, 2]);
  assert.equal(buildPhotoBackupParts([], CLINIC, REQUEST)[0].photoCount, 0);
});

test('document names reject unsafe paths and control characters', () => {
  assert.equal(safeDocumentName('pacientes/indice.json'), 'pacientes/indice.json');
  for (const name of [
    '',
    '/absoluto.json',
    '../fuera.json',
    'pacientes/../fuera.json',
    'pacientes//vacio.json',
    'pacientes\\fuera.json',
    'documento\u0000.json',
    'documento\u007f.json',
    'a'.repeat(241),
  ]) {
    assert.throws(() => safeDocumentName(name), { status: 409 });
  }
});

test('document bundles round-trip contents and verify hashes and payload limits', () => {
  const body = Buffer.from('{"paciente":"dato ficticio"}');
  const bundles = buildDocumentBundles([{
    name: 'clinica/pacientes.json',
    contentType: 'application/json',
    body,
  }]);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].name, 'bundle-0001.json');
  assert.equal(bundles[0].serializedBytes, bundles[0].body.length);
  assert.equal(bundles[0].sha256, createHash('sha256').update(bundles[0].body).digest('hex'));
  const decodedBundle = JSON.parse(bundles[0].body.toString('utf8'));
  assert.deepEqual(decodedBundle, {
    format: 'bioskin-annual-document-bundle',
    version: 1,
    documents: [{
      name: 'clinica/pacientes.json',
      contentType: 'application/json',
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      bodyBase64: body.toString('base64'),
    }],
  });
  assert.deepEqual(Buffer.from(decodedBundle.documents[0].bodyBase64, 'base64'), body);

  const fourMiB = Buffer.alloc(4 * 1024 * 1024, 7);
  const splitBundles = buildDocumentBundles([1, 2, 3].map(index => ({
    name: `documento-${index}.json`, contentType: 'application/json', body: fourMiB,
  })));
  assert.deepEqual(splitBundles.map(bundle => bundle.documents.length), [2, 1]);
  assert.ok(splitBundles.every(bundle => bundle.serializedBytes <= 12 * 1024 * 1024));
  assert.ok(splitBundles.every(bundle => bundle.documents.reduce((total, item) => total + item.size, 0) <= 8 * 1024 * 1024));
  assert.throws(() => buildDocumentBundles([{
    name: 'grande.json', contentType: 'application/json', body: Buffer.alloc(4 * 1024 * 1024 + 1),
  }]), { status: 409 });
  assert.throws(() => buildDocumentBundles([{
    name: 'no-permitido.xml', contentType: 'application/xml', body,
  }]), { status: 409 });

  const manyBundles = buildDocumentBundles(Array.from({ length: 201 }, (_, index) => ({
    name: `documento-${index}.json`, contentType: 'application/json', body: Buffer.alloc(0),
  })));
  assert.deepEqual(manyBundles.map(bundle => bundle.documents.length), [200, 1]);
  assert.throws(() => buildDocumentBundles(null), { status: 500 });
});

test('disabled status returns without touching tenant or administrative database pools', async t => {
  preserveEnvironment(t);
  useFeatureConfig(false);
  auth = { valid: true, id: 42, role: 'clinic_admin', clinic_id: CLINIC };
  let poolCalls = 0;
  poolFactory = () => { poolCalls++; throw new Error('No se esperaba conexión a Neon'); };

  const result = await invoke('photoBackupStatus', request());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    success: true,
    configured: false,
    processor_ready: false,
    eligible: false,
    reason: 'registration_not_configured',
    period: null,
    period_suggestion: null,
    requests: [],
  });
  assert.equal(poolCalls, 0);
  poolFactory = () => null;
});

test('clinic admins cannot configure a master-only annual period', async t => {
  preserveEnvironment(t);
  useFeatureConfig(false);
  auth = { valid: true, id: 42, role: 'clinic_admin', clinic_id: CLINIC };
  let poolCalls = 0;
  poolFactory = () => { poolCalls++; throw new Error('No se esperaba conexión a Neon'); };

  const result = await invoke('setPhotoBackupPeriod', request({
    method: 'POST',
    body: { clinicId: CLINIC },
  }));
  assert.equal(result.statusCode, 403);
  assert.match(result.body.error, /proveedor del sistema/);
  assert.equal(poolCalls, 0);
  poolFactory = () => null;
});

test('non-admins and master admins cannot submit a clinic backup request', async t => {
  preserveEnvironment(t);
  useFeatureConfig(true);
  let poolCalls = 0;
  poolFactory = () => { poolCalls++; throw new Error('No se esperaba conexión a Neon'); };

  auth = { valid: true, id: 42, role: 'clinic_user', clinic_id: CLINIC };
  const clinicUser = await invoke('photoBackupStatus', request());
  assert.equal(clinicUser.statusCode, 403);
  assert.match(clinicUser.body.error, /administrador de clínica/);

  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
  const master = await invoke('requestPhotoBackup', request({
    method: 'POST',
    body: { clinicId: CLINIC },
  }));
  assert.equal(master.statusCode, 403);
  assert.match(master.body.error, /administrador de la clínica/);
  assert.equal(poolCalls, 0);
  poolFactory = () => null;
});

test('period dates reject impossible calendar days and non-UTC offsets before database access', async t => {
  preserveEnvironment(t);
  useFeatureConfig(true);
  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
  let poolCalls = 0;
  poolFactory = () => { poolCalls++; throw new Error('No se esperaba conexión a Neon'); };

  for (const body of [
    { clinicId: CLINIC, startDate: '2025-02-30', endDate: '2026-03-02' },
    { clinicId: CLINIC, startsAt: '2025-01-01T00:00:00-05:00', endsAt: '2026-01-01T00:00:00Z' },
  ]) {
    const result = await invoke('setPhotoBackupPeriod', request({ method: 'POST', body }));
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /Fechas inicial y final UTC/);
  }
  assert.equal(poolCalls, 0);
  poolFactory = () => null;
});

test('master can set an exact 12-month UTC period; mismatched duration is rejected', async t => {
  preserveEnvironment(t);
  useFeatureConfig(true);
  auth = { valid: true, id: 1, role: 'master_admin', clinic_id: null };
  const database = mockDatabase(t);
  const created = await invoke('setPhotoBackupPeriod', request({
    method: 'POST',
    body: { clinicId: CLINIC, startDate: '2025-01-01', endDate: '2026-01-01' },
  }));
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.period.start_date, '2025-01-01T00:00:00Z');
  assert.equal(created.body.period.end_date, '2026-01-01T00:00:00Z');
  const durationCheck = database.queries.find(query =>
    query.sql.includes("$1::timestamptz + interval '12 months'"));
  assert.deepEqual(durationCheck.params, ['2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);
  assert.equal(database.wasReleased(), true);

  const invalidDatabase = mockDatabase(t, { validPeriod: false });
  const rejected = await invoke('setPhotoBackupPeriod', request({
    method: 'POST',
    body: { clinicId: CLINIC, startsAt: '2025-01-01T00:00:00Z', endsAt: '2026-01-02T00:00:00Z' },
  }));
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body.error, /exactamente 12 meses/);
  assert.equal(invalidDatabase.queries.some(query => query.sql.includes('INSERT INTO annual_photo_backup_periods')), false);
});
