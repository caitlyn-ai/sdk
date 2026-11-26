// Package core is the hand-written runtime behind the generated Caitlyn Go SDK (github.com/caitlyn-ai/sdk/go).
//
// It implements the wire protocol ai.caitlyn.protocols#restJson as model/PROTOCOL.md describes it: request
// headers, bearer authentication, retries, RFC 9457 errors chosen by status, server-sent event streams with
// resume, pagination, waiters, presigned uploads, @since checks and OpenTelemetry spans. Generated code
// describes each operation and calls into this package; it holds no protocol logic of its own.
//
// The package reads no AWS configuration (no AWS_* environment variable, no ~/.aws file, no instance metadata),
// except for the AWSIAM sign-in mode, which reads the AWS_* variables PROTOCOL.md section 12.2 lists.
package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"strconv"
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
	ci             string
	agent          string
	retryBudget    int
	// requestTimeout is how long an attempt waits for its response's headers; 0 waits as long as it takes.
	requestTimeout time.Duration
	// storageStallTimeout is how long a send to storage may send and receive nothing; 0 never gives up.
	storageStallTimeout time.Duration
}

// DefaultRequestTimeout is how long an API call's attempt waits for its response's headers before it fails as a
// connection failure with no response, retried as PROTOCOL.md 6.4 says. Only the headers are timed, never the body,
// so a stream, a watch and a wait stay open while events or keep-alives arrive.
const DefaultRequestTimeout = 120 * time.Second

// DefaultStorageStallTimeout is how long a send to storage may send no request bytes and receive no response before
// that attempt is abandoned and retried (PROTOCOL.md 14). It is not an overall limit: a large file on a slow link
// carries on while its bytes keep moving.
const DefaultStorageStallTimeout = 60 * time.Second

// Option configures a client.
type Option func(*settings)

// WithEndpoint sends requests to endpoint (for example "http://127.0.0.1:4010") instead of https://<workspace>/api.
func WithEndpoint(endpoint string) Option {
	return func(s *settings) { s.endpoint = strings.TrimRight(endpoint, "/") }
}

// noRedirects stops an *http.Client at a redirect, returning the 3xx response itself.
func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// WithHTTPClient replaces the default *http.Client. An *http.Client is used as a copy that does not follow redirects;
// any other HTTPDoer must not follow them itself.
func WithHTTPClient(c HTTPDoer) Option { return func(s *settings) { s.httpClient = c } }

// WithMaxAttempts sets the number of attempts for a retry-safe operation, the first included (default 3).
func WithMaxAttempts(n int) Option { return func(s *settings) { s.maxAttempts = n } }

// WithMaxRetryDelay sets the longest Retry-After the client waits for (default 60 s). A longer
// Retry-After fails the call at once with the typed error.
func WithMaxRetryDelay(d time.Duration) Option { return func(s *settings) { s.maxRetryDelay = d } }

// WithRetryBudget sets the size of the client's retry budget, in tokens (default 500). A retry costs 5, or 10 after
// an attempt that got no response; a call that succeeds gives back 1, or its last retry's cost. When the budget
// cannot pay for a retry, the call fails at once with its error. 0 turns retries off (PROTOCOL.md 6.4.6).
func WithRetryBudget(tokens int) Option { return func(s *settings) { s.retryBudget = tokens } }

// WithRequestTimeout sets how long each attempt of an API call waits for its response's headers (default 120 s);
// 0 waits as long as it takes. It never limits reading a body, so streams and waits are not cut by it.
func WithRequestTimeout(d time.Duration) Option { return func(s *settings) { s.requestTimeout = d } }

// WithStorageStallTimeout sets how long a send to storage may send and receive nothing before that attempt is
// abandoned and retried (default 60 s); 0 never gives up. It is not an overall limit (PROTOCOL.md 14).
func WithStorageStallTimeout(d time.Duration) Option {
	return func(s *settings) { s.storageStallTimeout = d }
}

// FormatTimeout writes a timeout as the SDKs' messages do: "300 ms", "1.5 s", "120 s".
func FormatTimeout(d time.Duration) string {
	if d < time.Second {
		return strconv.FormatInt(d.Milliseconds(), 10) + " ms"
	}
	return strconv.FormatFloat(d.Seconds(), 'f', -1, 64) + " s"
}

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

// WithCI adds ci/<provider> to the user agent, after app/: the CI system the application recognises it is running in
// (github, gitlab, buildkite, circleci, jenkins, azure-pipelines, bitbucket, or generic). Declared only, never used for
// authorisation (PROTOCOL.md 3.2). The value is 1 to 32 of a-z, 0-9 and -, or New fails.
func WithCI(provider string) Option { return func(s *settings) { s.ci = provider } }

