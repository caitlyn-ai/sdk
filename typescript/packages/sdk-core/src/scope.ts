// The runtime half of scopes (PROTOCOL.md 10 and 16): what the generated scope tree calls.
//
//   - WorkPromise: what a call that starts work returns. Awaiting it gives the call's response; `.wait()` waits for
//     the work through the knowledge base's watch, and `.watch()` follows it, so `await kb.documents.create(file).wait()`
//     is one await. The request is sent when the call is made, as the Anthropic SDK's APIPromise sends its own.
//   - waitFor: `wait()` and `planned()` on a scope, built on its `watch()`: the snapshot, then each change, until no job
//     on the thing is running, raising a failed job's error and returning on completed_with_failures.
//   - readers: the `'inherit' | 'everyone' | {roles, people}` shorthand for access.set.
import type { ToError } from './files.js';
import type { CallOptions } from './client.js';

type Json = Record<string, any>;

/** Options for `wait()` and `planned()`: cancellation, a time limit (none by default) and a progress callback. */
export interface WaitOptions extends CallOptions {
  /** Give up after this long, with a TimeoutError (code WAIT_TIMEOUT). No limit by default. */
  timeoutMs?: number;
  /**
   * Called with the thing's processing: the snapshot's first, when it is being processed, then each progress event's,
   * in order. A document's is its DocumentProcessing (stage, percent, eta); a batch's or folder's the running job.
   * Never called once wait() has returned or raised.
   */
  onProgress?: (processing: Json) => void;
}

/**
 * The processing an event carries for one thing (PROTOCOL.md 16, `watch.processing`): a document's DocumentProcessing,
 * from the snapshot (its processing entry, or the watched document itself), a document.progress or a document.created
 * or .updated event; any other thing's running job, from the snapshot's jobs or a job.progress event. With no
 * identifier, the first the event carries. Undefined when the event carries none for it.
 */
export function processingIn(event: Json, id?: string, of: 'document' | 'job' | 'any' = 'any'): Json | undefined {
  const type = event.type as string;
  const document = of !== 'job';
  const job = of !== 'document';
  if (type === 'snapshot') {
    if (document) {
      const entry = ((event.progress ?? []) as Json[]).find((p) => id === undefined || p.documentId === id);
      if (entry) return entry.processing;
      if (event.document && (id === undefined || event.document.id === id) && event.document.processing) return event.document.processing;
    }
    if (job) return ((event.jobs ?? []) as Json[]).find((j) => !FINAL_JOB.has(j.status) && (id === undefined || j.id === id || j.target?.id === id));
    return undefined;
  }
  if (document && type === 'document.progress') return id === undefined || event.documentId === id ? event.processing : undefined;
  if (job && type === 'job.progress') return id === undefined || event.job?.id === id || event.job?.target?.id === id ? event.job : undefined;
  return undefined;
}

/**
 * Gives every event of a knowledge base watch its processing accessor (PROTOCOL.md 16, watch.processing). On a scope's
 * watch (a document, folder or batch filter), `event.processing` is a getter for the watched thing's processing: a
 * document's DocumentProcessing, a folder's or batch's running job. On document.progress the event's own `processing`
 * is that same value and is left as it is. On the knowledge base's own watch, `event.processingOf(id)` gives a named
 * document's or job's.
 */
export function withProcessing(input: Json): (event: Json) => void {
  const watched = (input.document ?? input.folder ?? input.batch) as string | undefined;
  const of = input.document !== undefined ? 'document' : 'job';
  return (event) => {
    if (watched === undefined) {
      Object.defineProperty(event, 'processingOf', { value: (id: string) => processingIn(event, id, 'any'), enumerable: false });
    } else if (!('processing' in event)) {
      Object.defineProperty(event, 'processing', { get: () => processingIn(event, watched, of), enumerable: false });
    }
  };
}

/** On a scope's watch (a document, folder or batch): the watched thing's processing. */
export interface ScopeWatchAccessor {
  /** The watched thing's processing in this event, or undefined when the event carries none. */
  readonly processing?: Json;
}

