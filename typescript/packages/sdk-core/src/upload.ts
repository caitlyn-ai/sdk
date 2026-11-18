// A hand-built ingestion batch's two steps that have a cost (PROTOCOL.md 15): batch.upload.estimate prices the items
// that need bytes (EstimateIngestion, in parts of 10,000), and batch.upload sends them, as form POSTs under the batch's
// upload policy (6 at once, renewing the policy, CompleteIngestionBatchUploads at most 100 a call, one more upload
// after a CHECKSUM_MISMATCH). kb.ingestion.sync is built on the same two functions, priceDocuments and uploadItems.
// Neither hashes a file: an estimate describes it by name, content type and size, and an upload sends the batch
// item's checksum with the bytes, so storage refuses any other bytes.
import { openFile, sendToStorage, urlSafeBase64, type FileInput, type PreparedFile, type SendOptions, type ToError } from './files.js';
import { describeFile, isUploadDescription, type UploadDescription } from './describe.js';
import type { WaitOptions } from './scope.js';
import { SpanKind, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

/**
 * The form fields an upload sends itself after the policy's (PROTOCOL.md 15, step 6). A policy's own copy of one is
 * left out, compared without regard to case as storage compares form field names, so no field is sent twice.
 */
const OWN_FORM_FIELDS: ReadonlySet<string> = new Set(['key', 'content-type', 'x-amz-checksum-algorithm', 'x-amz-checksum-sha256', 'file']);

type Json = Record<string, any>;

/** Sends one operation (its Command input, If-Match and idempotency key included) through the client. */
export type IngestCall = (operation: string, input: Json, signal?: AbortSignal) => Promise<Json>;

/**
 * An ingestion's progress, shared by sync and a batch's upload. `checksum` counts files hashed; `upload` counts bytes
 * sent; `planning` and `planned` come from the batch (`counts` holds its counts by outcome once planned); `queued`
 * counts uploads handed to ingestion; `processing` counts items in a final status; the final phase is the batch's
 * final status.
 */
export interface IngestionProgress {
  phase: 'checksum' | 'upload' | 'planning' | 'planned' | 'queued' | 'processing' | (string & {});
  done: number;
  total: number;
  item?: Json;
  counts?: Json;
}

/** What the batch helpers need from the client: its calls, and a batch's planned() and wait(). */
export interface BatchDeps {
  call: IngestCall;
  toError: ToError;
  tracer?: Tracer;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  /** The client's storage stall timeout (SendOptions.stallTimeoutMs). */
  stallTimeoutMs?: number;
  /** The batch's planned(): the batch once it is planned or past it; raises its failure when planning failed it. */
  planned: (batchId: string, options: WaitOptions) => Promise<Json>;
}

/** The files of a batch's items: by the item's path (`/hr/leave.pdf`, or without its leading `/`), or a function of the item. */
export type BatchFiles<F = FileInput, I = Json> = Record<string, F> | Map<string, F> | ((item: I) => F | undefined);

export interface BatchUploadOptions<I = Json> {
  /** Uploads at once. Default 6. */
  concurrency?: number;
  onProgress?: (progress: IngestionProgress) => void;
  /** Called for each item that ends during the call: an upload that failed (UPLOAD_FAILED, FILE_CHANGED, CHECKSUM_MISMATCH). */
  onItem?: (item: I) => void;
  signal?: AbortSignal;
}

/** What awaiting batch.upload(files) gives. */
export interface BatchUpload<B = Json, I = Json> {
  /** The batch as it stood when the call ended. */
  batch: B;
  /** One for each item this call dealt with: `ingesting` once accepted, `failed` with its failureCode when not. */
  items: I[];
  /** The paths of items awaiting upload that were given no file: they are left awaiting upload. */
  notGiven: string[];
  /** The given paths that matched no item awaiting upload: nothing was sent for them. */
  unmatched: string[];
}

export const NEEDS_BYTES = new Set(['add', 'new_version', 'overwrite']);
export const FINAL_ITEM = new Set(['indexed', 'skipped', 'moved', 'updated', 'removed', 'failed', 'cancelled']);
const FINAL_BATCH = new Set(['succeeded', 'completed_with_failures', 'failed', 'cancelled']);
const ESTIMATE_PER_CALL = 10_000;
const COMPLETE_PER_CALL = 100;
const RENEW_BEFORE_MS = 5 * 60_000;
/** The keep-alive renews at most this often, so a policy that is already short cannot loop. */
const KEEP_ALIVE_FLOOR_MS = 1_000;

/** Runs `fn` over `items`, at most `limit` at once, stopping new work once `signal` aborts. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const queue = [...items];
  let failure: unknown;
  const worker = async () => {
    while (queue.length && failure === undefined && !signal?.aborted) {
      try {
        await fn(queue.shift()!);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (signal?.aborted) throw signal.reason;
  if (failure !== undefined) throw failure;
}

export async function listAll(call: IngestCall, operation: string, input: Json, key: string, signal?: AbortSignal): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(operation, { ...input, ...(cursor ? { cursor } : {}) }, signal);
    out.push(...(page[key] ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * Estimates of parts of one set of documents, added together (sync.estimate-many): the counts summed, the low and high
 * ends of durationSeconds and of cost summed, cost only when every part has one, and no details.
 */
export function sumEstimates(parts: Json[]): Json {
  const sum = (get: (p: Json) => number | undefined) => parts.reduce((n, p) => n + (get(p) ?? 0), 0);
  // Cost is a decimal amount in its unit, rounded to a millionth so that 0.1 + 0.2 reads 0.3.
  const range = (key: string, round = (n: number) => n) => ({ low: round(sum((p) => p[key]?.low)), high: round(sum((p) => p[key]?.high)) });
  const total: Json = {};
  for (const key of ['documents', 'pages', 'mediaSeconds', 'documentsOfUnknownLength']) if (parts.some((p) => p[key] !== undefined)) total[key] = sum((p) => p[key]);
  if (parts.some((p) => p.durationSeconds)) total.durationSeconds = range('durationSeconds');
  if (parts.every((p) => p.cost)) total.cost = { ...range('cost', (n) => Math.round(n * 1e6) / 1e6), unit: parts[0].cost.unit };
  return total;
}

/**
 * Prices documents with EstimateIngestion, at most `limit` (10,000) a call, in order, and adds the parts up. Undefined
 * when there is nothing to price: no call is sent.
 */
export async function priceDocuments(call: IngestCall, knowledgeBaseId: string, documents: Json[], limit = ESTIMATE_PER_CALL, signal?: AbortSignal): Promise<Json | undefined> {
  if (!documents.length) return undefined;
  const parts: Json[] = [];
  for (let at = 0; at < documents.length; at += limit) parts.push(await call('EstimateIngestion', { knowledgeBaseId, documents: documents.slice(at, at + limit) }, signal));
  return parts.length === 1 ? parts[0] : sumEstimates(parts);
}

/** A key of `files` as the batch stores paths: with its leading `/`. */
const asPath = (key: string) => (key.startsWith('/') ? key : `/${key}`);

/** The file given for an item, and the given paths, from a map or a function. */
function fileLookup<F>(files: BatchFiles<F, any> | undefined): { fileFor: (item: Json) => F | undefined; keys: string[] } {
  if (!files) return { fileFor: () => undefined, keys: [] };
  if (typeof files === 'function') return { fileFor: (item) => files(item) ?? undefined, keys: [] };
  const entries: [string, F][] = files instanceof Map ? [...files.entries()] : Object.entries(files);
  const byPath = new Map(entries.map(([k, v]) => [asPath(k), v]));
  return { fileFor: (item) => (item.path ? byPath.get(item.path) : undefined), keys: [...byPath.keys()] };
}

/**
 * Whether an item could need its bytes (sync.estimate-unresolved): resolved add, new_version or overwrite, or still
 * unresolved with an outcome that could take bytes (new, changed or a conflict). An estimate prices these, as the most
 * the batch could cost; items resolved skip, remove, move or update are not priced.
 */
export const couldNeedBytes = (item: Json) => NEEDS_BYTES.has(item.resolution) || (item.resolution === 'unresolved' && ['new', 'changed', 'conflict'].includes(item.outcome));

/** What a batch's estimate prices: the items that could need bytes and whose bytes have not arrived (draft or awaiting upload). */
const toPrice = (items: Json[]) => items.filter((i) => couldNeedBytes(i) && (i.status === 'draft' || i.status === 'awaiting_upload'));

/** The estimate of nothing: no document, no time and no cost. */
const EMPTY_ESTIMATE = { documents: 0, durationSeconds: { low: 0, high: 0 } };

/**
 * batch.upload.estimate(files?): what uploading the batch's file items would take and cost. A draft batch is refused
 * (INGESTION_BATCH_NOT_PLANNED, nothing sent); a planning one is waited on. Each document is its matched file's name,
 * content type and size, with the hints the caller gave it, or without files the item's own; nothing is read or hashed.
 */
export async function estimateUpload(
  deps: BatchDeps,
  knowledgeBaseId: string,
  batchId: string,
  files?: BatchFiles<FileInput | UploadDescription>,
  options: WaitOptions = {},
): Promise<Json> {
  const { call, toError } = deps;
  // The documents a call takes: 10,000, smaller only in tests, through a per-call option the types do not show.
  const { estimatePerCall, ...wait } = options as WaitOptions & { estimatePerCall?: number };
  const signal = wait.signal;
  let batch = await call('GetIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }, signal);
  if (batch.status === 'draft') {
    throw toError({
      status: 0,
      code: 'INGESTION_BATCH_NOT_PLANNED',
      title: 'The ingestion batch is not planned yet',
      detail: `Ingestion batch ${batchId} is a draft: add its last items (last: true) so that it is planned, then estimate its upload.`,
      ingestionBatchId: batchId,
    });
  }
  if (batch.status === 'planning') batch = await deps.planned(batchId, wait);
  if (FINAL_BATCH.has(batch.status)) return { ...EMPTY_ESTIMATE };
  const items = toPrice(await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, limit: 1000 }, 'items', signal));
  const { fileFor } = fileLookup(files);
  const documents = await Promise.all(
    items.map(async (item) => {
      const file = fileFor(item);
      if (file !== undefined) return isUploadDescription(file) ? file : describeFile(file, toError, signal);
      return { name: String(item.path ?? '').split('/').pop() || item.id, contentType: item.contentType, byteSize: item.byteSize };
    }),
  );
  const estimate = await priceDocuments(call, knowledgeBaseId, documents, estimatePerCall, signal);
  return estimate ?? { ...EMPTY_ESTIMATE };
}

