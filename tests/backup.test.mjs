import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';

process.env.BACKUP_ENCRYPTION_KEY = 'test-key-'.padEnd(48, 'x');
const svc = await import('../lib/backup-service.js');
const api = await import('../api/backup.js');
const CLINIC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const { subscriptionLifecycle } = await import('../lib/subscription-lifecycle.js');
const runCron = (req, res, pool, options = {}) => api.runCron(req, res, pool, {
  syncLifecycle: async (_pool, clinic, now) => subscriptionLifecycle(clinic, now), ...options,
});

test('encrypted snapshot round-trips and rejects tampering', () => {
  const doc = svc.buildBackupDocument({ clinicId: CLINIC, generatedBy: 'qa', kind: 'auto', modules: { patients: { tables: { patients: [{ id: 1 }] } } } });
  const enc = svc.encryptBackup(svc.compressBackup(doc));
  assert.equal(enc.subarray(0, 5).toString(), 'BSKE1');
  assert.doesNotMatch(enc.toString('latin1'), /patients/);
  assert.deepEqual(svc.decodeBackupBuffer(enc), doc);
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => svc.decodeBackupBuffer(tampered), /alterado/);
});

test('native gzip restores 6.5 MiB of clinical JSON, signatures and markings byte-for-byte', () => {
  const clinicalText = randomBytes(6.5 * 1024 * 1024 * 3 / 4).toString('base64');
  const doc = svc.buildBackupDocument({
    clinicId: CLINIC,
    generatedBy: 'qa',
    kind: 'download',
    modules: { patients: { tables: {
      patients: [{ id: 1, notes: clinicalText }],
      physical_exams: [{ id: 2, face_map_data: { marks: [{ x: 0.125, y: 0.875, zone: 'frente' }] } }],
      consent_forms: [{ id: 3, signatures: { patient_sig_data: 'data:image/png;base64,AAECAw==' }, signing_hash: 'integrity-proof' }],
    } } },
  });
  const original = Buffer.from(JSON.stringify(doc), 'utf8');
  const compressed = svc.compressBackup(doc);
  assert.ok(original.length > 6.5 * 1024 * 1024);
  assert.ok(compressed.length < original.length);
  assert.ok(compressed.length < 50 * 1024 * 1024);
  assert.deepEqual(svc.decodeBackupBuffer(compressed), doc);
  assert.equal(svc.decodeBackupBuffer(compressed).modules.patients.tables.patients[0].notes, clinicalText);
});

test('direct-to-R2 upload accepts exactly 50 MiB, rejects larger or invalid lengths, and allows gzip-compressed inputs', () => {
  assert.equal(svc.MAX_UPLOAD_BYTES, 50 * 1024 * 1024);
  assert.equal(svc.MAX_JSON_BYTES, 200 * 1024 * 1024);
  assert.equal(svc.isBackupUploadSizeAllowed(50 * 1024 * 1024), true);
  assert.equal(svc.isBackupUploadSizeAllowed(50 * 1024 * 1024 + 1), false);
  assert.equal(svc.isBackupUploadSizeAllowed(1), false);
  assert.equal(svc.isBackupUploadSizeAllowed(Number.NaN), false);
  assert.equal(svc.isBackupUploadSizeAllowed('52428800'), false);
  assert.deepEqual(svc.decodeBackupBuffer(gzipSync(Buffer.from('{"format":"bioskintech-backup"}'))),
    { format: 'bioskintech-backup' });
});

test('generated backups reject expanded or compressed output beyond standard restore limits with assisted guidance', () => {
  assert.doesNotThrow(() => svc.assertBackupJsonSize(svc.MAX_JSON_BYTES));
  assert.throws(
    () => svc.assertBackupJsonSize(svc.MAX_JSON_BYTES + 1),
    error => error.status === 413 && /200 MiB descomprimidos/.test(error.message) && /asistida/.test(error.message),
  );
  const doc = { format: svc.BACKUP_FORMAT, modules: { patients: { notes: 'synthetic' } } };
  assert.throws(
    () => svc.compressBackup(doc, { maxCompressedBytes: 1 }),
    error => error.status === 413 && /asistida/.test(error.message),
  );
});

test('manual backup stats contract has stable UI fields and no quota dependency on encryption', () => {
  const payload = api.manualBackupContract({
    available: false,
    next_allowed_at: '2026-10-08T05:00:00.000Z',
    last_success_at: '2026-10-07T18:30:00.000Z',
    time_zone: 'America/Guayaquil',
    daily_limit: 1,
    state: 'USED',
    reason: null,
  });
  assert.deepEqual(payload, {
    available: false,
    next_allowed_at: '2026-10-08T05:00:00.000Z',
    last_created_at: '2026-10-07T18:30:00.000Z',
    timezone: 'America/Guayaquil',
    limit: 1,
  });
});

function manualQuotaPool() {
  let lockTail = Promise.resolve();
  let lockHeld = false;
  let storedMetadata = null;
  const clock = {
    local_date: '2026-10-07',
    next_allowed_at: '2026-10-08T05:00:00.000Z',
    now: new Date('2026-10-07T18:00:00.000Z'),
  };
  const queries = [];
  const pool = {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('to_char(now() AT TIME ZONE')) return { rows: [clock] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    async connect() {
      let releaseLock = null;
      const takeLock = async () => {
        const previous = lockTail;
        let unlock;
        lockTail = new Promise(resolve => { unlock = resolve; });
        await previous;
        lockHeld = true;
        releaseLock = () => { lockHeld = false; unlock(); };
      };
      return {
        async query(sql, params = []) {
          queries.push(sql);
          if (sql.includes('pg_try_advisory_lock(')) {
            if (lockHeld) return { rows: [{ acquired: false }] };
            await takeLock();
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes('pg_advisory_lock(') && !sql.includes('unlock')) {
            await takeLock();
            return { rows: [] };
          }
          if (sql.includes('to_char(now() AT TIME ZONE')) return { rows: [clock] };
          if (sql.includes("SELECT general->'_manual_backup'")) return { rows: [{ metadata: storedMetadata }] };
          if (sql.includes('INSERT INTO clinic_settings')) {
            storedMetadata = JSON.parse(params[1]);
            return { rowCount: 1 };
          }
          if (sql.includes('pg_advisory_unlock(')) {
            const unlocked = Boolean(releaseLock);
            releaseLock?.();
            releaseLock = null;
            return { rows: [{ unlocked }] };
          }
          throw new Error(`Consulta inesperada: ${sql}`);
        },
        release(error) { if (error) releaseLock?.(); },
      };
    },
  };
  return pool;
}

test('manual snapshot reservation is serialized per clinic and returns Ecuador next-allow time as HTTP quota data', async () => {
  const pool = manualQuotaPool();
  const first = await api.reserveManualSnapshot(pool, CLINIC, async () => []);
  let error;
  try { await api.reserveManualSnapshot(pool, CLINIC, async () => []); } catch (caught) { error = caught; }
  assert.equal(error?.status, 429);
  assert.equal(error.nextAllowedAt, '2026-10-08T05:00:00.000Z');
  await api.releaseManualSnapshotReservation(first);
  assert.ok(pool.queries.some(sql => sql.includes("hashtextextended($1,0)")));
  assert.ok(pool.queries.some(sql => sql.includes("'America/Guayaquil'")));
});

test('manual snapshot reservation reuses the caller connection to avoid nested pool acquisition', async () => {
  const backingPool = manualQuotaPool();
  const client = await backingPool.connect();
  let nestedConnectionRequested = false;
  const pool = { connect: async () => { nestedConnectionRequested = true; throw new Error('No debe pedir otra conexión'); } };
  const reservation = await api.reserveManualSnapshot(pool, CLINIC, async () => [], client);

  assert.equal(nestedConnectionRequested, false);
  assert.equal(reservation.ownsClient, false);
  await api.releaseManualSnapshotReservation(reservation);
  assert.ok(backingPool.queries.some(sql => sql.includes('pg_advisory_unlock(')));
  client.release();
});

test('manual snapshot reservation releases the lock after an R2 check failure so a retry can proceed', async () => {
  const pool = manualQuotaPool();
  await assert.rejects(
    api.reserveManualSnapshot(pool, CLINIC, async () => { throw new Error('R2 no disponible'); }),
    /R2 no disponible/,
  );
  const retry = await api.reserveManualSnapshot(pool, CLINIC, async () => []);
  await api.releaseManualSnapshotReservation(retry);
});

test('manual quota reports daily status/history without resetting a used allowance', async () => {
  const pool = manualQuotaPool();
  const quota = await api.getManualSnapshotQuota(pool, CLINIC, {
    manualSnapshots: [{
      key: `backups/${CLINIC}/manual/test.json.gz.enc`,
      lastModified: new Date('2026-10-08T04:30:00.000Z'),
    }],
  });
  assert.deepEqual({
    time_zone: quota.time_zone,
    daily_limit: quota.daily_limit,
    used_today: quota.used_today,
    available: quota.available,
    state: quota.state,
    next_allowed_at: quota.next_allowed_at,
    last_success_key: quota.last_success_key,
  }, {
    time_zone: 'America/Guayaquil',
    daily_limit: 1,
    used_today: 1,
    available: false,
    state: 'USED',
    next_allowed_at: '2026-10-08T05:00:00.000Z',
    last_success_key: `backups/${CLINIC}/manual/test.json.gz.enc`,
  });
});

test('manual quota reports an active atomic reservation as unavailable while snapshot work runs', async () => {
  const pool = manualQuotaPool();
  const reservation = await api.reserveManualSnapshot(pool, CLINIC, async () => []);
  const quota = await api.getManualSnapshotQuota(pool, CLINIC, { manualSnapshots: [] });
  assert.equal(quota.available, false);
  assert.equal(quota.state, 'PROCESSING');
  assert.equal(quota.next_allowed_at, null);
  await api.releaseManualSnapshotReservation(reservation);
});

