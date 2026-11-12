// Server-sent events parser (WHATWG HTML "event stream interpretation"), over any async iterable of bytes.
// Hand-written runtime: Smithy's generators only speak AWS's binary event-stream framing.
export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

/**
 * A response body as an async iterable of chunks. A Node stream and a fetch body in most browsers are one already;
 * a fetch body in a browser without ReadableStream async iteration (Safari) is read with its reader.
 */
async function* chunks(body: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array | string> {
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') return yield* body as AsyncIterable<Uint8Array | string>;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export async function* parseSse(body: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | undefined;
  let event = '';
  let data: string[] = [];
  for await (const chunk of chunks(body)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1));
      if (line === '') {
        if (data.length) yield { id, event: event || 'message', data: data.join('\n') };
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\0')) id = value;
    }
  }
}
