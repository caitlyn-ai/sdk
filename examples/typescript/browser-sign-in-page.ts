// Signing in from a browser, pattern 2: a browser-only app, registered as a public API client. The page signs
// in with the authorisation code flow and PKCE, holds its tokens in memory, and calls Caitlyn directly from an
// origin registered on its API client. docs/guides/sign-in-from-a-browser.md shows the regions marked below.
import { Caitlyn, CaitlynAuthError } from '@caitlyn-ai/sdk';

// #region client
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
// #endregion

// #region sign-in
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
// #endregion

// #region call
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
// #endregion
