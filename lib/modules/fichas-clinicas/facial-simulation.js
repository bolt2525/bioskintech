import { createHash, randomUUID } from 'node:crypto';
import * as r2 from '../../r2-service.js';
import {
  EDITABLE_FIELDS, PhysicalExamError, savePhysicalExam, validateSkinVisualReview,
} from './physical-exam.js';

export const MAX_SIMULATION_BYTES = 3_900_000;
export const MAX_SIMULATION_BODY_BYTES = 4_000_000;
export const MAX_SIMULATION_PHOTOS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = (status, message) => { throw new PhysicalExamError(status, message); };
const invalid = () => fail(400, 'Datos de simulación inválidos o demasiado extensos.');
const forbidden = () => fail(403, 'Expediente o fotografía sin acceso válido.');
const positiveId = v => ['number', 'string'].includes(typeof v) && /^[1-9]\d{0,9}$/.test(String(v)) &&
  Number(v) <= 2_147_483_647 ? Number(v) : null;
function exact(value, allowed, required = allowed) {
  return plain(value) && Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key));
}
// Canonical fingerprint is independent of property ordering on retry.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(value).digest('hex');
function boundedJson(value, maxBytes) {
  let nodes = 0;
  const walk = (item, depth, parentKey = '') => {
    if (++nodes > 2_000_000 || depth > 16) invalid();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return; }
    if (typeof item === 'string') {
      if (parentKey === 'glbBase64') {
        if (!item.length || item.length > MAX_SIMULATION_BYTES || item.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(item)) invalid();
        const bytes = Buffer.from(item, 'base64');
        if (bytes.toString('base64') !== item || bytes.length < 12 ||
            bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 ||
            bytes.readUInt32LE(8) !== bytes.length) invalid();
        return;
      }
      // No blobs, expiring URLs, remote resources, credentials or image payloads.
      if (item.length > 10_000 || /(?:data:|blob:|https?:\/\/)/i.test(item)) invalid();
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > 900_000) invalid();
      for (const child of item) walk(child, depth + 1);
      return;
    }
    if (!plain(item) || Object.keys(item).length > 500) invalid();
    for (const [key, child] of Object.entries(item)) {
      if (key.length > 100 || ['__proto__', 'prototype', 'constructor'].includes(key) ||
          /^(?:imageBase64|base64|dataUrl|r2_url|token|password|apiKey|secret)$/i.test(key)) invalid();
      walk(child, depth + 1, key);
    }
  };
  walk(value, 0);
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > maxBytes) invalid();
  return serialized;
}

function photoRef(photo, { clinicId, recordId, isOwnedPhotoKey }) {
  if (!exact(photo, ['id', 'r2Key']) || typeof photo.id !== 'number' || !positiveId(photo.id) ||
      typeof photo.r2Key !== 'string' || photo.r2Key.length > 500) invalid();
  if (!isOwnedPhotoKey(photo.r2Key, clinicId, recordId)) forbidden();
}

/**
 * Persisted session v1: photos are durable clinical_photos identities, never
 * data URLs. GLB and editable numerical geometry are private state, not photos.
 * A save creates an immutable numeric revision; requestId is a retry UUID.
 */
