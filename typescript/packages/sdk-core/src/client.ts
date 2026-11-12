// Client options shared by every generated Caitlyn client, and the options every call accepts.
import type { TracerProvider } from '@opentelemetry/api';
import type { HttpHandlerUserInput } from '@smithy/core/protocols';
import { CaitlynRetryStrategy } from './retry.js';
import { caitlynTracer } from './telemetry.js';
import { AuthSession, tokenIdentityProvider, workspaceHost, type AuthOptions } from './auth.js';

export interface CaitlynOptions {
  /**
   * The workspace hostname, for example "your-company.getcaitlyn.ai". Like an AWS region, it decides where
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
   * The HTTP handler API calls go through, for this client only: a `NodeHttpHandler` with your own `https.Agent`
   * (a private certificate authority, a proxy, keep-alive settings), a `FetchHttpHandler`, any object with
   * `handle(request)`, or the default handler's options (`{ httpsAgent }` on Node). Default: a handler of the
   * client's own. Sign-in requests go through `fetch`.
   */
  requestHandler?: HttpHandlerUserInput;
  maxAttempts?: number;
  /** Longest Retry-After the SDK waits for (default 60 000 ms); above it the call fails at once. */
  maxRetryDelayMs?: number;
  /**
   * The size of this client's retry budget, in tokens (default 500). A retry costs 5, or 10 after a failure with no
   * response; a call that succeeds gives back 1, or its last retry's cost. When the budget cannot pay for a retry,
   * the call fails at once with its error. 0 turns retries off (PROTOCOL.md 6.4).
   */
  retryBudget?: number;
  telemetry?: { tracerProvider?: TracerProvider; enabled?: boolean };
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
  return {
    /** The workspace this client is for; readable as client.config.workspace. */
    workspace: workspaceHost(opts.workspace),
    endpoint: opts.endpoint ?? workspaceEndpoint(opts.workspace),
    token: tokenIdentityProvider(auth),
    /** The tracer upload helpers record the byte transfer with (PROTOCOL.md 13); absent with telemetry off. */
    caitlynTracer: opts.telemetry?.enabled === false ? undefined : caitlynTracer(opts.telemetry?.tracerProvider),
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