/** The bytes to send for one item, opened when its turn comes. */
export interface UploadSource {
  file: PreparedFile;
  /** The checksum the form carries: the batch item's (standard base64). */
  sha256: string;
}

export interface UploadItemsOptions {
  /** The upload policy Start returned, if any. */
  policy?: Json;
  concurrency?: number;
  signal?: AbortSignal;
  send: SendOptions;
  progress?: (p: IngestionProgress) => void;
  /** An item that ended here: a failed upload, with its failureCode and failureDetail. */
  onFailed: (item: Json) => void;
  /** An item Complete accepted: it is `ingesting` now. */
  onAccepted?: (item: Json) => void;
}

/**
 * Uploads the given items (PROTOCOL.md 15, sync's step 6): at most `concurrency` at once, each a form POST under the
 * batch's upload policy, renewed when less than its renewal margin remains and once after a 403 that says it expired; accepted
 * uploads reported with CompleteIngestionBatchUploads at most 100 a call, a CHECKSUM_MISMATCH uploaded once more. One
 * item's failure is its own: the others carry on, and only cancellation or a failed renewal stops them.
 */
export async function uploadItems(
  deps: BatchDeps,
  knowledgeBaseId: string,
  batchId: string,
  items: Json[],
  open: (item: Json) => Promise<UploadSource>,
  options: UploadItemsOptions,
): Promise<{ accepted: Json[]; failed: Json[] }> {
  const { call } = deps;
  const { signal } = options;
  const accepted: Json[] = [];
  const failed: Json[] = [];
  if (!items.length) return { accepted, failed };
  // A policy the server did not give is UPLOAD_POLICY_MISSING (PROTOCOL.md 6.3), not a failure further on.
  const newPolicy = async (): Promise<Json> => {
    const p = (await call('CreateIngestionBatchUploadPolicy', { knowledgeBaseId, ingestionBatchId: batchId }, signal)).uploadPolicy as Json | undefined;
    if (!p) throw deps.toError({ status: 0, code: 'UPLOAD_POLICY_MISSING', title: 'No upload policy', detail: `CreateIngestionBatchUploadPolicy returned no upload policy for batch ${batchId}.` });
    return p;
  };
  let policy: Json | undefined = options.policy ?? (await newPolicy());
  /** When the policy in hand arrived: its lifetime, for the renewal margin, runs from here to its expiresAt. */
  let policyReceived = Date.now();
  let generation = 0;
  let renewing: Promise<void> | undefined;
  /** When the last renewal ended, whoever asked for it: the keep-alive's once-a-second floor counts from it. */
  let lastRenewal = 0;
  const renew = async (from: number) => {
    if (generation !== from) return;
    renewing ??= (async () => {
      policy = await newPolicy();
      policyReceived = Date.now();
      generation++;
    })().finally(() => {
      renewing = undefined;
      lastRenewal = Date.now();
    });
    await renewing;
  };
  /**
   * Milliseconds the policy has left. A policy whose `expiresAt` is missing or cannot be read as a time
   * (PROTOCOL.md 15) counts as due now: it is renewed before each upload starts, and the keep-alive timer is not armed
   * for it, so uploads keep working against a server that sends a bad value, and nothing loops.
   */
  const expiresIn = () => {
    const at = policy!.expiresAt;
    const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : NaN;
    return Number.isNaN(ms) ? -Infinity : ms - Date.now();
  };
  const unreadableExpiry = () => expiresIn() === -Infinity;
  /**
   * How long before its expiresAt the policy is renewed (PROTOCOL.md 15): 5 minutes, or half its lifetime (from when
   * it arrived to its expiresAt) when that is shorter, so a batch with a short uploadWindowSeconds renews partway
   * through each policy rather than at once and then once a second.
   */
  const margin = () => {
    const left = expiresIn();
    if (left === -Infinity) return RENEW_BEFORE_MS;
    return Math.min(RENEW_BEFORE_MS, Math.max(0, left + Date.now() - policyReceived) / 2);
  };
  // The keep-alive (PROTOCOL.md 15): while any upload is in flight, the policy is renewed on a timer once it has less
  // than its renewal margin left, at most once a second, as the server judges each file by when its bytes arrive against the
  // batch's uploadsExpireAt, which a renewal moves on. A renewal that fails leaves the uploads in flight on the policy
  // they have, and is tried again at the next tick. The timer stops when the last upload in flight settles, and when the
  // call ends, however it ends.
  let sending = 0;
  let keepAlive: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const arm = () => {
    clearTimeout(keepAlive);
    keepAlive = undefined;
    if (ended || sending === 0 || signal?.aborted || unreadableExpiry()) return;
    const wait = Math.max(expiresIn() - margin(), lastRenewal + KEEP_ALIVE_FLOOR_MS - Date.now(), 0);
    keepAlive = setTimeout(async () => {
      keepAlive = undefined;
      if (ended || sending === 0 || signal?.aborted) return;
      // A renewal in flight, or one that ended less than a second ago, whoever asked for it, is this tick's: it re-arms
      // from the policy as it then stands.
      if (renewing) {
        await renewing.catch(() => {});
        return arm();
      }
      if (Date.now() - lastRenewal < KEEP_ALIVE_FLOOR_MS) return arm();
      try {
        if (expiresIn() < margin()) await renew(generation);
      } catch {
        // The policy in hand is valid until it expires: the next tick tries again.
      }
      arm();
    }, wait);
  };
  const totalBytes = items.reduce((n, it) => n + (it.byteSize ?? 0), 0);
  let sentBytes = 0;
  // Each item's steps (PROTOCOL.md 13): a `caitlyn.batch.item` span per item, with an event for each step, through the
  // client's tracer; nothing when telemetry is off. The span ends when the item is completed or fails.
  const spans = new Map<string, Span>();
  const step = (item: Json, name: string, attributes: Record<string, string | number> = {}) => {
    if (!deps.tracer) return;
    let span = spans.get(item.id);
    if (!span) {
      span = deps.tracer.startSpan('caitlyn.batch.item', {
        kind: SpanKind.INTERNAL,
        attributes: { 'caitlyn.ingestion_batch.id': batchId, 'caitlyn.ingestion_batch.item.id': String(item.id), 'caitlyn.ingestion_batch.item.path': String(item.path ?? '') },
      });
      spans.set(item.id, span);
    }
    span.addEvent(name, attributes);
    if (name === 'completed' || name === 'failed') {
      if (name === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: String(attributes['caitlyn.error.code'] ?? '') });
      span.end();
      spans.delete(item.id);
    }
  };
  const fail = (item: Json, code: string, detail: string) => {
    const f = { ...item, status: 'failed', failureCode: code, failureDetail: detail };
    failed.push(f);
    step(item, 'failed', { 'caitlyn.error.code': code });
    options.onFailed(f);
  };
  const opened = new Map<string, UploadSource>();
  /** Sends one file; false when its item failed. */
  const upload = async (item: Json): Promise<boolean> => {
    let source = opened.get(item.id);
    if (!source) {
      try {
        source = await open(item);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        fail(item, (err as { code?: string }).code ?? 'UPLOAD_FAILED', (err as Error).message);
        return false;
      }
      opened.set(item.id, source);
      step(item, 'opened', { 'caitlyn.file.byte_size': source.file.byteSize });
    }
    const local = source.file;
    // A file whose size is not the item's is not the file the item describes: FILE_CHANGED, with nothing sent.
    if (item.byteSize !== undefined && local.byteSize !== item.byteSize) {
      fail(item, 'FILE_CHANGED', `${item.path}: the file is ${local.byteSize} bytes, but the batch item is ${item.byteSize}; nothing was sent.`);
      return false;
    }
    sending++;
    if (sending === 1) arm();
    try {
      return await send(item, source, local);
    } finally {
      if (--sending === 0) arm();
    }
  };
  /** One file's sends: again once after a 403 that says the policy expired. */
  const send = async (item: Json, source: UploadSource, local: PreparedFile): Promise<boolean> => {
    for (let expiredOnce = false; ; ) {
      // A renewal the keep-alive started that failed is not this upload's failure: it renews for itself below.
      if (renewing) await renewing.catch(() => {});
      if (expiresIn() < margin()) await renew(generation);
      try {
        await local.check();
        step(item, 'checked');
      } catch (err) {
        fail(item, (err as { code?: string }).code ?? 'FILE_CHANGED', (err as Error).message);
        return false;
      }
      const used = generation;
      const p = policy!;
      step(item, 'sending', { 'server.address': (() => { try { return new URL(String(p.uploadUrl)).hostname; } catch { return ''; } })() });
      let res: Response;
      try {
        res = await sendToStorage(
          p.uploadUrl,
          () => {
            const form = new FormData();
            // The policy's fields, less any the SDK sends itself: storage refuses a form that repeats a field.
            for (const [k, v] of Object.entries(p.formFields as Record<string, string>)) if (!OWN_FORM_FIELDS.has(k.toLowerCase())) form.append(k, v);
            form.append('key', item.objectKey ?? `${p.keyPrefix}${urlSafeBase64(source!.sha256)}`);
            form.append('Content-Type', local.contentType);
            form.append('x-amz-checksum-algorithm', 'SHA256');
            form.append('x-amz-checksum-sha256', source!.sha256);
            form.append('file', local.blob, local.name);
            return { method: 'POST', body: form };
          },
          options.send,
        );
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        fail(item, 'UPLOAD_FAILED', `${item.path}: no response from storage: ${(err as Error)?.message ?? err}`);
        return false;
      }
      step(item, 'sent', { 'http.response.status_code': res.status });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        break;
      }
      const text = await res.text();
      if (res.status === 403 && /expired/i.test(text) && !expiredOnce) {
        expiredOnce = true;
        await renew(used);
        continue;
      }
      // Storage refused the bytes for the item's checksum: they are not the bytes the item describes. Sending them
      // again cannot succeed, so this is FILE_CHANGED, with no retry.
      if (res.status === 400 && /BadDigest|checksum/i.test(text)) {
        fail(item, 'FILE_CHANGED', `${item.path}: the bytes are not those the batch item describes (storage answered ${res.status}: ${text})`);
        return false;
      }
      fail(item, 'UPLOAD_FAILED', `${item.path}: storage answered ${res.status}: ${text}`);
      return false;
    }
    sentBytes += local.byteSize;
    options.progress?.({ phase: 'upload', done: sentBytes, total: totalBytes, item });
    return true;
  };

  // Uploads are reported as they finish: whenever no CompleteIngestionBatchUploads is under way, the ones waiting go,
  // at most 100 a call.
  const retried = new Set<string>();
  const pending: Json[] = [];
  let inFlight: Promise<void> | undefined;
  let completeFailure: unknown;
  const queue: Json[] = [...items];
  const flush = async (batch: Json[]) => {
    const r = await call('CompleteIngestionBatchUploads', { knowledgeBaseId, ingestionBatchId: batchId, itemIds: batch.map((i) => i.id) }, signal);
    for (const result of r.results as Json[]) {
      const item = batch.find((i) => i.id === result.itemId)!;
      if (result.status === 'accepted') {
        step(item, 'completed', { 'caitlyn.ingestion_batch.item.status': 'accepted' });
        const a = { ...item, status: 'ingesting' };
        accepted.push(a);
        options.onAccepted?.(a);
      } else if (result.code === 'CHECKSUM_MISMATCH' && !retried.has(item.id)) {
        step(item, 'retrying', { 'caitlyn.error.code': result.code });
        retried.add(item.id);
        queue.push(item);
      } else fail(item, result.code, result.detail);
    }
    // After each Complete call: the uploads handed to ingestion so far, of the items this call uploads.
    options.progress?.({ phase: 'queued', done: accepted.length, total: items.length });
  };
  const pump = () => {
    if (inFlight || !pending.length || completeFailure !== undefined) return;
    inFlight = flush(pending.splice(0, COMPLETE_PER_CALL))
      .catch((err) => void (completeFailure ??= err))
      .finally(() => {
        inFlight = undefined;
        pump();
      });
  };
  try {
    // Each round uploads what is queued; a CHECKSUM_MISMATCH puts an item back for one more round.
    while (queue.length) {
      const round = queue.splice(0);
      await pool(round, options.concurrency ?? 6, async (item) => {
        if (!(await upload(item))) return;
        pending.push(item);
        pump();
      }, signal);
      while (inFlight || (pending.length && completeFailure === undefined)) {
        pump();
        await inFlight;
      }
      if (signal?.aborted) throw signal.reason;
      if (completeFailure !== undefined) throw completeFailure;
    }
  } finally {
    ended = true;
    clearTimeout(keepAlive);
    // Items the call left unfinished (cancelled, or stopped by a Complete that failed): their spans end with it.
    for (const span of spans.values()) span.end();
    await Promise.all([...opened.values()].map((s) => s.file.dispose()));
  }
  return { accepted, failed };
}

