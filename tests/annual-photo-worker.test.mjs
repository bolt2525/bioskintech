import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { handleFetch, handleMessage, handleMaintenance, isAuthorized } from '../workers/annual-photo-backup/src/handlers.ts';
import { LIMITS, parseJobIds, sanitizeFileName, sanitizeRelativePath, validatePart } from '../workers/annual-photo-backup/src/claim.ts';

// Synthetic identifiers and bytes only; no real clinical data.
const SECRET = 'unit-test-service-secret-'.padEnd(48, 'x');
const CLINIC = '11111111-2222-4333-8444-555555555555';
const OTHER_CLINIC = '99999999-2222-4333-8444-555555555555';
const REQUEST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const IDS = { requestId: REQUEST, clinicId: CLINIC };
const LEASE = 'lease-token-0123456789abcdef';
const PART_KEY = `annual-photo-backups/${CLINIC}/${REQUEST}/part-0001.zip`;
const DOC_PREFIX = `annual-photo-backups/${CLINIC}/${REQUEST}/source/`;
const photoKey = (recordId, name) => `clinics/${CLINIC}/records/${recordId}/photos/${name}`;

const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

class FakeBucket {
  objects = new Map();
  uploads = [];
  failUploadPart = false;

  put(key, data, size = data.byteLength) {
    this.objects.set(key, { data, size, uploaded: new Date('2026-01-15T10:00:00Z'), cancelled: false });
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    let offset = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset >= object.data.byteLength) return controller.close();
        const end = Math.min(offset + 3000, object.data.byteLength);
        controller.enqueue(object.data.slice(offset, end));
        offset = end;
      },
      cancel() {
        object.cancelled = true;
      },
    });
    return { size: object.size, uploaded: object.uploaded, body, arrayBuffer: () => new Response(body).arrayBuffer() };
  }

  async createMultipartUpload(key, options) {
    const bucket = this;
    const state = { key, options, parts: new Map(), aborted: false, completed: false, partSizes: [] };
    this.uploads.push(state);
    return {
      async uploadPart(partNumber, value) {
        if (bucket.failUploadPart) throw new Error('simulated');
        state.parts.set(partNumber, new Uint8Array(value));
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(list) {
        const chunks = list.map((p) => state.parts.get(p.partNumber));
        state.partSizes = chunks.map((c) => c.byteLength);
        const data = new Uint8Array(state.partSizes.reduce((a, b) => a + b, 0));
        let offset = 0;
        for (const c of chunks) {
          data.set(c, offset);
          offset += c.byteLength;
        }
        bucket.objects.set(key, { data, size: data.byteLength, uploaded: new Date() });
        state.completed = true;
        return { size: data.byteLength };
      },
      async abort() {
        state.aborted = true;
      },
    };
  }
}

function makeEnv(overrides = {}) {
  const bucket = new FakeBucket();
  const queue = { sent: [], async send(body, options) { this.sent.push({ body, options }); } };
  return {
    bucket,
    queue,
    env: {
      SOURCE: bucket,
      ARCHIVES: bucket,
      PHOTO_BACKUP_QUEUE: queue,
      BACKEND_BASE_URL: 'https://backend.test',
      MAX_DELIVERY_ATTEMPTS: '4',
      ANNUAL_BACKUP_SERVICE_SECRET: SECRET,
      ...overrides,
    },
  };
}

function makeMessage(body = IDS, attempts = 1) {
  return {
    id: 'msg-1',
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: null,
    ack() { this.acked = true; },
    retry(options = {}) { this.retried = options; },
  };
}

