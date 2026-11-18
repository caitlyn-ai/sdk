// TypeScript conformance harness: the protocol cases in conformance/cases/protocol.json and the example
// cases in conformance/cases/examples.json, against the mock server. Test names start with the case id in
// square brackets; scripts/check-conformance.mjs checks that every case ran and passed.
//
// It also runs against the browser build (CAITLYN_SDK_BUILD=browser): in Node (typescript/dist/
// conformance-browser.test.mjs) and in real browsers (conformance/typescript/browser/run.mjs, which starts the mock
// server itself and passes its port as CAITLYN_MOCK_PORT). There, the cases that sign in with a mode a browser may
// not use pass only if the browser build refuses the mode before sending anything (PROTOCOL.md 12.6), and the
// [browser.*] tests cover the same sign-in behaviour with oauth and no client secret.
import { test as nodeTest, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  Caitlyn,
  CaitlynConnectionError,
  CaitlynError,
  ConflictError,
  ErrorCode,
  ReadersKind,
  NotFoundError,
  NotSupportedByServer,
  PreconditionFailedError,
  ServiceUnavailableError,
  ValidationError,
  CaitlynAuthError,
  UnprocessableContentError,
  UploadFile,
  WorkPromise,
  contentTypeFor,
  isSyncAborted,
  withHints,
  type BatchUpload,
  type IngestionBatchItem,
  type KnowledgeBase,
  type Document as CaitlynDocument,
  type Folder,
  type IngestionBatch,
  type SyncItemInput,
  type SyncPlan,
  type SyncReport,
  type AuthOptions,
  type CaitlynErrorFields,
  type OAuthTokens,
  type TokenStore,
} from '@caitlyn-ai/sdk';
import { CONTENT_TYPES, LONG_CONNECTION_MS, streamClock, describeFile, rereadAtDeadline, batchDeadline, DEADLINE_GRACE_MS, estimateSync, sync as coreSync, type SyncDeps } from '@caitlyn-ai/sdk-core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { propagation, SpanStatusCode } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { MOCK_AWS, MOCK_CLIENT, MOCK_OAUTH_CLIENT, MOCK_PAT, MOCK_SESSION_COOKIE, mockOidcToken } from '../mock-server/auth.mjs';

const ROOT = process.env.CAITLYN_REPO_ROOT ?? path.resolve(import.meta.dirname, '../..');
const EXAMPLES: ExampleCase[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'conformance/cases/examples.json'), 'utf8')).cases;
const SDK_VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); // every SDK sends it in its user agent
const SDK_MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'model/model.lock.json'), 'utf8')).stampNext as string;
const PORT = Number(process.env.CAITLYN_MOCK_PORT) || 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;

/** The SDK under test is the browser build. */
const BROWSER_BUILD = process.env.CAITLYN_SDK_BUILD === 'browser';
/** The harness runs in a browser page, not in Node. */
const IN_PAGE = typeof (globalThis as { document?: unknown }).document !== 'undefined';

/** Cases that sign in with clientCredentials, oauth with a client secret, awsIam or workloadIdentity. */
const SERVER_SIGN_IN = new Set([
  'auth.workspace',
  'auth.client-credentials',
  'auth.client-credentials-refused',
  'auth.renew-before-expiry',
  'auth.401-signs-in-again',
  'auth.401-once',
  'auth.oauth-sign-in',
  'auth.aws-iam',
  'auth.aws-iam-provider',
  'auth.aws-iam-env',
  'auth.aws-iam-bad-signature',
  'auth.aws-iam-no-credentials',
  'auth.workload-identity',
  'auth.workload-identity-single-use',
]);

/** Cases a browser page cannot run at all, and why. */
const NOT_IN_A_PAGE: Record<string, string> = {
  'environment.hostile-aws': 'a page has no environment variables or ~/.aws files',
  'auth.session': 'a page cannot set Cookie or Origin: the browser sends its own',
  'files.changed': 'a page reads no paths, so a file cannot change between hashing and sending',
};

/** Cases that need a file system, which the browser build has none of in Node either. */
const NEEDS_FILES = new Set(['files.changed']);
/** Cases a browser page cannot run, though the browser build in Node can. */
const PAGE_ONLY_LIMITS = new Set<string>();

function test(name: string, fn: () => Promise<void>): void {
  const id = /^\[([^\]]+)\]/.exec(name)?.[1] ?? '';
  if ((IN_PAGE || (BROWSER_BUILD && NEEDS_FILES.has(id))) && NOT_IN_A_PAGE[id] && (IN_PAGE || !PAGE_ONLY_LIMITS.has(id))) return void nodeTest(name, { skip: NOT_IN_A_PAGE[id] }, fn);
  if (!BROWSER_BUILD || !SERVER_SIGN_IN.has(id)) return void nodeTest(name, fn);
  // The browser build leaves these modes out: it must refuse them when the client is created, before any request.
  nodeTest(name, async () => {
    await assert.rejects(fn(), (e: unknown) => e instanceof CaitlynAuthError && e.code === 'not_allowed_in_browser');
    assert.deepEqual(await requests(), [], 'nothing was sent');
  });
}

interface ExampleCase {
  id: string;
  operation: string;
  input: Record<string, unknown>;
  response: { stream?: boolean; status?: number };
  expected: { output?: Record<string, unknown> | null; error?: { status: number; code: string; shape: string; requestId: string } };
}

before(async () => {
  if (process.env.CAITLYN_MOCK_PORT) return; // started by the caller
  server = spawn(process.execPath, [path.join(ROOT, 'conformance/mock-server/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => server!.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));
});
after(() => server?.kill());
beforeEach(async () => {
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
});

const faults = (f: unknown) => fetch(`${BASE}/__mock/faults`, { method: 'POST', body: JSON.stringify(f) });
const requests = async (): Promise<any[]> => (await fetch(`${BASE}/__mock/requests`)).json();
const api = async (): Promise<any[]> => (await requests()).filter((r) => r.path?.startsWith('/v3/'));
const client = (extra: Record<string, unknown> = {}) =>
  new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'pat_test' }, endpoint: BASE, ...extra } as never);

type Err = CaitlynError & CaitlynErrorFields;

async function expectError(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof CaitlynError, `expected CaitlynError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
    return err as Err;
  }
  assert.fail('expected an error');
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ---------------------------------------------------------------- retries

test('[retry.429-retry-after] a 429 with Retry-After 2 waits at least 2 s, then succeeds', async () => {
  await faults({ status: { ListDocuments: [{ status: 429, retryAfter: 2 }] } });
  const t0 = Date.now();
  const docs = await collect(client().knowledgeBases('KB4T7YQ2WL').documents.list({ limit: 100 }));
  const elapsed = Date.now() - t0;
  assert.equal(docs.length, 7);
  assert.ok(elapsed >= 2000, `waited ${elapsed} ms`);
  assert.equal((await api()).length, 2);
});

test('[retry.503-retry-after] a 503 with Retry-After 1 waits at least 1 s, then succeeds', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 1 }] } });
  const t0 = Date.now();
  const v = await client().agents('GHT7YRWXPL').draft.get();
  assert.equal(v.name, 'draft');
  assert.ok(Date.now() - t0 >= 1000);
});

test('[retry.long-retry-after] a long Retry-After (7 s) is honoured in full', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 7 }] } });
  const t0 = Date.now();
  await client().agents('GHT7YRWXPL').draft.get();
  assert.ok(Date.now() - t0 >= 7000, `waited ${Date.now() - t0} ms`);
});

const fault503 = (n: number) => Array.from({ length: n }, () => ({ status: 503, retryAfter: 0 }));
const getDraft = (c: Caitlyn) => c.agents('GHT7YRWXPL').draft.get();

test('[retry.budget-drains] two retries spend a budget of 10; the next 503 fails at once; no response costs 10', async () => {
  const c = client({ retryBudget: 10 });
  await faults({ status: { GetAgentVersion: fault503(4) } });
  assert.ok((await expectError(getDraft(c))) instanceof ServiceUnavailableError, 'the first call ends with the 503');
  assert.equal((await api()).length, 3, 'two retries, 5 tokens each');
  const spent = await expectError(getDraft(c));
  assert.ok(spent instanceof ServiceUnavailableError, `the second call ends with the 503, not ${spent?.constructor?.name}`);
  assert.equal(spent.$metadata.attempts, 1, 'the budget is spent: no retry');
  assert.equal((await api()).length, 4, 'exactly one more request');
  // A retry after no response costs 10: a budget of 9 pays for a 503's retry but not this one. A browser resends a
  // request whose connection closed before any response by itself, so in a page the mock closes it every time
  // (as in errors.connection). The SDK's own attempts are counted wherever it runs; the requests the server saw
  // can be checked exactly only outside a page.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ status: { GetAgentVersion: IN_PAGE ? Array.from({ length: 10 }, () => ({ close: true })) : [{ close: true }] } });
  const lost = await expectError(getDraft(client({ retryBudget: 9 })));
  assert.ok(lost instanceof CaitlynConnectionError, `a connection error, not ${(lost as Error)?.constructor?.name}`);
  assert.equal(lost.$metadata.attempts, 1, 'no retry: the budget of 9 cannot pay 10');
  if (IN_PAGE) assert.ok((await api()).length >= 1, 'the server saw the request');
  else assert.equal((await api()).length, 1);
});

test('[retry.budget-refund] a call that succeeds after a retry refunds it, so the next call can retry too', async () => {
  const c = client({ retryBudget: 5 });
  await faults({ status: { GetAgentVersion: fault503(1) } });
  await getDraft(c); // retried once, then refunded
  await faults({ status: { GetAgentVersion: fault503(1) } });
  assert.equal((await getDraft(c)).name, 'draft');
  assert.equal((await api()).length, 4);
});

test('[retry.budget-first-attempt] with an empty budget the first attempt still goes', async () => {
  const c = client({ retryBudget: 0 });
  assert.equal((await getDraft(c)).name, 'draft');
  await faults({ status: { GetAgentVersion: fault503(1) } });
  assert.ok((await expectError(getDraft(c))) instanceof ServiceUnavailableError);
  assert.equal((await api()).length, 2);
});

test('[retry.idempotency-key-kept] the idempotency key is generated once and kept across retries', async () => {
  await faults({ status: { CreateUpload: [{ status: 503, retryAfter: 0 }] } });
  await client().core.uploads.reserve({ fileName: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' });
  const sent = (await api()).filter((r) => r.path === '/v3/uploads');
  assert.equal(sent.length, 2);
  assert.match(sent[0].headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  assert.equal(sent[0].headers['idempotency-key'], sent[1].headers['idempotency-key']);
});

test('[retry.unsafe-not-retried] an operation that is not retry-safe (SendMessage) is sent once on a 503', async () => {
  await faults({ status: { SendMessage: [{ status: 503, retryAfter: 0 }] } });
  const err = await expectError(collect(client().conversations('c-1').send('hi')));
  assert.equal(err.status, 503);
  assert.ok(err instanceof ServiceUnavailableError);
  assert.equal((await api()).length, 1);
});

test('[retry.above-max-retry-delay] a Retry-After above maxRetryDelay fails at once with the typed error', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 429, retryAfter: 120 }] } });
  const t0 = Date.now();
  const err = await expectError(client().agents('GHT7YRWXPL').draft.get());
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterSeconds, 120);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((await api()).length, 1);
});

// ---------------------------------------------------------------- pagination

test('[pagination.to-last-page] a list runs to the last page, following nextCursor', async () => {
  const docs = await collect(client().knowledgeBases('KB4T7YQ2WL').documents.list({ limit: 3 }));
  assert.equal(docs.length, 7);
  const reqs = await api();
  assert.equal(reqs.length, 3);
  assert.ok(!reqs[0].query.includes('cursor='));
  assert.ok(reqs[2].query.includes('cursor='));
});

// ---------------------------------------------------------------- SSE

test('[sse.resumed-answer-reset] a stream with a final event, resumed after its answer finished, yields stream.reset and ends with no error', async () => {
  // The mock cuts the stream only once the SDK has yielded the two events before the cut, so it always has an
  // event ID to resume from (a browser can lose events it had buffered when a connection is cut).
  await faults({ dropAfterEvents: 2, dropOnSignal: true, finishWhileAway: true });
  const stream = client().conversations('c-away').send('hi');
  const events: { type: string }[] = [];
  for await (const event of stream) {
    events.push(event);
    if (events.length === 2) await fetch(`${BASE}/__mock/drop`, { method: 'POST' });
  }
  assert.equal(events.at(-1)?.type, 'stream.reset');
  assert.equal(events.length, 3, 'two events, then the reset');
  assert.equal((await api()).filter((r) => r.method === 'GET').length, 1, 'one reconnect, and none after the reset');
  assert.equal((await expectError(stream.finalMessage())).code, 'NO_FINAL_EVENT');
});

test('[sse.watch-reconnects] a watch the server ends cleanly reconnects with Last-Event-ID, as often as each reconnect carries events', async () => {
  const c = client();
  await collect(c.conversations('c-w').send('hi'));
  await faults({ watchCloses: 7 });
  const events: { type: string; eventId?: string }[] = [];
  for await (const event of c.conversations('c-w').watch()) {
    events.push(event);
    if (event.type === 'message.completed') break;
  }
  assert.deepEqual(events.map((e) => e.type), ['message.started', 'progress.updated', 'tool.started', 'tool.finished', 'text.delta', 'citation.added', 'text.delta', 'message.completed']);
  const gets = (await api()).filter((r) => r.method === 'GET' && r.path === '/v3/conversations/c-w/stream');
  assert.equal(gets.length, 8, 'seven reconnects, more than three, because each carried an event');
  gets.slice(1).forEach((g, i) => assert.equal(g.headers['last-event-id'], events[i]!.eventId));
});

test('[sse.watch-resends-request] a watch reconnects with its whole request, what it listens to included, and Last-Event-ID', async () => {
  await faults({ watchCloses: 1 });
  const events: { type: string; eventId?: string }[] = [];
  for await (const event of client().events.watch({ types: ['conversation.created'], conversationIds: ['c-11', 'c-12'] })) {
    events.push(event);
    if (events.length === 2) break;
  }
  const [first, second] = (await api()).filter((r) => r.path === '/v3/events/stream');
  assert.ok(first && second, 'a reconnect after the clean end');
  assert.equal(second.query, first.query, 'the same query');
  assert.match(second.query, /type=conversation.created/);
  assert.match(second.query, /conversationId=c-11/);
  assert.equal(second.headers['last-event-id'], events[0]!.eventId);
});

test('[sse.conversation-reset] stream.reset on a conversation watch is delivered with its cursor as its id, and the watch carries on', async () => {
  const c = client();
  const answer = await collect(c.conversations('c-r').send('hi'));
  const events: any[] = [];
  for await (const event of c.conversations('c-r').watch({ lastEventId: answer.at(-1)!.eventId })) {
    events.push(event);
    if (event.type === 'message.completed') break;
  }
  const [reset] = events;
  assert.equal(reset.type, 'stream.reset');
  assert.equal(reset.cursor, reset.eventId);
  assert.equal(events.at(-1).type, 'message.completed', 'the next answer follows the reset');
  assert.equal((await api()).filter((r) => r.method === 'GET').length, 1, 'a reset is not an error and is never retried');
});

const ID_11 = '0193a6f3-0a1b-7c2d-8e3f-000000000011';

test('[sse.reconnect-backoff] each reconnect in a row waits a longer, jittered pause, and the fourth fails with STREAM_LOST', async () => {
  const c = client();
  await collect(c.conversations('c-b').send('hi'));
  await faults({ watchEmptyCloses: 4 });
  const err = await expectError(collect(c.conversations('c-b').watch()));
  assert.equal(err.code, 'STREAM_LOST');
  const at = (await api()).filter((r) => r.method === 'GET').map((r) => r.at as number);
  assert.equal(at.length, 4, 'the first request and three reconnects');
  const [g1, g2, g3] = [at[1]! - at[0]!, at[2]! - at[1]!, at[3]! - at[2]!];
  // The bands (0.25-0.5 s, 0.5-1 s, 1-2 s) do not overlap, so their lower bounds show the pause grows; a slow
  // runtime only lengthens a pause. The upper bounds, three times each band's top, catch a broken cap.
  assert.ok(g1 >= 200 && g2 >= 450 && g3 >= 950, `pauses ${g1}, ${g2}, ${g3} ms: at least 0.25, 0.5 and 1 s`);
  assert.ok(g1 <= 1500 && g2 <= 3000 && g3 <= 6000, `pauses ${g1}, ${g2}, ${g3} ms: at most 1.5, 3 and 6 s`);
});

test('[sse.reconnect-without-event-id] a reconnect before any event sends no Last-Event-ID, and a watch keeps its after cursor', async () => {
  await faults({ watchEmptyCloses: 1 });
  for await (const event of client().events.watch({ types: ['conversation.created'], after: ID_11 })) {
    void event;
    break;
  }
  const [first, second] = (await api()).filter((r) => r.path === '/v3/events/stream');
  assert.ok(first && second, 'a reconnect after the empty response');
  assert.equal(second.headers['last-event-id'], undefined);
  assert.equal(second.query, first.query, 'the same request, after cursor included');
});

test("[sse.reconnect-drops-after] a watch's reconnect sends Last-Event-ID in place of the after cursor it started from", async () => {
  await faults({ watchCloses: 1 });
  const events: { eventId?: string }[] = [];
  for await (const event of client().events.watch({ types: ['conversation.created'], after: ID_11 })) {
    events.push(event);
    if (events.length === 2) break;
  }
  const [first, second] = (await api()).filter((r) => r.path === '/v3/events/stream');
  assert.match(first.query, /after=/);
  assert.equal(second.headers['last-event-id'], events[0]!.eventId);
  assert.ok(!/after=/.test(second.query), 'no after cursor');
  assert.match(second.query, /type=conversation.created/);
});

/**
 * Runs `run` with the stream clock stepping `stepMs` at each reading, so every connection lasts exactly that long
 * (a stream reads the clock when a response arrives and when its connection ends), then puts the real clock back.
 */
async function withConnectionsLasting<T>(stepMs: number, run: () => Promise<T>): Promise<T> {
  const real = streamClock.now;
  let t = 0;
  streamClock.now = () => (t += stepMs);
  try {
    return await run();
  } finally {
    streamClock.now = real;
  }
}

test('[sse.long-connection-resets-count] a connection open at least a minute starts the reconnect count again', async () => {
  const c = client();
  await collect(c.conversations('c-l').send('hi'));
  // Five quiet responses in a row (the first and four reconnects), each open just over a minute: one more than the
  // limit, so the watch carries on only because each long connection restarts the count. The sixth carries events.
  await faults({ watchEmptyCloses: 5 });
  const first = await withConnectionsLasting(LONG_CONNECTION_MS + 1_000, async () => {
    for await (const event of c.conversations('c-l').watch()) return event;
    return undefined;
  });
  assert.equal(first?.type, 'message.started', 'the watch reached the events, with no STREAM_LOST');
  assert.equal((await api()).filter((r) => r.method === 'GET').length, 6, 'the first request and five reconnects');
});

test('[sse.short-connections-stream-lost] three reconnects whose connections each stayed open under a minute still end in STREAM_LOST', async () => {
  const c = client();
  await collect(c.conversations('c-s').send('hi'));
  await faults({ watchEmptyCloses: 4 });
  const err = await withConnectionsLasting(LONG_CONNECTION_MS - 1_000, () => expectError(collect(c.conversations('c-s').watch())));
  assert.equal(err.code, 'STREAM_LOST');
  assert.equal((await api()).filter((r) => r.method === 'GET').length, 4, 'the first request and three reconnects');
});

test('[sse.duplicate-not-progress] reconnects that bring only replayed duplicates still end in STREAM_LOST', async () => {
  const c = client();
  await collect(c.conversations('c-d').send('hi'));
  await faults({ watchReplayCloses: 10 });
  const seen: string[] = [];
  const err = await expectError(
    (async () => {
      for await (const event of c.conversations('c-d').watch()) seen.push(event.type);
    })(),
  );
  assert.equal(err.code, 'STREAM_LOST');
  assert.deepEqual(seen, ['message.started'], 'the duplicates were dropped');
  assert.equal((await api()).filter((r) => r.method === 'GET').length, 4, 'the first request and three reconnects');
});

test('[sse.watch-failed-answer] on a watch, message.failed is delivered as an event and the watch carries on', async () => {
  const c = client();
  await faults({ failStream: true });
  await expectError(collect(c.conversations('c-f').send('hi')));
  const types: string[] = [];
  let failed: any;
  for await (const event of c.conversations('c-f').watch()) {
    types.push(event.type);
    if (event.type === 'message.failed') failed = event;
    if (event.type === 'message.completed') break;
  }
  assert.equal(failed?.code, 'SERVICE_UNAVAILABLE');
  assert.ok(types.indexOf('message.failed') < types.indexOf('message.completed'), 'the next answer follows the failed one');
});

test('[sse.request-id-and-type] a stream exposes its request id, and every event its SSE event name', async () => {
  const stream = client().conversations('c-ids').send('hi');
  const events = await collect(stream);
  assert.equal(stream.requestId, (await api()).at(-1).requestId);
  assert.equal(events[0]!.type, 'message.started');
  assert.equal(events.at(-1)!.type, 'message.completed');
});

test('[sse.typed-events] typed events, keep-alive comments ignored, finalMessage() returns the final member', async () => {
  const stream = client().conversations('c-1').send('How many days of annual leave do staff get?');
  let text = '';
  const types: string[] = [];
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === 'text.delta') text += event.delta;
    if (event.type === 'citation.added') assert.equal(event.citation.documentName, 'leave-policy.pdf');
  }
  assert.equal(text, 'Staff receive 20 days of annual leave.');
  assert.deepEqual(types, ['message.started', 'progress.updated', 'tool.started', 'tool.finished', 'text.delta', 'citation.added', 'text.delta', 'message.completed']);
  const answer = await stream.finalMessage();
  assert.equal(answer.citations?.[0]?.pageNumber, 3);
  const send = (await api()).find((r) => r.method === 'POST');
  assert.equal(send.headers.accept, 'text/event-stream');
});

test('[sse.resume] a dropped stream resumes with Last-Event-ID, without duplicates', async () => {
  // The mock holds the connection after the third event until the harness signals the drop, which it does once
  // the SDK has delivered that event: a browser discards events still queued when a connection fails, so a drop on
  // a timer could leave the client nothing to resume from.
  await faults({ dropAfterEvents: 3, dropOnSignal: true });
  const events: { eventId?: string; type: string }[] = [];
  for await (const e of client().conversations('c-2').send('hi')) {
    events.push(e);
    if (events.length === 3) await fetch(`${BASE}/__mock/drop`, { method: 'POST' });
  }
  const ids = events.map((e) => e.eventId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate events');
  assert.equal(events.at(-1)?.type, 'message.completed');
  const resume = (await api()).find((r) => r.method === 'GET' && r.path === '/v3/conversations/c-2/stream');
  assert.ok(resume, 'a resume request was made');
  assert.equal(resume.headers['last-event-id'], ids[2]);
  assert.equal(resume.headers.accept, 'text/event-stream');
});

// The mock's cursor the workspace stream cannot carry on from, and the cursor its stream.reset gives instead.
const STALE_CURSOR = '0190d2a1-0000-7000-8000-000000000001';
const RESET_CURSOR = '0193a6f3-0a1b-7c2d-8e3f-000000000010';

test('[sse.final-ends-watch] a resumed answer ends at its final event, and closes the connection, although the watch stays open', async () => {
  await faults({ dropAfterEvents: 2 });
  const t0 = Date.now();
  const answer = await client().conversations('c-watch').send('hi').finalMessage();
  assert.equal(answer.text, 'Staff receive 20 days of annual leave.');
  assert.ok(Date.now() - t0 < 5_000, 'ended at message.completed, not when the server closed the watch');
  let closed = false;
  for (let i = 0; i < 100 && !closed; i++) {
    closed = (await requests()).some((r) => r.event === 'client-disconnected');
    if (!closed) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(closed, 'the SDK closed the watch connection');
});

// TypeScript only: a stream sends its request when iterated, so opened() is how a caller knows it is open.
test('opened() sends a stream request now and resolves at the headers; iterating reads that same response', async () => {
  const stream = client().events.watch({ types: ['conversation.created'] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await api()).length, 0, 'nothing is sent until the stream is opened or iterated');
  await stream.opened();
  await stream.opened(); // idempotent
  assert.equal((await api()).length, 1);
  assert.ok(stream.requestId, 'the request id is known once the headers have arrived');
  let first: string | undefined;
  for await (const event of stream) {
    first = event.type;
    break; // a workspace stream stays open (and reconnects): take the first event and close
  }
  assert.equal(first, 'conversation.created');
  assert.equal((await api()).length, 1, 'iterating did not send a second request');
});

test('opened() rejects with the call\'s typed error', async () => {
  await faults({ status: { WatchWorkspaceEvents: [{ status: 404 }] } });
  const stream = client().events.watch({ types: ['conversation.created'] });
  await assert.rejects(stream.opened(), (e: unknown) => e instanceof NotFoundError || (e instanceof CaitlynError && (e as Err).status === 404));
  await assert.rejects(
    (async () => {
      for await (const _ of stream) break;
    })(),
    (e: unknown) => e instanceof CaitlynError,
    'iterating rethrows the same failure',
  );
});

test('[sse.stream-reset] stream.reset is delivered as an event with its cursor as its id, and the stream carries on after it', async () => {
  const events = [];
  for await (const event of client().events.watch({ types: ['conversation.created'], after: STALE_CURSOR })) {
    events.push(event);
    if (events.length === 2) break; // a watch carries on until it is closed
  }
  assert.deepEqual(events.map((e) => e.type), ['stream.reset', 'conversation.created']);
  const [reset, created] = events;
  assert.ok(reset?.type === 'stream.reset');
  assert.equal(reset.cursor, RESET_CURSOR);
  assert.equal(reset.eventId, RESET_CURSOR);
  assert.ok(created?.type === 'conversation.created');
  assert.equal(created.data.agentId, 'GHT7YRWXPL');
  assert.equal((await api()).length, 1, 'one request: a reset is not an error and is never retried');
});

test('[sse.clean-end-resumes] a clean end of stream before the final event also resumes', async () => {
  await faults({ endAfterEvents: 2 });
  const events = await collect(client().conversations('c-5').send('hi'));
  assert.equal(events.at(-1)?.type, 'message.completed');
  const resume = (await api()).find((r) => r.method === 'GET' && r.path === '/v3/conversations/c-5/stream');
  assert.equal(resume?.headers['last-event-id'], events[1]!.eventId);
});

test('[sse.message-failed] message.failed raises the typed error for its status and ends the stream', async () => {
  await faults({ failStream: true });
  const seen: string[] = [];
  const err = await expectError(
    (async () => {
      for await (const e of client().conversations('c-6').send('hi')) seen.push(e.type);
    })(),
  );
  assert.ok(err instanceof ServiceUnavailableError, `got ${err.name}`);
  assert.equal(err.status, 503);
  assert.equal(err.code, 'SERVICE_UNAVAILABLE');
  assert.equal(err.requestId, '01JC9Q2W7R4M0H2T6N1S8V3B80');
  assert.ok(!seen.includes('message.failed'));
  assert.equal((await api()).filter((r) => r.path.endsWith('/stream')).length, 0, 'a failure is not resumed');
});

// ---------------------------------------------------------------- tolerance

test('[tolerance.unknown-event] an unknown event name is skipped', async () => {
  await faults({ unknownEvent: true });
  const events = await collect(client().conversations('c-3').send('hi'));
  assert.ok(!events.some((e) => (e.type as string) === 'memory.saved'));
  assert.equal(events.at(-1)?.type, 'message.completed');
});

test('[tolerance.unknown-enum] an unknown enum value is kept, not raised', async () => {
  await faults({ unknownEnum: true });
  const docs = await collect(client().knowledgeBases('KB4T7YQ2WL').documents.list());
  assert.equal(docs[1]!.status as string, 'archived');
  const v = await client().agents('GHT7YRWXPL').draft.get();
  assert.equal(v.source as string, 'cloned_from_template');
  // Types: every enum is open, so a switch over its known values is not exhaustive, and a value this SDK does not
  // know yet is accepted where the enum is. tsc checks this file, so a closed enum type fails the build.
  const label = (kind: ReadersKind): string => {
    switch (kind) {
      case ReadersKind.INHERIT:
      case ReadersKind.PUBLIC:
      case ReadersKind.EVERYONE:
      case ReadersKind.SPECIFIC:
        return kind;
      default: {
        // The known values are handled, yet kind is still a string here: the unknown case must be handled too.
        // @ts-expect-error an open enum is never narrowed to `never`
        const exhausted: never = kind;
        return `unknown: ${String(exhausted)}`;
      }
    }
  };
  const future: ReadersKind = 'friends_of_friends';
  assert.equal(label(future), 'unknown: friends_of_friends');
  assert.equal(label(ReadersKind.PUBLIC), 'public');
});

test('[tolerance.unknown-error-code] an error code this SDK does not know keeps its status class, or is the generic error on a job', async () => {
  const body = JSON.stringify({ type: 'https://build.caitlyn.ai/errors/SOMETHING_NEW', title: 'Something new', status: 409, code: 'SOMETHING_NEW', requestId: 'r-1' });
  await faults({ status: { GetAgentVersion: [{ status: 409, contentType: 'application/problem+json', body }] } });
  const http = await expectError(client().agents('GHT7YRWXPL').draft.get());
  assert.ok(http instanceof ConflictError, `got ${http.name}`);
  assert.equal(http.status, 409);
  assert.equal(http.code, 'SOMETHING_NEW');
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ busyDocuments: { 'doc-0002': true }, jobOutcomes: { 'doc-0002': 'failed' }, jobError: { code: 'SOMETHING_NEW', detail: 'A failure this SDK does not know.' } });
  const job = await expectError(client().knowledgeBases('KB4T7YQ2WL').documents('doc-0002').wait());
  assert.ok(job instanceof CaitlynError && !(job instanceof ConflictError), `got ${job.name}`);
  assert.equal(job.name, 'CaitlynError');
  assert.equal(job.status, 0);
  assert.equal(job.code, 'SOMETHING_NEW');
});

test('[tolerance.unknown-field-raw] unknown fields are kept in raw on the output', async () => {
  await faults({ unknownField: true });
  const v = await client().agents('GHT7YRWXPL').draft.get();
  assert.deepEqual(v.raw?.reviewState, { required: false });
  assert.ok(!('reviewState' in v), 'unknown fields are not spread onto the output');
});

test('[tolerance.nested-raw] unknown fields are kept in raw on nested structures and list items', async () => {
  await faults({ unknownField: true });
  const docs = await collect(client().knowledgeBases('KB4T7YQ2WL').documents.list());
  assert.deepEqual((docs[0] as unknown as { raw?: Record<string, unknown> }).raw?.retentionPolicy, { keepDays: 365 });
  const v = await client().agents('GHT7YRWXPL').draft.get();
  const kb = v.configuration!.knowledgeBases?.[0] as unknown as { raw?: Record<string, unknown> };
  assert.equal(kb.raw?.reranker, 'cohere');
});

// ---------------------------------------------------------------- typed errors

test('[errors.404] a 404 is NotFoundError with status, code and requestId, with and without X-Amzn-Errortype', async () => {
  for (const awsErrorTypeHeader of [false, true]) {
    await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
    await faults({ awsErrorTypeHeader });
    const err = await expectError(collect(client().knowledgeBases('NOPE').documents.list()));
    const req = (await api()).at(-1);
    assert.ok(err instanceof NotFoundError, `got ${err.name}`);
    assert.equal(err.name, 'NotFoundError');
    assert.equal(err.status, 404);
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(err.type, 'https://build.caitlyn.ai/errors/NOT_FOUND');
    assert.equal(err.requestId, req.requestId);
  }
});

test('[errors.409] a 409 is ConflictError', async () => {
  const c = client();
  // An upload whose bytes never arrived: creating a document from it is the 409
  const up = await c.core.uploads.reserve({ fileName: 'a.pdf', contentType: 'application/pdf', byteSize: 1, sha256: 'x' });
  const err = await expectError(c.knowledgeBases('KB4T7YQ2WL').documents.create({ uploadId: up.id }, { folder: '/hr/' }));
  assert.ok(err instanceof ConflictError);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'CONFLICT');
  assert.equal(err.code, ErrorCode.CONFLICT, 'the constant is the code itself');
});

test('[errors.versions-not-numbered] deleting a version by number before the versions are numbered is ConflictError VERSIONS_NOT_NUMBERED', async () => {
  await faults({ versionsNotNumbered: { 'doc-0001': true } });
  const doc = client().knowledgeBases('KB4T7YQ2WL').documents('doc-0001');
  const err = await expectError(doc.versions('1').delete());
  assert.ok(err instanceof ConflictError, `got ${err.name}`);
  assert.equal(err.status, 409);
  assert.equal(err.code, ErrorCode.VERSIONS_NOT_NUMBERED);
  const deletes = (await api()).filter((r) => r.method === 'DELETE');
  assert.equal(deletes.length, 1, 'not retried');
  assert.equal((await doc.get()).versionCount, 1, 'nothing deleted');
});

test('[errors.412] a 412 on a stale ETag is PreconditionFailedError', async () => {
  const c = client();
  const draft = await c.agents('GHT7YRWXPL').draft.get();
  await c.agents('GHT7YRWXPL').draft.update({ guidance: { instructions: 'first' } }, { ifMatch: draft.etag });
  const err = await expectError(c.agents('GHT7YRWXPL').draft.update({ guidance: { instructions: 'second' } }, { ifMatch: draft.etag }));
  assert.ok(err instanceof PreconditionFailedError);
  assert.equal(err.code, 'PRECONDITION_FAILED');
  assert.ok(err.requestId);
});

test('[errors.decode-failed] a 200 whose body is not JSON raises DECODE_FAILED, the generic error with status 0, with the parse failure as its cause', async () => {
  await faults({ status: { GetDocument: [{ status: 200, body: 'this is not JSON', contentType: 'application/json' }] } });
  const err = await expectError(client().knowledgeBases(KB).documents('doc-0001').get());
  assert.equal(err.code, 'DECODE_FAILED');
  assert.equal(err.status, 0);
  assert.equal(err.name, 'CaitlynError');
  assert.ok((err as { cause?: unknown }).cause instanceof SyntaxError, `cause ${(err as { cause?: unknown }).cause}`);
});

test('[errors.job-failed-no-code] wait() on a job that failed with no error code raises JOB_FAILED, the generic error with status 0', async () => {
  await busy('doc-0002', 'failed', { jobError: { detail: 'The job failed and said no more.' } });
  const err = await expectError(client().knowledgeBases(KB).documents('doc-0002').wait());
  assert.equal(err.code, 'JOB_FAILED');
  assert.equal(err.status, 0);
  assert.equal(err.name, 'CaitlynError');
});

test('[errors.file-unreadable] a file that cannot be read raises FILE_UNREADABLE (status 0) with the native error as its cause, and nothing is sent', async () => {
  const broken = new Error('the disk went away');
  async function* failing() {
    yield enc('%PDF-1.7 first part');
    throw broken;
  }
  const err = await expectError(client().core.uploads.send(UploadFile.fromStream(failing(), { name: 'scan.pdf' })));
  assert.equal(err.code, 'FILE_UNREADABLE');
  assert.equal(err.status, 0);
  assert.equal((err as { cause?: unknown }).cause, broken);
  if (!BROWSER_BUILD) {
    const missing = await expectError(client().core.uploads.send(path.join(tempDir('caitlyn-missing-'), 'no-such-file.pdf')));
    assert.equal(missing.code, 'FILE_UNREADABLE');
    assert.equal(((missing as { cause?: { code?: string } }).cause)?.code, 'ENOENT');
  }
  assert.deepEqual(await api(), [], 'nothing was sent');
});

test('[errors.item-has-no-file] a sync whose batch awaits a file the call has none for raises INGESTION_ITEM_HAS_NO_FILE (status 0), and nothing is uploaded', async () => {
  await faults({ strayItem: '/hr/stray.pdf' });
  const err = await expectError(client().knowledgeBases(KB).ingestion.sync(await syncSource(someFiles(1)), { folder: '/hr/' }));
  assert.equal(err.code, 'INGESTION_ITEM_HAS_NO_FILE');
  assert.equal(err.status, 0);
  assert.match(err.message, /\/hr\/stray\.pdf/);
  assert.deepEqual(await forms(), [], 'nothing was uploaded');
});

test('[errors.429-exhausted] a 429 after retries are exhausted carries retryAfterSeconds', async () => {
  await faults({ status: { GetAgentVersion: [0, 1, 2].map(() => ({ status: 429, retryAfter: 0 })) } });
  const err = await expectError(client().agents('GHT7YRWXPL').draft.get());
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.retryAfterSeconds, 0);
  assert.equal((await api()).length, 3);
});

test('[errors.field-errors] a 400 VALIDATION_FAILED for a field both set and cleared carries the field errors', async () => {
  const c = client();
  const draft = await c.agents('GHT7YRWXPL').draft.get();
  const err = await expectError(c.agents('GHT7YRWXPL').draft.update({ guidance: { identity: 'New' }, clear: ['guidance.identity'] }, { ifMatch: draft.etag }));
  assert.ok(err instanceof ValidationError);
  assert.equal(err.code, 'VALIDATION_FAILED');
  assert.equal(err.errors?.[0]?.pointer, '/guidance/identity');
  assert.equal(err.errors?.[0]?.code, 'VALIDATION_FAILED');
});

// errors.raw-body-limit: a 20 KiB HTML page (ASCII), and a page whose 8 KiB cut would fall inside a three-byte "€".
const PAGE_20K = '<!DOCTYPE html>' + 'x'.repeat(20480 - 15);
const PAGE_STRADDLE = 'a'.repeat(8191) + '€'.repeat(10);

test('[errors.raw-body-limit] rawBody keeps at most 8 KiB, cut on a character boundary, and says when it was cut', async () => {
  await faults({ status: { GetAgentVersion: [PAGE_20K, PAGE_STRADDLE].map((body) => ({ status: 404, contentType: 'text/html', body })) } });
  const c = client();
  const get = (version: string) => expectError(c.agents('GHT7YRWXPL').versions(version).get());
  const page = await get('draft');
  assert.ok((page as unknown) instanceof NotFoundError);
  assert.equal(new TextEncoder().encode(page.rawBody!).byteLength, 8192);
  assert.equal(page.rawBody, PAGE_20K.slice(0, 8192));
  assert.equal(page.rawBodyTruncated, true);
  const straddle = await get('draft');
  assert.equal(straddle.rawBody, 'a'.repeat(8191));
  assert.equal(straddle.rawBodyTruncated, true);
  const problem = await get('nope');
  assert.ok((problem as unknown) instanceof NotFoundError);
  assert.equal(JSON.parse(problem.rawBody!).code, 'NOT_FOUND');
  assert.equal(problem.rawBodyTruncated, false);
});

/** An endpoint nothing listens on: a port the system handed out, then closed. */
async function refusedEndpoint(): Promise<string> {
  if (process.env.CAITLYN_REFUSED_ENDPOINT) return process.env.CAITLYN_REFUSED_ENDPOINT; // a page cannot open a port
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

test('[errors.connection] a connection closed before any response, and a refused connection, are the connection error', async () => {
  // A browser resends a request whose connection closed before any response by itself (Chromium once, WebKit
  // several times), so in a page the mock closes it every time.
  await faults({ status: { GetAgentVersion: IN_PAGE ? Array.from({ length: 10 }, () => ({ close: true })) : [{ close: true }] } });
  const closed = await expectError(client({ maxAttempts: 1 }).agents('GHT7YRWXPL').draft.get());
  const refused = await expectError(client({ maxAttempts: 1, endpoint: await refusedEndpoint() }).agents('GHT7YRWXPL').draft.get());
  for (const err of [closed, refused]) {
    assert.ok(err instanceof CaitlynConnectionError, `${err.constructor.name}: ${err.message}`);
    assert.deepEqual([err.status, err.code, err.requestId, err.rawBody, err.rawBodyTruncated], [0, 'CONNECTION_ERROR', undefined, '', false]);
    assert.ok(err.cause instanceof Error, 'the network error is the cause');
    assert.match(err.message, /^GetAgentVersion: no response: /);
  }
  // the closed connection was asked once (by the SDK: a page's browser may resend it); the refused one never arrived
  if (IN_PAGE) assert.ok((await api()).length >= 1);
  else assert.equal((await api()).length, 1);
});

test("[errors.unmodelled-status] a status the operation does not list is still that status's class", async () => {
  await faults({ status: { CreateUpload: [{ status: 404 }, { status: 405, body: '' }] } });
  const c = client();
  const reserve = () => expectError(c.core.uploads.reserve({ fileName: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' }));
  const notFound = await reserve();
  assert.ok((notFound as unknown) instanceof NotFoundError, notFound.name);
  assert.deepEqual([notFound.name, notFound.status, notFound.code], ['NotFoundError', 404, 'HTTP_404']);
  const other = await reserve();
  assert.ok(!((other as unknown) instanceof NotFoundError));
  assert.deepEqual([other.name, other.status, other.code], ['CaitlynError', 405, 'HTTP_405']);
});

// An error page from something in front of the API, not a problem body (PROTOCOL.md 6.1).
const HTML_404 = '<!DOCTYPE html><html><head><title>404: This page could not be found</title></head><body><h1>404</h1></body></html>';

test('[errors.html-404] an HTML 404 with no Caitlyn-Request-Id is the NotFoundError class, with code HTTP_404 and the body kept', async () => {
  await faults({ status: { ListDocuments: [{ status: 404, contentType: 'text/html; charset=utf-8', body: HTML_404 }] } });
  const err = await expectError(collect(client().knowledgeBases('KB4T7YQ2WL').documents.list()));
  assert.ok(err instanceof NotFoundError, `got ${err.name}`);
  assert.equal(err.status, 404);
  assert.equal(err.code, 'HTTP_404');
  assert.equal(err.requestId, undefined);
  assert.equal((err as Err).rawBody, HTML_404);
});

test('[errors.empty-405] a 405 with an empty body is the generic error, with status 405 and code HTTP_405', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 405, body: '' }] } });
  const err = await expectError(client().agents('GHT7YRWXPL').draft.get());
  assert.equal(err.constructor, CaitlynError);
  assert.equal(err.status, 405);
  assert.equal(err.code, 'HTTP_405');
  assert.equal(err.requestId, undefined);
  assert.equal(err.rawBody, '');
});

test('[errors.text-502] a text/plain 502 is the generic error, with status 502, code HTTP_502 and the text, sent once', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }] } });
  const err = await expectError(client().agents('GHT7YRWXPL').draft.get());
  assert.equal(err.constructor, CaitlynError);
  assert.equal(err.status, 502);
  assert.equal(err.code, 'HTTP_502');
  assert.equal(err.rawBody, 'Bad Gateway');
  assert.equal((await api()).length, 1);
});

// A problem body whose status disagrees with the HTTP status (PROTOCOL.md 6.3).
const MISMATCHED_409 = '{"type":"https://build.caitlyn.ai/errors/CONFLICT","title":"Conflict","status":400,"code":"CONFLICT","requestId":"01MISMATCHEDSTATUS0000000"}';

test('[errors.status-from-http] an HTTP 409 whose problem body says status 400 is ConflictError, with status 409', async () => {
  await faults({ status: { CreateUpload: [{ status: 409, contentType: 'application/problem+json', body: MISMATCHED_409 }] } });
  const err = await expectError(client().core.uploads.reserve({ fileName: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' }));
  assert.ok(err instanceof ConflictError, `got ${err.name}`);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'CONFLICT');
  assert.equal(err.requestId, '01MISMATCHEDSTATUS0000000');
});

// ---------------------------------------------------------------- cancellation

test('[cancel.stream] cancelling a stream closes the connection and raises AbortError', async () => {
  await faults({ streamDelayMs: 150 });
  const controller = new AbortController();
  const stream = client().conversations('c-4').send('hi', {}, { signal: controller.signal });
  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const e of stream) {
        seen.push(e.type);
        if (seen.length === 2) controller.abort();
      }
    })(),
    (err: Error) => err.name === 'AbortError',
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await requests()).some((r) => r.event === 'client-disconnected'), 'server saw the client disconnect');
});

test('[cancel.unary] cancelling a single call stops it', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client().agents('GHT7YRWXPL').draft.get({ signal: controller.signal }), (err: Error) => err.name === 'AbortError');
});

// ---------------------------------------------------------------- updates

test('[update.if-match] If-Match is sent from the call option and the new ETag comes back', async () => {
  const c = client();
  const draft = await c.agents('GHT7YRWXPL').draft.get();
  const updated = await c.agents('GHT7YRWXPL').draft.update({ guidance: { instructions: `${draft.configuration!.guidance?.instructions}\nAlways state the policy clause number.` } }, { ifMatch: draft.etag });
  assert.notEqual(updated.etag, draft.etag);
  const patch = (await api()).find((r) => r.method === 'PATCH');
  assert.equal(patch.headers['if-match'], draft.etag);
  assert.deepEqual(JSON.parse(patch.body), { guidance: { instructions: 'Answer from the HR policies.\nAlways state the policy clause number.' } });
});

test('[update.clear] clear sends only the clear list, and the field is cleared', async () => {
  const c = client();
  const draft = await c.agents('GHT7YRWXPL').draft.get();
  const updated = await c.agents('GHT7YRWXPL').draft.update({ clear: ['guidance.identity'] }, { ifMatch: draft.etag });
  const patch = (await api()).find((r) => r.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.body), { clear: ['guidance.identity'] });
  assert.equal(updated.configuration!.guidance?.identity, undefined);
  assert.equal(updated.configuration!.guidance?.instructions, 'Answer from the HR policies.');
});

// ---------------------------------------------------------------- wire and environment

test('[wire.headers] exactly the SDK headers: Caitlyn user agent, Caitlyn-Sdk-Model, no AWS headers', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 0 }] } });
  await client({ telemetry: { enabled: false } }).agents('GHT7YRWXPL').draft.get();
  const sent = await api();
  assert.equal(sent.length, 2);
  for (const r of sent) {
    const aws = r.headerNames.filter((h: string) => /^(x-amz|amz-sdk|x-amzn)/.test(h));
    assert.deepEqual(aws, [], `AWS headers sent: ${aws.join(', ')}`);
    // A page sends the SDK's User-Agent where the browser allows it (Firefox), and its own where it does not (Chromium, WebKit).
    const runtime = IN_PAGE ? 'md/browser' : 'md/nodejs#\\d+\\.\\d+\\.\\d+';
    if (!IN_PAGE || r.headers['user-agent'].startsWith('caitlyn-sdk-ts/'))
      assert.match(r.headers['user-agent'], new RegExp(`^caitlyn-sdk-ts/${SDK_VERSION.replaceAll('.', '\\.')} lang/js ${runtime}$`));
    assert.equal(r.headers['caitlyn-sdk-model'], SDK_MODEL);
    assert.equal(r.headers.authorization, 'Bearer pat_test');
    assert.equal(r.headers['caitlyn-api-version'], undefined, 'a response header only');
    assert.equal(r.headers['content-type'], undefined, 'no body, no Content-Type');
    assert.equal(r.headers.traceparent, undefined, 'no propagator, no traceparent');
  }
});

test('[environment.hostile-aws] hostile AWS_* variables and ~/.aws files change nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caitlyn-hostile-'));
  const hostile = '[default]\nmax_attempts = 1\nretry_mode = adaptive\ndefaults_mode = auto\nendpoint_url = http://127.0.0.1:9\nregion = xx-hostile-1\n';
  fs.writeFileSync(path.join(dir, 'config'), hostile.replace('[default]', '[profile hostile]') + '\n' + hostile);
  const vars: Record<string, string> = {
    AWS_PROFILE: 'hostile',
    AWS_REGION: 'xx-hostile-1',
    AWS_MAX_ATTEMPTS: '1',
    AWS_RETRY_MODE: 'adaptive',
    AWS_DEFAULTS_MODE: 'auto',
    AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
    AWS_CONFIG_FILE: path.join(dir, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'config'),
    // Any instance-metadata lookup ("auto" defaults mode) would hang on this unroutable address.
    AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://10.255.255.1',
  };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 0 }] } });
    const t0 = Date.now();
    const v = await client({ telemetry: { enabled: false } }).agents('GHT7YRWXPL').draft.get();
    const docs = await collect(client({ telemetry: { enabled: false } }).knowledgeBases('KB4T7YQ2WL').documents.list({ limit: 3 }));
    assert.equal(v.name, 'draft');
    assert.equal(docs.length, 7);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms: something waited on the environment`);
    const sent = (await api()).filter((r) => r.path.includes('/versions/'));
    assert.equal(sent.length, 2, 'still retried once: AWS_MAX_ATTEMPTS=1 and max_attempts=1 were ignored');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------- versions, headers, telemetry, endpoint

