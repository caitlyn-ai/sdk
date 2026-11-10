// Client options shared by every generated Caitlyn client, and the options every call accepts.
import type { TracerProvider } from '@opentelemetry/api';
import { CaitlynRetryStrategy } from './retry.js';

export interface CaitlynOptions {
  /** The workspace hostname, for example "your-company.getcaitlyn.ai". */
  workspace: string;
  /** Only the bearer token mode exists so far; oauth, workloadIdentity and awsIam come with lane K1. */
  auth: { mode: 'token'; token: string };
  /** Overrides the base URL the operation paths (/v3/…) are appended to. Default: https://{workspace}/api. */
  endpoint?: string;
  maxAttempts?: number;
  /** Longest Retry-After the SDK waits for (default 60 000 ms); above it the call fails at once. */
  maxRetryDelayMs?: number;
  telemetry?: { tracerProvider?: TracerProvider; enabled?: boolean };
}

export interface CallOptions {
  signal?: AbortSignal;
}

/** The base URL of a workspace's API: its hostname, over HTTPS, with the /api prefix every Caitlyn route has. */
export function workspaceEndpoint(workspace: string): string {
  const host = workspace.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${host}/api`;
}

/** The generated client's configuration for a set of options. */
export function clientConfig(opts: CaitlynOptions) {
  return {
    endpoint: opts.endpoint ?? workspaceEndpoint(opts.workspace),
    token: { token: opts.auth.token },
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.maxRetryDelayMs !== undefined ? { retryStrategy: new CaitlynRetryStrategy(opts.maxAttempts ?? 3, opts.maxRetryDelayMs) } : {}),
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
}
