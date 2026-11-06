import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import {
  getFacialSimulation, listFacialSimulations, saveFacialSimulation, saveSimulationExam,
  validateFacialSimulationState, MAX_SIMULATION_BYTES,
} from '../lib/modules/fichas-clinicas/facial-simulation.js';
import { validateSkinVisualReview } from '../lib/modules/fichas-clinicas/physical-exam.js';
import { LESION_CATEGORIES, AI_LESION_LABELS } from '../lib/modules/ia/skin-lesion-catalog.js';
import { LESION_CATALOG } from '../src/data/clinical-catalogs.ts';

mock.method(globalThis, 'fetch', () => assert.fail('Real network forbidden'));
const CLINIC = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TIME = '2026-11-05T20:00:00.000Z';
const key = (record = 7, photo = 10) => `clinics/${CLINIC}/records/${record}/photos/${photo}.jpeg`;
const photo = (record = 7, id = 10) => ({ id, r2Key: key(record, id) });
const box = () => ({ x: 0.1, y: 0.1, width: 0.2, height: 0.3 });
const ownKey = (key, clinic, record) => typeof key === 'string' &&
  key.startsWith(`clinics/${clinic}/records/${record}/photos/`);
function review() {
  return { version: 2, annotations: [{
    id: 'lesion:stable-identity', category: 'telangiectasias', label: 'Etiqueta clínica libre',
    note: 'Observación multivista', coordinateSpace: 'clinical-photo-2d', reviewVersion: 2,
    photo: photo(), normalizedBox: box(), reviewStatus: 'validated', reviewedAt: TIME,
    source: { provider: 'manual' }, anchor: { version: 1, triangle: 4, weights: [0.2, 0.3, 0.5] },
    observations: [{ photo: photo(7, 11), normalizedBox: box() }],
    crop: { originalPhoto: photo(), normalizedBox: box(), sourceWidth: 4000, sourceHeight: 3000 },
  }] };
}
function session() {
  return { version: 1, atlas: { modelId: 'face-v1', version: 1 },
    photos: [{ slot: 'front', photo: photo(), alignment: { confirmed: true, landmarks: [[0.1, 0.2, 0.3]] } }],
    marks: [],
  };
}
const common = () => ({ clinicId: CLINIC, sessionUser: { user_id: 7, access_scope: 'own', role: 'clinic_user',
  facial_simulation_enabled: true, clinical_records_enabled: true },
  isOwnedPhotoKey: ownKey });
const save = state => ({ ...common(), body: { record_id: 7, requestId: randomUUID(), state } });
const exam = () => ({ ...common(), body: { record_id: 7, requestId: randomUUID(), reason: 'Control de piel',
  exam: { skin_type: 'No determinado', phototype: 'No determinado', skin_visual_review: review() } } });