// ---------------------------------------------------------------- scopes (PROTOCOL.md 10)

const KB = 'KB4T7YQ2WL';
const AGENT = 'GHT7YRWXPL';
const pathOf = (r: any) => `${r.method} ${r.path}`;

test('[scope.sends-nothing] making a scope, at any depth, sends no request', async () => {
  const c = client();
  const kb = c.knowledgeBases(KB);
  const made = [
    kb,
    kb.documents('doc-0001'),
    kb.documents('doc-0001').versions('3'),
    kb.documents('doc-0001').access,
    kb.folders('/hr/leave/'),
    kb.folders('/hr/leave/').access,
    kb.ingestion.batches('b-1').items('i-1'),
    kb.fields('policyOwner'),
    c.agents(AGENT),
    c.agents(AGENT).draft,
    c.agents(AGENT).live.conversations,
    c.agents(AGENT).versions('v13'),
    c.agents(AGENT).history('lh-0001'),
    c.conversations('c-1').messages,
    c.core.operations(KB, 'op-1'),
    c.core.uploads('up-1'),
  ];
  assert.equal(made.length, 16);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await requests(), [], 'nothing was sent');
});

test("[scope.fills-identifiers] a scope's call fills its identifiers, and a folder scope's path is sent without its first and last / in a request path", async () => {
  const kb = client().knowledgeBases(KB);
  const doc = await kb.documents('doc-0002').get();
  assert.equal(doc.id, 'doc-0002');
  await kb.documents('doc-0002').versions('1').get();
  await kb.folders('/hr/investigations/').delete();
  await kb.folders('/hr/investigations/').access.get();
  const sent = await api();
  assert.deepEqual(sent.map(pathOf), [
    `GET ${KB_PATH}/documents/doc-0002`,
    `GET ${KB_PATH}/documents/doc-0002/versions/1`,
    `DELETE ${KB_PATH}/folders/hr/investigations`,
    `GET ${KB_PATH}/access`,
  ]);
  assert.equal(new URLSearchParams(sent[3].query).get('folder'), '/hr/investigations/', 'a query value keeps its slashes');
});

test('[scope.named] a named scope sends its fixed value, merges a singleton of the same name, and lacks the operations it leaves out', async () => {
  const agent = client().agents(AGENT);
  const live = await agent.live.get();
  assert.equal(live.liveVersion, 'v13');
  const draft = await agent.draft.get();
  assert.equal(draft.name, 'draft');
  await agent.draft.update({ guidance: { instructions: 'Cite clause numbers.' } }); // If-Match is optional here
  await agent.live.conversations.create();
  const sent = await api();
  assert.deepEqual(sent.map(pathOf), [
    `GET /v3/agents/${AGENT}/versions/live`,
    `GET /v3/agents/${AGENT}/versions/draft`,
    `PATCH /v3/agents/${AGENT}/versions/draft`,
    `POST /v3/agents/${AGENT}/versions/live/conversations`,
  ]);
  assert.equal(sent[2].headers['if-match'], undefined);
  assert.equal(agent.live.version, 'live');
  assert.equal(agent.draft.version, 'draft');
  const loose = (x: object) => x as Record<string, unknown>;
  assert.equal(loose(agent.live).publish, undefined, 'live is read-only: no publish');
  assert.equal(loose(agent.live).delete, undefined, 'and no delete');
  assert.equal(loose(agent.draft).delete, undefined, 'the draft is never deleted');
  assert.equal(typeof agent.draft.save, 'function', 'the Draft singleton’s operations are on the draft');
  assert.equal(typeof agent.versions('v13').publish, 'function');
});

test('[scope.from-scope] an operation with @fromScope sends the member filled from the scope: folder, document, or neither', async () => {
  const kb = client().knowledgeBases(KB);
  await kb.access.get();
  await kb.folders('/hr/').access.get();
  const { etag } = await kb.documents('doc-0001').access.get();
  await kb.documents('doc-0001').access.set({ readers: 'everyone' }, { ifMatch: etag });
  const queries = (await api()).map((r) => Object.fromEntries(new URLSearchParams(r.query)));
  assert.deepEqual(queries, [{}, { folder: '/hr/' }, { document: 'doc-0001' }, { document: 'doc-0001' }]);
  assert.equal((await api())[3].method, 'PUT');
});

