// The waiter runtime (the runtime half of @waitable). Generated waitUntil…() methods are checked by the shared
// conformance cases once the model has @waitable operations (lane K4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil, WaiterError } from '@caitlyn-ai/sdk-core';

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

test('[waiter.success] polls until a success acceptor matches and returns that output', async () => {
  const out = await waitUntil('waitUntilIndexed', sequence([{ status: 'queued' }, { status: 'indexing' }, { status: 'indexed' }]), byStatus, fast);
  assert.equal(out.status, 'indexed');
});

test('[waiter.failure] a failure acceptor throws WaiterError with the last output', async () => {
  const err = await waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }, { status: 'failed' }]), byStatus, fast).catch((e) => e);
  assert.ok(err instanceof WaiterError);
  assert.equal(err.reason, 'failure');
  assert.deepEqual(err.last, { status: 'failed' });
  assert.equal(err.attempts, 2);
});

test('[waiter.error-acceptor] an error an acceptor matches is retried; one it does not is thrown', async () => {
  const notYet = Object.assign(new Error('not found'), { status: 404 });
  const out = await waitUntil('waitUntilIndexed', sequence<any>([notYet, { status: 'indexed' }]), byStatus, fast);
  assert.equal(out?.status, 'indexed');
  const fatal = Object.assign(new Error('denied'), { status: 403 });
  await assert.rejects(waitUntil('waitUntilIndexed', sequence<any>([fatal]), byStatus, fast), fatal);
});

test('[waiter.max-wait] maxWaitMs ends the wait with a timeout WaiterError', async () => {
  const err = await waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }]), byStatus, { ...fast, maxWaitMs: 60 }).catch((e) => e);
  assert.ok(err instanceof WaiterError);
  assert.equal(err.reason, 'timeout');
});

test('[waiter.signal] an aborted signal stops the wait with its reason, mid-delay', async () => {
  const signal = AbortSignal.timeout(50);
  const t0 = Date.now();
  await assert.rejects(waitUntil('waitUntilIndexed', sequence([{ status: 'indexing' }]), byStatus, { signal, minDelayMs: 10_000 }), (e: any) => e.name === 'TimeoutError');
  assert.ok(Date.now() - t0 < 2_000);
});

test('[waiter.backoff] delays grow from minDelay and stay under maxDelay', async () => {
  const at: number[] = [];
  const read = async () => (at.push(Date.now()), at.length < 5 ? { status: 'indexing' } : { status: 'indexed' });
  await waitUntil('waitUntilIndexed', read, byStatus, { minDelayMs: 10, maxDelayMs: 40 });
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  for (const g of gaps) assert.ok(g >= 9 && g < 120, `gap ${g} ms`);
});