// SQL protocol double exercises actual service/validator/physical-exam SQL, no DB,
// environment loading, live AI, R2 client, buckets or billing are permitted.
function fixture() {
  const s = { receipts: [], sessions: [], consultations: [], exams: [], queries: [], objects: new Map(),
    photos: [photo(), photo(7, 11)], allowed: true, failExam: false, failReceipt: false, puts: 0 };
  let before;
  const rows = rows => ({ rows });
  const db = { async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    s.queries.push({ text, params });
    if (text === 'BEGIN') {
      before = structuredClone({ receipts: s.receipts, sessions: s.sessions, consultations: s.consultations, exams: s.exams });
      return rows([]);
    }
    if (text === 'ROLLBACK') { Object.assign(s, before); return rows([]); }
    if (text === 'COMMIT' || text.startsWith('SET LOCAL') || text.includes('pg_advisory_xact_lock')) return rows([]);
    if (text.startsWith('SELECT cr.id FROM clinical_records')) {
      assert.match(text, /cr\.clinic_id = \$2/);
      assert.match(text, /cr\.created_by_user_id = \$4 OR EXISTS.*patient_assignments/);
      return rows(s.allowed && params[1] === CLINIC ? [{ id: params[0] }] : []);
    }
    if (text.startsWith('SELECT record_id, operation')) return rows(s.receipts.filter(r => r.clinic === params[0] && r.request === params[1]));
    if (text.startsWith('SELECT cp.id, cp.r2_key')) {
      assert.match(text, /cp\.record_id = \$1 AND cp\.clinic_id = \$2 FOR KEY SHARE/);
      return rows(JSON.parse(params[2]).filter(p => s.photos.some(owned => owned.id === p.id && owned.r2Key === p.r2Key))
        .map(p => ({ id: p.id, r2_key: p.r2Key })));
    }
    if (text.startsWith('INSERT INTO facial_simulations')) {
      const [request_id, clinic_id, record_id, r2_key, state_sha256, state_bytes, photos, , scope] = params;
      const id = s.sessions.length + 1;
      const row = { id, request_id, clinic_id, record_id, r2_key, state_sha256, state_bytes, photos: JSON.parse(photos),
        created_at: TIME, state_version: 1, scope };
      s.sessions.push(row);
      return rows([{ id, record_id, created_at: TIME, state_version: 1, scope }]);
    }
    if (text.startsWith('INSERT INTO clinical_simulation_requests')) {
      if (s.failReceipt) throw new Error('receipt unavailable');
      const [clinic, request, record_id, operation, fingerprint, result] = params;
      s.receipts.push({ clinic, request, record_id, operation, fingerprint, result: JSON.parse(result) });
      return rows([]);
    }
    if (text.startsWith('SELECT id, record_id, state_version, created_at, request_id'))
      return rows(s.sessions.filter(row => row.id === params[0] && row.record_id === params[1] &&
        row.clinic_id === params[2] && row.scope === params[3]));
    if (text.startsWith('SELECT id, record_id, state_version, created_at, photo_refs'))
      return rows(s.sessions.filter(row => row.record_id === params[0] && row.clinic_id === params[1] && row.scope === params[4])
        .slice(0, params[3]).map(({ id, record_id, state_version, created_at, photos }) =>
          ({ id, record_id, state_version, created_at, photos })));
    if (text.startsWith('INSERT INTO consultations')) {
      const id = s.consultations.length + 1;
      s.consultations.push({ id, record_id: params[0], reason: params[2] });
      return rows([{ id }]);
    }
    if (text.startsWith('WITH authorized_record AS')) {
      assert.match(text, /cr\.clinic_id = \$2/);
      assert.match(text, /FOR KEY SHARE OF cp/);
      assert.match(text, /ann->'crop'->'originalPhoto'/);
      assert.match(text, /jsonb_array_elements\(COALESCE\(ann->'observations'/);
      if (s.failExam) throw new Error('exam failed');
      const index = Number(text.match(/jsonb_array_elements\(\$(\d+)::jsonb/)[1]) - 1;
      const review = JSON.parse(params[index]);
      const photos = review.annotations.flatMap(mark => [mark.photo,
        ...(mark.observations || []).map(o => o.photo), ...(mark.crop ? [mark.crop.originalPhoto] : [])]);
      if (!s.allowed || photos.some(p => !s.photos.some(owned => owned.id === p.id && owned.r2Key === p.r2Key))) return rows([]);
      const id = s.exams.length + 100;
      s.exams.push({ id, review, record_id: params[0] });
      return rows([{ id }]);
    }
    throw new Error(`Unexpected SQL ${text}`);
  } };
  const storage = {
    async putR2Object(key, buffer, type) {
      assert.equal(type, 'application/json');
      assert.match(key, /\/facial-simulations\/.+\.json$/);
      s.puts++; s.objects.set(key, Buffer.from(buffer));
    },
    async getR2ObjectBuffer(key, max) {
      assert.equal(max, MAX_SIMULATION_BYTES);
      return s.objects.get(key);
    },
  };
  return { s, db, storage };
}

test('canonical catalog covers real clinical labels and seven legacy keys; pores/dysplasia never AI', () => {
  const source = readFileSync(new URL('../src/data/clinical-catalogs.ts', import.meta.url), 'utf8');
  assert.match(source, /import lesionCatalog from '\.\/skin-lesion-catalog\.json'/);
  assert.match(source, /LESION_CATALOG = Object\.values\(lesionCatalog\)\.sort\(\)/);
  assert.deepEqual(LESION_CATALOG, Object.values(LESION_CATEGORIES).sort());
  for (const key of ['acne', 'spot', 'nevus', 'scar', 'melasma', 'fine-wrinkle', 'coarse-wrinkle'])
    assert.ok(LESION_CATEGORIES[key] && AI_LESION_LABELS[key]);
  assert.ok(LESION_CATEGORIES['no-evaluable'] && LESION_CATEGORIES['no-concluyente']);
  assert.equal(AI_LESION_LABELS['poros-dilatados'], undefined);
  assert.equal(AI_LESION_LABELS['nevo-displasico'], undefined);
});

test('crop persists original dimensions; partial, oversized or other-photo evidence fails closed', () => {
  const context = { clinicId: CLINIC, recordId: 7, isOwnedPhotoKey: ownKey };
  assert.deepEqual(JSON.parse(validateSkinVisualReview(review(), context)).annotations[0].crop, review().annotations[0].crop);
  for (const patch of [{ sourceWidth: 0 }, { sourceHeight: undefined }, { sourceWidth: 50000, sourceHeight: 50000 },
    { originalPhoto: photo(7, 11) }]) {
    const changed = review();
    Object.assign(changed.annotations[0].crop, patch);
    assert.throws(() => validateSkinVisualReview(changed, context));
  }
  const compatible = review();
  delete compatible.annotations[0].crop.sourceWidth; delete compatible.annotations[0].crop.sourceHeight;
  assert.doesNotThrow(() => validateSkinVisualReview(compatible, context));
});

test('v2 manual/free labels, stable lesion identity, barycentric address, crop and multiview validation', () => {
  assert.deepEqual(JSON.parse(validateSkinVisualReview(review(), { ...common(), recordId: 7 })), review());
  for (const mutate of [
    r => { r.annotations[0].anchor.weights = [1, 1, 1]; },
    r => { r.annotations[0].observations[0].photo.r2Key = key(8, 11); },
    r => { r.annotations[0].crop.originalPhoto.r2Key = key(8); },
    r => { r.annotations[0].source.extra = true; },
    r => { r.annotations[0].observations[0].normalizedBox.width = 3; },
    r => { r.annotations[0].reviewStatus = 'pending'; },
  ]) {
    const r = review(); mutate(r);
    assert.throws(() => validateSkinVisualReview(r, { ...common(), recordId: 7 }));
  }
  const manual = review(); manual.annotations[0].category = 'other';
  manual.annotations[0].label = 'Descripción libre no incluida en catálogo';
  assert.ok(validateSkinVisualReview(manual, { ...common(), recordId: 7 }));
});

test('private R2 state save/reload/list, same request is idempotent, new request is a new revision', async () => {
  const f = fixture(), options = save(session());
  const saved = await saveFacialSimulation(f.db, options, f.storage);
  assert.equal(saved.id, 1);
  assert.deepEqual(await saveFacialSimulation(f.db, options, f.storage), saved);
  assert.equal(f.s.puts, 1); assert.equal(f.s.sessions.length, 1);
  const loaded = await getFacialSimulation(f.db, { ...common(), query: { record_id: '7', id: saved.id } }, f.storage);
  assert.deepEqual(loaded.state, options.body.state);
  const list = await listFacialSimulations(f.db, { ...common(), query: { record_id: 7 } });
  assert.equal(list.simulations.length, 1);
  assert.ok(!JSON.stringify(list).includes('r2_key'));
  await saveFacialSimulation(f.db, save(session()), f.storage);
  assert.equal(f.s.sessions.length, 2);
  assert.ok(f.s.sessions.every(row => !Object.hasOwn(row, 'state')));
});

test('cross-record/idempotency conflicts and changed payload fail, own-scope/photo mismatch fail before R2', async () => {
  const f = fixture(), options = save(session());
  await saveFacialSimulation(f.db, options, f.storage);
  const changed = { ...options, body: structuredClone(options.body) }; changed.body.state.photos[0].alignment.confirmed = false;
  await assert.rejects(saveFacialSimulation(f.db, changed, f.storage), e => e.status === 409);
  const cross = { ...options, body: structuredClone(options.body) };
  cross.body.record_id = 8; cross.body.state.photos[0].photo = photo(8);
  await assert.rejects(saveFacialSimulation(f.db, cross, f.storage), e => e.status === 409);
  f.s.allowed = false;
  await assert.rejects(saveFacialSimulation(f.db, options, f.storage), e => e.status === 403);
  await assert.rejects(getFacialSimulation(f.db, { ...common(), query: { record_id: 7, id: 1 } }, f.storage),
    e => e.status === 403);
  f.s.allowed = true; f.s.photos = [];
  await assert.rejects(saveFacialSimulation(f.db, save(session()), f.storage), e => e.status === 403);
  assert.equal(f.s.puts, 1);
});

test('module defaults denied; physical-exam scope remains available, isolated and requires clinical_records', async () => {
  const f = fixture(), options = save(session());
  delete options.sessionUser.facial_simulation_enabled;
  await assert.rejects(saveFacialSimulation(f.db, options, f.storage), e => e.status === 403);
  const newExam = exam(); delete newExam.sessionUser.facial_simulation_enabled;
  await assert.rejects(saveSimulationExam(f.db, newExam), e => e.status === 403);
  assert.equal(f.s.puts, 0);
  options.body.scope = 'physical-exam';
  const saved = await saveFacialSimulation(f.db, options, f.storage);
  assert.equal(saved.scope, 'physical-exam');
  const request = { ...common(), query: { record_id: 7, id: saved.id, scope: 'physical-exam' } };
  delete request.sessionUser.facial_simulation_enabled;
  assert.equal((await getFacialSimulation(f.db, request, f.storage)).id, saved.id);
  request.sessionUser.clinical_records_enabled = false;
  await assert.rejects(getFacialSimulation(f.db, request, f.storage), e => e.status === 403);
  const wrongScope = { ...common(), query: { record_id: 7, id: saved.id } };
  await assert.rejects(getFacialSimulation(f.db, wrongScope, f.storage), e => e.status === 404);
  assert.equal((await listFacialSimulations(f.db, { ...common(), query: { record_id: 7 } })).simulations.length, 0);
});

test('bounded state rejects photos embedded as URLs/base64, invalid surfaces and extra root fields', () => {
  const context = { ...common(), recordId: 7 };
  for (const mutate of [
    s => { s.imageBase64 = 'image'; },
    s => { s.photos[0].alignment.image = 'data:image/png;base64,xxxx'; },
    s => { s.photos[0].alignment.url = 'https://storage.invalid/test'; },
    s => { s.photos[0].photo.r2Key = key(8); },
    s => { s.photos[0].alignment.data = new Array(900_001).fill(0); },
    s => { s.photos.push(s.photos[0]); },
    s => { s.marks = new Array(101).fill({}); },
  ]) {
    const state = session(); mutate(state);
    assert.throws(() => validateFacialSimulationState(state, context));
  }
});

test('real controller-shaped editable surfaces/GLB/alignments and validated marks roundtrip without reconstruction', async () => {
  const state = session();
  state.atlas.glbSha256 = 'a'.repeat(64);
  const surface = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
    projection: { cx: 0.5, cy: 0.5, k: 1, aspect: 1 },
  };
  const glb = Buffer.alloc(12); glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(12, 8);
  state.mask = {
    view: 'front', surface, renderSurface: { ...surface, observedIndexCount: 3, observedVertexCount: 3,
      preservedOpenings: 1, inferredColor: '#ffffff', inferredSkinColor: '#ffffff' },
    glbBase64: glb.toString('base64'), depth: 0.2, depthDetails: 'Profundidad manual',
    diagnostics: [], closedHead: false,
    base: { surface, renderSurface: surface, glbBase64: glb.toString('base64') },
    photoPatches: [{ slot: 'front', projection: { u: [1, 0, 0], v: [0, 1, 0], towardCamera: [0, 0, 1] },
      indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1], alpha: [1, 1, 1] }],
  };
  state.marks = [{
    id: 'mark:1', sourceId: 'front', category: 'spot', label: 'Etiqueta clínica libre', note: '',
    box: box(), status: 'validated', source: { provider: 'manual' }, reviewedAt: TIME,
    anchor: { version: 1, triangle: 0, weights: [1, 0, 0] },
    observations: [{ sourceId: 'front', box: box() }],
    crop: { box: box(), sourceWidth: 1000, sourceHeight: 1000 },
  }];
  const f = fixture();
  const saved = await saveFacialSimulation(f.db, save(state), f.storage);
  const loaded = await getFacialSimulation(f.db, { ...common(), query: { record_id: 7, id: saved.id } }, f.storage);
  assert.deepEqual(loaded.state, state);
  state.marks[0].source = { provider: 'edited', original: { provider: 'manual' } };
  const edited = await saveFacialSimulation(f.db, save(state), f.storage);
  assert.deepEqual((await getFacialSimulation(f.db, {
    ...common(), query: { record_id: 7, id: edited.id },
  }, f.storage)).state.marks[0].source, state.marks[0].source);
  state.marks[0].source = { provider: 'edited', original: state.marks[0].source };
  await assert.rejects(saveFacialSimulation(f.db, save(state), f.storage), e => e.status === 400);
  state.marks[0].source = { provider: 'edited', original: { provider: 'manual' } };
  state.marks[0].status = 'pending';
  await assert.rejects(saveFacialSimulation(f.db, save(state), f.storage), e => e.status === 400);
  state.marks[0].status = 'validated'; state.marks[0].sourceId = 'not-uploaded';
  await assert.rejects(saveFacialSimulation(f.db, save(state), f.storage), e => e.status === 400);
});

