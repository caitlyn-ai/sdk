// kb.ingestion.sync (PROTOCOL.md 15): keeps a knowledge base in step with a folder of files, or a list of items,
// through one ingestion batch, in the protocol's order: hash; create (`start: manual`, 10,000 items a call, the last
// call `last: true`); wait with the batch's planned(); price the items that need bytes (EstimateIngestion); resolve
// (confirm, the resolver); Start with the plan's ETag; upload each awaiting item as a form POST under the batch's
// upload policy (6 at once, renewing the policy, reporting uploads 100 at a time); wait with the batch's wait(); list
// the items for the report. sync.estimate runs the first three steps and returns the plan, uploading nothing.
//
// Pricing and uploading are the batch's own helpers (./upload.ts: priceDocuments and uploadItems, which
// batch.upload.estimate and batch.upload are built on too); sync adds the hashing, the batch and the report.
//
// The generated SDK supplies `call`, which sends one operation by name through the client (so the helper uses the
// client's sign-in, retries and telemetry), and the batch's planned() and wait(), which follow its watch.
import { prepareFile, type FileInput, type PreparedFile } from './files.js';
import { readTextFile, walkDirectory, joinPath } from './files-node.js';
import type { WaitOptions } from './scope.js';
import { FINAL_ITEM, couldNeedBytes, listAll, pool, priceDocuments, uploadItems, type BatchDeps, type IngestionProgress } from './upload.js';

export type { IngestCall, IngestionProgress } from './upload.js';

type Json = Record<string, any>;

/** One file of the source, as the caller's functions see it. */
export interface LocalFile {
  /** The path below the source folder, with `/` (for a list of items, the item's own `path`). */
  relativePath: string;
  /** The document path it is ingested at: the target folder plus relativePath. */
  path: string;
  name: string;
  byteSize: number;
  contentType: string;
  /** Standard base64. */
  sha256: string;
}

/** An item of a list given in place of a folder. */
export interface SyncItemInput {
  /** The path below the target folder, with `/`: `leave/annual.pdf`. */
  path: string;
  file: FileInput;
  externalId?: string;
  sourceUrl?: string;
  metadata?: Json;
}

/** A phase of an ingestion's progress. */
export type SyncPhase = IngestionProgress['phase'];

/**
 * The plan: the planned batch, every item with its outcome, and what uploading the items that need bytes would take
 * and cost (EstimateIngestion; absent when no item needs bytes). What `confirm` sees, and what sync.estimate returns.
 */
export interface SyncPlan {
  batch: Json;
  items: Json[];
  estimate?: Json;
  /**
   * Why there is no estimate, when EstimateIngestion failed: the typed error it raised. Only `confirm` sees it, and
   * decides whether to go on without an estimate; sync.estimate raises the error instead (PROTOCOL.md 15).
   */
  estimateError?: Error;
}

export interface SyncOptions {
  /** The folder the files go into, starting and ending in `/`. Default `/`. */
  folder?: string;
  /** Globs over relative paths (`**`, `*`, `?`): only matching files are ingested. */
  include?: string[];
  /** Globs over relative paths that are left out, as are the patterns in the folder's .caitlynignore. */
  exclude?: string[];
  /** The batch's rules (IngestionPolicy). */
  policy?: Json;
  /**
   * How long, in seconds, the batch waits for its files once it starts: each upload policy lasts this long, and an
   * item whose bytes have not arrived soon after the last one expires fails. The server's default (30 minutes) when
   * not given; a short window suits a test or a small batch sent at once.
   */
  uploadWindowSeconds?: number;
  externalId?: (file: LocalFile) => string | undefined;
  sourceUrl?: (file: LocalFile) => string | undefined;
  metadata?: (file: LocalFile) => Json | undefined;
  /** Remove each document under the folder that has no file. */
  removeMissing?: boolean;
  /** Called with the plan and its estimate; false cancels the batch and raises CANCELLED (status 0), with the report so far. */
  confirm?: (plan: SyncPlan) => boolean | Promise<boolean>;
  /**
   * Resolves an item the policy left `unresolved` (`add`, `new_version`, `overwrite`, `skip`, …). Without a resolver,
   * or when it returns nothing for an item, the call fails with INGESTION_BATCH_UNRESOLVED and the batch is left
   * planned.
   */
  resolve?: (item: Json, plan: SyncPlan) => string | undefined | Promise<string | undefined>;
  onProgress?: (progress: IngestionProgress) => void;
  /**
   * Called once for each item, when it ends: at Start for one that needs no bytes (skipped, removed, moved, updated),
   * at once for an upload that failed here, else when the final listing finds it (indexed, failed or cancelled).
   */
  onItem?: (item: Json) => void;
  /** Uploads at once. Default 6. */
  concurrency?: number;
  signal?: AbortSignal;
  /** On cancellation, also cancel the batch, stopping ingestion already running. */
  cancelIngestion?: boolean;
  /** Time limits for the waits for the plan and for the end (none by default). */
  wait?: Omit<WaitOptions, 'signal'>;
}