function mockBackend(t, routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    const action = url.searchParams.get('action');
    const body = JSON.parse(init.body);
    calls.push({ action, body, auth: init.headers.authorization, origin: url.origin, path: url.pathname });
    const route = routes[action];
    if (!route) return new Response('{}', { status: 500 });
    const { status = 200, json } = route(body, calls);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function claimed(part, extra = {}) {
  return () => ({ json: { state: 'claimed', leaseToken: LEASE, totalParts: 1, remainingParts: 1, parts: [part], ...extra } });
}

function seedPart(bucket) {
  const photos = [
    { id: 101, record_id: 7, name: 'a1.jpg', mime: 'image/jpeg', data: bytes(10_000, 1) },
    { id: 102, record_id: 7, name: 'a2.png', mime: 'image/png', data: bytes(9_001, 2) },
  ].map((p) => {
    bucket.put(photoKey(p.record_id, p.name), p.data);
    return { id: p.id, record_id: p.record_id, r2_key: photoKey(p.record_id, p.name), file_size: p.data.byteLength, mime_type: p.mime };
  });
  const docData = new TextEncoder().encode('id,record\n101,7\n102,7\n');
  bucket.put(`${DOC_PREFIX}manifest.csv`, docData);
  return {
    index: 1,
    key: PART_KEY,
    photos,
    documents: [{ key: `${DOC_PREFIX}manifest.csv`, name: '../../indice fotos?.csv', size: docData.byteLength }],
  };
}

const dispatch = (env, { auth = `Bearer ${SECRET}`, body = IDS, method = 'POST', path = '/dispatch', type = 'application/json' } = {}) =>
  handleFetch(new Request(`https://worker.test${path}`, {
    method,
    headers: { ...(auth ? { authorization: auth } : {}), 'content-type': type },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  }), env);

test('dispatch: auth, validation and queue payload contains only IDs', async () => {
  const { env, queue } = makeEnv();
  assert.equal((await dispatch(env, { auth: null })).status, 401);
  assert.equal((await dispatch(env, { auth: 'Bearer wrong' })).status, 401);
  assert.equal((await dispatch(env, { method: 'GET' })).status, 405);
  assert.equal((await dispatch(env, { path: '/other' })).status, 404);
  assert.equal((await dispatch(env, { type: 'text/plain' })).status, 415);
  assert.equal((await dispatch(env, { body: '{bad' })).status, 400);
  assert.equal((await dispatch(env, { body: { ...IDS, patient: 'x' } })).status, 400);
  assert.equal((await dispatch(env, { body: { requestId: 'nope', clinicId: CLINIC } })).status, 400);
  assert.equal((await dispatch(env, { body: 'x'.repeat(2000) })).status, 413);
  assert.equal(queue.sent.length, 0);

  const ok = await dispatch(env, { body: { requestId: REQUEST.toUpperCase(), clinicId: CLINIC } });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { state: 'queued' });
  assert.deepEqual(queue.sent, [{ body: IDS, options: { contentType: 'json' } }]);

  const { env: unconfigured } = makeEnv({ ANNUAL_BACKUP_SERVICE_SECRET: 'short' });
  assert.equal((await dispatch(unconfigured, { auth: 'Bearer short' })).status, 503);
});

test('isAuthorized is length-independent and exact', () => {
  assert.equal(isAuthorized(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(isAuthorized(`Bearer ${SECRET}x`, SECRET), false);
  assert.equal(isAuthorized(SECRET, SECRET), false);
  assert.equal(isAuthorized(null, SECRET), false);
});

test('consumer builds STORE ZIP part, uploads uniform multipart chunks and reports hash', async (t) => {
  const { env, bucket, queue } = makeEnv();
  const part = seedPart(bucket);
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerPart: () => ({ json: { state: 'part_recorded', remainingParts: 1 } }),
  });
  const message = makeMessage();
  await handleMessage(message, env, { chunkBytes: 4096 });

  assert.equal(message.acked, true);
  assert.deepEqual(calls.map((c) => c.action), ['photoBackupWorkerClaim', 'photoBackupWorkerPart']);
  assert.ok(calls.every((c) => c.auth === `Bearer ${SECRET}` && c.origin === 'https://backend.test' && c.path === '/api/backup'));
  assert.deepEqual(calls[0].body, { ...IDS, attempt: 1 });

  const upload = bucket.uploads[0];
  assert.equal(upload.completed, true);
  assert.equal(upload.aborted, false);
  assert.equal(upload.options.httpMetadata.contentType, 'application/zip');
  assert.ok(upload.partSizes.length > 3);
  assert.ok(upload.partSizes.slice(0, -1).every((s) => s === 4096));

  const stored = bucket.objects.get(PART_KEY).data;
  const reported = calls[1].body;
  assert.deepEqual(reported, {
    ...IDS,
    leaseToken: LEASE,
    index: 1,
    key: PART_KEY,
    size: stored.byteLength,
    sha256: createHash('sha256').update(stored).digest('hex'),
    fileCount: 3,
  });

  const reader = new ZipReader(new Uint8ArrayReader(stored));
  const entries = await reader.getEntries();
  assert.deepEqual(entries.map((e) => e.filename), ['fotos/7/101.jpg', 'fotos/7/102.png', 'documentos/indice_fotos_.csv', 'manifest.json']);
  assert.ok(entries.every((e) => e.compressionMethod === 0));
  const manifest = JSON.parse(new TextDecoder().decode(await entries[3].getData(new Uint8ArrayWriter())));
  assert.deepEqual(manifest.files.map((f) => f.name), entries.slice(0, 3).map((e) => e.filename));
  assert.equal(manifest.requestId, REQUEST);
  assert.deepEqual(await entries[0].getData(new Uint8ArrayWriter()), bucket.objects.get(part.photos[0].r2_key).data);
  await reader.close();

  // Next part / completion is claimed by a fresh message carrying IDs only.
  assert.deepEqual(queue.sent, [{ body: IDS, options: { contentType: 'json' } }]);
});

