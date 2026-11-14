---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations: []
operations: []
---

# Sign in from a browser

Anyone can read the code a browser runs, and any script that runs on your page can read what that code holds.
So a browser app never holds a client secret or a long-lived token. There are two ways for a web app to call
Caitlyn as the person using it:

1. **Sign in on your server** (recommended for production). Your server signs the person in, keeps their
   Caitlyn tokens and makes the calls. The browser has only your app's own session cookie. This is the
   "backend for frontend" pattern in the IETF guidance on OAuth for browser-based apps.
2. **A browser-only app.** The page signs in itself with the authorisation code flow and PKCE, holds its
   tokens in memory and calls Caitlyn directly.

Both use the SDK's `oauth` mode. Personal access tokens (`token` mode) are for scripts and local testing,
never for a page other people use.

> **Not available yet.** Caitlyn workspaces do not accept browser API clients or cross-origin calls to the v3 API
> yet, so a browser-only app (pattern 2) cannot reach a workspace. This page describes how it works.

## Which pattern to use

|  | Sign in on your server | A browser-only app |
| --- | --- | --- |
| Use it when | You have a server, or serverless functions, in front of your page | You have no server: a static site, a prototype, an internal tool |
| Where the tokens are | Encrypted in your server's store | In the page's memory |
| What a malicious script on your page can do | Call your server's routes while the page is open | Read the tokens and use them elsewhere until they expire |
| After a reload | Still signed in | Signs in again |
| API client | A web API client, with a client secret | A browser API client, with no secret, and your page's origin registered |
| Cross-origin calls to Caitlyn | None: the browser calls your own server | Yes, from your registered origin |

Choose pattern 1 unless you have no server. Pattern 2 is a reasonable choice for a tool used by a few people
who already have Caitlyn accounts, and a poor one for a public product.

## Pattern 1: sign in on your server

1. The browser asks your server to sign in (`/caitlyn/sign-in`). Your server builds the Caitlyn sign-in URL,
   keeps the state and PKCE verifier in your app's session, and redirects the browser to Caitlyn.
2. The person signs in to Caitlyn, and Caitlyn redirects the browser back to your server's callback with a
   code. Your server exchanges the code, with its client secret, for an access token and a refresh token, and
   saves them, encrypted, against the person.
3. From then on, the browser calls your server's routes with your session cookie, and your server calls
   Caitlyn with the person's access token, refreshing it when it is due.

