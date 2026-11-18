// A client can take its own HTTP handler (a private certificate authority, a proxy), as the Python, Go and Rust
// clients can take their own HTTP client. The handler is the client's alone: another client keeps the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResponse, type HttpRequest } from '@smithy/core/protocols';
import { Caitlyn } from '@caitlyn-ai/sdk';

/** node:events' getEventListeners, which this @types/node does not declare for an EventTarget. */
const abortListeners = async () => ((await import('node:events')) as unknown as { getEventListeners(target: EventTarget, type: string): unknown[] }).getEventListeners;

const VERSION = { agentId: 'GHT7YRWXPL', name: 'draft', createdAt: '2026-11-03T22:14:05.120Z', configuration: {} };

test('requestHandler: API calls go through the handler the client was given', async () => {
  const seen: string[] = [];
  const handler = {
    async handle(request: HttpRequest) {
      seen.push(`${request.method} ${request.protocol}//${request.hostname}${request.path}`);
      const body = new TextEncoder().encode(JSON.stringify(VERSION));
      return { response: new HttpResponse({ statusCode: 200, headers: { 'content-type': 'application/json', 'caitlyn-request-id': 'R1', etag: '"draft-1"' }, body }) };
    },
  };
  const c = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'cait-pat-test' }, requestHandler: handler });
  const v = await c.agents('GHT7YRWXPL').draft.get();
  assert.equal(v.name, 'draft');
  assert.equal(v.$metadata.requestId, 'R1');
  assert.deepEqual(seen, ['GET https://your-company.getcaitlyn.ai/api/v3/agents/GHT7YRWXPL/versions/draft']);
  const other = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'cait-pat-test' } });
  assert.notEqual(other.client.config.requestHandler, c.client.config.requestHandler);
});

test('requestHandler: the default fetch handler takes customFetch, which Node clients use for an undici dispatcher', async () => {
  const seen: string[] = [];
  const customFetch = async (request: Request) => {
    seen.push(`${request.method} ${request.url} ${request.headers.get('authorization')}`);
    return new Response(JSON.stringify(VERSION), { status: 200, headers: { 'content-type': 'application/json', 'caitlyn-request-id': 'R2' } });
  };
  const c = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'cait-pat-test' }, requestHandler: { customFetch } as never });
  const v = await c.agents('GHT7YRWXPL').draft.get();
  assert.equal(v.$metadata.requestId, 'R2');
  assert.deepEqual(seen, ['GET https://your-company.getcaitlyn.ai/api/v3/agents/GHT7YRWXPL/versions/draft Bearer cait-pat-test']);
});

test('requestHandler: a signal reused for many calls keeps no listener from the calls that have finished', async () => {
  const getEventListeners = await abortListeners();
  let n = 0;
  const customFetch = async () => {
    n++;
    if (n % 5 === 0) throw new TypeError('fetch failed');
    if (n % 3 === 0) return new Response(JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND' }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
    return new Response(JSON.stringify(VERSION), { status: 200, headers: { 'content-type': 'application/json', 'caitlyn-request-id': `R${n}` } });
  };
  const c = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'cait-pat-test' }, requestHandler: { customFetch } as never, maxAttempts: 1 });
  const controller = new AbortController();
  for (let i = 0; i < 30; i++) await c.agents('GHT7YRWXPL').draft.get({ signal: controller.signal }).catch(() => undefined);
  assert.equal(n, 30, 'every call reached fetch');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('requestHandler: a signal reused for many watches keeps no listener from the watches that have been left', async () => {
  const getEventListeners = await abortListeners();
  const frame = (n: number) => `id: m-1:${n}\nevent: text.delta\ndata: ${JSON.stringify({ delta: `part ${n}` })}\n\n`;
  const customFetch = async () =>
    new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode('retry: 2000\n\n' + frame(1) + frame(2))); } }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'caitlyn-request-id': 'RW' },
    });
  const c = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'cait-pat-test' }, requestHandler: { customFetch } as never });
  const controller = new AbortController();
  for (let i = 0; i < 15; i++) {
    for await (const event of c.conversations('c-w').watch({}, { signal: controller.signal })) {
      assert.equal(event.type, 'text.delta');
      break;
    }
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