test('ready_to_complete calls Complete with the lease and acks', async (t) => {
  const { env, bucket } = makeEnv();
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: () => ({ json: { state: 'ready_to_complete', leaseToken: LEASE, totalParts: 2, remainingParts: 0 } }),
    photoBackupWorkerComplete: () => ({ json: { state: 'completed' } }),
  });
  const message = makeMessage();
  await handleMessage(message, env);
  assert.equal(message.acked, true);
  assert.deepEqual(calls[1], { action: 'photoBackupWorkerComplete', body: { ...IDS, leaseToken: LEASE }, auth: `Bearer ${SECRET}`, origin: 'https://backend.test', path: '/api/backup' });
  assert.equal(bucket.uploads.length, 0);
});

test('409 terminal state acks without duplicate work; leased retries later', async (t) => {
  for (const state of ['completed', 'failed', 'cancelled']) {
    const { env, bucket, queue } = makeEnv();
    mockBackend(t, { photoBackupWorkerClaim: () => ({ status: 409, json: { state } }) });
    const message = makeMessage();
    await handleMessage(message, env);
    assert.equal(message.acked, true, state);
    assert.equal(message.retried, null);
    assert.equal(bucket.uploads.length + queue.sent.length, 0);
  }
  const { env } = makeEnv();
  mockBackend(t, { photoBackupWorkerClaim: () => ({ status: 409, json: { state: 'leased', retryAfterSeconds: 5 } }) });
  const message = makeMessage();
  await handleMessage(message, env);
  assert.equal(message.acked, false);
  assert.deepEqual(message.retried, { delaySeconds: 30 });
});

test('401 from backend is never swallowed nor reported as failure', async (t) => {
  const { env } = makeEnv();
  const calls = mockBackend(t, { photoBackupWorkerClaim: () => ({ status: 401, json: { error: 'unauthorized' } }) });
  const message = makeMessage(IDS, 4);
  await handleMessage(message, env);
  assert.equal(message.acked, false);
  assert.deepEqual(message.retried, { delaySeconds: 300 });
  assert.deepEqual(calls.map((c) => c.action), ['photoBackupWorkerClaim']);
});

test('claim reply without explicit state is retried', async (t) => {
  const { env } = makeEnv();
  mockBackend(t, { photoBackupWorkerClaim: () => ({ json: { leaseToken: LEASE } }) });
  const message = makeMessage();
  await handleMessage(message, env);
  assert.equal(message.acked, false);
  assert.ok(message.retried);
});

test('untrusted claim outside tenant prefix fails permanently with safe code', async (t) => {
  const { env, bucket } = makeEnv();
  const part = seedPart(bucket);
  part.photos[0].r2_key = `clinics/${OTHER_CLINIC}/records/7/photos/a1.jpg`;
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerFail: () => ({ json: { state: 'failed' } }),
  });
  const message = makeMessage();
  await handleMessage(message, env);
  assert.equal(message.acked, true);
  assert.equal(bucket.uploads.length, 0);
  assert.deepEqual(calls[1].body, { ...IDS, leaseToken: LEASE, code: 'INVALID_CLAIM', attempt: 1 });
});

