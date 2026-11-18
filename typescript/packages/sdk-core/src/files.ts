// Files (PROTOCOL.md 14): the one UploadFile type every operation that takes a file accepts, how it is read
// (hashed before anything is sent, a one-shot stream spooled), and how its bytes are sent: a single file as a PUT to
// an Upload's presigned URL (core.uploads.send), a batch's files as form POSTs under its upload policy (the ingest
// helper, ingest.ts). What needs a file system (paths, streaming hashes, spooling to disk) is in files-node.ts; the
// browser build replaces it with browser/files-node.ts, which hashes with Web Crypto and spools to memory.
import { SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { recordFailure, urlWithoutQuery } from './telemetry.js';
import { hashBlob, hashBytes, pathFile, createSpool, type PathFile } from './files-node.js';
import { formatTimeout } from './runtime/http.js';

/** The largest file the API accepts: 2 GB (2,147,483,648 bytes). */
export const MAX_FILE_BYTES = 2_147_483_648;
/** A one-shot stream is spooled to memory up to this size, and to a temporary file past it. */
export const SPOOL_MEMORY_BYTES = 8 * 1024 * 1024;

/**
 * The content type for a file name's extension, from the table every SDK shares (PROTOCOL.md 14; its entries are
 * conformance/cases/content-types.json's, and the files.content-type case checks them), or
 * `application/octet-stream` for an extension not in it.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  eml: 'message/rfc822',
  flac: 'audio/flac',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  m4a: 'audio/mp4',
  markdown: 'text/markdown',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  odt: 'application/vnd.oasis.opendocument.text',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  zip: 'application/zip',
};

/** The content type the shared table gives a file name. */
export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && CONTENT_TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/** Standard base64 (with padding) as URL-safe base64 with no padding, for an object key (PROTOCOL.md 14). */
export function urlSafeBase64(standard: string): string {
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface UploadFileOptions {
  /** The file's name. Taken from the path, or the File, when not given; required for bytes and streams. */
  name?: string;
  /** The media type. Default: from the name's extension (CONTENT_TYPES). */
  contentType?: string;
  /**
   * What the caller read of the file (pages, seconds of audio or video…: the model's IngestionHints), for an estimate.
   * An estimate sends them as they are and reads nothing itself; sending the file ignores them.
   */
  hints?: Record<string, number>;
}

type Source =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'stream'; stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>; size?: number };

/**
 * A file to send: a path (outside browsers), bytes, a stream, or a Blob or File (PROTOCOL.md 14). Every operation
 * that takes a file accepts one, and also a Blob or File as it is, or a path as a string.
 */
export class UploadFile {
  private constructor(
    /** @internal */ readonly source: Source,
    readonly name: string,
    readonly contentType: string | undefined,
    /** What the caller read of the file, for an estimate (UploadFileOptions.hints). */
    readonly hints?: Record<string, number>,
  ) {}

  /** A file on disk. It is read twice (hashed, then sent), and must not change in between (FILE_CHANGED). */
  static fromPath(path: string, options: UploadFileOptions = {}): UploadFile {
    return new UploadFile({ kind: 'path', path }, options.name ?? path.split(/[\\/]/).pop()!, options.contentType, options.hints);
  }

  /** Bytes in memory. */
  static fromBytes(bytes: Uint8Array | ArrayBuffer, options: UploadFileOptions & { name: string }): UploadFile {
    return new UploadFile({ kind: 'bytes', bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }, required(options.name), options.contentType, options.hints);
  }

  /**
   * A stream that can be read once: a web ReadableStream (a fetch response's body) or any async iterable of bytes
   * (a Node stream). It is copied as it is hashed, to memory up to 8 MiB and past that to a temporary file readable
   * only by its owner, deleted when the call ends. `size`, when known, lets a file over 2 GB fail at once.
   */
  static fromStream(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options: UploadFileOptions & { name: string; size?: number }): UploadFile {
    return new UploadFile({ kind: 'stream', stream, size: options.size }, required(options.name), options.contentType, options.hints);
  }

  /** A Blob, or a browser File (whose name and type are used unless given). */
  static fromBlob(blob: Blob, options: UploadFileOptions = {}): UploadFile {
    const named = (blob as { name?: unknown }).name;
    const name = options.name ?? (typeof named === 'string' && named ? named : undefined);
    return new UploadFile({ kind: 'blob', blob }, required(name), options.contentType ?? (blob.type || undefined), options.hints);
  }

  /** The same file, carrying hints for an estimate (withHints). */
  static withHints(file: FileInput, hints: Record<string, number>): UploadFile {
    const f = UploadFile.from(file);
    return new UploadFile(f.source, f.name, f.contentType, hints);
  }

  /** An UploadFile as it is, a Blob or File, or a path. */
  static from(file: FileInput): UploadFile {
    if (file instanceof UploadFile) return file;
    if (typeof file === 'string') return UploadFile.fromPath(file);
    if (isBlob(file)) return UploadFile.fromBlob(file);
    throw new TypeError('Expected an UploadFile, a Blob or File, or a path');
  }
}

/**
 * A file that carries hints for an estimate: `withHints('./a.pdf', { pages: 12 })`. It is a file like any other, so the
 * same value serves an estimate (which sends the hints and reads nothing) and the upload (which ignores them).
 */
export function withHints(file: FileInput, hints: Record<string, number>): UploadFile {
  return UploadFile.withHints(file, hints);
}

/** What every operation that takes a file accepts. */
export type FileInput = UploadFile | Blob | string;

/** True for an UploadFile, Blob or File: the values an upload target's member takes in place of an identifier. */
export function isFileInput(v: unknown): v is FileInput {
  return v instanceof UploadFile || isBlob(v);
}

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== 'undefined' && v instanceof Blob;
}

