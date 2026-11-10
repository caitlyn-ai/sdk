package core

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// APIError is an RFC 9457 problem returned by Caitlyn, or raised by the SDK itself (Status 0, with the
// codes STREAM_LOST, NO_FINAL_EVENT or UPLOAD_PUT_FAILED). Generated typed errors (NotFoundError and so on)
// embed it, so errors.As works with either the typed error or *APIError.
type APIError struct {
	// Status is the HTTP status (body status, else the response's), or 0 for errors the SDK raises itself.
	Status int
	// Code is the stable, documented product code, for example NOT_FOUND.
	Code   string
	Title  string
	Detail string
	// Type is the code's page in the public error reference, https://build.caitlyn.ai/errors/{code}.
	Type string
	// RequestID is the body's requestId, else the Caitlyn-Request-Id header.
	RequestID string
	// RetryAfterSeconds is Retry-After on 429 and 503 responses.
	RetryAfterSeconds *int
	// Errors lists the field-level problems of a 400 VALIDATION_FAILED.
	Errors []FieldError
	// Cause is the underlying failure for errors the SDK raises itself.
	Cause error

	raw Raw
}

func (e *APIError) Error() string {
	var b strings.Builder
	b.WriteString("caitlyn: ")
	if e.Status != 0 {
		b.WriteString(strconv.Itoa(e.Status))
		b.WriteByte(' ')
	}
	b.WriteString(e.Code)
	if e.Title != "" {
		b.WriteString(": ")
		b.WriteString(e.Title)
	}
	if e.Detail != "" {
		b.WriteString(" (")
		b.WriteString(e.Detail)
		b.WriteByte(')')
	}
	if e.RequestID != "" {
		b.WriteString(" [")
		b.WriteString(e.RequestID)
		b.WriteByte(']')
	}
	if e.Cause != nil {
		b.WriteString(": ")
		b.WriteString(e.Cause.Error())
	}
	return b.String()
}

// Unwrap returns the cause of an error the SDK raised itself.
func (e *APIError) Unwrap() error { return e.Cause }

// Raw returns the problem body as received, unknown fields included (nil if the body was not JSON).
func (e *APIError) Raw() map[string]any { return e.raw.Map() }

// FieldError is one problem with one request member (Pointer, a JSON Pointer into the body) or query
// parameter (Parameter).
type FieldError struct {
	Pointer   string `json:"pointer,omitempty"`
	Parameter string `json:"parameter,omitempty"`
	Code      string `json:"code"`
	Detail    string `json:"detail,omitempty"`
}

// sdkError is an error the SDK raises itself (PROTOCOL.md 6.3).
func sdkError(code, title string, cause error) *APIError {
	return &APIError{Code: code, Title: title, Cause: cause}
}

// ErrorFor builds the typed error for a status from an operation's error table: the generated
// constructors wrap the *APIError; with no match the *APIError itself is the error.
type ErrorFor func(status int, e *APIError) error

func problemFromBody(status int, header http.Header, body []byte) *APIError {
	e := &APIError{Status: status}
	var p struct {
		Type      string       `json:"type"`
		Title     string       `json:"title"`
		Status    int          `json:"status"`
		Detail    string       `json:"detail"`
		Code      string       `json:"code"`
		RequestID string       `json:"requestId"`
		Errors    []FieldError `json:"errors"`
	}
	if json.Unmarshal(body, &p) == nil {
		e.raw = NewRaw(body)
		e.Type, e.Title, e.Detail, e.Code, e.RequestID, e.Errors = p.Type, p.Title, p.Detail, p.Code, p.RequestID, p.Errors
		if p.Status != 0 {
			e.Status = p.Status
		}
	}
	if e.RequestID == "" && header != nil {
		e.RequestID = header.Get("Caitlyn-Request-Id")
	}
	if e.Code == "" {
		e.Code = "HTTP_" + strconv.Itoa(status)
	}
	if header != nil && (status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable) {
		if d, ok := parseRetryAfter(header.Get("Retry-After"), time.Now()); ok {
			secs := int((d + time.Second - 1) / time.Second)
			e.RetryAfterSeconds = &secs
		}
	}
	return e
}

// ProblemFromEvent builds the error for an SSE failure event, such as message.failed (PROTOCOL.md 5.5).
func ProblemFromEvent(data []byte, errorFor ErrorFor) error {
	e := problemFromBody(0, nil, data)
	if errorFor != nil {
		return errorFor(e.Status, e)
	}
	return e
}

// parseRetryAfter reads delta-seconds or an HTTP-date.
func parseRetryAfter(v string, now time.Time) (time.Duration, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	if n, err := strconv.Atoi(v); err == nil && n >= 0 {
		return time.Duration(n) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := t.Sub(now)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

// NotSupportedByServerError is returned before anything is sent when an operation, or a member the caller
// set, is newer than the server's Caitlyn-Api-Version (PROTOCOL.md 9).
type NotSupportedByServerError struct {
	// Operation is the operation name; Member is set when a member, not the operation, is too new.
	Operation, Member string
	// Requires is the @since version; Server is the server's version.
	Requires, Server string
}

func (e *NotSupportedByServerError) Error() string {
	what := e.Operation
	if e.Member != "" {
		what += "." + e.Member
	}
	return fmt.Sprintf("caitlyn: %s needs Caitlyn %s; the server is %s", what, e.Requires, e.Server)
}

// InputError is returned before anything is sent when the input is incomplete.
type InputError struct {
	Operation, Member, Reason string
}

func (e *InputError) Error() string {
	return fmt.Sprintf("caitlyn: %s: %s %s", e.Operation, e.Member, e.Reason)
}

// MissingInput reports a required member left empty.
func MissingInput(op, member string) error {
	return &InputError{Operation: op, Member: member, Reason: "is required"}
}