test('missing source aborts the multipart upload and reports SOURCE_MISSING', async (t) => {
  const { env, bucket } = makeEnv();
  const part = seedPart(bucket);
  bucket.objects.delete(part.photos[1].r2_key);
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerFail: () => ({ json: { state: 'failed' } }),
  });
  await handleMessage(makeMessage(), env, { chunkBytes: 4096 });
  assert.equal(bucket.uploads[0].aborted, true);
  assert.equal(bucket.objects.has(PART_KEY), false);
  assert.equal(calls.at(-1).body.code, 'SOURCE_MISSING');
});

test('oversized real object is rejected before reading its body', async (t) => {
  const { env, bucket } = makeEnv();
  const part = seedPart(bucket);
  const big = bucket.objects.get(part.photos[0].r2_key);
  big.size = LIMITS.maxPhotoBytes + 1;
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerFail: () => ({ json: { state: 'failed' } }),
  });
  await handleMessage(makeMessage(), env, { chunkBytes: 4096 });
  assert.equal(big.cancelled, true);
  assert.equal(bucket.uploads[0].aborted, true);
  assert.equal(calls.at(-1).body.code, 'SOURCE_TOO_LARGE');
});

test('archive output limit aborts with ARCHIVE_TOO_LARGE', async (t) => {
  const { env, bucket } = makeEnv();
  const part = seedPart(bucket);
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerFail: () => ({ json: { state: 'failed' } }),
  });
  await handleMessage(makeMessage(), env, { chunkBytes: 4096, maxArchiveBytes: 12_000 });
  assert.equal(bucket.uploads[0].aborted, true);
  assert.equal(calls.at(-1).body.code, 'ARCHIVE_TOO_LARGE');
});

test('transient upload failure retries, then reports UPLOAD_FAILED on the last attempt', async (t) => {
  const { env, bucket } = makeEnv();
  bucket.failUploadPart = true;
  const part = seedPart(bucket);
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerFail: () => ({ json: { state: 'failed' } }),
  });
  const first = makeMessage(IDS, 1);
  await handleMessage(first, env, { chunkBytes: 4096 });
  assert.deepEqual(first.retried, { delaySeconds: 60 });
  assert.equal(bucket.uploads[0].aborted, true);
  assert.ok(!calls.some((c) => c.action === 'photoBackupWorkerFail'));

  const last = makeMessage(IDS, 4);
  await handleMessage(last, env, { chunkBytes: 4096 });
  assert.equal(last.acked, true);
  assert.deepEqual(calls.at(-1).body, { ...IDS, leaseToken: LEASE, code: 'UPLOAD_FAILED', attempt: 4 });
});