function required(name: string | undefined): string {
  if (!name) throw new TypeError('A file name is required for bytes, streams and Blobs without one: pass { name }');
  return name;
}

/** Problem details for an error the SDK raises itself; the generated code turns them into its error classes. */
export type ToError = (problem: Record<string, unknown>) => Error;

/** A file read and hashed, ready to send. `dispose()` removes any spool file; call it whatever happens. */
export interface PreparedFile {
  name: string;
  contentType: string;
  byteSize: number;
  /** Standard base64. */
  sha256: string;
  /** The bytes to send: re-readable, so a retry sends the same bytes. */
  blob: Blob;
  /** Fails with FILE_CHANGED when a path's size or modification time changed since it was hashed. */
  check(): Promise<void>;
  dispose(): Promise<void>;
  /** The hints the caller gave the file, for an estimate. */
  hints?: Record<string, number>;
}

const tooLarge = (toError: ToError, name: string, size: number) =>
  toError({ status: 0, code: 'FILE_TOO_LARGE', title: 'The file is too large', detail: `${name} is ${size} bytes; a file can be at most 2 GB (2,147,483,648 bytes).` });

/** Reads and hashes a file (PROTOCOL.md 14). Nothing is sent. */
export async function prepareFile(input: FileInput, toError: ToError, signal?: AbortSignal): Promise<PreparedFile> {
  const prepared = await prepare(input, toError, signal);
  const hints = UploadFile.from(input).hints;
  return hints ? { ...prepared, hints } : prepared;
}

/**
 * Opens a file to send without hashing it (batch.upload, PROTOCOL.md 15): its name, content type, size and re-readable
 * bytes. `sha256` is empty; the form carries the batch item's own checksum, and storage refuses other bytes.
 */
export async function openFile(input: FileInput, toError: ToError, signal?: AbortSignal): Promise<PreparedFile> {
  return prepare(input, toError, signal, false);
}

async function prepare(input: FileInput, toError: ToError, signal?: AbortSignal, hash = true): Promise<PreparedFile> {
  try {
    return await read(input, toError, signal, hash);
  } catch (cause) {
    throw unreadable(cause, toError, UploadFile.from(input).name);
  }
}

/**
 * A file that could not be read (PROTOCOL.md 6.3): FILE_UNREADABLE, with the native error as its cause. A Caitlyn
 * error (FILE_TOO_LARGE, a typed error) and a cancellation pass as they are.
 */
export function unreadable(cause: unknown, toError: ToError, name: string): unknown {
  if ((cause as { $fault?: unknown })?.$fault || (cause as Error)?.name === 'AbortError' || (cause as { code?: unknown })?.code === 'FILE_TOO_LARGE') return cause;
  return Object.assign(toError({ status: 0, code: 'FILE_UNREADABLE', title: 'The file could not be read', detail: `${name} could not be read: ${(cause as Error)?.message ?? cause}` }), { cause });
}

