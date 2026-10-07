import { createHash } from 'node:crypto';
import { ZipWriter, configure } from '@zip.js/zip.js';
import { Buffer } from 'node:buffer';
import { LIMITS, MANIFEST_NAME, WorkerError, uniqueDocumentName } from './claim.ts';
import type { DocumentEntry, JobIds, ValidatedPart } from './claim.ts';

// Workers have no Web Workers; STORE entries need no codec.
configure({ useWebWorkers: false, useCompressionStream: false });

export interface ArchiveOptions {
  deadline: number;
  chunkBytes?: number;
  maxArchiveBytes?: number;
  maxPhotoBytes?: number;
  maxDocumentBytes?: number;
  maxBundleBytes?: number;
}

export interface ArchiveResult {
  size: number;
  sha256: string;
  fileCount: number;
}

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

interface BundledDocument {
  name: string;
  data: Uint8Array;
}

/** Parses an untrusted backend bundle; every inner document is size- and hash-checked before archiving. */
export function parseBundle(raw: Uint8Array, maxDocuments: number, maxDocumentBytes: number): BundledDocument[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    throw new WorkerError('INVALID_CLAIM', 'bundle_json');
  }
  const bundle = parsed as { format?: unknown; version?: unknown; documents?: unknown };
  if (!bundle || bundle.format !== 'bioskin-annual-document-bundle' || bundle.version !== 1 ||
    !Array.isArray(bundle.documents) || bundle.documents.length > maxDocuments) throw new WorkerError('INVALID_CLAIM', 'bundle_format');
  return bundle.documents.map((item: unknown) => {
    const d = (item ?? {}) as Record<string, unknown>;
    if (typeof d.name !== 'string' || typeof d.bodyBase64 !== 'string' || typeof d.sha256 !== 'string' ||
      !Number.isSafeInteger(d.size) || (d.size as number) < 0 || (d.size as number) > maxDocumentBytes ||
      d.bodyBase64.length > Math.ceil(maxDocumentBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(d.bodyBase64)) {
      throw new WorkerError('INVALID_CLAIM', 'bundle_document');
    }
    const data = new Uint8Array(Buffer.from(d.bodyBase64, 'base64'));
    if (data.byteLength !== d.size || sha256Hex(data) !== d.sha256) throw new WorkerError('INVALID_CLAIM', 'bundle_document_hash');
    return { name: d.name, data };
  });
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new WorkerError('DEADLINE_EXCEEDED');
}

/** Passes exactly `expected` bytes through; errors on overrun/underrun so a changed object can never be archived silently. */
function exactLength(expected: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expected) throw new WorkerError('UPLOAD_FAILED', 'source_length');
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== expected) throw new WorkerError('UPLOAD_FAILED', 'source_length');
    },
  });
}

/**
 * Streams one validated part into `ARCHIVES` as a STORE ZIP via a multipart upload.
 * Memory is bounded to one chunk buffer: each full chunk is uploaded (awaited) before more ZIP bytes are accepted.
 */
