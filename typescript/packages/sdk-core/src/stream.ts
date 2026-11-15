// SseStream: the runtime half of @sseEvents (PROTOCOL.md rule 7). Generated code supplies the event names and
// how to open and resume the stream; this class does parsing, skipping unknown events, de-duplication by id,
// resuming with Last-Event-ID, abort handling and finalMessage().
import { parseSse } from './sse.js';

export interface SseSpec {
  /** SSE `event:` names this SDK knows (the union members' jsonNames). Others are skipped. */
  readonly known: ReadonlySet<string>;
  /** The event that ends the stream successfully, and the member finalMessage() returns. */
  readonly final?: { event: string; member: string };
  /** The event carrying RFC 9457 problem details; it ends the stream with a thrown error. */
  readonly errorEvent?: string;
  /** Builds the typed error for an error event. */
  readonly toError: (problem: Record<string, unknown>) => Error;
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

export class SseStream<E extends { type: string }, F = never> implements AsyncIterable<E> {
  private finalValue?: F;
  private consumed = false;
  private readonly seen = new Set<string>();
  lastEventId?: string;
  /** Reconnects so far, in all. */
  reconnects = 0;
  /** Reconnects since the last event: at most maxReconnects in a row (PROTOCOL.md 5.6). */
  private attempts = 0;
  /** The Caitlyn-Request-Id of the response that opened the stream; set once it has opened. */
  requestId?: string;

  constructor(
    private readonly spec: SseSpec,
    private readonly open: () => Promise<SseOpened>,
    private readonly resume: ((lastEventId: string | undefined) => Promise<SseOpened>) | undefined,
    private readonly signal?: AbortSignal,
    private readonly maxReconnects = 3,
  ) {}

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
    this.opening ??= this.open().then((opened) => {
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

  async *[Symbol.asyncIterator](): AsyncGenerator<E> {
    if (this.consumed) throw new Error('SseStream can only be iterated once');
    this.consumed = true;
    const opened = await this.start();
    let body = opened.events as Body;
    for (;;) {
      let ended = false;
      try {
        for await (const msg of parseSse(body)) {
          // WebKit can keep delivering a body after its fetch was aborted: cancelling ends the stream here regardless.
          if (this.signal?.aborted) throw this.aborted();
          if (msg.id) {
            if (this.seen.has(msg.id)) continue;
            this.seen.add(msg.id);
            this.lastEventId = msg.id;
            this.attempts = 0; // only a new event counts as progress (PROTOCOL.md 5.6)
          }
          if (!this.spec.known.has(msg.event)) continue;
          const data = JSON.parse(msg.data) as Record<string, unknown>;
          // PROTOCOL.md 5.5: a failure event ends only a stream with a final event. On a watch it is delivered.
          if (msg.event === this.spec.errorEvent && this.spec.final) throw this.spec.toError(data);
          const event = { ...data, type: msg.event, eventId: msg.id } as unknown as E;
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
      if (!this.resume || ++this.attempts > this.maxReconnects)
        throw this.spec.toError({ status: 0, code: 'STREAM_LOST', title: 'The stream dropped and could not be resumed' });
      this.reconnects++;
      await this.pause(reconnectDelayMs(this.attempts));
      body = (await this.resume(this.lastEventId)).events as Body;
    }
  }

  /** Drains the stream if needed and returns the final event's member. */
  async finalMessage(): Promise<F> {
    if (!this.consumed) for await (const _ of this) void _;
    if (this.finalValue === undefined) throw this.spec.toError({ status: 0, code: 'NO_FINAL_EVENT', title: 'The stream ended without its final event' });
    return this.finalValue;
  }
}
