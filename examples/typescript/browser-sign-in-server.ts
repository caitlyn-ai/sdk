// Signing in from a browser, pattern 1 (recommended): sign in on your server, the "backend for frontend"
// pattern. Your server is a confidential API client and keeps each person's Caitlyn tokens, encrypted, in its
// own store. The browser has only your app's own session cookie and calls your server, which calls Caitlyn.
// The handlers take and return web-standard Request and Response objects, as Next.js route handlers, Hono,
// Remix and Bun do. docs/guides/sign-in-from-a-browser.md shows the regions marked below.
import { Caitlyn, CaitlynAuthError, type OAuthTokens, type TokenStore } from '@caitlyn-ai/sdk';

// #region client
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
// #endregion

// #region routes
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
// #endregion