test("[scope.create-returns-scope] create returns the new thing's scope, with the response's fields and its identifier", async () => {
  const c = client();
  const agent = await c.agents.create({ name: 'Policy helper' });
  assert.equal(agent.agentId, agent.id);
  assert.equal(agent.name, 'Policy helper');
  await agent.draft.get(); // agent.draft at once, with no second lookup
  const kb = c.knowledgeBases(KB);
  const doc = await kb.documents.create(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' }), { folder: '/hr/' });
  assert.equal(doc.documentId, doc.id);
  assert.equal(doc.status, 'pending');
  await doc.get();
  const folder = await kb.folders.create('/hr/cases/');
  assert.equal(folder.folderPath, '/hr/cases/');
  assert.ok(folder.operation.id);
  await folder.access.get();
  const conversation = await c.agents(AGENT).live.conversations.create({ title: 'Leave' });
  assert.equal(conversation.conversationId, conversation.id);
  assert.equal(conversation.version, 'live');
  await conversation.get();
  const sent = (await api()).filter((r) => r.method === 'GET').map((r) => `${r.path}${r.query}`);
  assert.deepEqual(sent, [
    `/v3/agents/${agent.id}/versions/draft`,
    `${KB_PATH}/documents/${doc.id}`,
    `${KB_PATH}/access?folder=%2Fhr%2Fcases%2F`,
    `/v3/conversations/${conversation.id}`,
  ]);
});

test('[scope.core] the building blocks are under core and take their identifiers as leading arguments', async () => {
  const c = client();
  const up = await c.core.uploads.reserve({ fileName: 'a.pdf', contentType: 'application/pdf', byteSize: PDF.length, sha256: await sha256(PDF) });
  await c.core.uploads(up.id).get();
  const batch = await c.knowledgeBases(KB).ingestion.batches.create({ start: 'manual', awaitMoreItems: true });
  const added = await c.core.ingestion.addItems(KB, batch.id, [{ path: '/hr/a.pdf', sha256: await sha256(PDF), byteSize: PDF.length, contentType: 'application/pdf' }], { last: true });
  assert.equal(added.results[0]?.status, 'created');
  const { job } = await c.knowledgeBases(KB).fields.fillIn(['policyOwner']);
  const op = await c.core.operations(KB, job.id).get();
  assert.equal(op.id, job.id);
  assert.equal(typeof c.core.ingestion.completeUploads, 'function');
  assert.equal(typeof c.core.ingestion.uploadPolicy, 'function');
  assert.equal(typeof c.core.operations.list, 'function');
  const sent = (await api()).map(pathOf);
  assert.deepEqual(sent, [
    'POST /v3/uploads',
    `GET /v3/uploads/${up.id}`,
    `POST ${BATCHES}`,
    `POST ${BATCHES}/${batch.id}/items:batch-create`,
    `POST ${KB_PATH}/fields:fill-in`,
    `GET ${KB_PATH}/operations/${job.id}`,
  ]);
  assert.equal(JSON.parse((await api())[3].body).last, true);
});

test("[scope.estimate] an estimate sits beside its job and takes the job's arguments; a file's estimate sends only its description", async () => {
  const kb = client().knowledgeBases(KB);
  const fill = await kb.fields.fillIn.estimate(['policyOwner']);
  assert.equal(typeof fill.documents, 'number');
  assert.ok(fill.durationSeconds.high >= fill.durationSeconds.low);
  // A file job's estimate takes the file and the estimate's own members only: not the job's folder.
  const add = await kb.documents.create.estimate(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' }));
  assert.equal(add.documents, 1);
  assert.equal(add.cost?.unit, 'usd');
  const reprocess = await kb.documents.reprocess.estimate({ outOfDate: true });
  assert.equal(typeof reprocess.documents, 'number');
  await kb.layoutAwareSearch.enable.estimate();
  const sent = await api();
  assert.deepEqual(sent.map(pathOf), [
    `POST ${KB_PATH}/fields:estimate-fill-in`,
    `POST ${KB_PATH}/ingestions:estimate`,
    `POST ${KB_PATH}/documents:estimate-reprocess`,
    `GET ${KB_PATH}/layout-aware-search-estimate`,
  ]);
  assert.deepEqual(JSON.parse(sent[0].body), { keys: ['policyOwner'] });
  assert.deepEqual(JSON.parse(sent[1].body), { documents: [{ name: 'leave-policy.pdf', contentType: 'application/pdf', byteSize: PDF.length }] });
  assert.deepEqual(JSON.parse(sent[2].body), { outOfDate: true });
  assert.equal((await requests()).filter((r) => r.path?.startsWith('/__s3/') || r.path === '/v3/uploads').length, 0, 'nothing was uploaded');
});

test('[watch.event-types] a watch’s events are read as the model’s types: snapshot entries and change events have Date timestamps', async () => {
  const kb = client().knowledgeBases(KB);
  for await (const event of kb.watch()) {
    assert.ok(event.type === 'snapshot');
    assert.ok(event.knowledgeBase?.updatedAt instanceof Date, 'a snapshot entry’s updatedAt is a Date');
    assert.ok(event.knowledgeBase?.createdAt instanceof Date);
    assert.ok((event.knowledgeBase as { raw?: unknown } | undefined)?.raw, 'and keeps its raw JSON');
    break;
  }
  for await (const event of kb.folders('/hr/').watch()) {
    assert.ok(event.type === 'snapshot');
    assert.ok(event.folder?.updatedAt instanceof Date, 'a folder snapshot entry’s updatedAt is a Date');
    break;
  }
  // A change event: a document's update, seen on the document's watch.
  const doc = kb.documents('doc-0001');
  const current = await doc.get();
  const watch = doc.watch();
  await watch.opened();
  await doc.update({ metadata: { policyOwner: 'HR' } }, { ifMatch: current.etag });
  for await (const event of watch) {
    if (event.type !== 'document.updated') continue;
    assert.ok(event.document?.updatedAt instanceof Date, 'a change event’s updatedAt is a Date');
    break;
  }
  // So a folder's wait() and ListFolders give the same Folder.
  const waited = await kb.folders('/hr/').wait();
  let listed: unknown;
  for await (const f of kb.folders.list()) if (f.path === '/hr/') listed = f;
  assert.deepEqual({ ...waited }, { ...(listed as object) });
});

test('[watch.break-closes] a break out of a watch closes its connection: the server sees the client leave within a second, and nothing more is sent', async () => {
  for await (const event of client().knowledgeBases(KB).watch()) {
    assert.equal(event.type, 'snapshot');
    break;
  }
  const left = Date.now();
  const disconnected = async () => (await requests()).some((r) => r.event === 'client-disconnected' && r.subject === `kb:${KB}`);
  while (!(await disconnected())) {
    if (Date.now() - left > 1000) assert.fail('the server did not see the client leave within a second');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await watches()).length, 1, 'no further request');
});

test('[wait.snapshot-entry] wait() finds a batch, a document and a folder in the snapshot under the filter’s name, and a snapshot that shows it done ends the wait as that thing', async () => {
  const kb = client().knowledgeBases(KB);
  const report = await kb.ingestion.sync(await syncSource(someFiles(1)), { folder: '/hr/' });
  const snapshotOf = async (scope: { watch(): AsyncIterable<any> }, key: string) => {
    for await (const event of scope.watch()) {
      assert.equal(event.type, 'snapshot');
      return event[key];
    }
  };
  const cases: [string, { watch(): AsyncIterable<any>; wait(): Promise<{ id?: string; path?: string; status?: string }> }, string][] = [
    ['batch', kb.ingestion.batches(report.batch.id), report.batch.id],
    ['document', kb.documents('doc-0001'), 'doc-0001'],
    ['folder', kb.folders('/hr/'), '/hr/'],
  ];
  for (const [key, scope, id] of cases) {
    const entry = await snapshotOf(scope, key);
    assert.ok(entry, `the snapshot holds the ${key} under ${key}`);
    assert.equal(entry.id ?? entry.path, id);
    const watchesBefore = (await watches()).length;
    const done = await scope.wait();
    assert.equal(done.id ?? done.path, id, `${key}: the wait ends as that thing`);
    if (entry.status !== undefined) assert.equal(done.status, entry.status, `${key}: done as the snapshot showed it`);
    assert.equal((await watches()).length, watchesBefore + 1, `${key}: one watch, ended by its snapshot`);
  }
  // Typed as the things themselves.
  const batch: IngestionBatch = await kb.ingestion.batches(report.batch.id).wait();
  const doc: CaitlynDocument = await kb.documents('doc-0001').wait();
  const folder: Folder = await kb.folders('/hr/').wait();
  assert.ok(batch.id && doc.id && folder.path);
});

// The operations the model marks @ifMatchOptional, and those with an If-Match header it does not: read from the
// model, so a re-lock that moves one shows here.
function ifMatchSets(): { optional: string[]; required: string[] } {
  const optional: string[] = [];
  const required: string[] = [];
  for (const [id, shape] of Object.entries(SHAPES)) {
    if (shape.type !== 'operation' || !shape.input) continue;
    const members = Object.values(SHAPES[shape.input.target]?.members ?? {}) as { traits?: Record<string, unknown> }[];
    if (!members.some((m) => String(m.traits?.['smithy.api#httpHeader'] ?? '').toLowerCase() === 'if-match')) continue;
    (shape.traits?.['ai.caitlyn.traits#ifMatchOptional'] !== undefined ? optional : required).push(id.split('#')[1]);
  }
  return { optional: optional.sort(), required: required.sort() };
}

// Types, checked by the compiler and never run: on every @ifMatchOptional operation a call without ifMatch compiles;
// on every other operation with If-Match it does not.
export async function ifMatchTypes(c: Caitlyn, file: UploadFile) {
  const kb = c.knowledgeBases(KB);
  const batch = kb.ingestion.batches('IB1');
  // The model's @ifMatchOptional set: no ifMatch needed.
  await kb.documents('doc-0001').replace(file); // CreateDocumentVersion
  await c.agents('GHT7YRWXPL').draft.publish(); // PublishAgentVersion
  await kb.folders('/hr/').access.set({ readers: 'everyone' }); // PutAccess
  await c.agents('GHT7YRWXPL').draft.replace({}); // ReplaceDraftVersion
  await c.agents('GHT7YRWXPL').draft.save('v13'); // SaveDraftVersion
  await batch.start(); // StartIngestionBatch
  await c.agents('GHT7YRWXPL').draft.update({}); // UpdateDraftVersion
  await kb.fields('policyOwner').update({}); // UpdateField
  await batch.items('item-00001').resolve('skip'); // UpdateIngestionBatchItem
  // Every other operation with If-Match: ifMatch is required.
  // @ts-expect-error ResetDraftVersion requires ifMatch
  await c.agents('GHT7YRWXPL').draft.reset('v12', {});
  // @ts-expect-error UpdateAgent requires ifMatch
  await c.agents('GHT7YRWXPL').update({}, {});
  // @ts-expect-error UpdateDocument requires ifMatch
  await kb.documents('doc-0001').update({}, {});
  // @ts-expect-error UpdateFolder requires ifMatch
  await kb.folders('/hr/').update({}, {});
  // @ts-expect-error UpdateIngestionBatch requires ifMatch
  await batch.update({}, {});
  // @ts-expect-error UpdateKnowledgeBase requires ifMatch
  await kb.update({}, {});
}

test('[if-match.optional-set] ifMatch is optional exactly on the model’s @ifMatchOptional operations, and a call without it sends no If-Match; elsewhere it is required', async () => {
  const sets = ifMatchSets();
  // The compile-time half (ifMatchTypes above) names these sets; a re-lock that moves an operation fails here.
  assert.deepEqual(sets.optional, ['CancelIngestionBatchItem', 'CreateDocumentVersion', 'PublishAgentVersion', 'PutAccess', 'ReplaceDraftVersion', 'SaveDraftVersion', 'StartIngestionBatch', 'UpdateDraftVersion', 'UpdateField', 'UpdateIngestionBatchItem']);
  assert.deepEqual(sets.required, ['ResetDraftVersion', 'UpdateAgent', 'UpdateDocument', 'UpdateFolder', 'UpdateIngestionBatch', 'UpdateKnowledgeBase']);
  const kb = client().knowledgeBases(KB);
  const agent = client().agents('GHT7YRWXPL');
  // A planned batch with one item the policy leaves unresolved: for start() and resolve().
  await faults({ planConflicts: { '/hr/clash.pdf': 'duplicate_path' } });
  const unresolved = await handBatch({ '/hr/clash.pdf': enc('%PDF clash') });
  await unresolved.planned();
  const [item] = await itemsOf(unresolved);
  const plain = await handBatch(handFiles(1));
  await plain.planned();
  // A started batch's item still waiting for its upload: for cancel().
  const waiting = await handBatch(handFiles(1, '/cancel/'));
  await waiting.planned();
  await waiting.start();
  const [waitingItem] = await itemsOf(waiting);
  const calls: Record<string, () => Promise<unknown>> = {
    CancelIngestionBatchItem: () => waiting.items(waitingItem.id).cancel(),
    CreateDocumentVersion: () => kb.documents('doc-0001').replace(UploadFile.fromBytes(enc('%PDF 2027'), { name: 'policy-1.pdf' })),
    PublishAgentVersion: () => agent.versions('v12').publish(),
    PutAccess: () => kb.folders('/hr/').access.set({ readers: 'everyone' }),
    ReplaceDraftVersion: () => agent.draft.replace({ guidance: { instructions: 'Answer from the HR policies.' } }),
    SaveDraftVersion: () => agent.draft.save('v99'),
    StartIngestionBatch: () => plain.start(),
    UpdateDraftVersion: () => agent.draft.update({ guidance: { instructions: 'Answer from the HR policies only.' } }),
    UpdateField: () => kb.fields('policyOwner').update({ description: 'Who owns the policy' }),
    UpdateIngestionBatchItem: () => unresolved.items(item.id).resolve('skip'),
  };
  assert.deepEqual(Object.keys(calls).sort(), sets.optional, 'a call for each operation in the set');
  for (const op of sets.optional) {
    const before = (await api()).length;
    await calls[op]();
    const sent = (await api()).slice(before).filter((r) => r.method !== 'GET' && r.path !== '/v3/uploads');
    assert.ok(sent.length >= 1, `${op}: sent`);
    assert.equal(sent[0].headers['if-match'], undefined, `${op}: no If-Match`);
  }
});

test('the model’s long-running batch calls return handles: create and start of a batch, each awaitable and with wait()', async () => {
  const kb = client().knowledgeBases(KB);
  // CreateIngestionBatch: awaiting it gives the batch's scope and the batch; StartIngestionBatch its result, and its
  // wait() the finished batch.
  const files = handFiles(1);
  const [p, bytes] = Object.entries(files)[0];
  const batch = await kb.ingestion.batches.create({ start: 'manual', items: [{ path: p, sha256: await sha256(bytes), byteSize: bytes.length, contentType: 'application/pdf' }] });
  assert.ok(batch.id && typeof batch.start === 'function');
  await batch.planned();
  const start = batch.start();
  const started = await start;
  assert.ok(started.batch && started.uploadPolicy, 'StartIngestionBatchResult');
  await batch.upload(asUploads(files));
  const finished: IngestionBatch = await start.wait();
  assert.equal(finished.status, 'succeeded');
});

test('[wait.cancel-returns] the wait of a call that cancels returns the thing once its work has stopped: the cancelled IngestionBatch, the Document as it then stands; other waits still raise CANCELLED', async () => {
  const kb = client().knowledgeBases(KB);
  // A batch's cancel(): awaiting it gives the batch; wait() the cancelled batch, not CANCELLED.
  const batch = await handBatch(handFiles(2));
  await batch.planned();
  const cancel = batch.cancel();
  assert.equal((await cancel).id, batch.id);
  const cancelled: IngestionBatch = await cancel.wait();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.id, batch.id);
  // Any other wait on that batch still raises CANCELLED.
  assert.equal((await expectError(batch.wait())).code, 'CANCELLED');
  // A document's cancelProcessing(): its running job ends cancelled, and wait() gives the document as it then stands.
  await busy('doc-0002', undefined, { cancellableProcessing: true });
  const doc = kb.documents('doc-0002');
  for await (const event of doc.watch()) {
    if (event.type === 'snapshot') break; // its job is running now
  }
  const stop = doc.cancelProcessing();
  assert.equal((await stop).id, 'doc-0002');
  const stood: CaitlynDocument = await stop.wait();
  assert.equal(stood.id, 'doc-0002');
  assert.equal(stood.status, 'failed', 'its stopped version');
  assert.equal(stood.failure?.code, 'cancelled');
});

test('[start.if-match-optional] start() with no ifMatch sends no If-Match and reads nothing first; a given one is sent as it is, and a stale one is a 412', async () => {
  const kb = client().knowledgeBases(KB);
  const item = async (name: string) => ({ path: `/hr/${name}`, sha256: await sha256(enc(name)), byteSize: name.length, contentType: 'application/pdf' });
  // No ifMatch: the start alone, with no If-Match.
  const plain = await kb.ingestion.batches.create({ start: 'manual', items: [await item('a.pdf')] });
  await plain.planned();
  const before = (await api()).length;
  await plain.start();
  const [start, ...more] = (await api()).slice(before);
  assert.equal(start.method, 'POST');
  assert.ok(start.path.endsWith(':start') || start.path.endsWith('/start'), start.path);
  assert.equal(start.headers['if-match'], undefined, 'no If-Match');
  assert.deepEqual(more, [], 'no read before it');
  // A given ifMatch is sent as it is.
  const given = await kb.ingestion.batches.create({ start: 'manual', items: [await item('b.pdf')] });
  const planned = await given.planned();
  await given.start({ ifMatch: planned.etag });
  assert.equal((await api()).at(-1).headers['if-match'], planned.etag);
  // A stale one: 412.
  const stale = await kb.ingestion.batches.create({ start: 'manual', items: [await item('c.pdf')] });
  await stale.planned();
  const err = await expectError(stale.start({ ifMatch: '"stale"' }));
  assert.equal(err.status, 412);
  assert.equal(err.code, 'PRECONDITION_FAILED');
});

test('wait(), section 16: a folder’s wait() gives the Folder as ListFolders does; a batch’s and a document’s give the final read, with $metadata', async () => {
  const kb = client().knowledgeBases(KB);
  const folder = await kb.folders('/hr/').wait();
  let listed: Record<string, unknown> | undefined;
  for await (const f of kb.folders.list()) if (f.path === '/hr/') listed = f as unknown as Record<string, unknown>;
  assert.deepEqual({ ...folder }, { ...listed }, 'the Folder as ListFolders gives it');
  const doc = await kb.documents('doc-0001').wait();
  assert.equal(doc.$metadata.httpStatusCode, 200, 'a document’s wait ends with a read');
  const report = await kb.ingestion.sync(await syncSource(someFiles(1)), { folder: '/hr/' });
  const batch = await kb.ingestion.batches(report.batch.id).wait();
  assert.equal(batch.$metadata.httpStatusCode, 200, 'a batch’s wait ends with a read');
  assert.equal((await api()).at(-1).method, 'GET');
});

test('[result.thing] get, update, create and wait() return the thing itself; list items and snapshot entries are the same type', async () => {
  const c = client();
  const kb = c.knowledgeBases(KB);
  const read: KnowledgeBase = await kb.get();
  assert.equal(read.id, KB, 'fields at the top level');
  assert.ok(!('knowledgeBase' in read), 'no wrapper member');
  const updated: KnowledgeBase = await kb.update({ description: 'HR policies' }, { ifMatch: read.etag });
  assert.equal(updated.description, 'HR policies');
  const created = await c.knowledgeBases.create({ name: 'Leave policies' });
  const asThing: KnowledgeBase = created;
  assert.ok(asThing.id && !('knowledgeBase' in created));
  const ready: KnowledgeBase = await created.wait();
  assert.equal(ready.status, 'ready');
  for await (const item of c.knowledgeBases.list()) {
    const listed: KnowledgeBase = item;
    assert.ok(listed.id && listed.etag);
    break;
  }
  const doc: CaitlynDocument = await kb.documents('doc-0001').get();
  assert.equal(doc.id, 'doc-0001');
  for await (const event of kb.watch()) {
    assert.ok(event.type === 'snapshot');
    const entry: KnowledgeBase | undefined = event.knowledgeBase;
    assert.equal(entry?.id, KB);
    break;
  }
});

test('[result.thing-metadata] a thing from one response carries its metadata, not enumerable; a list item and a snapshot entry carry none', async () => {
  const kb = client().knowledgeBases(KB);
  const read = await kb.get();
  assert.equal(read.$metadata.httpStatusCode, 200);
  assert.equal(read.$metadata.requestId, (await api()).at(-1).requestId);
  assert.ok(!Object.keys(read).includes('$metadata'), 'not enumerable');
  assert.ok(!('$metadata' in JSON.parse(JSON.stringify(read))), 'never serialised');
  assert.ok(!('$metadata' in { ...read }), 'a spread gives the data alone');
  const updated = await kb.update({ description: 'HR policies' }, { ifMatch: read.etag });
  assert.equal(updated.$metadata.httpStatusCode, 200);
  const created = await client().knowledgeBases.create({ name: 'Leave policies' });
  assert.equal(created.$metadata.httpStatusCode, 202, 'a knowledge base is created in the background');
  assert.ok(!Object.keys(created).includes('$metadata'));
  const ready = await created.wait();
  assert.equal(ready.$metadata.httpStatusCode, 200, 'wait() ends with a read');
  for await (const item of client().knowledgeBases.list()) {
    assert.equal((item as { $metadata?: unknown }).$metadata, undefined, 'a list item has none');
    break;
  }
  for await (const event of kb.watch()) {
    assert.ok(event.type === 'snapshot');
    assert.equal((event.knowledgeBase as { $metadata?: unknown } | undefined)?.$metadata, undefined, 'a snapshot entry has none');
    break;
  }
});

test('[result.thing-etag] etag is a field on the thing from a read, a list item and a snapshot entry; filled from the ETag header when the body has none', async () => {
  const kb = client().knowledgeBases(KB);
  const read = await kb.get();
  assert.ok(read.etag);
  let listed: string | undefined;
  for await (const item of client().knowledgeBases.list()) if (item.id === KB) listed = item.etag;
  assert.equal(listed, read.etag, 'a list item’s etag is a read’s');
  for await (const event of kb.watch()) {
    assert.ok(event.type === 'snapshot');
    assert.equal(event.knowledgeBase?.etag, read.etag, 'a snapshot entry’s etag is a read’s');
    break;
  }
  await faults({ etagHeaderOnly: true });
  const fromHeader = await kb.get();
  assert.ok(!('etag' in (fromHeader.raw ?? {})), 'the body had no etag');
  assert.equal(fromHeader.etag, read.etag, 'filled from the ETag header');
  const doc = await kb.documents('doc-0001').get();
  assert.ok(doc.etag);
});

test('[result.thing-raw] a thing keeps the JSON it was read from as raw, unknown fields included', async () => {
  await faults({ unknownField: true });
  const read = await client().knowledgeBases(KB).get();
  assert.deepEqual(read.raw?.retentionPolicy, { keepDays: 365 });
  assert.equal(read.raw?.id, KB);
  assert.ok(!Object.keys(read).includes('raw'));
  const doc = await client().knowledgeBases(KB).documents('doc-0001').get();
  assert.equal(doc.raw?.id, 'doc-0001');
});

test('[result.list-etag-if-match] a list item’s etag, given as ifMatch to the thing’s update, is accepted', async () => {
  let listed: KnowledgeBase | undefined;
  for await (const item of client().knowledgeBases.list()) if (item.id === KB) listed = item;
  assert.ok(listed?.etag);
  const updated = await client().knowledgeBases(KB).update({ description: 'From a list row' }, { ifMatch: listed.etag });
  assert.equal(updated.description, 'From a list row');
  assert.equal((await api()).at(-1).headers['if-match'], listed.etag);
  assert.notEqual(updated.etag, listed.etag);
});

test('[estimate.caller-hints] hints a caller gives a file reach EstimateIngestion and EstimateDocumentVersion from every estimate; a file with none sends no hints and is not read', async () => {
  const kb = client().knowledgeBases(KB);
  // A Blob that fails if anything reads it: an estimate only looks at its size.
  class Unreadable extends Blob {
    override arrayBuffer(): never { throw new Error('read'); }
    override stream(): never { throw new Error('read'); }
    override text(): never { throw new Error('read'); }
    override slice(): never { throw new Error('read'); }
  }
  const unread = () => UploadFile.fromBlob(new Unreadable([PDF], { type: 'application/pdf' }), { name: 'plain.pdf' });
  const hints = { pages: 12 };
  const bodies = async (suffix: string) => (await api()).filter((r) => r.path.endsWith(suffix)).map((r) => JSON.parse(r.body));

  // documents.create.estimate: withHints, UploadFileOptions.hints, the description object, and a file with none.
  await kb.documents.create.estimate(withHints(unread(), hints));
  await kb.documents.create.estimate(UploadFile.fromBlob(new Unreadable([PDF], { type: 'application/pdf' }), { name: 'opts.pdf', hints }));
  await kb.documents.create.estimate({ name: 'described.pdf', contentType: 'application/pdf', byteSize: PDF.length, hints });
  await kb.documents.create.estimate(unread());
  assert.deepEqual((await bodies('/ingestions:estimate')).map((b) => b.documents[0]), [
    { name: 'plain.pdf', contentType: 'application/pdf', byteSize: PDF.length, hints },
    { name: 'opts.pdf', contentType: 'application/pdf', byteSize: PDF.length, hints },
    { name: 'described.pdf', contentType: 'application/pdf', byteSize: PDF.length, hints },
    { name: 'plain.pdf', contentType: 'application/pdf', byteSize: PDF.length },
  ]);

  // doc.replace.estimate: the same, as EstimateDocumentVersion's file.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const doc = kb.documents('doc-0001');
  await doc.replace.estimate(withHints(unread(), hints));
  await doc.replace.estimate(unread());
  const files = (await api()).filter((r) => r.method === 'POST' && r.body).map((r) => JSON.parse(r.body).file);
  assert.deepEqual(files, [
    { name: 'plain.pdf', contentType: 'application/pdf', byteSize: PDF.length, hints },
    { name: 'plain.pdf', contentType: 'application/pdf', byteSize: PDF.length },
  ]);

  // ingestion.sync.estimate: a list entry's file carries its hints; the other entry's has none. (Sync hashes every
  // file to plan the batch; the estimate itself reads nothing more.) Batch items carry no hints.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const plan = await kbScope().ingestion.sync.estimate([
    { path: 'hinted.pdf', file: withHints(UploadFile.fromBytes(enc('%PDF hinted'), { name: 'hinted.pdf' }), hints) },
    { path: 'plain.pdf', file: UploadFile.fromBytes(enc('%PDF plain'), { name: 'plain.pdf' }) },
  ], { folder: '/hints/' });
  assert.equal(plan.estimate?.documents, 2);
  const described = Object.fromEntries((await bodies('/ingestions:estimate'))[0].documents.map((d: { name: string }) => [d.name, d]));
  assert.deepEqual(described['hinted.pdf'].hints, hints);
  assert.ok(!('hints' in described['plain.pdf']), 'no hints member');
  const batchBody = JSON.parse((await api()).find((r) => r.method === 'POST' && r.path === BATCHES)!.body);
  assert.ok(batchBody.items.every((i: Record<string, unknown>) => !('hints' in i)), 'batch items carry no hints');
});

test('[access.set-no-if-match] access.set with no ifMatch sends no If-Match and reads nothing first; a given ifMatch is sent, and a stale one is a 412', async () => {
  const folder = client().knowledgeBases(KB).folders('/hr/investigations/');
  await folder.access.set({ readers: { roles: ['hr-team'] } });
  const [put, ...more] = await api();
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['if-match'], undefined, 'no If-Match');
  assert.deepEqual(more, [], 'no read first');
  const { etag } = await folder.access.get();
  await folder.access.set({ readers: 'everyone' }, { ifMatch: etag });
  assert.equal((await api()).at(-1).headers['if-match'], etag);
  const stale = await expectError(folder.access.set({ readers: 'inherit' }, { ifMatch: etag }));
  assert.ok(stale instanceof PreconditionFailedError, `got ${stale.name}`);
});

test("[access.readers-shorthand] access.set({readers}) takes 'inherit', 'public', 'everyone' or {roles, people}, and sends the modelled {kind, …} shape", async () => {
  const kb = client().knowledgeBases(KB);
  const folder = kb.folders('/hr/investigations/');
  const cases: [NonNullable<Parameters<typeof folder.access.set>[0]>['readers'], unknown][] = [
    [{ roles: ['hr-team'] }, { kind: 'specific', roles: ['hr-team'] }],
    [{ roles: ['hr-team'], people: ['u-7'] }, { kind: 'specific', roles: ['hr-team'], people: ['u-7'] }],
    ['everyone', { kind: 'everyone' }],
    ['public', { kind: 'public' }],
    ['inherit', { kind: 'inherit' }],
    [{ kind: 'specific', roles: ['staff'] }, { kind: 'specific', roles: ['staff'] }],
  ];
  for (const [readers, wire] of cases) {
    const { etag } = await folder.access.get();
    const out = await folder.access.set({ readers }, { ifMatch: etag });
    const put = (await api()).at(-1);
    assert.deepEqual(JSON.parse(put.body), { readers: wire });
    assert.equal(put.headers['if-match'], etag);
    assert.deepEqual(out.readers, wire);
  }
  const doc = kb.documents('doc-0001');
  const { etag } = await doc.access.get();
  await doc.access.set({ readers: 'everyone' }, { ifMatch: etag });
  assert.deepEqual(JSON.parse((await api()).at(-1).body), { readers: { kind: 'everyone' } });
});

test("[access.public] access.set({readers: 'public'}) sends {kind: 'public'}, and the access read back has kind public", async () => {
  const folder = client().knowledgeBases(KB).folders('/policies/');
  await folder.access.set({ readers: 'public' });
  assert.deepEqual(JSON.parse((await api()).at(-1).body), { readers: { kind: 'public' } });
  const read = await folder.access.get();
  assert.equal(read.readers?.kind, ReadersKind.PUBLIC);
  const doc = client().knowledgeBases(KB).documents('doc-0001');
  await doc.access.set({ readers: { kind: ReadersKind.PUBLIC } });
  assert.equal((await doc.access.get()).readers?.kind, 'public');
});

// ---------------------------------------------------------------- watching and waiting (PROTOCOL.md 16)

/** A document with a job running on it when its watch connects, ending as `outcome`. */
const busy = (documentId: string, outcome?: string, extra: Record<string, unknown> = {}) =>
  faults({ busyDocuments: { [documentId]: true }, ...(outcome ? { jobOutcomes: { [documentId]: outcome } } : {}), ...extra });
const watches = async () => (await api()).filter((r) => r.path === `${KB_PATH}/events`);

test('[watch.snapshot-first] watch() opens the knowledge base’s watch with the scope as its filter, yields the snapshot first, then each change', async () => {
  await busy('doc-0002');
  const events: any[] = [];
  for await (const event of client().knowledgeBases(KB).documents('doc-0002').watch()) {
    events.push(event);
    if (event.type === 'job.finished') break;
  }
  const [snapshot] = events;
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.document.id, 'doc-0002');
  assert.equal(snapshot.jobs[0]?.kind, 'document_ingestion');
  assert.ok(events.some((e) => e.type === 'document.progress' && typeof e.processing.percent === 'number'));
  assert.ok(events.some((e) => e.type === 'document.updated' && e.document.status === 'indexed'));
  assert.equal(events.filter((e) => e.type === 'snapshot').length, 1);
  const [request] = await watches();
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.query)), { document: 'doc-0002' });
  // The same on a folder, and on the whole knowledge base.
  for await (const event of client().knowledgeBases(KB).folders('/hr/').watch()) {
    assert.equal(event.type, 'snapshot');
    assert.ok(event.type === 'snapshot' && event.folder?.path === '/hr/');
    break;
  }
  for await (const event of client().knowledgeBases(KB).watch()) {
    assert.ok(event.type === 'snapshot' && event.knowledgeBase?.id === KB);
    break;
  }
  assert.deepEqual((await watches()).map((r) => r.query), ['?document=doc-0002', '?folder=%2Fhr%2F', '']);
});

test('[watch.reconnect-snapshot] after a dropped connection, watch() reconnects with no cursor and yields the new snapshot first again', async () => {
  await busy('doc-0002', undefined, { watchDrops: { count: 1, afterEvents: 2 } });
  const types: string[] = [];
  for await (const event of client().knowledgeBases(KB).documents('doc-0002').watch()) {
    types.push(event.type);
    if (event.type === 'job.finished') break;
  }
  assert.equal(types[0], 'snapshot');
  assert.equal(types[2], 'snapshot', 'the new connection starts with a snapshot, which the SDK yields');
  const [first, second] = await watches();
  assert.ok(second, 'a reconnect');
  assert.equal(second.headers['last-event-id'], undefined, 'no cursor');
  assert.equal(second.query, first.query, 'the same filter');
});

test('[wait.done] wait() returns the thing, as its get would, once no job on it is running', async () => {
  await busy('doc-0002');
  const doc = await client().knowledgeBases(KB).documents('doc-0002').wait();
  assert.equal(doc.status, 'indexed');
  assert.ok(doc.etag, 'as GetDocument returns it, ETag included');
  assert.equal((await api()).at(-1).path, `${KB_PATH}/documents/doc-0002`, 'read with its get once done');
  // A knowledge base with nothing running returns at once.
  const kb = await client().knowledgeBases(KB).wait();
  assert.equal(kb.id, KB);
});

test('[wait.partial] wait() returns on a job that ended completed_with_failures, with the partial failures on the thing', async () => {
  await busy('doc-0002', 'completed_with_failures');
  const doc = await client().knowledgeBases(KB).documents('doc-0002').wait();
  assert.equal(doc.status, 'partially_indexed');
  assert.equal(doc.partialFailures?.[0]?.code, 'PICTURE_DESCRIPTION_FAILED');
});

test('[wait.failed] wait() raises a failed job as the typed error for its code, and a cancelled one as CANCELLED', async () => {
  await busy('doc-0002', 'failed');
  const failed = await expectError(client().knowledgeBases(KB).documents('doc-0002').wait());
  assert.ok(failed instanceof UnprocessableContentError, `got ${failed.name}`);
  assert.equal(failed.status, 422);
  assert.equal(failed.code, 'CONTENT_REJECTED');
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await busy('doc-0002', 'cancelled');
  const cancelled = await expectError(client().knowledgeBases(KB).documents('doc-0002').wait());
  assert.equal(cancelled.code, 'CANCELLED');
  assert.equal(cancelled.status, 0);
});

