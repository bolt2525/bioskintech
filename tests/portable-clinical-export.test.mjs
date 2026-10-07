import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPortableDocuments } from '../lib/portable-clinical-export.js';

const snapshot = () => ({
  patients: { tables: {
    patients: [{ id: 1, clinic_id: 'clinic-a', first_name: '<script>alert(1)</script>' }],
    clinical_records: [{ id: 2, clinic_id: 'clinic-a', patient_id: 1 }],
    consultations: [{ id: 3, clinic_id: 'clinic-a', record_id: 2 }],
    diagnoses: [{ id: 4, clinic_id: 'clinic-a', consultation_id: 3, text: 'Diagnóstico ficticio' }],
    consent_forms: [{ id: 5, clinic_id: 'clinic-a', patient_id: 1, content_text: 'Consentimiento ficticio', signing_token: 'secret-not-exported', signing_hash: 'evidence' }],
  } },
});

test('portable copy includes readable records, consent evidence and technical data', () => {
  const files = buildPortableDocuments(snapshot(), { clinicId: 'clinic-a' });
  assert.ok(files.some(file => file.name === 'datos/backup.json'));
  assert.doesNotMatch(files.find(file => file.name === 'datos/backup.json').body.toString(), /secret-not-exported/);
  const history = files.find(file => file.name === 'historias/paciente-1.html').body.toString();
  assert.match(history, /Diagnóstico ficticio/);
  assert.match(history, /&lt;script&gt;/);
  assert.doesNotMatch(history, /<script>/);
  assert.doesNotMatch(history, /secret-not-exported/);
  assert.match(files.find(file => file.name.includes('consentimiento-5')).body.toString(), /evidence/);
});

test('portable copy fails closed for foreign tenants and unlinked rows', () => {
  const foreign = snapshot();
  foreign.patients.tables.diagnoses[0].clinic_id = 'clinic-b';
  assert.throws(() => buildPortableDocuments(foreign, { clinicId: 'clinic-a' }), /fuera de la clínica/);
  const orphan = snapshot();
  orphan.patients.tables.diagnoses[0].consultation_id = 99;
  assert.throws(() => buildPortableDocuments(orphan, { clinicId: 'clinic-a' }), /relacionar/);
});

test('CSV is portable, protects spreadsheet formulas and retains signature images safely', () => {
  const data = snapshot();
  data.patients.tables.patients[0].first_name = '=HYPERLINK("https://example.invalid")';
  data.patients.tables.consent_forms[0].patient_sig_data = 'data:image/png;base64,YWJj';
  const files = buildPortableDocuments(data, { clinicId: 'clinic-a' });
  assert.match(files.find(file => file.name === 'datos/patients.csv').body.toString(), /'=HYPERLINK/);
  assert.match(files.find(file => file.name.includes('consentimiento-5')).body.toString(), /<img alt="Firma/);
  assert.doesNotMatch(files.map(file => file.body.toString()).join(''), /secret-not-exported/);
});

test('readable maps decode JSON coordinates and use clinical labels without external models', () => {
  const data = snapshot();
  data.patients.tables.physical_exams = [{
    id: 6, clinic_id: 'clinic-a', record_id: 2,
    face_map_data: JSON.stringify([{ category: 'Mácula', position3D: { x: 1, y: 2, z: 3 } }]),
  }];
  const html = buildPortableDocuments(data, { clinicId: 'clinic-a' })
    .find(file => file.name === 'historias/paciente-1.html').body.toString();
  assert.match(html, /Marcaciones faciales/);
  assert.match(html, /Coordenadas 3D/);
  assert.match(html, /Mácula/);
  assert.doesNotMatch(html, /\{"category"/);
  data.patients.tables.physical_exams[0].face_map_data = '{invalid';
  assert.throws(() => buildPortableDocuments(data, { clinicId: 'clinic-a' }), /no interpretables/);
});

test('text-only history with twenty synthetic consultations stays below 64 KiB', () => {
  const data = snapshot();
  data.patients.tables.consultations = Array.from({ length: 20 }, (_, i) => ({
    id: i + 3, clinic_id: 'clinic-a', record_id: 2, notes: 'Nota ficticia de consulta. '.repeat(50),
  }));
  const history = buildPortableDocuments(data, { clinicId: 'clinic-a' })
    .find(file => file.name === 'historias/paciente-1.html');
  assert.ok(history.body.length < 64 * 1024, `HTML demasiado grande: ${history.body.length} bytes`);
});

test('oversized documentation fails explicitly instead of returning partial files', () => {
  const data = snapshot();
  data.patients.tables.diagnoses[0].text = 'x'.repeat(4 * 1024 * 1024);
  assert.throws(() => buildPortableDocuments(data, { clinicId: 'clinic-a' }), /supera el límite/);
});

test('large snapshots split JSON, CSV and histories without losing any row', () => {
  const data = snapshot();
  data.patients.tables.consultations = Array.from({ length: 8 }, (_, i) => ({
    id: i + 3, clinic_id: 'clinic-a', record_id: 2, notes: 'x'.repeat(600 * 1024),
  }));
  const files = buildPortableDocuments(data, { clinicId: 'clinic-a' });
  const jsonFiles = files.filter(file => /^datos\/backup-parte-/.test(file.name));
  assert.ok(jsonFiles.length > 1);
  assert.equal(jsonFiles.reduce((count, file) => count +
    (JSON.parse(file.body).modules.patients.tables.consultations?.length || 0), 0), 8);
  assert.ok(files.filter(file => /^historias\/paciente-1-parte-/.test(file.name)).length > 1);
  assert.ok(files.filter(file => /^datos\/consultations-parte-/.test(file.name)).length > 1);
  assert.ok(files.every(file => file.body.length <= 4 * 1024 * 1024));
  assert.match(files.find(file => file.name === 'LEAME.html').body.toString(), /orden ascendente/);
});

test('nested signing secrets are excluded from every output', () => {
  const data = snapshot();
  data.patients.tables.consent_forms[0].signatures = {
    patient_sig_data: 'data:image/png;base64,YWJj', signing_session_hash: 'nested-secret',
  };
  const files = buildPortableDocuments(data, { clinicId: 'clinic-a' });
  assert.doesNotMatch(files.map(file => file.body.toString()).join(''), /nested-secret/);
});
