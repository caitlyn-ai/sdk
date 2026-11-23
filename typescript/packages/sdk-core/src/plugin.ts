// getCaitlynSdkPlugin: SDK identity on every request, with no AWS headers.
// - User-Agent: caitlyn-sdk-ts/<version> lang/js md/<runtime>
// - Caitlyn-Sdk-Model: the model version the SDK was generated from (highest @since)
// - reads Caitlyn-Api-Version from responses, and fails a call before sending when the operation, or a
//   member the caller set, is newer than that server (@since; PROTOCOL.md rule 8)
import { HttpRequest } from '@smithy/core/transport';
import type { BuildMiddleware, DeserializeMiddleware, FinalizeRequestMiddleware, InitializeMiddleware, Pluggable } from '@smithy/types';
import { HttpResponse } from '@smithy/core/transport';
import { NO_RETRY } from './retry.js';
import { decorateServiceException } from '@smithy/core/client';
import { TypeRegistry } from '@smithy/core/schema';
import { traitsOf } from './runtime/schema.js';
import { rangeProblems, rangeRules, type RangeProblem } from './ranges.js';

export const CAITLYN_SDK_USER_AGENT_PREFIX = 'caitlyn-sdk-ts';

/** Marks a failure that got no HTTP response, or whose connection failed while the body was read (PROTOCOL.md 6.5). */
export const NO_RESPONSE = Symbol.for('caitlyn.noResponse');

/** Marks `err` as a connection failure, unless it is a cancellation. Returns it, for `throw markNoResponse(err)`. */
export function markNoResponse(err: unknown): unknown {
  if (err && typeof err === 'object' && (err as Error).name !== 'AbortError') Object.defineProperty(err, NO_RESPONSE, { value: true, configurable: true });
  return err;
}

/**
 * Connection errors (PROTOCOL.md 6.5): a call that got no HTTP response, or whose connection failed while the
 * body was read, fails with `toError(operation, cause)`, the generated `CaitlynConnectionError`, once the retries
 * are spent. Token requests are not marked: their failures stay sign-in errors.
 */
export function getCaitlynConnectionErrorPlugin(toError: (operation: string, cause: unknown) => Error): Pluggable<any, any> {
  // Closest to the HTTP handler: whatever it throws got no response.
  const mark: DeserializeMiddleware<any, any> = (next) => async (args) => {
    try {
      return await next(args);
    } catch (err) {
      const e = err as { $response?: unknown; $metadata?: { httpStatusCode?: number } };
      if (!HttpResponse.isInstance(e?.$response) && e?.$metadata?.httpStatusCode === undefined) markNoResponse(err);
      throw err;
    }
  };
  // Outside the retries, inside the call span: the span records the connection error.
  const wrap: InitializeMiddleware<any, any> = (next, context) => async (args) => {
    try {
      return await next(args);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { [NO_RESPONSE]?: boolean })[NO_RESPONSE]) {
        const error = toError(context.commandName?.replace(/Command$/, '') ?? 'call', err) as Error & { $metadata?: Record<string, unknown> };
        // Keep what the retry loop recorded (attempts, totalRetryDelay), as every other error has it.
        const { attempts, totalRetryDelay } = (err as { $metadata?: { attempts?: number; totalRetryDelay?: number } }).$metadata ?? {};
        if (error.$metadata) Object.assign(error.$metadata, attempts !== undefined ? { attempts } : {}, totalRetryDelay !== undefined ? { totalRetryDelay } : {});
        throw error;
      }
      throw err;
    }
  };
  return {
    applyToStack(stack) {
      stack.add(mark, { step: 'deserialize', name: 'caitlynNoResponse', priority: 'low', override: true });
      stack.add(wrap, { step: 'initialize', name: 'caitlynConnectionError', priority: 'normal', override: true });
    },
  };
}

/**
 * VALIDATION_FAILED raised by the SDK itself (PROTOCOL.md 3 and 6.3): the model's 400 class (ValidationError), as the
 * server's refusal would be, but status 0 and nothing sent; the generic error when the model has no 400 class.
 */
