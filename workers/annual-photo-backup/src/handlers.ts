import { createHash, timingSafeEqual } from 'node:crypto';
import { buildPartArchive } from './archive.ts';
import type { ArchiveOptions } from './archive.ts';
import { MiB, WorkerError, isLeaseToken, parseJobIds, validatePart } from './claim.ts';
import type { JobIds } from './claim.ts';


// Leaves margin inside the 15 min queue-consumer wall clock for callbacks and multipart abort.
export const PART_DEADLINE_MS = 12 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 30_000;
const MAX_DISPATCH_BODY = 1024;
const MAX_CALLBACK_BODY = 2 * MiB;
const MIN_SECRET_LENGTH = 32;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'expired']);

type BackendReply = Record<string, unknown> & { state: string };

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function log(event: string, fields: object = {}): void {
  // IDs and error codes only; never photo keys, names or claim payloads.
  console.log(JSON.stringify({ event, ...fields }));
}

function configuredSecret(env: Env): string | null {
  const secret = env.ANNUAL_BACKUP_SERVICE_SECRET;
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

export function isAuthorized(header: string | null, secret: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  const given = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(given, expected);
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/dispatch') return json(404, { error: 'not_found' });
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });

  const secret = configuredSecret(env);
  if (!secret) {
    log('dispatch_misconfigured');
    return json(503, { error: 'not_configured' });
  }
  if (!isAuthorized(request.headers.get('authorization'), secret)) return json(401, { error: 'unauthorized' });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'unsupported_media_type' });
  }

  const text = await readLimited(request.body, MAX_DISPATCH_BODY);
  if (text === null) return json(413, { error: 'payload_too_large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const ids = parseJobIds(body);
  if (!ids) return json(400, { error: 'invalid_request' });

  await env.PHOTO_BACKUP_QUEUE.send(ids, { contentType: 'json' });
  log('dispatch_queued', ids);
  return json(202, { state: 'queued' });
}

function backendOrigin(value: string): string {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url.origin;
  } catch {
    // fall through
  }
  throw new WorkerError('CONFIG_MISSING', 'backend_url');
}