/** On the knowledge base's own watch: a named document's or job's processing. */
export interface KnowledgeBaseWatchAccessor {
  /** The processing this event carries for the document or job `id`, or undefined. */
  processingOf(id: string): Json | undefined;
}

/**
 * A wait() whose time limit passed (PROTOCOL.md 16): a `TimeoutError` by name, with the code every SDK gives it,
 * `WAIT_TIMEOUT`, and status 0. The watch it followed is closed.
 */
export class WaitTimeoutError extends Error {
  override readonly name = 'TimeoutError';
  readonly code = 'WAIT_TIMEOUT';
  readonly status = 0;
  constructor(readonly timeoutMs: number) {
    super(`The wait did not finish within ${timeoutMs} ms`);
  }
}

/** How a call's work is followed once its response is in: its `wait()` and its `watch()`. */
export interface Follow<W, E> {
  wait(options?: WaitOptions): Promise<W>;
  watch(options?: CallOptions): AsyncIterable<E>;
}

/**
 * What a call that starts work returns (PROTOCOL.md 16): a promise of the call's response that also has `wait()` and
 * `watch()`. The request is sent at once; awaiting gives the response, `wait()` the thing once the work is done.
 */
export class WorkPromise<T, W = T, E = Json> implements Promise<T> {
  readonly [Symbol.toStringTag] = 'WorkPromise';
  private readonly response: Promise<T>;

  constructor(
    response: Promise<T>,
    private readonly follow: (response: T) => Follow<W, E>,
  ) {
    this.response = response;
    // A caller who only calls wait() still sees the call's error there; never an unhandled rejection here.
    response.catch(() => {});
  }

  then<A = T, B = never>(onFulfilled?: ((value: T) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.response.then(onFulfilled, onRejected);
  }

  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.response.catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.response.finally(onFinally);
  }

  /** Waits for the work the call started: returns the thing once it is done, or raises the error that stopped it. */
  async wait(options: WaitOptions = {}): Promise<W> {
    return this.follow(await this.response).wait(options);
  }

  /** Follows the work the call started: the snapshot first, then each change. */
  watch(options: CallOptions = {}): AsyncIterable<E> {
    const response = this.response;
    const follow = this.follow;
    return {
      async *[Symbol.asyncIterator]() {
        yield* follow(await response).watch(options);
      },
    };
  }
}

/** The kinds of thing a knowledge base's watch reports on, as its snapshot names them. */
export type WatchedKind = 'knowledgeBase' | 'document' | 'folder' | 'batch';

export interface WaitSpec<T> {
  /** Opens the watch (the scope's own, with its filter), cancelled by `signal`. */
  watch: (signal: AbortSignal) => AsyncIterable<Json>;
  /** What is waited on; undefined when only a job is (a fill-in, reprocessing, layout-aware search). */
  kind?: WatchedKind;
  /** Its identifier: a knowledge base's or document's id, a folder's path, a batch's id. */
  id?: string;
  /** Follow this job (the Operation the call started) rather than every job on the thing. */
  jobId?: string;
  /** The call deleted the thing: its going ends the wait as success. */
  deleting?: boolean;
  /**
   * The call cancelled the thing's work (a batch's cancel(), a document's cancelProcessing()): the wait returns the
   * thing once its work has stopped, the cancelled batch or the document as it then stands, and a job it cancelled
   * is not raised as CANCELLED (wait.cancel-returns).
   */
  cancelling?: boolean;
  /** `planned`: a batch's planned(), until it is planned or past it. Default `done`. */
  until?: 'done' | 'planned';
  /** Reads the thing as its `get` does: what wait() returns. Without one, the watch's own view of it. */
  get?: (signal: AbortSignal) => Promise<T>;
  /** Called with the thing each time the watch shows it (a snapshot, a change, a read after an event). */
  onThing?: (thing: Json) => void;
  /** Builds an error the SDK raises itself, or a job's typed error for its code. */
  toError: ToError;
  /** The typed error for a failed job's error: its code's class (the model's errorCodes). */
  jobError: (error: Json) => Error;
}

