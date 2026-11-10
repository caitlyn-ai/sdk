package core

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"time"
)

// WaitState is an acceptor's verdict (Smithy waiters: success, failure, retry).
type WaitState int

const (
	// WaitRetry polls again.
	WaitRetry WaitState = iota
	// WaitSuccess stops and returns the output.
	WaitSuccess
	// WaitFailure stops with a *WaiterError.
	WaitFailure
)

// WaiterOption configures one wait.
type WaiterOption func(*waitSettings)

type waitSettings struct {
	maxWait            time.Duration
	minDelay, maxDelay time.Duration
}

// WithMaxWait bounds the whole wait (default 5 minutes). A context deadline also bounds it.
func WithMaxWait(d time.Duration) WaiterOption { return func(w *waitSettings) { w.maxWait = d } }

// WithWaitDelays overrides the model's minDelay and maxDelay.
func WithWaitDelays(minDelay, maxDelay time.Duration) WaiterOption {
	return func(w *waitSettings) { w.minDelay, w.maxDelay = minDelay, maxDelay }
}

// WaiterError reports a wait that reached a failure state, an unexpected error, or its time limit.
type WaiterError struct {
	Waiter string
	// State is "failure" (a failure acceptor matched or an error matched no acceptor) or "timeout".
	State    string
	Attempts int
	// Err is the last error seen, if any.
	Err error
}

func (e *WaiterError) Error() string {
	msg := fmt.Sprintf("caitlyn: waiter %s: %s after %d attempts", e.Waiter, e.State, e.Attempts)
	if e.Err != nil {
		msg += ": " + e.Err.Error()
	}
	return msg
}

// Unwrap returns the last error seen.
func (e *WaiterError) Unwrap() error { return e.Err }

// Wait polls until accept says success or failure, following the Smithy waiter retry rules: the first
// attempt at once, then a random delay between minDelay and an exponentially growing ceiling capped at
// maxDelay, never past the time limit.
func Wait[O any](ctx context.Context, name string, minDelay, maxDelay time.Duration, opts []WaiterOption,
	poll func(ctx context.Context) (O, error), accept func(out O, err error) WaitState) (O, error) {
	w := waitSettings{maxWait: 5 * time.Minute, minDelay: minDelay, maxDelay: maxDelay}
	for _, o := range opts {
		o(&w)
	}
	deadline := time.Now().Add(w.maxWait)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	var zero O
	for attempt := 1; ; attempt++ {
		out, err := poll(ctx)
		if ctx.Err() != nil {
			return zero, ctx.Err()
		}
		switch accept(out, err) {
		case WaitSuccess:
			return out, nil
		case WaitFailure:
			return zero, &WaiterError{Waiter: name, State: "failure", Attempts: attempt, Err: err}
		}
		delay := waiterDelay(attempt, w.minDelay, w.maxDelay)
		remaining := time.Until(deadline)
		if remaining <= w.minDelay {
			return zero, &WaiterError{Waiter: name, State: "timeout", Attempts: attempt, Err: err}
		}
		if delay > remaining-w.minDelay {
			delay = remaining - w.minDelay
		}
		t := time.NewTimer(delay)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return zero, ctx.Err()
		}
	}
}

func waiterDelay(attempt int, minDelay, maxDelay time.Duration) time.Duration {
	ceil := maxDelay
	if attempt < 30 {
		if c := minDelay << (attempt - 1); c > 0 && c < maxDelay {
			ceil = c
		}
	}
	if ceil <= minDelay {
		return minDelay
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(ceil-minDelay)))
	if err != nil {
		return minDelay
	}
	return minDelay + time.Duration(n.Int64())
}
