import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

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
  await api.runCron(cronRequest(), res, pool, {
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
  await api.runCron(cronRequest(), res, { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }] }) }, {
    snapshot: async (_pool, id) => { snapshots.push(id); return {}; },
    purgePhotos: async () => 2,
    purgeWhatsApp: async () => ({ shortLinks: 1, botStates: 3 }),
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
  await api.runCron(cronRequest(), res, { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }] }) }, {
    now: () => clock,
    snapshot: async () => { clock += 31_000; throw new Error('SECRET DATA'); },
    purgePhotos: async () => assert.fail('Budget exhausted'),
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
  await api.runCron(cronRequest(), res, { query: async () => ({ rows: [{ id: CLINIC }, { id: OTHER }] }) }, {
    now: () => clock,
    snapshot: async (_pool, _id, _kind, _user, { signal }) => {
      abortSignal = signal;
      clock = api.CRON_BUDGET_MS;
      return pending;
    },
    purgePhotos: async () => assert.fail('No maintenance after timeout'),
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
  await api.runCron({ headers: {} }, res, { query: () => assert.fail('No query allowed') });
  assert.equal(res.code, 401);
});

test('targeted cron checks existence with a parameterized query and only snapshots that clinic', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const queries = [], snapshots = [];
  const res = fakeCronResponse();
  await api.runCron({ ...cronRequest(), query: { clinicId: OTHER } }, res, {
    query: async (sql, params) => {
      queries.push([sql, params]);
      assert.equal(sql, 'SELECT id FROM clinics WHERE id = $1');
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
    await api.runCron({ ...cronRequest(), query: { clinicId } }, res, {
      query: () => assert.fail('Invalid ID must never reach the database'),
    }, { snapshot: () => assert.fail('Invalid ID must never start snapshot') });
    assert.equal(res.code, 400);
    assert.match(res.body.error, /UUID válido/);
  }
});

test('targeted cron rejects nonexistent clinic without snapshot or maintenance', async () => {
  process.env.CRON_SECRET = 'qa-cron-secret';
  const res = fakeCronResponse();
  await api.runCron({ ...cronRequest(), query: { clinicId: OTHER } }, res, {
    query: async (sql, params) => {
      assert.equal(sql, 'SELECT id FROM clinics WHERE id = $1');
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
  await api.runCron({ headers: {}, query: { clinicId: OTHER } }, res, {
    query: () => assert.fail('Unauthenticated targeted retry queried DB'),
  });
  assert.equal(res.code, 401);
});
