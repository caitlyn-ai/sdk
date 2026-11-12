// The TypeScript SDK's browser guard (PROTOCOL.md section 12.6): in a browser page, the sign-in modes whose
// credential every visitor could read, or that only work on a server, are refused when the client is created, and
// token mode warns. A browser is simulated with a `window` and a `document` on globalThis.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Caitlyn, CaitlynAuthError, createAuth, createCaitlynClient, type AuthOptions } from '@caitlyn-ai/sdk';

const g = globalThis as { window?: unknown; document?: unknown };
const workspace = 'your-company.getcaitlyn.ai';
const browser = () => Object.assign(g, { window: {}, document: {} });
afterEach(() => {
  delete g.window;
  delete g.document;
});

/** Runs `fn` and returns what it passed to console.warn. */
function warnings(fn: () => void): string[] {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

const refused: [string, AuthOptions, RegExp][] = [
  ['clientCredentials', { mode: 'clientCredentials', clientId: 'c', clientSecret: 's' }, /client secret in a browser is visible to everyone/],
  ['oauth with a clientSecret', { mode: 'oauth', clientId: 'c', clientSecret: 's', redirectUri: 'https://app.example.com/cb' }, /client secret in a browser is visible to everyone/],
  ['awsIam', { mode: 'awsIam', region: 'ap-southeast-2' }, /awsIam cannot be used in a browser/],
  ['workloadIdentity', { mode: 'workloadIdentity', token: () => 'jwt' }, /workloadIdentity cannot be used in a browser/],
];

for (const [name, auth, message] of refused) {
  test(`in a browser, ${name} is refused when the client is created`, () => {
    browser();
    for (const create of [() => new Caitlyn({ workspace, auth }), () => createCaitlynClient({ workspace, auth }), () => createAuth({ workspace, auth })]) {
      assert.throws(create, (e: unknown) => e instanceof CaitlynAuthError && e.code === 'not_allowed_in_browser' && message.test(e.message));
    }
  });
}

test('the secret message names the alternatives: oauth without a secret (PKCE), or signing in on a server', () => {
  browser();
  assert.throws(() => new Caitlyn({ workspace, auth: { mode: 'clientCredentials', clientId: 'c', clientSecret: 's' } }), /oauth without a clientSecret \(authorisation code with PKCE\), or sign in on your server/);
});

test('in a browser, token mode warns once per client, and allowBrowserToken silences it', () => {
  browser();
  const once = warnings(() => {
    const c = new Caitlyn({ workspace, auth: { mode: 'token', token: 't' } });
    void c.versions; // using the client warns no more
  });
  assert.equal(once.length, 1);
  assert.match(once[0], /long-lived token in a browser is exposed/);
  assert.match(once[0], /local testing; use oauth instead/);
  assert.equal(warnings(() => [new Caitlyn({ workspace, auth: { mode: 'token', token: 't' } }), new Caitlyn({ workspace, auth: { mode: 'token', token: 't' } })]).length, 2, 'one per client');
  assert.deepEqual(warnings(() => new Caitlyn({ workspace, auth: { mode: 'token', token: 't', allowBrowserToken: true } })), []);
});

test('in a browser, session mode and oauth without a secret are unaffected', () => {
  browser();
  assert.deepEqual(
    warnings(() => {
      new Caitlyn({ workspace, auth: { mode: 'session' } });
      new Caitlyn({ workspace, auth: { mode: 'oauth', clientId: 'c', redirectUri: 'https://app.example.com/cb' } });
    }),
    [],
  );
});

test('outside a browser nothing is refused or warned: no document (Node, Deno, Bun), or no window (workers)', () => {
  const every: AuthOptions[] = [{ mode: 'token', token: 't' }, ...refused.map(([, auth]) => auth)];
  for (const globals of [{}, { window: {} }, { document: {} }]) {
    Object.assign(g, globals);
    assert.deepEqual(warnings(() => every.forEach((auth) => new Caitlyn({ workspace, auth }))), [], JSON.stringify(globals));
    delete g.window;
    delete g.document;
  }
});
