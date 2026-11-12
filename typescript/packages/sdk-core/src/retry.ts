// Caitlyn's shared retry rules (ai.caitlyn.protocols#restJson, rule 4), as a smithy-typescript RetryStrategyV2.
// - At most `maxAttempts` attempts (default 3).
// - Only operations that are @readonly, @idempotent or have an @idempotencyToken member are retried;
//   getCaitlynSdkPlugin marks errors from any other operation with NO_RETRY.
// - Retried: modelled @retryable errors (429, 503) and connection failures with no response.
// - Delay: Retry-After (seconds or HTTP-date), honoured in full up to maxRetryDelayMs (default 60 s);
//   above that, fail at once with the typed error. Without Retry-After: full-jitter exponential,
//   base 0.5 s, cap 8 s.
// The retry middleware itself sleeps for the token's delay.
import type { Provider, RetryErrorInfo, RetryStrategyV2, RetryToken } from '@smithy/types';

export const NO_RETRY = Symbol.for('caitlyn.noRetry');

class Token implements RetryToken {
  constructor(private readonly count: number, private readonly delay: number) {}
  getRetryCount() {
    return this.count;
  }
  getRetryDelay() {
    return this.delay;
  }
}

export class CaitlynRetryStrategy implements RetryStrategyV2 {
  readonly mode = 'standard';
  private readonly maxAttempts: Provider<number>;

  constructor(maxAttempts: number | Provider<number> = 3, private readonly maxRetryDelayMs = 60_000) {
    this.maxAttempts = typeof maxAttempts === 'number' ? async () => maxAttempts : maxAttempts;
  }

  async acquireInitialRetryToken(): Promise<RetryToken> {
    return new Token(0, 0);
  }

  async refreshRetryTokenForRetry(token: RetryToken, info: RetryErrorInfo): Promise<RetryToken> {
    const count = token.getRetryCount();
    const err = info.error as (Error & { [NO_RETRY]?: boolean; $retryable?: unknown; $metadata?: { httpStatusCode?: number } }) | undefined;
    if (count + 1 >= (await this.maxAttempts())) throw new Error('retry: attempts exhausted');
    if (!err || err[NO_RETRY]) throw new Error('retry: operation is not safe to retry');
    const noResponse = err.$metadata?.httpStatusCode === undefined && err.name !== 'AbortError';
    if (err.$retryable === undefined && !noResponse) throw new Error('retry: error is not retryable');
    let delay: number;
    if (info.retryAfterHint instanceof Date) {
      delay = Math.max(0, info.retryAfterHint.getTime() - Date.now());
      if (delay > this.maxRetryDelayMs) throw new Error('retry: Retry-After exceeds maxRetryDelay');
    } else {
      delay = Math.random() * Math.min(8_000, 500 * 2 ** count);
    }
    return new Token(count + 1, delay);
  }

  recordSuccess(): void {}
}

// ---------------------------------------------------------------------------------------------- the loop
// The retry loop (PROTOCOL.md 6.4) that the generated client adds through getRetryPlugin, in place of @smithy/core's
// retry middleware and AWS's standard and adaptive strategies, rate limiter and error classification: every build
// uses it. CaitlynRetryStrategy above decides; this runs the attempts, waits (cancellation interrupts the wait),
// passes each refreshed token back, and reports a success with the call's last token.
import { HttpResponse } from '@smithy/core/transport';
import type { Pluggable } from '@smithy/types';

type Lazy<T> = T | (() => Promise<T>);
const provider = <T>(v: Lazy<T>): (() => Promise<T>) => (typeof v === 'function' ? (v as () => Promise<T>) : async () => v);

/** The generated client's retry configuration: maxAttempts as a provider, and the strategy (CaitlynRetryStrategy). */
export function resolveRetryConfig<T extends { maxAttempts?: Lazy<number>; retryStrategy?: RetryStrategyV2 }>(input: T) {
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

/** Retry-After, in seconds or as an HTTP date, as the time it names. */
export function retryAfter(response: unknown): Date | undefined {
  if (!HttpResponse.isInstance(response)) return undefined;
  for (const header in response.headers) {
    if (header.toLowerCase() !== 'retry-after') continue;
    const v = response.headers[header]!.trim();
    const seconds = /^\d+(\.\d+)?$/.test(v) ? Number(v) : (Date.parse(v) - Date.now()) / 1000;
    return Number.isNaN(seconds) ? undefined : new Date(Date.now() + seconds * 1000);
  }
  return undefined;
}

const asError = (e: unknown): any => (e instanceof Error ? e : e instanceof Object ? Object.assign(new Error(), e) : new Error(String(e)));

/** A request body that can be read only once: a Node stream or a web ReadableStream. */
const isStream = (body: unknown) =>
  (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) || typeof (body as { pipe?: unknown })?.pipe === 'function';

/** The retry loop, as the generated client adds it (getRetryPlugin(config)). */
export function getRetryPlugin(options: { retryStrategy: () => Promise<RetryStrategyV2>; logger?: unknown }): Pluggable<any, any> {
  const middleware = (next: any, context: any) => async (args: any) => {
    const strategy = await options.retryStrategy();
    const signal: AbortSignal | undefined = context.__smithy_context?.abortSignal;
    let token = await race(strategy.acquireInitialRetryToken(''), signal);
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
        const lastError = asError(e);
        if (isStream(args.request?.body)) throw lastError; // its bytes are spent
        const hint = retryAfter((e as { $response?: unknown })?.$response);
        try {
          token = await race(strategy.refreshRetryTokenForRetry(token, { error: e as never, errorType: 'TRANSIENT', ...(hint ? { retryAfterHint: hint } : {}) }), signal);
        } catch (refusal) {
          if (signal?.aborted && (refusal as Error)?.name === 'AbortError') throw refusal;
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
