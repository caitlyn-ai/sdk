// A client can take its own HTTP handler (a private certificate authority, a proxy), as the Python, Go and Rust
// clients can take their own HTTP client. The handler is the client's alone: another client keeps the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResponse, type HttpRequest } from '@smithy/core/protocols';
import { Caitlyn } from '@caitlyn-ai/sdk';

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
  const v = await c.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
  assert.equal(v.name, 'draft');
  assert.equal(v.requestId, 'R1');
  assert.deepEqual(seen, ['GET https://your-company.getcaitlyn.ai/api/v3/agents/GHT7YRWXPL/versions/draft']);
  const other = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 'cait-pat-test' } });
  assert.notEqual(other.client.config.requestHandler, c.client.config.requestHandler);
});
