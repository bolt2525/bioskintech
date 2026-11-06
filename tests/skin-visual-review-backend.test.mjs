import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { savePhysicalExam, validateSkinVisualReview } from '../lib/modules/fichas-clinicas/physical-exam.js';
import { migrateSkinVisualAi } from '../scripts/migrate-skin-visual-ai.mjs';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ANALYSIS = 'cccccccc-dddd-4eee-8fff-111111111111';
const PHOTO_KEY = `clinics/${CLINIC}/records/7/photos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpeg`;
const TIME = '2026-11-05T20:00:00.000Z';
const legacy = [{ id: 'legacy', x: 0.1, y: 0.2, z: 0.3, lesion: 'scar' }];
const url = value => new URL(value, import.meta.url).href;
let state;
function reset() {
  state = {
    auth: { valid: true, role: 'clinic_user', id: 7, username: 'test-user', access_scope: 'own',
      clinic_id: CLINIC, effective_clinic_id: CLINIC, clinical_records_enabled: true,
      skin_visual_ai_enabled: false },
    record: { id: 7, clinic_id: CLINIC, patient_id: 3, created_by_user_id: 7 },
    exams: [], photos: [{ id: 10, record_id: 7, clinic_id: CLINIC, r2_key: PHOTO_KEY }],
    assigned: false, writes: 0, statements: [], reviewSchema: true, failWrite: false,
  };
}
reset();
const rows = list => ({ rows: list, rowCount: list.length });
const accessible = (recordId, clinicId, own, userId) => state.record.id === Number(recordId) &&
  state.record.clinic_id === clinicId && (!own || state.record.created_by_user_id === userId || state.assigned);
