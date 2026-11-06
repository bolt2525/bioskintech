import { LESION_CATEGORIES, AI_LESION_LABELS } from '../ia/skin-lesion-catalog.js';
// Clinical persistence only: no AI permission, provider request or usage ledger dependency.
export const MAX_SKIN_REVIEW_BYTES = 262_144;
export const MAX_SKIN_REVIEW_ANNOTATIONS = 100;
const CATEGORIES = new Set(Object.keys(LESION_CATEGORIES));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Exact canonical UI fields only. Unquoted SQL identifiers fold case in PostgreSQL:
// never infer editable column names from a caller's spelling or normalize its keys.
export const EDITABLE_FIELDS = [
  'consultation_id', 'skin_type', 'phototype', 'glogau_scale', 'hydration', 'elasticity',
  'lesions_description', 'photoprotection', 'texture', 'pores', 'pigmentation', 'sensitivity',
  'face_map_data', 'body_map_data',
];
const INPUT_FIELDS = new Set([
  ...EDITABLE_FIELDS, 'skin_visual_review',
  // Selectors and verified read-only echoes from SELECT *; NEVER mutable SQL columns.
  'id', 'record_id', 'clinic_id', 'created_at', 'action',
]);

export class PhysicalExamError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const invalid = () => { throw new PhysicalExamError(400, 'Revisión visual inválida o demasiado extensa.'); };
const forbidden = () => { throw new PhysicalExamError(403, 'Expediente, examen o foto sin acceso válido.'); };
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value, allowed, required = allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key));
}
function text(value, max, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}
function integerId(value) {
  return ['string', 'number'].includes(typeof value) && /^[1-9]\d{0,9}$/.test(String(value)) &&
    Number(value) <= 2_147_483_647 ? Number(value) : null;
}
function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function box(value) {
  return keys(value, ['x', 'y', 'width', 'height']) &&
    Object.values(value).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) &&
    value.width > 0 && value.height > 0 && value.x + value.width <= 1 && value.y + value.height <= 1;
}
function proposal(value) {
  return keys(value, ['id', 'category', 'label', 'note', 'box']) &&
    text(value.id, 100) && /^[A-Za-z0-9:_-]+$/.test(value.id) &&
    Object.hasOwn(AI_LESION_LABELS, value.category) &&
    text(value.label, 300) && text(value.note, 3000, true) && box(value.box);
}

export function skinReviewPhotos(review) {
  return review.annotations.flatMap(mark => [mark.photo,
    ...(mark.observations || []).map(observation => observation.photo),
    ...(mark.crop ? [mark.crop.originalPhoto] : []),
  ]);
}

/**
 * Contract: src/.../skinVisualAI.ts SkinVisualReviewData / ReviewedSkinMark.
 * The provenance is bounded client-supplied clinical evidence, not proof of an
 * authentic provider invocation. Only explicitly validated marks may be saved.
 */