async function read(input: FileInput, toError: ToError, signal?: AbortSignal, hash = true): Promise<PreparedFile> {
  const file = UploadFile.from(input);
  const src = file.source;
  const contentType = file.contentType ?? contentTypeFor(file.name);
  const done = async () => {};
  signal?.throwIfAborted();
  if (src.kind === 'path') {
    const p: PathFile = await pathFile(src.path, signal);
    if (p.byteSize > MAX_FILE_BYTES) throw tooLarge(toError, file.name, p.byteSize);
    const sha256 = hash ? await p.hash() : '';
    return {
      name: file.name,
      contentType,
      byteSize: p.byteSize,
      sha256,
      blob: p.blob,
      check: async () => {
        if (await p.changed())
          throw toError({ status: 0, code: 'FILE_CHANGED', title: 'The file changed', detail: `${src.path} changed between ${hash ? 'hashing' : 'opening'} and sending; nothing more was sent. Send it again.` });
      },
      dispose: done,
    };
  }
  if (src.kind === 'bytes') {
    if (src.bytes.byteLength > MAX_FILE_BYTES) throw tooLarge(toError, file.name, src.bytes.byteLength);
    return { name: file.name, contentType, byteSize: src.bytes.byteLength, sha256: hash ? await hashBytes(src.bytes) : '', blob: new Blob([src.bytes as BlobPart], { type: contentType }), check: done, dispose: done };
  }
  if (src.kind === 'blob') {
    if (src.blob.size > MAX_FILE_BYTES) throw tooLarge(toError, file.name, src.blob.size);
    return { name: file.name, contentType, byteSize: src.blob.size, sha256: hash ? await hashBlob(src.blob, signal) : '', blob: src.blob, check: done, dispose: done };
  }
  if (src.size !== undefined && src.size > MAX_FILE_BYTES) throw tooLarge(toError, file.name, src.size);
  const spool = createSpool(contentType, hash);
  try {
    let total = 0;
    for await (const chunk of iterate(src.stream)) {
      signal?.throwIfAborted();
      total += chunk.byteLength;
      if (total > MAX_FILE_BYTES) throw tooLarge(toError, file.name, total);
      await spool.write(chunk);
    }
    const { blob, sha256 } = await spool.finish();
    return { name: file.name, contentType, byteSize: total, sha256, blob, check: done, dispose: () => spool.dispose() };
  } catch (err) {
    await spool.dispose();
    throw err;
  }
}