**Register** a web API client (see [Registering the API client](#registering-the-api-client)) with your
server's callback URL as its redirect URI. It has a client secret and no allowed origins, because the browser
never calls Caitlyn. Keep the secret in your server's secret store.

A client per person, with a token store that encrypts their tokens on your server:

<!-- example: examples/typescript/browser-sign-in-server.ts#client -->
```ts
// Your app's own session, from an HttpOnly, Secure, SameSite=Lax cookie. It never holds Caitlyn tokens.
interface AppSession {
  userId: string;
  caitlynSignIn?: { state: string; codeVerifier: string };
}
declare function getSession(request: Request): Promise<AppSession>;
declare function saveSession(session: AppSession): Promise<void>;

// A table on your server, and encryption under a key only your server can use (a KMS key, for example).
declare const tokenTable: {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
};
declare function encrypt(plaintext: string): Promise<Uint8Array>;
declare function decrypt(ciphertext: Uint8Array): Promise<string>;

/** One person's Caitlyn tokens, encrypted at rest. The SDK saves each new refresh token here. */
function tokenStoreFor(userId: string): TokenStore {
  const key = `caitlyn-tokens:${userId}`;
  return {
    async load() {
      const sealed = await tokenTable.get(key);
      return sealed ? (JSON.parse(await decrypt(sealed)) as OAuthTokens) : undefined;
    },
    async save(tokens) {
      await tokenTable.put(key, await encrypt(JSON.stringify(tokens)));
    },
    async clear() {
      await tokenTable.delete(key);
    },
  };
}

// One client per person in each server process, so a refresh is one request however many calls need it.
const clients = new Map<string, Caitlyn>();

function caitlynFor(userId: string): Caitlyn {
  let client = clients.get(userId);
  if (!client) {
    client = new Caitlyn({
      workspace: 'your-company.getcaitlyn.ai',
      auth: {
        mode: 'oauth',
        clientId: process.env.CAITLYN_CLIENT_ID!,
        clientSecret: process.env.CAITLYN_CLIENT_SECRET!, // only ever on your server
        redirectUri: 'https://app.example.com/caitlyn/callback',
        scopes: ['api:write'],
        tokenStore: tokenStoreFor(userId),
      },
    });
    clients.set(userId, client);
  }
  return client;
}
```

The routes. They take and return web-standard `Request` and `Response` objects, as Next.js route handlers,
Hono, Remix and Bun do:

<!-- example: examples/typescript/browser-sign-in-server.ts#routes -->
```ts
// GET /caitlyn/sign-in: send the person to Caitlyn
export async function signIn(request: Request): Promise<Response> {
  const session = await getSession(request);
  const { url, state, codeVerifier } = await caitlynFor(session.userId).auth.authorizationUrl();
  session.caitlynSignIn = { state, codeVerifier };
  await saveSession(session);
  return Response.redirect(url, 302);
}

// GET /caitlyn/callback: Caitlyn sends the person back here with a code
export async function callback(request: Request): Promise<Response> {
  const session = await getSession(request);
  const pending = session.caitlynSignIn;
  session.caitlynSignIn = undefined; // the state and verifier are good for one attempt only
  await saveSession(session);

  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  if (!pending || !code) return new Response('Sign-in was cancelled or failed.', { status: 400 });
  await caitlynFor(session.userId).auth.handleCallback({
    code,
    state: params.get('state') ?? undefined,
    expectedState: pending.state, // a different state fails with invalid_state before any request
    codeVerifier: pending.codeVerifier,
  });
  return Response.redirect(new URL('/', request.url), 303);
}

// POST /api/ask: the browser calls your server, and your server calls Caitlyn
export async function ask(request: Request): Promise<Response> {
  const session = await getSession(request);
  const { conversationId, message } = (await request.json()) as { conversationId: string; message: string };
  try {
    const answer = await caitlynFor(session.userId).conversations.send(conversationId, { message }).finalMessage();
    return Response.json({ text: answer.text });
  } catch (err) {
    // Not signed in to Caitlyn yet, or the refresh token was refused: ask the browser to sign in again
    if (err instanceof CaitlynAuthError && (err.code === 'sign_in_required' || err.code === 'invalid_grant')) {
      return Response.json({ signIn: '/caitlyn/sign-in' }, { status: 401 });
    }
    throw err;
  }
}

// POST /caitlyn/sign-out: revoke the refresh token and delete the stored tokens
export async function signOut(request: Request): Promise<Response> {
  const session = await getSession(request);
  await caitlynFor(session.userId).auth.signOut();
  clients.delete(session.userId);
  return new Response(null, { status: 204 });
}
```

- **Your session cookie** carries only your app's session ID: `HttpOnly`, `Secure` and `SameSite=Lax`. Caitlyn
  tokens never go into it, or into anything else the browser receives.
- **Protect your routes against cross-site requests.** Your `/api/` routes act with the person's Caitlyn
  access, so accept them only from your own pages: `SameSite` cookies, and a check of the `Origin` header on
  every request that changes something.
- **One client per person in each server process**, as `caitlynFor` does, so that one refresh serves every
  call waiting for it. Refresh tokens are single use: each refresh returns a new one, which the SDK saves to
  the store, and the old one stops working. The SDK loads the store before it refreshes, so a process that
  finds tokens another process has just refreshed uses those.
- **Signing out** revokes the refresh token at Caitlyn and deletes the stored tokens.

## Pattern 2: a browser-only app

1. The page builds the Caitlyn sign-in URL, keeps the one-time state and PKCE verifier in `sessionStorage`
   (the page unloads when the browser leaves for Caitlyn), and sends the browser to Caitlyn.
2. Caitlyn redirects the browser back to your callback page with a code. The page exchanges it for tokens,
   with the PKCE verifier and no secret, and the SDK keeps them in memory.
3. The page calls Caitlyn directly. Caitlyn answers because the page's origin is registered on the API
   client.

**Register** a browser API client (see [Registering the API client](#registering-the-api-client)) with:

- your page's origin in `allowedOrigins`: scheme, host and port exactly, such as `https://tools.example.com`
  or `http://localhost:5173`;
- your callback page's URL in `redirectUris`, exactly as the page sends it, on one of those origins.

Caitlyn returns a `clientId`, which the page uses. A browser API client is always public: it has no secret.

The client. With no token store, the SDK keeps tokens in memory:

<!-- example: examples/typescript/browser-sign-in-page.ts#client -->
```ts
// No client secret: a public client. Tokens stay in this page's memory (the default when there is no token
// store), so a reload signs in again.
const caitlyn = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: {
    mode: 'oauth',
    clientId: 'your-public-client-id', // an identifier, not a secret
    redirectUri: `${location.origin}/callback`, // registered on the API client exactly as written here
    scopes: ['api:write'],
  },
});
```

Signing in, and the callback page:

<!-- example: examples/typescript/browser-sign-in-page.ts#sign-in -->
```ts
const PENDING = 'caitlyn.sign-in';

/** Sends the person to Caitlyn to sign in. */
export async function signIn(): Promise<void> {
  const { url, state, codeVerifier } = await caitlyn.auth.authorizationUrl();
  // The page is about to unload, so keep the one-time state and PKCE verifier for the callback. They are not
  // tokens; sessionStorage keeps them for this tab only, and the callback deletes them.
  sessionStorage.setItem(PENDING, JSON.stringify({ state, codeVerifier }));
  location.assign(url);
}

/** On the /callback page: exchanges the code for tokens, which the client keeps in memory. */
export async function finishSignIn(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as { state: string; codeVerifier: string } | null;
  sessionStorage.removeItem(PENDING);
  history.replaceState(null, '', '/'); // take the code out of the address bar and the history

  const code = params.get('code');
  if (!pending || !code) throw new Error(params.get('error_description') ?? 'Sign-in was cancelled or failed.');
  await caitlyn.auth.handleCallback({
    code,
    state: params.get('state') ?? undefined,
    expectedState: pending.state, // a different state fails with invalid_state before any request
    codeVerifier: pending.codeVerifier,
  });
}
```

A call. The answer streams into the page:

<!-- example: examples/typescript/browser-sign-in-page.ts#call -->
```ts
/** Asks a question in a conversation and streams the answer into the page. */
export async function ask(conversationId: string, message: string, output: HTMLElement): Promise<void> {
  try {
    for await (const event of caitlyn.conversations.send(conversationId, { message })) {
      if (event.type === 'text.delta') output.append(event.delta);
    }
  } catch (err) {
    // Not signed in (after a reload, for example), or the refresh token was refused: sign in again
    if (err instanceof CaitlynAuthError && (err.code === 'sign_in_required' || err.code === 'invalid_grant')) return signIn();
    throw err;
  }
}

/** Revokes the refresh token and forgets the tokens. */
export async function signOut(): Promise<void> {
  await caitlyn.auth.signOut();
}
```

- **Tokens live in memory.** An access token lasts an hour, and the SDK refreshes it a minute before it
  expires. Refresh tokens are single use: each refresh returns a new one and the old one stops working. A
  reload, or a new tab, starts with no tokens, so the first call fails with `sign_in_required` and the page
  signs in again. If that round trip is not acceptable, use pattern 1 rather than storing tokens.
- **Only the state and verifier go in `sessionStorage`**, for the few seconds of the redirect. They are no use
  without the code Caitlyn sends to your registered redirect URI, and the callback deletes them.
- **Take the code out of the address bar**, as `finishSignIn` does with `history.replaceState`, so it is not
  left in the history.
- **Keep scripts you do not control off the page.** In this pattern a script injected into your page can read
  the tokens. A strict Content Security Policy and few third-party scripts matter more here than anywhere else.

## Registering the API client

| Setting | Sign in on your server | A browser-only app |
| --- | --- | --- |
| Register | A web API client: confidential, with a client secret; PKCE (S256) is required too | A browser API client: public, with no secret; PKCE (S256) is required |
| Redirect URIs | Your server's callback, for example `https://app.example.com/caitlyn/callback` | Your callback page, for example `https://tools.example.com/callback` |
| Allowed origins | None | Your page's origin, for example `https://tools.example.com` |
| Scopes | What your server's routes need, for example `api:read` | What the page needs, for example `api:write` |

Both kinds are registered by someone signed in to the workspace with permission to create API clients, with
a `POST` from the workspace's own pages; there is no form in the admin screens yet. They can grant only scopes
whose permissions they hold themselves (otherwise 403). List clients with
`GET /api/v2/api-clients?surface=api`, and revoke one with `DELETE /api/v2/api-clients/{clientId}`.

**A web API client** (sign in on your server): `POST /api/v2/api-clients/web`.

```json
{
  "clientName": "Policy portal",
  "scopes": ["api:read"],
  "redirectUris": ["https://app.example.com/caitlyn/callback"],
  "expiresAt": "2027-11-12T00:00:00Z"
}
```

| Field | Rules |
| --- | --- |
| `clientName` | Up to 120 characters |
| `scopes` | The `api:` scopes your server needs |
| `redirectUris` | 1 to 10, matched exactly. `https`, or `http` only on `localhost`, `127.0.0.1` or `[::1]`; no wildcards, fragments or user information |
| `expiresAt` | Required: when the client secret stops working. Capped, as machine client secrets are |

The response has the `clientId` and the `clientSecret`, shown once (Caitlyn keeps only a hash), and when the
secret expires. The secret is needed on every code exchange and refresh, and refused once it has expired.
Before then, issue a new one with `POST /api/v2/api-clients/{clientId}/rotate` and a new `expiresAt`; the old
secret stops working at once, so update your server's secret store in the same step. Such a client can only
sign people in and act for them: it cannot use client credentials, and every cross-origin request for it is
refused.

**A browser API client** (a browser-only app): `POST /api/v2/api-clients/browser`.

```json
{
  "clientName": "Policy lookup tool",
  "scopes": ["api:write"],
  "allowedOrigins": ["https://tools.example.com", "http://localhost:5173"],
  "redirectUris": ["https://tools.example.com/callback", "http://localhost:5173/callback"]
}
```

| Field | Rules |
| --- | --- |
| `clientName` | Up to 120 characters |
| `scopes` | The `api:` scopes the page needs |
| `allowedOrigins` | 1 to 10, each exactly `scheme://host[:port]`, with no path or wildcard. `https`, or `http` only on `localhost`, `127.0.0.1` or `[::1]`. A trailing slash and capitals are normalised |
| `redirectUris` | 1 to 10, matched exactly, each on one of `allowedOrigins`. The same `https` rule; no wildcards, fragments or user information |

The response has the `clientId`, and no secret. Such a client can only sign people in (authorisation code
with PKCE, then refresh tokens), and the sign-in must ask for the workspace's API,
`resource=https://<workspace>/api`, which the SDK does. To change its origins or redirect URIs, register a
new client and revoke the old one with `DELETE /api/v2/api-clients/{clientId}`. List every environment's
origins (`localhost`, staging, production) on the client that serves it, or register one client per
environment.

## How Caitlyn treats cross-origin calls

- **Only registered origins, and only v3.** Caitlyn answers a cross-origin request to `/api/v3/` or to the
  token endpoint only from an origin registered on a browser API client; a cross-origin call to any other part
  of the API is refused. The preflight (`OPTIONS`) passes only for such an
  origin, a v3 call only when the origin is on the client its token was issued to, and a token request only
  when it is on the client named by `client_id`, checked before the code or refresh token is used.
- **Everything else is refused, invisibly.** A refused origin gets a 403 with no cross-origin headers, so the
  browser blocks it and the page cannot read even the error: you see a CORS error in the browser console. A
  401 to a registered origin does carry them, so the SDK can read it and refresh.
- **Never cookies.** Caitlyn never allows credentials or `*` on a cross-origin response, so a page on another
  origin can never act with a person's Caitlyn session. A browser-only app sends its access token in the
  `Authorization` header.
- **Headers the page can read:** `Caitlyn-Request-Id`, `Caitlyn-Api-Version`, `Caitlyn-Idempotency-Replayed`,
  `ETag`, `Retry-After` and `Location`.
- **One workspace.** Every token's audience is the workspace's API, `https://<workspace>/api`, which
  the SDK sends as `resource` when it signs in; another workspace refuses it.
- **Later.** Sender-bound tokens (DPoP), which would make a stolen browser token useless on another machine,
  are planned for browser clients and not available yet.

## What the SDK refuses in a browser

The TypeScript SDK checks where it is running, and refuses to hold a secret in a browser.

| Sign-in | In a browser |
| --- | --- |
| `oauth` without `clientSecret` (pattern 2) | Allowed |
| `oauth` with `clientSecret` | Refused |
| `clientCredentials` | Refused |
| `awsIam` | Refused |
| `workloadIdentity` | Refused |
| `token` (a personal access token) | Allowed with a warning, for local testing |
| `session` | Allowed: the Caitlyn app's own pages |

- **A refusal is immediate.** Creating the client (`new Caitlyn(...)`, `createCaitlynClient(...)` or
  `createAuth(...)`) throws `CaitlynAuthError` with code `not_allowed_in_browser`, before any request, so the
  mistake shows up the first time the page loads rather than at the first call. For a secret, the message
  reads: "clientCredentials cannot be used in a browser: a client secret in a browser is visible to everyone
  who loads the page. Use oauth without a clientSecret (authorisation code with PKCE), or sign in on your
  server." For `awsIam` and `workloadIdentity`, it says the mode signs in a server workload with that
  workload's own identity, and to use `oauth` in a browser.
- **The `token` warning** is one `console.warn` per client, when it is created: "Caitlyn: a long-lived token
  in a browser is exposed to anyone who can run script on the page. token mode in a browser is for local
  testing; use oauth instead. Set auth.allowBrowserToken: true to silence this warning." To silence it while
  you test locally, set it on the mode: `auth: { mode: 'token', token, allowBrowserToken: true }`.
- **A browser** is anywhere with both `window` and `document`. Node, Deno, Bun and web, service and shared
  workers are not browsers, so the same options are fine on a server and pattern 1's code is unaffected. A test
  environment with a simulated DOM (jsdom, happy-dom) counts as a browser: create server-side clients in tests
  that run without one.

## What never to do

- Put a client secret, a personal access token or any other long-lived credential in browser code, a
  JavaScript bundle or a page's HTML. Bundles are public, whatever the build tool's environment variables
  suggest.
- Keep tokens in `localStorage`, `sessionStorage` or IndexedDB. Any script on your origin can read them, and
  they outlive the page. (The one-time state and PKCE verifier in pattern 2 are not tokens.)
- Send Caitlyn tokens to the browser from a pattern 1 server, in a response, a cookie or the page.
- Share one API client between different apps, or list origins you do not control on it.
- Turn on `allowBrowserToken` in anything other than your own local testing.