test('manual snapshot success is retained in existing clinic settings metadata without schema changes', async () => {
  const pool = manualQuotaPool();
  const reservation = await api.reserveManualSnapshot(pool, CLINIC, async () => []);
  await api.persistManualSnapshotMetadata(reservation, {
    key: `backups/${CLINIC}/manual/test.json.gz.enc`,
    size: 4096,
  });
  await api.releaseManualSnapshotReservation(reservation);
  const quota = await api.getManualSnapshotQuota(pool, CLINIC, { manualSnapshots: [] });
  assert.equal(quota.state, 'USED');
  assert.equal(quota.last_success_key, `backups/${CLINIC}/manual/test.json.gz.enc`);
  assert.equal(pool.queries.some(sql => /CREATE TABLE|ALTER TABLE/.test(sql)), false);
});

test('existing manual snapshots consume today quota by Ecuador calendar day during rollout', async () => {
  const pool = manualQuotaPool();
  await assert.rejects(
    api.reserveManualSnapshot(pool, CLINIC, async () => [{
      key: `backups/${CLINIC}/manual/legacy.json.gz.enc`,
      lastModified: new Date('2026-10-08T04:30:00.000Z'),
    }]),
    { status: 429 },
  );
});

test('manual quota fails closed when the R2 listing reaches its 500-object verification cap', async () => {
  const pool = manualQuotaPool();
  const snapshots = Array.from({ length: 500 }, (_, index) => ({
    key: `backups/${CLINIC}/manual/${index}.json.gz.enc`,
    lastModified: new Date('2026-10-06T18:00:00.000Z'),
  }));
  const quota = await api.getManualSnapshotQuota(pool, CLINIC, { manualSnapshots: snapshots });
  assert.equal(quota.available, false);
  assert.equal(quota.state, 'HISTORY_INCOMPLETE');
  assert.equal(quota.next_allowed_at, null);
});

test('retained copies from purged identities cannot be restored under a new clinic identity', async () => {
  let params;
  const blocked = { query: async (sql, args) => {
    assert.match(sql, /clinic_id=ANY\(\$1::uuid\[\]\) AND general \? '_purge'/);
    params = args;
    return { rows: [{ purge: true }] };
  } };
  await assert.rejects(api.rejectPurgedBackup(blocked, { metadata: { clinic_id: CLINIC } }, OTHER), { status: 409 });
  assert.deepEqual(params, [[OTHER, CLINIC]]);
  await api.rejectPurgedBackup({ query: async () => ({ rows: [] }) }, { metadata: { clinic_id: CLINIC } }, OTHER);
});

test('decoder rejects zip bombs, binary garbage and non JSON', () => {
  assert.throws(() => svc.decodeBackupBuffer(gzipSync(Buffer.alloc(svc.MAX_JSON_BYTES + 1, 32))), /excede/);
  assert.throws(() => svc.decodeBackupBuffer(Buffer.from([0x1f, 0x8b, 1, 2, 3])), /dañado/);
  assert.throws(() => svc.decodeBackupBuffer(Buffer.from('MZ\x90\x00 binario')), /JSON válido/);
  assert.deepEqual(svc.decodeBackupBuffer(Buffer.from('\uFEFF{"a":1}')), { a: 1 });
});

test('signature detects edited backups, foreign clinics and future versions', () => {
  const doc = svc.buildBackupDocument({ clinicId: CLINIC, generatedBy: 'qa', kind: 'download', modules: { finance: { records: [{ id: 3, total: '10.00' }] } } });
  const roundTrip = JSON.parse(JSON.stringify(doc));
  assert.equal(svc.inspectBackupDocument(roundTrip, CLINIC).signature, 'valid');
  assert.equal(svc.inspectBackupDocument(roundTrip, OTHER).sameClinic, false);
  roundTrip.modules.finance.records[0].total = '99999.00';
  assert.equal(svc.inspectBackupDocument(roundTrip, CLINIC).signature, 'invalid');
  assert.equal(svc.inspectBackupDocument({ metadata: {}, modules: {} }, CLINIC).signature, 'unsigned');
  assert.throws(() => svc.inspectBackupDocument({ ...doc, schema_version: 99 }, CLINIC), /incompatible/);
  assert.throws(() => svc.inspectBackupDocument({ ...doc, format: 'otro' }, CLINIC), /no es un respaldo/);
  assert.throws(() => svc.inspectBackupDocument([], CLINIC), /inválido/);
});

test('patient template validation normalizes Excel artifacts and rejects bad data', () => {
  const ok = svc.validatePatientImportRow({ nombres: ' Ana ', apellidos: 'Pérez', tipo_identificacion: 'CÉDULA', numero_identificacion: '102345675',
    email: 'ANA@MAIL.COM', telefono: "'+593 99 999 9999", fecha_nacimiento: '5/3/1990', genero: 'F', alergias: 'Penicilina', habitos: '' });
  assert.equal(ok.patient.identification_number, '0102345675');
  assert.equal(ok.patient.birth_date, '1990-03-05');
  assert.equal(ok.patient.gender, 'Femenino');
  assert.equal(ok.patient.email, 'ana@mail.com');
  assert.equal(ok.patient.phone, '+593 99 999 9999');
  assert.deepEqual(ok.history, { allergies: 'Penicilina' });
  const auto = svc.validatePatientImportRow({ nombres: 'A', apellidos: 'B', numero_identificacion: '0102345675001' });
  assert.equal(auto.patient.identification_type, 'ruc');
  assert.equal(auto.history, null);
  const bad = r => svc.validatePatientImportRow({ nombres: 'A', apellidos: 'B', tipo_identificacion: 'cedula', numero_identificacion: '0102345675', ...r }).error;
  assert.equal(bad({}), undefined);
  assert.match(bad({ numero_identificacion: '0102345678' }), /verificador/);
  assert.match(bad({ tipo_identificacion: 'pasaporte' }), /Tipo de identificación/);
  assert.match(bad({ antecedentes_patologicos: 'x'.repeat(2001) }), /2000/);
  assert.match(bad({ fecha_nacimiento: '2999-01-01' }), /Fecha/);
  assert.match(bad({ fecha_nacimiento: '1990-02-30' }), /Fecha/);
  assert.match(bad({ email: 'no-es-correo' }), /Correo/);
  assert.match(bad({ genero: 'x' }), /Género/);
  assert.match(bad({ nombres: 'x'.repeat(101) }), /obligatorios/);
  assert.equal(svc.validatePatientImportRow(null).error, 'Fila inválida');
});

test('jsonb arrays and objects are serialized as JSON while dates stay native', () => {
  const when = new Date('2026-01-01T00:00:00Z');
  const { values } = api.buildBackupInsertStatement('physical_exams',
    { id: 1, face_map_data: [{ zone: 'frente' }], body_map_data: { a: 1 }, created_at: when, skin_type: 'mixta' },
    new Set(['id', 'face_map_data', 'body_map_data', 'created_at', 'skin_type']), new Set(['face_map_data', 'body_map_data']));
  assert.deepEqual(values, [1, '[{"zone":"frente"}]', '{"a":1}', when, 'mixta']);
});

test('template uses semicolons, documents every column and marks example rows', () => {
  const csv = svc.buildPatientTemplateCsv();
  const [header, first] = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(header.split(';').length, svc.PATIENT_TEMPLATE_COLUMNS.length);
  assert.ok(header.includes('alergias'));
  assert.equal(svc.isTemplateExampleRow({ nombres: first.split(';')[0] }), true);
  assert.equal(svc.isTemplateExampleRow({ nombres: 'Ana' }), false);
});

test('readable consents escape content and only embed safe PNG signatures', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const pool = { query: async sql => sql.includes('FROM clinics') ? { rows: [{ name: 'Clínica <X>' }] } : { rows: [{
    first_name: '<script>alert(1)</script>', last_name: 'P', patient_identification: '0102345675', procedure_type: 'Toxina',
    risks: ['Edema', 'Hematoma'], declarations: { understanding: true }, signatures: { patient_sig_data: png, professional_sig_data: 'javascript:alert(1)' },
    signing_hash: 'abc', created_at: new Date(), status: 'signed' }] } };
  const html = await svc.buildConsentsHtml(pool, CLINIC);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Clínica &lt;X&gt;/);
  assert.ok(html.includes(`src="${png}"`));
  assert.doesNotMatch(html, /javascript:alert/);
  assert.match(html, /Hematoma/);
});

test('photo maintenance delegates to the locked lifecycle and never runs the old T+30 photo deletion', async () => {
  const calls = [];
  const pool = { connect: async () => ({
    query: async statement => { calls.push(statement); return { rows: [] }; },
    release() {},
  }) };
  const report = await api.purgeExpiredClinicPhotos(pool, async () => assert.fail('No eligible clinic'));
  assert.equal(report.completed, 0);
  assert.equal(report.complete, true);
  assert.ok(calls.some(statement => statement.includes('SELECT c.id FROM clinics c')));
  assert.equal(calls.some(statement => statement.includes('SELECT f.id') || statement.includes('DELETE FROM clinical_photos')), false);
});

