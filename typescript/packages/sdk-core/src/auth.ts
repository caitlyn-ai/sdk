// Sign-in modes. Every mode except `session` ends in the same thing: a short-lived Caitlyn bearer token from
// the workspace's OAuth token endpoint ({endpoint}/oauth/token), cached until a minute before it expires and
// refreshed by one request at a time (design doc, "Authentication"; proposal 6.11).
//
//   token              a personal access token (cait-pat-…), sent as it is
//   clientCredentials  client ID and secret exchanged for a token; re-requested before expiry
//   oauth              authorisation code with PKCE, then refresh tokens; a token store keeps them
//   awsIam             STS GetWebIdentityToken with the caller's AWS credentials, exchanged (RFC 8693)
//   workloadIdentity   a JWT from another trusted issuer (GitLab CI id_tokens), exchanged (RFC 8693)
//   session            the browser session cookie; Origin on every write (the Caitlyn app, local recording)
import type { Pluggable, FinalizeRequestMiddleware, InitializeMiddleware, TokenIdentity } from '@smithy/types';
import { HttpRequest } from '@smithy/core/protocols';
import type { AwsCredentialSource, AwsCredentials } from './aws.js';
import { CaitlynAuthError, isBrowser } from './auth-base.js';
import { guardBrowser, serverToken, type SignIn } from './auth-server.js';

export { CaitlynAuthError, isBrowser };

/** Tokens the `oauth` mode keeps. `expiresAt` is milliseconds since the epoch. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

/** Where the `oauth` mode keeps tokens between processes, for example encrypted on a server. */
export interface TokenStore {
  load(): Promise<OAuthTokens | undefined> | OAuthTokens | undefined;
  save(tokens: OAuthTokens): Promise<void> | void;
  clear(): Promise<void> | void;
}

export type AuthOptions =
  | {
      mode: 'token';
      token: string;
      /** In a browser, silences the warning that a long-lived token there is exposed (for local testing). */
      allowBrowserToken?: boolean;
    }
  | { mode: 'clientCredentials'; clientId: string; clientSecret: string; scopes?: string[]; resource?: string }
  | {
      mode: 'oauth';
      clientId: string;
      /** For a confidential client on a server; omit in a browser. */
      clientSecret?: string;
      redirectUri?: string;
      scopes?: string[];
      resource?: string;
      /** Default: kept in memory for the life of the client. */
      tokenStore?: TokenStore;
    }
  | {
      mode: 'awsIam';
      /** The regional STS endpoint to use. Default: AWS_REGION, then AWS_DEFAULT_REGION. */
      region?: string;
      /** Default: environment variables, then the container credentials endpoint. Accepts any @aws-sdk provider. */
      credentials?: AwsCredentialSource;
      signingAlgorithm?: 'ES384' | 'RS256';
      /** Lifetime of the AWS-signed token, at most 300 (the default). */
      durationSeconds?: number;
      /** The audience the AWS token is minted for. Default: the workspace resource URL. */
      audience?: string;
      stsEndpoint?: string;
    }
  | {
      mode: 'workloadIdentity';
      /** Returns the workload's current identity token, for example a GitLab CI id_tokens variable. */
      token: () => string | Promise<string>;
      resource?: string;
    }
  | {
      mode: 'session';
      /** A session cookie, for server-side use. In a browser leave it out: the browser sends its own. */
      cookie?: string;
      /** Sent as Origin on every write. Default: the workspace URL. */
      origin?: string;
    };

const REFRESH_EARLY_MS = 60_000;
const SESSION_PLACEHOLDER = 'session';

/** When to replace a token: a minute before it expires, or halfway through a lifetime shorter than two minutes. */
const refreshAt = (t: OAuthTokens) => (t.expiresAt === undefined ? undefined : t.expiresAt - Math.min(REFRESH_EARLY_MS, (t.expiresAt - Date.now()) / 2));

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** The audience of a workspace's tokens: its resource URL, https://<workspace>/api. */
export const workspaceAudience = (workspace: string) => `https://${workspaceHost(workspace)}/api`;

/** A workspace given as a hostname or a URL, as its bare hostname. */
export const workspaceHost = (workspace: string) => workspace.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

