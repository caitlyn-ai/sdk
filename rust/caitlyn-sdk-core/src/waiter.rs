//! Waiters (PROTOCOL.md 10.1): read something until it reaches the state the caller is waiting for.
//!
//! A generated `wait_until_<name>()` returns a [`Wait`], which runs when awaited:
//!
//! - the first read happens at once; before read n+1 it pauses for a random time between `min_delay` and
//!   `min(max_delay, min_delay × 2^(n−1))`, with the delays from the model unless the caller sets its own;
//! - the whole wait is limited to the waiter's default (the operation's `waitLimits`, or 300 s) or the caller's
//!   `max_wait`, and the last pause is clipped to the time left; running out is a [`WaiterError`] with reason
//!   [`WaitReason::Timeout`];
//! - the acceptors are checked in order: success returns the output (or `()` for a waiter whose success acceptors
//!   match only errors, such as `Deleted` on a 404, which has no output), failure is a [`WaiterError`] with reason
//!   [`WaitReason::Failure`]; with no match, an output is read again and an error ends the wait as a failure,
//!   carrying that error. Errors the client retries anyway (429, 503, lost connections) are retried inside each
//!   read first;
//! - cancelling (`cancel_on`, or dropping the future) ends it with the client's own cancellation error, never a
//!   [`WaiterError`].
use std::any::Any;
use std::fmt;
use std::future::IntoFuture;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::client::random_u64;
use crate::request::{BoxFuture, CallOptions};

/// What an acceptor decided about one read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitState {
    /// Stop and return the output.
    Success,
    /// Stop with a [`WaiterError`].
    Failure,
    /// Read again.
    Retry,
}

/// Why a wait ended without success.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitReason {
    /// A failure acceptor matched, or a read failed with an error no acceptor matches.
    Failure,
    /// The time limit ran out first.
    Timeout,
}

impl WaitReason {
    /// `failure` or `timeout`.
    pub fn as_str(&self) -> &'static str {
        match self {
            WaitReason::Failure => "failure",
            WaitReason::Timeout => "timeout",
        }
    }
}

/// A wait that ended without reaching its success state.
pub struct WaiterError<E> {
    /// The waiter's name in the model, for example `Indexed`.
    pub waiter: &'static str,
    /// Whether it reached a failure state or ran out of time.
    pub reason: WaitReason,
    /// How many reads were made.
    pub attempts: u32,
    /// The last read's error, when it failed.
    pub last_error: Option<E>,
    last_output: Option<Box<dyn Any + Send + Sync>>,
}

impl<E> WaiterError<E> {
    /// The last read's output, when it succeeded: `T` is the operation's output type.
    pub fn last_output<T: 'static>(&self) -> Option<&T> {
        self.last_output.as_deref().and_then(|o| o.downcast_ref::<T>())
    }
}

impl<E: fmt::Display> fmt::Display for WaiterError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.reason {
            WaitReason::Failure => write!(f, "{}: reached a failure state", self.waiter)?,
            WaitReason::Timeout => write!(f, "{}: timed out after {} reads", self.waiter, self.attempts)?,
        }
        match &self.last_error {
            Some(e) => write!(f, ": {e}"),
            None => Ok(()),
        }
    }
}

impl<E: fmt::Debug> fmt::Debug for WaiterError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WaiterError")
            .field("waiter", &self.waiter)
            .field("reason", &self.reason)
            .field("attempts", &self.attempts)
            .field("last_error", &self.last_error)
            .field("last_output", &self.last_output.is_some())
            .finish()
    }
}

impl<E: std::error::Error + 'static> std::error::Error for WaiterError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.last_error.as_ref().map(|e| e as _)
    }
}

/// The limit of a waiter whose operation has no `waitLimits` entry for it: five minutes (PROTOCOL.md 10.1). The
/// generator writes it into the waiter's [`WaiterSpec`].
pub const DEFAULT_LIMIT: Duration = Duration::from_secs(300);

/// A waiter's settings from the model.
#[derive(Debug, Clone, Copy)]
pub struct WaiterSpec {
    pub name: &'static str,
    pub min_delay: Duration,
    pub max_delay: Duration,
    /// The default limit for the whole wait: the operation's `waitLimits` entry, or 300 s.
    pub max_wait: Duration,
}

type Poll<T, Er> = Box<dyn Fn(CallOptions) -> BoxFuture<'static, Result<T, Er>> + Send + Sync>;