test('[wait.gone] wait() after a delete returns when the thing is gone; on any other call a 404 ends the wait', async () => {
  const kb = client().knowledgeBases(KB);
  const gone = await kb.documents('doc-0003').delete().wait();
  assert.equal(gone, undefined);
  await expectError(kb.documents('doc-0003').get()).then((e) => assert.equal(e.status, 404));
  const missing = await expectError(kb.documents('doc-none').wait());
  assert.ok(missing instanceof NotFoundError, `got ${missing.name}`);
  // A folder: its job ends, and it is gone.
  assert.equal(await kb.folders('/archive/').delete().wait(), undefined);
  assert.ok(!(await collect(kb.folders.list())).some((f) => f.path === '/archive/'));
});

test('[wait.delete-processing] a document still being processed can be deleted: delete().wait() ends on the gone rule, with no CANCELLED, and the document stays gone', async () => {
  const kb = client().knowledgeBases(KB);
  const doc = await kb.documents.create(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' }), { folder: '/hr/' });
  assert.equal(doc.status, 'pending');
  const deleted = doc.delete();
  await deleted; // accepted, no 409
  assert.equal(await deleted.wait(), undefined);
  const gone = await expectError(kb.documents(doc.id).get());
  assert.equal(gone.status, 404);
  assert.ok(!(await collect(kb.documents.list())).some((d) => d.id === doc.id), 'it does not come back');
});

test('[wait.started-work] a call that starts work returns its result and something to wait on, and its wait() follows that work', async () => {
  const kb = client().knowledgeBases(KB);
  // One await: the document, once indexed, as its scope.
  const doc = await kb.documents.create(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' }), { folder: '/hr/' }).wait();
  assert.equal(doc.status, 'indexed');
  assert.equal(doc.documentId, doc.id);
  assert.equal(typeof doc.replace, 'function');
  // Awaiting alone gives the response.
  const started = await kb.fields.fillIn(['policyOwner']);
  assert.equal(started.job.status, 'queued');
  const job = await kb.fields.fillIn(['policyOwner']).wait();
  assert.equal(job.status, 'succeeded');
  assert.equal(job.kind, 'fill_in');
  // watch() on the same kind of handle follows the work: the snapshot first, then the job's changes.
  const seen: string[] = [];
  for await (const event of kb.fields.fillIn(['policyOwner']).watch()) {
    seen.push(event.type);
    if (event.type === 'job.finished') break;
  }
  assert.equal(seen[0], 'snapshot');
  assert.ok(seen.includes('job.progress'));
  const replaced = await kb.documents('doc-0001').replace(UploadFile.fromBytes(enc('%PDF 2027'), { name: 'policy-1.pdf' })).wait();
  assert.equal(replaced.version, 2, 'the new version is the current one');
});

test('[wait.busy-status] wait() treats a busy status as busy even when no job is listed, and returns once it has moved on', async () => {
  await faults({ busyWithoutJob: { 'doc-0002': 3 } });
  const kb = client().knowledgeBases(KB);
  const seen: any[] = [];
  const watching = (async () => {
    for await (const event of kb.documents('doc-0002').watch()) {
      seen.push(event);
      break;
    }
  })();
  const doc = await kb.documents('doc-0002').wait();
  await watching;
  assert.equal(doc.status, 'indexed');
  // A knowledge base being created has no job either: its wait() returns once it is ready.
  const created = await client().knowledgeBases.create({ name: 'Leave policies' });
  assert.equal(created.status, 'creating');
  const ready = await created.wait();
  assert.equal(ready.status, 'ready');
});

test('[wait.timeout] wait() given a time limit that passes raises a TimeoutError with code WAIT_TIMEOUT, and closes the watch', async () => {
  await faults({ busyWithoutJob: { 'doc-0002': 100_000 } });
  const err = await client().knowledgeBases(KB).documents('doc-0002').wait({ timeoutMs: 150 }).catch((e) => e);
  assert.equal(err?.name, 'TimeoutError', String(err));
  assert.equal(err.code, 'WAIT_TIMEOUT');
  assert.equal(err.status, 0);
  // The watch is closed: the server sees the client leave. A failure says what the server did see of the watch.
  for (const until = Date.now() + 10_000; !(await requests()).some((r) => r.event === 'client-disconnected'); ) {
    if (Date.now() > until) assert.fail(`the watch was not closed; the server saw ${JSON.stringify((await requests()).map((r) => r.event ?? `${r.method} ${r.path}`))}`);
    await new Promise((r) => setTimeout(r, 10));
  }
});

test('[scope.download] kb.documents(id).download() calls GetDocumentDownload and returns its {url, expiresAt}, sending nothing to the address', async () => {
  const out = await client().knowledgeBases(KB).documents('doc-0001').download();
  assert.match(out.url, /\/__s3\/content\/doc-0001\?/);
  assert.ok(out.expiresAt instanceof Date);
  const sent = (await requests()).filter((r) => r.method && r.method !== 'OPTIONS');
  assert.deepEqual(sent.map((r) => r.path), [`${KB_PATH}/documents/doc-0001/download`], 'no request to the address');
  assert.equal(typeof client().core.documents.content, 'function', 'the 302 is the building block');
});

test('[core.content-redirect] core.documents.content() returns the 302 as its success, with the address unfollowed, sending nothing to it; a page gets REDIRECT_UNREADABLE', async () => {
  const sent = async () => (await requests()).filter((r) => r.method && r.method !== 'OPTIONS').map((r) => r.path);
  if (IN_PAGE) {
    // A browser hides the redirect from the page: an error the SDK raises itself, never retried, pointing to download().
    const err = await expectError(client().core.documents.content(KB, 'doc-0001'));
    assert.equal(err.code, 'REDIRECT_UNREADABLE');
    assert.equal(err.status, 0);
    assert.match(err.message, /kb\.documents\(id\)\.download\(\)/);
    assert.ok(!(err instanceof CaitlynConnectionError), 'not a connection error');
    assert.deepEqual(await sent(), [`${KB_PATH}/documents/doc-0001/content`], 'one request, never retried');
    return;
  }
  const out = await client().core.documents.content(KB, 'doc-0001');
  assert.match(out.location, /\/__s3\/content\/doc-0001\?/);
  assert.equal(out.url, out.location);
  assert.equal(out.$metadata.httpStatusCode, 302);
  assert.deepEqual(await sent(), [`${KB_PATH}/documents/doc-0001/content`], 'nothing sent to the address');
});

test('[send.attachments] send(text, {attachments}) uploads each file for the conversation, in order, then one SendMessage names them', async () => {
  const c = client();
  const conversation = await c.agents(AGENT).live.conversations.create();
  const id = conversation.id;
  const already = await c.core.uploads.send(UploadFile.fromBytes(enc('%PDF earlier'), { name: 'earlier.pdf' }), { purpose: { conversationId: id } });
  await fetch(`${BASE}/__mock/requests`); // the log keeps everything; read from here on
  const before = (await reservations()).length;
  const a = UploadFile.fromBytes(enc('%PDF leave form'), { name: 'leave-form.pdf' });
  const b = new File([enc('%PDF policy') as BlobPart], 'policy.pdf', { type: 'application/pdf' });
  let text = '';
  for await (const delta of conversation.send('Does this leave form match our policy?', { attachments: [a, { uploadId: already.id }, b] }).text()) text += delta;
  assert.equal(text, 'Staff receive 20 days of annual leave.');
  const reserved = (await reservations()).slice(before);
  assert.deepEqual(reserved.map((r) => [r.fileName, r.purpose]), [['leave-form.pdf', { conversationId: id }], ['policy.pdf', { conversationId: id }]], 'each file reserved for the conversation; the upload id passes straight through');
  const ids = (await puts()).slice(-2).map((p) => p.path.split('/').pop());
  const sent = (await api()).filter((r) => r.method === 'POST' && r.path === `/v3/conversations/${id}/messages`);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body).attachments, [{ uploadId: ids[0] }, { uploadId: already.id }, { uploadId: ids[1] }], 'in the order given');
  const [message] = await collect(c.conversations(id).messages.list());
  assert.deepEqual((message as any).attachments.map((x: any) => x.name), ['leave-form.pdf', 'earlier.pdf', 'policy.pdf']);
  // Sending the same files again uploads them again: each upload is used up by its message.
  await collect(conversation.send('And this one?', { attachments: [a, b] }));
  assert.equal((await reservations()).length - before, 4);
  // A file that fails to upload: no message is sent, and the call raises its error.
  await faults({ status: { PutUpload: [0, 1, 2].map(() => ({ status: 500 })) } });
  const messagesBefore = (await api()).filter((r) => r.path === `/v3/conversations/${id}/messages` && r.method === 'POST').length;
  const err = await expectError(collect(conversation.send('One more?', { attachments: [a] })));
  assert.equal(err.code, 'UPLOAD_PUT_FAILED');
  assert.equal((await api()).filter((r) => r.path === `/v3/conversations/${id}/messages` && r.method === 'POST').length, messagesBefore, 'no message sent');
});

test('[send.break-then-final] a break out of a send() stream leaves it open for finalMessage(), which drains and closes it; a stream left after a break closes on close(), its signal or the end of an await using block', async () => {
  const logOf = async (id: string) => (await requests()).filter((r) => r.conversationId === id || r.path?.startsWith(`/v3/conversations/${id}/`));
  // The server sees the client leave: a client-disconnected entry, within 5 s, and no request after it.
  const leaves = async (id: string, why: string) => {
    for (const until = Date.now() + 5000; !(await logOf(id)).some((r) => r.event === 'client-disconnected'); ) {
      if (Date.now() > until) assert.fail(`${why}: the server did not see the client leave within 5 s`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const log = await logOf(id);
    assert.ok(log.some((r) => r.event === 'server-holding-stream'), `${why}: the server was still sending when the client left`);
    const left = log.findIndex((r) => r.event === 'client-disconnected');
    assert.deepEqual(log.slice(left + 1).filter((r) => r.path), [], `${why}: no further request`);
  };
  await faults({ streamDelayMs: 30 });
  // A break from text(): the connection stays open; finalMessage() drains it, returns the message and closes it.
  const answer = client().conversations('c-btf').send('How much annual leave do staff get?');
  for await (const delta of answer.text()) {
    assert.ok(delta);
    break;
  }
  const message = await answer.finalMessage();
  assert.equal(message.role, 'assistant');
  assert.ok(message.text, 'the whole answer');
  assert.ok(!(await logOf('c-btf')).some((r) => r.event === 'client-disconnected'), 'read to its end, not cut off');
  // From here the server holds each answer open after its first text delta (the fifth event) until the client
  // leaves, so only the client closing it can end it.
  await faults({ holdAfterEvents: 5 });
  // A break from the events, then close().
  const closed = client().conversations('c-btc').send('How much annual leave do staff get?');
  for await (const event of closed) {
    if (event.type === 'text.delta') break;
  }
  await closed.close();
  await leaves('c-btc', 'close()');
  // Its abort signal, with nothing reading the stream.
  const controller = new AbortController();
  const aborted = client().conversations('c-bta').send('How much annual leave do staff get?', {}, { signal: controller.signal });
  for await (const delta of aborted.text()) {
    assert.ok(delta);
    break;
  }
  controller.abort();
  await leaves('c-bta', 'the signal');
  // Leaving an await using block.
  {
    await using disposed = client().conversations('c-btu').send('How much annual leave do staff get?');
    for await (const delta of disposed.text()) {
      assert.ok(delta);
      break;
    }
  }
  await leaves('c-btu', 'the end of the await using block');
});

test("[send.text] a conversation's send() stream has text(), which yields only the answer's text deltas, in order", async () => {
  const parts: string[] = [];
  for await (const text of client().conversations('c-text').send('How much annual leave do staff get?').text()) parts.push(text);
  assert.deepEqual(parts, ['Staff receive ', '20 days of annual leave.']);
});

test('[wait.deadline-reread] a batch past its uploadsExpireAt (plus 30 s) and still open is read again by wait() and watch(), which carry on from the read', async () => {
  const kb = client().knowledgeBases(KB);
  const batchReads = async () => (await api()).filter((r) => r.method === 'GET' && /\/ingestion-batches\/[^/]+$/.test(r.path)).length;
  // The mock's deadlinePassed: only GetIngestionBatch ends a batch past its deadline, and its watch never shows the end.
  // 'uploads': started, nothing uploaded, uploadsExpireAt a minute gone.
  await faults({ deadlinePassed: 'uploads' });
  const batch = await startedBatch({ '/hr/annual-leave.pdf': PDF });
  const done: IngestionBatch = await batch.wait({ timeoutMs: 10_000 });
  assert.equal(done.status, 'completed_with_failures');
  const [item] = await itemsOf(batch);
  assert.equal(item.status, 'failed');
  assert.equal(item.failureCode, 'UPLOAD_EXPIRED');
  // watch() yields the read as a snapshot: a fresh batch, so that only the SDK's read can show it ended.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ deadlinePassed: 'uploads' });
  const watched = await startedBatch({ '/hr/annual-leave.pdf': PDF });
  const before = await batchReads();
  let ended: Record<string, any> | undefined;
  for await (const event of watched.watch({ signal: AbortSignal.timeout(10_000) })) {
    if (event.type === 'snapshot' && event.batch?.status === 'completed_with_failures') {
      ended = event;
      break;
    }
  }
  assert.equal(ended?.batch.id, watched.id);
  assert.ok((await batchReads()) > before, 'GetIngestionBatch was sent');
  await readOncePerDeadline();
});

/** wait.deadline-reread: each deadline is read once, and a new snapshot starts the timer again. */
async function readOncePerDeadline() {
  // A watch of our own: a running batch due to be read in 100 ms, then 300 ms later a snapshot with a renewed deadline,
  // also due in 100 ms. Each read returns the same deadline as the snapshot before it, and the batch still running.
  const at = (ms: number) => new Date(Date.now() - DEADLINE_GRACE_MS + ms);
  const batch = (uploadsExpireAt: Date) => ({ id: 'IB1', status: 'running', uploadsExpireAt });
  const first = batch(at(100));
  let second: ReturnType<typeof batch> | undefined;
  let closed = false;
  const watch: AsyncIterable<Record<string, any>> = {
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        next: async () => {
          if (n++ === 0) return { done: false, value: { type: 'snapshot', batch: first, jobs: [], progress: [] } };
          if (n === 2) {
            await new Promise((r) => setTimeout(r, 300));
            second = batch(at(100));
            return { done: false, value: { type: 'snapshot', batch: second, jobs: [], progress: [] } };
          }
          return new Promise<never>(() => {});
        },
        return: async () => {
          closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const reads: Date[] = [];
  const stream = rereadAtDeadline(watch, async () => {
    const b = reads.length === 0 ? first : second!;
    reads.push(b.uploadsExpireAt);
    return { ...b };
  });
  const seen: Record<string, any>[] = [];
  // Four events: the snapshot, its read, the new snapshot, its read. A deadline read twice would be the third.
  const limit = setTimeout(() => assert.fail(`only ${seen.length} events in 2 s`), 2_000);
  for await (const event of stream) {
    seen.push(event);
    if (seen.length === 4) break;
  }
  clearTimeout(limit);
  assert.deepEqual(reads, [first.uploadsExpireAt, second!.uploadsExpireAt], 'one read per deadline, the second after the new snapshot');
  assert.deepEqual(seen.map((e) => [e.type, e.jobs.length]), [['snapshot', 0], ['snapshot', 0], ['snapshot', 0], ['snapshot', 0]]);
  assert.equal(batchDeadline(seen[1].batch), first.uploadsExpireAt.getTime());
  assert.ok(closed, 'leaving the watch closes it');
}

test("[watch.gone] a 404 when watch() reconnects ends the watch at once, as the thing gone, without counting towards STREAM_LOST", async () => {
  await busy('doc-0002', undefined, { watchDrops: { count: 1, afterEvents: 1 }, watchGoneAfterDrop: true });
  const kb = client().knowledgeBases(KB);
  const seen: string[] = [];
  const err = await expectError((async () => {
    for await (const event of kb.documents('doc-0002').watch()) seen.push(event.type);
  })());
  assert.ok(err instanceof NotFoundError, `got ${err.name}`);
  assert.deepEqual(seen, ['snapshot']);
  assert.equal((await watches()).length, 2, 'one reconnect, answered 404, and no more');
  // wait() then ends by the gone rule: after a delete, as success.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ watchDrops: { count: 1, afterEvents: 1 }, watchGoneAfterDrop: true, deletingReads: 1_000 });
  const doc = kb.documents('doc-0004');
  const deleted = doc.delete();
  await deleted;
  assert.equal(await deleted.wait(), undefined);
});

test('[wait.progress] wait({onProgress}) is called with the snapshot’s processing, then each progress event’s, in order, and never after it returns', async () => {
  await busy('doc-0002');
  const kb = client().knowledgeBases(KB);
  const seen: number[] = [];
  let returned = false;
  let late = 0;
  const doc = await kb.documents('doc-0002').wait({
    onProgress: (p) => {
      if (returned) late++;
      seen.push(p.percent as number);
    },
  });
  returned = true;
  assert.equal(doc.status, 'indexed');
  assert.ok(seen.length >= 3, `${seen.length} calls`);
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'in order, never going back');
  // The progress events the watch carried, once each: compare with a watch of another busy document.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(late, 0, 'not called once wait() returned');
  // On a handle: create(…).wait({onProgress}).
  const calls: string[] = [];
  await kb.documents.create(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' }), { folder: '/hr/' }).wait({ onProgress: (p) => calls.push(String(p.stage)) });
  assert.ok(calls.length >= 2, `${calls.length} calls on the handle`);
});

test('[watch.processing] every watch event has one accessor for a thing’s processing, for the snapshot and progress events alike', async () => {
  await busy('doc-0002');
  const kb = client().knowledgeBases(KB);
  const read: [string, number | undefined][] = [];
  for await (const event of kb.documents('doc-0002').watch()) {
    read.push([event.type, event.processing?.percent as number | undefined]);
    if (event.type === 'job.finished') break;
  }
  assert.equal(read[0]![0], 'snapshot');
  assert.equal(read[0]![1], 0, 'the snapshot’s processing for the watched document');
  assert.ok(read.some(([t, p]) => t === 'document.progress' && typeof p === 'number'));
  assert.equal(read.find(([t]) => t === 'job.finished')![1], undefined, 'nothing when the event carries none');
  assert.equal(Object.keys(read).length > 0, true);
  // On the knowledge base's own watch, it takes the document's identifier.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  // Enough steps that the job is still running when the knowledge base's watch connects, however slowly the page reads
  await busy('doc-0003', undefined, { jobSteps: 50 });
  const kbEvents: [string, unknown, unknown][] = [];
  for await (const event of client().knowledgeBases(KB).documents('doc-0003').watch()) {
    if (event.type === 'snapshot') continue; // starts the job
    break;
  }
  for await (const event of kb.watch()) {
    kbEvents.push([event.type, event.processingOf('doc-0003'), event.processingOf('doc-none')]);
    // Ends on the first event that carries the document's processing, or when its job ends, never waiting on a quiet watch
    if (event.processingOf('doc-0003') || event.type === 'job.finished' || kbEvents.length > 20) break;
  }
  const progress = kbEvents.find(([t]) => t === 'document.progress' || t === 'snapshot');
  assert.ok(progress && progress[1], 'the named document’s processing');
  assert.ok(kbEvents.every(([, , none]) => none === undefined), 'nothing for a document the event does not carry');
});

test('[wait.planned] batch.planned() waits until the batch is planned or past it', async () => {
  await faults({ planningReads: 3 });
  const kb = client().knowledgeBases(KB);
  const batch = await kb.ingestion.batches.create({ start: 'manual', items: [{ path: '/hr/a.pdf', sha256: await sha256(PDF), byteSize: PDF.length, contentType: 'application/pdf' }] });
  assert.equal(batch.status, 'planning');
  const planned = await kb.ingestion.batches(batch.id).planned();
  assert.equal(planned.status, 'planned');
  assert.ok(planned.etag);
  const [w] = await watches();
  assert.deepEqual(Object.fromEntries(new URLSearchParams(w.query)), { batch: batch.id });
});

test('[send.eager] conversation.send(message) sends the message when it is called, whether or not its stream is read', async () => {
  const conversation = client().conversations('c-eager');
  conversation.send('Is anyone there?'); // never read
  const sent = await untilRequest((r) => r.method === 'POST' && r.path === '/v3/conversations/c-eager/messages');
  assert.deepEqual(JSON.parse(sent.body), { message: 'Is anyone there?' });
  // Read, it is the answer.
  let text = '';
  for await (const delta of conversation.send('How much annual leave do staff get?').text()) text += delta;
  assert.equal(text, 'Staff receive 20 days of annual leave.');
});

test('[since.fails-before-sending] an operation newer than the server fails before anything is sent', async () => {
  await faults({ apiVersion: '5.110.0' });
  const c = client();
  await c.agents('GHT7YRWXPL').draft.get(); // no check before the first response
  const before = (await api()).length;
  await assert.rejects(c.agents('GHT7YRWXPL').draft.get(), (e: unknown) => {
    assert.ok(e instanceof NotSupportedByServer);
    assert.equal(e.requires, SDK_MODEL);
    assert.equal(e.server, '5.110.0');
    return true;
  });
  assert.equal((await api()).length, before);
});

test('[headers.request-id] Caitlyn-Request-Id and Caitlyn-Api-Version are on successful outputs', async () => {
  const v = await client().agents('GHT7YRWXPL').draft.get();
  // A thing has no header members: the request id and the API version are in its response metadata.
  assert.equal(v.$metadata.requestId, (await api()).at(-1).requestId);
  assert.equal(v.$metadata.apiVersion, '5.120.0');
});

test("[headers.response-metadata] a successful call's response metadata gives its HTTP status and request id", async () => {
  const v = await client().agents('GHT7YRWXPL').draft.get();
  const metadata = v.$metadata; // typed on every single-call output (MetadataBearer)
  assert.equal(metadata.httpStatusCode, 200);
  assert.equal(metadata.requestId, (await api()).at(-1).requestId);
  assert.equal(v.etag, '"draft-1"'); // the ETag is the modelled member (PROTOCOL.md 4.2)
});

test('[telemetry.spans] one span per call, one child span per attempt, traceparent sent', async () => {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  try {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 0 }] } });
    await client({ telemetry: { tracerProvider: provider } }).agents('GHT7YRWXPL').draft.get();
    const spans = exporter.getFinishedSpans();
    const call = spans.find((s) => s.name === 'caitlyn.call');
    assert.ok(call, `spans: ${spans.map((s) => s.name).join(', ')}`);
    const attempts = spans.filter((s) => s.parentSpanContext?.spanId === call.spanContext().spanId);
    assert.deepEqual(attempts.map((s) => s.attributes['http.request.resend_count']), [0, 1]);
    const sent = await api();
    assert.equal(call.attributes['caitlyn.request_id'], sent.at(-1).requestId);
    assert.ok(sent.every((r) => r.headers.traceparent), 'traceparent on every attempt');
  } finally {
    propagation.disable();
  }
});

test('[telemetry.attributes] the shared span names and attributes, on a failed call, a list and an upload', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const c = client({ telemetry: { tracerProvider: provider } });
  await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 0 }] } });
  await expectError(c.agents('GHT7YRWXPL').versions('nope').get());
  for await (const _ of c.knowledgeBases('KB4T7YQ2WL').documents.list({ limit: 100 })) void _;
  await c.core.uploads.send(UploadFile.fromBytes(new TextEncoder().encode('hello'), { name: 'hello.txt' }));
  const spans = exporter.getFinishedSpans();
  const sent = (await api()).filter((r) => r.path === '/v3/agents/GHT7YRWXPL/versions/nope');
  const children = (s: (typeof spans)[number]) => spans.filter((x) => x.parentSpanContext?.spanId === s.spanContext().spanId);
  assert.ok(spans.every((s) => ['caitlyn.call', 'caitlyn.attempt', 'caitlyn.upload'].includes(s.name)), spans.map((s) => s.name).join(', '));
  assert.ok(spans.every((s) => !('caitlyn.operation' in s.attributes)));

  const call = spans.find((s) => s.name === 'caitlyn.call' && s.attributes['rpc.method'] === 'GetAgentVersion')!;
  assert.equal(call.attributes['rpc.system'], 'caitlyn');
  assert.equal(call.attributes['error.type'], 'NotFoundError');
  assert.equal(call.attributes['caitlyn.error.code'], 'NOT_FOUND');
  assert.equal(call.attributes['caitlyn.request_id'], sent.at(-1).requestId);
  assert.equal(call.status.code, SpanStatusCode.ERROR);
  assert.ok(call.status.message, 'call status message');
  assert.ok(call.events.some((e) => e.name === 'exception' && e.attributes?.['exception.type'] === 'NotFoundError'), 'call exception event');
  const attempts = children(call);
  assert.deepEqual(attempts.map((s) => s.name), ['caitlyn.attempt', 'caitlyn.attempt']);
  assert.deepEqual(attempts.map((s) => s.attributes['http.request.resend_count']), [0, 1]);
  assert.deepEqual(attempts.map((s) => s.attributes['http.response.status_code']), [503, 404]);
  assert.deepEqual(attempts.map((s) => s.attributes['caitlyn.request_id']), sent.map((r) => r.requestId));
  for (const a of attempts) {
    assert.equal(a.attributes['http.request.method'], 'GET');
    assert.equal(a.attributes['server.address'], '127.0.0.1');
    assert.equal(a.attributes['url.full'], `${BASE}/v3/agents/GHT7YRWXPL/versions/nope`);
    assert.equal(a.attributes['caitlyn.server.api_version'], '5.120.0');
    assert.equal(a.status.code, SpanStatusCode.ERROR);
    assert.ok(a.status.message, 'attempt status message');
  }
  assert.deepEqual(attempts.map((s) => s.attributes['error.type']), ['ServiceUnavailableError', 'NotFoundError']);
  assert.deepEqual(attempts.map((s) => s.attributes['caitlyn.error.code']), ['SERVICE_UNAVAILABLE', 'NOT_FOUND']);
  assert.deepEqual(
    attempts.map((s) => s.events.find((e) => e.name === 'exception')?.attributes?.['exception.type']),
    ['ServiceUnavailableError', 'NotFoundError'],
  );

  const list = spans.find((s) => s.name === 'caitlyn.call' && s.attributes['rpc.method'] === 'ListDocuments')!;
  assert.deepEqual(children(list).map((s) => s.attributes['url.full']), [`${BASE}/v3/knowledge-bases/KB4T7YQ2WL/documents`]);
  assert.notEqual(children(list)[0]!.status.code, SpanStatusCode.ERROR);

  const upload = spans.find((s) => s.name === 'caitlyn.upload')!;
  assert.equal(upload.attributes['http.request.method'], 'PUT');
  assert.equal(upload.attributes['server.address'], '127.0.0.1');
  assert.match(String(upload.attributes['url.full']), /^http:\/\/127\.0\.0\.1:\d+\/__s3\/[^?]+$/);
  assert.equal(upload.attributes['http.response.status_code'], 200);
});

test('[endpoint.workspace] a workspace hostname resolves to https://<workspace>/api', async () => {
  const c = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'pat_test' } });
  const endpoint = await (c.client.config as unknown as { endpoint: () => Promise<{ protocol: string; hostname: string; path: string }> }).endpoint();
  assert.equal(`${endpoint.protocol}//${endpoint.hostname}${endpoint.path}`, 'https://your-company.getcaitlyn.ai/api');
});

// ---------------------------------------------------------------- sign-in (PROTOCOL.md section 12)
// Against the mock server's OAuth endpoints and STS stand-in (conformance/mock-server/auth.mjs). Each test turns
// on the mock's `require` fault, so every /v3/ request needs a credential the mock issued or accepts.

// The audience comes from the workspace, never from the endpoint override these tests use.
const RESOURCE = 'https://your-company.getcaitlyn.ai/api';
const signInRequired = () => faults({ auth: { require: true } });
const authCounts = async (): Promise<Record<string, number>> => (await (await fetch(`${BASE}/__mock/auth`)).json()).counts;
const tokenRequests = async () => (await requests()).filter((r) => r.path === '/oauth/token').map((r) => new URLSearchParams(r.body));
const signedIn = (auth: AuthOptions, workspace = 'your-company.getcaitlyn.ai') => new Caitlyn({ workspace, endpoint: BASE, auth, telemetry: { enabled: false } });
const read = (c: Caitlyn) => c.agents('GHT7YRWXPL').draft.get();
const ccAuth = (extra: Partial<Extract<AuthOptions, { mode: 'clientCredentials' }>> = {}): AuthOptions => ({ mode: 'clientCredentials', clientId: MOCK_CLIENT.id, clientSecret: MOCK_CLIENT.secret, ...extra });

