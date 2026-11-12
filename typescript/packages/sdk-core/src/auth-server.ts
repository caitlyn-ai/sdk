// The sign-in modes a browser page may not use (PROTOCOL.md 12.6), and the browser guard that refuses them there:
// clientCredentials, awsIam and workloadIdentity. The browser build of the SDK replaces this file with
// browser/auth-server.ts, which refuses them whatever page or worker it runs in, so none of their code ships to a
// browser.
import type { AuthOptions, OAuthTokens } from './auth.js';
import { CaitlynAuthError, isBrowser } from './auth-base.js';

/** What AuthSession lends a server-only mode to sign in with. */
export interface SignIn {
  request(params: Record<string, string>): Promise<OAuthTokens>;
  resource(): string;
  clientParams(): Record<string, string>;
  fetch: typeof fetch;
}

const IN_BROWSER = 'not_allowed_in_browser';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

/**
 * In a browser, refuses the modes whose credential everyone who loads the page could read, or that only work on a
 * server, and warns about a long-lived token (PROTOCOL.md section 12.6). Throws when the client is created.
 */
export function guardBrowser(o: AuthOptions): void {
  if (!isBrowser()) return;
  if (o.mode === 'clientCredentials' || (o.mode === 'oauth' && o.clientSecret)) {
    throw new CaitlynAuthError(
      `${o.mode === 'oauth' ? 'oauth with a clientSecret' : 'clientCredentials'} cannot be used in a browser: a client secret in a browser is visible to everyone who loads the page. Use oauth without a clientSecret (authorisation code with PKCE), or sign in on your server.`,
      IN_BROWSER,
    );
  }
  if (o.mode === 'awsIam' || o.mode === 'workloadIdentity') {
    throw new CaitlynAuthError(`${o.mode} cannot be used in a browser: it signs in a server workload with that workload's own identity. Use oauth in a browser.`, IN_BROWSER);
  }
  if (o.mode === 'token' && !o.allowBrowserToken) {
    console.warn(
      'Caitlyn: a long-lived token in a browser is exposed to anyone who can run script on the page. token mode in a browser is for local testing; use oauth instead. Set auth.allowBrowserToken: true to silence this warning.',
    );
  }
}

/** A token for clientCredentials, awsIam or workloadIdentity. */
export async function serverToken(o: AuthOptions, s: SignIn): Promise<OAuthTokens> {
  switch (o.mode) {
    case 'clientCredentials':
      return s.request({
        grant_type: 'client_credentials',
        ...s.clientParams(),
        resource: s.resource(),
        ...(o.scopes?.length ? { scope: o.scopes.join(' ') } : {}),
      });
    case 'awsIam': {
      const region = o.region ?? env().AWS_REGION ?? env().AWS_DEFAULT_REGION;
      if (!region) throw new CaitlynAuthError('awsIam: set region, or AWS_REGION, for the regional STS endpoint', 'invalid_request');
      // Loaded only in this mode, so a bundle that never signs in with AWS does not carry the signer.
      const { defaultAwsCredentials, getWebIdentityToken } = await import('./aws.js');
      let subject: string;
      try {
        // Inside the try, so missing credentials are a sign-in error like an STS refusal.
        const credentials = o.credentials ? await (typeof o.credentials === 'function' ? o.credentials() : o.credentials) : await defaultAwsCredentials(s.fetch);
        subject = (await getWebIdentityToken({ region, audience: o.audience ?? s.resource(), credentials, signingAlgorithm: o.signingAlgorithm, durationSeconds: o.durationSeconds, stsEndpoint: o.stsEndpoint, fetch: s.fetch })).token;
      } catch (err) {
        throw new CaitlynAuthError((err as Error).message, (err as { code?: string }).code ?? 'aws_identity_failed', (err as { status?: number }).status);
      }
      return exchange(s, subject);
    }
    case 'workloadIdentity':
      return exchange(s, await o.token());
    default:
      throw new CaitlynAuthError(`No token to fetch in ${o.mode} mode`, 'invalid_request');
  }
}

function exchange(s: SignIn, subjectToken: string) {
  return s.request({
    grant_type: TOKEN_EXCHANGE,
    subject_token: subjectToken,
    subject_token_type: JWT_TYPE,
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    resource: s.resource(),
  });
}

type Env = Record<string, string | undefined>;
const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};
