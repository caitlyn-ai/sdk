//! The retry budget (PROTOCOL.md 6.4.6): AWS's "standard" retry quota. One client's calls share it; a retry takes
//! its cost, and a call that succeeds gives back the cost of its last retry, or 1, up to the size.

use std::sync::Mutex;

/// The size of a client's retry budget, in tokens.
pub(crate) const DEFAULT_RETRY_BUDGET: u32 = 500;
/// Tokens a retry costs.
pub(crate) const RETRY_COST: u32 = 5;
/// Tokens a retry costs when the attempt it repeats got no response.
pub(crate) const NO_RESPONSE_RETRY_COST: u32 = 10;
/// Tokens a call that succeeded without retrying gives back.
const NO_RETRY_REFUND: u32 = 1;

pub(crate) struct RetryBudget {
    size: u32,
    tokens: Mutex<u32>,
}

impl RetryBudget {
    pub(crate) fn new(size: u32) -> Self {
        RetryBudget {
            size,
            tokens: Mutex::new(size),
        }
    }

    /// Takes `cost` tokens for a retry, or returns false, taking nothing, when the budget cannot pay.
    pub(crate) fn acquire(&self, cost: u32) -> bool {
        let mut tokens = self.tokens.lock().expect("retry budget lock");
        if *tokens < cost {
            return false;
        }
        *tokens -= cost;
        true
    }

    /// A call succeeded: give back its last retry's cost, or 1 when it did not retry.
    pub(crate) fn release(&self, last_retry_cost: Option<u32>) {
        let mut tokens = self.tokens.lock().expect("retry budget lock");
        *tokens = (*tokens + last_retry_cost.unwrap_or(NO_RETRY_REFUND)).min(self.size);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_spend_and_successes_refund_up_to_the_size() {
        let b = RetryBudget::new(10);
        assert!(b.acquire(RETRY_COST) && b.acquire(RETRY_COST) && !b.acquire(RETRY_COST));
        b.release(Some(RETRY_COST));
        assert!(!b.acquire(NO_RESPONSE_RETRY_COST) && b.acquire(RETRY_COST));
        b.release(None);
        b.release(Some(100));
        assert_eq!(*b.tokens.lock().unwrap(), 10);
    }
}