async function authError(p: Promise<unknown>): Promise<CaitlynAuthError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof CaitlynAuthError, `expected CaitlynAuthError, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
    return err;
  }
  assert.fail('expected a sign-in error');
}

const memoryStore = (initial?: OAuthTokens): TokenStore & { tokens?: OAuthTokens; clears: number } => {
  const s = {
    tokens: initial,
    clears: 0,
    load: () => s.tokens,
    save: (t: OAuthTokens) => void (s.tokens = t),
    clear: () => void ((s.tokens = undefined), s.clears++),
  };
  return s;
};

/** The `oauth` sign-in steps, following the mock's redirect as a browser would. */
async function oauthSignIn(c: Caitlyn): Promise<URL> {
  const { url, state, codeVerifier } = await c.auth.authorizationUrl();
  // A page cannot read a redirect's Location (fetch gives an opaque response), so there the mock answers with it.
  const location = IN_PAGE ? (await (await fetch(url, { headers: { accept: 'application/json' } })).json()).location : (await fetch(url, { redirect: 'manual' })).headers.get('location');
  const redirect = new URL(location!);
  await c.auth.handleCallback({ code: redirect.searchParams.get('code')!, state: redirect.searchParams.get('state')!, expectedState: state, codeVerifier });
  return new URL(url);
}

test('[endpoint.workspace-url] a workspace URL is its hostname; a path, query, fragment, user or other scheme is refused', async () => {
  const make = (workspace: string) => new Caitlyn({ workspace, auth: { mode: 'token', token: 'pat_test' } });
  for (const w of ['https://your-company.getcaitlyn.ai', 'https://your-company.getcaitlyn.ai/', 'your-company.getcaitlyn.ai/', 'HTTPS://Your-Company.GetCaitlyn.ai']) {
    const c = make(w);
    assert.equal(c.auth.workspace, 'your-company.getcaitlyn.ai', w);
    assert.equal(c.auth.tokenEndpoint, 'https://your-company.getcaitlyn.ai/api/oauth/token', w);
  }
  for (const w of ['https://your-company.getcaitlyn.ai/api', 'https://your-company.getcaitlyn.ai/?x=1', 'https://your-company.getcaitlyn.ai#top', 'http://your-company.getcaitlyn.ai', 'ftp://your-company.getcaitlyn.ai', 'me@your-company.getcaitlyn.ai', '']) {
    assert.throws(() => make(w), (e: Error) => e instanceof TypeError && e.message.includes('your-company.getcaitlyn.ai or https://your-company.getcaitlyn.ai'), JSON.stringify(w));
  }
});

test('[auth.workspace] the workspace sets the endpoint and the token audience; endpoint overrides only where requests go', async () => {
  await signInRequired();
  // A workspace given as a URL is reduced to its hostname.
  await read(signedIn(ccAuth(), 'https://your-company.getcaitlyn.ai/'));
  const [form] = await tokenRequests();
  assert.ok(form, 'the token request went to the overriding endpoint');
  assert.equal(form.get('resource'), RESOURCE);
  assert.equal((await api()).length, 1);
});

test('[auth.token] a personal access token is sent as the bearer token, with no token request', async () => {
  await signInRequired();
  await read(signedIn({ mode: 'token', token: MOCK_PAT }));
  assert.equal((await api())[0].headers.authorization, `Bearer ${MOCK_PAT}`);
  assert.deepEqual(await authCounts(), { sts: 0 });
});

test('[auth.client-credentials] one token request serves concurrent calls, bound to the workspace resource', async () => {
  await signInRequired();
  const c = signedIn(ccAuth({ scopes: ['agents:read'] }));
  await Promise.all([read(c), read(c), read(c)]);
  await read(c);
  assert.equal((await authCounts()).client_credentials, 1);
  const auths = new Set((await api()).map((r) => r.headers.authorization));
  assert.equal(auths.size, 1);
  assert.match([...auths][0], /^Bearer cai_cc_/);
  const [form] = await tokenRequests();
  assert.equal(form.get('client_id'), MOCK_CLIENT.id);
  assert.equal(form.get('resource'), RESOURCE);
  assert.equal(form.get('scope'), 'agents:read');
});

test('[auth.client-credentials-refused] a wrong secret is a sign-in error with the OAuth code', async () => {
  await signInRequired();
  const err = await authError(read(signedIn(ccAuth({ clientSecret: 'wrong' }))));
  assert.equal(err.code, 'invalid_client');
  assert.equal(err.status, 401);
  assert.equal((await api()).length, 0);
});

test('[auth.renew-before-expiry] a token is replaced before it expires: a minute early, or halfway through a short life', async () => {
  await faults({ auth: { require: true, expiresIn: 1 } });
  const c = signedIn(ccAuth());
  await read(c);
  await read(c);
  assert.equal((await authCounts()).client_credentials, 1, 'reused within the first half of its life');
  await new Promise((r) => setTimeout(r, 600));
  await read(c);
  assert.equal((await authCounts()).client_credentials, 2, 'replaced after half its life');
  assert.equal((await api()).length, 3, 'no call was refused');
});

test('[auth.401-signs-in-again] a token the server stopped accepting is replaced once, and the call succeeds', async () => {
  await signInRequired();
  const c = signedIn(ccAuth());
  await read(c);
  await faults({ auth: { revokeIssued: true } });
  const v = await read(c);
  assert.equal(v.agentId, 'GHT7YRWXPL');
  assert.equal((await authCounts()).client_credentials, 2);
  assert.equal((await api()).length, 3, 'the first call, then the refused attempt and the one after signing in again');
});

test('[auth.401-once] a second 401 after signing in again is raised, with no third attempt', async () => {
  await signInRequired();
  const c = signedIn(ccAuth());
  await read(c);
  // From here every token the mock issues expires at once, so the new token is refused too.
  await faults({ auth: { revokeIssued: true, expiresIn: 0 } });
  await assert.rejects(read(c), (e: any) => e.$metadata?.httpStatusCode === 401 && e.code === 'UNAUTHENTICATED');
  assert.equal((await authCounts()).client_credentials, 2, 'signed in again once');
  assert.equal((await api()).length, 3, 'the first call, then two attempts at the second');
});

test('[auth.401-token-mode] a refused personal access token fails with 401, without retrying', async () => {
  await signInRequired();
  await assert.rejects(read(signedIn({ mode: 'token', token: 'pat_revoked' })), (e: any) => e.$metadata?.httpStatusCode === 401 && e.code === 'UNAUTHENTICATED');
  assert.equal((await api()).length, 1);
});

test('[auth.oauth-sign-in] authorisation code with PKCE, then calls with the saved token', async () => {
  await signInRequired();
  const store = memoryStore();
  const c = signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, clientSecret: MOCK_OAUTH_CLIENT.secret, redirectUri: 'https://app.example.com/callback', scopes: ['chat:write'], tokenStore: store });
  const u = await oauthSignIn(c);
  assert.equal(u.pathname, '/oauth/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('resource'), RESOURCE);
  assert.equal(u.searchParams.get('scope'), 'chat:write');
  const [form] = await tokenRequests();
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('resource'), RESOURCE);
  assert.ok(store.tokens?.refreshToken);
  await read(c);
  assert.match((await api())[0].headers.authorization, /^Bearer cai_code_/);
});

test('[auth.oauth-state] a callback whose state does not match is refused before any token request', async () => {
  await signInRequired();
  const c = signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, redirectUri: 'https://app.example.com/callback' });
  const err = await authError(c.auth.handleCallback({ code: 'x', state: 'forged', expectedState: 'expected', codeVerifier: 'v' }));
  assert.equal(err.code, 'invalid_state');
  assert.equal((await tokenRequests()).length, 0);
});

test('[auth.oauth-refresh] an expired access token is refreshed with the stored refresh token, and the rotated one saved', async () => {
  await signInRequired();
  const store = memoryStore();
  await oauthSignIn(signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, redirectUri: 'https://app.example.com/callback', tokenStore: store }));
  const first = store.tokens!.refreshToken;
  // A new process with an expired access token in the store
  store.tokens = { ...store.tokens!, expiresAt: Date.now() - 1 };
  const later = signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, tokenStore: store });
  await Promise.all([read(later), read(later)]);
  assert.equal((await authCounts()).refresh_token, 1, 'one refresh however many calls wait');
  assert.notEqual(store.tokens!.refreshToken, first);
  assert.match((await api()).at(-1).headers.authorization, /^Bearer cai_refresh_/);
});

test('[auth.oauth-401-refreshes] a stored token the server refuses is not sent again: the refresh token replaces it', async () => {
  await signInRequired();
  const store = memoryStore();
  const c = signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, redirectUri: 'https://app.example.com/callback', tokenStore: store });
  await oauthSignIn(c);
  await read(c);
  await faults({ auth: { revokeIssued: true } });
  await read(c);
  assert.equal((await authCounts()).refresh_token, 1);
  const sent = (await api()).map((r) => r.headers.authorization);
  assert.equal(sent.length, 3);
  assert.equal(sent[1], sent[0], 'the refused token');
  assert.match(sent[2], /^Bearer cai_refresh_/);
});

test('[auth.oauth-401-single-flight] five 401s that arrive one after another cause one refresh, and every call succeeds', async () => {
  await signInRequired();
  const c = signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, redirectUri: 'https://app.example.com/callback', tokenStore: memoryStore() });
  await oauthSignIn(c);
  await read(c);
  // Every call is sent with the token the server now refuses; the 401s after the first arrive after its refresh.
  await faults({ auth: { revokeIssued: true, laterRefusalsDelayMs: 300 } });
  await Promise.all([read(c), read(c), read(c), read(c), read(c)]);
  assert.equal((await authCounts()).refresh_token, 1);
});

/** A token store whose withLock runs one function at a time: what a database or Redis lock gives a shared store. */
const lockingStore = (inner: ReturnType<typeof memoryStore>) => {
  let tail: Promise<unknown> = Promise.resolve();
  const s = Object.assign(inner, {
    locks: 0,
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      s.locks++;
      const run = tail.then(fn);
      tail = run.catch(() => undefined);
      return run;
    },
  });
  return s;
};

test('[auth.oauth-shared-store-lock] two clients sharing a locking store refresh once; the second uses the tokens the first saved', async () => {
  await signInRequired();
  const store = lockingStore(memoryStore());
  await oauthSignIn(signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, redirectUri: 'https://app.example.com/callback', tokenStore: store }));
  store.tokens = { ...store.tokens!, expiresAt: Date.now() - 1 }; // both clients find an expired access token
  await faults({ auth: { refreshDelayMs: 300 } }); // the first refresh is still in flight when the second client asks
  const a = signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, tokenStore: store });
  const b = signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, tokenStore: store });
  await Promise.all([read(a), read(b)]);
  assert.equal((await authCounts()).refresh_token, 1);
  assert.ok(store.locks >= 2, 'both clients took the lock');
  const sent = (await api()).slice(-2).map((r) => r.headers.authorization);
  assert.equal(sent[0], sent[1], "the second client used the first one's tokens");
  assert.match(sent[0], /^Bearer cai_refresh_/);
});

test('[auth.oauth-refresh-refused] a refused refresh token clears the store and asks for sign-in', async () => {
  await signInRequired();
  const store = memoryStore({ accessToken: 'old', refreshToken: 'rt_unknown', expiresAt: Date.now() - 1 });
  const err = await authError(read(signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, tokenStore: store })));
  assert.equal(err.code, 'invalid_grant');
  assert.equal(store.tokens, undefined);
  assert.equal(store.clears, 1);
  assert.equal((await api()).length, 0);
});

test('[auth.oauth-not-signed-in] a call before sign-in fails with sign_in_required and sends nothing', async () => {
  await signInRequired();
  const err = await authError(read(signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id })));
  assert.equal(err.code, 'sign_in_required');
  assert.equal((await requests()).length, 0);
});

// The browser build refuses the server sign-in modes, so these cover what the refused cases cover (the workspace
// audience, one token request for concurrent calls, renewal before expiry, one sign-in retry on a 401) with the
// mode a browser uses: oauth with PKCE and no client secret.
if (BROWSER_BUILD) {
  const browserApp = (store = memoryStore(), workspace = 'your-company.getcaitlyn.ai') =>
    signedIn({ mode: 'oauth', clientId: MOCK_OAUTH_CLIENT.id, redirectUri: 'https://app.example.com/callback', scopes: ['chat:write'], tokenStore: store }, workspace);

  nodeTest('[browser.oauth-sign-in] PKCE with no client secret, bound to the workspace, then calls with the saved token', async () => {
    await signInRequired();
    const store = memoryStore();
    // A workspace given as a URL is reduced to its hostname.
    const c = browserApp(store, 'https://your-company.getcaitlyn.ai/');
    const u = await oauthSignIn(c);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('resource'), RESOURCE);
    const [form] = await tokenRequests();
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('client_secret'), null);
    assert.equal(form.get('resource'), RESOURCE);
    await Promise.all([read(c), read(c), read(c)]);
    assert.equal((await tokenRequests()).length, 1, 'one token request');
    assert.equal(new Set((await api()).map((r) => r.headers.authorization)).size, 1);
    assert.match((await api())[0].headers.authorization, /^Bearer cai_code_/);
  });

  nodeTest('[browser.renew-before-expiry] a short-lived token is refreshed halfway through its life', async () => {
    await faults({ auth: { require: true, expiresIn: 1 } });
    const c = browserApp();
    await oauthSignIn(c);
    await read(c);
    assert.equal((await authCounts()).refresh_token ?? 0, 0, 'used within the first half of its life');
    await new Promise((r) => setTimeout(r, 600));
    await read(c);
    assert.equal((await authCounts()).refresh_token, 1, 'refreshed after half its life');
    assert.equal((await api()).length, 2, 'no call was refused');
  });

  nodeTest('[browser.401-once] a refused token is refreshed once; a second 401 is raised', async () => {
    await signInRequired();
    const c = browserApp();
    await oauthSignIn(c);
    await read(c);
    await faults({ auth: { revokeIssued: true, expiresIn: 0 } });
    await assert.rejects(read(c), (e: any) => e.$metadata?.httpStatusCode === 401 && e.code === 'UNAUTHENTICATED');
    assert.equal((await authCounts()).refresh_token, 1, 'refreshed once');
    assert.equal((await api()).length, 3, 'the first call, then two attempts at the second');
  });
}

const awsAuth = (extra: Partial<Extract<AuthOptions, { mode: 'awsIam' }>> = {}): AuthOptions => ({
  mode: 'awsIam',
  region: MOCK_AWS.region,
  stsEndpoint: `${BASE}/__sts/`,
  credentials: { accessKeyId: MOCK_AWS.accessKeyId, secretAccessKey: MOCK_AWS.secretAccessKey, sessionToken: 'session-token' },
  ...extra,
});

test('[auth.aws-iam] a signed STS GetWebIdentityToken call, one token exchange, then bearer calls', async () => {
  await signInRequired();
  const c = signedIn(awsAuth());
  await Promise.all([read(c), read(c)]);
  const n = await authCounts();
  assert.equal(n.sts, 1);
  assert.equal(n['urn:ietf:params:oauth:grant-type:token-exchange'], 1);
  assert.match((await api())[0].headers.authorization, /^Bearer cai_x_aws_/);
  const sts = new URLSearchParams((await requests()).find((r) => r.path === '/__sts/').body);
  assert.equal(sts.get('Action'), 'GetWebIdentityToken');
  assert.equal(sts.get('Audience.member.1'), RESOURCE);
  assert.equal(sts.get('SigningAlgorithm'), 'ES384');
  assert.equal(sts.get('DurationSeconds'), '300');
  const [form] = await tokenRequests();
  assert.equal(form.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:jwt');
  assert.equal(form.get('resource'), RESOURCE);
});

test('[auth.aws-iam-provider] credentials can come from a provider the caller passes, asked when signing in', async () => {
  await signInRequired();
  let calls = 0;
  const provider = async () => (calls++, { accessKeyId: MOCK_AWS.accessKeyId, secretAccessKey: MOCK_AWS.secretAccessKey });
  await read(signedIn(awsAuth({ credentials: provider })));
  assert.equal(calls, 1);
  assert.equal((await authCounts()).sts, 1);
});

test('[auth.aws-iam-env] without credentials it uses AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION', async () => {
  await signInRequired();
  const keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: MOCK_AWS.accessKeyId, AWS_SECRET_ACCESS_KEY: MOCK_AWS.secretAccessKey, AWS_REGION: MOCK_AWS.region });
  try {
    await read(signedIn(awsAuth({ credentials: undefined, region: undefined })));
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  assert.equal((await authCounts()).sts, 1);
});

test('[auth.aws-iam-bad-signature] an STS refusal is a sign-in error with the STS code', async () => {
  await signInRequired();
  const err = await authError(read(signedIn(awsAuth({ credentials: { accessKeyId: MOCK_AWS.accessKeyId, secretAccessKey: 'wrong' } }))));
  assert.equal(err.code, 'SignatureDoesNotMatch');
  assert.equal((await api()).length, 0);
});

test('[auth.aws-iam-no-credentials] with no credentials anywhere, awsIam fails with aws_identity_failed and sends nothing', async () => {
  await signInRequired();
  const keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const err = await authError(read(signedIn(awsAuth({ credentials: undefined }))));
    assert.equal(err.code, 'aws_identity_failed');
  } finally {
    for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
  assert.equal((await requests()).length, 0);
});

test('[auth.workload-identity] a CI identity token is exchanged once; a token for another workspace is refused', async () => {
  await signInRequired();
  let asked = 0;
  await read(signedIn({ mode: 'workloadIdentity', token: async () => (asked++, mockOidcToken(RESOURCE)) }));
  assert.equal(asked, 1);
  assert.match((await api())[0].headers.authorization, /^Bearer cai_x_oidc_/);
  const err = await authError(read(signedIn({ mode: 'workloadIdentity', token: () => mockOidcToken('https://other.getcaitlyn.ai/api') })));
  assert.equal(err.code, 'invalid_grant');
});

test('[auth.workload-identity-single-use] a replayed identity token is refused', async () => {
  await signInRequired();
  const jwt = mockOidcToken(RESOURCE);
  await read(signedIn({ mode: 'workloadIdentity', token: () => jwt }));
  const err = await authError(read(signedIn({ mode: 'workloadIdentity', token: () => jwt })));
  assert.equal(err.code, 'invalid_grant');
});

test('[auth.session] the session cookie, Origin on writes, and no Authorization header', async () => {
  await signInRequired();
  const c = signedIn({ mode: 'session', cookie: MOCK_SESSION_COOKIE, origin: 'https://caitlyn.lndo.site' });
  const v = await read(c);
  await c.agents('GHT7YRWXPL').draft.update({ guidance: { instructions: 'Cite clause numbers.' } }, { ifMatch: v.etag! });
  const [get, patch] = await api();
  assert.equal(get.headers.authorization, undefined);
  assert.equal(get.headers.cookie, MOCK_SESSION_COOKIE);
  assert.equal(get.headers.origin, undefined);
  assert.equal(patch.headers.origin, 'https://caitlyn.lndo.site');
  assert.equal(patch.headers.authorization, undefined);
  assert.equal((await tokenRequests()).length, 0);
});

// ---------------------------------------------------------------- files, upload targets and the ingest helper

const enc = (s: string) => new TextEncoder().encode(s);
async function sha256(bytes: Uint8Array): Promise<string> {
  let binary = '';
  for (const b of new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))) binary += String.fromCharCode(b);
  return btoa(binary);
}
const urlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A stream that can be read once, in chunks. */
const oneShot = (bytes: Uint8Array, chunk = 64 * 1024) => {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, (at += chunk)));
    },
  });
};
/** The request log once a request matching `pred` has arrived (the mock logs a request before it answers). */
async function untilRequest(pred: (r: any) => boolean): Promise<any> {
  const until = Date.now() + 10_000;
  for (;;) {
    const hit = (await requests()).find(pred);
    if (hit) return hit;
    if (Date.now() > until) assert.fail('the request never arrived');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const reservations = async () => (await api()).filter((r) => r.method === 'POST' && r.path === '/v3/uploads').map((r) => JSON.parse(r.body));
const puts = async () => (await requests()).filter((r) => r.method === 'PUT' && r.path?.startsWith('/__s3/'));
const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const PDF = enc('%PDF-1.7\nAnnual leave: staff receive 20 days a year.\n');

test('[files.sources] a path, bytes, a one-shot stream and a Blob of the same content reserve the same upload', async () => {
  const c = client();
  const sources: [string, unknown][] = [
    ['bytes', UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' })],
    ['stream', UploadFile.fromStream(oneShot(PDF, 7), { name: 'leave-policy.pdf' })],
    ['blob', new File([PDF as BlobPart], 'leave-policy.pdf', { type: 'application/pdf' })],
  ];
  if (!BROWSER_BUILD) {
    const file = path.join(tempDir('caitlyn-sources-'), 'leave-policy.pdf');
    fs.writeFileSync(file, PDF);
    sources.push(['path', UploadFile.fromPath(file)], ['path string', file]);
  }
  for (const [, src] of sources) await c.core.uploads.send(src as never);
  const want = { fileName: 'leave-policy.pdf', contentType: 'application/pdf', byteSize: PDF.length, sha256: await sha256(PDF) };
  const got = await reservations();
  assert.equal(got.length, sources.length);
  for (const [i, r] of got.entries()) assert.deepEqual(r, want, sources[i]![0]);
  assert.equal(want.sha256.length, 44, 'standard base64, padded');
  for (const p of await puts()) assert.equal(p.bodySha256, want.sha256);
});

test('[files.content-type] the content type comes from the caller, else the extension table, else application/octet-stream', async () => {
  const c = client();
  for (const name of ['a.pdf', 'b.docx', 'c.md', 'd.unknownext']) await c.core.uploads.send(UploadFile.fromBytes(PDF, { name }));
  await c.core.uploads.send(UploadFile.fromBytes(PDF, { name: 'e.md', contentType: 'text/plain' }));
  assert.deepEqual(
    (await reservations()).map((r) => r.contentType),
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown', 'application/octet-stream', 'text/plain'],
  );
  assert.equal(contentTypeFor('REPORT.PDF'), 'application/pdf');
  // Every extension in the table every SDK shares
  const shared: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'conformance/cases/content-types.json'), 'utf8')).contentTypes;
  for (const [ext, type] of Object.entries(shared)) assert.equal(contentTypeFor(`file.${ext}`), type, `.${ext}`);
  assert.deepEqual(Object.keys(CONTENT_TYPES).sort(), Object.keys(shared).sort(), 'the same extensions as the shared table');
});

test('[files.spool] a one-shot stream over 8 MiB is spooled and sent intact, and nothing is left on disk after the call', async () => {
  const big = new Uint8Array(9 * 1024 * 1024 + 7).map((_, i) => (i * 31) & 0xff);
  const small = big.slice(0, 1024 * 1024);
  const disk = !BROWSER_BUILD; // a page, and the browser build, spool to memory
  const dir = disk ? tempDir('caitlyn-spool-') : '';
  const before = process.env.TMPDIR;
  if (disk) process.env.TMPDIR = dir;
  try {
    await faults({ reserveDelayMs: 300 });
    for (const [bytes, spoolsToDisk] of [
      [small, false],
      [big, true],
    ] as const) {
      await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
      await faults({ reserveDelayMs: 300 });
      const call = client().core.uploads.send(UploadFile.fromStream(oneShot(bytes), { name: 'scan.pdf' }));
      await untilRequest((r) => r.path === '/v3/uploads');
      if (disk) {
        // While the reservation is held, the copy is a file only its owner can read (or nothing, under 8 MiB).
        const files = fs.readdirSync(dir);
        assert.equal(files.length, spoolsToDisk ? 1 : 0, files.join(', '));
        if (spoolsToDisk) assert.equal(fs.statSync(path.join(dir, files[0]!)).mode & 0o777, 0o600);
      }
      await call;
      const [put] = await puts();
      assert.equal(put.bodyLength, bytes.length);
      assert.equal(put.bodySha256, await sha256(bytes));
      if (disk) assert.deepEqual(fs.readdirSync(dir), [], 'the spool file is gone');
    }
    if (disk) {
      // Gone when the call fails, too.
      await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
      await faults({ status: { CreateUpload: [{ status: 400 }] } });
      await expectError(client().core.uploads.send(UploadFile.fromStream(oneShot(big), { name: 'scan.pdf' })));
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  } finally {
    if (disk && before === undefined) delete process.env.TMPDIR;
    else if (disk) process.env.TMPDIR = before;
  }
});

test('[files.too-large] a file over 2 GB fails with FILE_TOO_LARGE before any request', async () => {
  const c = client();
  const over = 2_147_483_648 + 1;
  const huge = UploadFile.fromStream(oneShot(PDF), { name: 'huge.mp4', size: over });
  const err = await expectError(c.core.uploads.send(huge));
  assert.equal(err.code, 'FILE_TOO_LARGE');
  const viaTarget = await expectError(c.knowledgeBases('KB4T7YQ2WL').documents.create(UploadFile.fromStream(oneShot(PDF), { name: 'huge.mp4', size: over }), { folder: '/media/' }));
  assert.equal(viaTarget.code, 'FILE_TOO_LARGE');
  if (!BROWSER_BUILD) {
    // A sparse file on disk of 2 GB and one byte: its size is known before it is read.
    const file = path.join(tempDir('caitlyn-large-'), 'huge.mp4');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, over);
    assert.equal((await expectError(c.core.uploads.send(file))).code, 'FILE_TOO_LARGE');
  }
  assert.deepEqual(await requests(), [], 'nothing was sent');
});

test('[files.changed] a path whose size or modification time changes between hashing and sending fails with FILE_CHANGED', async () => {
  const file = path.join(tempDir('caitlyn-changed-'), 'leave-policy.pdf');
  fs.writeFileSync(file, PDF);
  await faults({ reserveDelayMs: 300 });
  const call = client().core.uploads.send(file);
  await untilRequest((r) => r.path === '/v3/uploads');
  fs.appendFileSync(file, 'An edit made while the upload was being reserved.\n');
  const err = await expectError(call);
  assert.equal(err.code, 'FILE_CHANGED');
  assert.deepEqual(await puts(), [], 'its bytes were not sent');
});

test('[files.put-retry] a presigned PUT answered 503 is retried and then succeeds, with the same headers and bytes', async () => {
  await faults({ status: { PutUpload: [{ status: 503, retryAfter: 0 }] } });
  const upload = await client().core.uploads.send(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' }));
  const sent = await puts();
  assert.equal(sent.length, 2);
  const [a, b] = sent;
  assert.deepEqual(a.headers, b.headers);
  assert.equal(a.bodySha256, b.bodySha256);
  assert.equal(a.headers['x-amz-checksum-sha256'], await sha256(PDF));
  assert.equal(a.headers['content-type'], 'application/pdf');
  assert.equal(a.path, `/__s3/${upload.id}`);
  // Exactly the required headers: no credentials or Caitlyn headers go to storage.
  for (const h of ['authorization', 'caitlyn-sdk-model', 'idempotency-key', 'cookie']) assert.ok(!a.headerNames.includes(h), h);
  // Still failing after the retries: UPLOAD_PUT_FAILED.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ status: { PutUpload: [0, 1, 2].map(() => ({ status: 503, retryAfter: 0 })) } });
  const err = await expectError(client().core.uploads.send(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' })));
  assert.equal(err.code, 'UPLOAD_PUT_FAILED');
  assert.equal(err.status, 503);
  assert.equal((await puts()).length, 3);
});

test("[upload-target.top-level] kb.documents.create(file) reserves, PUTs, creates the document with the upload id and returns its scope; doc.replace(file) adds a version the same way", async () => {
  const kb = client().knowledgeBases('KB4T7YQ2WL');
  const doc = await kb.documents.create(UploadFile.fromBytes(PDF, { name: 'leave-policy.pdf' }), { folder: '/hr/' });
  assert.equal(doc.name, 'leave-policy.pdf');
  assert.equal(doc.folder, '/hr/');
  assert.ok(doc.operation.id);
  assert.equal(doc.documentId, doc.id, 'the new document’s scope');
  assert.equal(typeof doc.replace, 'function');
  const log = (await requests()).filter((r) => r.method !== 'OPTIONS');
  assert.deepEqual(log.map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/, '{id}')}`), ['POST /v3/uploads', 'PUT /__s3/{id}', 'POST /v3/knowledge-bases/KB4T7YQ2WL/documents']);
  const uploadId = log[1].path.split('/').pop();
  const reserved = JSON.parse(log[0].body);
  assert.deepEqual({ 'content-type': log[1].headers['content-type'], 'x-amz-checksum-sha256': log[1].headers['x-amz-checksum-sha256'] }, { 'content-type': reserved.contentType, 'x-amz-checksum-sha256': reserved.sha256 });
  assert.deepEqual(JSON.parse(log[2].body), { uploadId, folder: '/hr/' });
  // An upload id still works in place of the file.
  const up = await client().core.uploads.send(UploadFile.fromBytes(enc('%PDF second'), { name: 'second.pdf' }));
  const second = await kb.documents.create({ uploadId: up.id }, { folder: '/hr/' });
  assert.equal(second.name, 'second.pdf');
  // replace(file): the same reservation and PUT, then CreateDocumentVersion with the upload id.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const replaced = await client().knowledgeBases('KB4T7YQ2WL').documents('doc-0001').replace(UploadFile.fromBytes(enc('%PDF the 2027 edition'), { name: 'policy-1.pdf' }), { note: 'The 2027 edition' });
  assert.equal(replaced.result, 'created');
  assert.equal(replaced.version.number, 2);
  const steps = (await requests()).filter((r) => r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/, '{id}')}`);
  assert.deepEqual(steps, ['POST /v3/uploads', 'PUT /__s3/{id}', 'POST /v3/knowledge-bases/KB4T7YQ2WL/documents/doc-0001/versions']);
  const create = (await api()).find((r) => r.path.endsWith('/documents/doc-0001/versions'));
  assert.deepEqual(Object.keys(JSON.parse(create.body)).sort(), ['note', 'uploadId']);
});

test('[upload-target.nested] agents.create with a file at avatar.mark.pictureUploadId reserves it with purpose {agentAvatar: true}', async () => {
  const c = client();
  const png = enc('\x89PNG\r\n\x1a\n a small avatar');
  const agent = await c.agents.create({ name: 'HR assistant', avatar: { colour: 'sage', mark: { pictureUploadId: UploadFile.fromBytes(png, { name: 'hr.png' }) } } });
  assert.ok(agent.avatar?.mark?.pictureUrl);
  const [reserved] = await reservations();
  assert.deepEqual(reserved.purpose, { agentAvatar: true });
  assert.equal(reserved.contentType, 'image/png');
  const uploadId = (await puts())[0].path.split('/').pop();
  const create = (await api()).find((r) => r.method === 'POST' && r.path === '/v3/agents');
  assert.deepEqual(JSON.parse(create.body), { name: 'HR assistant', avatar: { colour: 'sage', mark: { pictureUploadId: uploadId } } });
  // UpdateAgent takes one the same way, on the agent's scope.
  const updated = await agent.update({ avatar: { mark: { pictureUploadId: new File([png as BlobPart], 'hr-2.png', { type: 'image/png' }) } } }, { ifMatch: agent.etag });
  assert.ok(updated.avatar?.mark?.pictureUrl);
  assert.equal((await reservations())[1].purpose.agentAvatar, true);
});

// kb.ingestion.sync reads a folder; the browser build has no file system, so there it is given the same files as a list.
async function syncSource(files: Record<string, Uint8Array>): Promise<string | SyncItemInput[]> {
  if (BROWSER_BUILD) return Object.entries(files).map(([p, bytes]) => ({ path: p, file: UploadFile.fromBytes(bytes, { name: p.split('/').pop()! }) }));
  const dir = tempDir('caitlyn-sync-');
  for (const [p, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), bytes);
  }
  return dir;
}
const someFiles = (n: number, prefix = 'policy') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-${String(i + 1).padStart(4, '0')}.pdf`, enc(`%PDF ${prefix} ${i + 1}`)]));
const forms = async () => (await requests()).filter((r) => r.method === 'POST' && r.path === '/__s3/');
const KB_PATH = '/v3/knowledge-bases/KB4T7YQ2WL';
const BATCHES = `${KB_PATH}/ingestion-batches`;
const opsSent = async () => (await api()).map((r) => `${r.method} ${r.path.replace(/\/ingestion-batches\/[^/]+/, '/ingestion-batches/{id}')}`);
// The policy's fields as sent: the mock's policy has its own `key` too, which a client leaves out (PROTOCOL.md 15).
const POLICY_FIELDS = ['bucket', 'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'policy', 'x-amz-signature'];
const kbScope = () => client().knowledgeBases('KB4T7YQ2WL');
const batchIdSent = async () => (await api()).find((r) => r.method === 'POST' && r.path === BATCHES && r.body)!;

test('[sync.flow] kb.ingestion.sync of a folder hashes, creates, plans, prices, starts, uploads each file as a form, completes, waits and reports', async () => {
  const files = { 'annual-leave.pdf': enc('%PDF annual'), 'guides/parental-leave.md': enc('# Parental leave\n'), 'forms/claim.docx': enc('PK docx bytes') };
  // With a confirm, so the plan is priced (sync.no-confirm-no-estimate: without one it is not).
  const report = await kbScope().ingestion.sync(await syncSource(files), { folder: '/hr/', confirm: () => true });
  // The steps, in PROTOCOL.md 15's order.
  const all = await api();
  const sent = await opsSent();
  const at = (s: string) => sent.indexOf(s);
  assert.equal(at(`POST ${BATCHES}`), 0, sent.join('\n'));
  const watched = all.findIndex((r) => r.path === `${KB_PATH}/events` && new URLSearchParams(r.query).get('batch'));
  assert.ok(watched > 0, 'planned() follows the batch through the knowledge base’s watch');
  const priced = at(`POST ${KB_PATH}/ingestions:estimate`);
  assert.ok(priced > watched, 'priced once planned');
  assert.ok(at(`POST ${BATCHES}/{id}/start`) > priced);
  const listedAwaiting = all.findIndex((r) => new URLSearchParams(r.query).get('filter[status][eq]') === 'awaiting_upload');
  assert.ok(listedAwaiting > at(`POST ${BATCHES}/{id}/start`));
  assert.ok(at(`POST ${BATCHES}/{id}/complete-uploads`) > listedAwaiting);
  assert.equal(sent.at(-1), `GET ${BATCHES}/{id}/items`, 'the items, listed for the report, last');
  // Each file hashed and described with its standard-base64 SHA-256; the batch starts by hand.
  const created = JSON.parse(all[0].body);
  assert.equal(created.start, 'manual');
  assert.equal(created.awaitMoreItems, false);
  const byPath = new Map<string, any>(created.items.map((i: any) => [i.path, i]));
  for (const [p, bytes] of Object.entries(files)) assert.equal(byPath.get(`/hr/${p}`)?.sha256, await sha256(bytes), p);
  assert.equal(byPath.get('/hr/forms/claim.docx').contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  // The estimate describes each file that needs bytes, and uploads nothing.
  const estimate = JSON.parse(all[priced].body);
  assert.deepEqual(estimate.documents.map((d: any) => d.name).sort(), ['annual-leave.pdf', 'claim.docx', 'parental-leave.md']);
  // Each form: the policy's fields in order, then key, Content-Type, the checksum fields and the file, last.
  const posted = await forms();
  assert.equal(posted.length, 3);
  for (const f of posted) {
    assert.deepEqual(f.form.map((p: any) => p.name), [...POLICY_FIELDS, 'key', 'Content-Type', 'x-amz-checksum-algorithm', 'x-amz-checksum-sha256', 'file']);
    const value = (n: string) => f.form.find((p: any) => p.name === n);
    assert.equal(value('x-amz-checksum-algorithm').value, 'SHA256');
    const sha = value('x-amz-checksum-sha256').value;
    assert.equal(value('file').sha256, sha);
    assert.match(sha, /^[A-Za-z0-9+/]{43}=$/);
    assert.match(value('key').value, new RegExp(`^batches/[^/]+/${urlSafe(sha).replace(/[-]/g, '\\-')}\\.(pdf|md|docx)$`));
  }
  // The report: every item, each indexed into a document.
  assert.equal(report.batch.status, 'succeeded');
  assert.equal(report.items.length, 3);
  for (const item of report.items) {
    assert.equal(item.status, 'indexed');
    assert.equal(item.outcome, 'new');
    assert.equal(item.resolution, 'add');
    assert.ok(item.documentId);
    assert.equal(item.version, 1);
  }
  // An upload that still fails after its retries fails only its item: UPLOAD_FAILED, through onItem and in the
  // report, and never reported to CompleteIngestionBatchUploads; the others carry on, and the call resolves.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ failUploads: { '/hr/annual-leave.pdf': true } });
  const seen: any[] = [];
  const partial = await kbScope().ingestion.sync(await syncSource(files), { folder: '/hr/', onItem: (i) => seen.push(i) });
  const failed = partial.items.find((i) => i.path === '/hr/annual-leave.pdf')!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'UPLOAD_FAILED');
  assert.equal(seen.find((i) => i.path === '/hr/annual-leave.pdf')?.failureCode, 'UPLOAD_FAILED');
  assert.equal((await forms()).filter((f) => f.form.find((p: any) => p.name === 'key').value.endsWith('.pdf')).length, 3, 'tried three times');
  const completed = (await api()).filter((r) => r.path.endsWith('/complete-uploads')).flatMap((r) => JSON.parse(r.body).itemIds);
  assert.ok(!completed.includes(failed.id));
  assert.equal(partial.items.filter((i) => i.status === 'indexed').length, 2);
});

// PROTOCOL.md 15: 10,000 items a call (the case's title still says 1,000), the last call `last: true`.
test('[sync.many-items] over 10,000 items: CreateIngestionBatch takes the first 10,000 with awaitMoreItems, BatchCreateIngestionBatchItems the rest, the last call with last: true', async () => {
  const items: SyncItemInput[] = Array.from({ length: 12_345 }, (_, i) => {
    const p = `policy-${String(i + 1).padStart(5, '0')}.pdf`;
    return { path: p, file: UploadFile.fromBytes(enc(`%PDF ${i + 1}`), { name: p }) };
  });
  // confirm: false stops after planning, so nothing is uploaded.
  let planned = 0;
  const err = await kbScope()
    .ingestion.sync(items, { folder: '/bulk/', confirm: (plan) => ((planned = plan.items.length), false) })
    .catch((e) => e);
  assert.equal(err?.code, 'CANCELLED', String(err));
  const calls = (await api()).filter((r) => r.method !== 'GET');
  const [create, ...rest] = calls;
  const createBody = JSON.parse(create.body);
  assert.equal(createBody.items.length, 10_000);
  assert.equal(createBody.awaitMoreItems, true);
  const more = rest.filter((r) => r.path.endsWith('/items:batch-create')).map((r) => JSON.parse(r.body));
  assert.deepEqual(more.map((b) => b.items.length), [2_345]);
  assert.equal(more.at(-1).last, true);
  assert.ok(!rest.some((r) => r.method === 'PATCH'), 'no UpdateIngestionBatch: the last items end the draft');
  assert.equal(planned, 12_345);
});

test('[sync.concurrency] at most 6 uploads run at once by default', async () => {
  await faults({ uploadDelayMs: 100 });
  await kbScope().ingestion.sync(await syncSource(someFiles(20)), { folder: '/hr/' });
  const stats = await (await fetch(`${BASE}/__mock/uploads`)).json();
  // A page's browser keeps at most six HTTP/1.1 connections per host, and may hold some for other requests (Firefox
  // does), so there the SDK's six can show as fewer at once; never more.
  if (IN_PAGE) assert.ok(stats.maxInFlight > 1 && stats.maxInFlight <= 6, `${stats.maxInFlight} at once`);
  else assert.equal(stats.maxInFlight, 6);
  assert.equal(stats.objects.length, 20);
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ uploadDelayMs: 50 });
  await kbScope().ingestion.sync(await syncSource(someFiles(8)), { folder: '/hr/', concurrency: 2 });
  assert.equal((await (await fetch(`${BASE}/__mock/uploads`)).json()).maxInFlight, 2);
});

