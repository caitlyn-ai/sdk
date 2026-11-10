// getCaitlynSdkPlugin: SDK identity on every request, with no AWS headers.
// - User-Agent: caitlyn-sdk-ts/<version> lang/js md/<runtime>
// - Caitlyn-Sdk-Model: the model version the SDK was generated from (highest @since)
// - removes smithy-typescript's retry bookkeeping headers (amz-sdk-invocation-id, amz-sdk-request)
// - reads Caitlyn-Api-Version from responses, and fails a call before sending when the operation, or a
//   member the caller set, is newer than that server (@since; PROTOCOL.md rule 8)
import { getOmitRetryHeadersPlugin } from '@smithy/core/retry';
import { HttpRequest } from '@smithy/core/protocols';
import type { BuildMiddleware, DeserializeMiddleware, FinalizeRequestMiddleware, InitializeMiddleware, Pluggable } from '@smithy/types';
import { HttpResponse } from '@smithy/core/protocols';
import { NO_RETRY } from './retry.js';

export const CAITLYN_SDK_USER_AGENT_PREFIX = 'caitlyn-sdk-ts';

export class NotSupportedByServer extends Error {
  constructor(readonly operation: string, readonly requires: string, readonly server: string) {
    super(`NotSupportedByServer(${operation}, requires ${requires}, server is ${server})`);
    this.name = 'NotSupportedByServer';
  }
}

const semver = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

function runtime(): string {
  const g = globalThis as { process?: { versions?: { node?: string; bun?: string } }; Deno?: { version?: { deno?: string } } };
  if (g.process?.versions?.bun) return `md/bun#${g.process.versions.bun}`;
  if (g.Deno?.version?.deno) return `md/deno#${g.Deno.version.deno}`;
  if (g.process?.versions?.node) return `md/nodejs#${g.process.versions.node}`;
  return 'md/browser';
}

/**
 * @param options.sdkModel the highest @since in the model: the server release this SDK was generated against
 * @param options.retrySafeOperations operations that are @readonly, @idempotent or have an @idempotencyToken member
 * @param options.since `Operation=5.120.0` and `Operation.member=5.124.0` entries from the model's @since traits
 */
export function getCaitlynSdkPlugin(
  config: { caitlynSdkVersion?: string; customUserAgent?: string },
  options: { sdkModel: string; retrySafeOperations: string[]; since?: string[] },
): Pluggable<any, any> {
  let server: string | undefined; // the last Caitlyn-Api-Version this client saw
  const since = new Map((options.since ?? []).map((e) => e.split('=') as [string, string]));
  const sinceCheck: InitializeMiddleware<any, any> = (next, context) => async (args) => {
    const op = context.commandName?.replace(/Command$/, '');
    if (op && server) {
      const required = since.get(op);
      if (required && semver(required, server) > 0) throw new NotSupportedByServer(op, required, server);
      for (const [member, value] of Object.entries(args.input as object)) {
        const memberSince = value === undefined ? undefined : since.get(`${op}.${member}`);
        if (memberSince && semver(memberSince, server) > 0) throw new NotSupportedByServer(`${op}.${member}`, memberSince, server);
      }
    }
    return next(args);
  };
  const serverVersion: DeserializeMiddleware<any, any> = (next) => async (args) => {
    try {
      const out = await next(args);
      if (HttpResponse.isInstance(out.response)) server = out.response.headers['caitlyn-api-version'] ?? server;
      return out;
    } catch (err) {
      const res = (err as { $response?: unknown }).$response;
      if (HttpResponse.isInstance(res)) server = res.headers['caitlyn-api-version'] ?? server;
      throw err;
    }
  };
  const userAgent = [`${CAITLYN_SDK_USER_AGENT_PREFIX}/${config.caitlynSdkVersion ?? '0.0.0'}`, 'lang/js', runtime(), config.customUserAgent]
    .filter(Boolean)
    .join(' ');
  const identity: BuildMiddleware<any, any> = (next) => async (args) => {
    if (HttpRequest.isInstance(args.request)) {
      args.request.headers['user-agent'] = userAgent;
      args.request.headers['caitlyn-sdk-model'] = options.sdkModel;
    }
    return next(args);
  };
  const safe = new Set(options.retrySafeOperations);
  // Inside the retry loop: mark errors from operations that must not be retried.
  const retrySafety: FinalizeRequestMiddleware<any, any> = (next, context) => async (args) => {
    try {
      return await next(args);
    } catch (err) {
      const op = context.commandName?.replace(/Command$/, '');
      if (op && !safe.has(op) && err && typeof err === 'object') Object.defineProperty(err, NO_RETRY, { value: true });
      throw err;
    }
  };
  return {
    applyToStack(stack) {
      stack.add(sinceCheck, { step: 'initialize', name: 'caitlynSinceCheck', priority: 'high', override: true });
      stack.add(serverVersion, { step: 'deserialize', name: 'caitlynServerVersion', priority: 'low', override: true });
      stack.add(identity, { step: 'build', name: 'caitlynSdkIdentity', priority: 'low', override: true });
      stack.addRelativeTo(retrySafety, { toMiddleware: 'retryMiddleware', relation: 'after', name: 'caitlynRetrySafety' });
      getOmitRetryHeadersPlugin({}).applyToStack(stack);
    },
  };
}