test('snapshot reads inside one read-only transaction and never saves a silently truncated table', async () => {
  const log = [];
  const makePool = rowsForPatients => ({ connect: async () => ({
    query: async sql => {
      log.push(sql.split(/\s+/).slice(0, 2).join(' '));
      if (sql.includes('information_schema.tables')) return { rows: [{ table_name: 'patients' }] };
      if (sql.includes('FROM patients')) return { rows: rowsForPatients };
      return { rows: [] };
    },
    release: () => log.push('RELEASE'),
  }) });
  const modules = await svc.collectClinicData(makePool([{ id: 1 }]), CLINIC, ['patients']);
  assert.equal(modules.patients.count, 1);
  assert.equal(log[0], 'BEGIN ISOLATION');
  assert.ok(log.includes('COMMIT') && log.at(-1) === 'RELEASE');
  const huge = Array.from({ length: svc.MAX_ROWS_PER_TABLE + 1 }, (_, id) => ({ id }));
  await assert.rejects(() => svc.collectClinicData(makePool(huge), CLINIC, ['patients']), /supera/);
  assert.ok(log.includes('ROLLBACK'));
});

test('signature images are cropped and downscaled for the readable export without losing strokes', async () => {
  const { deflateSync, inflateSync } = await import('node:zlib');
  const { crc32 } = await import('node:zlib');
  const w = 1800, h = 2400;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let x = 400; x < 1400; x++) { const i = 1000 * (w * 4 + 1) + 1 + x * 4; raw[i + 3] = 255; }
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const small = Buffer.from(svc.compactSignatureDataUrl(`data:image/png;base64,${png.toString('base64')}`).split(',')[1], 'base64');
  const ow = small.readUInt32BE(16), oh = small.readUInt32BE(20);
  assert.ok(ow <= 600 && oh < 20, `${ow}x${oh}`);
  const out = inflateSync(small.subarray(41, 41 + small.readUInt32BE(33)));
  const rowLen = ow * 4 + 1;
  assert.ok(out.some((v, i) => i % rowLen !== 0 && (i % rowLen - 1) % 4 === 3 && v === 255), 'el trazo se conserva');
  assert.equal(svc.compactSignatureDataUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test('snapshot and upload keys are scoped to the clinic', () => {
  assert.equal(api.isSnapshotKey(`backups/${CLINIC}/auto/2026-09-29T08-00-00-000Z-ab12cd34.json.gz.enc`, CLINIC), true);
  assert.equal(api.isSnapshotKey(`backups/${OTHER}/auto/x.json.gz.enc`, CLINIC), false);
  assert.equal(api.isSnapshotKey(`backups/${CLINIC}/auto/../../${OTHER}/x.json.gz.enc`, CLINIC), false);
  assert.equal(api.isUploadKey(`backup-tmp/${CLINIC}/uploads/0f8fad5b-d9cb-469f-a165-70867728950e`, CLINIC), true);
  assert.equal(api.isUploadKey(`backup-tmp/${CLINIC}/exports/0f8fad5b-d9cb-469f-a165-70867728950e`, CLINIC), false);
});

test('photo references must belong to the clinic record and still exist', async () => {
  const pool = { query: async statement => {
    if (statement.includes('information_schema.columns')) return { rows: ['id', 'record_id', 'clinic_id', 'r2_key'].map(column_name => ({ column_name })) };
    if (/^SELECT clinic_id FROM \w+ WHERE id = \$1$/.test(statement)) return { rows: [] };
    if (statement.startsWith('SELECT patient_id FROM clinical_records')) return { rows: [{ patient_id: 1 }] };
    if (statement.startsWith('INSERT INTO clinical_photos')) return { rowCount: 1 };
    throw new Error(`Unexpected ${statement}`);
  } };
  const row = { id: 5, record_id: 9, r2_key: `clinics/${OTHER}/records/9/photos/a.jpg` };
  await assert.rejects(() => api.insertBackupRow(pool, 'clinical_photos', row, CLINIC, false, { photoExists: async () => true }), /fuera de la clínica/);
  const own = { ...row, r2_key: `clinics/${CLINIC}/records/9/photos/a.jpg` };
  await assert.rejects(() => api.insertBackupRow(pool, 'clinical_photos', own, CLINIC, false, { photoExists: async () => false }), /ya no existe/);
  assert.equal(await api.insertBackupRow(pool, 'clinical_photos', own, CLINIC, false, { photoExists: async () => true }), 1);
});

test('rows that already exist are skipped without revalidation, foreign ids are rejected', async () => {
  const pool = owner => ({ query: async statement => {
    if (statement.includes('information_schema.columns')) return { rows: ['id', 'record_id', 'clinic_id', 'consultation_id'].map(column_name => ({ column_name })) };
    if (statement.startsWith('SELECT clinic_id FROM diagnoses')) return { rows: [{ clinic_id: owner }] };
    throw new Error(`Unexpected ${statement}`);
  } });
  assert.equal(await api.insertBackupRow(pool(CLINIC), 'diagnoses', { id: 4, record_id: 1, consultation_id: 999 }, CLINIC, false), 0);
  await assert.rejects(() => api.insertBackupRow(pool(OTHER), 'diagnoses', { id: 4, record_id: 1 }, CLINIC, false), /otra clínica/);
});

function fakeRestorePool({ failPatientId } = {}) {
  const log = [];
  const client = {
    query: async (statement, params) => {
      log.push(statement.trim().split(/\s+/).slice(0, 3).join(' '));
      if (statement.includes('information_schema.columns')) return { rows: ['id', 'first_name', 'clinic_id', 'rut', 'identification_number', 'patient_id'].map(column_name => ({ column_name })) };
      if (statement.includes("SELECT c.is_active,cs.general ? '_purge'")) return { rows: [{ is_active: true, purging: false }] };
      if (statement.startsWith('SELECT clinic_id FROM patients')) return { rows: [] };
      if (statement.startsWith('INSERT INTO patients')) {
        if (params[0] === failPatientId) throw Object.assign(new Error('duplicate key value violates unique constraint "uq_patients_identification_clinic" detail Ana'), { code: '23505' });
        return { rowCount: params[0] === 2 ? 0 : 1 };
      }
      return { rows: [{}], rowCount: 0 };
    },
    release: () => log.push('RELEASE CLIENT'),
  };
  return { log, pool: { connect: async () => client } };
}

test('restore simulation never commits and reports new, existing and failed rows without leaking data', async () => {
  const { pool, log } = fakeRestorePool({ failPatientId: 3 });
  const doc = { metadata: {}, modules: { patients: { tables: { patients: [{ id: 1, first_name: 'A' }, { id: 2, first_name: 'B' }, { id: 3, first_name: 'C' }] } } } };
  const report = await api.restoreBackupDocument(pool, doc, CLINIC, { dryRun: true });
  assert.deepEqual(report.inserted, { patients: 1 });
  assert.deepEqual(report.existing, { patients: 1 });
  assert.equal(report.errorCount, 1);
  assert.doesNotMatch(report.errors[0].error, /Ana|uq_patients/);
  assert.equal(report.committed, false);
  assert.ok(log.includes('ROLLBACK TO SAVEPOINT'));
  assert.ok(log.includes('ROLLBACK') && !log.includes('COMMIT'));
  assert.equal(log.at(-1), 'RELEASE CLIENT');
});

test('restore with errors needs explicit partial approval and then fixes sequences before commit', async () => {
  const doc = { metadata: {}, modules: { patients: { tables: { patients: [{ id: 1 }, { id: 3 }] } } } };
  const blocked = fakeRestorePool({ failPatientId: 3 });
  assert.equal((await api.restoreBackupDocument(blocked.pool, doc, CLINIC, { dryRun: false })).committed, false);
  assert.ok(!blocked.log.includes('COMMIT'));
  const partial = fakeRestorePool({ failPatientId: 3 });
  assert.equal((await api.restoreBackupDocument(partial.pool, doc, CLINIC, { dryRun: false, allowPartial: true })).committed, true);
  const setval = partial.log.findIndex(entry => entry.startsWith('SELECT setval('));
  assert.ok(setval > 0 && setval < partial.log.indexOf('COMMIT'));
});

test('restore rejects malformed sections before touching rows', async () => {
  const { pool, log } = fakeRestorePool();
  await assert.rejects(() => api.restoreBackupDocument(pool, { modules: { patients: { tables: { patients: 'x' } } } }, CLINIC), /inválida/);
  assert.ok(log.includes('ROLLBACK'));
});

test('every CSV dataset accepts 50000 rows and rejects 50001 instead of silently truncating', async () => {
  for (const dataset of Object.keys(svc.CSV_DATASETS)) {
    const pool = length => ({ query: async (sql, params) => {
      assert.match(sql, /LIMIT 50001$/);
      assert.deepEqual(params, [CLINIC]);
      return { rows: Array(length).fill({}) };
    } });
    assert.equal((await svc.buildDatasetCsv(pool(50_000), dataset, CLINIC)).count, 50_000);
    await assert.rejects(() => svc.buildDatasetCsv(pool(50_001), dataset, CLINIC), /50000.*no se generó una exportación parcial/);
  }
});

test('communications rolls back and releases on 50001 messages; 50000 messages are complete', async () => {
  for (const length of [50_000, 50_001]) {
    const log = [];
    const pool = { connect: async () => ({
      query: async (sql, params) => {
        log.push(sql);
        if (sql.includes('information_schema.tables'))
          return { rows: ['whatsapp_contacts', 'whatsapp_messages'].map(table_name => ({ table_name })) };
        if (sql.includes('FROM whatsapp_contacts')) {
          assert.deepEqual(params, [CLINIC]);
          return { rows: [{ id: 7 }] };
        }
        if (sql.includes('FROM whatsapp_messages')) {
          assert.match(sql, /LIMIT 50001/);
          assert.deepEqual(params, [[7]]);
          return { rows: Array(length).fill({ id: 1 }) };
        }
        return { rows: [] };
      },
      release: () => log.push('RELEASE'),
    }) };
    if (length === 50_000) {
      assert.equal((await svc.collectClinicData(pool, CLINIC, ['communications'])).communications.whatsapp_messages.length, length);
      assert.ok(log.includes('COMMIT'));
    } else {
      await assert.rejects(() => svc.collectClinicData(pool, CLINIC, ['communications']), /whatsapp_messages.*50000/);
      assert.ok(log.includes('ROLLBACK'));
      assert.ok(!log.includes('COMMIT'));
    }
    assert.equal(log.at(-1), 'RELEASE');
  }
});

test('timed-out collection rolls back after the current query and never starts another table', async () => {
  const controller = new AbortController();
  const log = [];
  const pool = { connect: async () => ({
    query: async sql => {
      log.push(sql);
      if (sql.includes('information_schema.tables'))
        return { rows: [{ table_name: 'patients' }, { table_name: 'clinical_records' }] };
      if (sql.includes('FROM patients')) controller.abort(new Error('Presupuesto del cron agotado'));
      return { rows: [] };
    },
    release: () => log.push('RELEASE'),
  }) };
  await assert.rejects(() => svc.collectClinicData(pool, CLINIC, ['patients'], { signal: controller.signal }), /Presupuesto/);
  assert.ok(log.includes('ROLLBACK'));
  assert.equal(log.at(-1), 'RELEASE');
  assert.ok(!log.some(sql => sql.includes('FROM clinical_records')));
  assert.ok(!log.includes('COMMIT'));
});

test('consent patient list counts per patient and detects its own overflow', async () => {
  const pool = length => ({ query: async (sql, params) => {
    assert.match(sql, /LIMIT 50001/);
    assert.match(sql, /cf.clinic_id = \$1 AND p.clinic_id = \$1/);
    assert.match(sql, /ORDER BY p.last_name, p.first_name, p.id/);
    assert.deepEqual(params, [CLINIC]);
    return { rows: Array(length).fill({ id: 1, consents: 205 }) };
  } });
  const rows = await svc.listConsentPatients(pool(50_000), CLINIC);
  assert.equal(rows.length, 50_000);
  assert.equal(rows[0].count, 205);
  assert.equal(rows[0].consents, 205); // compatibility with the previous frontend
  await assert.rejects(() => svc.listConsentPatients(pool(50_001), CLINIC), /lista.*50000/);
});

function fakeConsentPool(consents) {
  return { query: async (sql, params) => {
    if (sql.includes('FROM clinics')) return { rows: [{ name: 'Clínica QA' }] };
    assert.match(sql, /selected AS MATERIALIZED/);
    assert.match(sql, /cf.clinic_id = \$1 AND p.clinic_id = \$1/);
    assert.match(sql, /ORDER BY id LIMIT \$3 OFFSET \$4/);
    assert.match(sql, /ORDER BY page.id/);
    const [clinicId, patientIds, limit, offset] = params;
    const selected = consents.filter(c => c.clinic_id === clinicId && (!patientIds || patientIds.includes(c.patient_id)))
      .sort((a, b) => a.id - b.id);
    const totals = {
      export_count: selected.length,
      export_revision: createHash('md5').update(selected.map(c => c.id).join(',')).digest('hex'),
    };
    const rows = selected.slice(offset, offset + limit);
    return { rows: (rows.length ? rows : [{ id: null }]).map(c => ({ ...c, ...totals })) };
  } };
}

test('a single patient with 205 consents downloads in stable 100/100/5 pages without losses', async () => {
  const consents = Array.from({ length: 205 }, (_, i) => ({
    id: 205 - i, patient_id: 7, clinic_id: CLINIC, first_name: 'QA', last_name: 'Paciente',
    procedure_type: `Documento-${205 - i}`, status: 'signed',
  }));
  consents.push({ id: 999, patient_id: 7, clinic_id: OTHER, procedure_type: 'EXTRANJERO' });
  const pool = fakeConsentPool(consents);
  let offset = 0, revision = null;
  const downloaded = [];
  for (const expected of [100, 100, 5]) {
    const page = await svc.buildConsentsPage(pool, CLINIC, { patientIds: [7], offset, limit: 100, revision });
    assert.equal(page.count, 205);
    assert.equal(page.returnedCount, expected);
    assert.doesNotMatch(page.html, /EXTRANJERO/);
    downloaded.push(...Array.from(page.html.matchAll(/<h2>Documento-(\d+)<\/h2>/g), m => Number(m[1])));
    assert.equal(page.hasMore, expected === 100);
    revision = page.revision;
    offset = page.nextOffset;
  }
  assert.equal(offset, null);
  assert.deepEqual(downloaded, Array.from({ length: 205 }, (_, i) => i + 1));
  assert.equal(new Set(downloaded).size, 205);
  const empty = await svc.buildConsentsPage(pool, CLINIC, { patientIds: [8] });
  assert.equal(empty.count, 0);
  assert.equal(empty.returnedCount, 0);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.nextOffset, null);
  assert.match(empty.html, /No hay consentimientos/);
});

test('offset pagination refuses set mutations and requires revision; invalid inputs never query', async () => {
  const consents = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, patient_id: 7, clinic_id: CLINIC }));
  const pool = fakeConsentPool(consents);
  const first = await svc.buildConsentsPage(pool, CLINIC, { patientIds: [7] });
  consents.shift(); // deletion before offset used to lose a consent
  await assert.rejects(() => svc.buildConsentsPage(pool, CLINIC, {
    patientIds: [7], offset: 100, revision: first.revision,
  }), error => error.status === 409 && /reinicia/.test(error.message));
  consents.unshift({ id: 1, patient_id: 7, clinic_id: CLINIC });
  consents.push({ id: 200, patient_id: 7, clinic_id: CLINIC }); // insertion must also invalidate
  await assert.rejects(() => svc.buildConsentsPage(pool, CLINIC, {
    patientIds: [7], offset: 100, revision: first.revision,
  }), error => error.status === 409);
  const noQueries = { query: () => { assert.fail('Invalid input queried the database'); } };
  for (const options of [
    { offset: 100 }, { offset: -1 }, { offset: '0' }, { offset: 0.1 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: '100' }, { revision: 'bad' }, { patientIds: [] },
    { patientIds: [7, '8'] }, { patientIds: [-1] }, { patientIds: Array(5001).fill(7) },
  ]) await assert.rejects(() => svc.buildConsentsPage(noQueries, CLINIC, options));
});

