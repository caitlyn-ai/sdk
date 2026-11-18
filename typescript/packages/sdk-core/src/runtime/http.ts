// The fetch request handler (every build's default, Node's included), the Content-Length middleware and the HTTP
// handler extension configuration, ported from @smithy/fetch-http-handler and @smithy/core/protocols. Those
// packages reach their modules through @smithy/core/protocols, whose HttpProtocol loads AWS event-stream support on
// demand, so a bundler emits that code even though nothing calls it; these do the same work without it. Any
// object with handle(request), including @smithy/fetch-http-handler's own FetchHttpHandler and @smithy/node-http-
// handler's NodeHttpHandler, still works as `requestHandler`.
import { HttpRequest, HttpResponse } from '@smithy/core/transport';
import type { Pluggable } from '@smithy/types';

const escape = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A query string, keys sorted, as @smithy/core's buildQueryString writes it. */
export function buildQueryString(query: Record<string, string | string[] | null | undefined>): string {
  const parts: string[] = [];
  for (const k of Object.keys(query).sort()) {
    const value = query[k];
    const key = escape(k);
    if (Array.isArray(value)) for (const v of value) parts.push(`${key}=${escape(v)}`);
    else parts.push(value || typeof value === 'string' ? `${key}=${escape(value)}` : key);
  }
  return parts.join('&');
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal && typeof signal === 'object' && 'reason' in signal ? signal.reason : undefined;
  const e = new Error(reason && !(reason instanceof Error) ? String(reason) : 'Request aborted');
  e.name = 'AbortError';
  if (reason instanceof Error) e.cause = reason;
  return e;
}

/**
 * How long a request waits for its response's headers before it fails as a connection failure with no response,
 * retried as PROTOCOL.md 6.4 says, unless `requestTimeout` says otherwise: 120 s. Only the headers are timed, never the
 * body, so a stream, a watch and a wait stay open while events or keep-alives arrive. `requestTimeout: 0` turns it off.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** "120 s", "1.5 s", "300 ms": a timeout as the messages give it. */
export const formatTimeout = (ms: number) => (ms >= 1000 ? `${Number((ms / 1000).toFixed(3))} s` : `${ms} ms`);

export interface FetchHttpHandlerOptions {
  /** Milliseconds to wait for the response's headers (default 120 000; 0 waits as long as it takes). Never limits reading the body. */
  requestTimeout?: number;
  keepAlive?: boolean;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  requestInit?: (request: HttpRequest) => RequestInit;
  customFetch?: typeof fetch;
}

let keepAliveSupported: boolean | undefined;

/** The header the fetch handler puts on a redirect a browser hid from the page, for the protocol to raise. */
export const OPAQUE_REDIRECT = 'x-caitlyn-opaque-redirect';

/** @smithy/fetch-http-handler's FetchHttpHandler, with the same options and behaviour. */
export class FetchHttpHandler {
  private config?: FetchHttpHandlerOptions;
  private configProvider: Promise<FetchHttpHandlerOptions>;

  static create(instanceOrOptions?: unknown) {
    if (typeof (instanceOrOptions as { handle?: unknown })?.handle === 'function') return instanceOrOptions;
    return new FetchHttpHandler(instanceOrOptions as FetchHttpHandlerOptions);
  }

  constructor(options?: FetchHttpHandlerOptions | (() => Promise<FetchHttpHandlerOptions | undefined>)) {
    if (typeof options === 'function') this.configProvider = options().then((o) => o || {});
    else {
      this.config = options ?? {};
      this.configProvider = Promise.resolve(this.config);
    }
    keepAliveSupported ??= typeof Request !== 'undefined' && 'keepalive' in new Request('https://[::1]');
  }

  destroy(): void {}