const FINAL_JOB = new Set(['succeeded', 'completed_with_failures', 'failed', 'cancelled']);
const FINAL_BATCH = new Set(['succeeded', 'completed_with_failures', 'failed', 'cancelled', 'expired']);
const PAST_PLANNING = new Set(['planned', 'running', ...FINAL_BATCH]);
/** A thing in one of these is still being worked on, whether or not its job is known yet. */
// One list for every kind (PROTOCOL.md 16): a knowledge base creating, moving or deleting; a document pending or
// processing; an ingestion batch planning or running.
const BUSY = new Set(['creating', 'moving', 'deleting', 'pending', 'processing', 'planning', 'running']);

const isNotFound = (err: unknown) => (err as { status?: number })?.status === 404;

/** Joins the caller's signal and a time limit into one, for one wait. */
function waitSignal(options: WaitOptions): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const signals = [options.signal].filter(Boolean) as AbortSignal[];
  const onAbort = (s: AbortSignal) => () => controller.abort(s.reason);
  const off: (() => void)[] = [];
  if (options.timeoutMs !== undefined) {
    const limit = options.timeoutMs;
    const timer = setTimeout(() => controller.abort(new WaitTimeoutError(limit)), limit);
    off.push(() => clearTimeout(timer));
  }
  for (const s of signals) {
    if (s.aborted) controller.abort(s.reason);
    const f = onAbort(s);
    s.addEventListener('abort', f, { once: true });
    off.push(() => s.removeEventListener('abort', f));
  }
  return {
    signal: controller.signal,
    // Ending the wait closes its watch's connection.
    done: () => {
      off.forEach((f) => f());
      controller.abort();
    },
  };
}

/**
 * wait() and planned() (PROTOCOL.md 16): follows the thing's watch until no job on it is running (or, with
 * `until: 'planned'`, until a batch is planned or past it), then returns it as its `get` would. A job that ended
 * `completed_with_failures` returns, with its partial failures on the thing; one that ended `failed` raises its typed
 * error, and `cancelled` raises CANCELLED. The thing going ends the wait: as success after a delete, else as a 404.
 * Jobs that had already ended when the wait began are history, not this wait's concern, unless `jobId` names one.
 */
export async function waitFor<T>(spec: WaitSpec<T>, options: WaitOptions = {}): Promise<T | undefined> {
  const { signal, done } = waitSignal(options);
  let thing: Json | undefined;
  let seen = false; // the first snapshot has arrived
  const jobs = new Map<string, Json>();
  const followed = new Set<string>(spec.jobId ? [spec.jobId] : []);
  let gone = false;
  const fail = (err: unknown): never => {
    throw err;
  };
  try {
    const stream = spec.watch(signal);
    try {
      for await (const event of stream) {
        signal.throwIfAborted();
        const type = event.type as string;
        if (options.onProgress && (type === 'snapshot' || type.endsWith('.progress'))) {
          const p = spec.kind === 'document' ? processingIn(event, spec.id, 'document') : processingIn(event, spec.kind === 'knowledgeBase' ? undefined : spec.id, 'job');
          if (p) options.onProgress(p);
        }
        if (type === 'snapshot') {
          seen = true;
          if (spec.kind) {
            thing = event[spec.kind];
            if (!thing) gone = true;
          }
          for (const job of (event.jobs ?? []) as Json[]) {
            jobs.set(job.id, job);
            if (!FINAL_JOB.has(job.status) && !spec.jobId) followed.add(job.id);
          }
        } else if (type === 'job.progress' || type === 'job.finished') {
          const job = event.job as Json;
          jobs.set(job.id, job);
          if (!spec.jobId && !FINAL_JOB.has(job.status)) followed.add(job.id);
        } else if (spec.kind === 'document' && (type === 'document.created' || type === 'document.updated') && event.document?.id === spec.id) {
          thing = event.document;
        } else if (spec.kind === 'document' && type === 'document.progress' && event.documentId === spec.id && thing) {
          thing = { ...thing, processing: event.processing };
        } else if (spec.kind === 'document' && type === 'document.deleted' && event.documentId === spec.id) {
          gone = true;
        } else if (spec.kind === 'folder' && (type === 'folder.created' || type === 'folder.updated') && event.folder?.path === spec.id) {
          thing = event.folder;
        } else if (spec.kind === 'folder' && type === 'folder.deleted' && event.path === spec.id) {
          gone = true;
        } else if (spec.kind === 'knowledgeBase' && type === 'knowledge_base.updated') {
          thing = event.knowledgeBase;
        } else if (spec.kind === 'batch' && spec.get) {
          // The model has no change event for a batch itself: anything else on its watch may have moved it on.
          try {
            thing = (await spec.get(signal)) as Json;
          } catch (err) {
            if (isNotFound(err)) gone = true;
            else throw err;
          }
        }
        if (thing && spec.onThing) spec.onThing(thing);
        if (!seen) continue;
        if (gone) return spec.deleting ? undefined : fail(spec.toError({ status: 404, code: 'NOT_FOUND', title: 'Not found', detail: `The ${spec.kind ?? 'thing'} ${spec.id ?? ''} is gone.` }));
        const verdict = settle(spec, thing, jobs, followed);
        if (verdict === 'waiting') continue;
        return await finish(spec, thing, verdict, signal);
      }
    } finally {
      // Ending the iteration closes the watch's connection.
    }
    // A watch only ends on its own when it cannot be resumed.
    throw spec.toError({ status: 0, code: 'STREAM_LOST', title: 'The watch ended before the work did' });
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    if (isNotFound(err) && spec.deleting) return undefined;
    throw err;
  } finally {
    done();
  }
}