/**
 * batch.upload(files, options): sends the batch's items awaiting upload that were given a file. The batch must be
 * running: a when_planned batch still planning is followed until it is; one not started is refused
 * (INGESTION_BATCH_NOT_STARTED, nothing sent). An item with no file is left awaiting upload (notGiven), and a given
 * path that matches no item awaiting upload is listed in unmatched. Cancelling stops the uploads and leaves the batch.
 */
export async function batchUpload(deps: BatchDeps, knowledgeBaseId: string, batchId: string, files: BatchFiles, options: BatchUploadOptions = {}): Promise<BatchUpload> {
  const { call, toError } = deps;
  const { signal } = options;
  const notStarted = (status: string, detail: string) =>
    toError({ status: 0, code: 'INGESTION_BATCH_NOT_STARTED', title: 'The ingestion batch is not started', detail: `Ingestion batch ${batchId} is ${status}: ${detail}`, ingestionBatchId: batchId });
  let batch = await call('GetIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }, signal);
  if (batch.status === 'planning' && batch.start === 'when_planned') batch = await deps.planned(batchId, { signal });
  if (batch.status === 'planned' && batch.start === 'when_planned') batch = await call('GetIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }, signal);
  const { fileFor, keys } = fileLookup(files);
  if (FINAL_BATCH.has(batch.status)) return { batch, items: [], notGiven: [], unmatched: keys };
  if (batch.status !== 'running') {
    throw notStarted(batch.status, batch.start === 'when_planned' && batch.status === 'planned'
      ? 'it stopped at planned with items unresolved. Resolve them, then start it with batch.start().'
      : 'start it with batch.start(), then upload its files.');
  }
  const awaiting = await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, status: 'awaiting_upload', limit: 1000 }, 'items', signal);
  const given = new Map<string, FileInput>();
  const notGiven: string[] = [];
  for (const item of awaiting) {
    const file = fileFor(item);
    if (file === undefined) notGiven.push(item.path);
    else given.set(item.id, file);
  }
  const awaitingPaths = new Set(awaiting.map((i) => i.path));
  const unmatched = keys.filter((k) => !awaitingPaths.has(k));
  const { accepted, failed } = await uploadItems(
    deps,
    knowledgeBaseId,
    batchId,
    awaiting.filter((i) => given.has(i.id)),
    async (item) => ({ file: await openFile(given.get(item.id)!, toError, signal), sha256: item.sha256 }),
    {
      concurrency: options.concurrency,
      signal,
      send: { signal, tracer: deps.tracer, maxAttempts: deps.maxAttempts, maxRetryDelayMs: deps.maxRetryDelayMs, stallTimeoutMs: deps.stallTimeoutMs },
      progress: options.onProgress,
      onFailed: (item) => options.onItem?.(item),
    },
  );
  const ended = await call('GetIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }, signal);
  return { batch: ended, items: [...accepted, ...failed], notGiven, unmatched };
}
