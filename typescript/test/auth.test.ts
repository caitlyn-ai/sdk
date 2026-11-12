// Sign-in behaviour every SDK shares is tested by the conformance cases (conformance/cases/protocol.json,
// PROTOCOL.md section 12). What stays here is the TypeScript API that reports it: `client.auth` and
// `client.client.config`, which no other language has in this shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Caitlyn } from '@caitlyn-ai/sdk';

const RESOURCE = 'https://your-company.getcaitlyn.ai/api';

test('client.auth reports the workspace, the token audience and the token endpoint', () => {
  const plain = new Caitlyn({ workspace: 'https://your-company.getcaitlyn.ai/', auth: { mode: 'token', token: 'pat_test' } });
  assert.equal(plain.auth.workspace, 'your-company.getcaitlyn.ai');
  assert.equal(plain.auth.resource, RESOURCE);
  assert.equal(plain.auth.tokenEndpoint, 'https://your-company.getcaitlyn.ai/api/oauth/token');
  assert.equal(plain.auth.authorizationEndpoint, 'https://your-company.getcaitlyn.ai/api/oauth/authorize');
  assert.equal((plain.client.config as { workspace?: string }).workspace, 'your-company.getcaitlyn.ai');
});

test('an endpoint override moves the token endpoint but not the audience', () => {
  const proxied = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', endpoint: 'http://127.0.0.1:3000/api/', auth: { mode: 'token', token: 'pat_test' } });
  assert.equal(proxied.auth.resource, RESOURCE);
  assert.equal(proxied.auth.tokenEndpoint, 'http://127.0.0.1:3000/api/oauth/token');
});

test('a resource option, where a mode offers one, replaces the workspace audience', () => {
  const c = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'clientCredentials', clientId: 'c', clientSecret: 's', resource: 'https://other.example/api' } });
  assert.equal(c.auth.resource, 'https://other.example/api');
});