test('legacy readable export still rejects 101 documents instead of silently exporting the first part', async () => {
  const pool = { query: async sql => sql.includes('FROM clinics') ? { rows: [] } : { rows: Array(101).fill({}) } };
  await assert.rejects(() => svc.buildConsentsHtml(pool, CLINIC, [7]), /supera 100/);
});

test('consentsHtml API service publishes every part with pagination metadata and never publishes invalid/legacy truncated selections', async () => {
  const pool = fakeConsentPool(Array.from({ length: 101 }, (_, i) => ({
    id: i + 1, patient_id: 7, clinic_id: CLINIC, procedure_type: `Documento-${i + 1}`,
  })));
  const publications = [];
  const publish = async (clinicId, buffer, filename) => {
    assert.equal(clinicId, CLINIC);
    publications.push({ filename, html: gunzipSync(buffer).toString('utf8') });
    return { url: 'https://example.invalid/qa-download', filename };
  };
  await assert.rejects(() => api.exportConsentsFile(pool, CLINIC, { patientIds: [7] }, publish), /offset=0/);
  await assert.rejects(() => api.exportConsentsFile(pool, CLINIC, { patientIds: [7], limit: 101 }, publish), /Paginación inválida/);
  assert.equal(publications.length, 0);
  const first = await api.exportConsentsFile(pool, CLINIC, { patientIds: [7], offset: 0, limit: 100 }, publish);
  const last = await api.exportConsentsFile(pool, CLINIC, {
    patientIds: [7], offset: first.nextOffset, limit: 100, revision: first.revision,
  }, publish);
  assert.equal(first.count, 101);
  assert.equal(first.returnedCount, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.hasMore, true);
  assert.equal(last.returnedCount, 1);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextOffset, null);
  assert.equal(last.url, 'https://example.invalid/qa-download');
  assert.notEqual(first.filename, last.filename);
  assert.equal(publications.length, 2);
  assert.equal(Array.from(publications[0].html.matchAll(/<article>/g)).length, 100);
  assert.match(publications[1].html, /Documento-101/);
});

function fakeCronResponse() {
  return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
const cronRequest = () => ({ headers: { authorization: 'Bearer qa-cron-secret' } });

test('cron budget reports unstarted clinics, skips expensive maintenance and never claims full completion', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  let clock = 0;
  const snapshots = [];
  const res = fakeCronResponse();
  const pool = { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }, { id: 'third' }] }) };
  await runCron(cronRequest(), res, pool, {
    now: () => clock,
    snapshot: async (_pool, id) => { snapshots.push(id); clock += 20_000; return {}; },
    purgePhotos: async () => { clock += 11_000; return 4; },
    purgeWhatsApp: async () => assert.fail('No budget for WhatsApp maintenance'),
  });
  assert.equal(res.code, 207);
  assert.deepEqual(snapshots, [CLINIC]);
  assert.deepEqual(res.body.unprocessed, [OTHER, 'third']);
  assert.equal(res.body.ok, 1);
  assert.equal(res.body.complete, false);
  assert.equal(res.body.needsRetry, true);
  assert.equal(res.body.retryScheduled, false);
  assert.deepEqual(res.body.maintenance, { photos: 'complete', whatsapp: 'skipped' });
});