test('[sync.complete-groups] CompleteIngestionBatchUploads names at most 100 items a call', async () => {
  await faults({ completeDelayMs: 300 });
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(150)), { folder: '/hr/', concurrency: 50 });
  const groups = (await api()).filter((r) => r.path.endsWith('/complete-uploads')).map((r) => JSON.parse(r.body).itemIds as string[]);
  assert.ok(groups.every((g) => g.length >= 1 && g.length <= 100), groups.map((g) => g.length).join(', '));
  // Uploads that finish while a call is under way wait for the next one, so there are fewer calls than uploads. How
  // many go together depends on how fast the uploads finish (on a slow runner 1, 65, 84), so no exact grouping is asserted.
  assert.ok(groups.length < 150 && groups.some((g) => g.length > 1), `uploads that finished during a call wait for the next: ${groups.map((g) => g.length).join(', ')}`);
  const all = groups.flat();
  assert.equal(all.length, 150);
  assert.equal(new Set(all).size, 150);
  assert.equal(report.items.filter((i) => i.status === 'indexed').length, 150);
});

test('[sync.policy-renewal] a policy past its renewal margin is renewed before it is used again; a 403 saying it expired renews it once and resends', async () => {
  const generation = (f: any) => JSON.parse(atob(f.form.find((p: any) => p.name === 'policy').value)).generation;
  // Start's policy lasts a second, so its renewal margin is half a second; each file takes a second to arrive, one at a
  // time. The first goes with Start's policy; it is renewed before the second goes.
  await faults({ policySeconds: 1, uploadDelayMs: 1000 });
  await kbScope().ingestion.sync(await syncSource(someFiles(2)), { folder: '/hr/', concurrency: 1 });
  let sent = await opsSent();
  assert.equal(sent.filter((s) => s.endsWith('/upload-policies')).length, 1);
  const order = (await requests()).filter((r) => r.method === 'POST').map((r) => (r.path === '/__s3/' ? 'upload' : r.path?.endsWith('/upload-policies') ? 'renew' : '')).filter(Boolean);
  assert.deepEqual(order, ['upload', 'renew', 'upload'], 'renewed between the uploads');
  assert.deepEqual((await forms()).map(generation), [1, 2]);
  // A policy storage says has expired: one renewal, and the file sent again.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ startPolicyExpired: true });
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(3)), { folder: '/hr/', concurrency: 1 });
  sent = await opsSent();
  assert.equal(sent.filter((s) => s.endsWith('/upload-policies')).length, 1);
  assert.deepEqual((await forms()).map(generation), [1, 2, 2, 2], 'the refused file, sent again with the new policy, then the rest');
  assert.equal(report.batch.status, 'succeeded');
});

test('[sync.checksum-mismatch] an item Complete fails with CHECKSUM_MISMATCH is uploaded and completed again once', async () => {
  await faults({ checksumMismatch: { '/hr/policy-0002.pdf': 1 } });
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(3)), { folder: '/hr/' });
  const keys = (await forms()).map((f) => f.form.find((p: any) => p.name === 'key').value as string);
  const sha2 = await sha256(enc('%PDF policy 2'));
  assert.equal(keys.filter((k) => k.includes(urlSafe(sha2))).length, 2, 'uploaded twice');
  assert.equal(keys.length, 4);
  const completes = (await api()).filter((r) => r.path.endsWith('/complete-uploads')).flatMap((r) => JSON.parse(r.body).itemIds);
  const item2 = report.items.find((i) => i.path === '/hr/policy-0002.pdf')!;
  assert.equal(completes.filter((id: string) => id === item2.id).length, 2);
  assert.equal(item2.status, 'indexed');
});

test('[sync.resolve] unresolved items go to the resolver; with none the call fails with INGESTION_BATCH_UNRESOLVED and the batch stays planned', async () => {
  const conflicts = { '/hr/policy-0001.pdf': 'duplicate_path', '/hr/policy-0002.pdf': 'path_taken', '/hr/policy-0003.pdf': 'ambiguous_content' };
  await faults({ planConflicts: conflicts });
  const choices: Record<string, string> = { '/hr/policy-0001.pdf': 'overwrite', '/hr/policy-0002.pdf': 'new_version', '/hr/policy-0003.pdf': 'add' };
  const asked: string[] = [];
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(4)), {
    folder: '/hr/',
    resolve: (item) => (asked.push(item.path), choices[item.path]),
  });
  assert.deepEqual(asked.sort(), Object.keys(conflicts));
  const patches = (await api()).filter((r) => r.method === 'PATCH' && r.path.includes('/items/'));
  assert.deepEqual(patches.map((r) => JSON.parse(r.body).resolution).sort(), ['add', 'new_version', 'overwrite']);
  assert.ok(patches.every((r) => r.headers['if-match']));
  assert.equal(report.batch.status, 'succeeded');
  // No resolver: the call fails, nothing is started, and the batch is left planned.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ planConflicts: conflicts });
  const err = await expectError(kbScope().ingestion.sync(await syncSource(someFiles(4)), { folder: '/hr/' }));
  assert.equal(err.code, 'INGESTION_BATCH_UNRESOLVED');
  assert.ok(!(await opsSent()).some((s) => s.endsWith('/start')));
  const batchId = (err as unknown as { ingestionBatchId: string }).ingestionBatchId;
  assert.equal((await kbScope().ingestion.batches(batchId).get()).status, 'planned');
});

test("[sync.plan-failed] a plan that ends the batch failed raises the batch's own failure, and nothing is started", async () => {
  // A conflict whose policy rule is fail
  await faults({ planConflicts: { '/hr/policy-0001.pdf': 'duplicate_path' } });
  const failed = await expectError(kbScope().ingestion.sync(await syncSource(someFiles(2)), { folder: '/hr/', policy: { onConflict: { default: 'fail' } } }));
  assert.equal(failed.code, 'conflict_policy_fail');
  assert.match(failed.detail ?? failed.message, /policy rule is `fail`/);
  assert.ok(!(await opsSent()).some((x) => x.endsWith('/start')));
  // Planning that could not finish
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ planFails: true });
  const planning = await expectError(kbScope().ingestion.sync(await syncSource(someFiles(2)), { folder: '/hr/' }));
  assert.equal(planning.code, 'planning_failed');
  assert.match(planning.detail ?? planning.message, /Planning could not finish/);
  assert.ok(!(await opsSent()).some((x) => x.endsWith('/start')));
});

test('[sync.confirm] confirm is called with the plan and its estimate, and false cancels the batch and ends the call', async () => {
  let seen: SyncPlan | undefined;
  const err = await kbScope()
    .ingestion.sync(await syncSource(someFiles(3)), { folder: '/hr/', confirm: (plan) => ((seen = plan), false) })
    .catch((e) => e);
  // Not confirmed: CANCELLED, an error the SDK raises itself (status 0), not the platform's AbortError, with the report.
  assert.ok(err instanceof CaitlynError, `got ${err?.name}`);
  assert.equal(err.code, 'CANCELLED');
  assert.equal(err.status, 0);
  assert.ok(!(err instanceof DOMException));
  assert.equal(err.report!.items.length, 3, 'the report so far');
  assert.equal(seen?.batch.status, 'planned');
  assert.equal(seen?.items.length, 3);
  assert.ok(seen?.items.every((i) => i.outcome === 'new'));
  assert.equal(seen?.estimate?.documents, 3, 'the plan carries its estimate');
  assert.ok(seen?.estimate?.durationSeconds);
  const sent = await opsSent();
  assert.ok(sent.includes(`POST ${BATCHES}/{id}/cancel`));
  assert.ok(!sent.some((s) => s.endsWith('/start')));
  const batchId = (await api()).find((r) => r.path.endsWith('/cancel')).path.split('/')[5];
  assert.equal((await kbScope().ingestion.batches(batchId).get()).status, 'cancelled');
  assert.deepEqual(await forms(), []);
  // true carries on.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const ok = await kbScope().ingestion.sync(await syncSource(someFiles(2)), { folder: '/hr/', confirm: () => true });
  assert.equal(ok.batch.status, 'succeeded');
  // sync.estimate: the same plan and estimate, and nothing uploaded or started.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const plan = await kbScope().ingestion.sync.estimate(await syncSource(someFiles(2)), { folder: '/hr/' });
  assert.equal(plan.batch.status, 'planned');
  assert.equal(plan.estimate?.documents, 2);
  assert.ok(!(await opsSent()).some((s) => s.endsWith('/start')));
  assert.deepEqual(await forms(), []);
});

test('[sync.remove-missing] with removeMissing, each document under the folder with no matching file becomes a remove item', async () => {
  // The knowledge base holds /policies/policy-1.pdf … policy-7.pdf; the folder has policy-1.pdf (the same bytes) and a new file.
  const files = { 'policy-1.pdf': enc('doc1'), 'travel.pdf': enc('%PDF travel') };
  const report = await kbScope().ingestion.sync(await syncSource(files), { folder: '/policies/', removeMissing: true });
  const list = (await api()).find((r) => r.path === `${KB_PATH}/documents`);
  const q = new URLSearchParams(list.query);
  assert.equal(q.get('filter[folder][eq]'), '/policies/');
  assert.equal(q.get('deep'), 'true');
  const items = JSON.parse((await batchIdSent()).body).items;
  const removes = items.filter((i: any) => i.action === 'remove').map((i: any) => i.path).sort();
  assert.deepEqual(removes, [2, 3, 4, 5, 6, 7].map((n) => `/policies/policy-${n}.pdf`));
  const status = Object.fromEntries(report.items.map((i) => [i.path, i.status]));
  assert.equal(status['/policies/policy-1.pdf'], 'skipped', 'unchanged');
  assert.equal(status['/policies/travel.pdf'], 'indexed');
  assert.equal(status['/policies/policy-4.pdf'], 'removed');
  assert.equal((await forms()).length, 1, 'only the new file is uploaded');
});

test('[sync.progress] onProgress reports each phase in order, and onItem each item once', async () => {
  const phases: string[] = [];
  const uploads: number[] = [];
  const items: any[] = [];
  const files = someFiles(3);
  await kbScope().ingestion.sync(await syncSource(files), {
    folder: '/hr/',
    onProgress: (p) => {
      // Each phase where it first appears: `queued` follows each CompleteIngestionBatchUploads call, so it can
      // alternate with `upload` while other uploads are still going.
      if (!phases.includes(p.phase)) phases.push(p.phase);
      if (p.phase === 'upload') uploads.push(p.done);
    },
    onItem: (i) => items.push(i),
  });
  // Uploads happen after Start, so after planning (PROTOCOL.md 15's order of steps).
  assert.deepEqual(phases, ['checksum', 'planning', 'planned', 'upload', 'queued', 'processing', 'succeeded']);
  const total = Object.values(files).reduce((n, b) => n + b.length, 0);
  assert.equal(uploads.at(-1), total, 'upload counts bytes');
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((i) => i.id)).size, 3);
});

test('[sync.cancel] cancelling during the uploads stops new ones, aborts those in flight and raises AbortError; with cancelIngestion the batch is cancelled', async () => {
  // Uploads are held 150 ms, two at a time. policy-1.pdf has the bytes the knowledge base already holds: it is skipped
  // at Start, so it has finished before the cancel.
  await faults({ uploadDelayMs: 150 });
  const controller = new AbortController();
  const finished: any[] = [];
  const files = { 'policy-1.pdf': enc('doc1'), ...someFiles(6, 'leave') };
  const running = kbScope()
    .ingestion.sync(await syncSource(files), {
      folder: '/policies/',
      concurrency: 2,
      signal: controller.signal,
      cancelIngestion: true,
      onItem: (i) => finished.push(i),
    })
    .catch((e) => e);
  // Cancel once the third upload has arrived: it and the fourth are being held, so they are in flight.
  for (const until = Date.now() + 10_000; (await forms()).length < 3; ) {
    if (Date.now() > until) assert.fail('the third upload never arrived');
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  const err = await running;
  assert.equal(err?.name, 'AbortError', String(err));
  assert.ok(finished.some((i) => i.path === '/policies/policy-1.pdf' && i.status === 'skipped'), 'items already finished reached onItem');
  const aborted = await untilRequest((r) => r.event === 'upload-aborted');
  assert.ok(aborted, 'an upload in flight was aborted');
  assert.ok((await forms()).length < 6, 'no new uploads started');
  const stats = await (await fetch(`${BASE}/__mock/uploads`)).json();
  assert.ok(stats.objects.length < 6);
  const cancel = (await api()).find((r) => r.path.endsWith('/cancel'));
  assert.deepEqual(JSON.parse(cancel.body), { stopRunning: true });
});

test('[sync.on-item-once] onItem is called once per item, only with a final status, never when its upload is accepted; an upload that fails reaches it at once', async () => {
  await faults({ failUploads: { '/policies/leave-0002.pdf': true } });
  const seen: any[] = [];
  const files = { 'policy-1.pdf': enc('doc1'), ...someFiles(3, 'leave') };
  const report = await kbScope().ingestion.sync(await syncSource(files), { folder: '/policies/', onItem: (i) => seen.push(i) });
  const FINAL = ['indexed', 'skipped', 'moved', 'updated', 'removed', 'cancelled', 'failed'];
  assert.ok(seen.every((i) => FINAL.includes(i.status)), seen.map((i) => i.status).join(', '));
  assert.equal(new Set(seen.map((i) => i.id)).size, seen.length, 'once each');
  assert.equal(seen.length, report.items.length);
  const failed = seen.find((i) => i.path === '/policies/leave-0002.pdf');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'UPLOAD_FAILED');
  assert.ok(seen.indexOf(failed) < seen.findIndex((i) => i.status === 'indexed'), 'the failed upload at once, before the indexed ones');
  // Cancelled: onItem had every item final before the cancel, and none after the error.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ uploadDelayMs: 150 });
  const controller = new AbortController();
  const before: any[] = [];
  let raised = false;
  let late = 0;
  const running = kbScope()
    .ingestion.sync(await syncSource(files), { folder: '/policies/', concurrency: 2, signal: controller.signal, onItem: (i) => (raised ? late++ : before.push(i)) })
    .catch((e) => e);
  for (const until = Date.now() + 10_000; (await forms()).length < 2; ) {
    if (Date.now() > until) assert.fail('the uploads never arrived');
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  const err = await running;
  raised = true;
  assert.equal(err?.name, 'AbortError');
  assert.deepEqual(before.map((i) => i.status), ['skipped'], 'only the item final before the cancel');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(late, 0, 'never called after the cancellation error');
});

test('[sync.estimate-many] more items to price than one EstimateIngestion takes go in parts, in order, and the parts are added up', async () => {
  // A fake transport and a call limit of 2 in place of 10,000: five items to price are three calls, of 2, 2 and 1.
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`/hr/policy-${i + 1}.pdf`, enc(`%PDF ${i + 1}`)]));
  const source: SyncItemInput[] = Object.entries(files).map(([p, bytes]) => ({ path: p.replace('/hr/', ''), file: UploadFile.fromBytes(bytes, { name: p.split('/').pop()! }) }));
  const fake = (parts: Record<string, any>[]) => {
    const sent: { operation: string; input: Record<string, any> }[] = [];
    let estimates = 0;
    const deps: SyncDeps = {
      call: async (operation, input) => {
        sent.push({ operation, input });
        switch (operation) {
          case 'CreateIngestionBatch': return { id: 'IB1' };
          case 'ListIngestionBatchItems': return { items: Object.keys(files).map((p, i) => ({ id: `IT${i + 1}`, path: p, resolution: 'add', outcome: 'new', status: 'planned' })) };
          case 'EstimateIngestion': return { $metadata: {}, ...parts[estimates++] };
          case 'CancelIngestionBatch': return {};
          case 'GetIngestionBatch': return { id: 'IB1', status: 'cancelled', itemCount: 5 };
          default: throw new Error(`unexpected ${operation}`);
        }
      },
      toError: (p) => Object.assign(new Error(String(p.detail ?? p.title)), p),
      planned: async () => ({ id: 'IB1', status: 'planned', etag: '"1"', itemCount: 5 }),
      finished: async () => { throw new Error('not reached'); },
      describe: (file) => describeFile(file, (p) => new Error(String(p.title))) as Promise<Record<string, any>>,
    };
    return { deps, sent };
  };
  const part = (documents: number, cost?: [number, number]) => ({
    documents, pages: documents * 3, documentsOfUnknownLength: documents,
    durationSeconds: { low: 10 * documents, high: 20 * documents },
    ...(cost ? { cost: { low: cost[0], high: cost[1], unit: 'usd' } } : {}),
    details: { passages: documents },
  });

  const { deps, sent } = fake([part(2, [0.1, 0.2]), part(2, [0.1, 0.2]), part(1, [0.05, 0.1])]);
  const plan = await estimateSync(deps, 'KB4T7YQ2WL', source, { folder: '/hr/', estimatePerCall: 2 } as never);
  const calls = sent.filter((x) => x.operation === 'EstimateIngestion').map((x) => x.input.documents.map((d: { name: string }) => d.name));
  assert.deepEqual(calls, [['policy-1.pdf', 'policy-2.pdf'], ['policy-3.pdf', 'policy-4.pdf'], ['policy-5.pdf']], 'parts of at most the limit, in order');
  for (const d of sent.filter((x) => x.operation === 'EstimateIngestion').flatMap((x) => x.input.documents)) {
    assert.deepEqual(Object.keys(d).sort(), ['byteSize', 'contentType', 'name'], 'name, content type and size only: nothing hashed');
  }
  assert.deepEqual(plan.estimate, {
    documents: 5, pages: 15, documentsOfUnknownLength: 5,
    durationSeconds: { low: 50, high: 100 },
    cost: { low: 0.25, high: 0.5, unit: 'usd' },
  }, 'summed; details left out');

  // A part without a cost: the total has none. confirm sees the same one total.
  const second = fake([part(2, [0.1, 0.2]), part(2), part(1, [0.05, 0.1])]);
  let seen: SyncPlan | undefined;
  const err = await coreSync(second.deps, 'KB4T7YQ2WL', source, { folder: '/hr/', estimatePerCall: 2, confirm: (p: SyncPlan) => ((seen = p), false) } as never).catch((e) => e);
  assert.equal(err.code, 'CANCELLED');
  assert.equal(seen?.estimate?.documents, 5);
  assert.deepEqual(seen?.estimate?.durationSeconds, { low: 50, high: 100 });
  assert.ok(!('cost' in (seen?.estimate ?? {})), 'no cost when a part has none');
  assert.ok(!('details' in (seen?.estimate ?? {})));
});

