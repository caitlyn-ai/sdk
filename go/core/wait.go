package core

import (
	"context"
	"iter"
	"time"
)

// WaitOption configures a Wait or Planned call: WithTimeLimit.
type WaitOption func(*WaitSettings)

// WaitSettings are a wait's options, read by the generated package.
type WaitSettings struct {
	// TimeLimit bounds the wait; zero means no limit of the SDK's own (PROTOCOL.md 16: there is no default).
	TimeLimit time.Duration
	// Progress is called with the thing's processing as the wait sees it (the generated package's Processing).
	Progress func(any)
}

// WaitSettingsOf applies a wait's options.
func WaitSettingsOf(opts []WaitOption) WaitSettings {
	var s WaitSettings
	for _, o := range opts {
		o(&s)
	}
	return s
}

// WithTimeLimit ends a wait after d with WAIT_TIMEOUT, an *APIError whose Cause is context.DeadlineExceeded.
func WithTimeLimit(d time.Duration) WaitOption { return func(w *WaitSettings) { w.TimeLimit = d } }

// WaitContext is ctx bounded by the options' time limit, if one is set. Call the cancel function when the wait ends.
func WaitContext(ctx context.Context, opts []WaitOption) (context.Context, context.CancelFunc) {
	s := WaitSettingsOf(opts)
	if s.TimeLimit > 0 {
		return context.WithTimeout(ctx, s.TimeLimit)
	}
	return context.WithCancel(ctx)
}

// Fail is an iterator that yields only err: a list whose request could not be built.
func Fail[T any](err error) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		var zero T
		yield(zero, err)
	}
}

// NewJobError is the error a failed job raises (PROTOCOL.md 16): its code and detail, with the HTTP status of the error
// class the code belongs to (0 when no class lists it), and no request id: no response carried it.
func NewJobError(status int, code, detail string) *APIError {
	return &APIError{Status: status, Code: code, Title: code, Detail: detail}
}