/// A wait, run when awaited. Set `max_wait`, `delays` or `cancel_on` before awaiting it. `T` is what each read
/// returns and `R` what a successful wait returns: the read's output, or `()` when success is an error.
pub struct Wait<T, Er, R = T> {
    spec: WaiterSpec,
    max_wait: Duration,
    min_delay: Duration,
    max_delay: Duration,
    cancel: Option<CancellationToken>,
    poll: Poll<T, Er>,
    accept: fn(&Result<T, Er>) -> Option<WaitState>,
    wrap: fn(WaiterError<Er>) -> Er,
    cancelled: fn() -> Er,
    /// Turns the read a success acceptor matched into the wait's result.
    done: fn(Result<T, Er>) -> Result<R, Er>,
}

impl<T: Send + Sync + 'static, Er: Send + 'static> Wait<T, Er, T> {
    /// For generated code, for a waiter whose success acceptors match outputs: `poll` makes one read with the given
    /// options, `accept` runs the acceptors in order (`None` when none matches), `wrap` turns a [`WaiterError`]
    /// into the client's error type and `cancelled` is its cancellation error. The wait returns the output.
    pub fn new(
        spec: WaiterSpec,
        poll: impl Fn(CallOptions) -> BoxFuture<'static, Result<T, Er>> + Send + Sync + 'static,
        accept: fn(&Result<T, Er>) -> Option<WaitState>,
        wrap: fn(WaiterError<Er>) -> Er,
        cancelled: fn() -> Er,
    ) -> Self {
        Wait {
            spec,
            max_wait: spec.max_wait,
            min_delay: spec.min_delay,
            max_delay: spec.max_delay,
            cancel: None,
            poll: Box::new(poll),
            accept,
            wrap,
            cancelled,
            done: |read| read,
        }
    }
}

impl<T: Send + Sync + 'static, Er: Send + 'static> Wait<T, Er, ()> {
    /// For generated code, for a waiter whose success acceptors match only errors (PROTOCOL.md 10.1): as
    /// [`Wait::new`], but the error a success acceptor matched means the wait is over, and it returns `()`.
    pub fn until_error(
        spec: WaiterSpec,
        poll: impl Fn(CallOptions) -> BoxFuture<'static, Result<T, Er>> + Send + Sync + 'static,
        accept: fn(&Result<T, Er>) -> Option<WaitState>,
        wrap: fn(WaiterError<Er>) -> Er,
        cancelled: fn() -> Er,
    ) -> Self {
        Wait {
            spec,
            max_wait: spec.max_wait,
            min_delay: spec.min_delay,
            max_delay: spec.max_delay,
            cancel: None,
            poll: Box::new(poll),
            accept,
            wrap,
            cancelled,
            done: |_| Ok(()),
        }
    }
}

impl<T: Send + Sync + 'static, Er: Send + 'static, R: Send + 'static> Wait<T, Er, R> {
    /// The limit of the whole wait: the waiter's default (its `waitLimits` entry, or [`DEFAULT_LIMIT`]) unless
    /// `max_wait` replaced it.
    pub fn limit(&self) -> Duration {
        self.max_wait
    }

    /// Limits the whole wait (by default the waiter's own limit).
    pub fn max_wait(mut self, limit: Duration) -> Self {
        self.max_wait = limit;
        self
    }

    /// Replaces the model's shortest and longest pause between reads.
    pub fn delays(mut self, min_delay: Duration, max_delay: Duration) -> Self {
        self.min_delay = min_delay;
        self.max_delay = max_delay.max(min_delay);
        self
    }

    /// Ends the wait with the client's cancellation error when `token` fires, during a read or a pause.
    pub fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    async fn run(self) -> Result<R, Er> {
        let deadline = tokio::time::Instant::now() + self.max_wait;
        let opts = match &self.cancel {
            Some(t) => CallOptions::default().cancel_on(t.clone()),
            None => CallOptions::default(),
        };
        let fired = |c: &Option<CancellationToken>| c.as_ref().is_some_and(|t| t.is_cancelled());
        let mut attempts = 0u32;
        loop {
            attempts += 1;
            let read = (self.poll)(opts.clone()).await;
            if fired(&self.cancel) {
                return Err((self.cancelled)());
            }
            let ended = |reason, read: Result<T, Er>| {
                let (last_error, last_output) = match read {
                    Ok(out) => (None, Some(Box::new(out) as Box<dyn Any + Send + Sync>)),
                    Err(e) => (Some(e), None),
                };
                (self.wrap)(WaiterError {
                    waiter: self.spec.name,
                    reason,
                    attempts,
                    last_error,
                    last_output,
                })
            };
            match ((self.accept)(&read), read.is_ok()) {
                // The generator never mixes output and error successes (PROTOCOL.md 10.1), so `done` is given the
                // output for an output waiter, and the matched error, meaning success, for an error waiter.
                (Some(WaitState::Success), _) => return (self.done)(read),
                (Some(WaitState::Failure), _) | (None, false) => return Err(ended(WaitReason::Failure, read)),
                (Some(WaitState::Retry), _) | (None, true) => {}
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(ended(WaitReason::Timeout, read));
            }
            let pause = delay(attempts, self.min_delay, self.max_delay).min(deadline - now);
            let sleep = tokio::time::sleep(pause);
            match &self.cancel {
                Some(t) => tokio::select! {
                    biased;
                    _ = t.cancelled() => return Err((self.cancelled)()),
                    _ = sleep => {}
                },
                None => sleep.await,
            }
        }
    }
}