test('cron reports success only after every snapshot and both maintenance operations complete', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const snapshots = [];
  const res = fakeCronResponse();
  await runCron(cronRequest(), res, { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }] }) }, {
    snapshot: async (_pool, id) => { snapshots.push(id); return {}; },
    purgePhotos: async () => 2,
    purgeWhatsApp: async () => ({ shortLinks: 1, botStates: 3 }),
  });

  test('snapshot-heavy cron reserves the first slice for purging and reports both partial workloads accurately', async () => {
    process.env.CRON_SECRET = 'qa-cron-secret';
    let clock = 0;
    const order = [], res = fakeCronResponse();
    await runCron(cronRequest(), res, { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }] }) }, {
      now: () => clock,
      purgePhotos: async (_pool, _remove, budget, options) => {
        order.push('purge'); assert.equal(budget, 15000); assert.equal(options.now(), 0);
        clock += 10000; return { complete: false, waiting: 100 };
      },
      snapshot: async () => { order.push('snapshot'); clock += 25000; return {}; },
      purgeWhatsApp: async () => assert.fail('No leftover budget'),
    });
    assert.deepEqual(order, ['purge','snapshot']);
    assert.equal(res.code, 207);
    assert.equal(res.body.maintenance.photos, 'partial');
    assert.equal(res.body.photosPurged.waiting, 100);
    assert.deepEqual(res.body.unprocessed, [OTHER]);
    assert.equal(res.body.complete, false);
  });
  assert.equal(res.code, 200);
  assert.deepEqual(snapshots, [CLINIC, OTHER]);
  assert.equal(res.body.complete, true);
  assert.equal(res.body.needsRetry, false);
  assert.deepEqual(res.body.unprocessed, []);
});

test('cron failed snapshot is distinct from unprocessed clinics and contains no raw error data', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  let clock = 0;
  const res = fakeCronResponse();
  await runCron(cronRequest(), res, { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }] }) }, {
    now: () => clock,
    snapshot: async () => { clock += 31_000; throw new Error('SECRET DATA'); },
    purgePhotos: async () => ({ complete: true }),
    purgeWhatsApp: async () => assert.fail('Budget exhausted'),
  });
  assert.deepEqual(res.body.failed, [CLINIC]);
  assert.deepEqual(res.body.unprocessed, [OTHER]);
  assert.deepEqual(res.body.uncertain, []);
  assert.doesNotMatch(JSON.stringify(res.body), /SECRET DATA/);
});

test('cron timeout reports in-flight clinic as uncertain and never starts another operation', async t => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', callback => realSetTimeout(callback, 5));
  const res = fakeCronResponse();
  let clock = 0, finish, abortSignal;
  const pending = new Promise(resolve => { finish = resolve; });
  await runCron(cronRequest(), res, { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }] }) }, {
    now: () => clock,
    snapshot: async (_pool, _id, _kind, _user, { signal }) => {
      abortSignal = signal;
      clock = api.CRON_BUDGET_MS;
      return pending;
    },
    purgePhotos: async () => ({ complete: true }),
    purgeWhatsApp: async () => assert.fail('No maintenance after timeout'),
  });
  assert.equal(res.code, 207);
  assert.equal(res.body.ok, 0);
  assert.deepEqual(res.body.uncertain, [CLINIC]);
  assert.deepEqual(res.body.failed, []);
  assert.deepEqual(res.body.unprocessed, [OTHER]);
  assert.equal(res.body.retryScheduled, false);
  assert.equal(abortSignal.aborted, true);
  finish({}); // settle the non-cancelable mock; a late success never changes the report
  await pending;
  assert.equal(res.body.ok, 0);
});

test('unauthorized cron never queries or starts backup work', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const res = fakeCronResponse();
  await runCron({ headers: {} }, res, { query: () => assert.fail('No query allowed') });
  assert.equal(res.code, 401);
});

test('targeted cron checks existence with a parameterized query and only snapshots that clinic', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const queries = [], snapshots = [];
  const res = fakeCronResponse();
  await runCron({ ...cronRequest(), query: { clinicId: OTHER } }, res, {
    query: async (sql, params) => {
      queries.push([sql, params]);
      assert.match(sql, /SELECT c\.id,[\s\S]+WHERE c\.id=\$1/);
      assert.match(sql, /LEFT JOIN clinic_settings cs ON cs\.clinic_id=c\.id/);
      assert.deepEqual(params, [OTHER]);
      return { rows: [{ id: OTHER }] };
    },
  }, {
    snapshot: async (_pool, id, kind, by) => {
      assert.equal(queries.length, 1);
      snapshots.push(id);
      assert.equal(kind, 'auto');
      assert.equal(by, 'cron');
      return {};
    },
    purgePhotos: async () => assert.fail('Targeted retry must not purge all clinics'),
    purgeWhatsApp: async () => assert.fail('Targeted retry must not run global cleanup'),
  });
  assert.deepEqual(snapshots, [OTHER]);
  assert.equal(res.code, 200);
  assert.equal(res.body.scope, 'clinic');
  assert.equal(res.body.clinicId, OTHER);
  assert.equal(res.body.ok, 1);
  assert.equal(res.body.complete, true);
  assert.equal(res.body.needsRetry, false);
  assert.equal(res.body.retryScheduled, false);
  assert.deepEqual(res.body.unprocessed, []);
  assert.deepEqual(res.body.maintenance, { photos: 'not_requested', whatsapp: 'not_requested' });
});

test('targeted cron rejects malformed, repeated and empty clinic IDs before any DB query', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  for (const clinicId of ['', 'invalid', `${OTHER} OR 1=1`, ` ${OTHER}`, [OTHER], null, 7, {}]) {
    const res = fakeCronResponse();
    await runCron({ ...cronRequest(), query: { clinicId } }, res, {
      query: () => assert.fail('Invalid ID must never reach the database'),
    }, { snapshot: () => assert.fail('Invalid ID must never start snapshot') });
    assert.equal(res.code, 400);
    assert.match(res.body.error, /UUID válido/);
  }
});

test('targeted cron rejects nonexistent clinic without snapshot or maintenance', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const res = fakeCronResponse();
  await runCron({ ...cronRequest(), query: { clinicId: OTHER } }, res, {
    query: async (sql, params) => {
      assert.match(sql, /SELECT c\.id,[\s\S]+WHERE c\.id=\$1/);
      assert.match(sql, /LEFT JOIN clinic_settings cs ON cs\.clinic_id=c\.id/);
      assert.deepEqual(params, [OTHER]);
      return { rows: [] };
    },
  }, {
    snapshot: () => assert.fail('Missing clinic cannot be backed up'),
    purgePhotos: () => assert.fail('No maintenance'),
    purgeWhatsApp: () => assert.fail('No maintenance'),
  });
  assert.equal(res.code, 404);
  assert.equal(res.body.ok, 0);
  assert.equal(res.body.scope, 'clinic');
  assert.equal(res.body.complete, false);
  assert.equal(res.body.retryScheduled, false);
});

test('targeted cron still requires cron authentication before validation or DB access', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const res = fakeCronResponse();
  await runCron({ headers: {}, query: { clinicId: OTHER } }, res, {
    query: () => assert.fail('Unauthenticated targeted retry queried DB'),
  });
  assert.equal(res.code, 401);
});

