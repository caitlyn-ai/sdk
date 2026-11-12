// TypeScript conformance harness: the protocol cases in conformance/cases/protocol.json and the example
// cases in conformance/cases/examples.json, against the mock server. Test names start with the case id in
// square brackets; scripts/check-conformance.mjs checks that every case ran and passed.
import { test, before, after, beforeEach } from 'node:test';
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
  NotFoundError,
  NotSupportedByServer,
  PreconditionFailedError,
  ServiceUnavailableError,
  ValidationError,
  CaitlynAuthError,
  type AuthOptions,
  type CaitlynErrorFields,
  type OAuthTokens,
  type TokenStore,
} from '@caitlyn-ai/sdk';
import * as commands from '@caitlyn-ai/sdk/commands';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { propagation, SpanStatusCode } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { MOCK_AWS, MOCK_CLIENT, MOCK_OAUTH_CLIENT, MOCK_PAT, MOCK_SESSION_COOKIE, mockOidcToken } from '../mock-server/auth.mjs';

const ROOT = process.env.CAITLYN_REPO_ROOT ?? path.resolve(import.meta.dirname, '../..');
const EXAMPLES: ExampleCase[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'conformance/cases/examples.json'), 'utf8')).cases;
const SDK_VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); // every SDK sends it in its user agent
const SDK_MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'model/model.lock.json'), 'utf8')).stampNext as string;
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

interface ExampleCase {
  id: string;
  operation: string;
  input: Record<string, unknown>;
  response: { stream?: boolean };
  expected: { output?: Record<string, unknown> | null; error?: { status: number; code: string; shape: string; requestId: string } };
}

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'conformance/mock-server/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => server.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));
});
after(() => server.kill());
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
  const docs = await collect(client().documents.list({ knowledgeBaseId: 'KB4T7YQ2WL', limit: 100 }));
  const elapsed = Date.now() - t0;
  assert.equal(docs.length, 7);
  assert.ok(elapsed >= 2000, `waited ${elapsed} ms`);
  assert.equal((await api()).length, 2);
});

test('[retry.503-retry-after] a 503 with Retry-After 1 waits at least 1 s, then succeeds', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 1 }] } });
  const t0 = Date.now();
  const v = await client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  assert.equal(v.name, 'draft');
  assert.ok(Date.now() - t0 >= 1000);
});

test('[retry.long-retry-after] a long Retry-After (7 s) is honoured in full', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 7 }] } });
  const t0 = Date.now();
  await client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  assert.ok(Date.now() - t0 >= 7000, `waited ${Date.now() - t0} ms`);
});

test('[retry.idempotency-key-kept] the idempotency key is generated once and kept across retries', async () => {
  await faults({ status: { CreateUpload: [{ status: 503, retryAfter: 0 }] } });
  await client().uploads.reserve({ fileName: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' });
  const sent = (await api()).filter((r) => r.path === '/v3/uploads');
  assert.equal(sent.length, 2);
  assert.match(sent[0].headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  assert.equal(sent[0].headers['idempotency-key'], sent[1].headers['idempotency-key']);
});

test('[retry.unsafe-not-retried] an operation that is not retry-safe (SendMessage) is sent once on a 503', async () => {
  await faults({ status: { SendMessage: [{ status: 503, retryAfter: 0 }] } });
  const err = await expectError(collect(client().conversations.send('c-1', { message: 'hi' })));
  assert.equal(err.status, 503);
  assert.ok(err instanceof ServiceUnavailableError);
  assert.equal((await api()).length, 1);
});

test('[retry.above-max-retry-delay] a Retry-After above maxRetryDelay fails at once with the typed error', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 429, retryAfter: 120 }] } });
  const t0 = Date.now();
  const err = await expectError(client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }));
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterSeconds, 120);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((await api()).length, 1);
});

// ---------------------------------------------------------------- pagination