impl<T: Send + Sync + 'static, Er: Send + 'static, R: Send + 'static> IntoFuture for Wait<T, Er, R> {
    type Output = Result<R, Er>;
    type IntoFuture = BoxFuture<'static, Result<R, Er>>;

    fn into_future(self) -> Self::IntoFuture {
        Box::pin(self.run())
    }
}

/// The pause before read `attempt + 1`: random between `min` and `min(max, min × 2^(attempt−1))`.
pub fn delay(attempt: u32, min: Duration, max: Duration) -> Duration {
    let ceiling = min
        .checked_mul(1u32.checked_shl(attempt.saturating_sub(1)).unwrap_or(u32::MAX))
        .unwrap_or(max)
        .min(max);
    if ceiling <= min {
        return min;
    }
    let span = (ceiling - min).as_millis() as u64;
    min + Duration::from_millis(random_u64() % (span + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[derive(Debug, PartialEq)]
    enum E {
        NotFound,
        Other,
        Cancelled,
        Waiter(String, &'static str, u32, Option<Box<E>>, Option<u32>),
    }
    impl fmt::Display for E {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "{self:?}")
        }
    }

    fn wrap(w: WaiterError<E>) -> E {
        let out = w.last_output::<u32>().copied();
        E::Waiter(w.to_string(), w.reason.as_str(), w.attempts, w.last_error.map(Box::new), out)
    }

    /// Success at 3, failure at 99; a NotFound error is a failure and any other error matches nothing.
    fn accept(r: &Result<u32, E>) -> Option<WaitState> {
        match r {
            Ok(3) => Some(WaitState::Success),
            Ok(99) => Some(WaitState::Failure),
            Err(E::NotFound) => Some(WaitState::Failure),
            _ => None,
        }
    }

    fn spec() -> WaiterSpec {
        WaiterSpec {
            name: "Indexed",
            min_delay: Duration::from_secs(2),
            max_delay: Duration::from_secs(30),
            max_wait: Duration::from_secs(300),
        }
    }

    /// A wait whose reads return `reads` in turn (the last one repeats), counting them.
    fn wait(reads: Vec<Result<u32, E>>, calls: Arc<AtomicU32>) -> Wait<u32, E> {
        let reads = Arc::new(std::sync::Mutex::new(reads));
        Wait::new(
            spec(),
            move |_| {
                let n = calls.fetch_add(1, Ordering::SeqCst) as usize;
                let mut r = reads.lock().unwrap();
                let i = n.min(r.len() - 1);
                let v = match &r[i] {
                    Ok(v) => Ok(*v),
                    Err(E::NotFound) => Err(E::NotFound),
                    Err(_) => Err(E::Other),
                };
                if i + 1 < r.len() {
                    r[i] = Ok(0);
                }
                Box::pin(async move { v })
            },
            accept,
            wrap,
            || E::Cancelled,
        )
    }

    #[test]
    fn pauses_grow_from_min_delay_and_stop_at_max_delay() {
        let (min, max) = (Duration::from_secs(2), Duration::from_secs(30));
        for _ in 0..200 {
            assert_eq!(delay(1, min, max), min);
            let d2 = delay(2, min, max);
            assert!(d2 >= min && d2 <= Duration::from_secs(4), "{d2:?}");
            let d4 = delay(4, min, max);
            assert!(d4 >= min && d4 <= Duration::from_secs(16), "{d4:?}");
            let d10 = delay(10, min, max);
            assert!(d10 >= min && d10 <= max, "{d10:?}");
            assert!(delay(40, min, max) <= max);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_read_is_at_once_and_success_returns_the_output() {
        let calls = Arc::new(AtomicU32::new(0));
        let t0 = tokio::time::Instant::now();
        assert_eq!(wait(vec![Ok(3)], calls.clone()).await, Ok(3));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(t0.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unmatched_output_is_read_again_after_a_pause() {
        let calls = Arc::new(AtomicU32::new(0));
        let t0 = tokio::time::Instant::now();
        assert_eq!(wait(vec![Ok(1), Ok(1), Ok(3)], calls.clone()).await, Ok(3));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(
            t0.elapsed() >= Duration::from_secs(4),
            "two pauses of at least min_delay: {:?}",
            t0.elapsed()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_acceptor_ends_with_the_last_output() {
        let r = wait(vec![Ok(1), Ok(99)], Arc::new(AtomicU32::new(0))).await;
        assert_eq!(
            r,
            Err(E::Waiter("Indexed: reached a failure state".into(), "failure", 2, None, Some(99)))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_matched_error_is_a_failure_carrying_it() {
        let r = wait(vec![Err(E::NotFound)], Arc::new(AtomicU32::new(0))).await;
        assert_eq!(
            r,
            Err(E::Waiter(
                "Indexed: reached a failure state: NotFound".into(),
                "failure",
                1,
                Some(Box::new(E::NotFound)),
                None
            ))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_error_no_acceptor_matches_is_a_failure_carrying_it() {
        let r = wait(vec![Ok(1), Err(E::Other)], Arc::new(AtomicU32::new(0))).await;
        assert_eq!(
            r,
            Err(E::Waiter(
                "Indexed: reached a failure state: Other".into(),
                "failure",
                2,
                Some(Box::new(E::Other)),
                None
            ))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_time_limit_ends_it_and_the_last_pause_is_clipped() {
        let calls = Arc::new(AtomicU32::new(0));
        let t0 = tokio::time::Instant::now();
        let r = wait(vec![Ok(1)], calls.clone()).max_wait(Duration::from_secs(7)).await;
        let n = calls.load(Ordering::SeqCst);
        assert_eq!(
            r,
            Err(E::Waiter(
                format!("Indexed: timed out after {n} reads"),
                "timeout",
                n,
                None,
                Some(1)
            ))
        );
        assert_eq!(t0.elapsed(), Duration::from_secs(7), "the last read is at the limit, not after it");
    }

    #[tokio::test(start_paused = true)]
    async fn the_caller_can_set_the_delays() {
        let calls = Arc::new(AtomicU32::new(0));
        let t0 = tokio::time::Instant::now();
        let r = wait(vec![Ok(1), Ok(3)], calls)
            .delays(Duration::from_millis(100), Duration::from_millis(100))
            .await;
        assert_eq!(r, Ok(3));
        assert_eq!(t0.elapsed(), Duration::from_millis(100));
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiter_that_succeeds_on_an_error_returns_nothing() {
        let calls = Arc::new(AtomicU32::new(0));
        let reads = Arc::new(std::sync::Mutex::new(vec![Ok(1u32), Err(E::NotFound)]));
        let n = calls.clone();
        let w: Wait<u32, E, ()> = Wait::until_error(
            spec(),
            move |_| {
                let i = (n.fetch_add(1, Ordering::SeqCst) as usize).min(1);
                let v = match &reads.lock().unwrap()[i] {
                    Ok(v) => Ok(*v),
                    Err(_) => Err(E::NotFound),
                };
                Box::pin(async move { v })
            },
            |r| matches!(r, Err(E::NotFound)).then_some(WaitState::Success),
            wrap,
            || E::Cancelled,
        );
        assert_eq!(w.await, Ok(()));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_during_a_pause_is_the_cancellation_error() {
        let token = CancellationToken::new();
        let t = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            t.cancel();
        });
        let r = wait(vec![Ok(1)], Arc::new(AtomicU32::new(0))).cancel_on(token).await;
        assert_eq!(r, Err(E::Cancelled));
    }
}