/** An item of a sync's report: the item as ListIngestionBatchItems lists it, with its last status. */
export interface SyncReportItem {
  id: string;
  action?: string;
  path?: string;
  externalId?: string;
  sha256?: string;
  byteSize?: number;
  contentType?: string;
  outcome?: string;
  reason?: string;
  resolution?: string;
  status: string;
  documentId?: string;
  version?: number;
  failureCode?: string;
  failureDetail?: string;
  etag?: string;
}

/** The batch of a sync's report: the batch as GetIngestionBatch reads it, with its status and counts. */
export interface SyncReportBatch {
  id: string;
  status: string;
  itemCount?: number;
  counts?: { byOutcome?: Partial<Record<string, number>>; byStatus?: Partial<Record<string, number>> };
  etag?: string;
}

/**
 * What sync() returns, and what its cancellation's or declined confirm's error carries as `report`
 * (PROTOCOL 15, sync.report-shape): the batch as reading it gives it, and every item as listing the batch's items gives it.
 * The generated client narrows both to the model's types.
 */
export interface SyncReport<B extends SyncReportBatch = SyncReportBatch, I extends SyncReportItem = SyncReportItem> {
  batch: B;
  items: I[];
}

/** True for the error a sync raises when its signal aborts: the platform's AbortError, carrying the report so far. */
export function isSyncAborted(err: unknown): err is Error & { name: 'AbortError'; report: SyncReport } {
  return (err as Json | undefined)?.name === 'AbortError' && !!(err as Json).report;
}

export interface SyncDeps extends BatchDeps {
  /** The batch's wait(), calling `onBatch` with the batch each time its watch shows it. */
  finished: (batchId: string, onBatch: (batch: Json) => void, options: WaitOptions) => Promise<Json>;
  /** A file as an estimate describes it (UploadDescription): name, content type and size; never hashed. */
  describe: (file: PreparedFile) => Promise<Json>;
}

const ITEMS_PER_CALL = 10_000;

