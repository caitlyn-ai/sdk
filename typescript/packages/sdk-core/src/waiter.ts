// The runtime half of @waitable (smithy.waiters): poll a read operation until an acceptor matches. Generated
// waitUntil…() methods supply the read and the acceptors; this does the timing, cancellation and errors.
// PROTOCOL.md 10.1, which follows Smithy's waiter specification: the first read at once, then exponential backoff
// between minDelay and maxDelay with jitter; a success acceptor returns the output; a failure acceptor, or an error
// that no acceptor matches, ends the wait with a failure WaiterError; the whole wait is limited (by default the
// waiter's @waitLimits entry, or 5 minutes), with the last pause cut to the time left; cancellation is the signal's.

export type WaiterState = 'success' | 'failure' | 'retry';

export interface WaiterOptions {
  /** Stops waiting and throws the signal's reason (use AbortSignal.timeout() for a deadline). */
  signal?: AbortSignal;
  /**
   * The longest the waiter waits in total, in milliseconds. Default: the waiter's own limit, its @waitLimits entry
   * in the model (60 minutes for a document to be indexed, say), or 5 minutes for a waiter without one.
   */
  maxWaitMs?: number;
  /** Default 2 000 ms (Smithy's default minDelay). */
  minDelayMs?: number;
  /** Default 120 000 ms (Smithy's default maxDelay). */
  maxDelayMs?: number;
}

/** The limit of a waiter with no @waitLimits entry (PROTOCOL.md 10.1). */
export const DEFAULT_WAIT_LIMIT_MS = 300_000;

/**
 * A waiter ended in a failure state (a failure acceptor matched, or an error no acceptor matches), or ran out of
 * time. `last` is the last output or error it saw, and `attempts` the number of reads.
 */
export class WaiterError extends Error {
  override readonly name = 'WaiterError';
  constructor(
    message: string,
    readonly reason: 'failure' | 'timeout',
    readonly last: unknown,
    readonly attempts: number,
    /** The waiter's name, for example `waitUntilIndexed`. */
    readonly waiter: string = '',
  ) {
    super(message);
  }
}

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

/**
 * Calls `read` until `accept` says success (returns the output, or nothing when the success is an error) or failure
 * (throws WaiterError). `accept` sees
 * either `{output}` or `{error}`; undefined for an output means poll again, and for an error ends the wait with a
 * failure WaiterError carrying it. `limitMs` is the waiter's own limit (its @waitLimits entry); the caller's
 * `maxWaitMs` overrides it.
 */
export async function waitUntil<T>(
  name: string,
  read: (signal?: AbortSignal) => Promise<T>,
  accept: (r: { output: T; error?: undefined } | { output?: undefined; error: unknown }) => WaiterState | undefined,
  opts: WaiterOptions = {},
  limitMs: number = DEFAULT_WAIT_LIMIT_MS,
): Promise<T> {
  const minDelay = opts.minDelayMs ?? 2_000;
  const maxDelay = Math.max(minDelay, opts.maxDelayMs ?? 120_000);
  const limit = opts.maxWaitMs ?? limitMs;
  const deadline = Date.now() + limit;
  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    let state: WaiterState | undefined;
    let last: unknown;
    try {
      const output = await read(opts.signal);
      last = output;
      state = accept({ output }) ?? 'retry';
      if (state === 'success') return output;
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      last = error;
      state = accept({ error });
      // A waiter that succeeds on an error (Deleted succeeds on NotFoundError) has no output: it resolves with
      // nothing, and its generated method returns void (PROTOCOL.md 10.1).
      if (state === 'success') return undefined as T;
      if (state === undefined) throw new WaiterError(`${name}: failed with an error no acceptor expects: ${(error as Error)?.message ?? error}`, 'failure', error, attempt, name);
    }
    if (state === 'failure') throw new WaiterError(`${name}: reached a failure state`, 'failure', last, attempt, name);
    // Smithy's backoff: min(maxDelay, minDelay * 2^(attempt-1)), with jitter between minDelay and that.
    const ceiling = Math.min(maxDelay, minDelay * 2 ** Math.min(attempt - 1, 30));
    let delay = minDelay + Math.random() * (ceiling - minDelay);
    const left = deadline - Date.now();
    if (left <= 0) throw new WaiterError(`${name}: did not finish within ${limit} ms`, 'timeout', last, attempt, name);
    delay = Math.min(delay, left);
    await sleep(delay, opts.signal);
  }
}
