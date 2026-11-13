---
pageType: concept
sinceVersion: 5000115000000
resources: []
integrations: []
operations: []
---

# Telemetry

Every SDK records each call as [OpenTelemetry](https://opentelemetry.io/) spans, with the same names and
attributes in every language, so a trace looks the same whichever SDK made it. TypeScript, Python and Go use the
OpenTelemetry API, which records nothing until you configure a tracer provider; Rust uses `tracing` spans, which
`tracing-opentelemetry` turns into the same OpenTelemetry spans.

<!-- example: examples/typescript/concepts.ts#telemetry -->
```ts tab="TypeScript"
const traced = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
  telemetry: { tracerProvider: trace.getTracerProvider() }, // default: the global provider; enabled: false turns spans off
});
```
<!-- example: examples/python/concepts.py#telemetry -->
```python tab="Python"
traced = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=Token(os.environ["CAITLYN_TOKEN"]),
    tracer_provider=trace.get_tracer_provider(),  # default: the global provider
)
```
<!-- example: examples/go/concepts/concepts.go#telemetry -->
```go tab="Go"
traced, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")),
	caitlyn.WithTracerProvider(otel.GetTracerProvider()), // default: the global provider
	caitlyn.WithPropagator(propagation.TraceContext{}),   // default: the global propagator
)
```

In Rust, install a `tracing` subscriber (with `tracing-opentelemetry` for OpenTelemetry), and give the client
builder a `propagator` to send trace context.

## The spans

| Span | One per | Attributes |
| --- | --- | --- |
| `caitlyn.call` | call | `rpc.system` (`caitlyn`), `rpc.method` (the operation, such as `GetAgentVersion`), `caitlyn.request_id` (the last attempt's) |
| `caitlyn.attempt` | HTTP attempt, a child of the call | `http.request.method`, `server.address`, `url.full`, `http.request.resend_count` (0 for the first), and once a response arrives `http.response.status_code`, `caitlyn.request_id` and `caitlyn.server.api_version` |
| `caitlyn.upload` | file upload by an upload helper | `http.request.method`, `server.address`, `url.full`, `http.response.status_code` |

All are client spans; the call and upload spans are children of whatever span is current when you make the call.

- **`url.full` never has the query string**, a fragment or user information: an upload address's query is its
  signature.
- **A failure** sets the span's status to error with the error's message, `error.type` to the error's class
  (`NotFoundError`, `CaitlynError`, `CaitlynConnectionError`, `CaitlynAuthError`, `NotSupportedByServer`, the same
  in every SDK), `caitlyn.error.code` to its code, and records an `exception` event. An attempt fails when its
  response is 400 or above, or when no response arrived.

## Trace context

When a propagator is configured, each attempt sends `traceparent`, `tracestate` and `baggage` from its span, so
Caitlyn's own traces can be linked to yours. With none configured, nothing is sent. Caitlyn links a trace you
send to its own rather than making its spans children of yours.