// ------------------------------------------------------------------------------------------------ batch.upload
// A hand-built batch (PROTOCOL.md 15): batch.upload.estimate and batch.upload, the two steps sync is built on.

const ESTIMATE = `${KB_PATH}/ingestions:estimate`;
/** Files by the path their item has, as bytes. '/policies/policy-1.pdf' with 'doc1' is what the knowledge base holds: skipped. */
const handFiles = (n: number, folder = '/hand/') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${folder}file-${i + 1}.pdf`, enc(`%PDF hand ${i + 1}`)]));
const UNCHANGED = { '/policies/policy-1.pdf': enc('doc1') };
const asUploads = (files: Record<string, Uint8Array>) => Object.fromEntries(Object.entries(files).map(([p, bytes]) => [p, UploadFile.fromBytes(bytes, { name: p.split('/').pop()! })]));
/** Makes a batch of file items by hand, one for each file. */
async function handBatch(files: Record<string, Uint8Array>, input: Record<string, unknown> = { start: 'manual' }) {
  const items = await Promise.all(Object.entries(files).map(async ([p, bytes]) => ({ path: p, sha256: await sha256(bytes), byteSize: bytes.length, contentType: 'application/pdf' })));
  return client().knowledgeBases(KB).ingestion.batches.create({ ...input, items } as never);
}
/** The same, planned and started. */
async function startedBatch(files: Record<string, Uint8Array>) {
  const batch = await handBatch(files);
  await batch.planned();
  await batch.start();
  return batch;
}
/** A Blob that fails if anything reads it: an estimate only looks at its size. */
class UnreadBlob extends Blob {
  override arrayBuffer(): never { throw new Error('read'); }
  override stream(): never { throw new Error('read'); }
  override text(): never { throw new Error('read'); }
  override slice(): never { throw new Error('read'); }
}
const estimatesSent = async () => (await api()).filter((r) => r.path === ESTIMATE).map((r) => JSON.parse(r.body).documents as Record<string, unknown>[]);
const completed = async () => (await api()).filter((r) => r.path.endsWith('/complete-uploads')).flatMap((r) => JSON.parse(r.body).itemIds as string[]);
const formKeys = async () => (await forms()).map((f) => f.form.find((p: any) => p.name === 'key').value as string);
const itemsOf = async (batch: { items: { list(): AsyncIterable<IngestionBatchItem> } }) => collect(batch.items.list());

test('[batch-estimate.priced-items] upload.estimate() on a planned batch sends one EstimateIngestion with exactly the items that need bytes', async () => {
  const batch = await handBatch({ ...handFiles(2), ...UNCHANGED });
  await batch.planned();
  const estimate = await batch.upload.estimate();
  const sent = await estimatesSent();
  assert.equal(sent.length, 1, 'one EstimateIngestion');
  assert.deepEqual(sent[0].map((d) => d.name), ['file-1.pdf', 'file-2.pdf'], 'the two to add; not the skipped one');
  assert.equal(estimate.documents, 2);
  assert.ok(estimate.durationSeconds.high >= estimate.durationSeconds.low);
});

test('[batch-estimate.from-items] without files, each document is the item’s name, content type and size', async () => {
  const files = handFiles(2);
  const batch = await handBatch(files);
  await batch.planned();
  await batch.upload.estimate();
  assert.deepEqual((await estimatesSent())[0], Object.entries(files).map(([p, bytes]) => ({ name: p.split('/').pop(), contentType: 'application/pdf', byteSize: bytes.length })));
});

test('[batch-estimate.from-files] with files, each document is its matched file’s name, content type and size, with the hints given with it; nothing is read or hashed', async () => {
  const files = handFiles(4);
  const [a, b, c, d] = Object.keys(files);
  const batch = await handBatch(files);
  await batch.planned();
  const unread = (name: string, size: number) => UploadFile.fromBlob(new UnreadBlob([new Uint8Array(size)], { type: 'application/pdf' }), { name });
  const before = (await api()).length;
  await batch.upload.estimate({
    [a]: withHints(unread('a-local.pdf', 11), { pages: 12 }),
    [b.slice(1)]: unread('b-local.pdf', 22), // a key without its leading /
    [c]: { name: 'c-described.pdf', contentType: 'application/pdf', byteSize: 33, hints: { pages: 3 } },
    '/hand/not-an-item.pdf': unread('ghost.pdf', 44),
  });
  assert.deepEqual((await estimatesSent())[0], [
    { name: 'a-local.pdf', contentType: 'application/pdf', byteSize: 11, hints: { pages: 12 } },
    { name: 'b-local.pdf', contentType: 'application/pdf', byteSize: 22 },
    { name: 'c-described.pdf', contentType: 'application/pdf', byteSize: 33, hints: { pages: 3 } },
    { name: 'file-4.pdf', contentType: 'application/pdf', byteSize: files[d].length },
  ], 'the file matching no item is left out; an item with no file is described by itself');
  // A function of the item serves as well as a map.
  await batch.upload.estimate((item) => (item.path === a ? withHints(unread('fn.pdf', 5), { pages: 1 }) : undefined));
  assert.deepEqual((await estimatesSent())[1][0], { name: 'fn.pdf', contentType: 'application/pdf', byteSize: 5, hints: { pages: 1 } });
  assert.ok((await api()).slice(before).every((r) => !r.path.startsWith('/v3/uploads')), 'nothing uploaded');
});

test('[batch-estimate.draft] a draft batch raises INGESTION_BATCH_NOT_PLANNED, status 0, with no estimate sent and no retry', async () => {
  const batch = await handBatch(handFiles(1), { start: 'manual', awaitMoreItems: true });
  const before = (await api()).length;
  const err = await expectError(batch.upload.estimate());
  assert.ok(err instanceof CaitlynError);
  assert.equal(err.code, 'INGESTION_BATCH_NOT_PLANNED');
  assert.equal(err.status, 0);
  const sent = (await api()).slice(before);
  assert.deepEqual(sent.map((r) => r.method), ['GET'], 'the batch is read once; nothing else is sent');
  assert.equal((await estimatesSent()).length, 0);
});

test('[batch-estimate.planning] a planning batch is waited on until it is planned, then priced', async () => {
  await faults({ planningReads: 2 });
  const batch = await handBatch(handFiles(2));
  assert.equal(batch.status, 'planning');
  const estimate = await batch.upload.estimate();
  assert.equal(estimate.documents, 2);
  assert.equal((await estimatesSent()).length, 1);
  assert.ok((await watches()).length >= 1, 'through the batch’s watch');
});

test('[batch-estimate.nothing-to-price] a batch with no item that needs bytes returns an empty estimate, and sends no EstimateIngestion', async () => {
  const batch = await handBatch(UNCHANGED);
  await batch.planned();
  const estimate = await batch.upload.estimate();
  assert.equal(estimate.documents, 0);
  assert.equal(estimate.cost, undefined);
  assert.equal((await estimatesSent()).length, 0);
});

test('[batch-estimate.many] more items than one EstimateIngestion takes are priced in parts, in order, and added up as sync.estimate-many defines', async () => {
  const batch = await handBatch(handFiles(5));
  await batch.planned();
  // The call limit is a per-call option the types do not show: 2 in place of 10,000.
  const estimate = await batch.upload.estimate(undefined, { estimatePerCall: 2 } as never);
  const sent = await estimatesSent();
  assert.deepEqual(sent.map((docs) => docs.map((d) => d.name)), [['file-1.pdf', 'file-2.pdf'], ['file-3.pdf', 'file-4.pdf'], ['file-5.pdf']]);
  // Each part priced alone, for the sums.
  const parts: any[] = [];
  for (const documents of sent) {
    const res = await fetch(`${BASE}${ESTIMATE}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer pat_test' }, body: JSON.stringify({ documents }) });
    parts.push(await res.json());
  }
  const sum = (get: (p: any) => number) => parts.reduce((n: number, p: any) => n + get(p), 0);
  assert.equal(estimate.documents, 5);
  assert.equal(estimate.documentsOfUnknownLength, 5);
  assert.deepEqual(estimate.durationSeconds, { low: sum((p) => p.durationSeconds.low), high: sum((p) => p.durationSeconds.high) });
  assert.equal(estimate.cost?.unit, 'usd');
  assert.ok(Math.abs(estimate.cost!.high - sum((p) => p.cost.high)) < 1e-9);
  assert.ok(!('details' in estimate));
});

test('[batch-upload.not-started] upload() on a batch not started raises INGESTION_BATCH_NOT_STARTED, status 0, with nothing sent; a when-planned batch is followed until it is running, then uploaded', async () => {
  const files = handFiles(2);
  const manual = await handBatch(files);
  await manual.planned();
  const before = (await api()).length;
  const err = await expectError(Promise.resolve(manual.upload(asUploads(files))));
  assert.ok(err instanceof CaitlynError);
  assert.equal(err.code, 'INGESTION_BATCH_NOT_STARTED');
  assert.equal(err.status, 0);
  assert.match(String(err.detail), /batch\.start\(\)/);
  assert.deepEqual((await api()).slice(before).map((r) => r.method), ['GET'], 'the batch is read once; nothing else is sent');
  assert.equal((await forms()).length, 0);
  // A draft is refused the same way.
  const draft = await handBatch(files, { start: 'manual', awaitMoreItems: true });
  assert.equal((await expectError(Promise.resolve(draft.upload(asUploads(files))))).code, 'INGESTION_BATCH_NOT_STARTED');
  // A when-planned batch, still planning: followed until it is running, then uploaded.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ planningReads: 2 });
  const auto = await handBatch(files, { start: 'when_planned' });
  assert.equal(auto.status, 'planning');
  const uploaded = await auto.upload(asUploads(files));
  assert.deepEqual(uploaded.items.map((i) => i.status), ['ingesting', 'ingesting']);
  assert.equal((await forms()).length, 2);
  assert.ok(!(await api()).some((r) => r.path.endsWith(':start') || r.path.endsWith('/start')), 'no StartIngestionBatch from the SDK');
});

test('[batch-upload.keep-alive] while an upload is in flight the policy is renewed on a timer, so a long final upload is accepted; no renewal after the call returns or is cancelled', async () => {
  // A compressed clock: each policy lasts 4 s, so it is due for renewal 2 s after it arrives (half its life), and the
  // batch stops waiting for bytes 4 s after the latest one. The one file takes 6 s to arrive.
  const renewals = async () => (await api()).filter((r) => r.method === 'POST' && r.path.endsWith('/upload-policies')).length;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await faults({ uploadReservation: { policySeconds: 4, reservationSeconds: 4 }, uploadDelayMs: 6000 });
  const files = handFiles(1);
  const batch = await startedBatch(files);
  const uploaded = await batch.upload(asUploads(files));
  assert.deepEqual(uploaded.items.map((i) => [i.status, i.failureCode]), [['ingesting', undefined]], 'the item was accepted, not UPLOAD_EXPIRED');
  const sent = await renewals();
  assert.ok(sent >= 3, `${sent} policies asked for: the first, then at least two while the upload was in flight`);
  await pause(2500);
  assert.equal(await renewals(), sent, 'no renewal after the call returned');
  // Cancelled during a slow upload: no renewal after the cancellation is raised.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ uploadReservation: { policySeconds: 4, reservationSeconds: 4 }, uploadDelayMs: 6000 });
  const again = await startedBatch(files);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2500);
  const err = await again.upload(asUploads(files), { signal: controller.signal }).then(() => undefined, (e: unknown) => e as Error);
  assert.equal(err?.name, 'AbortError');
  const atCancel = await renewals();
  await pause(2500);
  assert.equal(await renewals(), atCancel, 'no renewal after the cancellation');
});

test('[batch-upload.keep-alive-floor] a policy due every half second is renewed on the keep-alive timer at most once a second while the upload is in flight', async () => {
  // Every policy lasts a second, so it is due half a second after it arrives; the one file takes 4 s to arrive. The first
  // ask is upload()'s own policy; the rest are the timer's, the first half a second on and the others a second apart:
  // about five in all, where half-second renewals would be about nine.
  await faults({ uploadReservation: { policySeconds: 1, reservationSeconds: 30 }, uploadDelayMs: 4000 });
  const files = handFiles(1);
  const batch = await startedBatch(files);
  const uploaded = await batch.upload(asUploads(files));
  assert.deepEqual(uploaded.items.map((i) => [i.status, i.failureCode]), [['ingesting', undefined]]);
  const at = (await api()).filter((r) => r.method === 'POST' && r.path.endsWith('/upload-policies')).map((r) => r.at as number);
  assert.ok(at.length >= 4, `${at.length} policies asked for: the timer renewed fewer than three times in 4 s`);
  assert.ok(at.length <= 6, `${at.length} policies asked for in 4 s: more than once a second`);
  for (let i = 2; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 900, `renewals ${at[i] - at[i - 1]} ms apart`);
});

test('[batch-upload.short-window] uploadWindowSeconds and expiresInSeconds pass straight through, and a short policy is renewed once half its life has passed', async () => {
  // A 4-second window (under the server's 60-second least: the mock's test mode) and one file that takes 5 s to
  // arrive. Each policy lasts 4 s, so its renewal margin is 2 s, not 5 minutes: renewals about 2 s apart, not at once
  // and then once a second.
  await faults({ shortWindows: true, uploadDelayMs: 5000 });
  const t0 = Date.now();
  const report = await kbScope().ingestion.sync(await syncSource({ 'annual-leave.pdf': enc('%PDF annual') }), { folder: '/window/', uploadWindowSeconds: 4 });
  assert.equal(report.batch.status, 'succeeded');
  const created = (await api()).find((r) => r.method === 'POST' && r.path === BATCHES)!;
  assert.equal(JSON.parse(created.body).uploadWindowSeconds, 4, 'sent as given');
  const at = (await api()).filter((r) => r.method === 'POST' && r.path.endsWith('/upload-policies')).map((r) => (r.at as number) - t0);
  assert.ok(at.length >= 1 && at.length <= 3, `${at.length} renewals in a 5 s upload under 4 s policies (at ${at.join(', ')} ms)`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 1500, `renewals ${at[i] - at[i - 1]} ms apart`);
  // expiresInSeconds on a single file's upload, as given.
  const before = Date.now();
  const up = await client().core.uploads.reserve({ fileName: 'a.pdf', contentType: 'application/pdf', byteSize: 1, sha256: await sha256(enc('a')), expiresInSeconds: 60 });
  const sent = (await api()).filter((r) => r.method === 'POST' && r.path === '/v3/uploads').at(-1)!;
  assert.equal(JSON.parse(sent.body).expiresInSeconds, 60);
  const life = (up.expiresAt as Date).getTime() - before;
  assert.ok(life > 55_000 && life < 65_000, `the upload lasts ${life} ms`);
});

test('[batch-upload.sends] only awaiting items that have a file are sent: at most 6 at once, the form’s fields in order, Complete in groups of at most 100', async () => {
  await faults({ uploadDelayMs: 100 });
  const files = { ...handFiles(14), ...UNCHANGED };
  const batch = await startedBatch(files);
  const uploaded = await batch.upload(asUploads(files));
  const stats = await (await fetch(`${BASE}/__mock/uploads`)).json();
  if (IN_PAGE) assert.ok(stats.maxInFlight > 1 && stats.maxInFlight <= 6, `${stats.maxInFlight} at once`);
  else assert.equal(stats.maxInFlight, 6);
  assert.equal((await forms()).length, 14, 'the skipped item is not sent');
  // The mock refuses a form whose fields are out of order; here is the order it received.
  for (const f of await forms()) {
    assert.deepEqual(f.form.map((p: any) => p.name), [...POLICY_FIELDS, 'key', 'Content-Type', 'x-amz-checksum-algorithm', 'x-amz-checksum-sha256', 'file']);
  }
  const groups = (await api()).filter((r) => r.path.endsWith('/complete-uploads')).map((r) => JSON.parse(r.body).itemIds as string[]);
  assert.ok(groups.every((g) => g.length >= 1 && g.length <= 100));
  assert.equal(new Set(groups.flat()).size, 14);
  assert.equal(uploaded.items.length, 14);
  assert.deepEqual(uploaded.unmatched, ['/policies/policy-1.pdf'], 'the skipped item awaits nothing');
  // Its concurrency option.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ uploadDelayMs: 50 });
  const few = handFiles(6);
  await (await startedBatch(few)).upload(asUploads(few), { concurrency: 2 });
  assert.equal((await (await fetch(`${BASE}/__mock/uploads`)).json()).maxInFlight, 2);
});

test('[batch-upload.not-given] an item with no file stays awaiting_upload, is listed in notGiven, is not reported to Complete and does not reach onItem', async () => {
  const files = handFiles(3);
  const [a, b, c] = Object.keys(files);
  const batch = await startedBatch(files);
  const seen: IngestionBatchItem[] = [];
  const uploaded = await batch.upload({ [a]: asUploads(files)[a], [c]: asUploads(files)[c] }, { onItem: (i) => seen.push(i) });
  assert.deepEqual(uploaded.notGiven, [b]);
  assert.deepEqual(uploaded.items.map((i) => i.path).sort(), [a, c]);
  const listed = await itemsOf(batch);
  const left = listed.find((i) => i.path === b)!;
  assert.equal(left.status, 'awaiting_upload');
  assert.ok(!(await completed()).includes(left.id));
  assert.deepEqual(seen, [], 'nothing ended during the call');
  assert.equal((await forms()).length, 2);
});

test('[batch-upload.unmatched] a given path that matches no awaiting item is listed in unmatched and nothing is sent for it; a key without its leading / matches', async () => {
  const files = handFiles(2);
  const [a, b] = Object.keys(files);
  const batch = await startedBatch(files);
  const uploads = asUploads(files);
  const uploaded = await batch.upload(new Map([[a.slice(1), uploads[a]], [b, uploads[b]], ['/hand/ghost.pdf', UploadFile.fromBytes(enc('ghost'), { name: 'ghost.pdf' })]]));
  assert.deepEqual(uploaded.unmatched, ['/hand/ghost.pdf']);
  assert.deepEqual(uploaded.notGiven, []);
  assert.deepEqual(uploaded.items.map((i) => [i.path, i.status]).sort(), [[a, 'ingesting'], [b, 'ingesting']]);
  assert.equal((await forms()).length, 2, 'nothing sent for the unmatched path');
});

test('[batch-upload.file-changed] a file of the wrong size is FILE_CHANGED before sending, and storage refusing its checksum is FILE_CHANGED with no retry; neither stops the others', async () => {
  const files = handFiles(3);
  const [a, b, c] = Object.keys(files);
  const batch = await startedBatch(files);
  const sameSizeOtherBytes = enc('%PDF HAND 2');
  assert.equal(sameSizeOtherBytes.length, files[b].length);
  const seen: IngestionBatchItem[] = [];
  const uploaded = await batch.upload(
    {
      [a]: UploadFile.fromBytes(enc('%PDF hand 1, and then some'), { name: 'file-1.pdf' }),
      [b]: UploadFile.fromBytes(sameSizeOtherBytes, { name: 'file-2.pdf' }),
      [c]: asUploads(files)[c],
    },
    { onItem: (i) => seen.push(i), concurrency: 1 },
  );
  const by = Object.fromEntries(uploaded.items.map((i) => [i.path, i]));
  assert.equal(by[a].status, 'failed');
  assert.equal(by[a].failureCode, 'FILE_CHANGED');
  assert.equal(by[b].status, 'failed');
  assert.equal(by[b].failureCode, 'FILE_CHANGED');
  assert.equal(by[c].status, 'ingesting');
  const keys = await formKeys();
  assert.equal(keys.length, 2, 'nothing sent for the wrong size; the wrong bytes sent once, not retried');
  const done = await completed();
  assert.deepEqual(done, [by[c].id], 'neither failure is reported to Complete');
  assert.deepEqual(seen.map((i) => i.path).sort(), [a, b]);
});

test('[batch-upload.upload-failed] an upload that fails after its retries is UPLOAD_FAILED for that item only: it reaches onItem and items, and is not reported to Complete', async () => {
  const files = handFiles(3);
  const [a, b, c] = Object.keys(files);
  await faults({ failUploads: { [b]: true } });
  const batch = await startedBatch(files);
  const seen: IngestionBatchItem[] = [];
  const uploaded = await client({ maxRetryDelayMs: 10 })
    .knowledgeBases(KB)
    .ingestion.batches(batch.id)
    .upload(asUploads(files), { onItem: (i) => seen.push(i) });
  const by = Object.fromEntries(uploaded.items.map((i) => [i.path, i]));
  assert.equal(by[b].status, 'failed');
  assert.equal(by[b].failureCode, 'UPLOAD_FAILED');
  assert.ok(by[b].failureDetail);
  assert.deepEqual([by[a].status, by[c].status], ['ingesting', 'ingesting']);
  assert.deepEqual(seen.map((i) => [i.path, i.failureCode]), [[b, 'UPLOAD_FAILED']]);
  assert.ok(!(await completed()).includes(by[b].id));
});

test('[batch-upload.policy-renewal] the policy is renewed once it is past its renewal margin, and once after a 403 saying it expired, sending that file again', async () => {
  const generation = (f: any) => JSON.parse(atob(f.form.find((p: any) => p.name === 'policy').value)).generation;
  const policies = async () => (await opsSent()).filter((s) => s.endsWith('/upload-policies')).length;
  // The policy upload() asks for lasts a second, so its renewal margin is half a second; each file takes a second to
  // arrive, one at a time. The first goes with that policy; it is renewed before the second goes.
  await faults({ renewedPolicySeconds: 1, uploadDelayMs: 1000 });
  const two = handFiles(2);
  const first = await startedBatch(two);
  await first.upload(asUploads(two), { concurrency: 1 });
  assert.equal(await policies(), 2, 'the policy, then its renewal');
  assert.deepEqual((await forms()).map(generation), [2, 3], 'the second sent with the renewed policy (Start’s was the first)');
  // A policy storage says has expired: one renewal, and the file sent again.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ firstCreatedPolicyExpired: true });
  const three = handFiles(3);
  const second = await startedBatch(three);
  const uploaded = await second.upload(asUploads(three), { concurrency: 1 });
  assert.equal(await policies(), 2, 'one renewal');
  assert.deepEqual((await forms()).map(generation), [2, 3, 3, 3], 'the refused file, sent again with the new policy, then the rest');
  assert.deepEqual(uploaded.items.map((i) => i.status), ['ingesting', 'ingesting', 'ingesting']);
});

test('[batch-upload.checksum-mismatch] CHECKSUM_MISMATCH from Complete uploads the item once more; a second mismatch fails it', async () => {
  const files = handFiles(3);
  const [a, b] = Object.keys(files);
  await faults({ checksumMismatch: { [a]: 1, [b]: 2 } });
  const batch = await startedBatch(files);
  const seen: IngestionBatchItem[] = [];
  const uploaded = await batch.upload(asUploads(files), { onItem: (i) => seen.push(i) });
  const by = Object.fromEntries(uploaded.items.map((i) => [i.path, i]));
  assert.equal(by[a].status, 'ingesting', 'accepted the second time');
  assert.equal(by[b].status, 'failed');
  assert.equal(by[b].failureCode, 'CHECKSUM_MISMATCH');
  const keys = await formKeys();
  const sentFor = async (p: string) => keys.filter((k) => k.includes(urlSafe(shaOf[p]))).length;
  const shaOf: Record<string, string> = {};
  for (const [p, bytes] of Object.entries(files)) shaOf[p] = await sha256(bytes);
  assert.equal(await sentFor(a), 2);
  assert.equal(await sentFor(b), 2, 'once more, not a third time');
  assert.equal(keys.length, 5);
  assert.deepEqual(seen.map((i) => i.path), [b]);
});

test('[batch-upload.second-call] a second upload() sends only the items still awaiting upload', async () => {
  const files = handFiles(3);
  const [a, b, c] = Object.keys(files);
  const batch = await startedBatch(files);
  const uploads = asUploads(files);
  const first = await batch.upload({ [a]: uploads[a] });
  assert.deepEqual(first.notGiven.sort(), [b, c]);
  assert.equal((await forms()).length, 1);
  const second = await batch.upload(asUploads(files));
  assert.deepEqual(second.items.map((i) => i.path).sort(), [b, c]);
  assert.deepEqual(second.unmatched, [a], 'already uploaded: it awaits nothing');
  assert.equal((await forms()).length, 3, 'two more, not three');
  const done = await completed();
  assert.equal(new Set(done).size, 3);
  assert.equal(done.length, 3);
});

test('[batch-upload.result] awaiting upload() gives {batch, items, notGiven, unmatched} with batch an IngestionBatch; .wait() returns the finished IngestionBatch', async () => {
  const files = handFiles(2);
  const batch = await startedBatch(files);
  const work = batch.upload(asUploads(files));
  const uploaded: BatchUpload<IngestionBatch, IngestionBatchItem> = await work;
  assert.deepEqual(Object.keys(uploaded).sort(), ['batch', 'items', 'notGiven', 'unmatched']);
  assert.equal(uploaded.batch.id, batch.id);
  assert.equal(uploaded.batch.status, 'running');
  assert.ok(uploaded.batch.etag && uploaded.batch.createdAt instanceof Date, 'an IngestionBatch, as reading it gives it');
  assert.ok(!('batchId' in uploaded));
  assert.deepEqual(uploaded.items.map((i) => i.status), ['ingesting', 'ingesting']);
  assert.ok(uploaded.items.every((i) => i.id && i.path));
  const finished: IngestionBatch = await work.wait();
  assert.equal(finished.id, batch.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.counts?.byStatus?.indexed, 2);
  // One call does both.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const again = await startedBatch(files);
  assert.equal((await again.upload(asUploads(files)).wait()).status, 'succeeded');
});

test('[batch-upload.cancel] cancelling upload() aborts the uploads, raises AbortError, and sends no CancelIngestionBatch', async () => {
  await faults({ uploadDelayMs: 150 });
  const files = handFiles(6);
  const batch = await startedBatch(files);
  const controller = new AbortController();
  const running = Promise.resolve(batch.upload(asUploads(files), { concurrency: 2, signal: controller.signal })).catch((e) => e);
  for (const until = Date.now() + 10_000; (await forms()).length < 3; ) {
    if (Date.now() > until) assert.fail('the third upload never arrived');
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  const err = await running;
  assert.equal(err?.name, 'AbortError');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await forms()).length <= 4, 'no new upload after the cancel');
  assert.ok(!(await api()).some((r) => r.path.endsWith(':cancel') || r.path.endsWith('/cancel')), 'the batch is left as it is');
  assert.equal((await batch.get()).status, 'running');
});

test('[sync.estimate-unresolved] an estimate prices every item that could need its bytes, the unresolved ones included; confirm sees it before the resolver runs', async () => {
  // policy-0001 is a conflict the policy leaves unresolved; policy-1.pdf holds what the knowledge base has: skipped.
  await faults({ planConflicts: { '/policies/policy-0001.pdf': 'duplicate_path' } });
  const order: string[] = [];
  let confirmed: SyncPlan | undefined;
  const report = await kbScope().ingestion.sync(await syncSource({ ...someFiles(2), 'policy-1.pdf': enc('doc1') }), {
    folder: '/policies/',
    confirm: (plan) => (order.push('confirm'), (confirmed = plan), true),
    resolve: () => (order.push('resolve'), 'skip'),
  });
  assert.deepEqual(order, ['confirm', 'resolve'], 'the estimate is seen before the resolver runs');
  assert.equal(confirmed?.items.find((i) => i.path === '/policies/policy-0001.pdf')?.resolution, 'unresolved');
  const priced = (await estimatesSent())[0].map((d) => d.name).sort();
  assert.deepEqual(priced, ['policy-0001.pdf', 'policy-0002.pdf'], 'the unresolved conflict and the item to add; not the skipped one');
  assert.equal(confirmed?.estimate?.documents, 2, 'the most the batch could cost');
  assert.equal(report.batch.status, 'succeeded');
  // batch.upload.estimate prices the same items.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const files = { ...handFiles(2), ...UNCHANGED };
  await faults({ planConflicts: { [Object.keys(files)[0]]: 'duplicate_path' } });
  const batch = await handBatch(files);
  await batch.planned();
  const estimate = await batch.upload.estimate();
  assert.deepEqual((await estimatesSent())[0].map((d) => d.name).sort(), ['file-1.pdf', 'file-2.pdf']);
  assert.equal(estimate.documents, 2);
});

