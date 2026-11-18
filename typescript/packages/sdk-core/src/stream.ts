// SseStream: the runtime half of @sseEvents (PROTOCOL.md rule 7). Generated code supplies the event names and
// how to open and resume the stream; this class does parsing, skipping unknown events, de-duplication by id,
// resuming with Last-Event-ID, abort handling and finalMessage().
import { parseSse } from './sse.js';
import { readEvent, type EventPlan } from './protocol.js';

export interface SseSpec {
  /** SSE `event:` names this SDK knows (the union members' jsonNames). Others are skipped. */
  readonly known: ReadonlySet<string>;
  /** The event that ends the stream successfully, and the member finalMessage() returns. */
  readonly final?: { event: string; member: string };
  /** The event carrying RFC 9457 problem details; it ends the stream with a thrown error. */
  readonly errorEvent?: string;
  /** Builds the typed error for an error event. */
  readonly toError: (problem: Record<string, unknown>) => Error;
  /**
   * The watch starts every connection with a snapshot and takes no cursor (WatchKnowledgeBase, PROTOCOL.md 16): a
   * reconnect sends no Last-Event-ID, and the ids seen before it are forgotten, so the new snapshot is delivered.
   */
  readonly fresh?: boolean;
  /** Adds what the SDK gives every event of this stream beside its data (the knowledge base watch's processingOf()). */
  readonly decorate?: (event: Record<string, unknown>) => void;
  /** How each event's data is read as the model's types (watch.event-types), by event name. */
  readonly read?: Readonly<Record<string, EventPlan>>;
}

type Body = AsyncIterable<Uint8Array>;
/** What opening (or resuming) a stream returns: the command output, with its event body and response metadata. */
export interface SseOpened {
  readonly events: unknown;
  readonly $metadata?: { readonly requestId?: string };
}

/**
 * The pause before the nth reconnect in a row (PROTOCOL.md 5.6): an exponential backoff with jitter, 0.25-0.5 s,
 * then 0.5-1 s, then 1-2 s, so each pause is longer than the last.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
}

/** A connection that stayed open at least this long before it ended restarts the reconnect count (PROTOCOL.md 5.6). */
export const LONG_CONNECTION_MS = 60_000;

/**
 * The clock that times each connection, for the rule above. Replace `now` only in tests: the conformance cases step it
 * so that a connection lasts an hour, or under a minute, without waiting.
 */
export const streamClock = { now: (): number => Date.now() };

export class SseStream<E extends { type: string }, F = never> implements AsyncIterable<E> {
  private finalValue?: F;
  private consumed = false;
  private readonly seen = new Set<string>();
  lastEventId?: string;
  /** Reconnects so far, in all. */
  reconnects = 0;
  /** Reconnects since the last event: at most maxReconnects in a row (PROTOCOL.md 5.6). */
  private attempts = 0;
  /** When the current connection's response arrived, on streamClock. */
  private openedAt = 0;
  /** The Caitlyn-Request-Id of the response that opened the stream; set once it has opened. */
  requestId?: string;

  /**
   * Aborts the stream's own requests: the caller's signal, and close(). The fetch is sent with this signal, so
   * closing a stream ends its connection in Node and in every browser (watch.break-closes), not only its reader.
   */
  private readonly controller = new AbortController();
  /** The events, read once, however many times they are pulled (iteration, then finalMessage()). */
  private events?: AsyncGenerator<E>;

  constructor(
    private readonly spec: SseSpec,
    private readonly open: (signal: AbortSignal) => Promise<SseOpened>,
    private readonly resume: ((lastEventId: string | undefined, signal: AbortSignal) => Promise<SseOpened>) | undefined,
    private readonly signal?: AbortSignal,
    private readonly maxReconnects = 3,
  ) {
    if (signal?.aborted) this.controller.abort(signal.reason);
    else if (signal) {
      // Forwarded until the stream's own controller aborts (it ends, or is closed), then removed: a signal reused for
      // many streams keeps no listener from the streams that have finished.
      const forward = () => this.controller.abort(signal.reason);
      signal.addEventListener('abort', forward, { once: true });
      this.controller.signal.addEventListener('abort', () => signal.removeEventListener('abort', forward), { once: true });
    }
    // `await using stream = conversation.send(...)`: leaving the block closes the stream as close() does.
    Object.defineProperty(this, asyncDispose, { value: () => this.close(), configurable: true });
  }