test('saveSimulationExam creates new consultation + exam atomically, retries same pair, no mass assignment', async () => {
  const f = fixture(), options = exam();
  const result = await saveSimulationExam(f.db, options);
  assert.deepEqual(result, { success: true, consultation_id: 1, exam_id: 100 });
  assert.deepEqual(await saveSimulationExam(f.db, options), result);
  assert.equal(f.s.consultations.length, 1); assert.equal(f.s.exams.length, 1);
  await saveSimulationExam(f.db, exam());
  assert.equal(f.s.consultations.length, 2); assert.equal(f.s.exams.length, 2);
  const bad = exam(); bad.body.exam.consultation_id = 999;
  await assert.rejects(saveSimulationExam(f.db, bad), e => e.status === 400);
  for (const field of ['reason', 'skin_type', 'phototype']) {
    const bad = exam();
    if (field === 'reason') bad.body.reason = ' ';
    else bad.body.exam[field] = '';
    await assert.rejects(saveSimulationExam(f.db, bad), e => e.status === 400);
  }
});

test('exam failure, photo mismatch or receipt failure rolls back consultation, exam and receipt; corrected retry succeeds', async () => {
  for (const failure of ['failExam', 'failReceipt', 'photos']) {
    const f = fixture(), options = exam();
    if (failure === 'photos') f.s.photos = [photo()];
    else f.s[failure] = true;
    await assert.rejects(saveSimulationExam(f.db, options));
    assert.equal(f.s.consultations.length, 0); assert.equal(f.s.exams.length, 0); assert.equal(f.s.receipts.length, 0);
    assert.equal(f.s.queries.at(-1).text, 'ROLLBACK');
    f.s.failExam = f.s.failReceipt = false; f.s.photos = [photo(), photo(7, 11)];
    assert.equal((await saveSimulationExam(f.db, options)).consultation_id, 1);
  }
});