// ── batch-jsonl-v1 ───────────────────────────────────────────────────────────
function fakeExportPool(data, { shortFetch, log = [] } = {}) {
  const cursors = new Map();
  let released = false;
  const client = {
    query: async (sql, params) => {
      const s = sql.trim();
      log.push(s.split(/\s+/).slice(0, 3).join(' '));
      if (log.length === 1) log.first = s;
      assert.doesNotMatch(s, /\bOFFSET\b/i);
      if (s.startsWith('BEGIN') || s === 'COMMIT' || s === 'ROLLBACK' || s.startsWith('CLOSE')) return { rows: [] };
      if (/^SET LOCAL statement_timeout = \d+$/.test(s)) return { rows: [] };
      if (s.includes('information_schema.tables')) return { rows: Object.keys(data).map(table_name => ({ table_name })) };
      if (s.startsWith('SELECT now()')) return { rows: [{ snapshot_at: new Date('2026-01-02T03:04:05Z'), clinic_name: 'Clínica QA' }] };
      const declared = s.match(/^DECLARE (\w+) NO SCROLL CURSOR FOR SELECT (.+?) FROM \((?:SELECT .+? FROM (\w+))/s);
      if (declared) {
        assert.deepEqual(params, [CLINIC]);
        const rows = data[declared[3]] || [];
        const sizes = declared[2].startsWith('octet_length');
        cursors.set(declared[1], { pos: 0, rows: sizes ? rows.map(r => ({ b: Buffer.byteLength(JSON.stringify(r)) })) : rows });
        return { rows: [] };
      }
      const fetch = s.match(/^FETCH FORWARD (\d+) FROM (\w+)$/);
      if (fetch) {
        const cursor = cursors.get(fetch[2]);
        let n = Number(fetch[1]);
        if (shortFetch && fetch[2].startsWith('bsk_rows') && n > 1) n -= 1;
        const rows = cursor.rows.slice(cursor.pos, cursor.pos + n);
        cursor.pos += rows.length;
        return { rows };
      }
      throw new Error(`Unexpected ${s}`);
    },
    release: () => { released = true; },
  };
  return { log, pool: { connect: async () => client }, released: () => released };
}

async function collectBatchFile(pool, options = {}) {
  let summary = null;
  const chunks = [];
  for await (const chunk of svc.encodeBatchExport(svc.streamBatchExport(pool, { clinicId: CLINIC, generatedBy: 'qa',
    onComplete: value => { summary = value; }, ...options }))) chunks.push(chunk);
  const lines = gunzipSync(Buffer.concat(chunks)).toString('utf8').split('\n');
  assert.equal(lines.pop(), '');
  return { lines, summary };
}

const patientRows = (n, start = 1) => Array.from({ length: n }, (_, i) => ({ id: start + i, first_name: `P${start + i}`, clinic_id: CLINIC }));

test('batch export streams manifest, bounded batches and trailer from one read-only snapshot without OFFSET', async () => {
  const big = 'x'.repeat(200 * 1024);
  const data = {
    patients: patientRows(1200),
    consent_forms: [1, 2, 3].map(id => ({ id, clinic_id: CLINIC, body: big, signing_otp_hash: 'secret', signing_token: 'tok' })),
    clinics: [{ id: CLINIC, name: 'QA', smtp_password: 'secret' }],
    clinic_users: [{ id: 7, username: 'ana', password_hash: 'hash', role: 'clinic_admin' }],
  };
  const fake = fakeExportPool(data);
  const { lines, summary } = await collectBatchFile(fake.pool, { modules: ['patients', 'config'] });
  assert.equal(fake.log.first, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(fake.log.includes('COMMIT') && !fake.log.includes('ROLLBACK') && fake.released());
  const ctx = svc.inspectBatchManifest(lines[0], CLINIC);
  assert.equal(ctx.signature, 'valid');
  assert.deepEqual(ctx.manifest.tables.map(t => t.name), ['patients', 'consent_forms', 'clinics', 'clinic_users']);
  assert.deepEqual(ctx.manifest.plan, [[0, 500], [0, 500], [0, 200], [1, 2], [1, 1], [2, 1], [3, 1]]);
  assert.equal(ctx.manifest.total_batches, lines.length - 2);
  let chain = ctx.sha256;
  const seen = {};
  for (let i = 1; i < lines.length - 1; i++) {
    assert.ok(Buffer.byteLength(lines[i]) <= svc.BATCH_LIMITS.maxLineBytes);
    const { batch, sha256 } = svc.openBatch(lines[i], ctx, i - 1);
    seen[batch.table] = (seen[batch.table] || 0) + batch.count;
    chain = svc.chainBatchHash(chain, sha256);
  }
  assert.deepEqual(seen, { patients: 1200, consent_forms: 3, clinics: 1, clinic_users: 1 });
  assert.equal(svc.openBatchTrailer(lines.at(-1), ctx, chain).complete, true);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /signing_otp_hash|signing_token|password_hash|smtp_password/);
  assert.deepEqual(summary.counts, ctx.manifest.counts);
  assert.equal(summary.manifest_sha256, ctx.sha256);
});

test('batch export rolls back and never completes when a cursor returns fewer rows than planned', async () => {
  const fake = fakeExportPool({ patients: patientRows(10) }, { shortFetch: true });
  let completed = false;
  await assert.rejects(() => collectBatchFile(fake.pool, { modules: ['patients'], onComplete: () => { completed = true; } }), /no coincide con el plan/);
  assert.equal(completed, false);
  assert.ok(fake.log.includes('ROLLBACK') && !fake.log.includes('COMMIT') && fake.released());
});

test('batch export rolls back if cancellation arrives while BEGIN is completing', async () => {
  const controller = new AbortController();
  const queries = [];
  let released = false;
  const pool = { connect: async () => ({
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN')) controller.abort(new Error('cancel during BEGIN'));
      return { rows: [] };
    },
    release() { released = true; },
  }) };
  const consume = async () => {
    for await (const line of svc.streamBatchExport(pool, { clinicId: CLINIC, modules: ['patients'], signal: controller.signal })) void line;
  };
  await assert.rejects(consume, /cancel during BEGIN/);
  assert.ok(queries.some(query => query === 'ROLLBACK'));
  assert.equal(released, true);
});

test('batch export applies the remaining deadline to DB statements and reports timeout instead of hanging', async () => {
  let statementTimeout = 0;
  let released = false;
  const pool = { connect: async () => ({
    async query(sql) {
      if (sql.startsWith('SET LOCAL statement_timeout')) {
        statementTimeout = Number(/= (\d+)/.exec(sql)?.[1]);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT table_name')) {
        return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('cancelled'), { code: '57014' })),
          statementTimeout));
      }
      return { rows: [] };
    },
    release() { released = true; },
  }) };
  const started = Date.now();
  await assert.rejects(() => api.exportBatchObject(pool, {
    clinicId: CLINIC, modules: ['patients'], kind: 'download', key: 'temporary',
    budgetMs: 30, storage: { upload: async (_key, chunks) => { for await (const chunk of chunks) void chunk; } },
  }), error => error.status === 504 && error.details.reason === 'TIMEOUT');
  assert.ok(statementTimeout > 0 && statementTimeout <= 30);
  assert.ok(Date.now() - started < 250);
  assert.equal(released, true);
});

test('batch export timeout while acquiring a DB connection releases any late connection', async () => {
  let released = false;
  const pool = { connect: () => new Promise(resolve => setTimeout(() => resolve({ release() { released = true; } }), 80)) };
  const started = Date.now();
  await assert.rejects(async () => {
    for await (const line of svc.streamBatchExport(pool, { clinicId: CLINIC, modules: ['patients'], budgetMs: 15 })) void line;
  }, error => error.name === 'TimeoutError');
  assert.ok(Date.now() - started < 70);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(released, true);
});

test('batch export fails explicitly when a single row exceeds the line limit', async () => {
  const fake = fakeExportPool({ patients: [{ id: 1, clinic_id: CLINIC, notes: 'x'.repeat(1.1 * 1024 * 1024) }] });
  await assert.rejects(() => collectBatchFile(fake.pool, { modules: ['patients'] }), error => error.status === 413 && error.details.reason === 'SIZE');
  assert.ok(fake.log.includes('ROLLBACK') && fake.released());
});