  /**
   * Closes the stream: its connection ends and nothing more is read. A watch closes when its loop is left; a stream
   * with a final event (a send) stays open after a `break`, so finalMessage() can still drain it, until this is
   * called, its signal aborts, or finalMessage() has read it to the end (send.break-then-final).
   */
  async close(): Promise<void> {
    this.controller.abort(new DOMException('The stream was closed', 'AbortError'));
    await this.events?.return(undefined).catch(() => undefined);
  }

  /** Waits `ms`, or until the signal aborts, then throws its reason. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) return reject(this.aborted());
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.aborted());
      };
      const timer = setTimeout(() => {
        this.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      this.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private opening?: Promise<SseOpened>;

  /** Sends the request once, however it is started: by opened() or by iterating. */
  private start(): Promise<SseOpened> {
    this.opening ??= this.open(this.controller.signal).then((opened) => {
      this.openedAt = streamClock.now();
      this.requestId = opened.$metadata?.requestId;
      return opened;
    });
    return this.opening;
  }

  /**
   * Opens the stream now, rather than when iteration starts, and resolves once the response headers (2xx) have
   * arrived; rejects with the call's error. To wait for something your own call causes, await this, then make the
   * call, then iterate. Iterating afterwards reads this same response.
   */
  async opened(): Promise<void> {
    await this.start();
  }

  private aborted(): unknown {
    return this.signal?.reason ?? new DOMException('Aborted', 'AbortError');
  }

  /**
   * Its events. Leaving the loop (break, return, a throw) closes a stream with no final event (a watch: its
   * connection ends at once); a stream with one stays open for finalMessage() until close() (PROTOCOL.md 5).
   */
  [Symbol.asyncIterator](): AsyncIterator<E> {
    if (this.consumed) throw new Error('SseStream can only be iterated once');
    this.consumed = true;
    const events = this.read();
    return {
      next: () => events.next(),
      return: async (value?: unknown) => {
        if (!this.spec.final) await this.close();
        return { done: true, value: value as E };
      },
    };
  }

  private read(): AsyncGenerator<E> {
    return (this.events ??= this.generate());
  }

  private async *generate(): AsyncGenerator<E> {
    try {
      yield* this.connect();
    } finally {
      // Read to the end, failed or closed: the connection is released either way.
      this.controller.abort(new DOMException('The stream ended', 'AbortError'));
    }
  }