test('R2 write/receipt failure stores no metadata; corrupt read fails closed and never returns state', async () => {
  const f = fixture(), options = save(session());
  await assert.rejects(saveFacialSimulation(f.db, options, {
    ...f.storage, putR2Object() { throw new Error('R2 unavailable'); },
  }));
  assert.equal(f.s.sessions.length, 0); assert.equal(f.s.receipts.length, 0);
  f.s.failReceipt = true;
  await assert.rejects(saveFacialSimulation(f.db, options, f.storage));
  assert.equal(f.s.sessions.length, 0); assert.equal(f.s.receipts.length, 0);
  f.s.failReceipt = false;
  await saveFacialSimulation(f.db, options, f.storage);
  f.s.objects.set(f.s.sessions[0].r2_key, Buffer.from('{}'));
  await assert.rejects(getFacialSimulation(f.db, {
    ...common(), query: { record_id: 7, id: 1 },
  }, f.storage), e => e.status === 409);
});

test('prepared migration enables and forces RLS, no photos/state in receipts or automatic DDL', () => {
  const sql = readFileSync(new URL('../scripts/facial-simulation-schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /facial_simulations FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /clinical_simulation_requests FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /PRIMARY KEY \(clinic_id, request_id\)/);
  assert.match(sql, /GRANT SELECT, INSERT .* TO bioskin_app/);
  assert.match(sql, /current_setting\('app.current_tenant', true\)/);
  const init = readFileSync(new URL('../lib/neon-clinical-db.js', import.meta.url), 'utf8');
  assert.doesNotMatch(init, /facial_simulations|clinical_simulation_requests|facial-simulation-schema/);
  assert.equal(common().clinicId === OTHER, false);
});
