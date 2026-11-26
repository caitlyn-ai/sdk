// Package traces is "your own traces": OpenTelemetry traces of the CLI's own calls, exported over OTLP/HTTP to a
// collector you run. It is off unless an OTLP endpoint is set (traces.otlp_endpoint in your user file, or the
// standard OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT), and OTEL_SDK_DISABLED=true turns it
// off whatever is set.
//
// It has nothing to do with "usage data for Caitlyn" (package telemetry): neither reads the other's settings, so
// turning one on never turns the other on.
//
// Each run has a root span named after the command ("caitlyn kb sync"), and the Go SDK adds a span per API call
// (caitlyn.call, and caitlyn.attempt per attempt) under it, and sends W3C traceparent with each request. Spans hold
// operations, timings, status codes and request IDs: never a token, the Authorization header, a request or response
// body, or an argument's value.
package traces

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// ShutdownTimeout bounds the flush at exit, so a dead or slow collector costs a command about a second at most.
const ShutdownTimeout = time.Second

// DefaultServiceName is service.name when OTEL_SERVICE_NAME doesn't set one.
const DefaultServiceName = "caitlyn-cli"

// Settings are what decide whether traces are exported, and where.
type Settings struct {
	// Lookup reads the environment (the run's, so tests can set it).
	Lookup func(string) (string, bool)
	// Endpoint is traces.otlp_endpoint (from the user file, or OTEL_EXPORTER_OTLP_ENDPOINT): the collector's base URL,
	// to which /v1/traces is added.
	Endpoint string
	// Version is the CLI's, for service.version.
	Version string
}

// Run is one run's tracing: Provider and Propagator go to the SDK's client; End closes the root span and flushes.
type Run struct {
	Provider   trace.TracerProvider
	Propagator propagation.TextMapPropagator
	root       trace.Span
	sdk        *sdktrace.TracerProvider
}

// On reports whether this run exports traces.
func (r *Run) On() bool { return r != nil && r.sdk != nil }

func (s Settings) env(k string) string {
	if s.Lookup == nil {
		return ""
	}
	v, _ := s.Lookup(k)
	return strings.TrimSpace(v)
}

// tracesURL is where spans go: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as it is, else the base endpoint plus /v1/traces
// (the OTLP/HTTP specification's rule), or "" when nothing is set or OTEL_SDK_DISABLED is true.
func (s Settings) tracesURL() string {
	if strings.EqualFold(s.env("OTEL_SDK_DISABLED"), "true") {
		return ""
	}
	if v := s.env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"); v != "" {
		return v
	}
	base := strings.TrimSpace(s.Endpoint)
	if base == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/v1/traces"
}

// headers parses OTEL_EXPORTER_OTLP_HEADERS (and the traces-only variable, which wins for a key it names):
// key=value pairs separated by commas, values URL-encoded, as the OpenTelemetry specification says.
func (s Settings) headers() map[string]string {
	out := map[string]string{}
	for _, name := range []string{"OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"} {
		for k, v := range pairs(s.env(name)) {
			out[k] = v
		}
	}
	return out
}

// pairs parses k=v,k2=v2 with URL-encoded keys and values; malformed pairs are skipped.
func pairs(s string) map[string]string {
	out := map[string]string{}
	for _, p := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(p, "=")
		if !ok {
			continue
		}
		k, err1 := url.QueryUnescape(strings.TrimSpace(k))
		v, err2 := url.QueryUnescape(strings.TrimSpace(v))
		if err1 != nil || err2 != nil || k == "" {
			continue
		}
		out[k] = v
	}
	return out
}

// Start begins a run's tracing. With no endpoint it returns a Run whose On is false and whose End does nothing. The
// context it returns carries the root span: pass it to the command, so the SDK's spans are its children.
func Start(ctx context.Context, s Settings) (context.Context, *Run) {
	target := s.tracesURL()
	if target == "" {
		return ctx, &Run{}
	}
	opts := []otlptracehttp.Option{otlptracehttp.WithEndpointURL(target), otlptracehttp.WithTimeout(ShutdownTimeout)}
	if h := s.headers(); len(h) > 0 {
		opts = append(opts, otlptracehttp.WithHeaders(h))
	}
	// Export once, at exit: no retries that would hold a command past ShutdownTimeout
	opts = append(opts, otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}))
	// A failed export is the collector's business, never the command's output: OpenTelemetry's default handler would
	// print it on stderr
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) {}))
	exp, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		return ctx, &Run{}
	}
	name := s.env("OTEL_SERVICE_NAME")
	if name == "" {
		name = DefaultServiceName
	}
	// OTEL_RESOURCE_ATTRIBUTES first, so OTEL_SERVICE_NAME and the CLI's own version win over it
	var attrs []attribute.KeyValue
	for k, v := range pairs(s.env("OTEL_RESOURCE_ATTRIBUTES")) {
		attrs = append(attrs, attribute.String(k, v))
	}
	if s.env("OTEL_SERVICE_NAME") != "" || !hasKey(attrs, "service.name") {
		attrs = append(attrs, attribute.String("service.name", name))
	}
	attrs = append(attrs, attribute.String("service.version", s.Version))
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(time.Hour)), // sent at End, not on a timer mid-command
		sdktrace.WithResource(resource.NewSchemaless(dedupe(attrs)...)),
	)
	ctx, root := tp.Tracer("caitlyn-cli").Start(ctx, "caitlyn", trace.WithSpanKind(trace.SpanKindInternal))
	return ctx, &Run{Provider: tp, Propagator: propagation.TraceContext{}, root: root, sdk: tp}
}

func hasKey(attrs []attribute.KeyValue, k string) bool {
	for _, a := range attrs {
		if string(a.Key) == k {
			return true
		}
	}
	return false
}

// dedupe keeps the last value of each key.
func dedupe(attrs []attribute.KeyValue) []attribute.KeyValue {
	idx := map[attribute.Key]int{}
	var out []attribute.KeyValue
	for _, a := range attrs {
		if i, ok := idx[a.Key]; ok {
			out[i] = a
			continue
		}
		idx[a.Key] = len(out)
		out = append(out, a)
	}
	return out
}

// End names the root span after the command that ran ("caitlyn kb sync": the path in the command tree, never an
// argument), records its exit code, and flushes, waiting at most ShutdownTimeout.
func (r *Run) End(command string, exitCode int) {
	if !r.On() {
		return
	}
	name := "caitlyn"
	if command != "" {
		name += " " + command
	}
	r.root.SetName(name)
	r.root.SetAttributes(attribute.String("cli.command", command), attribute.Int("cli.exit_code", exitCode))
	if exitCode != 0 {
		r.root.SetStatus(codes.Error, "exit code "+strconv.Itoa(exitCode))
	}
	r.root.End()
	ctx, cancel := context.WithTimeout(context.Background(), ShutdownTimeout)
	defer cancel()
	_ = r.sdk.Shutdown(ctx)
}