export function validateFacialSimulationState(state, context) {
  if (!exact(state, ['version', 'atlas', 'photos', 'mask', 'marks'],
    ['version', 'atlas', 'photos', 'marks']) || state.version !== 1 ||
      !exact(state.atlas, ['modelId', 'version', 'glbSha256'], ['modelId', 'version']) || state.atlas.version !== 1 ||
      typeof state.atlas.modelId !== 'string' || !state.atlas.modelId.trim() || state.atlas.modelId.length > 100 ||
      (state.atlas.glbSha256 !== undefined && (typeof state.atlas.glbSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(state.atlas.glbSha256))) ||
      !Array.isArray(state.photos) || !state.photos.length || state.photos.length > MAX_SIMULATION_PHOTOS ||
      !Array.isArray(state.marks) || state.marks.length > 100) invalid();
  const photos = new Map();
  const slotPhotos = new Map();
  const slots = new Set();
  for (const entry of state.photos) {
    if (!exact(entry, ['slot', 'photo', 'alignment']) || typeof entry.slot !== 'string' ||
        !/^[A-Za-z0-9:_-]{1,100}$/.test(entry.slot) || slots.has(entry.slot) || !plain(entry.alignment)) invalid();
    photoRef(entry.photo, context);
    if (photos.has(entry.photo.id)) invalid();
    photos.set(entry.photo.id, entry.photo.r2Key);
    slots.add(entry.slot);
    slotPhotos.set(entry.slot, entry.photo);
  }
  validateSessionMarks(state.marks, slotPhotos, context);
  if (state.mask !== undefined) {
    const mask = state.mask;
    if (!exact(mask, ['view', 'glbBase64', 'surface', 'renderSurface', 'depth', 'depthDetails',
      'diagnostics', 'closedHead', 'base', 'photoPatches'],
    ['view', 'glbBase64', 'surface', 'depth', 'depthDetails', 'diagnostics', 'closedHead'])) invalid();
    if (typeof mask.view !== 'string' || !slots.has(mask.view) || typeof mask.closedHead !== 'boolean' ||
        typeof mask.depth !== 'number' || !Number.isFinite(mask.depth) ||
        typeof mask.depthDetails !== 'string' || mask.depthDetails.length > 10_000 ||
        !Array.isArray(mask.diagnostics) || mask.diagnostics.length > 100) invalid();
    validateSurface(mask.surface);
    if (mask.renderSurface !== undefined) validateSurface(mask.renderSurface, true);
    if (mask.base !== undefined) {
      if (!exact(mask.base, ['surface', 'renderSurface', 'glbBase64'], ['surface', 'glbBase64'])) invalid();
      validateSurface(mask.base.surface);
      if (mask.base.renderSurface !== undefined) validateSurface(mask.base.renderSurface, true);
    }
    if (mask.photoPatches !== undefined) {
      if (!Array.isArray(mask.photoPatches) || mask.photoPatches.length > 12) invalid();
      for (const patch of mask.photoPatches) {
        if (!exact(patch, ['slot', 'projection', 'indices', 'uvs', 'blendIndices', 'alpha'],
          ['slot', 'projection', 'indices', 'uvs']) || !slots.has(patch.slot) || !plain(patch.projection) ||
            !Array.isArray(patch.indices) || patch.indices.length > 900_000 ||
            !patch.indices.every(n => Number.isInteger(n) && n >= 0 &&
              n < (mask.renderSurface || mask.surface).positions.length / 3) ||
            !Array.isArray(patch.uvs) || !patch.uvs.every(Number.isFinite) ||
            (patch.alpha !== undefined && (!Array.isArray(patch.alpha) ||
              !patch.alpha.every(n => Number.isFinite(n) && n >= 0 && n <= 1)))) invalid();
      }
    }
  }
  return boundedJson(state, MAX_SIMULATION_BYTES);
}

function validateSurface(surface, rendered = false) {
  const fields = ['positions', 'uvs', 'indices', 'projection'];
  const estimated = ['observedIndexCount', 'observedVertexCount', 'preservedOpenings', 'inferredColor', 'inferredSkinColor'];
  if (!exact(surface, [...fields, ...estimated], fields) ||
      !Array.isArray(surface.positions) || surface.positions.length < 9 || surface.positions.length > 300_000 ||
      surface.positions.length % 3 !== 0 ||
      !surface.positions.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000) ||
      !Array.isArray(surface.uvs) || surface.uvs.length !== surface.positions.length / 3 * 2 ||
      !surface.uvs.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100) ||
      !Array.isArray(surface.indices) || surface.indices.length > 900_000 || surface.indices.length % 3 !== 0 ||
      !surface.indices.every(n => Number.isInteger(n) && n >= 0 && n < surface.positions.length / 3) ||
      !exact(surface.projection, ['cx', 'cy', 'k', 'aspect']) ||
      !Object.values(surface.projection).every(n => typeof n === 'number' && Number.isFinite(n)) ||
      surface.projection.k <= 0 || surface.projection.aspect <= 0) invalid();
  if (rendered && surface.observedIndexCount !== undefined &&
      (!Number.isInteger(surface.observedIndexCount) || surface.observedIndexCount < 0 ||
        surface.observedIndexCount > surface.indices.length)) invalid();
}

