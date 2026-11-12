package core

import "sync"

// The retry budget (PROTOCOL.md 6.4.6): AWS's "standard" retry quota.
const (
	// DefaultRetryBudget is the size of a client's retry budget, in tokens.
	DefaultRetryBudget  = 500
	retryCost           = 5  // a retry
	noResponseRetryCost = 10 // a retry of an attempt that got no response
	noRetryRefund       = 1  // a call that succeeded without retrying
)

// retryBudget is the retry tokens one client's calls share. A retry takes its cost; a call that succeeds gives back
// the cost of its last retry, or 1, up to the size. Safe for concurrent use.
type retryBudget struct {
	mu     sync.Mutex
	size   int
	tokens int
}

func newRetryBudget(size int) *retryBudget {
	if size < 0 {
		size = 0
	}
	return &retryBudget{size: size, tokens: size}
}

// acquire takes cost tokens for a retry, or reports false, taking nothing, when the budget cannot pay.
func (b *retryBudget) acquire(cost int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.tokens < cost {
		return false
	}
	b.tokens -= cost
	return true
}

// release gives back lastRetryCost after a call succeeded, or 1 when it did not retry.
func (b *retryBudget) release(lastRetryCost int) {
	if lastRetryCost == 0 {
		lastRetryCost = noRetryRefund
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tokens = min(b.size, b.tokens+lastRetryCost)
}