type Verdict = 'waiting' | { partial?: Json[] };

/** Is the wait over? A failed or cancelled job raises; otherwise the jobs followed and the thing's own status say. */
function settle<T>(spec: WaitSpec<T>, thing: Json | undefined, jobs: Map<string, Json>, followed: Set<string>): Verdict {
  let partial: Json[] | undefined;
  for (const id of followed) {
    const job = jobs.get(id);
    if (!job || !FINAL_JOB.has(job.status)) return 'waiting';
    if (job.status === 'failed') throw spec.jobError(job.error ?? { code: 'INTERNAL', detail: `Job ${job.id} failed.` });
    // A delete stops the thing's work: a job it cancelled is part of the delete, and the wait ends on the gone rule.
    if (job.status === 'cancelled' && (spec.deleting || spec.cancelling)) continue;
    if (job.status === 'cancelled') throw spec.toError({ status: 0, code: 'CANCELLED', title: 'The work was cancelled', detail: `Job ${job.id} (${job.kind}) was cancelled.`, jobId: job.id });
    if (job.status === 'completed_with_failures') partial = [...(partial ?? []), ...((job.partialFailures as Json[]) ?? [])];
  }
  if (spec.kind === 'batch' && thing) {
    const status = thing.status as string;
    if (status === 'failed') {
      const failure = thing.failure as Json | undefined;
      throw spec.toError({ status: 0, code: failure?.code ?? 'INGESTION_BATCH_FAILED', title: 'The ingestion batch failed', detail: failure?.message ?? `Ingestion batch ${thing.id} failed.`, ingestionBatchId: thing.id });
    }
    if (status === 'cancelled' && spec.cancelling) return {};
    if (status === 'cancelled') throw spec.toError({ status: 0, code: 'CANCELLED', title: 'The ingestion batch was cancelled', detail: `Ingestion batch ${thing.id} was cancelled.`, ingestionBatchId: thing.id });
    if (status === 'expired') throw spec.toError({ status: 0, code: 'EXPIRED', title: 'The ingestion batch expired', detail: `Ingestion batch ${thing.id} expired before it was started.`, ingestionBatchId: thing.id });
    if (spec.until === 'planned') return PAST_PLANNING.has(status) ? {} : 'waiting';
    return FINAL_BATCH.has(status) ? {} : 'waiting';
  }
  // A delete whose own job has ended is done: the thing is going, whatever its last status said.
  if (spec.deleting && spec.jobId) return { partial };
  // The thing's own status says whether work is still under way, even with no job listed on it (a document pending
  // before its job is reported, a knowledge base still being created).
  if (spec.kind && thing && BUSY.has(thing.status)) return 'waiting';
  if (spec.deleting && spec.jobId === undefined) return 'waiting';
  return { partial };
}