  async handle(request: HttpRequest, { abortSignal, requestTimeout }: { abortSignal?: AbortSignal; requestTimeout?: number } = {}): Promise<{ response: HttpResponse }> {
    this.config ??= await this.configProvider;
    const config = this.config;
    if (abortSignal?.aborted) throw abortError(abortSignal);
    let path = request.path;
    const query = buildQueryString((request.query ?? {}) as Record<string, string | string[]>);
    if (query) path += `?${query}`;
    if (request.fragment) path += `#${request.fragment}`;
    const auth = request.username != null || request.password != null ? `${request.username ?? ''}:${request.password ?? ''}@` : '';
    const url = `${request.protocol}//${auth}${request.hostname}${request.port ? `:${request.port}` : ''}${path}`;
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
    const init: RequestInit & { duplex?: string } = { body, headers: new Headers(request.headers), method: request.method, credentials: config.credentials };
    if (config.cache) init.cache = config.cache;
    if (body) init.duplex = 'half';
    // The request's own controller: the caller's signal and the timeout both abort it, so a request that times out is
    // aborted and its connection closed, not left open behind a rejected promise.
    const own = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    // The forwarding stays for the response's life, so cancelling the caller's signal still stops a stream's body, and
    // is removed once that body is read, cancelled or fails, or the request fails: a signal reused for many calls
    // keeps no listener from the calls that have finished.
    let release = () => {};
    if (own && abortSignal) {
      const forward = () => own.abort((abortSignal as AbortSignal & { reason?: unknown }).reason);
      abortSignal.addEventListener('abort', forward, { once: true });
      release = () => abortSignal.removeEventListener('abort', forward);
    }
    if (own) init.signal = own.signal;
    if (keepAliveSupported) init.keepalive = config.keepAlive === true;
    // The API answers a redirect only where it means to hand out an address (GetDocumentContent's 302, which the SDK
    // returns and never follows): see it, rather than fetch what it points at.
    init.redirect = 'manual';
    if (typeof config.requestInit === 'function') Object.assign(init, config.requestInit(request));

    const timeoutMs = requestTimeout ?? config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => {};
    const race: Promise<{ response: HttpResponse }>[] = [
      (config.customFetch ?? fetch)(new Request(url, init)).then(async (res) => {
        // A browser hides a redirect's status, headers and body from a page (an opaque redirect). It is a response, so
        // never a connection error and never retried: the protocol raises REDIRECT_UNREADABLE for it (PROTOCOL.md 16).
        if (res.type === 'opaqueredirect') {
          release();
          return { response: new HttpResponse({ headers: { [OPAQUE_REDIRECT]: '1' }, statusCode: 0, body: new Uint8Array() }) };
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        let responseBody: ReadableStream<Uint8Array> | Blob;
        if (res.body) responseBody = untilDone(res.body, release);
        else {
          responseBody = await res.blob();
          release();
        }
        return { response: new HttpResponse({ headers, reason: res.statusText, statusCode: res.status, body: responseBody }) };
      }),
      new Promise((_, reject) => {
        if (timeoutMs)
          timer = setTimeout(() => {
            const timedOut = Object.assign(new Error(`no response headers within ${formatTimeout(timeoutMs)}`), { name: 'TimeoutError' });
            reject(timedOut);
            own?.abort(timedOut);
          }, timeoutMs);
      }),
    ];
    if (abortSignal) {
      race.push(
        new Promise((_, reject) => {
          const onAbort = () => reject(abortError(abortSignal));
          abortSignal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => abortSignal.removeEventListener('abort', onAbort);
        }),
      );
    }
    return Promise.race(race)
      .catch((e: unknown) => {
        release();
        throw e;
      })
      .finally(() => {
        clearTimeout(timer);
        removeAbort();
      });
  }

  updateHttpClientConfig(key: keyof FetchHttpHandlerOptions, value: never): void {
    this.config = undefined;
    this.configProvider = this.configProvider.then((c) => Object.assign(c, { [key]: value }));
  }

  httpHandlerConfigs(): FetchHttpHandlerOptions {
    return this.config ?? {};
  }
}

/** The body as it is read, calling `done` once when it ends, fails or is cancelled. */
function untilDone(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          done();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (e) {
        done();
        controller.error(e);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}

/** Sets Content-Length from the body, when the request has a body and no Content-Length. */
export function getContentLengthPlugin(options: { bodyLengthChecker: (body: unknown) => number | undefined }): Pluggable<any, any> {
  return {
    applyToStack(stack) {
      stack.add(
        (next: any) => async (args: any) => {
          const request = args.request;
          if (HttpRequest.isInstance(request) && request.body && !Object.keys(request.headers).some((h) => h.toLowerCase() === 'content-length')) {
            try {
              const length = options.bodyLengthChecker(request.body);
              if (length != null) request.headers = { ...request.headers, 'content-length': String(length) };
            } catch {
              // no length: the handler sends the body without one
            }
          }
          return next({ ...args, request });
        },
        { step: 'build', tags: ['SET_CONTENT_LENGTH', 'CONTENT_LENGTH'], name: 'contentLengthMiddleware', override: true },
      );
    },
  };
}

export function getHttpHandlerExtensionConfiguration(runtimeConfig: any) {
  if (runtimeConfig.logger && runtimeConfig.logger.constructor?.name !== 'NoOpLogger') runtimeConfig.requestHandler?.updateHttpClientConfig?.(Symbol.for('logger'), runtimeConfig.logger);
  if (runtimeConfig.defaultSocketTimeout) runtimeConfig.requestHandler?.updateHttpClientConfig?.(Symbol.for('@smithy/defaultSocketTimeout'), runtimeConfig.defaultSocketTimeout);
  return {
    setHttpHandler(handler: unknown) {
      runtimeConfig.requestHandler = handler;
    },
    httpHandler() {
      return runtimeConfig.requestHandler;
    },
    updateHttpClientConfig(key: unknown, value: unknown) {
      runtimeConfig.requestHandler?.updateHttpClientConfig(key, value);
    },
    httpHandlerConfigs() {
      return runtimeConfig.requestHandler.httpHandlerConfigs();
    },
  };
}

export const resolveHttpHandlerRuntimeConfig = (c: { httpHandler(): unknown }) => ({ requestHandler: c.httpHandler() });
