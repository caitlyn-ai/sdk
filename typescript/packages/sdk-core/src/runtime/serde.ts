// The serde helpers the runtime needs, on the platform's own APIs (TextEncoder, atob, crypto), in place of
// @smithy/core/serde's. Each behaves as the @smithy/core function it replaces does for the values a Caitlyn
// response or request can hold.
const encoder = new TextEncoder();

/** The byte length of a request body, for Content-Length. */
export function calculateBodyLength(body: any): number {
  if (typeof body === 'string') return encoder.encode(body).byteLength;
  if (typeof body?.byteLength === 'number') return body.byteLength;
  if (typeof body?.size === 'number') return body.size;
  throw new Error(`Body Length computation failed for ${body}`);
}

export const fromUtf8 = (s: string): Uint8Array => encoder.encode(s);
export const toUtf8 = (b: Uint8Array | string): string => (typeof b === 'string' ? b : new TextDecoder().decode(b));

export function toBase64(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? fromUtf8(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The browser build reads response bodies as they come (ReadableStream), so the stream needs no mixin. */
export const sdkStreamMixin = <T>(stream: T): T => stream;

/** A random (version 4) UUID, from crypto.getRandomValues, which pages served over plain HTTP have too. */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Every byte of a body: bytes, text, a Blob or a ReadableStream. */
export async function collectBody(body: unknown, context?: { streamCollector?: (b: unknown) => Promise<Uint8Array> }): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return fromUtf8(body);
  if (!body) return new Uint8Array();
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (typeof (body as ReadableStream).getReader === 'function') return new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
  if (context?.streamCollector) return context.streamCollector(body);
  throw new Error('Caitlyn: cannot read a response body of this type');
}

/** A `streamCollector` for the client configuration. */
export const streamCollector = (body: unknown) => collectBody(body);

// ---------------------------------------------------------------------------------------------- timestamps

// The model's one timestamp format is RFC 3339 date-time (PROTOCOL.md: "Timestamps"); its numbers are plain JSON.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(([-+]\d{2}:\d{2})|[zZ])$/;

function range(value: string, what: string, lo: number, hi: number): number {
  const n = Number(value);
  if (!(n >= lo && n <= hi)) throw new TypeError(`${what} must be between ${lo} and ${hi}, inclusive`);
  return n;
}

/** An RFC 3339 date-time with an offset or Z, strictly, as @smithy/core's parseRfc3339DateTimeWithOffset reads it. */
export function parseDateTime(value: unknown): Date | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new TypeError('RFC-3339 date-times must be expressed as strings');
  const m = RFC3339.exec(value);
  if (!m) throw new TypeError('Invalid RFC-3339 date-time value');
  const year = Number(m[1]);
  const month = range(m[2]!, 'month', 1, 12);
  const day = range(m[3]!, 'day', 1, 31);
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new TypeError(`Invalid day for month ${month} in ${year}: ${day}`);
  const date = new Date(Date.UTC(year, month - 1, day, range(m[4]!, 'hour', 0, 23), range(m[5]!, 'minute', 0, 59), range(m[6]!, 'seconds', 0, 60), m[7] ? parseFloat(`0.${m[7]}`) * 1000 : 0));
  const offset = m[8]!;
  if (offset.toUpperCase() !== 'Z') date.setTime(date.getTime() - (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60_000);
  return date;
}

/** A timestamp as RFC 3339 date-time, milliseconds dropped when zero (as smithy-typescript writes it). */
export const writeDateTime = (d: Date) => d.toISOString().replace('.000Z', 'Z');

// ---------------------------------------------------------------------------------------------- headers

/** A comma-separated header value as its items, honouring quoted strings (@smithy/core's splitHeader). */
export function splitHeader(value: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let prev: string | undefined;
  let anchor = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"' && prev !== '\\') quoted = !quoted;
    else if (c === ',' && !quoted) {
      out.push(value.slice(anchor, i));
      anchor = i + 1;
    }
    prev = c;
  }
  out.push(value.slice(anchor));
  return out.map((v) => {
    v = v.trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    return v.replace(/\\"/g, '"');
  });
}

export const quoteHeader = (part: string) => (part.includes(',') || part.includes('"') ? `"${part.replace(/"/g, '\\"')}"` : part);
