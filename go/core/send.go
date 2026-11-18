package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// HTTPStatusError is a response from an upload URL that is not 2xx: its status and the start of its body (at most
// 64 KiB), which for storage is usually XML naming the reason.
type HTTPStatusError struct {
	Status int
	Body   []byte
}

func (e *HTTPStatusError) Error() string {
	body := strings.TrimSpace(string(e.Body))
	if len(body) > 512 {
		body = body[:512] + "…"
	}
	if body == "" {
		return fmt.Sprintf("HTTP %d", e.Status)
	}
	return fmt.Sprintf("HTTP %d: %s", e.Status, body)
}

// uploadBodyLimit is how much of an upload URL's response body is kept.
const uploadBodyLimit = 64 << 10

// SendRaw sends bytes to an upload URL outside the Caitlyn API (a presigned PUT, a form POST under an upload
// policy): only the headers build gives, no SDK header and no credentials, in a caitlyn.upload span (PROTOCOL.md 13).
// build makes each attempt's body afresh, with its headers and length. The send is retried as a retry-safe call is
// (PROTOCOL.md 6.4: 429 and 503, honouring Retry-After up to the client's limit, and no response, within the client's
// attempts and retry budget). It returns the last response's status and the start of its body, or the error that
// stopped it: build's, the context's, or the network's once the retries are spent.
func (c *Client) SendRaw(ctx context.Context, method, url string, build func() (io.ReadCloser, map[string]string, int64, error)) (status int, body []byte, err error) {
	ctx, span := c.tracer.Start(ctx, "caitlyn.upload", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(httpAttributes(method, url)...))
	defer func() {
		if err == nil && (status < 200 || status >= 300) {
			recordFailure(span, sdkError("UPLOAD_PUT_FAILED", "The upload URL refused the bytes", &HTTPStatusError{Status: status, Body: body}))
		} else if err != nil {
			recordFailure(span, err)
		}
		span.End()
	}()
	lastRetryCost := 0
	for attempt := 0; ; attempt++ {
		rc, headers, length, err := build()
		if err != nil {
			return 0, nil, err
		}
		// The stall timer (PROTOCOL.md 14): the attempt's own context is cancelled when it has sent no bytes and received
		// no response for the client's storage stall timeout; each read of the body as it is sent starts the wait again.
		actx, cancel := context.WithCancelCause(ctx)
		var stall *time.Timer
		if d := c.s.storageStallTimeout; d > 0 {
			stall = time.AfterFunc(d, func() { cancel(&storageStallError{after: d}) })
			rc = &touchingReader{ReadCloser: rc, touch: func() { stall.Reset(d) }}
		}
		req, err := http.NewRequestWithContext(actx, method, url, rc)
		if err != nil {
			cancel(nil)
			rc.Close()
			return 0, nil, err
		}
		req.ContentLength = length
		// Only the headers given: Go would otherwise add its own User-Agent.
		req.Header.Set("User-Agent", "")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := c.s.httpClient.Do(req)
		if stall != nil && !stall.Stop() && err == nil {
			resp.Body.Close()
			resp, err = nil, context.Cause(actx)
		}
		if err != nil {
			var stalled *storageStallError
			if errors.As(context.Cause(actx), &stalled) {
				err = stalled
			}
		}
		var delay time.Duration
		cost := retryCost
		if err != nil {
			cancel(nil)
			if ctx.Err() != nil {
				return 0, nil, ctx.Err()
			}
			if attempt+1 >= c.s.maxAttempts {
				return 0, nil, err
			}
			delay, cost = backoff(attempt), noResponseRetryCost
		} else {
			status = resp.StatusCode
			body, _ = io.ReadAll(io.LimitReader(resp.Body, uploadBodyLimit))
			resp.Body.Close()
			cancel(nil)
			span.SetAttributes(attribute.Int("http.response.status_code", status))
			if status != http.StatusTooManyRequests && status != http.StatusServiceUnavailable || attempt+1 >= c.s.maxAttempts {
				if status >= 200 && status < 300 {
					c.budget.release(lastRetryCost)
				}
				return status, body, nil
			}
			delay = backoff(attempt)
			if d, ok := parseRetryAfter(resp.Header.Get("Retry-After"), time.Now()); ok {
				if d > c.s.maxRetryDelay {
					return status, body, nil
				}
				delay = d
			}
		}
		if !c.budget.acquire(cost) {
			if err != nil {
				return 0, nil, err
			}
			return status, body, nil
		}
		lastRetryCost = cost
		t := time.NewTimer(delay)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return 0, nil, ctx.Err()
		}
	}
}

// storageStallError is a send to storage that sent and received nothing for the stall timeout.
type storageStallError struct{ after time.Duration }

func (e *storageStallError) Error() string {
	return "storage sent nothing for " + FormatTimeout(e.after)
}

// Timeout reports true, as net.Error's does.
func (e *storageStallError) Timeout() bool { return true }

// touchingReader calls touch each time the transport reads a chunk of the body to send.
type touchingReader struct {
	io.ReadCloser
	touch func()
}

func (r *touchingReader) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		r.touch()
	}
	return n, err
}