function validateSessionMarks(marks, refs, context) {
  const ids = new Set();
  for (const mark of marks) {
    if (!exact(mark, ['id', 'sourceId', 'category', 'label', 'note', 'box', 'status', 'source',
      'reviewedAt', 'anchor', 'observations', 'crop'],
    ['id', 'sourceId', 'category', 'label', 'note', 'box', 'status', 'source']) ||
        !refs.has(mark.sourceId) || mark.status !== 'validated' || ids.has(mark.id)) invalid();
    ids.add(mark.id);
    const annotation = {
      id: mark.id, category: mark.category, label: mark.label, note: mark.note,
      coordinateSpace: 'clinical-photo-2d', reviewVersion: 2, reviewStatus: 'validated',
      reviewedAt: mark.reviewedAt,
      photo: refs.get(mark.sourceId), normalizedBox: mark.box, source: mark.source,
      ...(mark.anchor === undefined ? {} : { anchor: mark.anchor }),
    };
    if (mark.observations !== undefined) {
      if (!Array.isArray(mark.observations) || mark.observations.length > 12) invalid();
      annotation.observations = mark.observations.map(o => {
        if (!exact(o, ['sourceId', 'box']) || !refs.has(o.sourceId)) invalid();
        return { photo: refs.get(o.sourceId), normalizedBox: o.box };
      });
    }
    if (mark.crop !== undefined) {
      if (!exact(mark.crop, ['box', 'sourceWidth', 'sourceHeight']) ||
          ![mark.crop.sourceWidth, mark.crop.sourceHeight].every(n => Number.isInteger(n) && n > 0 && n <= 50_000) ||
          mark.crop.sourceWidth * mark.crop.sourceHeight > 40_000_000) invalid();
      annotation.crop = { originalPhoto: refs.get(mark.sourceId), normalizedBox: mark.crop.box,
        sourceWidth: mark.crop.sourceWidth, sourceHeight: mark.crop.sourceHeight };
    }
    validateSkinVisualReview({ version: 2, annotations: [annotation] }, context);
  }
}

function sessionScope(value) {
  const scope = value ?? 'facial-simulation';
  if (!['physical-exam', 'facial-simulation'].includes(scope)) invalid();
  return scope;
}

async function authorize(db, { clinicId, recordId, sessionUser, scope = 'facial-simulation' }) {
  if (typeof clinicId !== 'string' || !UUID.test(clinicId) || !sessionUser ||
      !['own', 'all'].includes(sessionUser.access_scope)) forbidden();
  if (scope === 'facial-simulation' && sessionUser.facial_simulation_enabled !== true)
    fail(403, 'El módulo de simulación facial no está habilitado.');
  if (scope === 'physical-exam' && sessionUser.clinical_records_enabled !== true)
    fail(403, 'El módulo de fichas clínicas no está habilitado.');
  const userId = positiveId(sessionUser.user_id);
  const own = sessionUser.access_scope === 'own';
  if (own && !userId) forbidden();
  const result = await db.query(`SELECT cr.id FROM clinical_records cr
    WHERE cr.id = $1 AND cr.clinic_id = $2
      AND ($3::boolean = false OR cr.created_by_user_id = $4 OR EXISTS (
        SELECT 1 FROM patient_assignments pa
        WHERE pa.patient_id = cr.patient_id AND pa.clinic_user_id = $4))
    FOR KEY SHARE OF cr`, [recordId, clinicId, own, userId]);
  if (!result.rows.length) forbidden();
}

async function bindPhotos(db, photos, clinicId, recordId) {
  const result = await db.query(`SELECT cp.id, cp.r2_key FROM clinical_photos cp
    JOIN jsonb_to_recordset($3::jsonb) AS wanted(id integer, "r2Key" text)
      ON cp.id = wanted.id AND cp.r2_key = wanted."r2Key"
    WHERE cp.record_id = $1 AND cp.clinic_id = $2 FOR KEY SHARE OF cp`,
  [recordId, clinicId, JSON.stringify(photos)]);
  const owned = new Map(result.rows.map(row => [row.id, row.r2_key]));
  if (photos.some(photo => owned.get(photo.id) !== photo.r2Key)) forbidden();
}

async function transaction(db, fn) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL statement_timeout = '10s'");
    await db.query("SET LOCAL lock_timeout = '3s'");
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { /* caller discards/reset client */ }
    throw error;
  }
}

