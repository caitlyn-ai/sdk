// The runtime half of @waitable (smithy.waiters): poll a read operation until an acceptor matches. Generated
// waitUntil…() methods supply the read and the acceptors; this does the timing, cancellation and errors.
// The same rules as Smithy's waiter specification: exponential backoff between minDelay and maxDelay with
// jitter, a success or failure acceptor ends the wait, and an error that no acceptor matches is thrown.

export type WaiterState = 'success' | 'failure' | 'retry';

export interface WaiterOptions {
  /** Stops waiting and throws the signal's reason (use AbortSignal.timeout() for a deadline). */
  signal?: AbortSignal;
  /** The longest the waiter waits in total, in milliseconds. Default: no limit beyond the signal. */
  maxWaitMs?: number;
  /** Default 2 000 ms (Smithy's default minDelay). */
  minDelayMs?: number;
  /** Default 120 000 ms (Smithy's default maxDelay). */
  maxDelayMs?: number;
}

/** A waiter ended in a failure state, or ran out of time. `last` is the last output or error it saw. */
export class WaiterError extends Error {
  override readonly name = 'WaiterError';
  constructor(
    message: string,
    readonly reason: 'failure' | 'timeout',
    readonly last: unknown,
    readonly attempts: number,
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
 * Calls `read` until `accept` says success (returns the output) or failure (throws WaiterError).
 * `accept` sees either `{output}` or `{error}`; returning undefined for an error rethrows it.
 */
export async function waitUntil<T>(
  name: string,
  read: (signal?: AbortSignal) => Promise<T>,
  accept: (r: { output: T; error?: undefined } | { output?: undefined; error: unknown }) => WaiterState | undefined,
  opts: WaiterOptions = {},
): Promise<T> {
  const minDelay = opts.minDelayMs ?? 2_000;
  const maxDelay = Math.max(minDelay, opts.maxDelayMs ?? 120_000);
  const deadline = opts.maxWaitMs === undefined ? Infinity : Date.now() + opts.maxWaitMs;
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
      if (state === undefined || state === 'success') throw error;
    }
    if (state === 'failure') throw new WaiterError(`${name}: reached a failure state`, 'failure', last, attempt);
    // Smithy's backoff: min(maxDelay, minDelay * 2^(attempt-1)), with jitter between minDelay and that.
    const ceiling = Math.min(maxDelay, minDelay * 2 ** Math.min(attempt - 1, 30));
    let delay = minDelay + Math.random() * (ceiling - minDelay);
    const left = deadline - Date.now();
    if (left <= 0) throw new WaiterError(`${name}: did not finish within ${opts.maxWaitMs} ms`, 'timeout', last, attempt);
    delay = Math.min(delay, left);
    await sleep(delay, opts.signal);
  }
}
