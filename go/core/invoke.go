package core

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// Operation describes one modelled operation. Generated code declares one per operation.
type Operation struct {
	Name   string
	Method string
	// Since is the operation's @since.
	Since string
	// RetrySafe is true for @readonly and @idempotent operations and those with an @idempotencyToken (PROTOCOL.md 6.4).
	RetrySafe bool
	// SSE operations send Accept: text/event-stream.
	SSE bool
	// IdempotencyHeader is the header bound to the @idempotencyToken member, if any.
	IdempotencyHeader string
	// IfMatchRequired operations refuse to send without WithIfMatch.
	IfMatchRequired bool
	// Retryable lists the statuses of modelled @retryable errors.
	Retryable []int
	// Errors builds typed errors by status.
	Errors ErrorFor
}

// Since names a member the caller set and the release that introduced it.
type Since struct{ Member, Version string }

// Request is one call's HTTP request before the runtime adds its headers. Generated code fills it in.
type Request struct {
	Path        string
	Query       url.Values
	Header      http.Header
	Body        []byte
	ContentType string
	// Set lists the members the caller set that carry @since, for the version check.
	Set []Since
}

// NewRequest returns an empty request for path.
func NewRequest(path string) *Request {
	return &Request{Path: path, Query: url.Values{}, Header: http.Header{}}
}

// JSONBody marshals v (an input with json tags on its body members) as the body.
func (r *Request) JSONBody(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	r.Body, r.ContentType = b, "application/json"
	return nil
}

// CallOption configures one call.
type CallOption func(*callSettings)

type callSettings struct {
	ifMatch        *string
	idempotencyKey string
}

// WithIfMatch sends If-Match: etag, for optimistic concurrency.
func WithIfMatch(etag string) CallOption { return func(c *callSettings) { c.ifMatch = &etag } }

// WithIdempotencyKey sends this Idempotency-Key instead of a generated one.
func WithIdempotencyKey(key string) CallOption {
	return func(c *callSettings) { c.idempotencyKey = key }
}

// Response is a successful (2xx) response.
type Response struct {
	*http.Response
}

// DecodeJSON reads the body into v and closes it. An empty body leaves v as it is.
func (r *Response) DecodeJSON(v any) error {
	defer r.Body.Close()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return fmt.Errorf("caitlyn: read response: %w", err)
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("caitlyn: decode response: %w", err)
	}
	return nil
}

// HeaderPtr returns the header's value, or nil when it is absent.
func (r *Response) HeaderPtr(name string) *string {
	if vs := r.Header.Values(name); len(vs) > 0 {
		v := vs[0]
		return &v
	}
	return nil
}

// HeaderValue returns the header's value, or "".
func (r *Response) HeaderValue(name string) string { return r.Header.Get(name) }

// errNoResponse marks a failure before any response arrived (retryable on retry-safe operations).
type errNoResponse struct{ err error }

func (e *errNoResponse) Error() string { return "caitlyn: no response: " + e.err.Error() }
func (e *errNoResponse) Unwrap() error { return e.err }

// Do sends a request with retries and returns the 2xx response, whose body the caller must consume or close.
func (c *Client) Do(ctx context.Context, op *Operation, req *Request, opts []CallOption) (*Response, error) {
	var cs callSettings
	for _, o := range opts {
		o(&cs)
	}
	if err := c.checkSince(op, req); err != nil {
		return nil, err
	}
	if op.IfMatchRequired && cs.ifMatch == nil {
		return nil, &InputError{Operation: op.Name, Member: "If-Match", Reason: "is required: pass caitlyn.WithIfMatch(etag)"}
	}
	idemKey := ""
	if op.IdempotencyHeader != "" {
		idemKey = cs.idempotencyKey
		if idemKey == "" {
			idemKey = uuid4()
		}
	}

	ctx, span := c.tracer.Start(ctx, "caitlyn "+op.Name, trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.String("rpc.system", "caitlyn"), attribute.String("rpc.method", op.Name)))
	defer span.End()

	for attempt := 0; ; attempt++ {
		resp, err := c.attempt(ctx, op, req, &cs, idemKey, attempt)
		if resp != nil {
			span.SetAttributes(attribute.String("caitlyn.request_id", resp.Header.Get("Caitlyn-Request-Id")))
		}
		if err == nil {
			return resp, nil
		}
		var ae interface{ apiError() *APIError }
		if errors.As(err, &ae) && ae.apiError().RequestID != "" {
			span.SetAttributes(attribute.String("caitlyn.request_id", ae.apiError().RequestID))
		}
		delay, retry := c.retryDelay(ctx, op, err, attempt)
		if !retry {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			return nil, err
		}
		t := time.NewTimer(delay)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			span.SetStatus(codes.Error, ctx.Err().Error())
			return nil, ctx.Err()
		}
	}
}

func (e *APIError) apiError() *APIError { return e }

