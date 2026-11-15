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

// The clock Wait reads and sleeps on. Tests replace both with a virtual clock, so their timing is exact and
// a slow or paused machine cannot change their outcome.
var (
	waitNow   = time.Now
	waitTimer = func(d time.Duration) (<-chan time.Time, func() bool) {
		t := time.NewTimer(d)
		return t.C, t.Stop
	}
)

// DefaultMaxWait is the time limit of a waiter whose operation names none (PROTOCOL.md 10.1).
const DefaultMaxWait = 300 * time.Second

// WithMaxWait bounds the whole wait, in place of the waiter's own limit (the model's waitLimits for it, else
// DefaultMaxWait). A context's deadline still ends the wait, with the context's error.
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
	// Output is the last output read, when the last read returned one (an *…Result or other output pointer).
	Output any
	// Err is the last error seen, if any.
	Err error
	// Limit is the time limit the wait ran under: the waiter's own (from the model), or WithMaxWait's.
	Limit time.Duration
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
// maxDelay, never past the time limit. maxWait is the waiter's own time limit, from the model's waitLimits
// trait (0 means DefaultMaxWait); WithMaxWait replaces it.
func Wait[O any](ctx context.Context, name string, minDelay, maxDelay, maxWait time.Duration, opts []WaiterOption,
	poll func(ctx context.Context) (O, error), accept func(out O, err error) WaitState) (O, error) {
	if maxWait <= 0 {
		maxWait = DefaultMaxWait
	}
	w := waitSettings{maxWait: maxWait, minDelay: minDelay, maxDelay: maxDelay}
	for _, o := range opts {
		o(&w)
	}
	// The context's deadline or cancellation ends the wait with the context's error, never a WaiterError
	// (PROTOCOL.md 10.1): only the waiter's own limit times out.
	deadline := waitNow().Add(w.maxWait)
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
			return zero, &WaiterError{Waiter: name, State: "failure", Attempts: attempt, Output: lastOutput(out, err), Err: err, Limit: w.maxWait}
		}
		delay := waiterDelay(attempt, w.minDelay, w.maxDelay)
		remaining := deadline.Sub(waitNow())
		if remaining <= w.minDelay {
			return zero, &WaiterError{Waiter: name, State: "timeout", Attempts: attempt, Output: lastOutput(out, err), Err: err, Limit: w.maxWait}
		}
		if delay > remaining-w.minDelay {
			delay = remaining - w.minDelay
		}
		fired, stop := waitTimer(delay)
		select {
		case <-fired:
		case <-ctx.Done():
			stop()
			return zero, ctx.Err()
		}
	}
}

// lastOutput is the read's output for a WaiterError, or nil when the read failed.
func lastOutput[O any](out O, err error) any {
	if err != nil {
		return nil
	}
	return out
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