function validationError(registries: TypeRegistry[], problems: RangeProblem[]): Error {
  let Ctor: (new (o: { name?: string; message: string }) => Error) | undefined;
  for (const r of registries) {
    const schema = r.find((x) => Array.isArray(x) && x[0] === -3 && traitsOf((x as unknown[])[3]).httpError === 400);
    if (schema) {
      Ctor = r.getErrorCtor(schema as never) as typeof Ctor;
      break;
    }
  }
  for (const r of Ctor ? [] : registries) {
    const base = r.getBaseException();
    if (base) {
      Ctor = r.getErrorCtor(base) as typeof Ctor;
      break;
    }
  }
  const detail = problems.length === 1 ? problems[0]!.detail : `${problems.length} values are out of range. ${problems.map((p) => p.detail).join(' ')}`;
  const error = Object.assign(new (Ctor ?? (Error as never))({ name: 'CaitlynError', message: detail }), { $metadata: {}, $fault: 'client' as const });
  return decorateServiceException(error as never, { status: 0, code: 'VALIDATION_FAILED', title: 'The request is not valid', detail, errors: problems });
}

/** A routing answer that says the server has no such operation (PROTOCOL.md 9), not that a thing is missing. */
function isUnknownOperation(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown };
  return (e.status === 404 && e.code === 'UNKNOWN_OPERATION') || (e.status === 405 && e.code === 'METHOD_NOT_ALLOWED');
}

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
 * @param options.ranges `Operation|query|limit|1|100` and `Operation|body|/pointer/*\/pattern|0|1` entries from the
 *   model's @range traits (ranges.ts)
 */
export function getCaitlynSdkPlugin(
  config: { caitlynSdkVersion?: string; customUserAgent?: string; protocolSettings?: { [setting: string]: unknown } },
  options: { sdkModel: string; retrySafeOperations: string[]; since?: string[]; ranges?: string[] },
): Pluggable<any, any> {
  let server: string | undefined; // the last Caitlyn-Api-Version this client saw
  const since = new Map((options.since ?? []).map((e) => e.split('=') as [string, string]));
  const ranges = rangeRules(options.ranges ?? []);
  // The @range check (PROTOCOL.md 3): a value outside its range is refused before sending, with the error the server
  // would give (ValidationError, VALIDATION_FAILED and its field errors), but status 0 and nothing sent.
  const rangeCheck: BuildMiddleware<any, any> = (next, context) => async (args) => {
    const rules = ranges.get(context.commandName?.replace(/Command$/, '') ?? '');
    if (rules && HttpRequest.isInstance(args.request)) {
      const req = args.request;
      const text = typeof req.body === 'string' ? req.body : req.body instanceof Uint8Array ? new TextDecoder().decode(req.body) : undefined;
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined; // not JSON: nothing in it to check
      }
      const problems = rangeProblems(rules, req.query ?? {}, body);
      if (problems.length) {
        const settings = config.protocolSettings ?? {};
        const ns = typeof settings.defaultNamespace === 'string' ? [TypeRegistry.for(settings.defaultNamespace)] : [];
        throw validationError([...ns, ...((settings.errorTypeRegistries as TypeRegistry[] | undefined) ?? [])], problems);
      }
    }
    return next(args);
  };
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
    try {
      return await next(args);
    } catch (err) {
      // An operation the server does not have (PROTOCOL.md 9): its routing answers 404 UNKNOWN_OPERATION or 405
      // METHOD_NOT_ALLOWED, even before this client has seen the server's version. A 405 without that code (a
      // proxy's) stays the generic error.
      if (op && isUnknownOperation(err)) {
        throw Object.assign(new NotSupportedByServer(op, since.get(op) ?? 'unknown', server ?? 'unknown'), { cause: err });
      }
      throw err;
    }
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
      stack.add(rangeCheck, { step: 'build', name: 'caitlynRangeCheck', priority: 'high', override: true });
      stack.addRelativeTo(retrySafety, { toMiddleware: 'retryMiddleware', relation: 'after', name: 'caitlynRetrySafety' });
    },
  };
}