test('validatePart enforces key layout, limits and sanitized names', () => {
  const base = { index: 1, key: PART_KEY, photos: [], documents: [{ key: `${DOC_PREFIX}a.csv`, name: 'a.csv' }] };
  assert.equal(validatePart(base, IDS).documents[0].entryName, 'documentos/a.csv');
  const bad = [
    { ...base, key: `annual-photo-backups/${CLINIC}/${REQUEST}/part-0002.zip` },
    { ...base, index: 0 },
    { ...base, documents: [{ key: `${DOC_PREFIX}../x.csv`, name: 'x' }] },
    { ...base, documents: [{ key: `annual-photo-backups/${CLINIC}/${REQUEST}/x.csv`, name: 'x' }] },
    { ...base, photos: [{ id: 1, record_id: 2, r2_key: photoKey(3, 'a.jpg'), file_size: 1 }] },
    { ...base, photos: [{ id: 1, record_id: 2, r2_key: photoKey(2, 'a\\b.jpg'), file_size: 1 }] },
    { ...base, photos: [{ id: '1;drop', record_id: 2, r2_key: photoKey(2, 'a.jpg'), file_size: 1 }] },
  ];
  for (const raw of bad) assert.throws(() => validatePart(raw, IDS), { code: 'INVALID_CLAIM' });
  const tooMany = { ...base, photos: Array.from({ length: 201 }, (_, i) => ({ id: i + 1, record_id: 2, r2_key: photoKey(2, `${i}.jpg`), file_size: 1 })) };
  assert.throws(() => validatePart(tooMany, IDS), { code: 'INVALID_CLAIM' });
  const tooBig = { ...base, photos: [{ id: 1, record_id: 2, r2_key: photoKey(2, 'a.jpg'), file_size: LIMITS.maxPhotoBytes + 1 }] };
  assert.throws(() => validatePart(tooBig, IDS), { code: 'SOURCE_TOO_LARGE' });
  const total = { ...base, photos: Array.from({ length: 27 }, (_, i) => ({ id: i + 1, record_id: 2, r2_key: photoKey(2, `${i}.jpg`), file_size: LIMITS.maxPhotoBytes })) };
  assert.throws(() => validatePart(total, IDS), { code: 'ARCHIVE_TOO_LARGE' });

  assert.equal(sanitizeFileName('..\\..\\x/..//.hidden name.csv', 'f'), 'hidden_name.csv');
  assert.equal(sanitizeFileName('...', 'fallback'), 'fallback');
  assert.equal(parseJobIds({ ...IDS, extra: 1 }), null);
});

test('last part completes in the same invocation using the retained lease', async (t) => {
  const { env, bucket, queue } = makeEnv();
  const part = seedPart(bucket);
  part.photos[0].size_bytes = part.photos[0].file_size;
  delete part.photos[0].file_size;
  part.photos[1].file_size = null;
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerPart: () => ({ json: { state: 'part_recorded', remainingParts: 0 } }),
    photoBackupWorkerComplete: () => ({ json: { state: 'completed' } }),
  });
  const message = makeMessage();
  await handleMessage(message, env, { chunkBytes: 4096 });
  assert.equal(message.acked, true);
  assert.deepEqual(calls.map((c) => c.action), ['photoBackupWorkerClaim', 'photoBackupWorkerPart', 'photoBackupWorkerComplete']);
  assert.deepEqual(calls[2].body, { ...IDS, leaseToken: LEASE });
  assert.equal(queue.sent.length, 0);
});

test('empty part produces a manifest-only ZIP and rebuilds are byte-identical', async (t) => {
  const hashes = [];
  for (let run = 0; run < 2; run += 1) {
    const { env, bucket } = makeEnv();
    const calls = mockBackend(t, {
      photoBackupWorkerClaim: claimed({ index: 1, key: PART_KEY, photos: [], documents: [] }),
      photoBackupWorkerPart: () => ({ json: { state: 'part_recorded', remainingParts: 1 } }),
    });
    await handleMessage(makeMessage(), env);
    const reader = new ZipReader(new Uint8ArrayReader(bucket.objects.get(PART_KEY).data));
    assert.deepEqual((await reader.getEntries()).map((e) => e.filename), ['manifest.json']);
    await reader.close();
    assert.equal(calls[1].body.fileCount, 0);
    hashes.push(calls[1].body.sha256);
  }
  assert.equal(hashes[0], hashes[1]);
});

test('portable export folder layout is preserved and sanitized', () => {
  const docs = ['datos/backup.json', 'historias/paciente-12.html', 'consentimientos/paciente-12/consentimiento-5.html', 'LEAME.html', 'historias/paciente-12.html']
    .map((name) => ({ key: `${DOC_PREFIX}${name}`, name, size: 10 }));
  docs[4].key = `${DOC_PREFIX}historias/dup.html`;
  const part = validatePart({ index: 1, key: PART_KEY, photos: [], documents: docs }, IDS);
  assert.deepEqual(part.documents.map((d) => d.entryName), [
    'documentos/datos/backup.json',
    'documentos/historias/paciente-12.html',
    'documentos/consentimientos/paciente-12/consentimiento-5.html',
    'documentos/LEAME.html',
    'documentos/historias/2-paciente-12.html',
  ]);
  assert.equal(sanitizeRelativePath('../../a/./b c/..\\x?.html', 'f'), 'a/b_c/x_.html');
  assert.throws(() => validatePart({ index: 1, key: PART_KEY, photos: [], documents: [{ key: `${DOC_PREFIX}a.json`, name: 'a.json', size: LIMITS.maxDocumentBytes + 1 }] }, IDS), { code: 'SOURCE_TOO_LARGE' });
});

