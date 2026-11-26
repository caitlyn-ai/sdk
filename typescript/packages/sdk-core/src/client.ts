// Client options shared by every generated Caitlyn client, and the options every call accepts.
import type { TracerProvider } from '@opentelemetry/api';
import type { HttpHandlerUserInput } from '@smithy/core/protocols';
import { CaitlynRetryStrategy } from './retry.js';
import { caitlynTracer } from './telemetry.js';
import { AuthSession, tokenIdentityProvider, workspaceHost, type AuthOptions } from './auth.js';

export interface CaitlynOptions {
  /**
   * The workspace hostname, for example "your-company.caitlyn.ai". Like an AWS region, it decides where
   * requests go (https://<workspace>/api) and the audience every token is bound to (https://<workspace>/api).
   */
  workspace: string;
  /** How the client signs in: token, clientCredentials, oauth, awsIam, workloadIdentity or session. */
  auth: AuthOptions;
  /** The fetch the sign-in requests use (token endpoint, STS, container credentials). Default: global fetch. */
  fetch?: typeof fetch;
  /**
   * Overrides the base URL the operation paths (/v3/…) and the token endpoint (/oauth/token) are appended to,
   * for a proxy or a local app. Default: https://{workspace}/api. It never changes the token audience.
   */
  endpoint?: string;
  /**
   * The HTTP handler API calls go through, for this client only: the fetch handler's options (`requestTimeout`,
   * `keepAlive`, `credentials`, `cache`, `requestInit`, `customFetch`: on Node, a `fetch` with an undici dispatcher
   * for a private certificate authority or a proxy), or any object with `handle(request)`, such as a
   * `NodeHttpHandler`. Default: a fetch handler of the client's own, in every runtime. Sign-in requests go through
   * `fetch`.
   */
  requestHandler?: HttpHandlerUserInput;
  maxAttempts?: number;
  /** Longest Retry-After the SDK waits for (default 60 000 ms); above it the call fails at once. */
  maxRetryDelayMs?: number;
  /**
   * How long a send to storage (an upload's bytes) may send and receive nothing before that attempt is abandoned and
   * retried, in milliseconds (default 60 000; 0 never). Not an overall limit: a large file on a slow link carries on
   * while its bytes keep moving (PROTOCOL.md 14). API calls have their own timeout: `requestHandler: { requestTimeout }`.
   */
  storageStallTimeoutMs?: number;
  /**
   * The size of this client's retry budget, in tokens (default 500). A retry costs 5, or 10 after a failure with no
   * response; a call that succeeds gives back 1, or its last retry's cost. When the budget cannot pay for a retry,
   * the call fails at once with its error. 0 turns retries off (PROTOCOL.md 6.4).
   */
  retryBudget?: number;
  telemetry?: { tracerProvider?: TracerProvider; enabled?: boolean };
  /** Your application's name, sent in the user agent as `app/<appId>`: `<name>` or `<name>#<version>`. Declared only; never used for authorisation. */
  appId?: string;
  /**
   * The CI system your application recognises it runs in, sent after `app/` as `ci/<ci>` (github, gitlab, buildkite,
   * circleci, jenkins, azure-pipelines, bitbucket, or generic). 1 to 32 of a-z, 0-9 and -, or creating the client throws.
   */
  ci?: string;
  /**
   * The AI agent your application recognises is driving it, sent last as `agent/<agent>` (for example claude-code).
   * 1 to 32 of a-z, 0-9 and -, or creating the client throws.
   */
  agent?: string;
}

/** The caller's own user-agent tokens (PROTOCOL.md 3.1 and 3.2): `app/`, then `ci/`, then `agent/`, each only when given. */
export function callerUserAgent(opts: Pick<CaitlynOptions, 'appId' | 'ci' | 'agent'>): string | undefined {
  for (const [name, value] of [['ci', opts.ci], ['agent', opts.agent]] as const) {
    if (value !== undefined && !/^[a-z0-9-]{1,32}$/.test(value)) {
      throw new TypeError(`The ${name}/ user-agent value ${JSON.stringify(value)} must be 1 to 32 of a-z, 0-9 and -.`);
    }
  }
  const tokens = [opts.appId && `app/${opts.appId}`, opts.ci && `ci/${opts.ci}`, opts.agent && `agent/${opts.agent}`].filter(Boolean);
  return tokens.length ? tokens.join(' ') : undefined;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/** The base URL of a workspace's API: its hostname, over HTTPS, with the /api prefix every Caitlyn route has. */
export function workspaceEndpoint(workspace: string): string {
  return `https://${workspaceHost(workspace)}/api`;
}

/** The sign-in session for a set of options: what `client.auth` is. */
export function createAuth(opts: CaitlynOptions): AuthSession {
  return new AuthSession(opts.auth, (opts.endpoint ?? workspaceEndpoint(opts.workspace)).replace(/\/+$/, ''), workspaceHost(opts.workspace), opts.fetch);
}

/** The generated client's configuration for a set of options. */
export function clientConfig(opts: CaitlynOptions, auth: AuthSession = createAuth(opts)) {
  const customUserAgent = callerUserAgent(opts);
  return {
    /** The workspace this client is for; readable as client.config.workspace. */
    workspace: workspaceHost(opts.workspace),
    endpoint: opts.endpoint ?? workspaceEndpoint(opts.workspace),
    token: tokenIdentityProvider(auth),
    /** The tracer upload helpers record the byte transfer with (PROTOCOL.md 13); absent with telemetry off. */
    caitlynTracer: opts.telemetry?.enabled === false ? undefined : caitlynTracer(opts.telemetry?.tracerProvider),
    /** How file helpers retry the bytes they send to storage (PROTOCOL.md 14): the client's own limits. */
    caitlynStorage: { maxAttempts: opts.maxAttempts, maxRetryDelayMs: opts.maxRetryDelayMs, stallTimeoutMs: opts.storageStallTimeoutMs },
    ...(customUserAgent !== undefined ? { customUserAgent } : {}),
    ...(opts.requestHandler !== undefined ? { requestHandler: opts.requestHandler } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.maxRetryDelayMs !== undefined || opts.retryBudget !== undefined
      ? { retryStrategy: new CaitlynRetryStrategy(opts.maxAttempts ?? 3, opts.maxRetryDelayMs, opts.retryBudget) }
      : {}),
  };
}

/** One problem with one request member or query parameter, on a 400 VALIDATION_FAILED. */
export interface CaitlynFieldError {
  pointer?: string;
  parameter?: string;
  code: string;
  detail?: string;
}

/** The RFC 9457 fields every Caitlyn error carries (PROTOCOL.md 6.3). */
export interface CaitlynErrorFields {
  status?: number;
  code?: string;
  type?: string;
  title?: string;
  detail?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  errors?: CaitlynFieldError[];
  /** The response body as received, as text, at most its first 8 KiB: the only view of a body that is not problem details (PROTOCOL.md 6.3). */
  rawBody?: string;
  /** True when the body was longer than 8 KiB and `rawBody` holds only its first 8 KiB. */
  rawBodyTruncated?: boolean;
}