/** What `client.auth` offers: the current token, and the `oauth` mode's sign-in steps. */
export class AuthSession {
  private cached?: { token: string; refreshAt?: number };
  /** The token the server last refused with a 401, so `oauth` never reloads it from the store. */
  private refused?: string;
  private inflight?: Promise<string>;
  private memoryTokens?: OAuthTokens;
  readonly tokenEndpoint: string;
  readonly authorizationEndpoint: string;
  /** The workspace's resource URL, https://<workspace>/api: the audience every token is bound to. */
  readonly resource: string;
  /** https://<workspace>: the default Origin for session writes. */
  readonly workspaceUrl: string;

  constructor(
    readonly options: AuthOptions,
    /** Where the token endpoint is: the client's endpoint, which an override may move (a proxy, a local app). */
    readonly endpoint: string,
    /** The workspace hostname. Like an AWS region, it decides the endpoint and the token audience. */
    readonly workspace: string,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {
    this.tokenEndpoint = `${endpoint}/oauth/token`;
    this.authorizationEndpoint = `${endpoint}/oauth/authorize`;
    this.workspaceUrl = `https://${workspace}`;
    // From the workspace, never from an endpoint override: a token is always for the workspace it names.
    this.resource = ('resource' in options && options.resource) || workspaceAudience(workspace);
    guardBrowser(options);
  }

  get mode() {
    return this.options.mode;
  }

  /** The bearer token for the next request: cached, or fetched once however many calls ask at the same time. */
  async token(): Promise<string> {
    const o = this.options;
    if (o.mode === 'token') return o.token;
    if (o.mode === 'session') return SESSION_PLACEHOLDER; // removed again after signing
    if (this.cached && (this.cached.refreshAt === undefined || this.cached.refreshAt > Date.now())) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** Forgets the cached token, so the next call signs in again (done once after a 401). */
  invalidate(): void {
    this.refused = this.cached?.token;
    this.cached = undefined;
  }

  /** Whether a 401 is worth one more try with a new token. */
  get canRefresh(): boolean {
    return this.options.mode !== 'token' && this.options.mode !== 'session';
  }

  // ------------------------------------------------------------------ oauth

  /** Starts sign-in (`oauth` mode): the URL to send the person to, and the state and PKCE verifier to keep. */
  async authorizationUrl(opts: { state?: string; scopes?: string[]; redirectUri?: string } = {}): Promise<{ url: string; state: string; codeVerifier: string }> {
    const o = this.oauth();
    const codeVerifier = randomString(48);
    const state = opts.state ?? randomString(16);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
    const url = new URL(this.authorizationEndpoint);
    const redirectUri = opts.redirectUri ?? o.redirectUri;
    if (!redirectUri) throw new CaitlynAuthError('oauth: redirectUri is required', 'invalid_request');
    const scopes = opts.scopes ?? o.scopes;
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: o.clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: this.resource,
      ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
    }).toString();
    return { url: url.toString(), state, codeVerifier };
  }

  /** Finishes sign-in (`oauth` mode): checks state, exchanges the code and saves the tokens. */
  async handleCallback(p: { code: string; state?: string; expectedState?: string; codeVerifier: string; redirectUri?: string }): Promise<OAuthTokens> {
    const o = this.oauth();
    if (p.expectedState !== undefined && p.state !== p.expectedState) throw new CaitlynAuthError('oauth: the state does not match', 'invalid_state');
    const redirectUri = p.redirectUri ?? o.redirectUri;
    const tokens = await this.requestToken({
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.codeVerifier,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      resource: this.resource,
      ...this.clientParams(),
    });
    await this.saveTokens(tokens);
    return tokens;
  }