test('[pagination.to-last-page] a list runs to the last page, following nextCursor', async () => {
  const docs = await collect(client().documents.list({ knowledgeBaseId: 'KB4T7YQ2WL', limit: 3 }));
  assert.equal(docs.length, 7);
  const reqs = await api();
  assert.equal(reqs.length, 3);
  assert.ok(!reqs[0].query.includes('cursor='));
  assert.ok(reqs[2].query.includes('cursor='));
});

// ---------------------------------------------------------------- SSE

test('[sse.resume-finished] resuming an answer that has already finished ends at once, with no events and no error', async () => {
  const c = client();
  const first: { eventId?: string }[] = await collect(c.conversations.send('c-done', { message: 'hi' }));
  const resumed = c.conversations.resume('c-done', { lastEventId: first.at(-1)!.eventId });
  assert.deepEqual(await collect(resumed), []);
  assert.equal((await api()).filter((r) => r.method === 'GET').length, 1, 'one resume request, no reconnects');
});

test('[sse.request-id-and-type] a stream exposes its request id, and every event its SSE event name', async () => {
  const stream = client().conversations.send('c-ids', { message: 'hi' });
  const events = await collect(stream);
  assert.equal(stream.requestId, (await api()).at(-1).requestId);
  assert.equal(events[0]!.type, 'message.started');
  assert.equal(events.at(-1)!.type, 'message.completed');
});

