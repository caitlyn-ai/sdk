// OpenTelemetry for the generated client: one span per call, one child span per HTTP attempt
// (http.request.resend_count), traceparent through the global propagator. Uses only @opentelemetry/api,
// so it is a no-op until the integrator configures a provider.
import type { Pluggable, HandlerExecutionContext, FinalizeHandler, FinalizeHandlerArguments } from '@smithy/types';
import { HttpRequest, HttpResponse } from '@smithy/core/protocols';
import { context, propagation, trace, SpanKind, SpanStatusCode, type TracerProvider, type Span } from '@opentelemetry/api';

type Ctx = HandlerExecutionContext & { __caitlynSpan?: Span; __attempt?: number };

export function getCaitlynTelemetryPlugin(provider?: TracerProvider): Pluggable<any, any> {
  const tracer = (provider ?? trace.getTracerProvider()).getTracer('@caitlyn-ai/sdk', '0.0.2');
  return {
    applyToStack(stack) {
      // One client span per logical call.
      stack.add(
        (next, ctx: Ctx) => async (args) => {
          const op = ctx.commandName?.replace(/Command$/, '') ?? 'unknown';
          return tracer.startActiveSpan(`caitlyn ${op}`, { kind: SpanKind.CLIENT, attributes: { 'caitlyn.operation': op } }, async (span) => {
            ctx.__caitlynSpan = span;
            ctx.__attempt = 0;
            try {
              const out = await next(args);
              return out;
            } catch (err) {
              span.recordException(err as Error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.setAttribute('error.type', (err as Error).name);
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
          const span = tracer.startSpan(`HTTP ${(args.request as HttpRequest).method}`, { kind: SpanKind.CLIENT, attributes: { 'http.request.resend_count': attempt } }, parent);
          const req = args.request;
          if (HttpRequest.isInstance(req)) {
            span.setAttribute('server.address', req.hostname);
            propagation.inject(trace.setSpan(parent, span), req.headers);
          }
          try {
            const out = await next(args);
            if (HttpResponse.isInstance(out.response)) {
              span.setAttribute('http.response.status_code', out.response.statusCode);
              const rid = out.response.headers['caitlyn-request-id'];
              if (rid) {
                span.setAttribute('caitlyn.request_id', rid);
                ctx.__caitlynSpan?.setAttribute('caitlyn.request_id', rid);
              }
            }
            return out;
          } catch (err) {
            const res = (err as { $response?: unknown }).$response;
            if (HttpResponse.isInstance(res)) span.setAttribute('http.response.status_code', res.statusCode);
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
