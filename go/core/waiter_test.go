package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

// waitForever polls a resource that never reaches a success or failure state.
func waitForever(ctx context.Context, maxWait time.Duration, opts ...WaiterOption) (int, time.Duration, error) {
	polls := 0
	start := time.Now()
	_, err := Wait(ctx, "Ready", 5*time.Millisecond, 10*time.Millisecond, maxWait, opts,
		func(context.Context) (struct{}, error) { polls++; return struct{}{}, nil },
		func(struct{}, error) WaitState { return WaitRetry })
	return polls, time.Since(start), err
}

func timedOut(err error) bool {
	var we *WaiterError
	return errors.As(err, &we) && we.State == "timeout"
}

// The waiter's own limit (from the model's waitLimits) bounds the wait.
func TestWaitUsesTheWaitersOwnLimit(t *testing.T) {
	polls, took, err := waitForever(context.Background(), 60*time.Millisecond)
	if !timedOut(err) || polls < 2 || took > 500*time.Millisecond {
		t.Fatalf("err %v after %d polls in %v, want a timeout near 60 ms", err, polls, took)
	}
}

// WithMaxWait replaces the waiter's own limit, shorter or longer.
func TestWithMaxWaitOverridesTheWaitersLimit(t *testing.T) {
	_, took, err := waitForever(context.Background(), time.Hour, WithMaxWait(40*time.Millisecond))
	if !timedOut(err) || took > 500*time.Millisecond {
		t.Fatalf("err %v after %v, want a timeout near 40 ms in place of the hour", err, took)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	// The context's deadline is the nearer limit now, so the wait lasts about 150 ms, not the waiter's 20 ms.
	_, took, err = waitForever(ctx, 20*time.Millisecond, WithMaxWait(time.Hour))
	if err == nil || took < 100*time.Millisecond {
		t.Fatalf("err %v after %v, want WithMaxWait(1h) to outlast the waiter's 20 ms", err, took)
	}
}

// Without a limit from the model, the wait falls back to DefaultMaxWait (300 s), so only a short context ends it.
func TestWaitFallsBackToTheDefaultLimit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, took, err := waitForever(ctx, 0); err == nil || took < 60*time.Millisecond {
		t.Fatalf("err %v after %v, want the wait to last until the context's deadline", err, took)
	}
	if DefaultMaxWait != 300*time.Second {
		t.Fatalf("DefaultMaxWait is %v, want 300 s (PROTOCOL.md 10.1)", DefaultMaxWait)
	}
}