export async function buildPartArchive(
  env: Pick<Env, 'SOURCE' | 'ARCHIVES'>,
  ids: JobIds,
  part: ValidatedPart,
  options: ArchiveOptions,
): Promise<ArchiveResult> {
  const chunkBytes = options.chunkBytes ?? LIMITS.multipartChunkBytes;
  const maxArchiveBytes = options.maxArchiveBytes ?? LIMITS.maxArchiveBytes;
  const { deadline } = options;

  checkDeadline(deadline);
  const upload = await env.ARCHIVES.createMultipartUpload(part.key, {
    httpMetadata: { contentType: 'application/zip' },
    customMetadata: { requestId: ids.requestId, clinicId: ids.clinicId, part: String(part.index) },
  });

  const hash = createHash('sha256');
  const uploaded: R2UploadedPart[] = [];
  let buffer = new Uint8Array(chunkBytes);
  let filled = 0;
  let total = 0;
  let sinkError: unknown = null;

  const flush = async (): Promise<void> => {
    if (filled === 0) return;
    checkDeadline(deadline);
    const body = filled === buffer.byteLength ? buffer : buffer.subarray(0, filled);
    try {
      uploaded.push(await upload.uploadPart(uploaded.length + 1, body));
    } catch {
      throw new WorkerError('UPLOAD_FAILED', 'upload_part');
    }
    buffer = new Uint8Array(chunkBytes);
    filled = 0;
  };

  const sink = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        total += chunk.byteLength;
        if (total > maxArchiveBytes) throw new WorkerError('ARCHIVE_TOO_LARGE', 'output');
        checkDeadline(deadline);
        hash.update(chunk);
        for (let offset = 0; offset < chunk.byteLength; ) {
          const n = Math.min(chunk.byteLength - offset, chunkBytes - filled);
          buffer.set(chunk.subarray(offset, offset + n), filled);
          filled += n;
          offset += n;
          if (filled === chunkBytes) await flush();
        }
      } catch (error) {
        sinkError ??= error;
        throw error;
      }
    },
    async close() {
      try {
        await flush();
      } catch (error) {
        sinkError ??= error;
        throw error;
      }
    },
  });

  const zip = new ZipWriter(sink, { level: 0, keepOrder: true, bufferedWrite: false, useWebWorkers: false });
  let sourceTotal = 0;
  const files: { name: string; size: number }[] = [];
  // Deterministic output (same bytes and sha256) when a part is rebuilt after a retry.
  let manifestDate = new Date(Date.UTC(2020, 0, 1));

  const addEntry = async (key: string, entryName: string, maxBytes: number): Promise<void> => {
    checkDeadline(deadline);
    const object = await env.SOURCE.get(key);
    if (!object) throw new WorkerError('SOURCE_MISSING');
    if (object.size > maxBytes) {
      await object.body.cancel();
      throw new WorkerError('SOURCE_TOO_LARGE');
    }
    sourceTotal += object.size;
    if (sourceTotal > maxArchiveBytes) {
      await object.body.cancel();
      throw new WorkerError('ARCHIVE_TOO_LARGE', 'sources');
    }
    await zip.add(entryName, object.body.pipeThrough(exactLength(object.size)), { lastModDate: object.uploaded });
    files.push({ name: entryName, size: object.size });
    if (object.uploaded > manifestDate) manifestDate = object.uploaded;
  };

  // Bundles are <= 12 MiB, so one is held in memory at a time (bounded); each is released before the next.
  const addBundle = async (doc: DocumentEntry): Promise<void> => {
    checkDeadline(deadline);
    const maxBundleBytes = options.maxBundleBytes ?? LIMITS.maxBundleBytes;
    const object = await env.SOURCE.get(doc.key);
    if (!object) throw new WorkerError('SOURCE_MISSING');
    if (object.size > maxBundleBytes || (doc.declaredSize !== null && object.size !== doc.declaredSize)) {
      await object.body.cancel();
      throw new WorkerError(object.size > maxBundleBytes ? 'SOURCE_TOO_LARGE' : 'INVALID_CLAIM', 'bundle_size');
    }
    const raw = new Uint8Array(await object.arrayBuffer());
    if (doc.sha256 !== null && sha256Hex(raw) !== doc.sha256) throw new WorkerError('INVALID_CLAIM', 'bundle_hash');
    for (const inner of parseBundle(raw, LIMITS.maxDocumentsPerBundle, LIMITS.maxBundledDocumentBytes)) {
      checkDeadline(deadline);
      const entryName = uniqueDocumentName(part.entryNames, inner.name, `documento-${files.length + 1}`);
      sourceTotal += inner.data.byteLength;
      if (sourceTotal > maxArchiveBytes) throw new WorkerError('ARCHIVE_TOO_LARGE', 'sources');
      await zip.add(entryName, new Blob([inner.data]).stream(), { lastModDate: object.uploaded });
      files.push({ name: entryName, size: inner.data.byteLength });
    }
    if (object.uploaded > manifestDate) manifestDate = object.uploaded;
  };

  try {
    for (const photo of part.photos) await addEntry(photo.key, photo.entryName, options.maxPhotoBytes ?? LIMITS.maxPhotoBytes);
    for (const doc of part.documents) {
      if (doc.bundle) await addBundle(doc);
      else await addEntry(doc.key, doc.entryName, options.maxDocumentBytes ?? LIMITS.maxDocumentBytes);
    }
    // Manifest holds only IDs, entry names and sizes; it also makes empty parts valid ZIPs.
    const manifest = JSON.stringify({ format: 'bioskin-annual-photo-backup/v1', requestId: ids.requestId, clinicId: ids.clinicId, part: part.index, files });
    await zip.add(MANIFEST_NAME, new Blob([manifest]).stream(), { lastModDate: manifestDate });
    await zip.close();
    checkDeadline(deadline);
    let stored: R2Object;
    try {
      stored = await upload.complete(uploaded);
    } catch {
      throw new WorkerError('UPLOAD_FAILED', 'complete');
    }
    if (stored.size !== total) throw new WorkerError('UPLOAD_FAILED', 'size_mismatch');
    return { size: total, sha256: hash.digest('hex'), fileCount: files.length };
  } catch (error) {
    try {
      await upload.abort();
    } catch {
      // Uncompleted uploads are auto-aborted by R2 after 7 days.
    }
    if (sinkError instanceof WorkerError) throw sinkError;
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('INTERNAL_ERROR', 'archive');
  }
}