export async function callBackend(env: Env, action: string, payload: Record<string, unknown>,
  options: { timeoutMs?: number; allowDisabled?: boolean } = {}): Promise<BackendReply> {
  const secret = configuredSecret(env);
  if (!secret) throw new WorkerError('CONFIG_MISSING', 'secret');
  const endpoint = `${backendOrigin(env.BACKEND_BASE_URL)}/api/backup?action=${encodeURIComponent(action)}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? CALLBACK_TIMEOUT_MS),
    });
  } catch {
    throw new WorkerError('CALLBACK_FAILED', `${action}:network`);
  }
  if (response.status >= 300 && response.status < 400) {
    // Callbacks never follow redirects (secret would be re-sent); BACKEND_BASE_URL must be the final origin.
    await response.body?.cancel();
    throw new WorkerError('CONFIG_MISSING', `backend_redirect:${response.status}`);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new WorkerError('CALLBACK_UNAUTHORIZED', action);
  }
  if (response.status === 503 && options.allowDisabled) {
    const text = await readLimited(response.body, MAX_CALLBACK_BODY);
    if (text && JSON.parse(text).error === 'Respaldo anual no habilitado') return { state: 'disabled' };
    throw new WorkerError('CALLBACK_FAILED', `${action}:503`);
  }
  if (response.status !== 200 && response.status !== 409) {
    await response.body?.cancel();
    throw new WorkerError('CALLBACK_FAILED', `${action}:${response.status}`);
  }

  const text = await readLimited(response.body, MAX_CALLBACK_BODY);
  let reply: unknown;
  try {
    reply = text === null ? null : JSON.parse(text);
  } catch {
    reply = null;
  }
  const state = reply && typeof reply === 'object' ? (reply as Record<string, unknown>).state : undefined;
  if (typeof state !== 'string' || !/^[a-z_]{1,40}$/.test(state)) throw new WorkerError('CALLBACK_FAILED', `${action}:invalid_reply`);
  // Backend maps every callback 409 to lease_lost; never ack it: a fresh claim resumes and Part is idempotent.
  if (state === 'lease_lost') throw new WorkerError('LEASE_LOST', action);
  return reply as BackendReply;
}

export async function handleMaintenance(env: Env): Promise<void> {
  try {
    const result = await callBackend(env, 'photoBackupWorkerMaintenance', {}, { timeoutMs: 55_000, allowDisabled: true });
    if (result.state === 'disabled') {
      log('maintenance_disabled');
      return;
    }
    if (result.state !== 'maintenance_done') throw new WorkerError('CALLBACK_FAILED', 'maintenance_state');
    log('maintenance_done', {
      snapshotsPurged: result.snapshotsPurged, sourcesDeleted: result.sourcesDeleted,
      artifactsDeleted: result.artifactsDeleted, failures: result.failures, partial: result.partial,
    });
    if (result.failures || result.partial) throw new WorkerError('CALLBACK_FAILED', 'maintenance_partial');
  } catch (error) {
    log('maintenance_error', { code: error instanceof WorkerError ? error.code : 'INTERNAL_ERROR' });
    throw error;
  }
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 900);
}

function boundedSeconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 30), 900) : fallback;
}

export interface ConsumerOptions extends Partial<Omit<ArchiveOptions, 'deadline'>> {
  deadlineMs?: number;
}

async function completeJob(message: Message<unknown>, env: Env, ids: JobIds, leaseToken: string): Promise<void> {
  const done = await callBackend(env, 'photoBackupWorkerComplete', { ...ids, leaseToken });
  if (!TERMINAL_STATES.has(done.state)) throw new WorkerError('CALLBACK_FAILED', 'complete:unknown_state');
  log('job_completed', { ...ids, state: done.state });
  message.ack();
}

async function processJob(message: Message<unknown>, env: Env, ids: JobIds, options: ConsumerOptions, lease: { token: string | null }): Promise<void> {
  const claim = await callBackend(env, 'photoBackupWorkerClaim', { ...ids, attempt: message.attempts });

  if (TERMINAL_STATES.has(claim.state)) {
    log('job_skipped', { ...ids, state: claim.state });
    message.ack();
    return;
  }
  if (claim.state === 'leased') {
    log('job_leased_elsewhere', ids);
    message.retry({ delaySeconds: boundedSeconds(claim.retryAfterSeconds, 300) });
    return;
  }
  if (claim.state !== 'claimed' && claim.state !== 'ready_to_complete') {
    throw new WorkerError('CALLBACK_FAILED', 'claim:unknown_state');
  }
  if (!isLeaseToken(claim.leaseToken)) throw new WorkerError('INVALID_CLAIM', 'leaseToken');
  lease.token = claim.leaseToken;

  if (claim.state === 'ready_to_complete') {
    await completeJob(message, env, ids, lease.token);
    return;
  }

  if (!Array.isArray(claim.parts) || claim.parts.length === 0) throw new WorkerError('INVALID_CLAIM', 'parts');
  // Only the first pending part is processed per invocation to stay inside the 15 min wall clock.
  const part = validatePart(claim.parts[0], ids);
  const result = await buildPartArchive(env, ids, part, {
    ...options,
    deadline: Date.now() + (options.deadlineMs ?? PART_DEADLINE_MS),
  });
  const recorded = await callBackend(env, 'photoBackupWorkerPart', {
    ...ids,
    leaseToken: lease.token,
    index: part.index,
    key: part.key,
    size: result.size,
    sha256: result.sha256,
    fileCount: result.fileCount,
  });
  log('part_uploaded', { ...ids, index: part.index, size: result.size, fileCount: result.fileCount, state: recorded.state });

  if (recorded.state === 'part_recorded' && recorded.remainingParts === 0) {
    // Backend keeps the lease after the last part, so complete within this invocation.
    await completeJob(message, env, ids, lease.token);
    return;
  }
  if (recorded.state === 'part_recorded') {
    // Backend released the lease; the next pending part is claimed by a fresh invocation.
    // If publishing fails, redelivering this same message resumes from the next pending part (no duplicate).
    try {
      await env.PHOTO_BACKUP_QUEUE.send(ids, { contentType: 'json' });
    } catch {
      throw new WorkerError('QUEUE_PUBLISH_FAILED');
    }
    message.ack();
    return;
  }
  if (TERMINAL_STATES.has(recorded.state)) {
    message.ack();
    return;
  }
  throw new WorkerError('CALLBACK_FAILED', 'part:unknown_state');
}

export async function handleMessage(message: Message<unknown>, env: Env, options: ConsumerOptions = {}): Promise<void> {
  const ids = parseJobIds(message.body);
  if (!ids) {
    log('message_invalid');
    message.ack();
    return;
  }
  const lease = { token: null as string | null };
  try {
    await processJob(message, env, ids, options, lease);
  } catch (raw) {
    const error = raw instanceof WorkerError ? raw : new WorkerError('INTERNAL_ERROR');
    const maxAttempts = Number.parseInt(env.MAX_DELIVERY_ATTEMPTS, 10) || 4;
    log('job_error', { ...ids, code: error.code, attempt: message.attempts });

    // Auth/config problems cannot be reported to the backend, and a failed publish happens after the part was
    // persisted (job is healthy): retry, and past max_retries let the DLQ + backend re-dispatch resume it.
    if (error.code === 'CALLBACK_UNAUTHORIZED' || error.code === 'CONFIG_MISSING' || error.code === 'QUEUE_PUBLISH_FAILED') {
      message.retry({ delaySeconds: 300 });
      return;
    }
    if (error.retryable && message.attempts < maxAttempts) {
      message.retry({ delaySeconds: retryDelay(message.attempts) });
      return;
    }
    try {
      const failed = await callBackend(env, 'photoBackupWorkerFail', {
        ...ids,
        // A lost lease can no longer authorize Fail; backend accepts null when no lease is active.
        leaseToken: error.code === 'LEASE_LOST' ? null : lease.token,
        code: error.code,
        attempt: message.attempts,
      });
      log('job_failed', { ...ids, code: error.code, state: failed.state });
      message.ack();
    } catch {
      message.retry({ delaySeconds: retryDelay(message.attempts) });
    }
  }
}

export async function handleBatch(batch: MessageBatch<unknown>, env: Env, options: ConsumerOptions = {}): Promise<void> {
  for (const message of batch.messages) await handleMessage(message, env, options);
}