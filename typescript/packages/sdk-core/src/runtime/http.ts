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

export interface FetchHttpHandlerOptions {
  requestTimeout?: number;
  keepAlive?: boolean;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  requestInit?: (request: HttpRequest) => RequestInit;
  customFetch?: typeof fetch;
}

let keepAliveSupported: boolean | undefined;

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
    if (typeof AbortController !== 'undefined') init.signal = abortSignal;
    if (keepAliveSupported) init.keepalive = config.keepAlive === true;
    if (typeof config.requestInit === 'function') Object.assign(init, config.requestInit(request));

    const timeoutMs = requestTimeout ?? config.requestTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => {};
    const race: Promise<{ response: HttpResponse }>[] = [
      (config.customFetch ?? fetch)(new Request(url, init)).then(async (res) => {
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        return { response: new HttpResponse({ headers, reason: res.statusText, statusCode: res.status, body: res.body ?? (await res.blob()) }) };
      }),
      new Promise((_, reject) => {
        if (timeoutMs)
          timer = setTimeout(() => reject(Object.assign(new Error(`Request did not complete within ${timeoutMs} ms`), { name: 'TimeoutError' })), timeoutMs);
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
    return Promise.race(race).finally(() => {
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