test('[sse.typed-events] typed events, keep-alive comments ignored, finalMessage() returns the final member', async () => {
  const stream = client().conversations.send('c-1', { message: 'How many days of annual leave do staff get?' });
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
  await faults({ dropAfterEvents: 3 });
  const events = await collect(client().conversations.send('c-2', { message: 'hi' }));
  const ids = events.map((e) => e.eventId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate events');
  assert.equal(events.at(-1)?.type, 'message.completed');
  const resume = (await api()).find((r) => r.method === 'GET' && r.path === '/v3/conversations/c-2/stream');
  assert.ok(resume, 'a resume request was made');
  assert.equal(resume.headers['last-event-id'], ids[2]);
  assert.equal(resume.headers.accept, 'text/event-stream');
});

test('[sse.clean-end-resumes] a clean end of stream before the final event also resumes', async () => {
  await faults({ endAfterEvents: 2 });
  const events = await collect(client().conversations.send('c-5', { message: 'hi' }));
  assert.equal(events.at(-1)?.type, 'message.completed');
  const resume = (await api()).find((r) => r.method === 'GET' && r.path === '/v3/conversations/c-5/stream');
  assert.equal(resume?.headers['last-event-id'], events[1]!.eventId);
});

test('[sse.message-failed] message.failed raises the typed error for its status and ends the stream', async () => {
  await faults({ failStream: true });
  const seen: string[] = [];
  const err = await expectError(
    (async () => {
      for await (const e of client().conversations.send('c-6', { message: 'hi' })) seen.push(e.type);
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
  const events = await collect(client().conversations.send('c-3', { message: 'hi' }));
  assert.ok(!events.some((e) => (e.type as string) === 'memory.saved'));
  assert.equal(events.at(-1)?.type, 'message.completed');
});

test('[tolerance.unknown-enum] an unknown enum value is kept, not raised', async () => {
  await faults({ unknownEnum: true });
  const docs = await collect(client().documents.list({ knowledgeBaseId: 'KB4T7YQ2WL' }));
  assert.equal(docs[1]!.status as string, 'archived');
  const v = await client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  assert.equal(v.source as string, 'cloned_from_template');
});

test('[tolerance.unknown-field-raw] unknown fields are kept in raw on the output', async () => {
  await faults({ unknownField: true });
  const v = await client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  assert.deepEqual(v.raw?.reviewState, { required: false });
  assert.ok(!('reviewState' in v), 'unknown fields are not spread onto the output');
});

test('[tolerance.nested-raw] unknown fields are kept in raw on nested structures and list items', async () => {
  await faults({ unknownField: true });
  const docs = await collect(client().documents.list({ knowledgeBaseId: 'KB4T7YQ2WL' }));
  assert.deepEqual((docs[0] as unknown as { raw?: Record<string, unknown> }).raw?.retentionPolicy, { keepDays: 365 });
  const v = await client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  const kb = v.configuration.knowledgeBases?.[0] as unknown as { raw?: Record<string, unknown> };
  assert.equal(kb.raw?.reranker, 'cohere');
});

// ---------------------------------------------------------------- typed errors

test('[errors.404] a 404 is NotFoundError with status, code and requestId, with and without X-Amzn-Errortype', async () => {
  for (const awsErrorTypeHeader of [false, true]) {
    await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
    await faults({ awsErrorTypeHeader });
    const err = await expectError(collect(client().documents.list({ knowledgeBaseId: 'NOPE' })));
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
  const up = await c.uploads.reserve({ fileName: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' });
  const err = await expectError(c.documents.create({ knowledgeBaseId: 'KB4T7YQ2WL', uploadId: up.id, folder: 'hr/' }));
  assert.ok(err instanceof ConflictError);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'CONFLICT');
});

test('[errors.412] a 412 on a stale ETag is PreconditionFailedError', async () => {
  const c = client();
  const draft = await c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  await c.versions.updateDraft('GHT7YRWXPL', { instructions: 'first' }, { ifMatch: draft.etag });
  const err = await expectError(c.versions.updateDraft('GHT7YRWXPL', { instructions: 'second' }, { ifMatch: draft.etag }));
  assert.ok(err instanceof PreconditionFailedError);
  assert.equal(err.code, 'PRECONDITION_FAILED');
  assert.ok(err.requestId);
});

test('[errors.429-exhausted] a 429 after retries are exhausted carries retryAfterSeconds', async () => {
  await faults({ status: { GetAgentVersion: [0, 1, 2].map(() => ({ status: 429, retryAfter: 0 })) } });
  const err = await expectError(client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }));
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.retryAfterSeconds, 0);
  assert.equal((await api()).length, 3);
});

test('[errors.field-errors] a 400 VALIDATION_FAILED for a field both set and cleared carries the field errors', async () => {
  const c = client();
  const draft = await c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  const err = await expectError(c.versions.updateDraft('GHT7YRWXPL', { identity: 'New', clear: ['identity'] }, { ifMatch: draft.etag }));
  assert.ok(err instanceof ValidationError);
  assert.equal(err.code, 'VALIDATION_FAILED');
  assert.equal(err.errors?.[0]?.pointer, '/identity');
  assert.equal(err.errors?.[0]?.code, 'VALIDATION_FAILED');
});

// errors.raw-body-limit: a 20 KiB HTML page (ASCII), and a page whose 8 KiB cut would fall inside a three-byte "€".
const PAGE_20K = '<!DOCTYPE html>' + 'x'.repeat(20480 - 15);
const PAGE_STRADDLE = 'a'.repeat(8191) + '€'.repeat(10);

test('[errors.raw-body-limit] rawBody keeps at most 8 KiB, cut on a character boundary, and says when it was cut', async () => {
  await faults({ status: { GetAgentVersion: [PAGE_20K, PAGE_STRADDLE].map((body) => ({ status: 404, contentType: 'text/html', body })) } });
  const c = client();
  const get = (version: string) => expectError(c.versions.get({ agentId: 'GHT7YRWXPL', version }));
  const page = await get('draft');
  assert.ok((page as unknown) instanceof NotFoundError);
  assert.equal(Buffer.byteLength(page.rawBody!), 8192);
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
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

test('[errors.connection] a connection closed before any response, and a refused connection, are the connection error', async () => {
  await faults({ status: { GetAgentVersion: [{ close: true }] } });
  const closed = await expectError(client({ maxAttempts: 1 }).versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }));
  const refused = await expectError(client({ maxAttempts: 1, endpoint: await refusedEndpoint() }).versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }));
  for (const err of [closed, refused]) {
    assert.ok(err instanceof CaitlynConnectionError, `${err.constructor.name}: ${err.message}`);
    assert.deepEqual([err.status, err.code, err.requestId, err.rawBody, err.rawBodyTruncated], [0, 'CONNECTION_ERROR', undefined, '', false]);
    assert.ok(err.cause instanceof Error, 'the network error is the cause');
    assert.match(err.message, /^GetAgentVersion: no response: /);
  }
  assert.equal((await api()).length, 1); // the closed connection was asked once; the refused one never arrived
});

test("[errors.unmodelled-status] a status the operation does not list is still that status's class", async () => {
  await faults({ status: { CreateUpload: [{ status: 404 }, { status: 405, body: '' }] } });
  const c = client();
  const reserve = () => expectError(c.uploads.reserve({ fileName: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' }));
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
  const err = await expectError(collect(client().documents.list({ knowledgeBaseId: 'KB4T7YQ2WL' })));
  assert.ok(err instanceof NotFoundError, `got ${err.name}`);
  assert.equal(err.status, 404);
  assert.equal(err.code, 'HTTP_404');
  assert.equal(err.requestId, undefined);
  assert.equal((err as Err).rawBody, HTML_404);
});

test('[errors.empty-405] a 405 with an empty body is the generic error, with status 405 and code HTTP_405', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 405, body: '' }] } });
  const err = await expectError(client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }));
  assert.equal(err.constructor, CaitlynError);
  assert.equal(err.status, 405);
  assert.equal(err.code, 'HTTP_405');
  assert.equal(err.requestId, undefined);
  assert.equal(err.rawBody, '');
});