// WithAgent adds agent/<name> to the user agent, after app/ and ci/: the AI agent the application recognises is
// driving it, such as claude-code. Declared only, never used for authorisation (PROTOCOL.md 3.2). The value is 1 to 32
// of a-z, 0-9 and -, or New fails.
func WithAgent(name string) Option { return func(s *settings) { s.agent = name } }

// userAgentToken reports whether v is a valid ci/ or agent/ value: 1 to 32 of a-z, 0-9 and - (PROTOCOL.md 3.2).
func userAgentToken(v string) bool {
	if len(v) < 1 || len(v) > 32 {
		return false
	}
	for _, r := range v {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// Client is the runtime half of a generated client. It is safe for concurrent use.
type Client struct {
	s         settings
	auth      *AuthSession
	sdk       SDKInfo
	userAgent string
	tracer    trace.Tracer

	budget *retryBudget

	mu            sync.Mutex
	serverVersion string
}

// WorkspaceEndpoint is the base URL of a workspace's API: its hostname, over HTTPS, with the /api prefix
// every Caitlyn route has. Operation paths (/v3/…) are appended to it.
func WorkspaceEndpoint(workspace string) string {
	return "https://" + WorkspaceHost(workspace) + "/api"
}

// Endpoint is the base URL requests are sent to.
func (c *Client) Endpoint() string { return c.s.endpoint }

// Tracer is the client's OpenTelemetry tracer, a no-op unless a provider is set: helpers record their own spans with it.
func (c *Client) Tracer() trace.Tracer { return c.tracer }

// Auth is the client's sign-in: its mode, its token, and the OAuth mode's sign-in steps.
func (c *Client) Auth() *AuthSession { return c.auth }

// NewClient returns a runtime client for workspace (for example "your-company.caitlyn.ai").
func NewClient(sdk SDKInfo, workspace string, auth Auth, opts ...Option) (*Client, error) {
	s := settings{maxAttempts: 3, maxRetryDelay: 60 * time.Second, retryBudget: DefaultRetryBudget, requestTimeout: DefaultRequestTimeout, storageStallTimeout: DefaultStorageStallTimeout}
	for _, o := range opts {
		o(&s)
	}
	if workspace != "" {
		host, err := ParseWorkspace(workspace)
		if err != nil {
			return nil, err
		}
		workspace = host
	}
	if s.endpoint == "" {
		if workspace == "" {
			_, err := ParseWorkspace(workspace) // names the expected form
			return nil, err
		}
		s.endpoint = WorkspaceEndpoint(workspace)
	}
	for _, t := range [][2]string{{"ci", s.ci}, {"agent", s.agent}} {
		if t[1] != "" && !userAgentToken(t[1]) {
			return nil, fmt.Errorf("caitlyn: the %s/ user-agent value %q must be 1 to 32 of a-z, 0-9 and -", t[0], t[1])
		}
	}
	if auth == nil {
		return nil, errors.New("caitlyn: auth is required (for example caitlyn.Token(\"cait-pat-…\"))")
	}
	// Redirects are results, not hops: an operation that answers 302 returns the address unfollowed, and nothing the
	// SDK calls is reached through one. An *http.Client given with WithHTTPClient is copied with redirects stopped (the
	// caller's own is not changed); any other HTTPDoer must not follow redirects itself.
	switch c := s.httpClient.(type) {
	case nil:
		s.httpClient = &http.Client{CheckRedirect: noRedirects}
	case *http.Client:
		own := *c
		own.CheckRedirect = noRedirects
		s.httpClient = &own
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
	c := &Client{s: s, sdk: sdk, budget: newRetryBudget(s.retryBudget)}
	c.userAgent = userAgent(sdk.Version, s.appID, s.ci, s.agent)
	c.auth = newAuthSession(auth, s.endpoint, workspace, s.httpClient, c.userAgent)
	c.tracer = s.tracerProvider.Tracer("github.com/caitlyn-ai/sdk/go", trace.WithInstrumentationVersion(sdk.Version))
	return c, nil
}

// userAgent follows PROTOCOL.md 3.1: caitlyn-sdk-go/<v> lang/go#<goVersion> md/<compiler> os/<os> [app/<id>] [ci/<provider>]
// [agent/<name>].
func userAgent(version, appID, ci, agent string) string {
	goVersion := strings.TrimPrefix(runtime.Version(), "go")
	if i := strings.IndexAny(goVersion, " "); i >= 0 {
		goVersion = goVersion[:i]
	}
	ua := "caitlyn-sdk-go/" + version + " lang/go#" + goVersion + " md/" + runtime.Compiler + " os/" + runtime.GOOS
	if appID != "" {
		ua += " app/" + appID
	}
	if ci != "" {
		ua += " ci/" + ci
	}
	if agent != "" {
		ua += " agent/" + agent
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