test('[sync.report-shape] the report is the batch as reading it gives it and every item as listing gives it, on success, cancellation and a declined confirm', async () => {
  const kb = kbScope();
  const files = someFiles(3, 'leave');
  const checkShape = async (report: SyncReport, when: string) => {
    assert.deepEqual(Object.keys(report).sort(), ['batch', 'items'], `${when}: batch and items, nothing else`);
    const read = await kb.ingestion.batches(report.batch.id).get();
    for (const key of ['id', 'status', 'itemCount', 'counts', 'start', 'policy', 'createdAt'] as const) {
      assert.ok(key in report.batch, `${when}: the batch has ${key}, as reading it gives it`);
    }
    assert.equal(report.batch.id, read.id);
    const listed = new Map<string, Record<string, unknown>>();
    for await (const i of kb.ingestion.batches(report.batch.id).items.list()) listed.set(i.id, i as unknown as Record<string, unknown>);
    assert.equal(report.items.length, listed.size, `${when}: every item`);
    for (const item of report.items) {
      const it = listed.get(item.id);
      assert.ok(it, `${when}: ${item.id} is a listed item`);
      for (const key of Object.keys(it)) assert.ok(key in item, `${when}: ${item.id} has the listed item's ${key}`);
      assert.equal(item.path, it.path);
    }
  };

  // Success: typed as the model's batch and item, with no cast.
  const report = await kb.ingestion.sync(await syncSource(files), { folder: '/policies/' });
  const status: string = report.batch.status;
  const outcome: string | undefined = report.items[0].outcome;
  assert.equal(status, 'succeeded');
  assert.ok(outcome);
  assert.equal(report.batch.counts?.byStatus?.indexed, 3, 'the batch’s counts');
  await checkShape(report, 'success');

  // A declined confirm: CaitlynError CANCELLED, whose report is typed on the error.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  try {
    await kbScope().ingestion.sync(await syncSource(files), { folder: '/policies/', confirm: () => false });
    assert.fail('a declined confirm raises');
  } catch (err: unknown) {
    assert.ok(err instanceof CaitlynError && err.code === 'CANCELLED', `got ${String(err)}`);
    const declined: SyncReport | undefined = err.report;
    assert.ok(declined);
    assert.equal(declined.batch.status, 'cancelled', 'the batch as read once cancelled');
    await checkShape(declined, 'declined confirm');
  }

  // The caller's cancellation: the AbortError, narrowed by isSyncAborted.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ uploadDelayMs: 150, completeDelayMs: 0 });
  const controller = new AbortController();
  const running = kbScope().ingestion.sync(await syncSource(files), { folder: '/policies/', concurrency: 1, signal: controller.signal });
  for (const until = Date.now() + 10_000; !(await api()).some((r) => r.path.endsWith('/complete-uploads')); ) {
    if (Date.now() > until) assert.fail('no upload was reported complete');
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  try {
    await running;
    assert.fail('a cancelled sync raises');
  } catch (err: unknown) {
    if (!isSyncAborted(err)) assert.fail(`got ${String(err)}`);
    const aborted: SyncReport = err.report;
    assert.ok(aborted.batch.id && aborted.batch.status);
    assert.deepEqual(Object.keys(aborted).sort(), ['batch', 'items']);
    assert.equal(aborted.items.length, 3);
  }
});

test('[sync.cancel-report] a cancelled sync’s error carries the report so far: every item with its last status, and the batch’s counts', async () => {
  await faults({ uploadDelayMs: 150, completeDelayMs: 0 });
  const controller = new AbortController();
  const files = { 'policy-1.pdf': enc('doc1'), ...someFiles(4, 'leave') };
  const running = kbScope().ingestion.sync(await syncSource(files), { folder: '/policies/', concurrency: 2, signal: controller.signal }).catch((e) => e);
  // Cancel once the first two uploads have been reported complete: they are accepted, not yet final.
  for (const until = Date.now() + 10_000; !(await api()).some((r) => r.path.endsWith('/complete-uploads')); ) {
    if (Date.now() > until) assert.fail('no upload was reported complete');
    await new Promise((r) => setTimeout(r, 10));
  }
  controller.abort();
  const err = await running;
  assert.equal(err?.name, 'AbortError');
  if (!isSyncAborted(err)) assert.fail('the AbortError, with the report');
  const report = err.report;
  assert.ok(report, 'error.report');
  assert.equal(report.items.length, 5, 'every item');
  const status = Object.fromEntries(report.items.map((i) => [i.path, i.status]));
  assert.equal(status['/policies/policy-1.pdf'], 'skipped');
  assert.ok(Object.values(status).includes('ingesting'), `an accepted item, with its last status: ${JSON.stringify(status)}`);
  assert.ok(Object.values(status).includes('awaiting_upload'), 'one not yet uploaded');
  assert.ok(report.batch.counts, 'the batch’s counts');
  assert.ok(report.batch.id);
  // The caller's own cancellation is the platform's AbortError; a declined confirm is CANCELLED. Both carry the report.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const declined = await kbScope().ingestion.sync(await syncSource(files), { folder: '/policies/', confirm: () => false }).catch((e) => e);
  assert.ok(declined instanceof CaitlynError, `got ${declined?.name}`);
  assert.equal(declined.code, 'CANCELLED');
  assert.equal(declined.status, 0);
  assert.equal(declined.report!.items.length, 5);
});

test('[sync.cancelled-item] an item whose document was deleted while it was ingested ends cancelled: reported once, counted as done, never sent again, and the batch succeeds', async () => {
  await faults({ cancelItems: { '/hr/policy-0002.pdf': true } });
  const items: any[] = [];
  const done: number[] = [];
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(3)), {
    folder: '/hr/',
    onItem: (i) => items.push(i),
    onProgress: (p) => {
      if (p.phase === 'succeeded') done.push(p.done);
    },
  });
  assert.equal(report.batch.status, 'succeeded');
  const cancelled = report.items.find((i) => i.path === '/hr/policy-0002.pdf')!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.failureCode, undefined);
  const seen = items.filter((i) => i.path === '/hr/policy-0002.pdf');
  assert.equal(seen.length, 1, 'reported once');
  assert.equal(seen[0].status, 'cancelled');
  assert.deepEqual(done, [3], 'counted as done');
  assert.equal((await forms()).length, 3, 'uploaded once each');
  const completes = (await api()).filter((r) => r.path.endsWith('/complete-uploads')).flatMap((r) => JSON.parse(r.body).itemIds);
  assert.equal(completes.filter((id: string) => id === cancelled.id).length, 1, 'completed once');
});

// ---------------------------------------------------------------- the model's @examples

/** Every member of `expected` is in `actual` with the same value; timestamps compare as instants. */
function assertSubset(expected: unknown, actual: unknown, at = 'output'): void {
  // A created thing's scope keeps its own methods where the response has a member of the same name (a batch's `start`
  // mode is its start() method); the member is in the response the call returned.
  if (typeof actual === 'function') return;
  if (actual instanceof Date) {
    assert.equal(actual.getTime(), new Date(expected as string).getTime(), `${at}: timestamp`);
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${at}: expected an object, got ${JSON.stringify(actual)}`);
    for (const [k, v] of Object.entries(expected)) assertSubset(v, (actual as Record<string, unknown>)[k], `${at}.${k}`);
    return;
  }
  assert.equal(actual, expected, at);
}

// The example cases go through the client as a caller writes it: each operation's method is found in the scope tree
// (conformance/cases/scope-tree.json); the example's input gives the identifiers for the scopes on the way and the
// rest for the call, laid out as the SDK takes them (codegen/typescript's ScopeEmitter): an upload target's file first,
// else a lone required member first, then an object of the rest, then the call options.
interface TreeNode {
  kind: 'root' | 'namespace' | 'collection' | 'scope';
  name?: string;
  alias?: string;
  identifiers?: { name: string; fixed?: string }[];
  methods?: { name: string; operation: string; fills?: { member: string; identifier: string; trimSlashes?: boolean }[]; leading?: string[]; estimate?: string }[];
  children?: Record<string, TreeNode>;
  scope?: TreeNode;
}
const TREE: TreeNode = JSON.parse(fs.readFileSync(path.join(ROOT, 'conformance/cases/scope-tree.json'), 'utf8'));
const SHAPES: Record<string, any> = JSON.parse(fs.readFileSync(path.join(ROOT, 'model/model.json'), 'utf8')).shapes;
const T = (n: string) => `ai.caitlyn.v3#${n}`;

/** A structure's members, its mixins' included. */
function membersOf(id: string): Record<string, any> {
  const s = SHAPES[id];
  const out: Record<string, any> = {};
  for (const m of s?.mixins ?? []) Object.assign(out, membersOf(m.target));
  return Object.assign(out, s?.members ?? {});
}

/** How a method takes an operation's input: as ScopeEmitter lays it out. */
function layout(operation: string, fills: string[]) {
  const op = SHAPES[T(operation)];
  const members = membersOf(op.input.target);
  const options: Record<string, string> = {};
  const rest: string[] = [];
  const upload = op.traits?.['ai.caitlyn.traits#uploadTarget']?.member as string | undefined;
  const top = upload && !upload.includes('.') ? upload : undefined;
  for (const [name, m] of Object.entries(members)) {
    const header = m.traits?.['smithy.api#httpHeader'];
    if (m.traits?.['smithy.api#idempotencyToken'] !== undefined || /^if-match$/i.test(header ?? '')) options[name] = name;
    else if (fills.includes(name) || m.traits?.['ai.caitlyn.traits#fromScope'] !== undefined || name === top) continue;
    else rest.push(name);
  }
  const required = rest.filter((n) => members[n].traits?.['smithy.api#required'] !== undefined);
  const readers = (n: string) => SHAPES[members[n].target]?.members?.kind !== undefined;
  const positional = !top && !upload?.includes('.') && required.length === 1 && rest.length <= 3 && !readers(required[0]!) ? required[0] : undefined;
  return { top, positional, rest: rest.filter((n) => n !== positional), options };
}

/** Every place an operation is offered: the nodes from the root, and the method (an estimate is its job's .estimate). */
function placements(operation: string) {
  const out: { chain: TreeNode[]; method: NonNullable<TreeNode['methods']>[number]; estimate: boolean }[] = [];
  const walk = (n: TreeNode, chain: TreeNode[]) => {
    for (const m of n.methods ?? []) {
      if (m.operation === operation) out.push({ chain, method: m, estimate: false });
      if (m.estimate === operation) out.push({ chain, method: m, estimate: true });
    }
    for (const c of Object.values(n.children ?? {})) walk(c, [...chain, c]);
    if (n.scope) walk(n.scope, [...chain, n.scope]);
  };
  walk(TREE, []);
  return out;
}

/** Calls an example's operation through the scope tree; returns what the call returned (a stream or list is read). */
async function callExample(c: Caitlyn, ex: ExampleCase): Promise<unknown> {
  const input = ex.input;
  const fromScope = Object.entries(membersOf(SHAPES[T(ex.operation)].input.target)).filter(([, m]) => m.traits?.['ai.caitlyn.traits#fromScope'] !== undefined).map(([n]) => n);
  const ok = placements(ex.operation).filter(({ chain, method, estimate }) => {
    const fills = method.fills ?? [];
    if (fills.some((f) => input[f.member] === undefined)) return false;
    if (!estimate && fromScope.some((m) => input[m] !== undefined && !fills.some((f) => f.member === m))) return false;
    // A named scope fits only an input naming its fixed value.
    return chain.every((n) => !n.alias || n.identifiers!.filter((i) => i.fixed).every((i) => {
      const f = fills.find((x) => x.identifier === i.name);
      return !f || input[f.member] === i.fixed;
    }));
  });
  assert.ok(ok.length, `${ex.operation} has no method in the scope tree that fits the example's input`);
  const { chain, method, estimate } = ok[0]!;
  // The identifiers, as the scopes take them: a folder as people write it.
  const ids: Record<string, string> = {};
  const jobFills = method.fills ?? [];
  for (const f of jobFills) {
    const v = input[f.member];
    if (v !== undefined) ids[f.identifier] = f.trimSlashes ? `/${String(v)}/` : String(v);
  }
  let at: any = c;
  for (const [i, n] of chain.entries()) {
    const parent = i === 0 ? TREE : chain[i - 1]!;
    if (n.kind === 'scope' && parent.kind === 'collection') at = at(...parent.identifiers!.map((x) => ids[x.name]));
    else at = at[n.name!];
  }
  const fn = estimate ? at[method.name].estimate : at[method.name].bind(at);
  // The arguments: laid out as the job takes them; an estimate's values come from its own input by name.
  const job = layout(method.operation, jobFills.map((f) => f.member));
  const own = estimate ? layout(ex.operation, jobFills.map((f) => f.member)) : job;
  const args: unknown[] = (method.leading ?? []).map((l) => input[l]);
  if (job.top) {
    if (!estimate) args.push({ [job.top]: input[job.top] });
    else {
      // The estimate takes the file the job would; the example gives its description, which the SDK takes as it is.
      const desc = Object.values(input).find((v) => v && typeof v === 'object' && 'byteSize' in (Array.isArray(v) ? v[0] : v));
      args.push(Array.isArray(desc) ? desc[0] : desc);
    }
  }
  if (job.positional) args.push(input[job.positional]);
  // A file job's estimate takes the file and the estimate's own members only; any other estimate, its job's arguments.
  const describes = (target: string) => target === T('UploadDescription') || SHAPES[target]?.member?.target === T('UploadDescription');
  const estimateMembers = membersOf(SHAPES[T(ex.operation)].input.target);
  const ownMembers = estimate && job.top ? own.rest.filter((n) => !describes(estimateMembers[n].target)) : undefined;
  const restNames = ownMembers ?? (estimate ? job.rest.filter((n) => own.rest.includes(n)) : job.rest);
  const rest = Object.fromEntries(restNames.filter((n) => input[n] !== undefined).map((n) => [n, input[n]]));
  const options = Object.fromEntries(Object.keys(own.options).filter((n) => input[n] !== undefined).map((n) => [n, input[n]]));
  if (ownMembers ? ownMembers.length : job.rest.length) args.push(rest);
  args.push(options);
  const result = await fn(...args);
  if (result && typeof (result as { finalMessage?: unknown }).finalMessage === 'function') {
    const events: unknown[] = [];
    for await (const e of result as AsyncIterable<{ type: string }>) {
      events.push(e);
      // A watch stays open (and reconnects): its first event is enough. An answer ends at its final event.
      if (ex.operation !== 'SendMessage') break;
    }
    return events;
  }
  if (result && typeof result === 'object' && Symbol.asyncIterator in result && !(result as { then?: unknown }).then) {
    // A list: the example's one page, read without asking for the next (at least one item is asked for, so the
    // first page is requested even when the example's is empty or an error).
    const want = Math.max(1, ((ex.expected.output as { items?: unknown[] } | undefined)?.items ?? []).length);
    const items: unknown[] = [];
    for await (const item of result as AsyncIterable<unknown>) if (items.push(item) >= want) break;
    return { items };
  }
  return result;
}

for (const ex of EXAMPLES) {
  // A page cannot read a redirect (the browser hides an opaque redirect's status, headers and body), so a page cannot
  // call GetDocumentContent: its 302 is the answer.
  if (IN_PAGE && ex.response.status === 302) {
    nodeTest(`[example] ${ex.id}`, { skip: 'a page cannot read a redirect' }, () => {});
    continue;
  }
  test(`[example] ${ex.id}`, async () => {
    await fetch(`${BASE}/__mock/example`, { method: 'POST', body: JSON.stringify({ id: ex.id }) });
    let output: any;
    let error: unknown;
    try {
      output = await callExample(client(), ex);
    } catch (err) {
      error = err;
    }
    const result = await (await fetch(`${BASE}/__mock/example`)).json();
    assert.ok(result.served, `the SDK sent no request${error ? `: ${String(error)}` : ''}`);
    assert.deepEqual(result.mismatches, [], 'the request differs from the example');
    if (ex.expected.error) {
      const want = ex.expected.error;
      assert.ok(error instanceof CaitlynError, `expected ${want.shape}, got ${String(error)}`);
      const e = error as Err;
      assert.equal(e.name, want.shape);
      assert.equal(e.status, want.status);
      assert.equal(e.code, want.code);
      assert.equal(e.requestId, want.requestId);
    } else {
      assert.equal(error, undefined, `unexpected error: ${String(error)}`);
      if (ex.expected.output && !ex.response.stream) {
        const want = ex.expected.output as Record<string, unknown>;
        if (output && typeof output === 'object' && 'items' in output && 'items' in want) assertSubset({ items: want.items }, output);
        else assertSubset(want, output);
      }
    }
  });
}

// ---------------------------------------------------------------- 0.10.1: timeouts, unreadable expiry, sync estimates, If-Match: *

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mockLog = async (event: string) => (await requests()).filter((r) => r.event === event);
/**
 * The attempts the mock saw closed (request-aborted, for op if given), once three are in or 2 s have passed: a browser
 * closes an aborted request's connection in its own time (WebKit's can take several hundred milliseconds under load).
 */
async function abortsSeen(op?: string): Promise<number> {
  const count = async () => (await mockLog('request-aborted')).filter((e) => !op || e.op === op).length;
  for (const until = Date.now() + 2000; Date.now() < until && (await count()) < 3; ) await pause(50);
  return count();
}
/** A planned and started batch of these files, through the given client. */
async function startedWith(c: Caitlyn, files: Record<string, Uint8Array>) {
  const items = await Promise.all(Object.entries(files).map(async ([p, bytes]) => ({ path: p, sha256: await sha256(bytes), byteSize: bytes.length, contentType: 'application/pdf' })));
  const batch = await c.knowledgeBases(KB).ingestion.batches.create({ start: 'manual', items } as never);
  await batch.planned();
  await batch.start();
  return batch;
}
const policiesAsked = async () => (await api()).filter((r) => r.method === 'POST' && r.path.endsWith('/upload-policies')).length;

test('[client.request-timeout] a call with no response headers within the request timeout fails with CONNECTION_ERROR after its retries, each attempt closed; a watch with only keep-alives stays open', async () => {
  const c = client({ requestHandler: { requestTimeout: 300 } });
  await faults({ status: { GetKnowledgeBase: [{ hold: true }, { hold: true }, { hold: true }] } });
  const started = Date.now();
  const err = await expectError(c.knowledgeBases(KB).get());
  assert.equal(err.code, 'CONNECTION_ERROR');
  assert.equal(err.status, 0);
  assert.match(err.message, /GetKnowledgeBase/, 'the message names the operation');
  assert.match(err.message, /300 ms/, 'and the timeout');
  assert.equal((await api()).filter((r) => r.path === KB_PATH).length, 3, 'retried as a read is');
  assert.ok(Date.now() - started < 10_000);
  assert.equal(await abortsSeen(), 3, 'each timed-out attempt was closed, not left open');
  // A watch whose stream goes quiet but for keep-alives, for longer than the timeout, is not cut: only the headers are timed.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ watchKeepAliveMs: 100 });
  const kb = c.knowledgeBases(KB);
  const seen: string[] = [];
  const watching = (async () => {
    for await (const event of kb.watch()) {
      seen.push(event.type);
      if (event.type === 'knowledge_base.updated') return;
    }
  })();
  await pause(1200);
  const current = await kb.get();
  await kb.update({ description: 'Still watching' }, { ifMatch: current.etag! });
  await watching;
  assert.deepEqual(seen, ['snapshot', 'knowledge_base.updated']);
  assert.equal((await api()).filter((r) => r.path === `${KB_PATH}/events`).length, 1, 'one connection, never cut');
});

test('[files.storage-stall] a storage request that sends and receives nothing for the stall timeout is closed and retried, then the item fails UPLOAD_FAILED', async () => {
  const c = client({ storageStallTimeoutMs: 300 });
  const files = handFiles(1);
  const batch = await startedWith(c, files);
  await faults({ status: { PostObject: [{ hold: true }, { hold: true }, { hold: true }] } });
  const up = await batch.upload(asUploads(files));
  assert.deepEqual(up.items.map((i) => [i.status, i.failureCode]), [['failed', 'UPLOAD_FAILED']]);
  assert.match(String(up.items[0].failureDetail), /storage sent nothing for 300 ms/);
  assert.equal((await forms()).length, 3, 'retried as a send with no response is');
  assert.equal(await abortsSeen('PostObject'), 3, 'each stalled attempt was closed');
});

test('[files.slow-not-stalled] a large upload storage reads slowly but steadily is not abandoned, though it takes longer than the stall timeout', async () => {
  const c = client({ storageStallTimeoutMs: 2500 });
  const big = new Uint8Array(32 * 1024 * 1024).map((_, i) => i % 251);
  const files = { '/hand/large.pdf': big };
  const batch = await startedWith(c, files);
  await faults({ uploadReadBytesPerSecond: 8 * 1024 * 1024 });
  const started = Date.now();
  const up = await batch.upload(asUploads(files));
  assert.deepEqual(up.items.map((i) => [i.status, i.failureCode]), [['ingesting', undefined]]);
  assert.ok(Date.now() - started > 2500, `took ${Date.now() - started} ms: longer than the stall timeout in all`);
  assert.equal((await forms()).length, 1, 'one attempt');
});

test('[batch-upload.unreadable-expiry] a policy with no expiresAt is renewed before each upload, every upload is accepted and no keep-alive runs; one that is not a time fails with DECODE_FAILED', async () => {
  // Start's policy is short, so the first upload renews it; every renewal then has no expiresAt.
  await faults({ policySeconds: 1, policyExpiresAt: null });
  const files = handFiles(3);
  const batch = await startedWith(client(), files);
  const before = await policiesAsked();
  const up = await batch.upload(asUploads(files), { concurrency: 1 });
  assert.deepEqual(up.items.map((i) => i.status), ['ingesting', 'ingesting', 'ingesting']);
  assert.ok((await policiesAsked()) - before >= 3, `${(await policiesAsked()) - before} policies asked for: one before each of 3 uploads`);
  // No keep-alive timer runs for such a policy: nothing more is asked for once the call has returned.
  const after = await policiesAsked();
  await pause(1500);
  assert.equal(await policiesAsked(), after);
  // An expiresAt that is not a time fails the call that returned it, clearly: never a silent loss of renewal.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ policySeconds: 1, policyExpiresAt: 'not a date' });
  const again = await startedWith(client(), files);
  assert.equal((await expectError(again.upload(asUploads(files), { concurrency: 1 }))).code, 'DECODE_FAILED');
});

test('[sync.no-confirm-no-estimate] a sync with no confirm never calls EstimateIngestion, and completes when it would fail', async () => {
  await faults({ status: { EstimateIngestion: [{ status: 503 }, { status: 503 }, { status: 503 }] } });
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(2)), { folder: '/hr/' });
  assert.equal(report.batch.status, 'succeeded');
  assert.deepEqual(await estimatesSent(), [], 'nothing was priced');
});

test('[sync.confirm-estimate-unavailable] confirm gets the plan with estimateError and no estimate when EstimateIngestion fails, and true carries on; sync.estimate raises the error', async () => {
  await faults({ status: { EstimateIngestion: [{ status: 400 }] } });
  let seen: SyncPlan | undefined;
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(2)), { folder: '/hr/', confirm: (plan) => ((seen = plan), true) });
  assert.equal(report.batch.status, 'succeeded');
  assert.equal(seen?.estimate, undefined);
  assert.ok(seen?.estimateError instanceof CaitlynError, `estimateError ${seen?.estimateError}`);
  assert.equal((seen?.estimateError as Err).status, 400);
  assert.equal(seen?.items.length, 2);
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ status: { EstimateIngestion: [{ status: 400 }] } });
  const err = await expectError(kbScope().ingestion.sync.estimate(await syncSource(someFiles(2)), { folder: '/hr/' }));
  assert.equal(err.status, 400);
});

test('[if-match.never-wildcard] If-Match: * is sent as given when the caller passes it and matches any version; no helper sends it on its own', async () => {
  const kb = client().knowledgeBases(KB);
  // Unasked, the mock refuses it: every other case is a guard that no helper sends it.
  assert.equal((await expectError(kb.update({ description: 'Any version' }, { ifMatch: '*' }))).code, 'IF_MATCH_WILDCARD_NOT_ASKED');
  await faults({ allowIfMatchWildcard: true });
  const updated = await kb.update({ description: 'Any version' }, { ifMatch: '*' });
  assert.equal(updated.description, 'Any version');
  const sent = (await api()).filter((r) => r.method === 'PATCH' && r.path === KB_PATH);
  assert.equal(sent.at(-1).headers['if-match'], '*');
  // A sync, which sends If-Match on Start, sends the plan's own ETag.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  const report = await kbScope().ingestion.sync(await syncSource(someFiles(1)), { folder: '/hr/' });
  assert.equal(report.batch.status, 'succeeded');
  const start = (await api()).find((r) => r.path.endsWith('/start'));
  assert.ok(start.headers['if-match'] && start.headers['if-match'] !== '*', `Start sent If-Match ${start.headers['if-match']}`);
});

test('[watch.snapshot-not-progress] a watch whose connections bring only their snapshot ends in STREAM_LOST after three reconnects; an event after a snapshot is progress', async () => {
  const kb = client().knowledgeBases(KB);
  const watches = async () => (await api()).filter((r) => r.method === 'GET' && r.path === `/v3/knowledge-bases/${KB}/events`).length;
  // Four connections in a row that each end after their snapshot (a fresh id every time): STREAM_LOST.
  await faults({ watchDrops: { count: 4, afterEvents: 1 } });
  const seen: string[] = [];
  const err = await expectError((async () => { for await (const e of kb.watch()) seen.push(e.type); })());
  assert.equal(err.code, 'STREAM_LOST');
  assert.deepEqual(seen, ['snapshot', 'snapshot', 'snapshot', 'snapshot']);
  assert.equal(await watches(), 4, 'the first connection and three reconnects');
  // Three such connections, then one that stays open and brings a change: the watch carries on to it.
  await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
  await faults({ watchDrops: { count: 3, afterEvents: 1 } });
  const changing = (async () => {
    while ((await watches()) < 4) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    const current = await kb.get();
    await kb.update({ description: 'Still watching' }, { ifMatch: current.etag! });
  })();
  const types: string[] = [];
  for await (const e of kb.watch()) {
    types.push(e.type);
    if (e.type === 'knowledge_base.updated') break;
  }
  await changing;
  assert.deepEqual(types, ['snapshot', 'snapshot', 'snapshot', 'snapshot', 'knowledge_base.updated']);
});

test('[batch-upload.policy-sets-key] a policy whose formFields have their own key, as createPresignedPost makes them, uploads each item with one key, the item\'s objectKey (the mock refuses a repeated field)', async () => {
  const c = client();
  const files = handFiles(2);
  const batch = await startedWith(c, files);
  const up = await batch.upload(asUploads(files));
  assert.deepEqual(up.items.map((i) => [i.status, i.failureCode ?? null]), [['ingesting', null], ['ingesting', null]]);
  const objectKeys = new Set((await collect(batch.items.list())).map((i) => i.objectKey));
  const sent = await forms();
  assert.equal(sent.length, 2);
  for (const f of sent) {
    const keys = f.form.filter((p: any) => p.name.toLowerCase() === 'key');
    assert.equal(keys.length, 1, `one key field: ${JSON.stringify(f.form.map((p: any) => p.name))}`);
    assert.ok(objectKeys.has(keys[0].value), `the item's objectKey, not the policy's ${keys[0].value}`);
  }
  assert.deepEqual(await mockLog('storage-refused-repeated-field'), []);
});

test('[errors.409-retry-after] a 409 carries retryAfterSeconds from its Retry-After and is not retried: CreateDocument and a rename onto a path a started batch has reserved (TARGET_IN_USE)', async () => {
  const c = client();
  await startedWith(c, handFiles(1, '/reserved/'));
  const kb = c.knowledgeBases(KB);
  const created = await expectError(kb.documents.create(UploadFile.fromBytes(enc('%PDF another'), { name: 'file-1.pdf' }), { folder: '/reserved/' }));
  assert.ok(created instanceof ConflictError, created.name);
  assert.equal(created.code, 'TARGET_IN_USE');
  assert.equal(created.retryAfterSeconds, 30);
  assert.equal((await api()).filter((r) => r.method === 'POST' && r.path === `/v3/knowledge-bases/${KB}/documents`).length, 1, 'a 409 is not retried');
  const other = await kb.documents.create(UploadFile.fromBytes(enc('%PDF other'), { name: 'other.pdf' }), { folder: '/reserved/' });
  const current = await kb.documents(other.id).get();
  const renamed = await expectError(kb.documents(other.id).update({ name: 'file-1.pdf' }, { ifMatch: current.etag! }));
  assert.ok(renamed instanceof ConflictError, renamed.name);
  assert.equal(renamed.code, 'TARGET_IN_USE');
  assert.equal(renamed.retryAfterSeconds, 30);
});

test('[telemetry.batch-item] each item an upload helper sends has a caitlyn.batch.item span with its steps as events', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const c = client({ telemetry: { tracerProvider: provider } });
  const files = { ...handFiles(2), '/hand/broken.pdf': enc('%PDF broken') };
  const batch = await startedWith(c, files);
  await faults({ failUploads: { '/hand/broken.pdf': true } });
  await batch.upload(asUploads(files));
  const items = exporter.getFinishedSpans().filter((s) => s.name === 'caitlyn.batch.item');
  assert.equal(items.length, 3);
  for (const s of items) {
    assert.equal(s.attributes['caitlyn.ingestion_batch.id'], batch.id);
    assert.ok(s.attributes['caitlyn.ingestion_batch.item.id']);
    const p = String(s.attributes['caitlyn.ingestion_batch.item.path']);
    const events = s.events.map((e) => e.name);
    if (p === '/hand/broken.pdf') {
      assert.deepEqual(events.slice(0, 3), ['opened', 'checked', 'sending']);
      assert.equal(events.at(-1), 'failed');
      assert.equal(s.events.at(-1)!.attributes!['caitlyn.error.code'], 'UPLOAD_FAILED');
      assert.equal(s.status.code, SpanStatusCode.ERROR);
    } else {
      assert.deepEqual(events, ['opened', 'checked', 'sending', 'sent', 'completed'], `${p}: ${events.join(', ')}`);
    }
  }
});