test('[errors.text-502] a text/plain 502 is the generic error, with status 502, code HTTP_502 and the text, sent once', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }] } });
  const err = await expectError(client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }));
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
  const err = await expectError(client().uploads.reserve({ fileName: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' }));
  assert.ok(err instanceof ConflictError, `got ${err.name}`);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'CONFLICT');
  assert.equal(err.requestId, '01MISMATCHEDSTATUS0000000');
});

// ---------------------------------------------------------------- cancellation

test('[cancel.stream] cancelling a stream closes the connection and raises AbortError', async () => {
  await faults({ streamDelayMs: 150 });
  const controller = new AbortController();
  const stream = client().conversations.send('c-4', { message: 'hi' }, { signal: controller.signal });
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
  await assert.rejects(client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }, { signal: controller.signal }), (err: Error) => err.name === 'AbortError');
});

// ---------------------------------------------------------------- updates

test('[update.if-match] If-Match is sent from the call option and the new ETag comes back', async () => {
  const c = client();
  const draft = await c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  const updated = await c.versions.updateDraft('GHT7YRWXPL', { instructions: `${draft.configuration.instructions}\nAlways state the policy clause number.` }, { ifMatch: draft.etag });
  assert.notEqual(updated.etag, draft.etag);
  const patch = (await api()).find((r) => r.method === 'PATCH');
  assert.equal(patch.headers['if-match'], draft.etag);
  assert.deepEqual(JSON.parse(patch.body), { instructions: 'Answer from the HR policies.\nAlways state the policy clause number.' });
});

test('[update.clear] clear sends only the clear list, and the field is cleared', async () => {
  const c = client();
  const draft = await c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  const updated = await c.versions.updateDraft('GHT7YRWXPL', { clear: ['identity'] }, { ifMatch: draft.etag });
  const patch = (await api()).find((r) => r.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.body), { clear: ['identity'] });
  assert.equal(updated.configuration.identity, undefined);
  assert.equal(updated.configuration.instructions, 'Answer from the HR policies.');
});

// ---------------------------------------------------------------- wire and environment