  /** Signs out (`oauth` mode): revokes the refresh token where possible and clears the store. */
  async signOut(): Promise<void> {
    const o = this.oauth();
    const t = await this.loadTokens();
    if (t?.refreshToken) {
      await this.fetchFn(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'revoke', token: t.refreshToken, ...this.clientParams() }).toString(),
      }).catch(() => undefined);
    }
    this.cached = undefined;
    this.memoryTokens = undefined;
    await o.tokenStore?.clear();
  }

  private oauth() {
    if (this.options.mode !== 'oauth') throw new CaitlynAuthError(`This client signs in with ${this.options.mode}, not oauth`, 'invalid_request');
    return this.options;
  }

  private clientParams(): Record<string, string> {
    const o = this.options as { clientId?: string; clientSecret?: string };
    return { ...(o.clientId ? { client_id: o.clientId } : {}), ...(o.clientSecret ? { client_secret: o.clientSecret } : {}) };
  }

  private async loadTokens() {
    const o = this.oauth();
    return o.tokenStore ? await o.tokenStore.load() : this.memoryTokens;
  }

  private async saveTokens(t: OAuthTokens) {
    const o = this.oauth();
    this.memoryTokens = t;
    this.cached = { token: t.accessToken, refreshAt: refreshAt(t) };
    await o.tokenStore?.save(t);
  }

  // ------------------------------------------------------------------ fetching tokens

  private async fetchToken(): Promise<string> {
    const o = this.options;
    let t: OAuthTokens;
    switch (o.mode) {
      case 'oauth': {
        const stored = await this.loadTokens();
        const held = this.cached?.token ?? this.refused;
        if (stored && (stored.expiresAt === undefined || stored.expiresAt - REFRESH_EARLY_MS > Date.now()) && stored.accessToken !== held) {
          t = stored; // signed in or refreshed by another process (or not yet used by this client)
        } else if (stored?.refreshToken) {
          try {
            t = await this.requestToken({ grant_type: 'refresh_token', refresh_token: stored.refreshToken, ...this.clientParams() });
          } catch (err) {
            if (err instanceof CaitlynAuthError && err.code === 'invalid_grant') await o.tokenStore?.clear();
            throw err;
          }
          t.refreshToken ??= stored.refreshToken;
          await this.saveTokens(t);
        } else {
          throw new CaitlynAuthError('oauth: not signed in. Call auth.authorizationUrl() and auth.handleCallback() first.', 'sign_in_required');
        }
        break;
      }
      default:
        t = await serverToken(o, this.signIn);
    }
    this.cached = { token: t.accessToken, refreshAt: refreshAt(t) };
    return t.accessToken;
  }

  /** What the server-only modes (auth-server.ts) sign in with. */
  private readonly signIn: SignIn = {
    request: (params) => this.requestToken(params),
    resource: () => this.resource,
    clientParams: () => this.clientParams(),
    fetch: (...a) => this.fetchFn(...a),
  };

  private async requestToken(params: Record<string, string>): Promise<OAuthTokens> {
    const res = await this.fetchFn(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    const requestId = res.headers.get('caitlyn-request-id') ?? undefined;
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string') {
      const code = String(body.error ?? body.code ?? `http_${res.status}`);
      throw new CaitlynAuthError(String(body.error_description ?? body.detail ?? `Sign-in failed: ${code}`), code, res.status, requestId);
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
    };
  }
}

/**
 * The generated client's `token` identity provider. It reports the token as already near expiry, so Smithy's
 * memoisation asks again on every request and AuthSession's own cache (which knows the real expiry, and can
 * be invalidated after a 401) decides.
 */
export const tokenIdentityProvider = (auth: AuthSession) => async (): Promise<TokenIdentity> => ({ token: await auth.token(), expiration: new Date() });

/** Session headers, and one retry with a new token after a 401. */
export function getCaitlynAuthPlugin(auth: AuthSession): Pluggable<any, any> {
  const o = auth.options;
  const session: FinalizeRequestMiddleware<any, any> = (next) => async (args) => {
    if (o.mode === 'session' && HttpRequest.isInstance(args.request)) {
      delete args.request.headers.authorization;
      delete args.request.headers.Authorization;
      if (o.cookie) args.request.headers.cookie = o.cookie;
      if (args.request.method !== 'GET' && args.request.method !== 'HEAD') args.request.headers.origin = o.origin ?? auth.workspaceUrl;
    }
    return next(args);
  };
  const reauth: InitializeMiddleware<any, any> = (next) => async (args) => {
    try {
      return await next(args);
    } catch (err) {
      if (!auth.canRefresh || (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 401) throw err;
      auth.invalidate();
      return next(args);
    }
  };
  return {
    applyToStack(stack) {
      stack.addRelativeTo(session, { toMiddleware: 'httpSigningMiddleware', relation: 'after', name: 'caitlynSession', override: true });
      stack.add(reauth, { step: 'initialize', name: 'caitlynReauth', priority: 'low', override: true });
    },
  };
}
