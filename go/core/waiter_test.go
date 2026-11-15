package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

// virtualClock stands in for Wait's clock: a timer fires at once and moves the time on by its delay, so a wait runs
// in no real time and every duration a test sees is exact. When cancelAt is set, the clock cancels cancel once the
// time reaches it, as a context deadline would.
type virtualClock struct {
	start, now time.Time
	cancelAt   time.Duration
	cancel     context.CancelFunc
}

func useVirtualClock(t *testing.T) *virtualClock {
	t.Helper()
	c := &virtualClock{start: time.Unix(1_800_000_000, 0)}
	c.now = c.start
	now, timer := waitNow, waitTimer
	t.Cleanup(func() { waitNow, waitTimer = now, timer })
	waitNow = func() time.Time { return c.now }
	waitTimer = func(d time.Duration) (<-chan time.Time, func() bool) {
		c.now = c.now.Add(d)
		if c.cancel != nil && c.elapsed() >= c.cancelAt {
			c.cancel()
		}
		fired := make(chan time.Time, 1)
		fired <- c.now
		return fired, func() bool { return false }
	}
	return c
}

func (c *virtualClock) elapsed() time.Duration { return c.now.Sub(c.start) }

// waitForever polls a resource that never reaches a success or failure state (minDelay 5 ms, maxDelay 10 ms).
func waitForever(ctx context.Context, maxWait time.Duration, opts ...WaiterOption) (int, error) {
	polls := 0
	_, err := Wait(ctx, "Ready", 5*time.Millisecond, 10*time.Millisecond, maxWait, opts,
		func(context.Context) (struct{}, error) { polls++; return struct{}{}, nil },
		func(struct{}, error) WaitState { return WaitRetry })
	return polls, err
}

// timeout is the wait's *WaiterError when it timed out, else nil.
func timeout(err error) *WaiterError {
	var we *WaiterError
	if errors.As(err, &we) && we.State == "timeout" {
		return we
	}
	return nil
}

// A wait that times out stops before its limit, when the next delay would end within minDelay of it: after
// limit-minDelay and by limit.
func checkTimedOut(t *testing.T, err error, polls int, took, limit, minDelay time.Duration) {
	t.Helper()
	we := timeout(err)
	switch {
	case we == nil:
		t.Fatalf("got %v (%T) after %v and %d polls, want a timeout WaiterError at the %v limit", err, err, took, polls, limit)
	case we.Limit != limit:
		t.Fatalf("timed out under a %v limit after %v, want the %v limit", we.Limit, took, limit)
	case we.Attempts != polls:
		t.Fatalf("the WaiterError counts %d attempts, the resource was polled %d times", we.Attempts, polls)
	case polls < 2 || took < limit-minDelay || took > limit:
		t.Fatalf("timed out after %v and %d polls, want at least 2 polls and %v to %v", took, polls, limit-minDelay, limit)
	}
}

// The waiter's own limit (from the model's waitLimits) bounds the wait.
func TestWaitUsesTheWaitersOwnLimit(t *testing.T) {
	clock := useVirtualClock(t)
	polls, err := waitForever(context.Background(), 60*time.Millisecond)
	checkTimedOut(t, err, polls, clock.elapsed(), 60*time.Millisecond, 5*time.Millisecond)
}

// WithMaxWait replaces the waiter's own limit, shorter or longer.
func TestWithMaxWaitOverridesTheWaitersLimit(t *testing.T) {
	t.Run("shorter", func(t *testing.T) {
		clock := useVirtualClock(t)
		polls, err := waitForever(context.Background(), time.Hour, WithMaxWait(40*time.Millisecond))
		checkTimedOut(t, err, polls, clock.elapsed(), 40*time.Millisecond, 5*time.Millisecond)
	})
	t.Run("longer", func(t *testing.T) {
		// The waiter's own limit is 20 ms and WithMaxWait raises it to an hour, so the context, ended at 150 ms,
		// ends the wait, with the context's error and not a timeout.
		clock := useVirtualClock(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		clock.cancelAt, clock.cancel = 150*time.Millisecond, cancel
		polls, err := waitForever(ctx, 20*time.Millisecond, WithMaxWait(time.Hour))
		if !errors.Is(err, context.Canceled) || clock.elapsed() < 150*time.Millisecond {
			t.Fatalf("got %v (%T) after %v and %d polls, want the context's error at 150 ms: WithMaxWait(1h) outlasting the waiter's 20 ms",
				err, err, clock.elapsed(), polls)
		}
	})
}

// A context ends the wait with the context's error, never a WaiterError, even when it ends before the limit.
func TestTheContextEndsTheWait(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if polls, err := waitForever(ctx, time.Hour); !errors.Is(err, context.Canceled) || polls != 1 {
		t.Fatalf("got %v after %d polls, want context.Canceled after the first poll", err, polls)
	}
}

// Without a limit from the model, the wait falls back to DefaultMaxWait (300 s).
func TestWaitFallsBackToTheDefaultLimit(t *testing.T) {
	if DefaultMaxWait != 300*time.Second {
		t.Fatalf("DefaultMaxWait is %v, want 300 s (PROTOCOL.md 10.1)", DefaultMaxWait)
	}
	clock := useVirtualClock(t)
	// Delays of 1 s to 30 s keep it to a few dozen polls over the 300 s.
	polls, err := waitForever(context.Background(), 0, WithWaitDelays(time.Second, 30*time.Second))
	checkTimedOut(t, err, polls, clock.elapsed(), DefaultMaxWait, time.Second)
}