async function simulationStorage(operation, run) {
  try {
    return await run();
  } catch {
    // Storage SDK errors can contain signed requests, keys or credentials.
    console.error('[Facial simulation] Private storage unavailable.', { operation });
    fail(503, 'No se pudo acceder al almacenamiento privado de simulaciones. Solicita al administrador verificar su disponibilidad y configuración, y reintenta con la misma solicitud.');
  }
}

function selectors(body, allowed, optional = []) {
  if (!exact(body, [...allowed, ...optional, 'action'], allowed) || !positiveId(body.record_id) ||
      typeof body.requestId !== 'string' || !UUID.test(body.requestId)) invalid();
  return { recordId: positiveId(body.record_id), requestId: body.requestId.toLowerCase() };
}

async function idempotent(db, context, operation, fingerprint, run) {
  return transaction(db, async () => {
    const { clinicId, recordId, requestId } = context;
    // RLS is already set by records.js on THIS app-role client.
    await authorize(db, context);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`facial-simulation:${clinicId}:${requestId}`]);
    const previous = await db.query(`SELECT record_id, operation, fingerprint, result
      FROM clinical_simulation_requests WHERE clinic_id = $1 AND request_id = $2`,
    [clinicId, requestId]);
    if (previous.rows.length) {
      const saved = previous.rows[0];
      if (saved.record_id !== recordId || saved.operation !== operation || saved.fingerprint !== fingerprint)
        fail(409, 'requestId ya utilizado con otros datos o expediente.');
      return saved.result;
    }
    const result = await run();
    await db.query(`INSERT INTO clinical_simulation_requests
      (clinic_id, request_id, record_id, operation, fingerprint, result)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [clinicId, requestId, recordId, operation, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

export async function saveFacialSimulation(db, options, storage = r2) {
  const { body, clinicId, sessionUser, isOwnedPhotoKey } = options;
  const ids = selectors(body, ['record_id', 'requestId', 'state'], ['scope']);
  const scope = sessionScope(body.scope);
  const context = { ...ids, clinicId, sessionUser, isOwnedPhotoKey, scope };
  const serialized = validateFacialSimulationState(body.state, context);
  return idempotent(db, context, 'session', hash(`${scope}:${serialized}`), async () => {
    const photos = body.state.photos.map(entry => entry.photo);
    await bindPhotos(db, photos, clinicId, ids.recordId);
    // A unique object per attempt avoids clobbering a committed version when a
    // COMMIT acknowledgment is lost. No deletion on uncertain commit.
    const key = `clinics/${clinicId}/records/${ids.recordId}/facial-simulations/${ids.requestId}/${randomUUID()}.json`;
    await simulationStorage('write', () => storage.putR2Object(key, Buffer.from(serialized), 'application/json'));
    await authorize(db, context);
    const result = await db.query(`INSERT INTO facial_simulations
      (request_id, clinic_id, record_id, state_version, r2_key, state_sha256, state_bytes, photo_refs, created_by_user_id, scope)
      VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8,$9)
      RETURNING id, record_id, state_version, created_at, scope`,
    [ids.requestId, clinicId, ids.recordId, key, hash(serialized), Buffer.byteLength(serialized),
      JSON.stringify(photos), positiveId(sessionUser.user_id), scope]);
    return { success: true, ...result.rows[0] };
  });
}

export async function getFacialSimulation(db, options, storage = r2) {
  const { query, clinicId, sessionUser, isOwnedPhotoKey } = options;
  const recordId = positiveId(query.record_id);
  const scope = sessionScope(query.scope);
  const simulationId = positiveId(query.id);
  if (!recordId || !simulationId) invalid();
  return transaction(db, async () => {
    await authorize(db, { clinicId, recordId, sessionUser, scope });
    const result = await db.query(`SELECT id, record_id, state_version, created_at, request_id,
      r2_key, state_sha256, state_bytes FROM facial_simulations
      WHERE id = $1 AND record_id = $2 AND clinic_id = $3
        AND (scope = $4 OR ($4 = 'physical-exam' AND EXISTS (
          SELECT 1 FROM physical_exams pe WHERE pe.record_id = $2 AND pe.clinic_id = $3
            AND pe.skin_visual_review->>'simulationId' = facial_simulations.id::text
        )))`, [simulationId, recordId, clinicId, scope]);
    const row = result.rows[0];
    if (!row) fail(404, 'Simulación no encontrada.');
    const prefix = `clinics/${clinicId}/records/${recordId}/facial-simulations/${row.request_id}/`;
    if (typeof row.r2_key !== 'string' || !row.r2_key.startsWith(prefix) ||
        !Number.isInteger(row.state_bytes) || row.state_bytes > MAX_SIMULATION_BYTES) forbidden();
    const buffer = await simulationStorage('read', () => storage.getR2ObjectBuffer(row.r2_key, MAX_SIMULATION_BYTES));
    if (buffer.length !== row.state_bytes || hash(buffer) !== row.state_sha256)
      fail(409, 'El estado almacenado no supera la verificación de integridad.');
    let state;
    try { state = JSON.parse(buffer.toString('utf8')); } catch { invalid(); }
    validateFacialSimulationState(state, { clinicId, recordId, isOwnedPhotoKey });
    await bindPhotos(db, state.photos.map(entry => entry.photo), clinicId, recordId);
    await authorize(db, { clinicId, recordId, sessionUser, scope });
    return { id: row.id, record_id: row.record_id, state_version: row.state_version,
      created_at: row.created_at, scope, state };
  });
}

export async function listFacialSimulations(db, { query, clinicId, sessionUser }) {
  const recordId = positiveId(query.record_id), limit = query.limit === undefined ? 20 : positiveId(query.limit);
  const scope = sessionScope(query.scope);
  if (!recordId || !limit || limit > 50 ||
      (query.before !== undefined && !positiveId(query.before))) invalid();
  return transaction(db, async () => {
    await authorize(db, { clinicId, recordId, sessionUser, scope });
    const result = await db.query(`SELECT id, record_id, state_version, created_at, photo_refs AS photos
      FROM facial_simulations WHERE record_id = $1 AND clinic_id = $2 AND scope = $5
        AND ($3::integer IS NULL OR (created_at, id) < (
          SELECT created_at, id FROM facial_simulations
          WHERE id = $3 AND record_id = $1 AND clinic_id = $2 AND scope = $5))
      ORDER BY created_at DESC, id DESC LIMIT $4`, [recordId, clinicId, query.before ?? null, limit, scope]);
    return { simulations: result.rows, nextCursor: result.rows.length === limit ? result.rows.at(-1).id : null };
  });
}

/** New consultation + exam + idempotency receipt are committed or rolled back together. */
export async function saveSimulationExam(db, options) {
  const { body, clinicId, sessionUser, isOwnedPhotoKey } = options;
  const ids = selectors(body, ['record_id', 'requestId', 'reason', 'exam']);
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 3000 ||
      !exact(body.exam, [...EDITABLE_FIELDS.filter(key => key !== 'consultation_id'), 'skin_visual_review'],
        ['skin_type', 'phototype']) ||
      !['Sensible', 'Seca', 'Normal', 'Grasa', 'Mixta', 'No determinado'].includes(body.exam.skin_type) ||
      !['I', 'II', 'III', 'IV', 'V', 'VI', 'No determinado'].includes(body.exam.phototype)) invalid();
  const serialized = boundedJson({ reason: body.reason.trim(), exam: body.exam }, 524_288);
  const context = { ...ids, clinicId, sessionUser, isOwnedPhotoKey };
  // Validate provenance/geometry before opening a transaction or inserting a consultation.
  if (Object.hasOwn(body.exam, 'skin_visual_review'))
    validateSkinVisualReview(body.exam.skin_visual_review, context);
  return idempotent(db, context, 'exam', hash(serialized), async () => {
    const consultation = await db.query(`INSERT INTO consultations (record_id, clinic_id, reason)
      VALUES ($1,$2,$3) RETURNING id`, [ids.recordId, clinicId, body.reason.trim()]);
    const consultationId = consultation.rows[0].id;
    const examId = await savePhysicalExam(db, {
      body: { ...body.exam, record_id: ids.recordId, consultation_id: consultationId },
      clinicId, sessionUser, isOwnedPhotoKey,
    });
    return { success: true, consultation_id: consultationId, exam_id: examId };
  });
}