export function validateSkinVisualReview(value, { clinicId, recordId, isOwnedPhotoKey }) {
  let review = value;
  if (typeof review === 'string') {
    if (Buffer.byteLength(review) > MAX_SKIN_REVIEW_BYTES) invalid();
    try { review = JSON.parse(review); } catch { invalid(); }
  }
  if (!keys(review, ['version', 'annotations', ...(review?.version === 2 ? ['simulationId'] : [])],
    ['version', 'annotations']) || ![1, 2].includes(review.version) ||
      !Array.isArray(review.annotations) || review.annotations.length > MAX_SKIN_REVIEW_ANNOTATIONS) invalid();
  const v2 = review.version === 2;
  if (Object.hasOwn(review, 'simulationId') &&
      (typeof review.simulationId !== 'number' || !integerId(review.simulationId))) invalid();
  const photo = value => keys(value, ['id', 'r2Key']) && typeof value.id === 'number' &&
    integerId(value.id) && text(value.r2Key, 500);
  const ownPhoto = value => {
    if (!photo(value)) invalid();
    if (!isOwnedPhotoKey(value.r2Key, clinicId, recordId)) forbidden();
  };
  const ids = new Set();
  for (const mark of review.annotations) {
    const required = ['id', 'category', 'label', 'note', 'coordinateSpace', 'reviewVersion', 'photo',
      'normalizedBox', 'reviewStatus', 'reviewedAt', 'source'];
    if (!keys(mark, [...required, ...(v2 ? ['anchor', 'observations', 'crop'] : [])], required) ||
        !text(mark.id, 200) || ids.has(mark.id) || !CATEGORIES.has(mark.category) ||
        !text(mark.label, 300) || !text(mark.note, 3000, true) ||
        mark.coordinateSpace !== 'clinical-photo-2d' || mark.reviewVersion !== review.version ||
        mark.reviewStatus !== 'validated' || !isoDate(mark.reviewedAt) || !box(mark.normalizedBox) ||
        !keys(mark.photo, ['id', 'r2Key']) || typeof mark.photo.id !== 'number' ||
        !integerId(mark.photo.id) || !text(mark.photo.r2Key, 500)) invalid();
    if (!isOwnedPhotoKey(mark.photo.r2Key, clinicId, recordId)) forbidden();
    if (v2) {
      if (mark.anchor !== undefined) {
        const anchor = mark.anchor;
        if (!keys(anchor, ['version', 'triangle', 'weights']) || anchor.version !== 1 ||
            !Number.isInteger(anchor.triangle) || anchor.triangle < 0 || anchor.triangle > 100_000 ||
            !Array.isArray(anchor.weights) || anchor.weights.length !== 3 ||
            !anchor.weights.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) ||
            Math.abs(anchor.weights.reduce((a, b) => a + b, 0) - 1) > 0.000001) invalid();
      }
      if (mark.observations !== undefined) {
        if (!Array.isArray(mark.observations) || mark.observations.length > 12) invalid();
        const seen = new Set();
        for (const observation of mark.observations) {
          if (!keys(observation, ['photo', 'normalizedBox']) || !box(observation.normalizedBox)) invalid();
          ownPhoto(observation.photo);
          if (seen.has(observation.photo.id)) invalid();
          seen.add(observation.photo.id);
        }
      }
      if (mark.crop !== undefined) {
        if (!keys(mark.crop, ['originalPhoto', 'normalizedBox', 'sourceWidth', 'sourceHeight'],
          ['originalPhoto', 'normalizedBox']) || !box(mark.crop.normalizedBox)) invalid();
        if (mark.crop.sourceWidth !== undefined || mark.crop.sourceHeight !== undefined) {
          if (![mark.crop.sourceWidth, mark.crop.sourceHeight].every(n => Number.isInteger(n) && n > 0 && n <= 50_000) ||
              mark.crop.sourceWidth * mark.crop.sourceHeight > 40_000_000) invalid();
        }
        ownPhoto(mark.crop.originalPhoto);
        if (mark.crop.originalPhoto.id !== mark.photo.id || mark.crop.originalPhoto.r2Key !== mark.photo.r2Key) invalid();
      }
    }
    let source = mark.source;
    // One edit layer preserves the original evidence; never recursively unwrap
    // attacker-controlled provenance or silently discard the edited wrapper.
    if (v2 && source?.provider === 'edited') {
      if (!keys(source, ['provider', 'original']) ||
          !object(source.original) || !['manual', 'google-gemini'].includes(source.original.provider)) invalid();
      source = source.original;
    }
    if (v2 && keys(source, ['provider']) && source.provider === 'manual') {
      ids.add(mark.id);
      continue;
    }
    if (!keys(source, ['provider', 'analysisId', 'model', 'requestId', 'analyzedAt', 'consentedAt',
      'imageWidth', 'imageHeight', 'proposal', 'summary', 'limitations', 'context']) ||
        source.provider !== 'google-gemini' || typeof source.analysisId !== 'string' ||
        !UUID.test(source.analysisId) || typeof source.requestId !== 'string' || !UUID.test(source.requestId) ||
        !text(source.model, 100) || !/^gemini-[a-z0-9._-]+$/i.test(source.model) ||
        !isoDate(source.analyzedAt) || !isoDate(source.consentedAt) ||
        ![source.imageWidth, source.imageHeight].every(n => Number.isInteger(n) && n > 0 && n <= 4096) ||
        !proposal(source.proposal) || !text(source.summary, 3000) ||
        !Array.isArray(source.limitations) || source.limitations.length > 12 ||
        !source.limitations.every(item => text(item, 1000)) ||
        !keys(source.context, ['skinType', 'phototype', 'hydration'], []) ||
        !Object.values(source.context).every(item => text(item, 40) && /^[\p{L}\p{N} ()/-]+$/u.test(item)) ||
        (!v2 && mark.id !== `skin-photo:${source.analysisId}:${source.proposal.id}`)) invalid();
    ids.add(mark.id);
  }
  const serialized = JSON.stringify(review);
  if (Buffer.byteLength(serialized) > MAX_SKIN_REVIEW_BYTES) invalid();
  return serialized;
}

