export const MiB = 1024 * 1024;

export const LIMITS = {
  maxArchiveBytes: 512 * MiB,
  maxPhotosPerPart: 200,
  maxPhotoBytes: 20 * MiB,
  maxDocumentsPerPart: 200,
  // Matches lib/portable-clinical-export.js (32 MiB per rendered document).
  maxDocumentBytes: 32 * MiB,
  // Matches buildDocumentBundles in lib/annual-photo-backup.js.
  maxBundleBytes: 12 * MiB,
  maxBundledDocumentBytes: 4 * MiB,
  maxDocumentsPerBundle: 200,
  maxPartIndex: 9999,
  multipartChunkBytes: 8 * MiB,
};

export type ErrorCode =
  | 'INVALID_CLAIM'
  | 'SOURCE_MISSING'
  | 'SOURCE_TOO_LARGE'
  | 'ARCHIVE_TOO_LARGE'
  | 'UPLOAD_FAILED'
  | 'CALLBACK_FAILED'
  | 'CALLBACK_UNAUTHORIZED'
  | 'CONFIG_MISSING'
  | 'QUEUE_PUBLISH_FAILED'
  | 'LEASE_LOST'
  | 'DEADLINE_EXCEEDED'
  | 'INTERNAL_ERROR';

const PERMANENT: ReadonlySet<ErrorCode> = new Set(['INVALID_CLAIM', 'SOURCE_MISSING', 'SOURCE_TOO_LARGE', 'ARCHIVE_TOO_LARGE']);

export class WorkerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, detail?: string) {
    // detail must never contain clinical data; only static reasons or field names.
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'WorkerError';
    this.code = code;
    this.retryable = !PERMANENT.has(code);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROW_ID_RE = /^(?:[1-9][0-9]{0,17}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEY_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LEASE_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export interface JobIds {
  requestId: string;
  clinicId: string;
}

export interface PhotoEntry {
  key: string;
  entryName: string;
  declaredSize: number;
}

export interface DocumentEntry {
  key: string;
  entryName: string;
  declaredSize: number | null;
  /** Backend JSON bundle ({documents:[{name,contentType,size,sha256,bodyBase64}]}) unpacked into `documentos/`. */
  bundle: boolean;
  sha256: string | null;
}

export interface ValidatedPart {
  index: number;
  key: string;
  photos: PhotoEntry[];
  documents: DocumentEntry[];
  /** ZIP entry names already taken; bundled documents are deduplicated against it at archive time. */
  entryNames: Set<string>;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Accepts exactly {requestId, clinicId}; anything else is rejected so no clinical data rides the queue. */
export function parseJobIds(value: unknown): JobIds | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2) return null;
  const { requestId, clinicId } = value as Record<string, unknown>;
  const req = typeof requestId === 'string' ? requestId.toLowerCase() : requestId;
  const clinic = typeof clinicId === 'string' ? clinicId.toLowerCase() : clinicId;
  if (!isUuid(req) || !isUuid(clinic)) return null;
  return { requestId: req, clinicId: clinic };
}

export function isLeaseToken(value: unknown): value is string {
  return typeof value === 'string' && LEASE_RE.test(value);
}

export function partKey(ids: JobIds, index: number): string {
  return `annual-photo-backups/${ids.clinicId}/${ids.requestId}/part-${String(index).padStart(4, '0')}.zip`;
}

function invalid(field: string): never {
  throw new WorkerError('INVALID_CLAIM', field);
}

function rowId(value: unknown, field: string): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !ROW_ID_RE.test(id)) invalid(field);
  return id;
}

function size(value: unknown, max: number, field: string): number {
  const n = typeof value === 'string' && /^[0-9]{1,12}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) invalid(field);
  if (n > max) throw new WorkerError('SOURCE_TOO_LARGE', field);
  return n;
}

/** Key must be `${prefix}` followed by safe path segments (no traversal, no backslashes, no empty segments). */
function keyUnder(value: unknown, prefix: string, field: string): string {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith(prefix)) invalid(field);
  const rest = value.slice(prefix.length);
  if (!rest || !rest.split('/').every((segment) => KEY_SEGMENT_RE.test(segment) && !segment.includes('..'))) invalid(field);
  return value;
}

export function sanitizeFileName(value: unknown, fallback: string): string {
  const base = typeof value === 'string' ? value.split(/[\\/]/).pop() ?? '' : '';
  const clean = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 100);
  return clean && !clean.includes('..') ? clean : fallback;
}

/** Keeps up to 4 sanitized folder levels (e.g. `historias/paciente-12.html`); traversal segments are dropped. */
export function sanitizeRelativePath(value: unknown, fallback: string): string {
  const segments = (typeof value === 'string' ? value.split(/[\\/]+/) : [])
    .filter((s) => s && s !== '.' && s !== '..')
    .slice(-4)
    .map((s, i, all) => sanitizeFileName(s, i === all.length - 1 ? fallback : 'carpeta'));
  return segments.length ? segments.join('/') : fallback;
}