test('batch multipart deletes an object when post-completion verification fails', async t => {
  const previousAccess = process.env.R2_ACCESS_KEY_ID;
  const previousSecret = process.env.R2_SECRET_ACCESS_KEY;
  process.env.R2_ACCESS_KEY_ID = 'test-access';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  t.after(() => {
    if (previousAccess === undefined) delete process.env.R2_ACCESS_KEY_ID; else process.env.R2_ACCESS_KEY_ID = previousAccess;
    if (previousSecret === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = previousSecret;
  });
  let completed = false, deleted = false, deleteSignal;
  t.mock.method(S3Client.prototype, 'send', async function (command, options) {
    switch (command.constructor.name) {
      case 'CreateMultipartUploadCommand': return { UploadId: 'upload-test' };
      case 'UploadPartCommand': return { ETag: 'etag-test' };
      case 'CompleteMultipartUploadCommand': completed = true; return {};
      case 'HeadObjectCommand': throw new Error('R2 verification failed');
      case 'DeleteObjectCommand': deleted = true; deleteSignal = options?.abortSignal; return {};
      default: throw new Error(`Unexpected R2 command ${command.constructor.name}`);
    }
  });
  const chunks = async function* () { yield Buffer.from('small test body'); };
  await assert.rejects(() => api.r2BatchStorage.upload('backups/test/export.jsonl.gz.enc', chunks(), 'application/octet-stream'),
    /R2 verification failed/);
  assert.equal(completed, true);
  assert.equal(deleted, true);
  assert.ok(deleteSignal instanceof AbortSignal);
});

test('batch multipart surfaces uncertain publication if cleanup after verification failure also fails', async t => {
  const previousAccess = process.env.R2_ACCESS_KEY_ID;
  const previousSecret = process.env.R2_SECRET_ACCESS_KEY;
  process.env.R2_ACCESS_KEY_ID = 'test-access';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  t.after(() => {
    if (previousAccess === undefined) delete process.env.R2_ACCESS_KEY_ID; else process.env.R2_ACCESS_KEY_ID = previousAccess;
    if (previousSecret === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = previousSecret;
  });
  let deleteSignal;
  t.mock.method(S3Client.prototype, 'send', async function (command, options) {
    switch (command.constructor.name) {
      case 'CreateMultipartUploadCommand': return { UploadId: 'upload-test' };
      case 'UploadPartCommand': return { ETag: 'etag-test' };
      case 'CompleteMultipartUploadCommand': return {};
      case 'HeadObjectCommand': throw new Error('R2 verification failed');
      case 'DeleteObjectCommand': deleteSignal = options?.abortSignal; throw new Error('R2 deletion failed');
      default: throw new Error(`Unexpected R2 command ${command.constructor.name}`);
    }
  });
  const chunks = async function* () { yield Buffer.from('small test body'); };
  await assert.rejects(() => api.r2BatchStorage.upload('backups/test/export.jsonl.gz.enc', chunks(), 'application/octet-stream'),
    error => error.status === 502 && error.details.reason === 'PUBLICATION_UNCERTAIN' && /incierta/.test(error.message));
  assert.ok(deleteSignal instanceof AbortSignal);
});

test('batch multipart aborts an upload when completion fails ambiguously, with bounded cleanup signals', async t => {
  const previousAccess = process.env.R2_ACCESS_KEY_ID;
  const previousSecret = process.env.R2_SECRET_ACCESS_KEY;
  process.env.R2_ACCESS_KEY_ID = 'test-access';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  t.after(() => {
    if (previousAccess === undefined) delete process.env.R2_ACCESS_KEY_ID; else process.env.R2_ACCESS_KEY_ID = previousAccess;
    if (previousSecret === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = previousSecret;
  });
  const cleanupCalls = [];
  t.mock.method(S3Client.prototype, 'send', async function (command, options) {
    switch (command.constructor.name) {
      case 'CreateMultipartUploadCommand': return { UploadId: 'upload-test' };
      case 'UploadPartCommand': return { ETag: 'etag-test' };
      case 'CompleteMultipartUploadCommand': throw new Error('R2 completion response lost');
      case 'DeleteObjectCommand':
      case 'AbortMultipartUploadCommand':
        cleanupCalls.push({ command: command.constructor.name, signal: options?.abortSignal });
        return {};
      default: throw new Error(`Unexpected R2 command ${command.constructor.name}`);
    }
  });
  const chunks = async function* () { yield Buffer.from('small test body'); };
  await assert.rejects(() => api.r2BatchStorage.upload('backups/test/export.jsonl.gz.enc', chunks(), 'application/octet-stream'),
    /R2 completion response lost/);
  assert.deepEqual(cleanupCalls.map(call => call.command), ['DeleteObjectCommand', 'AbortMultipartUploadCommand']);
  assert.ok(cleanupCalls.every(call => call.signal instanceof AbortSignal));
  assert.notEqual(cleanupCalls[0].signal, cleanupCalls[1].signal);
});

test('batch multipart reports failed abort cleanup instead of masking an orphaned upload', async t => {
  const previousAccess = process.env.R2_ACCESS_KEY_ID;
  const previousSecret = process.env.R2_SECRET_ACCESS_KEY;
  process.env.R2_ACCESS_KEY_ID = 'test-access';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  t.after(() => {
    if (previousAccess === undefined) delete process.env.R2_ACCESS_KEY_ID; else process.env.R2_ACCESS_KEY_ID = previousAccess;
    if (previousSecret === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = previousSecret;
  });
  let abortSignal;
  t.mock.method(S3Client.prototype, 'send', async function (command, options) {
    switch (command.constructor.name) {
      case 'CreateMultipartUploadCommand': return { UploadId: 'upload-test' };
      case 'UploadPartCommand': throw new Error('R2 part upload failed');
      case 'AbortMultipartUploadCommand':
        abortSignal = options?.abortSignal;
        throw new Error('R2 abort failed');
      default: throw new Error(`Unexpected R2 command ${command.constructor.name}`);
    }
  });
  const chunks = async function* () { yield Buffer.from('small test body'); };
  await assert.rejects(() => api.r2BatchStorage.upload('backups/test/export.jsonl.gz.enc', chunks(), 'application/octet-stream'),
    error => error.status === 502 && error.details.reason === 'MULTIPART_CLEANUP_UNCERTAIN' &&
      error.cleanupUncertain === true && /no se publicó ningún archivo/.test(error.message));
  assert.ok(abortSignal instanceof AbortSignal);
});

test('encrypted batch stream round-trips and rejects tampering; parts have fixed size', async () => {
  const marker = 'qa-clinical-plaintext-marker-6c1f9d9e-dbc1-4e78-bfe0-97231';
  const fake = fakeExportPool({ patients: [{ id: 1, clinic_id: CLINIC, notes: marker }] });
  const chunks = [];
  for await (const c of svc.encodeBatchExport(svc.streamBatchExport(fake.pool, { clinicId: CLINIC, modules: ['patients'] }), { encrypt: true })) chunks.push(c);
  const enc = Buffer.concat(chunks);
  assert.equal(enc.subarray(0, 5).toString(), 'BSKE2');
  assert.equal(enc.includes(Buffer.from(marker)), false);
  const plain = [];
  for await (const c of svc.decryptBatchSnapshot([enc.subarray(0, 7), enc.subarray(7)])) plain.push(c);
  const restored = gunzipSync(Buffer.concat(plain)).toString();
  assert.match(restored, /"type":"trailer"/);
  assert.match(restored, new RegExp(marker));
  const tampered = Buffer.from(enc);
  tampered[30] ^= 1;
  await assert.rejects(async () => { for await (const c of svc.decryptBatchSnapshot([tampered])) void c; }, /alterado/);
  const parts = [];
  for await (const p of svc.fixedSizeParts([Buffer.alloc(5), Buffer.alloc(9), Buffer.alloc(3)], 4)) parts.push(p.length);
  assert.deepEqual(parts, [4, 4, 4, 4, 1]);
});

function memoryStorage({ failUpload } = {}) {
  const objects = new Map();
  return {
    objects,
    async upload(key, chunks, _type, { beforeComplete } = {}) {
      const parts = [];
      for await (const part of chunks) { parts.push(part); if (failUpload) throw new Error('R2 caído'); }
      beforeComplete?.();
      objects.set(key, Buffer.concat(parts));
      return { key, size: objects.get(key).length };
    },
    async *download(key) { yield objects.get(key); },
    downloadUrl: async key => `https://r2.test/${key}`,
  };
}

test('batch object is published only after the trailer and releases the snapshot when upload fails', async () => {
  const storage = memoryStorage();
  const file = await api.exportBatchDownload(fakeExportPool({ patients: patientRows(2) }).pool, CLINIC, ['patients'], 'qa', { storage });
  assert.equal(file.format, 'batch-jsonl-v1');
  assert.equal(file.total_batches, 1);
  assert.match(file.filename, /\.jsonl\.gz$/);
  assert.equal(storage.objects.size, 1);
  const failing = memoryStorage({ failUpload: true });
  const noisy = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, clinic_id: CLINIC, notes: randomBytes(150).toString('base64') }));
  const fake = fakeExportPool({ patients: noisy });
  await assert.rejects(() => api.exportBatchDownload(fake.pool, CLINIC, ['patients'], 'qa', { storage: failing }), /R2 caído/);
  assert.equal(failing.objects.size, 0);
  assert.ok(fake.log.includes('ROLLBACK') && fake.released());
  const pre = memoryStorage();
  const snap = await api.createBatchPreRestore(fakeExportPool({ patients: patientRows(2) }).pool, CLINIC, 'qa', { storage: pre });
  assert.ok(api.isBatchSnapshotKey(snap.key, CLINIC) && !api.isBatchSnapshotKey(snap.key, OTHER));
  const republished = await api.republishBatchSnapshot(CLINIC, snap.key, { storage: pre });
  assert.match(republished.url, /backup-tmp/);
});

async function exportLines(data, modules = ['patients']) {
  return (await collectBatchFile(fakeExportPool(data).pool, { modules })).lines;
}

function statefulRestorePool({ failPatientId, missingRecords = false } = {}) {
  const committed = new Set();
  let pending = new Set();
  const log = [];
  const client = {
    query: async (statement, params) => {
      const s = statement.trim();
      log.push(s.split(/\s+/).slice(0, 3).join(' '));
      if (s === 'BEGIN') { pending = new Set(); return { rows: [] }; }
      if (s === 'COMMIT') { pending.forEach(id => committed.add(id)); return { rows: [] }; }
      if (s === 'ROLLBACK') { pending = new Set(); return { rows: [] }; }
      if (s.includes('information_schema.columns')) return { rows: ['id', 'first_name', 'clinic_id', 'rut', 'identification_number', 'patient_id', 'record_id'].map(column_name => ({ column_name })) };
      if (s.includes("SELECT c.is_active,cs.general ? '_purge'")) return { rows: [{ is_active: true, purging: false }] };
      if (s.startsWith('SELECT 1 FROM clinical_records') || s.startsWith('SELECT 1 FROM patients')) return { rows: missingRecords ? [] : [{}] };
      if (s.startsWith('SELECT clinic_id FROM patients')) return { rows: committed.has(params[0]) || pending.has(params[0]) ? [{ clinic_id: CLINIC }] : [] };
      if (s.startsWith('SELECT clinic_id FROM')) return { rows: [] };
      if (s.startsWith('INSERT INTO patients')) {
        if (params[0] === failPatientId) throw Object.assign(new Error('dup'), { code: '23505' });
        if (committed.has(params[0]) || pending.has(params[0])) return { rowCount: 0 };
        pending.add(params[0]);
        return { rowCount: 1 };
      }
      return { rows: [{}], rowCount: 0 };
    },
    release: () => {},
  };
  return { log, committed, pool: { connect: async () => client, query: client.query } };
}

const okPreRestore = async () => ({ key: `backups/${CLINIC}/pre-restore/x.jsonl.gz.enc`, size: 10, manifest_sha256: 'h' });
const restoreCall = (pool, body, extra = {}) => {
  const request = { format: 'batch-jsonl-v1', ...body };
  return api.handleBatchRestore(pool, request, {
    clinicId: CLINIC, userId: 9, username: 'qa', preRestore: okPreRestore,
    contentLength: Buffer.byteLength(JSON.stringify(request)), ...extra,
  });
};

test('batch restore requires a verified pre-restore before any write and applies idempotently with resume token', async () => {
  const lines = await exportLines({ patients: patientRows(600) });
  const [manifest, b0, b1, trailer] = lines;
  const db = statefulRestorePool();
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0, dryRun: false }),
    error => error.status === 409 && error.details.reason === 'PREPARE_REQUIRED');
  await assert.rejects(() => restoreCall(db.pool, { phase: 'prepare', manifest }, { preRestore: async () => { throw new Error('R2 caído'); } }), /R2 caído/);
  assert.ok(!db.log.includes('COMMIT'));
  const prepared = await restoreCall(db.pool, { phase: 'prepare', manifest });
  assert.equal(prepared.mode, 'apply');
  assert.match(prepared.pre_restore_snapshot, /pre-restore/);
  assert.deepEqual(prepared.progress, { next_index: 0, total_batches: 2, done: false });
  const first = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0, dryRun: false, resumeToken: prepared.resume_token });
  assert.equal(first.committed, true);
  assert.deepEqual(first.report.inserted, { patients: 500 });
  assert.equal(db.committed.size, 500);
  const setval = db.log.findIndex(entry => entry.startsWith('SELECT setval('));
  assert.ok(setval > 0 && setval < db.log.lastIndexOf('COMMIT'));
  // Respuesta perdida: reintentar el mismo lote con el token anterior no duplica ni sobrescribe.
  const retry = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0, dryRun: false, resumeToken: prepared.resume_token });
  assert.deepEqual(retry.report.existing, { patients: 500 });
  assert.deepEqual(retry.report.inserted, {});
  assert.equal(db.committed.size, 500);
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: b1, index: 1, dryRun: false, resumeToken: prepared.resume_token }),
    error => error.status === 409 && error.details.reason === 'SEQUENCE' && error.details.expected_index === 0);
  await assert.rejects(() => restoreCall(db.pool, { phase: 'finish', manifest, trailer, resumeToken: first.resume_token }),
    error => error.details.reason === 'SEQUENCE');
  const second = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b1, index: 1, dryRun: false, resumeToken: first.resume_token });
  assert.equal(db.committed.size, 600);
  assert.equal(second.progress.done, true);
  const done = await restoreCall(db.pool, { phase: 'finish', manifest, trailer, resumeToken: second.resume_token });
  assert.equal(done.completed, true);
  // Restart desde cero con el mismo archivo es seguro.
  const again = await restoreCall(db.pool, { phase: 'prepare', manifest });
  const replay = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0, dryRun: false, resumeToken: again.resume_token });
  assert.equal(replay.report.existing.patients, 500);
  assert.equal(db.committed.size, 600);
  // Token ligado a clínica y usuario.
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: b1, index: 1, dryRun: false, resumeToken: first.resume_token }, { userId: 10 }),
    error => error.details.reason === 'TOKEN');
});