test('queue publish failure after a persisted part retries without Fail and resumes at the next part', async (t) => {
  const { env, bucket, queue } = makeEnv();
  const part1 = seedPart(bucket);
  const part2 = { index: 2, key: PART_KEY.replace('part-0001', 'part-0002'), photos: [], documents: [] };
  let recorded = 0;
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: () => ({ json: { state: 'claimed', leaseToken: LEASE, totalParts: 2, remainingParts: 2 - recorded, parts: [recorded ? part2 : part1] } }),
    photoBackupWorkerPart: () => { recorded += 1; return { json: { state: 'part_recorded', remainingParts: 2 - recorded } }; },
    photoBackupWorkerComplete: () => ({ json: { state: 'completed' } }),
  });
  queue.send = async () => { throw new Error('queue unavailable'); };
  const last = makeMessage(IDS, 4);
  await handleMessage(last, env, { chunkBytes: 4096 });
  assert.equal(last.acked, false);
  assert.deepEqual(last.retried, { delaySeconds: 300 });
  assert.ok(!calls.some((c) => c.action === 'photoBackupWorkerFail'));

  // Redelivery (or backend re-dispatch) claims the next pending part, not part 1 again.
  const again = makeMessage(IDS, 5);
  await handleMessage(again, env);
  assert.equal(again.acked, true);
  assert.deepEqual(calls.filter((c) => c.action === 'photoBackupWorkerPart').map((c) => c.body.index), [1, 2]);
  assert.equal(calls.at(-1).action, 'photoBackupWorkerComplete');
  assert.equal(bucket.uploads.length, 2);
});

test('backend redirect is a configuration error, never followed nor reported as job failure', async (t) => {
  const { env } = makeEnv();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push(init.redirect);
    return new Response(null, { status: 308, headers: { location: 'https://elsewhere.test/' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const message = makeMessage(IDS, 4);
  await handleMessage(message, env);
  assert.deepEqual(seen, ['manual']);
  assert.equal(message.acked, false);
  assert.deepEqual(message.retried, { delaySeconds: 300 });
});

test('lease_lost (any callback 409) is retried, then reported with a null lease on the last attempt', async (t) => {
  const { env, bucket, queue } = makeEnv();
  const part = seedPart(bucket);
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerPart: () => ({ status: 409, json: { success: false, state: 'lease_lost' } }),
    photoBackupWorkerFail: () => ({ json: { state: 'failed' } }),
  });
  const first = makeMessage(IDS, 1);
  await handleMessage(first, env, { chunkBytes: 4096 });
  assert.equal(first.acked, false);
  assert.ok(first.retried);
  assert.ok(!calls.some((c) => c.action === 'photoBackupWorkerFail'));

  const last = makeMessage(IDS, 4);
  await handleMessage(last, env, { chunkBytes: 4096 });
  assert.equal(last.acked, true);
  assert.deepEqual(calls.at(-1).body, { ...IDS, leaseToken: null, code: 'LEASE_LOST', attempt: 4 });
  assert.equal(queue.sent.length, 0);
});

test('backend photos without file_size/mime_type use the real R2 size', async (t) => {
  const { env, bucket } = makeEnv();
  const part = seedPart(bucket);
  part.photos = part.photos.map(({ id, record_id, r2_key }) => ({ id, record_id, r2_key, file_size: null, mime_type: null, sizeBytes: null, maxBytes: 20971520 }));
  part.documents = [];
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerPart: () => ({ json: { state: 'part_recorded', remainingParts: 0 } }),
    photoBackupWorkerComplete: () => ({ json: { state: 'completed' } }),
  });
  const message = makeMessage();
  await handleMessage(message, env, { chunkBytes: 4096 });
  assert.equal(message.acked, true);
  const partCall = calls.find((c) => c.action === 'photoBackupWorkerPart');
  assert.equal(partCall.body.fileCount, 2)
  assert.equal(bucket.objects.get(PART_KEY).size, partCall.body.size);
});

