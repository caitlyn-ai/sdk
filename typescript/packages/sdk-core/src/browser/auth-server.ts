// The browser build's stand-in for ../auth-server.ts. A browser may sign in only with oauth without a client
// secret, session, or token (PROTOCOL.md 12.6), so the code of the other modes is left out of this build, and a
// client created with one is refused at once, in a page or a worker, with the same error the Node build gives a
// page.
import type { AuthOptions, OAuthTokens } from '../auth.js';
import { CaitlynAuthError, isBrowser } from '../auth-base.js';
import type { SignIn } from '../auth-server.js';

export type { SignIn };

const IN_BROWSER = 'not_allowed_in_browser';

export function guardBrowser(o: AuthOptions): void {
  if (o.mode === 'clientCredentials' || (o.mode === 'oauth' && o.clientSecret)) {
    throw new CaitlynAuthError(
      `${o.mode === 'oauth' ? 'oauth with a clientSecret' : 'clientCredentials'} cannot be used in a browser: a client secret in a browser is visible to everyone who loads the page. Use oauth without a clientSecret (authorisation code with PKCE), or sign in on your server.`,
      IN_BROWSER,
    );
  }
  if (o.mode === 'awsIam' || o.mode === 'workloadIdentity') {
    throw new CaitlynAuthError(`${o.mode} cannot be used in a browser: it signs in a server workload with that workload's own identity. Use oauth in a browser.`, IN_BROWSER);
  }
  if (o.mode === 'token' && !o.allowBrowserToken && isBrowser()) {
    console.warn(
      'Caitlyn: a long-lived token in a browser is exposed to anyone who can run script on the page. token mode in a browser is for local testing; use oauth instead. Set auth.allowBrowserToken: true to silence this warning.',
    );
  }
}

export async function serverToken(o: AuthOptions, _s: SignIn): Promise<OAuthTokens> {
  throw new CaitlynAuthError(`No token to fetch in ${o.mode} mode`, 'invalid_request');
}