test('batch restore dry run never commits, defers missing parents and its token cannot authorize writes', async () => {
  const lines = await exportLines({ patients: patientRows(1), clinical_records: [{ id: 5, clinic_id: CLINIC, patient_id: 1 }] });
  const [manifest, b0, b1] = lines;
  const db = statefulRestorePool({ missingRecords: true });
  const dry0 = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0 });
  assert.equal(dry0.mode, 'dry_run');
  assert.equal(dry0.committed, false);
  const dry1 = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b1, index: 1, resumeToken: dry0.resume_token });
  assert.deepEqual(dry1.report.deferred, { clinical_records: 1 });
  assert.equal(dry1.report.errorCount, 0);
  assert.ok(!db.log.includes('COMMIT') && db.committed.size === 0);
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: b1, index: 1, dryRun: false, resumeToken: dry0.resume_token }),
    error => error.details.reason === 'TOKEN');
});

test('batch restore needs explicit allowPartial and keeps the cursor on the failed batch', async () => {
  const [manifest, b0] = await exportLines({ patients: patientRows(3) });
  const db = statefulRestorePool({ failPatientId: 2 });
  const prepared = await restoreCall(db.pool, { phase: 'prepare', manifest });
  const blocked = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0, dryRun: false, resumeToken: prepared.resume_token });
  assert.equal(blocked.committed, false);
  assert.equal(blocked.needs_allow_partial, true);
  assert.equal(blocked.progress.next_index, 0);
  assert.equal(blocked.resume_token, prepared.resume_token);
  assert.equal(db.committed.size, 0);
  const partial = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0, dryRun: false, allowPartial: true, resumeToken: prepared.resume_token });
  assert.equal(partial.committed, true);
  assert.equal(partial.report.errorCount, 1);
  assert.equal(db.committed.size, 2);
});

test('batch restore rejects tampering, cross-tenant rows, oversize requests and missing confirmations', async () => {
  const [manifest, b0, trailer] = await exportLines({ patients: patientRows(2) });
  const db = statefulRestorePool();
  await assert.rejects(() => api.handleBatchRestore(db.pool, { format: 'batch-jsonl-v1', phase: 'inspect', manifest },
    { clinicId: CLINIC }), error => error.status === 411);
  const tamperedBatch = b0.replace('"P1"', '"PX"');
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: tamperedBatch, index: 0 }), error => error.details.reason === 'INTEGRITY');
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest: manifest.replace('"total_batches":1', '"total_batches":2'), batch: b0, index: 0 }),
    error => error.status === 422);
  // Reempaquetado sin firma con una fila de otra clínica: rechazado por tenant antes de tocar la base.
  const parsed = JSON.parse(b0);
  const ctx = svc.inspectBatchManifest(manifest, CLINIC);
  const content = { ...parsed };
  delete content.sha256;
  delete content.signature;
  content.rows[1].clinic_id = OTHER;
  const forged = svc.sealBatchLine(content).line.trim();
  assert.throws(() => svc.openBatch(forged, ctx, 0), error => error.details.reason === 'TENANT');
  const unsignedManifest = (() => { const m = JSON.parse(manifest);
    delete m.sha256;
    delete m.signature;
    const sha256 = createHash('sha256').update(JSON.stringify(m)).digest('hex'); return JSON.stringify({ ...m, sha256, signature: null }); })();
  await assert.rejects(() => restoreCall(db.pool, { phase: 'prepare', manifest: unsignedManifest }), error => error.details.reason === 'CONFIRMATION');
  await assert.rejects(() => restoreCall(db.pool, { phase: 'prepare', manifest }, { clinicId: OTHER }), error => error.details.reason === 'CONFIRMATION');
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0 }, { contentLength: 4 * 1024 * 1024 }),
    error => error.status === 413);
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: b0 + ' '.repeat(3 * 1024 * 1024), index: 0 }),
    error => error.status === 413);
  const dry = await restoreCall(db.pool, { phase: 'batch', manifest, batch: b0, index: 0 });
  await assert.rejects(() => restoreCall(db.pool, { phase: 'finish', manifest, trailer: trailer.replace('"complete":true', '"complete":false'), resumeToken: dry.resume_token }),
    error => error.status === 422);
  assert.ok(!db.log.includes('COMMIT'));
});

test('batch restore rejects invalid HMAC signatures and measures the complete parsed request body', async () => {
  const [manifest, batch, trailer] = await exportLines({ patients: patientRows(1) });
  const db = statefulRestorePool();
  const invalidSignature = line => {
    const parsed = JSON.parse(line);
    parsed.signature = '0'.repeat(64);
    return JSON.stringify(parsed);
  };
  await assert.rejects(() => restoreCall(db.pool, { phase: 'inspect', manifest: invalidSignature(manifest) }),
    error => error.details.reason === 'INTEGRITY');
  const inspected = await restoreCall(db.pool, { phase: 'inspect', manifest });
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: invalidSignature(batch),
    index: 0, resumeToken: inspected.resume_token }),
  error => error.details.reason === 'INTEGRITY');
  const simulated = await restoreCall(db.pool, { phase: 'batch', manifest, batch, index: 0,
    resumeToken: inspected.resume_token });
  await assert.rejects(() => restoreCall(db.pool, { phase: 'finish', manifest, trailer: invalidSignature(trailer),
    resumeToken: simulated.resume_token }),
  error => error.details.reason === 'INTEGRITY');
  await assert.rejects(() => restoreCall(db.pool, {
    phase: 'inspect', manifest, unrelated: 'x'.repeat(svc.BATCH_LIMITS.maxRequestBytes),
  }), error => error.status === 413 && error.details.reason === 'SIZE');
  await assert.rejects(() => restoreCall(db.pool, { phase: 'inspect', manifest }, { contentLength: 'invalid' }),
    error => error.status === 400 && error.details.reason === 'MALFORMED');
  assert.equal(db.committed.size, 0);
});

test('batch manifests reject malformed Unicode HMAC values as integrity errors', async () => {
  const [manifest] = await exportLines({ patients: patientRows(1) });
  const parsed = JSON.parse(manifest);
  parsed.signature = 'é'.repeat(64);
  const malformed = JSON.stringify(parsed);
  assert.equal(svc.openBatchLine(malformed, 'manifest', svc.BATCH_LIMITS.maxManifestBytes).signature, 'invalid');
  assert.throws(() => svc.inspectBatchManifest(malformed, CLINIC),
    error => error.status === 422 && error.details.reason === 'INTEGRITY');
});

test('batch contract limits stay below the serverless body limit', () => {
  assert.equal(svc.BATCH_FORMAT, 'batch-jsonl-v1');
  assert.ok(svc.BATCH_LIMITS.maxRequestBytes < 4 * 1024 * 1024);
  assert.ok(svc.BATCH_LIMITS.maxLineBytes <= 1024 * 1024 && svc.BATCH_LIMITS.maxBatchRows === 500);
});

test('batch restore inspect is read-only, never creates pre-restore and supports an empty batch plan', async () => {
  const [manifest, trailer, ...rest] = await exportLines({ patients: [] });
  assert.equal(rest.length, 0);
  const db = statefulRestorePool();
  let preRestoreCalls = 0;
  const preRestore = async () => { preRestoreCalls++; return okPreRestore(); };
  const inspected = await restoreCall(db.pool, { phase: 'inspect', manifest }, { preRestore });
  assert.equal(inspected.mode, 'dry_run');
  assert.equal(inspected.committed, false);
  assert.equal(inspected.pre_restore_snapshot, null);
  assert.deepEqual(inspected.confirmations, []);
  assert.equal(inspected.info.total_batches, 0);
  assert.deepEqual(inspected.progress, { next_index: 0, total_batches: 0, done: true });
  assert.equal(typeof inspected.resume_token, 'string');
  const foreign = await restoreCall(db.pool, { phase: 'inspect', manifest }, { clinicId: OTHER, preRestore });
  assert.deepEqual(foreign.confirmations, ['foreignClinic']);
  assert.equal(preRestoreCalls, 0);
  assert.ok(!db.log.some(entry => /^(BEGIN|COMMIT|INSERT|SAVEPOINT)/.test(entry)));
  assert.equal(db.committed.size, 0);
  // El token de inspección solo simula: no autoriza escrituras y cierra un plan vacío con finish.
  await assert.rejects(() => restoreCall(db.pool, { phase: 'batch', manifest, batch: trailer, index: 0, dryRun: false, resumeToken: inspected.resume_token }),
    error => error.status === 409);
  const done = await restoreCall(db.pool, { phase: 'finish', manifest, trailer, resumeToken: inspected.resume_token }, { preRestore });
  assert.equal(done.completed, true);
  assert.equal(done.mode, 'dry_run');
  assert.equal(preRestoreCalls, 0);
});
