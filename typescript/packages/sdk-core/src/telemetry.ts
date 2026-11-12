// OpenTelemetry for the generated client (PROTOCOL.md section 13): a `caitlyn.call` span per call, a
// `caitlyn.attempt` child span per HTTP attempt, a `caitlyn.upload` span for an upload's bytes, and traceparent
// through the global propagator. Uses only @opentelemetry/api, so it is a no-op until the integrator configures
// a provider.
import type { Pluggable, HandlerExecutionContext, FinalizeHandler, FinalizeHandlerArguments } from '@smithy/types';
import { HttpRequest, HttpResponse } from '@smithy/core/protocols';
import { context, propagation, trace, SpanKind, SpanStatusCode, type TracerProvider, type Span, type Tracer } from '@opentelemetry/api';

type Ctx = HandlerExecutionContext & { __caitlynSpan?: Span; __attempt?: number };

/** The tracer every Caitlyn span comes from. */
export function caitlynTracer(provider?: TracerProvider): Tracer {
  return (provider ?? trace.getTracerProvider()).getTracer('@caitlyn-ai/sdk', '0.0.0');
}

/** `url.full` without the query or fragment, which can carry secrets (a presigned URL's signature). */
export function urlWithoutQuery(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.toString();
}

/** Ends a span with an error: status, `error.type` (the class name), `caitlyn.error.code` and an exception event. */
export function recordFailure(span: Span, err: unknown): void {
  const e = err as { name?: string; code?: unknown; message?: string };
  span.recordException(err instanceof Error ? err : { name: String(e?.name ?? 'Error'), message: String(e?.message ?? err) });
  span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message });
  span.setAttribute('error.type', e?.name ?? 'Error');
  if (typeof e?.code === 'string') span.setAttribute('caitlyn.error.code', e.code);
}

export function getCaitlynTelemetryPlugin(provider?: TracerProvider): Pluggable<any, any> {
  const tracer = caitlynTracer(provider);
  return {
    applyToStack(stack) {
      // One client span per logical call.
      stack.add(
        (next, ctx: Ctx) => async (args) => {
          const op = ctx.commandName?.replace(/Command$/, '') ?? 'unknown';
          return tracer.startActiveSpan('caitlyn.call', { kind: SpanKind.CLIENT, attributes: { 'rpc.system': 'caitlyn', 'rpc.method': op } }, async (span) => {
            ctx.__caitlynSpan = span;
            ctx.__attempt = 0;
            try {
              return await next(args);
            } catch (err) {
              recordFailure(span, err);
              throw err;
            } finally {
              span.end();
            }
          });
        },
        { step: 'initialize', name: 'caitlynTelemetryCall', priority: 'high' },
      );
      // One child span per HTTP attempt, inside the retry loop.
      stack.addRelativeTo(
        (next: FinalizeHandler<any, any>, ctx: Ctx) => async (args: FinalizeHandlerArguments<any>) => {
          const attempt = ctx.__attempt ?? 0;
          ctx.__attempt = attempt + 1;
          const parent = ctx.__caitlynSpan ? trace.setSpan(context.active(), ctx.__caitlynSpan) : context.active();
          const span = tracer.startSpan('caitlyn.attempt', { kind: SpanKind.CLIENT, attributes: { 'http.request.resend_count': attempt } }, parent);
          const req = args.request;
          if (HttpRequest.isInstance(req)) {
            span.setAttributes({
              'http.request.method': req.method,
              'server.address': req.hostname,
              'url.full': urlWithoutQuery(`${req.protocol}//${req.hostname}${req.port ? `:${req.port}` : ''}${req.path}`),
            });
            propagation.inject(trace.setSpan(parent, span), req.headers);
          }
          const response = (res: unknown) => {
            if (!HttpResponse.isInstance(res)) return;
            span.setAttribute('http.response.status_code', res.statusCode);
            const rid = res.headers['caitlyn-request-id'];
            if (rid) {
              span.setAttribute('caitlyn.request_id', rid);
              ctx.__caitlynSpan?.setAttribute('caitlyn.request_id', rid);
            }
            const api = res.headers['caitlyn-api-version'];
            if (api) span.setAttribute('caitlyn.server.api_version', api);
            if (res.statusCode >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
          };
          try {
            const out = await next(args);
            response(out.response);
            return out;
          } catch (err) {
            response((err as { $response?: unknown }).$response);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
        { toMiddleware: 'retryMiddleware', relation: 'after', name: 'caitlynTelemetryAttempt' },
      );
    },
  };
}
