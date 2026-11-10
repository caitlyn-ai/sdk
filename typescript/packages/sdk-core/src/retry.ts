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