function dbValue(field, value) {
  return ['skin_visual_review', 'face_map_data', 'body_map_data'].includes(field) && typeof value === 'string'
    ? JSON.parse(value) : structuredClone(value);
}
async function query(statement, params = []) {
  const text = statement.replace(/\s+/g, ' ').trim();
  state.statements.push({ text, params });
  if (/^(SET |SELECT set_config)/.test(text)) return rows([]);
  if (text.startsWith('WITH authorized_record AS')) {
    const indices = new Set([...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    assert.equal(indices.size, params.length, 'all bind parameters must have an explicit SQL use/type');
    assert.ok([...indices].every(n => n >= 1 && n <= params.length));
    assert.match(text, /cr\.id = \$1 AND cr\.clinic_id = \$2/);
    assert.match(text, /cr\.created_by_user_id = \$4 OR EXISTS.*patient_assignments/);
    if (!accessible(...params.slice(0, 4))) return rows([]);
    if (!state.reviewSchema && text.includes('skin_visual_review'))
      throw Object.assign(new Error('fictitious missing review column'), { code: '42703' });
    const reviewIndex = text.match(/jsonb_array_elements\(\$(\d+)::jsonb/);
    if (reviewIndex) {
      assert.match(text, /cp\.record_id = \$1 AND cp\.clinic_id = \$2/);
      assert.match(text, /FOR KEY SHARE OF cp/);
      const review = JSON.parse(params[Number(reviewIndex[1]) - 1]);
      for (const mark of review.annotations) {
        if (!state.photos.some(p => p.id === mark.photo.id && p.r2_key === mark.photo.r2Key &&
          p.record_id === params[0] && p.clinic_id === params[1])) return rows([]);
      }
    } else {
      assert.ok(!text.includes('skin_visual_review'), 'legacy save must not reference unmigrated column');
      assert.ok(!text.includes('clinical_photos'), 'legacy save must not require photo schema');
    }
    if (state.failWrite) throw new Error('fictitious statement failure, nothing persisted');
    const noop = text.match(/SELECT pe.id FROM physical_exams pe WHERE pe.id = \$(\d+)/);
    if (noop) {
      const current = state.exams.find(e => e.id === params[Number(noop[1]) - 1] &&
        e.clinic_id === params[1] && e.record_id === params[0]);
      return rows(current ? [{ id: current.id }] : []);
    }
    const update = text.match(/UPDATE physical_exams pe SET (.+?) WHERE pe.id = \$(\d+)/);
    if (update) {
      const id = params[Number(update[2]) - 1];
      const current = state.exams.find(e => e.id === id && e.clinic_id === params[1] && e.record_id === params[0]);
      if (!current) return rows([]);
      const patch = {};
      for (const field of update[1].split(', ')) {
        const match = field.match(/^(\w+) = \$(\d+)(?:::jsonb)?$/);
        if (match) patch[match[1]] = dbValue(match[1], params[Number(match[2]) - 1]);
      }
      Object.assign(current, patch);
      state.writes++;
      return rows([{ id }]);
    }
    const insert = text.match(/INSERT INTO physical_exams \(([^)]+)\) SELECT (.+?) FROM authorized_record/);
    assert.ok(insert, text);
    const fields = insert[1].split(', '), values = insert[2].split(', ');
    const next = { id: 55, created_at: TIME };
    for (let i = 0; i < fields.length; i++) {
      const index = Number(values[i].match(/^\$(\d+)/)[1]) - 1;
      next[fields[i]] = dbValue(fields[i], params[index]);
    }
    state.exams.push(next);
    state.writes++;
    return rows([{ id: next.id }]);
  }
  if (/^SELECT record_id(?:, created_at)? FROM physical_exams/.test(text)) {
    const current = state.exams.find(e => e.id === Number(params[0]) &&
      e.clinic_id === (params[1] ?? CLINIC));
    return rows(current ? [{ record_id: current.record_id, created_at: current.created_at }] : []);
  }
  if (text.startsWith('SELECT 1 FROM clinical_records cr'))
    return rows(accessible(...params.slice(0, 4)) ? [{ ok: 1 }] : []);
  if (text.startsWith('SELECT cr.*, to_jsonb(p) AS patient')) return rows(
    state.record.id === Number(params[0]) && state.record.clinic_id === CLINIC ? [{
      ...state.record, patient: { id: 3, clinic_id: CLINIC, first_name: 'Synthetic' },
    }] : []);
  if (text.startsWith('SELECT * FROM physical_exams'))
    return rows(structuredClone(state.exams.filter(e => e.record_id === Number(params[0]) && e.clinic_id === CLINIC)));
  if (/^SELECT \* FROM (medical_history|diagnoses|treatments|prescriptions|injectables|consultation_info|consultations)\b/.test(text))
    return rows([]);
  if (text.includes('FROM consent_forms WHERE record_id')) return rows([]);
  if (text.startsWith('SELECT p.clinic_id FROM physical_exams')) {
    const exam = state.exams.find(e => e.id === Number(params[0]) && e.clinic_id === CLINIC);
    return rows(exam ? [{ clinic_id: CLINIC }] : []);
  }
  if (text.startsWith('DELETE FROM physical_exams')) {
    state.exams = state.exams.filter(e => e.id !== Number(params[0]));
    return rows([]);
  }
  throw new Error(`Unexpected mock SQL: ${text}`);
}
mock.module('@vercel/postgres', { namedExports: { sql: async () => assert.fail('No auth DB queries expected') } });
mock.module(url('../lib/admin-auth.js'), { namedExports: { authenticateRequest: async () => state.auth } });
mock.module(url('../lib/neon-clinical-db.js'), { namedExports: {
  initClinicalDatabase: async () => {}, // Never run automatic DDL in tests.
  getAppPool: () => ({ connect: async () => ({ query, release() {} }) }),
  getPool: () => ({ query: async () => assert.fail('No owner clinical queries') }),
} });
mock.module(url('../lib/clinic-lifecycle.js'), { namedExports: {
  lockClinicWriters: async () => {}, unlockClinicWriters: async () => {},
  requireClinicWritable: async () => {},
} });
mock.module(url('../lib/r2-service.js'), { namedExports: Object.fromEntries(
  ['generateUploadUrl', 'generateReadUrl', 'deleteR2Object', 'putR2Object']
    .map(name => [name, async () => assert.fail('Remote storage forbidden')]),
) });
const net = mock.method(globalThis, 'fetch', async () => assert.fail('HTTP forbidden'));
mock.method(console, 'log', () => {});
const { default: records, isOwnedPhotoKey } = await import('../api/records.js');
const review = () => ({
  version: 1, annotations: [{
    id: `skin-photo:${ANALYSIS}:p1`, category: 'acne', label: 'Región revisada', note: 'Revisión humana.',
    coordinateSpace: 'clinical-photo-2d', reviewVersion: 1, reviewStatus: 'validated', reviewedAt: TIME,
    normalizedBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, photo: { id: 10, r2Key: PHOTO_KEY },
    source: {
      provider: 'google-gemini', analysisId: ANALYSIS, requestId: ANALYSIS, model: 'gemini-3.5-flash-lite',
      analyzedAt: TIME, consentedAt: TIME, imageWidth: 1280, imageHeight: 960, context: { skinType: 'Mixta' },
      summary: 'Propuesta incierta para revisión.', limitations: ['No diagnóstico.'],
      proposal: { id: 'p1', category: 'acne', label: 'Propuesta visual', note: 'Incierta.',
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
    },
  }],
});
const body = () => ({
  record_id: 7, skin_type: 'Mixta', phototype: 'III', hydration: 'Normal',
  face_map_data: JSON.stringify(legacy), body_map_data: '[]', skin_visual_review: review(),
});
async function call(action, payload = {}, queryParams = {}) {
  const res = {
    code: 0, body: null, setHeader() {},
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await records({ method: 'POST', headers: { authorization: 'Bearer fictitious-session' },
    query: { action, ...queryParams }, body: payload }, res);
  return res;
}
const direct = payload => savePhysicalExam({ query }, {
  body: payload, clinicId: CLINIC, sessionUser: {
    role: state.auth.role, access_scope: state.auth.access_scope, user_id: state.auth.id,
  }, isOwnedPhotoKey,
});

test('real save/getRecordData roundtrip preserves reviewed JSON and legacy maps, even when AI disabled', async () => {
  reset();
  const original = body();
  const saved = await call('savePhysicalExam', original);
  assert.equal(saved.code, 200);
  assert.equal(saved.body.success, true);
  assert.equal(state.writes, 1, 'exam + review must be one atomic write');
  const reopened = await call('getRecordData', {}, { recordId: '7' });
  assert.equal(reopened.code, 200, JSON.stringify(reopened.body));
  assert.deepEqual(reopened.body.physicalExams[0].skin_visual_review, original.skin_visual_review);
  assert.deepEqual(reopened.body.physicalExams[0].face_map_data, legacy);
  assert.deepEqual(reopened.body.physicalExams[0].body_map_data, []);
  assert.equal(state.auth.skin_visual_ai_enabled, false);
  const revised = review();
  revised.annotations[0].note = 'Edición humana posterior.';
  assert.equal((await call('savePhysicalExam', { id: saved.body.id, record_id: 7,
    skin_visual_review: JSON.stringify(revised), hydration: 'Baja' })).code, 200);
  const again = await call('getRecordData', {}, { recordId: '7' });
  assert.deepEqual(again.body.physicalExams[0].skin_visual_review, revised);
  assert.deepEqual(again.body.physicalExams[0].face_map_data, legacy);
  assert.equal(again.body.physicalExams[0].hydration, 'Baja');
  assert.equal(net.mock.callCount(), 0);
});

test('legacy update omitting review preserves it; explicit version 1 empty list clears intentionally', async () => {
  reset();
  const id = await direct(body());
  const retained = structuredClone(state.exams[0].skin_visual_review);
  await direct({ id, hydration: 'Baja' });
  assert.deepEqual(state.exams[0].skin_visual_review, retained);
  assert.deepEqual(state.exams[0].face_map_data, legacy);
  await direct({ id, skin_visual_review: { version: 1, annotations: [] } });
  assert.deepEqual(state.exams[0].skin_visual_review, { version: 1, annotations: [] });
  assert.deepEqual(state.exams[0].face_map_data, legacy);
});

test('HIGH mass-assignment regression: uppercase review/record keys and protected/unknown keys => 400, intact exam, ZERO writes', async () => {
  reset();
  const id = await direct(body());
  const before = structuredClone(state.exams);
  const writes = state.writes;
  for (const patch of [
    { SKIN_VISUAL_REVIEW: { version: 999, annotations: [{ reviewStatus: 'pending' }] } },
    { skin_visual_review: { version: 1, annotations: [] }, SKIN_VISUAL_REVIEW: { arbitrary: true } },
    { RECORD_ID: 8 }, { Record_Id: 8 }, { ID: 999 }, { CLINIC_ID: OTHER },
    { CREATED_AT: '1900-01-01T00:00:00.000Z' }, { Skin_Type: 'overwrite' },
    { created_by_user_id: 999 }, { updated_at: TIME }, { unknown_column: 'value' },
    { 'skin_visual_review ': {} }, { 'skin_visual_review"': {} },
  ]) {
    const start = state.statements.length;
    await assert.rejects(direct({ id, ...patch }), { status: 400 });
    assert.equal(state.statements.length, start, 'module rejects names before any query');
    const response = await call('savePhysicalExam', { id, hydration: 'Must not change', ...patch });
    assert.equal(response.code, 400, JSON.stringify(patch));
    assert.equal(state.writes, writes);
    assert.deepEqual(state.exams, before);
    assert.ok(!state.statements.slice(start).some(s => s.text.startsWith('WITH authorized_record')),
      'no attempted SQL write, not just no affected row');
  }
});

test('real reload/edit payload keeps read-only metadata and legacy fields but never places protected columns in SET', async () => {
  reset();
  const created = await call('savePhysicalExam', body());
  assert.equal(created.code, 200);
  const reloaded = await call('getRecordData', {}, { recordId: '7' });
  const payload = { ...reloaded.body.physicalExams[0], hydration: 'Baja' };
  assert.ok(payload.id && payload.record_id && payload.clinic_id && payload.created_at);
  const start = state.statements.length;
  assert.equal((await call('savePhysicalExam', payload)).code, 200);
  assert.equal(state.exams[0].hydration, 'Baja');
  for (const field of ['id', 'record_id', 'clinic_id', 'created_at'])
    assert.deepEqual(state.exams[0][field], payload[field]);
  assert.deepEqual(state.exams[0].skin_visual_review, payload.skin_visual_review);
  assert.deepEqual(state.exams[0].face_map_data, legacy);
  const write = state.statements.slice(start).find(s => s.text.startsWith('WITH authorized_record'));
  const setters = write.text.match(/UPDATE physical_exams pe SET (.+?) WHERE pe.id/)[1];
  assert.doesNotMatch(setters, /\b(id|record_id|clinic_id|created_at|created_by_user_id|updated_at)\s*=/);
  assert.match(setters, /skin_visual_review = \$\d+::jsonb/);
  assert.equal((await call('savePhysicalExam', { ...payload, created_at: '1900-01-01T00:00:00.000Z' })).code, 400);
  assert.equal((await call('savePhysicalExam', { ...payload, clinic_id: OTHER })).code, 400);
  const writes = state.writes;
  const beforeNoop = state.statements.length;
  assert.equal((await call('savePhysicalExam', {
    id: payload.id, record_id: payload.record_id, clinic_id: payload.clinic_id, created_at: payload.created_at,
  })).code, 200);
  assert.equal(state.writes, writes, 'metadata-only saves must not update even protected id to itself');
  assert.ok(!state.statements.slice(beforeNoop).some(s => /\b(UPDATE|INSERT|DELETE)\b/.test(s.text)));
});

test('unmigrated legacy schema saves with review omitted, with no dependency on new column/photo table', async () => {
  reset();
  state.reviewSchema = false;
  const payload = body();
  delete payload.skin_visual_review;
  const saved = await call('savePhysicalExam', payload);
  assert.equal(saved.code, 200);
  assert.equal((await call('savePhysicalExam', { id: saved.body.id, hydration: 'Alta' })).code, 200);
  assert.equal(state.exams[0].hydration, 'Alta');
  assert.ok(!Object.hasOwn(state.exams[0], 'skin_visual_review'));
  assert.deepEqual(state.exams[0].face_map_data, legacy);
  const before = structuredClone(state.exams);
  assert.equal((await call('savePhysicalExam', { id: saved.body.id, hydration: 'No guardar',
    skin_visual_review: review() })).code, 500);
  assert.deepEqual(state.exams, before, 'failed combined write must not partially update legacy fields');
});

test('photo ID + raw R2 key must bind the same clinical record and clinic in the atomic statement', async () => {
  for (const change of [
    () => { state.photos = []; },
    () => { state.photos[0].record_id = 8; },
    () => { state.photos[0].clinic_id = OTHER; },
    () => { state.photos[0].r2_key = PHOTO_KEY.replace('aaaaaaaa', 'bbbbbbbb'); },
  ]) {
    reset(); change();
    assert.equal((await call('savePhysicalExam', body())).code, 403);
    assert.equal(state.writes, 0);
  }
  for (const key of [
    `clinics/${OTHER}/records/7/photos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpeg`,
    PHOTO_KEY.replace('/records/7/', '/records/8/'),
    `https://example.test/${PHOTO_KEY}?X-Amz-Signature=fictitious`, `blob:https://example.test/id`,
    'data:image/png;base64,AAAA', `${PHOTO_KEY}?X-Amz-Signature=fictitious`,
  ]) {
    reset();
    const payload = body(); payload.skin_visual_review.annotations[0].photo.r2Key = key;
    assert.equal((await call('savePhysicalExam', payload)).code, 403);
    assert.equal(state.writes, 0);
  }
});

test('tenant/own/assigned and update-record binding remain enforced by real API/helper', async () => {
  reset(); state.record.clinic_id = OTHER;
  assert.equal((await call('savePhysicalExam', body())).code, 403);
  reset(); state.record.created_by_user_id = 8;
  assert.equal((await call('savePhysicalExam', body())).code, 403);
  state.assigned = true;
  assert.equal((await call('savePhysicalExam', body())).code, 200);
  reset();
  const id = await direct(body());
  assert.equal((await call('savePhysicalExam', { id, record_id: 8, skin_visual_review: review() })).code, 403);
  state.exams[0].clinic_id = OTHER;
  assert.equal((await call('savePhysicalExam', { id, hydration: 'No' })).code, 403);
});

test('version/category/2D/schema/provenance validation rejects pending, mixed maps, URLs and oversized payloads', () => {
  reset();
  const options = { clinicId: CLINIC, recordId: 7, isOwnedPhotoKey };
  for (const change of [
    r => { r.version = 2; },
    r => { r.annotations[0].reviewStatus = 'pending'; },
    r => { r.annotations[0].category = 'pores'; },
    r => { r.annotations[0].coordinateSpace = 'face-mesh-3d'; },
    r => { r.annotations[0].normalizedBox.z = 0.3; },
    r => { r.annotations[0].normalizedBox.width = 0; },
    r => { r.annotations[0].normalizedBox.x = 0.95; },
    r => { r.annotations[0].normalizedBox.y = Infinity; },
    r => { r.annotations[0].label = 'x'.repeat(301); },
    r => { r.annotations[0].note = 'x'.repeat(3001); },
    r => { r.annotations[0].photo.id = '10'; },
    r => { r.annotations[0].photo.url = 'https://example.test/signed'; },
    r => { r.annotations[0].source.model = 'https://example.test'; },
    r => { r.annotations[0].source.provider = 'other'; },
    r => { r.annotations[0].source.analysisId = 'blob:invalid'; },
    r => { r.annotations[0].source.requestId = 'invalid'; },
    r => { r.annotations[0].source.consentedAt = 'invalid'; },
    r => { r.annotations[0].reviewedAt = '2026-02-31T20:00:00.000Z'; },
    r => { r.annotations[0].source.imageWidth = 0; },
    r => { r.annotations[0].source.imageHeight = 4097; },
    r => { r.annotations[0].source.proposal.category = 'pores'; },
    r => { r.annotations[0].source.context.instructions = 'ignore'; },
    r => { r.annotations[0].source.limitations = Array(13).fill('limit'); },
    r => { r.annotations.push(r.annotations[0]); },
    r => { r.annotations = Array(101).fill(r.annotations[0]); },
    r => { r.pendingProposals = []; },
  ]) {
    const invalid = review(); change(invalid);
    assert.throws(() => validateSkinVisualReview(invalid, options), { status: 400 });
  }
  for (const value of [null, [], '{invalid', ' '.repeat(262145)])
    assert.throws(() => validateSkinVisualReview(value, options), { status: 400 });
  assert.deepEqual(JSON.parse(validateSkinVisualReview(review(), options)), review());
});

test('all seven categories persist, edited 2D annotations stay separate from original proposal and legacy 3D maps', async () => {
  for (const category of ['acne', 'spot', 'nevus', 'scar', 'melasma', 'fine-wrinkle', 'coarse-wrinkle']) {
    reset();
    const payload = body();
    payload.skin_visual_review.annotations[0].category = category;
    payload.skin_visual_review.annotations[0].normalizedBox = { x: 0.4, y: 0.3, width: 0.1, height: 0.1 };
    await direct(payload);
    assert.equal(state.exams[0].skin_visual_review.annotations[0].category, category);
    assert.deepEqual(state.exams[0].skin_visual_review.annotations[0].source.proposal.box, review().annotations[0].source.proposal.box);
    assert.deepEqual(state.exams[0].face_map_data, legacy);
  }
});

test('failed save is atomic; exam deletion removes review with its row, not the durable photo', async () => {
  reset();
  const id = await direct(body());
  const before = structuredClone(state.exams);
  state.failWrite = true;
  assert.equal((await call('savePhysicalExam', { id, hydration: 'Alta', skin_visual_review: { version: 1, annotations: [] } })).code, 500);
  assert.deepEqual(state.exams, before);
  state.failWrite = false;
  assert.equal((await call('deletePhysicalExam', {}, { id: String(id) })).code, 200);
  assert.equal(state.exams.length, 0);
  assert.equal(state.photos.length, 1);
});

test('initializer and standalone migration add JSONB idempotently; list/history/print consume complete reviews', () => {
  const schema = readFileSync(new URL('../lib/neon-clinical-db.js', import.meta.url), 'utf8');
  assert.match(schema, /skin_visual_review\s+JSONB/);
  assert.match(schema, /ALTER TABLE physical_exams\s+ADD COLUMN IF NOT EXISTS skin_visual_review JSONB/);
  const migration = readFileSync(new URL('../scripts/skin-visual-review-schema.sql', import.meta.url), 'utf8');
  assert.match(migration, /BEGIN;[\s\S]+ADD COLUMN IF NOT EXISTS skin_visual_review JSONB;[\s\S]+COMMIT;/);
  const tab = readFileSync(new URL('../src/components/admin/ficha-clinica/components/tabs/PhysicalExamTab.tsx', import.meta.url), 'utf8');
  const print = readFileSync(new URL('../src/components/admin/ficha-clinica/components/PrintModal.tsx', import.meta.url), 'utf8');
  assert.match(tab, /parseSkinReview\(exam\.skin_visual_review\)/);
  assert.match(tab, /parseSkinReview\(e\.skin_visual_review\)/);
  assert.match(print, /parseSkinReview\(ex\.skin_visual_review\)/);
});

test('runner: direct/pooler logical Neon aliases accepted, owner canonical wins, ONE client + transaction for BOTH DDL', async () => {
  const events = [];
  const connectionStrings = [];
  let number = 0;
  class Client {
    constructor(options) { this.id = ++number; connectionStrings.push(options.connectionString); }
    async connect() { events.push([this.id, 'connect']); }
    async query(statement) {
      events.push([this.id, statement]);
    }
    async end() { events.push([this.id, 'end']); }
  }
  const auth = 'postgresql://test_auth:stub@ep-bioskin-123-pooler.us-east-2.aws.neon.tech/bioskin?sslmode=require';
  const owner = 'postgres://test_owner:other@ep-bioskin-123.us-east-2.aws.neon.tech/%62ioskin?sslmode=verify-full&channel_binding=require';
  const env = { POSTGRES_URL: auth, NEON_DATABASE_URL: owner };
  await migrateSkinVisualAi({ env, Client });
  assert.equal(number, 1);
  assert.deepEqual(connectionStrings, [owner], 'credentials/TLS differ but canonical owner URL is used');
  assert.equal(events.filter(([, text]) => text === 'BEGIN').length, 1);
  assert.equal(events.filter(([, text]) => text === 'COMMIT').length, 1);
  assert.ok(events.some(([, text]) => text.includes('CREATE TABLE IF NOT EXISTS skin_visual_ai_usage')));
  assert.ok(events.some(([, text]) => text.includes('ADD COLUMN IF NOT EXISTS skin_visual_review')));
  // Repeat is deliberate: all schema statements remain idempotent.
  await migrateSkinVisualAi({ env, Client });
  await migrateSkinVisualAi({ env: { POSTGRES_URL: auth }, Client });
  await migrateSkinVisualAi({ env: { NEON_DATABASE_URL: owner }, Client });
  assert.deepEqual(connectionStrings, [owner, owner, auth, owner]);
  assert.equal(number, 4);
  assert.equal(net.mock.callCount(), 0);
});

test('runner rejects different endpoint/DB and ambiguous or overridden targets BEFORE constructing clients or queries', async () => {
  let clients = 0;
  class Client { constructor() { clients++; assert.fail('Must reject before a client exists'); } }
  const canonical = 'postgresql://owner:stub@ep-bioskin-123.us-east-2.aws.neon.tech/bioskin?sslmode=require';
  for (const alternative of [
    canonical.replace('bioskin-123', 'bioskin-999'),
    canonical.replace('/bioskin?', '/other_database?'),
    canonical.replace('us-east-2', 'us-west-2'),
    canonical.replace('/bioskin?', '/Bioskin?'),
    canonical.replace('aws.neon.tech', 'aws.neon.tech.attacker.invalid'),
    canonical.replace('/bioskin?', '/?'),
    canonical.replace('postgresql:', 'https:'),
    `${canonical}&host=ep-other-123.us-east-2.aws.neon.tech`,
    `${canonical}&database=other`,
    `${canonical}&dbname=other`,
    `${canonical}&port=9999`,
    'postgresql://localhost/bioskin',
    'invalid', '',
  ]) {
    await assert.rejects(migrateSkinVisualAi({
      env: { NEON_DATABASE_URL: canonical, POSTGRES_URL: alternative }, Client,
    }), error => /misma base Neon|inválida o ambigua/.test(error.message) &&
      !error.message.includes(canonical) && !error.message.includes('owner:stub'));
  }
  await assert.rejects(migrateSkinVisualAi({ env: {}, Client }), /Falta NEON_DATABASE_URL o POSTGRES_URL/);
  assert.equal(clients, 0);
});

test('runner failure in either DDL rolls back BOTH on the same connection, with no secret-bearing DB error', async () => {
  for (const failingFile of ['CREATE TABLE IF NOT EXISTS skin_visual_ai_usage', 'ADD COLUMN IF NOT EXISTS skin_visual_review']) {
    const events = [], committed = [], pending = [];
    let clients = 0;
    class Client {
      constructor() { clients++; }
      async connect() { events.push('connect'); }
      async query(statement) {
        events.push(statement);
        if (statement.includes(failingFile)) throw new Error('postgres://DO-NOT-EXPOSE.invalid/auth password');
        if (statement === 'ROLLBACK') pending.length = 0;
        else if (statement === 'COMMIT') { committed.push(...pending); pending.length = 0; }
        else if (statement !== 'BEGIN') pending.push(statement);
      }
      async end() { events.push('end'); }
    }
    await assert.rejects(migrateSkinVisualAi({
      env: { NEON_DATABASE_URL: 'postgresql://ep-bioskin-123.us-east-2.aws.neon.tech/bioskin' }, Client,
    }), error => /Falló la migración única de auth y clínica/.test(error.message) &&
      !error.message.includes('postgres://') && !error.message.includes('password'));
    assert.equal(clients, 1);
    assert.equal(events.filter(text => text === 'BEGIN').length, 1);
    assert.equal(events.filter(text => text === 'ROLLBACK').length, 1);
    assert.ok(!events.includes('COMMIT'));
    assert.deepEqual(committed, []);
    assert.deepEqual(pending, []);
  }
  assert.equal(net.mock.callCount(), 0);
});