  private async *connect(): AsyncGenerator<E> {
    const opened = await this.start();
    let body = opened.events as Body;
    for (;;) {
      let ended = false;
      // Events on this connection so far: on a watch that starts each connection with a snapshot (spec.fresh), the
      // snapshot, its first, is not progress towards STREAM_LOST, whatever its id (PROTOCOL.md 5.6).
      let onConnection = 0;
      try {
        for await (const msg of parseSse(body)) {
          // WebKit can keep delivering a body after its fetch was aborted: cancelling ends the stream here regardless.
          if (this.signal?.aborted) throw this.aborted();
          const first = onConnection++ === 0;
          if (msg.id) {
            if (this.seen.has(msg.id)) continue;
            this.seen.add(msg.id);
            this.lastEventId = msg.id;
            if (!(this.spec.fresh && first)) this.attempts = 0; // only a new event counts as progress (PROTOCOL.md 5.6)
          }
          if (!this.spec.known.has(msg.event)) continue;
          let data: Record<string, any>;
          try {
            data = JSON.parse(msg.data) as Record<string, any>;
            const plan = this.spec.read?.[msg.event];
            if (plan) readEvent(data, plan);
          } catch (cause) {
            // PROTOCOL.md 6.3: a failure the SDK meets is its own error, with the native one as its cause.
            throw Object.assign(this.spec.toError({ status: 0, code: 'DECODE_FAILED', title: 'An event could not be decoded', detail: `The ${msg.event} event could not be decoded: ${(cause as Error)?.message ?? cause}` }), { cause });
          }
          // PROTOCOL.md 5.5: a failure event ends only a stream with a final event. On a watch it is delivered.
          if (msg.event === this.spec.errorEvent && this.spec.final) throw this.spec.toError(data);
          const event = { ...data, type: msg.event, eventId: msg.id } as unknown as E;
          this.spec.decorate?.(event as unknown as Record<string, unknown>);
          yield event;
          if (msg.event === this.spec.final?.event) {
            this.finalValue = data[this.spec.final.member] as F;
            ended = true;
            return;
          }
          // PROTOCOL.md 5.9: a resumed stream with a final event that gets stream.reset ends there, with no error:
          // the answer finished while it was disconnected, and its final event went to the earlier connection.
          if (msg.event === 'stream.reset' && this.spec.final && this.reconnects > 0) {
            ended = true;
            return;
          }
        }
        // A clean end of stream: the end, unless the operation resumes. Then it reconnects, whether a proxy cut a
        // stream short of its final event or a server shutting down ended a watch (PROTOCOL.md 5.6, 5.7).
        if (!this.resume) return;
      } catch (err) {
        if (this.signal?.aborted) throw this.aborted(); // Node surfaces a mid-body abort as Error('aborted')
        if (ended || (err as Error)?.name === 'AbortError' || err === undefined || (err as { $fault?: unknown }).$fault || err instanceof SyntaxError) throw err;
        // Transport error mid-stream: resume.
      }
      if (this.signal?.aborted) throw this.aborted();
      // A connection that stayed open a minute or more starts the count again, like a new event: the server ends
      // every stream within an hour, and a quiet watch must outlive that (PROTOCOL.md 5.6).
      if (streamClock.now() - this.openedAt >= LONG_CONNECTION_MS) this.attempts = 0;
      if (!this.resume || ++this.attempts > this.maxReconnects)
        throw this.spec.toError({ status: 0, code: 'STREAM_LOST', title: 'The stream dropped and could not be resumed' });
      this.reconnects++;
      await this.pause(reconnectDelayMs(this.attempts));
      if (this.spec.fresh) {
        this.seen.clear();
        this.lastEventId = undefined;
      }
      body = (await this.resume(this.lastEventId, this.controller.signal)).events as Body;
      this.openedAt = streamClock.now();
    }
  }

  /**
   * The answer's text as it is written: the `delta` of each `text.delta` event, for
   * `for await (const text of conversation.send(message).text())`. Iterates the stream, so use one or the other;
   * after a `break`, finalMessage() still drains it, or close() ends it.
   */
  async *text(): AsyncGenerator<string> {
    for await (const event of this) {
      const e = event as { type: string; delta?: unknown };
      if (e.type === 'text.delta' && typeof e.delta === 'string') yield e.delta;
    }
  }

  /** Drains the stream if needed and returns the final event's member. */
  async finalMessage(): Promise<F> {
    // Whatever is left: after a break the same events carry on from where the loop stopped.
    this.consumed = true;
    const events = this.read();
    while (!(await events.next()).done);
    if (this.finalValue === undefined) throw this.spec.toError({ status: 0, code: 'NO_FINAL_EVENT', title: 'The stream ended without its final event' });
    return this.finalValue;
  }
}

/**
 * The key `await using` closes a stream by: Symbol.asyncDispose, or where a runtime has none,
 * Symbol.for('Symbol.asyncDispose'), the key TypeScript's and esbuild's lowering of `await using` look up then.
 */
const asyncDispose: symbol = /* @__PURE__ */ (() => (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose'))();

/**
 * What `await using` needs of a stream, typed only where the caller's lib declares Symbol.asyncDispose (esnext or
 * es2024 disposable, or @types/node): elsewhere it is `{}`, so the types still compile.
 */
export type AsyncDisposableStream = SymbolConstructor extends { readonly asyncDispose: infer K extends symbol } ? { [P in K]: () => Promise<void> } : {};
