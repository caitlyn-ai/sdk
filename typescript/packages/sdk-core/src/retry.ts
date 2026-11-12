// Caitlyn's shared retry rules (ai.caitlyn.protocols#restJson, rule 4), as a smithy-typescript RetryStrategyV2.
// - At most `maxAttempts` attempts (default 3).
// - Only operations that are @readonly, @idempotent or have an @idempotencyToken member are retried;
//   getCaitlynSdkPlugin marks errors from any other operation with NO_RETRY.
// - Retried: modelled @retryable errors (429, 503) and connection failures with no response.
// - Delay: Retry-After (seconds or HTTP-date), honoured in full up to maxRetryDelayMs (default 60 s);
//   above that, fail at once with the typed error. Without Retry-After: full-jitter exponential,
//   base 0.5 s, cap 8 s.
// - A retry budget per client (rule 6): AWS's "standard" retry quota. A retry costs 5 tokens, or 10 after a
//   failure with no response; a call that succeeds gives back its last retry's cost, or 1. When the budget cannot
//   pay, the call fails at once with its error. The first attempt is never blocked.
// The retry middleware itself sleeps for the token's delay. Both builds' retry middleware (@smithy/core's for Node,
// browser/retry.ts for browsers, once that lands) call refreshRetryTokenForRetry and recordSuccess.
import type { Provider, RetryErrorInfo, RetryStrategyV2, RetryToken } from '@smithy/types';

export const NO_RETRY = Symbol.for('caitlyn.noRetry');

/** The size of a client's retry budget, in tokens (PROTOCOL.md 6.4.6). */
export const DEFAULT_RETRY_BUDGET = 500;
const RETRY_COST = 5;
const NO_RESPONSE_RETRY_COST = 10;
const NO_RETRY_REFUND = 1;

/** The retry tokens one client's calls share (PROTOCOL.md 6.4.6). */
export class RetryBudget {
  private tokens: number;

  constructor(readonly size = DEFAULT_RETRY_BUDGET) {
    this.size = Math.max(0, Math.floor(size));
    this.tokens = this.size;
  }

  get available(): number {
    return this.tokens;
  }

  /** Takes `cost` tokens for a retry, or returns false, taking nothing, when the budget cannot pay. */
  acquire(cost: number): boolean {
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** A call succeeded: give back its last retry's cost, or 1 when it did not retry. */
  release(lastRetryCost: number): void {
    this.tokens = Math.min(this.size, this.tokens + (lastRetryCost || NO_RETRY_REFUND));
  }
}

class Token implements RetryToken {
  /** `cost` is what this call's last retry took from the budget; 0 before any retry. */
  constructor(private readonly count: number, private readonly delay: number, readonly cost = 0) {}
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

  readonly budget: RetryBudget;

  constructor(maxAttempts: number | Provider<number> = 3, private readonly maxRetryDelayMs = 60_000, retryBudget = DEFAULT_RETRY_BUDGET) {
    this.maxAttempts = typeof maxAttempts === 'number' ? async () => maxAttempts : maxAttempts;
    this.budget = new RetryBudget(retryBudget);
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
    const cost = noResponse ? NO_RESPONSE_RETRY_COST : RETRY_COST;
    if (!this.budget.acquire(cost)) throw new Error('retry: the retry budget is spent');
    return new Token(count + 1, delay, cost);
  }

  recordSuccess(token: RetryToken): void {
    this.budget.release(token instanceof Token ? token.cost : 0);
  }
}
