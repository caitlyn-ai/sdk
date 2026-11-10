// TypeScript conformance harness: the protocol cases in conformance/cases/protocol.json and the example
// cases in conformance/cases/examples.json, against the mock server. Test names start with the case id in
// square brackets; scripts/check-conformance.mjs checks that every case ran and passed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Caitlyn,
  CaitlynError,
  ConflictError,
  NotFoundError,
  NotSupportedByServer,
  PreconditionFailedError,
  ServiceUnavailableError,
  ValidationError,
  type CaitlynErrorFields,
} from '@caitlyn-ai/sdk';
import * as commands from '@caitlyn-ai/sdk/commands';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const ROOT = process.env.CAITLYN_REPO_ROOT ?? path.resolve(import.meta.dirname, '../..');
const EXAMPLES: ExampleCase[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'conformance/cases/examples.json'), 'utf8')).cases;
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
    assert.match(r.headers['user-agent'], /^caitlyn-sdk-ts\/0\.0\.1 lang\/js md\/nodejs#\d+\.\d+\.\d+$/);
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
  assert.equal((v as unknown as { $metadata: { requestId?: string } }).$metadata.requestId, v.requestId);
  assert.equal(v.apiVersion, '5.120.0');
});

test('[telemetry.spans] one span per call, one child span per attempt, traceparent sent', async () => {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  try {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    await faults({ status: { GetAgentVersion: [{ status: 503, retryAfter: 0 }] } });
    await client({ telemetry: { tracerProvider: provider } }).versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
    const spans = exporter.getFinishedSpans();
    const call = spans.find((s) => s.name === 'caitlyn GetAgentVersion');
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

test('[endpoint.workspace] a workspace hostname resolves to https://<workspace>/api', async () => {
  const c = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'pat_test' } });
  const endpoint = await (c.client.config as unknown as { endpoint: () => Promise<{ protocol: string; hostname: string; path: string }> }).endpoint();
  assert.equal(`${endpoint.protocol}//${endpoint.hostname}${endpoint.path}`, 'https://your-company.getcaitlyn.ai/api');
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