test('[wire.headers] exactly the SDK headers: Caitlyn user agent, Caitlyn-Sdk-Model, no AWS headers', async () => {
  await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 0 }] } });
  await client({ telemetry: { enabled: false } }).versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  const sent = await api();
  assert.equal(sent.length, 2);
  for (const r of sent) {
    const aws = r.headerNames.filter((h: string) => /^(x-amz|amz-sdk|x-amzn)/.test(h));
    assert.deepEqual(aws, [], `AWS headers sent: ${aws.join(', ')}`);
    assert.match(r.headers['user-agent'], new RegExp(`^caitlyn-sdk-ts/${SDK_VERSION.replaceAll('.', '\\.')} lang/js md/nodejs#\\d+\\.\\d+\\.\\d+$`));
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
    const v = await client({ telemetry: { enabled: false } }).versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
    const docs = await collect(client({ telemetry: { enabled: false } }).documents.list({ knowledgeBaseId: 'KB4T7YQ2WL', limit: 3 }));
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

test('[since.fails-before-sending] an operation newer than the server fails before anything is sent', async () => {
  await faults({ apiVersion: '5.110.0' });
  const c = client();
  await c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }); // no check before the first response
  const before = (await api()).length;
  await assert.rejects(c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' }), (e: unknown) => {
    assert.ok(e instanceof NotSupportedByServer);
    assert.equal(e.requires, SDK_MODEL);
    assert.equal(e.server, '5.110.0');
    return true;
  });
  assert.equal((await api()).length, before);
});

test('[headers.request-id] Caitlyn-Request-Id and Caitlyn-Api-Version are on successful outputs', async () => {
  const v = await client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  assert.equal(v.requestId, (await api()).at(-1).requestId);
  assert.equal(v.$metadata.requestId, v.requestId);
  assert.equal(v.apiVersion, '5.120.0');
});

test("[headers.response-metadata] a successful call's response metadata gives its HTTP status and request id", async () => {
  const v = await client().versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
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
    await client({ telemetry: { tracerProvider: provider } }).versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
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
  await expectError(c.versions.get({ agentId: 'GHT7YRWXPL', version: 'nope' }));
  for await (const _ of c.documents.list({ knowledgeBaseId: 'KB4T7YQ2WL', limit: 100 })) void _;
  await c.uploads.create({ file: new Blob(['hello'], { type: 'text/plain' }), fileName: 'hello.txt' });
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
const read = (c: Caitlyn) => c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
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
  const redirect = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
  await c.auth.handleCallback({ code: redirect.searchParams.get('code')!, state: redirect.searchParams.get('state')!, expectedState: state, codeVerifier });
  return new URL(url);
}

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
  await c.versions.updateDraft('GHT7YRWXPL', { instructions: 'Cite clause numbers.' }, { ifMatch: v.etag! });
  const [get, patch] = await api();
  assert.equal(get.headers.authorization, undefined);
  assert.equal(get.headers.cookie, MOCK_SESSION_COOKIE);
  assert.equal(get.headers.origin, undefined);
  assert.equal(patch.headers.origin, 'https://caitlyn.lndo.site');
  assert.equal(patch.headers.authorization, undefined);
  assert.equal((await tokenRequests()).length, 0);
});

// ---------------------------------------------------------------- the model's @examples

/** Every member of `expected` is in `actual` with the same value; timestamps compare as instants. */
function assertSubset(expected: unknown, actual: unknown, at = 'output'): void {
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

for (const ex of EXAMPLES) {
  test(`[example] ${ex.id}`, async () => {
    await fetch(`${BASE}/__mock/example`, { method: 'POST', body: JSON.stringify({ id: ex.id }) });
    const Command = (commands as unknown as Record<string, new (input: unknown) => any>)[`${ex.operation}Command`];
    assert.ok(Command, `no ${ex.operation}Command`);
    const c = client();
    let output: any;
    let error: unknown;
    try {
      output = await c.client.send(new Command(ex.input));
      if (ex.response.stream) for await (const _ of output.events as AsyncIterable<Uint8Array>) void _;
    } catch (err) {
      error = err;
    }
    const result = await (await fetch(`${BASE}/__mock/example`)).json();
    assert.ok(result.served, 'the SDK sent no request');
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
      if (ex.expected.output) assertSubset(ex.expected.output, output);
    }
  });
}
