// Package core is the hand-written runtime behind the generated Caitlyn Go SDK (github.com/caitlyn-ai/caitlyn-go).
//
// It implements the wire protocol ai.caitlyn.protocols#restJson as model/PROTOCOL.md describes it: request
// headers, bearer authentication, retries, RFC 9457 errors chosen by status, server-sent event streams with
// resume, pagination, waiters, presigned uploads, @since checks and OpenTelemetry spans. Generated code
// describes each operation and calls into this package; it holds no protocol logic of its own.
//
// The package reads no AWS configuration: no AWS_* environment variable, no ~/.aws file, no instance metadata.
package core

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// SDKInfo identifies the generated SDK that owns a client. Generated code fills it in.
type SDKInfo struct {
	// Version is the SDK's own version, for the user agent.
	Version string
	// ModelVersion is the highest @since in the model, sent as Caitlyn-Sdk-Model.
	ModelVersion string
}

// HTTPDoer is the part of *http.Client the runtime uses.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type settings struct {
	endpoint       string
	httpClient     HTTPDoer
	maxAttempts    int
	maxRetryDelay  time.Duration
	tracerProvider trace.TracerProvider
	propagator     propagation.TextMapPropagator
	appID          string
}

// Option configures a client.
type Option func(*settings)

// WithEndpoint sends requests to endpoint (for example "http://127.0.0.1:4010") instead of https://<workspace>/api.
func WithEndpoint(endpoint string) Option {
	return func(s *settings) { s.endpoint = strings.TrimRight(endpoint, "/") }
}

// WithHTTPClient replaces the default *http.Client.
func WithHTTPClient(c HTTPDoer) Option { return func(s *settings) { s.httpClient = c } }

// WithMaxAttempts sets the number of attempts for a retry-safe operation, the first included (default 3).
func WithMaxAttempts(n int) Option { return func(s *settings) { s.maxAttempts = n } }

// WithMaxRetryDelay sets the longest Retry-After the client waits for (default 60 s). A longer
// Retry-After fails the call at once with the typed error.
func WithMaxRetryDelay(d time.Duration) Option { return func(s *settings) { s.maxRetryDelay = d } }

// WithTracerProvider sets the OpenTelemetry tracer provider (default: the global one, a no-op unless set).
func WithTracerProvider(tp trace.TracerProvider) Option {
	return func(s *settings) { s.tracerProvider = tp }
}

// WithPropagator sets the OpenTelemetry propagator that writes traceparent, tracestate and baggage
// (default: the global one, which sends nothing unless set).
func WithPropagator(p propagation.TextMapPropagator) Option {
	return func(s *settings) { s.propagator = p }
}

// WithAppID adds app/<id> to the user agent.
func WithAppID(id string) Option { return func(s *settings) { s.appID = id } }

// Client is the runtime half of a generated client. It is safe for concurrent use.
type Client struct {
	s         settings
	auth      Auth
	sdk       SDKInfo
	userAgent string
	tracer    trace.Tracer

	mu            sync.Mutex
	serverVersion string
}

// WorkspaceEndpoint is the base URL of a workspace's API: its hostname, over HTTPS, with the /api prefix
// every Caitlyn route has. Operation paths (/v3/…) are appended to it.
func WorkspaceEndpoint(workspace string) string {
	host := workspace
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	return "https://" + strings.TrimRight(host, "/") + "/api"
}

// Endpoint is the base URL requests are sent to.
func (c *Client) Endpoint() string { return c.s.endpoint }

// NewClient returns a runtime client for workspace (for example "your-company.getcaitlyn.ai").
func NewClient(sdk SDKInfo, workspace string, auth Auth, opts ...Option) (*Client, error) {
	s := settings{maxAttempts: 3, maxRetryDelay: 60 * time.Second}
	for _, o := range opts {
		o(&s)
	}
	if s.endpoint == "" {
		if workspace == "" {
			return nil, errors.New("caitlyn: a workspace or caitlyn.WithEndpoint is required")
		}
		s.endpoint = WorkspaceEndpoint(workspace)
	}
	if auth == nil {
		return nil, errors.New("caitlyn: auth is required (for example caitlyn.Token(\"pat_…\"))")
	}
	if s.httpClient == nil {
		s.httpClient = &http.Client{}
	}
	if s.maxAttempts < 1 {
		s.maxAttempts = 1
	}
	if s.tracerProvider == nil {
		s.tracerProvider = otel.GetTracerProvider()
	}
	if s.propagator == nil {
		s.propagator = otel.GetTextMapPropagator()
	}
	c := &Client{s: s, auth: auth, sdk: sdk}
	c.userAgent = userAgent(sdk.Version, s.appID)
	c.tracer = s.tracerProvider.Tracer("github.com/caitlyn-ai/caitlyn-go", trace.WithInstrumentationVersion(sdk.Version))
	return c, nil
}

// userAgent follows PROTOCOL.md 3.1: caitlyn-sdk-go/<v> lang/go#<goVersion> md/<compiler> os/<os> [app/<id>].
func userAgent(version, appID string) string {
	goVersion := strings.TrimPrefix(runtime.Version(), "go")
	if i := strings.IndexAny(goVersion, " "); i >= 0 {
		goVersion = goVersion[:i]
	}
	ua := "caitlyn-sdk-go/" + version + " lang/go#" + goVersion + " md/" + runtime.Compiler + " os/" + runtime.GOOS
	if appID != "" {
		ua += " app/" + appID
	}
	return ua
}

// ServerVersion is the latest Caitlyn-Api-Version this client has seen, or "" before any response.
func (c *Client) ServerVersion() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.serverVersion
}

func (c *Client) noteServerVersion(v string) {
	if v == "" {
		return
	}
	c.mu.Lock()
	c.serverVersion = v
	c.mu.Unlock()
}

// Auth adds credentials to a request.
type Auth interface {
	Authorize(ctx context.Context, req *http.Request) error
}

// Token is a static bearer token (a personal access token or an API key).
type Token string

// Authorize sets Authorization: Bearer <token>.
func (t Token) Authorize(_ context.Context, req *http.Request) error {
	req.Header.Set("Authorization", "Bearer "+string(t))
	return nil
}

// TokenFunc returns a bearer token for each request, for tokens that are refreshed elsewhere.
type TokenFunc func(ctx context.Context) (string, error)

// Authorize calls f and sets Authorization: Bearer <token>.
func (f TokenFunc) Authorize(ctx context.Context, req *http.Request) error {
	tok, err := f(ctx)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	return nil
}
