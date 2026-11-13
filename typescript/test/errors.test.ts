// CaitlynError, the base class of every Caitlyn error, is typed with the fields every error carries (PROTOCOL.md
// 6.3), so generic handling reads them without a cast. The type checks are compile-time (this file is type-checked
// strictly with the rest of the workspace); the tests check the same fields hold the values at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResponse, type HttpRequest } from '@smithy/core/protocols';
import { Caitlyn, CaitlynError, NotFoundError, ValidationError } from '@caitlyn-ai/sdk';

/** A client whose every call is answered with this status, headers and body. */
const answering = (statusCode: number, body: string, headers: Record<string, string> = {}) =>
  new Caitlyn({
    workspace: 'your-company.getcaitlyn.ai',
    auth: { mode: 'token', token: 'cait-pat-test' },
    maxAttempts: 1,
    requestHandler: { handle: async (_: HttpRequest) => ({ response: new HttpResponse({ statusCode, headers, body: new TextEncoder().encode(body) }) }) },
  });

/** What generic error handling reads: no cast, and the field types as declared. */
function describe(e: unknown): { status: number; code: string; requestId: string | undefined; title: string | undefined; pointer: string | undefined; rawBody: string | undefined } | undefined {
  if (!(e instanceof CaitlynError)) return undefined;
  return { status: e.status, code: e.code, requestId: e.requestId, title: e.title, pointer: e.errors?.[0]?.pointer, rawBody: e.rawBody };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail('expected an error');
}

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: `https://build.caitlyn.ai/errors/${code}`, title: 'Problem', status, code, requestId: 'R1', ...extra });

test('a typed error read through CaitlynError: status, code, requestId, title', async () => {
  const e = await caught(answering(404, problem(404, 'NOT_FOUND'), { 'content-type': 'application/problem+json' }).versions.get({ agentId: 'A', version: 'draft' }));
  assert.ok(e instanceof NotFoundError);
  assert.deepEqual(describe(e), { status: 404, code: 'NOT_FOUND', requestId: 'R1', title: 'Problem', pointer: undefined, rawBody: problem(404, 'NOT_FOUND') });
});

test('field errors on a 400 are typed through CaitlynError', async () => {
  const body = problem(400, 'VALIDATION_FAILED', { errors: [{ pointer: '/identity', code: 'VALIDATION_FAILED' }] });
  const e = await caught(answering(400, body, { 'content-type': 'application/problem+json' }).versions.get({ agentId: 'A', version: 'draft' }));
  assert.ok(e instanceof ValidationError);
  assert.equal(describe(e)?.pointer, '/identity');
});

test('the generic error for a status the model does not name is a CaitlynError with its fields', async () => {
  const e = await caught(answering(502, 'Bad Gateway', { 'content-type': 'text/plain' }).versions.get({ agentId: 'A', version: 'draft' }));
  assert.ok(e instanceof CaitlynError);
  assert.deepEqual(describe(e), { status: 502, code: 'HTTP_502', requestId: undefined, title: undefined, pointer: undefined, rawBody: 'Bad Gateway' });
});

test('anything else is not a CaitlynError', () => {
  assert.equal(describe(new Error('x')), undefined);
});