async function finish<T>(spec: WaitSpec<T>, thing: Json | undefined, verdict: { partial?: Json[] }, signal: AbortSignal): Promise<T | undefined> {
  if (spec.deleting) return undefined;
  let out: Json | undefined;
  if (!spec.kind) out = spec.jobId ? undefined : thing;
  else if (spec.get) {
    try {
      out = (await spec.get(signal)) as Json;
    } catch (err) {
      if (isNotFound(err) && spec.deleting) return undefined;
      throw err;
    }
  } else out = thing;
  if (out && verdict.partial?.length && !(out.partialFailures as Json[] | undefined)?.length) out = Object.assign(out, { partialFailures: verdict.partial });
  return out as T | undefined;
}

/** wait() on work that only a job tracks (a fill-in, reprocessing): the job, once it has ended. */
export async function waitForJob(spec: Omit<WaitSpec<Json>, 'kind' | 'get' | 'deleting' | 'until'> & { jobId: string }, options: WaitOptions = {}): Promise<Json> {
  const { signal, done } = waitSignal(options);
  let job: Json | undefined;
  try {
    const stream = spec.watch(signal);
    try {
      for await (const event of stream) {
        if (options.onProgress && (event.type === 'snapshot' || event.type === 'job.progress')) {
          const p = processingIn(event, spec.jobId, 'job');
          if (p) options.onProgress(p);
        }
        if (event.type === 'snapshot') job = ((event.jobs ?? []) as Json[]).find((j) => j.id === spec.jobId) ?? job;
        else if ((event.type === 'job.progress' || event.type === 'job.finished') && event.job?.id === spec.jobId) job = event.job;
        if (!job || !FINAL_JOB.has(job.status)) continue;
        if (job.status === 'failed') throw spec.jobError(job.error ?? { code: 'INTERNAL', detail: `Job ${job.id} failed.` });
        if (job.status === 'cancelled') throw spec.toError({ status: 0, code: 'CANCELLED', title: 'The work was cancelled', detail: `Job ${job.id} (${job.kind}) was cancelled.`, jobId: job.id });
        return job;
      }
    } finally {
      // Ending the iteration closes the watch's connection.
    }
    throw spec.toError({ status: 0, code: 'STREAM_LOST', title: 'The watch ended before the work did' });
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    throw err;
  } finally {
    done();
  }
}

/** Who may read a folder or document: the shorthand access.set takes, beside the modelled `{kind, roles, people}`. */
export type ReadersShorthand = 'inherit' | 'everyone' | { roles?: string[]; people?: string[] };

/**
 * The readers shorthand as the modelled shape: `'inherit'` and `'everyone'` are `{kind}`, and `{roles, people}` is
 * `{kind: 'specific', roles, people}`. A value that already has `kind` is sent as it is.
 */
export function readers(value: unknown): unknown {
  if (value === 'inherit' || value === 'everyone') return { kind: value };
  if (value && typeof value === 'object' && !('kind' in value)) return { kind: 'specific', ...(value as object) };
  return value;
}

/** A folder path as a request path takes it: without its first and last `/` (`/hr/leave/` is `hr/leave`). */
export function trimFolder(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * The fields of what a create returned, for its new scope: every member of `response` and of the thing in it, less
 * those the scope's own methods and properties take (a batch's `start` mode is its start() method).
 */
export function withFields<S extends object>(scope: S, response: Json, thing: Json = response): S {
  const out: Json = {};
  for (const source of [response, thing]) {
    for (const [k, v] of Object.entries(source ?? {})) if (!(k in scope)) out[k] = v;
  }
  // The thing's JSON and the response's metadata stay hidden, as on the thing itself (PROTOCOL.md 4.2).
  for (const k of ['raw', '$metadata']) {
    const v = thing?.[k] ?? response?.[k];
    if (v !== undefined) Object.defineProperty(out, k, { value: v, enumerable: false, configurable: true });
  }
  return Object.assign(out, scope) as S;
}

/** A conversation's send(): sends the message now, whether or not the stream is ever read (PROTOCOL.md 16). */
export function eager<S extends { opened(): Promise<void> }>(stream: S): S {
  stream.opened().catch(() => {});
  return stream;
}
