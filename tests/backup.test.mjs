import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';

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