func (c *Client) attempt(ctx context.Context, op *Operation, req *Request, cs *callSettings, idemKey string, attempt int) (*Response, error) {
	ctx, span := c.tracer.Start(ctx, op.Method, trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.Int("http.request.resend_count", attempt), attribute.String("http.request.method", op.Method)))
	defer span.End()

	u := c.s.endpoint + req.Path
	if len(req.Query) > 0 {
		u += "?" + req.Query.Encode()
	}
	var body io.Reader
	if req.Body != nil {
		body = bytes.NewReader(req.Body)
	}
	hr, err := http.NewRequestWithContext(ctx, op.Method, u, body)
	if err != nil {
		return nil, err
	}
	for k, vs := range req.Header {
		hr.Header[k] = vs
	}
	hr.Header.Set("User-Agent", c.userAgent)
	hr.Header.Set("Caitlyn-Sdk-Model", c.sdk.ModelVersion)
	if req.ContentType != "" {
		hr.Header.Set("Content-Type", req.ContentType)
	}
	if op.SSE {
		hr.Header.Set("Accept", "text/event-stream")
	}
	if idemKey != "" {
		hr.Header.Set(op.IdempotencyHeader, idemKey)
	}
	if cs.ifMatch != nil {
		hr.Header.Set("If-Match", *cs.ifMatch)
	}
	if err := c.auth.Authorize(ctx, hr); err != nil {
		return nil, fmt.Errorf("caitlyn: authorise: %w", err)
	}
	c.s.propagator.Inject(ctx, propagation.HeaderCarrier(hr.Header))

	resp, err := c.s.httpClient.Do(hr)
	if err != nil {
		span.RecordError(err)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &errNoResponse{err: err}
	}
	span.SetAttributes(attribute.Int("http.response.status_code", resp.StatusCode))
	c.noteServerVersion(resp.Header.Get("Caitlyn-Api-Version"))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return &Response{Response: resp}, nil
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	ae := problemFromBody(resp.StatusCode, resp.Header, b)
	if ae.Status != resp.StatusCode {
		ae.Status = resp.StatusCode // the class is chosen by the HTTP status (PROTOCOL.md 6.2)
	}
	span.SetStatus(codes.Error, ae.Code)
	if op.Errors != nil {
		return nil, op.Errors(resp.StatusCode, ae)
	}
	return nil, ae
}

// retryDelay applies PROTOCOL.md 6.4.
func (c *Client) retryDelay(ctx context.Context, op *Operation, err error, attempt int) (time.Duration, bool) {
	if !op.RetrySafe || attempt+1 >= c.s.maxAttempts || ctx.Err() != nil {
		return 0, false
	}
	var nr *errNoResponse
	if errors.As(err, &nr) {
		return backoff(attempt), true
	}
	var ae interface{ apiError() *APIError }
	if !errors.As(err, &ae) {
		return 0, false
	}
	e := ae.apiError()
	retryable := false
	for _, s := range op.Retryable {
		retryable = retryable || s == e.Status
	}
	if !retryable {
		return 0, false
	}
	if e.RetryAfterSeconds != nil {
		d := time.Duration(*e.RetryAfterSeconds) * time.Second
		if d > c.s.maxRetryDelay {
			return 0, false
		}
		return d, true
	}
	return backoff(attempt), true
}

// backoff is full-jitter exponential: random(0, min(8 s, 0.5 s × 2^retry)).
func backoff(retry int) time.Duration {
	ceil := 500 * time.Millisecond << retry
	if ceil > 8*time.Second || ceil <= 0 {
		ceil = 8 * time.Second
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(ceil)))
	if err != nil {
		return ceil / 2
	}
	return time.Duration(n.Int64())
}

func (c *Client) checkSince(op *Operation, req *Request) error {
	server := c.ServerVersion()
	if server == "" {
		return nil
	}
	if op.Since != "" && CompareVersions(op.Since, server) > 0 {
		return &NotSupportedByServerError{Operation: op.Name, Requires: op.Since, Server: server}
	}
	for _, m := range req.Set {
		if CompareVersions(m.Version, server) > 0 {
			return &NotSupportedByServerError{Operation: op.Name, Member: m.Member, Requires: m.Version, Server: server}
		}
	}
	return nil
}

// CompareVersions compares dotted numeric versions.
func CompareVersions(a, b string) int {
	x, y := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(x) || i < len(y); i++ {
		var xi, yi int
		if i < len(x) {
			xi, _ = strconv.Atoi(x[i])
		}
		if i < len(y) {
			yi, _ = strconv.Atoi(y[i])
		}
		if xi != yi {
			if xi < yi {
				return -1
			}
			return 1
		}
	}
	return 0
}

func uuid4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// PathLabel escapes a label value for one path segment.
func PathLabel(v string) string { return url.PathEscape(v) }

// FormatTime formats a timestamp as RFC 3339 with milliseconds and Z (PROTOCOL.md 3).
func FormatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