/** A glob as a regular expression over a `/`-separated path: `**` crosses folders, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** .caitlynignore lines (as .gitignore, simply): a pattern with no `/` matches a name at any depth; `dir/` a folder. */
function ignorePatterns(text: string | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const dir = line.endsWith('/');
    const p = line.replace(/^\/|\/$/g, '');
    const anchored = line.includes('/') && !(dir && !p.includes('/'));
    const body = globToRegExp(p).source.slice(1, -1);
    out.push(new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${dir ? '/.*' : '(?:/.*)?'}$`));
  }
  return out;
}

function normaliseFolder(folder = '/'): string {
  let f = folder.startsWith('/') ? folder : `/${folder}`;
  if (!f.endsWith('/')) f += '/';
  return f;
}

interface Local {
  file: LocalFile;
  prepared: PreparedFile;
  input: FileInput;
}

/** kb.ingestion.sync(folderOrItems, options): see the module comment. */
export function sync(deps: SyncDeps, knowledgeBaseId: string, source: string | SyncItemInput[], options: SyncOptions = {}): Promise<SyncReport> {
  return run(deps, knowledgeBaseId, source, options, false) as Promise<SyncReport>;
}

/** kb.ingestion.sync.estimate(folderOrItems, options): steps 1 to 3 (hash, create, plan and price), uploading nothing. */
export function estimateSync(deps: SyncDeps, knowledgeBaseId: string, source: string | SyncItemInput[], options: SyncOptions = {}): Promise<SyncPlan> {
  return run(deps, knowledgeBaseId, source, options, true) as Promise<SyncPlan>;
}

async function run(deps: SyncDeps, knowledgeBaseId: string, source: string | SyncItemInput[], options: SyncOptions, planOnly: boolean): Promise<SyncReport | SyncPlan> {
  const { call, toError } = deps;
  const signal = options.signal;
  const folder = normaliseFolder(options.folder);
  const progress = (p: IngestionProgress) => options.onProgress?.(p);
  const reported = new Set<string>();
  // Each item's last known status, and the batch as last seen: the report a cancellation carries (sync.cancel-report).
  const known = new Map<string, Json>();
  let lastBatch: Json | undefined;
  const note = (item: Json) => void known.set(item.id, item);
  const report = (item: Json) => {
    note(item);
    if (reported.has(item.id)) return;
    reported.add(item.id);
    options.onItem?.(item);
  };
  const locals: Local[] = [];
  let batchId: string | undefined;
  try {
    // 1. Hash
    const entries: { relativePath: string; file: FileInput; item?: SyncItemInput }[] = [];
    if (typeof source === 'string') {
      const include = (options.include ?? []).map(globToRegExp);
      const exclude = [...(options.exclude ?? []).map(globToRegExp), ...ignorePatterns(await readTextFile(joinPath(source, '.caitlynignore')))];
      for (const f of await walkDirectory(source)) {
        if (f.relativePath === '.caitlynignore') continue;
        if (include.length && !include.some((r) => r.test(f.relativePath))) continue;
        if (exclude.some((r) => r.test(f.relativePath))) continue;
        entries.push({ relativePath: f.relativePath, file: f.absolutePath });
      }
    } else {
      for (const item of source) entries.push({ relativePath: item.path.replace(/^\/+/, ''), file: item.file, item });
    }
    let hashed = 0;
    progress({ phase: 'checksum', done: 0, total: entries.length });
    await pool(
      entries.map((e, i) => ({ e, i })),
      options.concurrency ?? 6,
      async ({ e, i }) => {
        const prepared = await prepareFile(e.file, toError, signal);
        const name = e.relativePath.split('/').pop()!;
        const file: LocalFile = { relativePath: e.relativePath, path: `${folder}${e.relativePath}`, name, byteSize: prepared.byteSize, contentType: prepared.contentType, sha256: prepared.sha256 };
        locals[i] = { file, prepared, input: e.file };
        progress({ phase: 'checksum', done: ++hashed, total: entries.length });
      },
      signal,
    );
    const byPath = new Map(locals.map((l) => [l.file.path, l]));
    const items: Json[] = locals.map(({ file }, i) => {
      const own = entries[i].item;
      const externalId = own?.externalId ?? options.externalId?.(file);
      const sourceUrl = own?.sourceUrl ?? options.sourceUrl?.(file);
      const metadata = own?.metadata ?? options.metadata?.(file);
      return { path: file.path, sha256: file.sha256, byteSize: file.byteSize, contentType: file.contentType, ...(externalId ? { externalId } : {}), ...(sourceUrl ? { sourceUrl } : {}), ...(metadata ? { metadata } : {}) };
    });
    if (options.removeMissing) {
      const docs = await listAll(call, 'ListDocuments', { knowledgeBaseId, folder, deep: true, limit: 100 }, 'items', signal);
      const externalIds = new Set(items.map((i) => i.externalId).filter(Boolean));
      for (const d of docs) {
        const p = `${d.folder}${d.name}`;
        if (byPath.has(p) || (d.externalId && externalIds.has(d.externalId))) continue;
        items.push({ action: 'remove', path: p, ...(d.externalId ? { externalId: d.externalId } : {}) });
      }
    }

    // 2. Create: the first 10,000 items with the batch, the rest 10,000 a call, the last call `last: true`.
    const more = items.length > ITEMS_PER_CALL;
    const created = await call(
      'CreateIngestionBatch',
      { knowledgeBaseId, start: 'manual', awaitMoreItems: more, ...(options.policy ? { policy: options.policy } : {}), ...(options.uploadWindowSeconds !== undefined ? { uploadWindowSeconds: options.uploadWindowSeconds } : {}), ...(folder !== '/' ? { scope: { folderPath: folder } } : {}), items: items.slice(0, ITEMS_PER_CALL) },
      signal,
    );
    batchId = created.id as string;
    for (let at = ITEMS_PER_CALL; at < items.length; at += ITEMS_PER_CALL) {
      const last = at + ITEMS_PER_CALL >= items.length;
      const r = await call('BatchCreateIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, items: items.slice(at, at + ITEMS_PER_CALL), ...(last ? { last: true } : {}) }, signal);
      const failed = (r.results as Json[]).find((x) => x.status === 'failed');
      if (failed) throw toError({ status: 0, code: 'INGESTION_ITEM_REFUSED', title: 'An item was refused', detail: `Item ${at + failed.index} was refused${failed.code ? ` (${failed.code})` : ''}: ${failed.detail ?? 'no reason given'}`, itemCode: failed.code });
    }

    // 3. Plan: the batch's planned(), which follows its watch and raises the batch's own failure when planning
    // failed it (a policy rule of `fail` matched an item, say). Then price the items that need bytes.
    progress({ phase: 'planning', done: 0, total: items.length });
    let batch = await deps.planned(batchId, { ...options.wait, signal });
    lastBatch = batch;
    let etag = batch.etag as string;
    progress({ phase: 'planned', done: items.length, total: items.length, counts: batch.counts });
    let all: Json[] | undefined;
    const listItems = async () => (all ??= await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, limit: 1000 }, 'items', signal));
    // The plan is priced only when someone will see it: sync.estimate, and sync with a confirm (PROTOCOL.md 15). Every
    // item that could need its bytes is priced, the unresolved ones included: the most the batch could cost. Priced as
    // batch.upload.estimate prices them: each file by its name, content type and size, never hashed for it.
    let estimate: Json | undefined;
    let estimateError: Error | undefined;
    if (planOnly || options.confirm) {
      try {
        const needBytes = (await listItems()).filter((i) => couldNeedBytes(i) && byPath.has(i.path));
        estimate = await priceDocuments(
          call,
          knowledgeBaseId,
          await Promise.all(needBytes.map((i) => deps.describe(byPath.get(i.path)!.prepared))),
          (options as { estimatePerCall?: number }).estimatePerCall,
          signal,
        );
      } catch (err) {
        // For confirm, an estimate that could not be made is the caller's to judge: the plan carries the error in its
        // place. sync.estimate has nothing else to give, and a cancellation is never caught.
        if (planOnly || signal?.aborted || (err as Error)?.name === 'AbortError') throw err;
        estimateError = err as Error;
      }
    }
    const withoutMetadata = (e: Json | undefined) => {
      if (!e) return undefined;
      const { $metadata, ...rest } = e;
      void $metadata;
      return rest;
    };
    const plan = async (): Promise<SyncPlan> => ({ batch, items: await listItems(), ...(estimate ? { estimate: withoutMetadata(estimate) } : {}), ...(estimateError ? { estimateError } : {}) });
    if (planOnly) return await plan();

    // 4. Resolve
    if (options.confirm && !(await options.confirm(await plan()))) {
      // Not confirmed: the batch is cancelled, and the call raises CANCELLED (an error the SDK raises itself, status 0)
      // with the report so far: the planned items.
      await call('CancelIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }, signal);
      const declined = toError({ status: 0, code: 'CANCELLED', title: 'The plan was not confirmed', detail: `The plan of ingestion batch ${batchId} was not confirmed; the batch is cancelled.`, ingestionBatchId: batchId });
      // The report reads the batch and its items again: the batch is cancelled now, and so are its items.
      const readBatch = await call('GetIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }, signal);
      const readItems = await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, limit: 1000 }, 'items', signal);
      Object.defineProperty(declined, 'report', { value: toReport(readBatch, readItems), configurable: true, enumerable: false });
      throw declined;
    }
    const unresolved = await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, resolution: 'unresolved', limit: 1000 }, 'items', signal);
    if (unresolved.length) {
      const left: Json[] = [];
      for (const item of unresolved) {
        const resolution = options.resolve ? await options.resolve(item, await plan()) : undefined;
        if (!resolution) left.push(item);
        else await call('UpdateIngestionBatchItem', { knowledgeBaseId, ingestionBatchId: batchId, itemId: item.id, ifMatch: item.etag, resolution }, signal);
      }
      if (left.length) {
        throw toError({
          status: 0,
          code: 'INGESTION_BATCH_UNRESOLVED',
          title: 'Ingestion batch has unresolved items',
          detail: `${left.length} item${left.length === 1 ? ' is' : 's are'} unresolved (${left.map((i) => i.path ?? i.id).join(', ')}). The batch ${batchId} is left planned: resolve them with kb.ingestion.batches(batchId).items(itemId).resolve(…), then start it.`,
          ingestionBatchId: batchId,
          items: left,
        });
      }
      batch = await call('GetIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }, signal);
      etag = batch.etag;
    }

    // 5. Start
    const started = await call('StartIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId, ifMatch: etag }, signal);
    const policy: Json | undefined = started.uploadPolicy;
    if (started.batch) lastBatch = started.batch;

    // 6. Upload
    // Items Start already ended (skipped, removed, moved, updated) reach onItem now.
    for (const item of await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, limit: 1000 }, 'items', signal)) {
      if (FINAL_ITEM.has(item.status)) report(item);
      else note(item);
    }
    const awaiting = await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, status: 'awaiting_upload', limit: 1000 }, 'items', signal);
    // Every item came from this call's folder or list, so one awaiting a file the call does not have is an error, as is
    // a start that gave no upload policy for the items that need one (PROTOCOL.md 6.3).
    const unknown = awaiting.find((item) => !byPath.has(item.path));
    if (unknown) throw toError({ status: 0, code: 'INGESTION_ITEM_HAS_NO_FILE', title: 'An item has no file', detail: `The batch awaits bytes for ${unknown.path}, which is not one of the files given.` });
    if (awaiting.length && !policy) throw toError({ status: 0, code: 'UPLOAD_POLICY_MISSING', title: 'No upload policy', detail: 'StartIngestionBatch returned no upload policy, but items are awaiting upload.' });
    // The batch's upload (./upload.ts), with this call's own files. An upload that fails here reaches onItem and the
    // report at once.
    const failedLocally = new Map<string, Json>();
    await uploadItems(
      deps,
      knowledgeBaseId,
      batchId,
      awaiting,
      async (item) => {
        const local = byPath.get(item.path)!;
        return { file: { ...local.prepared, name: local.file.name, contentType: local.file.contentType }, sha256: local.file.sha256 };
      },
      {
        policy,
        concurrency: options.concurrency,
        signal,
        send: { signal, tracer: deps.tracer, maxAttempts: deps.maxAttempts, maxRetryDelayMs: deps.maxRetryDelayMs, stallTimeoutMs: deps.stallTimeoutMs },
        progress,
        onFailed: (item) => {
          failedLocally.set(item.id, item);
          report(item);
        },
        onAccepted: note,
      },
    );

    // 7. Wait: the batch's wait(), reporting its progress as its watch shows it.
    batch = await deps.finished(
      batchId,
      (b) => {
        lastBatch = b;
        if (b.status !== 'running') return;
        const byStatus = (b.counts?.byStatus ?? {}) as Record<string, number>;
        const done = Object.entries(byStatus).reduce((n, [k, v]) => n + (FINAL_ITEM.has(k) ? v : 0), 0);
        progress({ phase: 'processing', done, total: b.itemCount, counts: b.counts });
      },
      { ...options.wait, signal },
    );
    progress({ phase: batch.status, done: batch.itemCount, total: batch.itemCount, counts: batch.counts });
    const final = await listAll(call, 'ListIngestionBatchItems', { knowledgeBaseId, ingestionBatchId: batchId, limit: 1000 }, 'items', signal);
    // An item whose upload failed here is reported as that failure, whatever the server later made of it.
    const reportItems = final.map((i) => failedLocally.get(i.id) ?? i);
    for (const item of reportItems) report(item);
    return toReport(batch, reportItems);
  } catch (err) {
    if (signal?.aborted && batchId && options.cancelIngestion) {
      await call('CancelIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId, stopRunning: true }).catch(() => {});
    }
    const raised = signal?.aborted ? signal.reason : err;
    // A cancelled call's error carries the report so far: every item with its last status, and the batch's counts.
    if (signal?.aborted && batchId && raised && typeof raised === 'object') {
      // The batch as last read; read now (without the aborted signal) when the call was cancelled before any read.
      const readBatch = lastBatch ?? (await call('GetIngestionBatch', { knowledgeBaseId, ingestionBatchId: batchId }).catch(() => ({ id: batchId, status: 'unknown' })));
      Object.defineProperty(raised, 'report', { value: toReport(readBatch, [...known.values()]), configurable: true, enumerable: false });
    }
    throw raised;
  } finally {
    await Promise.all(locals.filter(Boolean).map((l) => l.prepared.dispose()));
  }
}

function toReport(batch: Json, items: Json[]): SyncReport {
  return { batch: batch as SyncReportBatch, items: items as SyncReportItem[] };
}