/**
 * db is the already tenant-scoped app client from records.js, never the owner pool.
 * Photo binding, record scope and ALL exam fields are committed by ONE write.
 * Omitted review preserves the existing JSONB; an explicit validated empty list clears it.
 */
export async function savePhysicalExam(db, { body, clinicId, sessionUser, isOwnedPhotoKey }) {
  if (!object(body)) throw new PhysicalExamError(400, 'Examen físico inválido.');
  if (Object.keys(body).some(key => !INPUT_FIELDS.has(key)) ||
      (Object.hasOwn(body, 'action') && body.action !== 'savePhysicalExam'))
    throw new PhysicalExamError(400, 'Campo de examen físico no permitido.');
  if (typeof clinicId !== 'string' || !UUID.test(clinicId)) forbidden();
  const { id, record_id, skin_visual_review } = body;
  if (Object.hasOwn(body, 'clinic_id') && body.clinic_id !== clinicId)
    throw new PhysicalExamError(400, 'La clínica del examen no se puede modificar.');
  const examId = id == null ? null : integerId(id);
  if (id != null && !examId) throw new PhysicalExamError(400, 'ID de examen inválido.');
  if (!examId && Object.hasOwn(body, 'created_at'))
    throw new PhysicalExamError(400, 'La fecha de creación la establece el servidor.');
  let recordId = integerId(record_id);
  if (examId) {
    const current = await db.query(
      'SELECT record_id, created_at FROM physical_exams WHERE id = $1 AND clinic_id = $2', [examId, clinicId]);
    if (!current.rows.length || (record_id !== undefined && recordId !== current.rows[0].record_id)) forbidden();
    if (Object.hasOwn(body, 'created_at')) {
      const savedDate = current.rows[0].created_at;
      const sameDate = savedDate == null ? body.created_at === savedDate :
        typeof body.created_at === 'string' && Number.isFinite(Date.parse(body.created_at)) &&
          Date.parse(body.created_at) === new Date(savedDate).getTime();
      if (!sameDate) throw new PhysicalExamError(400, 'La fecha de creación no se puede modificar.');
    }
    recordId = current.rows[0].record_id;
  }
  if (!recordId) throw new PhysicalExamError(400, 'Falta el ID del expediente (record_id).');
  const own = sessionUser?.role !== 'master_admin' && sessionUser?.access_scope === 'own';
  const userId = integerId(sessionUser?.user_id);
  if (!sessionUser || (own && !userId)) forbidden();
  const hasReview = Object.hasOwn(body, 'skin_visual_review');
  const review = hasReview ? validateSkinVisualReview(skin_visual_review, {
    clinicId, recordId, isOwnedPhotoKey,
  }) : null;
  // Values/legacy maps retain their behavior; names come only from the fixed server whitelist.
  // Review JSON is deliberately excluded: it can only use the validated review parameter below.
  const safeData = Object.fromEntries(EDITABLE_FIELDS
    .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  const fields = Object.keys(safeData);
  const params = [recordId, clinicId, own, userId];
  const examParam = examId ? `$${params.push(examId)}` : null;
  const reviewParam = hasReview ? `$${params.push(review)}` : null;
  const simulationId = hasReview ? JSON.parse(review).simulationId : undefined;
  const simulationParam = simulationId === undefined ? null : `$${params.push(simulationId)}`;
  const moduleParam = simulationParam ? `$${params.push(sessionUser?.facial_simulation_enabled === true)}` : null;
  const values = Object.values(safeData).map(value => `$${params.push(value)}`);
  const cte = `
    WITH authorized_record AS (
      SELECT cr.id FROM clinical_records cr
      WHERE cr.id = $1 AND cr.clinic_id = $2
        AND ($3::boolean = false OR cr.created_by_user_id = $4 OR EXISTS (
          SELECT 1 FROM patient_assignments pa
          WHERE pa.patient_id = cr.patient_id AND pa.clinic_user_id = $4
        ))
    )${hasReview ? `, requested_photos AS (
      SELECT ann->'photo' AS photo
      FROM jsonb_array_elements(${reviewParam}::jsonb->'annotations') ann
      UNION ALL
      SELECT observation->'photo'
      FROM jsonb_array_elements(${reviewParam}::jsonb->'annotations') ann,
        jsonb_array_elements(COALESCE(ann->'observations', '[]'::jsonb)) observation
      UNION ALL
      SELECT ann->'crop'->'originalPhoto'
      FROM jsonb_array_elements(${reviewParam}::jsonb->'annotations') ann WHERE ann ? 'crop'
    ), bound_photos AS MATERIALIZED (
      SELECT cp.id, cp.r2_key FROM clinical_photos cp
      JOIN requested_photos rp ON cp.id = (rp.photo->>'id')::integer AND cp.r2_key = rp.photo->>'r2Key'
      WHERE cp.record_id = $1 AND cp.clinic_id = $2
      FOR KEY SHARE OF cp
    )` : ''}
  `;
  const photosAllowed = (hasReview ? `NOT EXISTS (
    SELECT 1 FROM requested_photos rp WHERE NOT EXISTS (
      SELECT 1 FROM bound_photos bp
      WHERE bp.id = (rp.photo->>'id')::integer AND bp.r2_key = rp.photo->>'r2Key'
    )
  )` : 'TRUE') + (simulationParam ? ` AND EXISTS (
    SELECT 1 FROM facial_simulations fs
    WHERE fs.id = ${simulationParam} AND fs.record_id = $1 AND fs.clinic_id = $2
      AND (fs.scope = 'physical-exam' OR ${moduleParam}::boolean = true)
      AND NOT EXISTS (SELECT 1 FROM requested_photos rp WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(fs.photo_refs) ref
        WHERE (ref->>'id')::integer = (rp.photo->>'id')::integer AND ref->>'r2Key' = rp.photo->>'r2Key'
      ))
  )` : '');
  let statement;
  if (examId) {
    const setters = fields.map((field, i) => `${field} = ${values[i]}`);
    if (hasReview) setters.push(`skin_visual_review = ${reviewParam}::jsonb`);
    const where = `WHERE pe.id = ${examParam} AND pe.clinic_id = $2 AND pe.record_id = $1
      AND EXISTS (SELECT 1 FROM authorized_record) AND ${photosAllowed}`;
    // A metadata-only legacy save is an authorized no-op, not an UPDATE of protected id.
    statement = setters.length
      ? `${cte} UPDATE physical_exams pe SET ${setters.join(', ')} ${where} RETURNING pe.id`
      : `${cte} SELECT pe.id FROM physical_exams pe ${where}`;
  } else {
    const columns = ['record_id', 'clinic_id', ...fields, ...(hasReview ? ['skin_visual_review'] : [])];
    statement = `${cte}
      INSERT INTO physical_exams (${columns.join(', ')})
      SELECT ${['$1', '$2', ...values, ...(hasReview ? [`${reviewParam}::jsonb`] : [])].join(', ')}
      FROM authorized_record WHERE ${photosAllowed}
      RETURNING id`;
  }
  const saved = await db.query(statement, params);
  if (!saved.rows.length) forbidden();
  return saved.rows[0].id;
}
