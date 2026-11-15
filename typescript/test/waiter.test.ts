// The waiter runtime (the runtime half of @waitable), on its own. The generated waitUntil…() methods are checked by
// the shared conformance cases waiter.* (conformance/typescript), against the mock's GetDocument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil, WaiterError, DEFAULT_WAIT_LIMIT_MS } from '@caitlyn-ai/sdk-core';

const fast = { minDelayMs: 5, maxDelayMs: 20 };
const sequence = <T>(values: T[]) => {
  let i = 0;
  return async () => {
    const v = values[Math.min(i++, values.length - 1)];
    if (v instanceof Error) throw v;
    return v;
  };
};
const byStatus = ({ output, error }: { output?: { status: string }; error?: unknown }) =>
  error ? ((error as { status?: number }).status === 404 ? 'retry' : undefined) : output!.status === 'indexed' ? 'success' : output!.status === 'failed' ? 'failure' : 'retry';

test('waitUntil, success: polls until a success acceptor matches and returns that output', async () => {
  const out = await waitUntil('waitUntilIndexed', sequence([{ status: 'queued' }, { status: 'indexing' }, { status: 'indexed' }]), byStatus, fast);
  assert.equal(out.status, 'indexed');
});

test('waitUntil, failure: a failure acceptor throws WaiterError with the last output', async () => {
  const err = await waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }, { status: 'failed' }]), byStatus, fast).catch((e) => e);
  assert.ok(err instanceof WaiterError);
  assert.equal(err.reason, 'failure');
  assert.deepEqual(err.last, { status: 'failed' });
  assert.equal(err.attempts, 2);
});

test('waitUntil, error-acceptor: an error an acceptor matches is retried; one no acceptor matches ends the wait with a failure WaiterError', async () => {
  const notYet = Object.assign(new Error('not found'), { status: 404 });
  const out = await waitUntil('waitUntilIndexed', sequence<any>([notYet, { status: 'indexed' }]), byStatus, fast);
  assert.equal(out?.status, 'indexed');
  const fatal = Object.assign(new Error('denied'), { status: 403 });
  const err = await waitUntil('waitUntilIndexed', sequence<any>([{ status: 'indexing' }, fatal]), byStatus, fast).catch((e) => e);
  assert.ok(err instanceof WaiterError, `got ${err}`);
  assert.equal(err.reason, 'failure');
  assert.equal(err.last, fatal);
  assert.equal(err.attempts, 2);
  assert.equal(err.waiter, 'waitUntilIndexed');
});

test('waitUntil, max-wait: maxWaitMs ends the wait with a timeout WaiterError', async () => {
  const err = await waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }]), byStatus, { ...fast, maxWaitMs: 60 }).catch((e) => e);
  assert.ok(err instanceof WaiterError);
  assert.equal(err.reason, 'timeout');
  assert.equal(err.waiter, 'waitUntilIndexed');
});

test('waitUntil, default-limit: the waiter\'s own limit applies by default, maxWaitMs overrides it, and 5 minutes is the fallback', async () => {
  const t0 = Date.now();
  const own = await waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }]), byStatus, fast, 60).catch((e) => e);
  assert.ok(own instanceof WaiterError && own.reason === 'timeout', `got ${own}`);
  assert.match(own.message, /within 60 ms/);
  assert.ok(Date.now() - t0 < 1_000);
  const overridden = await waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }]), byStatus, { ...fast, maxWaitMs: 40 }, 3_600_000).catch((e) => e);
  assert.match(overridden.message, /within 40 ms/);
  assert.equal(DEFAULT_WAIT_LIMIT_MS, 300_000);
});

test('waitUntil, last-pause: the last pause is cut to the time left', async () => {
  const t0 = Date.now();
  const err = await waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }]), byStatus, { minDelayMs: 10_000, maxDelayMs: 10_000, maxWaitMs: 80 }).catch((e) => e);
  assert.equal(err.reason, 'timeout');
  assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0} ms`);
});

test('waitUntil, signal: an aborted signal stops the wait with its reason, mid-delay', async () => {
  const signal = AbortSignal.timeout(50);
  const t0 = Date.now();
  await assert.rejects(waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }]), byStatus, { signal, minDelayMs: 10_000 }), (e: any) => e.name === 'TimeoutError');
  assert.ok(Date.now() - t0 < 2_000);
});

test('waitUntil, backoff: delays grow from minDelay and stay under maxDelay', async () => {
  const at: number[] = [];
  const read = async () => (at.push(Date.now()), at.length < 5 ? { status: 'indexing' } : { status: 'indexed' });
  await waitUntil('waitUntilIndexed', read, byStatus, { minDelayMs: 10, maxDelayMs: 40 });
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  for (const g of gaps) assert.ok(g >= 9 && g < 120, `gap ${g} ms`);
});

test('waitUntil, success-on-error: an error a success acceptor matches ends the wait with no output', async () => {
  const gone = Object.assign(new Error('not found'), { status: 404 });
  const accept = ({ error }: { error?: unknown }) => ((error as { status?: number })?.status === 404 ? 'success' : error ? undefined : 'retry');
  const out = await waitUntil('waitUntilDeleted', sequence<any>([{ status: 'deleting' }, gone]), accept, fast);
  assert.equal(out, undefined);
});