function seedBundle(bucket, documents, name = 'bundle-0001.json') {
  const docs = documents.map(([docName, text]) => {
    const body = Buffer.from(text, 'utf8');
    return { name: docName, contentType: 'text/html', size: body.length, sha256: createHash('sha256').update(body).digest('hex'), bodyBase64: body.toString('base64') };
  });
  const body = Buffer.from(JSON.stringify({ format: 'bioskin-annual-document-bundle', version: 1, documents: docs }), 'utf8');
  const key = `${DOC_PREFIX}${name}`;
  bucket.put(key, new Uint8Array(body));
  return { type: 'bundle', key, name, size: body.length, documentCount: docs.length, sha256: createHash('sha256').update(body).digest('hex') };
}

test('backend document bundles are unpacked into sanitized documentos/ entries', async (t) => {
  const { env, bucket } = makeEnv();
  const part = seedPart(bucket);
  part.documents = [seedBundle(bucket, [['historias/paciente-1.html', '<p>ficticio</p>'], ['../LEAME.html', 'x'], ['LEAME.html', 'y']])];
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerPart: () => ({ json: { state: 'part_recorded', remainingParts: 0 } }),
    photoBackupWorkerComplete: () => ({ json: { state: 'completed' } }),
  });
  const message = makeMessage();
  await handleMessage(message, env, { chunkBytes: 4096 });
  assert.equal(message.acked, true);
  const reader = new ZipReader(new Uint8ArrayReader(bucket.objects.get(PART_KEY).data));
  const entries = await reader.getEntries();
  const names = entries.map((e) => e.filename);
  assert.ok(names.includes('documentos/historias/paciente-1.html'));
  assert.ok(names.includes('documentos/LEAME.html'));
  assert.ok(names.includes('documentos/2-LEAME.html'));
  assert.ok(!names.some((n) => n.includes('bundle-0001') || n.includes('..')));
  const html = entries.find((e) => e.filename === 'documentos/historias/paciente-1.html');
  assert.equal(new TextDecoder().decode(await html.getData(new Uint8ArrayWriter())), '<p>ficticio</p>');
  await reader.close();
  assert.equal(calls.find((c) => c.action === 'photoBackupWorkerPart').body.fileCount, 5);
});

test('tampered bundle fails permanently with a safe code and aborts the upload', async (t) => {
  const { env, bucket } = makeEnv();
  const part = seedPart(bucket);
  const bundle = seedBundle(bucket, [['a.html', 'ok']]);
  bundle.sha256 = '0'.repeat(64);
  part.documents = [bundle];
  const calls = mockBackend(t, {
    photoBackupWorkerClaim: claimed(part),
    photoBackupWorkerFail: () => ({ json: { state: 'failed' } }),
  });

  const message = makeMessage();
  await handleMessage(message, env, { chunkBytes: 4096 });
  assert.equal(message.acked, true);
  assert.equal(calls.at(-1).body.code, 'INVALID_CLAIM');
  assert.ok(!bucket.objects.has(PART_KEY));
});

test('hourly maintenance invokes only the authenticated service action with no clinical payload', async t => {
  const { env } = makeEnv();
  const calls = mockBackend(t, {
    photoBackupWorkerMaintenance: () => ({ json: { state: 'maintenance_done', snapshotsPurged: 1,
      sourcesDeleted: 2, artifactsDeleted: 1, failures: 0, partial: false } }),
  });
  await handleMaintenance(env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, `Bearer ${SECRET}`);
  assert.deepEqual(calls[0].body, {});
});

test('maintenance accepts explicitly disabled feature but surfaces partial cleanup', async t => {
  const { env } = makeEnv();
  let disabled = true;
  mockBackend(t, {
    photoBackupWorkerMaintenance: () => disabled
      ? { status: 503, json: { error: 'Respaldo anual no habilitado' } }
      : { json: { state: 'maintenance_done', failures: 1, partial: true } },
  });
  await handleMaintenance(env);
  disabled = false;
  await assert.rejects(handleMaintenance(env), error => error.code === 'CALLBACK_FAILED');
});