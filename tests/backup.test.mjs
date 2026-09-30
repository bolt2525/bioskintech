import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

process.env.BACKUP_ENCRYPTION_KEY = 'test-key-'.padEnd(48, 'x');
const svc = await import('../lib/backup-service.js');
const api = await import('../api/backup.js');
const CLINIC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

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

test('photo purge deletes storage first and keeps rows whose object could not be deleted', async () => {
  const deletedRows = [];
  const pool = { query: async (sql, params) => {
    if (sql.startsWith('SELECT f.id')) { assert.match(sql, /INTERVAL '30 days'/); return { rows: [{ id: 1, r2_key: 'a' }, { id: 2, r2_key: 'b' }] }; }
    deletedRows.push(params[0]); return { rowCount: 1 };
  } };
  const removed = await api.purgeExpiredClinicPhotos(pool, async key => { if (key === 'b') throw new Error('R2 down'); });
  assert.equal(removed, 1);
  assert.deepEqual(deletedRows, [1]);
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
