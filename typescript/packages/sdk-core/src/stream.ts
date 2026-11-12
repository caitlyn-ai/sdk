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

export class SseStream<E extends { type: string }, F = never> implements AsyncIterable<E> {
  private finalValue?: F;
  private consumed = false;
  private readonly seen = new Set<string>();
  lastEventId?: string;
  reconnects = 0;
  /** The Caitlyn-Request-Id of the response that opened the stream; set once iteration has started. */
  requestId?: string;

  constructor(
    private readonly spec: SseSpec,
    private readonly open: () => Promise<SseOpened>,
    private readonly resume: ((lastEventId: string | undefined) => Promise<SseOpened>) | undefined,
    private readonly signal?: AbortSignal,
    private readonly maxReconnects = 3,
  ) {}

  private aborted(): unknown {
    return this.signal?.reason ?? new DOMException('Aborted', 'AbortError');
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<E> {
    if (this.consumed) throw new Error('SseStream can only be iterated once');
    this.consumed = true;
    const opened = await this.open();
    this.requestId = opened.$metadata?.requestId;
    let body = opened.events as Body;
    for (;;) {
      let ended = false;
      let onResponse = 0; // SSE events (known or not) this response has carried
      try {
        for await (const msg of parseSse(body)) {
          onResponse++;
          if (msg.id) {
            if (this.seen.has(msg.id)) continue;
            this.seen.add(msg.id);
            this.lastEventId = msg.id;
          }
          if (!this.spec.known.has(msg.event)) continue;
          const data = JSON.parse(msg.data) as Record<string, unknown>;
          if (msg.event === this.spec.errorEvent) throw this.spec.toError(data);
          const event = { ...data, type: msg.event, eventId: msg.id } as unknown as E;
          yield event;
          if (msg.event === this.spec.final?.event) {
            this.finalValue = data[this.spec.final.member] as F;
            ended = true;
            return;
          }
        }
        // A clean end of stream. Without a final event declared, that is the end; with one, a proxy cut us off,
        // unless the response carried no event at all: then the answer had already finished (PROTOCOL.md 5.6).
        if (!this.spec.final || onResponse === 0) return;
      } catch (err) {
        if (this.signal?.aborted) throw this.aborted(); // Node surfaces a mid-body abort as Error('aborted')
        if (ended || (err as Error)?.name === 'AbortError' || err === undefined || (err as { $fault?: unknown }).$fault || err instanceof SyntaxError) throw err;
        // Transport error mid-stream: resume.
      }
      if (this.signal?.aborted) throw this.aborted();
      if (!this.resume || ++this.reconnects > this.maxReconnects)
        throw this.spec.toError({ status: 0, code: 'STREAM_LOST', title: 'The stream dropped and could not be resumed' });
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