/** Reads a one-shot stream through and counts its bytes, keeping and hashing nothing: an estimate's size. */
export async function measureStream(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<number> {
  let total = 0;
  for await (const chunk of iterate(stream)) {
    signal?.throwIfAborted();
    total += chunk.byteLength;
  }
  return total;
}

async function* iterate(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in stream) {
    for await (const c of stream as AsyncIterable<Uint8Array | string>) yield typeof c === 'string' ? new TextEncoder().encode(c) : c;
    return;
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------- sending, retried as a retry-safe call

/** How the bytes are retried (PROTOCOL.md 6.4): the client's attempts and longest Retry-After. */
export interface SendOptions {
  signal?: AbortSignal;
  tracer?: Tracer;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  /** How long an attempt may send and receive nothing before it is abandoned (default 60 000 ms; 0 never). */
  stallTimeoutMs?: number;
}

/**
 * The storage stall timeout (PROTOCOL.md 14): an attempt that has sent no request bytes and received no response for
 * this long is abandoned as a failure with no response, and retried. It is not an overall limit: a large file on a
 * slow link carries on while its bytes keep moving.
 */
export const STORAGE_STALL_TIMEOUT_MS = 60_000;

/** Where request bodies can be streams with a known length (Node, Deno, Bun); a browser page sends a Blob as it is. */
const STREAMED_BODIES = typeof (globalThis as { document?: unknown }).document === 'undefined' && typeof ReadableStream !== 'undefined';

/** A form field's name or file name in a part's Content-Disposition, escaped as the HTML form encoder does. */
const dispositionValue = (v: string) => v.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');

/**
 * A FormData as one multipart/form-data Blob, in the fields' order. The Blob is made of the parts' headers and the
 * file Blobs themselves, so nothing is copied or read until it is sent, and its size is known: storage refuses a
 * form sent in chunks, so the length goes in Content-Length.
 */
export function formBlob(form: FormData): { blob: Blob; contentType: string } {
  const boundary = `----caitlyn-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const parts: BlobPart[] = [];
  form.forEach((value, name) => {
    if (typeof value === 'string') {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${dispositionValue(name)}"\r\n\r\n${value}\r\n`);
    } else {
      const file = value as Blob & { name?: string };
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${dispositionValue(name)}"; filename="${dispositionValue(file.name ?? 'blob')}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
        file,
        '\r\n',
      );
    }
  });
  parts.push(`--${boundary}--\r\n`);
  return { blob: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * One attempt's request, with the stall timer fed: the body as a stream that touches it for each chunk sent, with
 * its length, where streamed bodies work; elsewhere the body as it is, and an attempt limit that grows with its size
 * (the stall timeout plus a second for each 64 KiB).
 */
function counted(init: RequestInit, touch: () => void): { init: RequestInit & { duplex?: string }; extraMs: number } {
  let blob: Blob | undefined;
  const headers = new Headers(init.headers);
  if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
    const f = formBlob(init.body);
    blob = f.blob;
    headers.set('content-type', f.contentType);
  } else if (typeof Blob !== 'undefined' && init.body instanceof Blob) {
    blob = init.body;
  }
  if (!blob) return { init, extraMs: 0 };
  if (!STREAMED_BODIES) return { init: { ...init, body: blob, headers }, extraMs: Math.ceil(blob.size / 65_536) * 1000 };
  headers.set('content-length', String(blob.size));
  // Pulled 64 KiB at a time, only as the connection takes it: a Blob's own stream can hand over a whole in-memory part
  // in one chunk, which would touch the timer once at the start and never again.
  const reader = blob.stream().getReader();
  let chunk: Uint8Array | undefined;
  let at = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(out) {
        if (!chunk || at >= chunk.byteLength) {
          const next = await reader.read();
          if (next.done) return out.close();
          chunk = next.value;
          at = 0;
        }
        const piece = chunk.subarray(at, at + 65_536);
        at += piece.byteLength;
        touch();
        out.enqueue(piece);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return { init: { ...init, body, headers, duplex: 'half' }, extraMs: 0 };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (v === null) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Sends a request to storage (a presigned PUT or a form POST), retried as a retry-safe call: 429, 500, 502, 503 and
 * 504 and connection failures, honouring Retry-After up to maxRetryDelayMs, else full-jitter backoff (base 0.5 s,
 * cap 8 s), at most maxAttempts in all. Returns the last response, which may be an error; throws only when no
 * response arrived, or on cancellation. Recorded as one `caitlyn.upload` span (PROTOCOL.md 13).
 */
export async function sendToStorage(url: string, init: () => RequestInit, opts: SendOptions = {}): Promise<Response> {
  const attempts = Math.max(1, opts.maxAttempts ?? 3);
  const maxRetryDelay = opts.maxRetryDelayMs ?? 60_000;
  const span = opts.tracer?.startSpan('caitlyn.upload', {
    kind: SpanKind.CLIENT,
    attributes: { 'http.request.method': init().method ?? 'PUT', 'server.address': new URL(url).hostname, 'url.full': urlWithoutQuery(url) },
  });
  try {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      // The stall timer (PROTOCOL.md 14), on the attempt's own controller, which the caller's signal also aborts.
      const stallMs = opts.stallTimeoutMs ?? STORAGE_STALL_TIMEOUT_MS;
      const attemptCtl = new AbortController();
      const forward = () => attemptCtl.abort(opts.signal!.reason);
      opts.signal?.addEventListener('abort', forward, { once: true });
      let stall: ReturnType<typeof setTimeout> | undefined;
      let limitMs = stallMs;
      // Set before the timer aborts the attempt, and what the failure is judged by: a fetch aborted by the timer
      // rejects with the browser's own error in WebKit ("Fetch is aborted"), not the abort's reason.
      let stalled: Error | undefined;
      const touch = () => {
        if (!stallMs) return;
        clearTimeout(stall);
        stall = setTimeout(() => {
          stalled = Object.assign(new Error(`storage sent nothing for ${formatTimeout(stallMs)}`), { name: 'TimeoutError' });
          attemptCtl.abort(stalled);
        }, limitMs);
      };
      try {
        const prepared = counted(init(), () => {
          limitMs = stallMs;
          touch();
        });
        limitMs = stallMs + prepared.extraMs;
        touch();
        res = await fetch(url, { ...prepared.init, signal: attemptCtl.signal });
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (attempt >= attempts) throw stalled ?? err;
        await sleep(Math.random() * Math.min(8_000, 500 * 2 ** (attempt - 1)), opts.signal);
        continue;
      } finally {
        // The headers arrived, or the attempt failed: the timer has done its work either way.
        clearTimeout(stall);
        opts.signal?.removeEventListener('abort', forward);
      }
      if (!RETRYABLE.has(res.status) || attempt >= attempts) {
        span?.setAttribute('http.response.status_code', res.status);
        if (!res.ok) span?.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
        return res;
      }
      const after = retryAfterMs(res);
      if (after !== undefined && after > maxRetryDelay) {
        span?.setAttribute('http.response.status_code', res.status);
        return res;
      }
      await res.body?.cancel().catch(() => {});
      await sleep(after ?? Math.random() * Math.min(8_000, 500 * 2 ** (attempt - 1)), opts.signal);
    }
  } catch (err) {
    if (span) recordFailure(span, err);
    throw err;
  } finally {
    span?.end();
  }
}

/** An Upload, as CreateUpload returns it. */
export interface UploadSlot {
  id: string;
  uploadUrl: string;
  uploadMethod: string;
  requiredHeaders: Record<string, string>;
}

/** What CreateUpload needs to reserve the slot for a file. */
export interface UploadMeta {
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}

/**
 * core.uploads.send(file) (@presignedUpload): hash the file, reserve the upload with `reserve`, check that a path has
 * not changed, then PUT the bytes with exactly the slot's requiredHeaders, retried; UPLOAD_PUT_FAILED when the PUT
 * still fails. Returns the Upload. A spool file is removed when the call ends, whatever happens.
 */
export async function sendFile<S extends UploadSlot>(file: FileInput, reserve: (meta: UploadMeta) => Promise<S>, toError: ToError, opts: SendOptions = {}): Promise<S> {
  const prepared = await prepareFile(file, toError, opts.signal);
  try {
    const slot = await reserve({ fileName: prepared.name, contentType: prepared.contentType, byteSize: prepared.byteSize, sha256: prepared.sha256 });
    await prepared.check();
    let res: Response;
    try {
      res = await sendToStorage(slot.uploadUrl, () => ({ method: slot.uploadMethod || 'PUT', headers: slot.requiredHeaders, body: prepared.blob }), opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw Object.assign(toError({ status: 0, code: 'UPLOAD_PUT_FAILED', title: 'Uploading the bytes failed', detail: `No response from storage: ${(err as Error)?.message ?? err}` }), { cause: err });
    }
    if (!res.ok) throw toError({ status: res.status, code: 'UPLOAD_PUT_FAILED', title: 'Uploading the bytes failed', detail: await res.text() });
    return slot;
  } finally {
    await prepared.dispose();
  }
}

/**
 * @uploadTarget: when `input` holds a file at `path` (a top-level target takes it as `file`, in place of the
 * identifier member), uploads it with `send` and returns a copy of the input with the upload's id there. The caller's
 * input is never changed. An identifier already there is sent as it is.
 */
export async function resolveUploadTarget<T>(input: T, path: string[], send: (file: FileInput) => Promise<{ id: string }>): Promise<T> {
  const top = path.length === 1;
  if (top) {
    const { file, ...rest } = input as Record<string, unknown>;
    if (file === undefined) return input;
    if (!isFileInput(file) && typeof file !== 'string') throw new TypeError('file: expected an UploadFile, a Blob or File, or a path');
    return { ...rest, [path[0]]: (await send(file as FileInput)).id } as T;
  }
  const copy = { ...(input as Record<string, unknown>) };
  let at: Record<string, unknown> = copy;
  for (const seg of path.slice(0, -1)) {
    const next = at[seg];
    if (next === null || typeof next !== 'object') return input;
    at = at[seg] = { ...(next as Record<string, unknown>) };
  }
  const leaf = path[path.length - 1];
  if (isFileInput(at[leaf])) at[leaf] = (await send(at[leaf] as FileInput)).id;
  return copy as T;
}

/** A message attachment as the caller gives it: a file (any of the sources above) or an upload already made. */
export type AttachmentInput = FileInput | { uploadId: string };

/**
 * A message's attachments (PROTOCOL.md 16, "Attachments"): each file uploaded with `send` (reserved for the
 * conversation), each `{uploadId}` as it is, in the order given. The first upload that fails raises its error, so no
 * message is sent.
 */
export async function uploadAttachments(entries: readonly AttachmentInput[] | undefined, send: (file: FileInput) => Promise<{ id: string }>): Promise<{ uploadId: string }[] | undefined> {
  if (entries === undefined) return undefined;
  const out: { uploadId: string }[] = [];
  for (const entry of entries) {
    if (typeof entry === 'object' && entry !== null && !isFileInput(entry) && typeof (entry as { uploadId?: unknown }).uploadId === 'string') out.push({ uploadId: (entry as { uploadId: string }).uploadId });
    else out.push({ uploadId: (await send(entry as FileInput)).id });
  }
  return out;
}