export function uniqueDocumentName(names: Set<string>, rawName: unknown, fallback: string): string {
  const base = sanitizeRelativePath(rawName, fallback);
  const slash = base.lastIndexOf('/') + 1;
  let entryName = `documentos/${base}`;
  for (let n = 2; names.has(entryName); n += 1) entryName = `documentos/${base.slice(0, slash)}${n}-${base.slice(slash)}`;
  names.add(entryName);
  return entryName;
}

function extension(mime: unknown, key: string): string {
  if (typeof mime === 'string' && MIME_RE.test(mime) && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(key);
  return match ? match[1].toLowerCase() : 'bin';
}

// Per-entry ZIP overhead upper bound: local header + data descriptor + central record + Zip64/timestamp extras.
export function entryOverhead(entryName: string): number {
  return 256 + 2 * new TextEncoder().encode(entryName).byteLength;
}
const ARCHIVE_TRAILER_BYTES = 1024;
export const MANIFEST_NAME = 'manifest.json';

export function validatePart(raw: unknown, ids: JobIds, limits = LIMITS): ValidatedPart {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('part');
  const part = raw as Record<string, unknown>;
  const index = part.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > limits.maxPartIndex) invalid('index');
  const key = partKey(ids, index);
  if (part.key !== key) invalid('key');

  const rawPhotos = part.photos ?? [];
  const rawDocs = part.documents ?? [];
  if (!Array.isArray(rawPhotos) || rawPhotos.length > limits.maxPhotosPerPart) invalid('photos');
  if (!Array.isArray(rawDocs) || rawDocs.length > limits.maxDocumentsPerPart) invalid('documents');

  const names = new Set<string>([MANIFEST_NAME]);
  const sourceKeys = new Set<string>();
  let estimate = ARCHIVE_TRAILER_BYTES + entryOverhead(MANIFEST_NAME) + 512 * (rawPhotos.length + rawDocs.length + 1);

  const photos = rawPhotos.map((item: unknown, i: number): PhotoEntry => {
    if (!item || typeof item !== 'object') invalid(`photos[${i}]`);
    const p = item as Record<string, unknown>;
    const id = rowId(p.id, `photos[${i}].id`);
    const recordId = rowId(p.record_id, `photos[${i}].record_id`);
    const r2Key = keyUnder(p.r2_key, `clinics/${ids.clinicId}/records/${recordId}/photos/`, `photos[${i}].r2_key`);
    // Unknown sizes are budgeted at the per-photo maximum; the real object size is enforced while streaming.
    const rawSize = p.file_size ?? p.size_bytes;
    const declaredSize = rawSize === null || rawSize === undefined ? limits.maxPhotoBytes : size(rawSize, limits.maxPhotoBytes, `photos[${i}].file_size`);
    const entryName = `fotos/${recordId}/${id}.${extension(p.mime_type, r2Key)}`;
    if (names.has(entryName) || sourceKeys.has(r2Key)) invalid(`photos[${i}].duplicate`);
    names.add(entryName);
    sourceKeys.add(r2Key);
    estimate += declaredSize + entryOverhead(entryName);
    return { key: r2Key, entryName, declaredSize };
  });

  const docPrefix = `annual-photo-backups/${ids.clinicId}/${ids.requestId}/source/`;
  const documents = rawDocs.map((item: unknown, i: number): DocumentEntry => {
    if (!item || typeof item !== 'object') invalid(`documents[${i}]`);
    const d = item as Record<string, unknown>;
    const docKey = keyUnder(d.key, docPrefix, `documents[${i}].key`);
    if (sourceKeys.has(docKey)) invalid(`documents[${i}].duplicate`);
    const bundle = d.type === 'bundle';
    if (d.type !== undefined && !bundle) invalid(`documents[${i}].type`);
    const max = bundle ? limits.maxBundleBytes : limits.maxDocumentBytes;
    const declaredSize = d.size === undefined || d.size === null ? null : size(d.size, max, `documents[${i}].size`);
    if (bundle && declaredSize === null) invalid(`documents[${i}].size`);
    const sha256 = d.sha256 === undefined || d.sha256 === null ? null : d.sha256;
    if (sha256 !== null && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))) invalid(`documents[${i}].sha256`);
    // Bundles are unpacked into their inner documents; base64 size is an upper bound of the decoded content.
    const entryName = bundle ? '' : uniqueDocumentName(names, d.name ?? docKey.slice(docPrefix.length), `documento-${i + 1}`);
    sourceKeys.add(docKey);
    estimate += (declaredSize ?? 0) + entryOverhead(entryName);
    return { key: docKey, entryName, declaredSize, bundle, sha256 };
  });

  if (estimate > limits.maxArchiveBytes) throw new WorkerError('ARCHIVE_TOO_LARGE', 'declared');
  return { index, key, photos, documents, entryNames: names };
}