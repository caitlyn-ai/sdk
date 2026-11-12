// The retry middleware for the browser build, in place of @smithy/core/retry, which carries AWS's standard and
// adaptive strategies, a client-side rate limiter and AWS error classification. A Caitlyn client always uses
// CaitlynRetryStrategy (../retry.ts), which decides from the error and the Retry-After hint alone, so this is
// @smithy/core's retry loop for a RetryStrategyV2: the same attempts, delays, cancellation and $metadata, and no
// amz-sdk-invocation-id or amz-sdk-request headers (the Node build adds them and getCaitlynSdkPlugin removes them).
import { HttpResponse } from '@smithy/core/transport';
import type { Pluggable, RetryErrorInfo, RetryStrategyV2 } from '@smithy/types';
import { CaitlynRetryStrategy } from '../retry.js';

const SMITHY_CONTEXT_KEY = '__smithy_context';

type Provider<T> = () => Promise<T>;
const provider = <T>(v: T | Provider<T>): Provider<T> => (typeof v === 'function' ? (v as Provider<T>) : async () => v);

export function resolveRetryConfig<T extends { maxAttempts?: number | Provider<number>; retryStrategy?: RetryStrategyV2 }>(input: T) {
  const maxAttempts = provider(input.maxAttempts ?? 3);
  const strategy = Promise.resolve(input.retryStrategy ?? new CaitlynRetryStrategy(maxAttempts));
  return Object.assign(input, { maxAttempts, retryStrategy: () => strategy });
}

/** Rejects with an AbortError when the signal fires first. */
function race<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let cleanup = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const handler = () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    if (signal.aborted) handler();
    else {
      signal.addEventListener('abort', handler, { once: true });
      cleanup = () => signal.removeEventListener('abort', handler);
    }
  });
  return Promise.race([promise, aborted]).finally(cleanup);
}

/** Retry-After, in seconds or as an HTTP date, as a time; as @smithy/core's parseRetryAfterHeader reads it. */
function retryAfter(response: unknown): Date | undefined {
  if (!HttpResponse.isInstance(response)) return undefined;
  for (const header in response.headers) {
    const h = header.toLowerCase();
    const v = response.headers[header]!;
    if (h === 'retry-after') {
      let seconds = NaN;
      if (v.endsWith('GMT')) seconds = (Date.parse(v) - Date.now()) / 1000;
      else if (/ GMT, ((\d+)|(\d+\.\d+))$/.test(v)) seconds = Number(/ GMT, ([\d.]+)$/.exec(v)?.[1]);
      else if (/^((\d+)|(\d+\.\d+))$/.test(v)) seconds = Number(v);
      else if (Date.parse(v) >= Date.now()) seconds = (Date.parse(v) - Date.now()) / 1000;
      return Number.isNaN(seconds) ? undefined : new Date(Date.now() + seconds * 1000);
    }
    if (h === 'x-amz-retry-after') return Number.isNaN(Number(v)) ? undefined : new Date(Date.now() + Number(v));
  }
  return undefined;
}

function errorInfo(error: any): RetryErrorInfo {
  const status = error?.$metadata?.httpStatusCode;
  const errorType = error?.$retryable?.throttling || status === 429 ? 'THROTTLING' : status === undefined ? 'TRANSIENT' : status >= 500 ? 'SERVER_ERROR' : 'CLIENT_ERROR';
  const hint = retryAfter(error?.$response);
  return { error, errorType, ...(hint ? { retryAfterHint: hint } : {}) };
}

const asError = (e: unknown): any => (e instanceof Error ? e : e instanceof Object ? Object.assign(new Error(), e) : new Error(typeof e === 'string' ? e : `AWS SDK error wrapper for ${e}`));

export function getRetryPlugin(options: { retryStrategy: () => Promise<RetryStrategyV2>; maxAttempts: Provider<number>; logger?: { warn?: (m: string) => void } }): Pluggable<any, any> {
  const middleware = (next: any, context: any) => async (args: any) => {
    const strategy = await options.retryStrategy();
    const signal: AbortSignal | undefined = context[SMITHY_CONTEXT_KEY]?.abortSignal;
    let token = await race(strategy.acquireInitialRetryToken((context.partition_id ?? '') + (context.__retryLongPoll ? ':longpoll' : '')), signal);
    let attempts = 0;
    let totalRetryDelay = 0;
    for (;;) {
      try {
        const { response, output } = await next(args);
        strategy.recordSuccess(token);
        output.$metadata.attempts = attempts + 1;
        output.$metadata.totalRetryDelay = totalRetryDelay;
        return { response, output };
      } catch (e) {
        const info = errorInfo(e);
        const lastError = asError(e);
        if (typeof ReadableStream !== 'undefined' && args.request?.body instanceof ReadableStream) {
          (context.logger?.constructor?.name === 'NoOpLogger' || !context.logger ? console : context.logger).warn?.('An error was encountered in a non-retryable streaming request.');
          throw lastError;
        }
        try {
          token = await race(strategy.refreshRetryTokenForRetry(token, info), signal);
        } catch (refreshError) {
          if (signal?.aborted && (refreshError as Error)?.name === 'AbortError') throw refreshError;
          lastError.$metadata ??= {};
          lastError.$metadata.attempts = attempts + 1;
          lastError.$metadata.totalRetryDelay = totalRetryDelay;
          throw lastError;
        }
        attempts = token.getRetryCount();
        const delay = token.getRetryDelay();
        totalRetryDelay += delay;
        if (delay > 0) await race(new Promise((resolve) => setTimeout(resolve, delay)), signal);
      }
    }
  };
  return {
    applyToStack(stack) {
      stack.add(middleware, { name: 'retryMiddleware', tags: ['RETRY'], step: 'finalizeRequest', priority: 'high', override: true });
    },
  };
}

/** The Node build's retry middleware adds AWS retry headers and this plugin removes them; this build adds none. */
export const getOmitRetryHeadersPlugin = (_options?: unknown): Pluggable<any, any> => ({ applyToStack() {} });
