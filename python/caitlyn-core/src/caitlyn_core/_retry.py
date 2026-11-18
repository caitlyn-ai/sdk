"""Retry policy: exponential backoff with full jitter; Retry-After honoured in full up to a maximum."""

from __future__ import annotations

import email.utils
import random
import threading
import time
from dataclasses import dataclass, field
from typing import cast

import httpx

from ._errors import CaitlynError


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    """Attempts in total, including the first."""
    base_delay: float = 0.5
    max_backoff: float = 8.0
    """Cap on the computed backoff (not on Retry-After)."""
    max_retry_delay: float = 60.0
    """Seconds. A Retry-After longer than this is not waited for: the error is raised at once."""
    retry_statuses: frozenset[int] = field(default_factory=frozenset[int])
    """Statuses retried even when not modelled as @retryable. Empty by default: the shared rule
    (ai.caitlyn.protocols#restJson, rule 4) retries modelled @retryable errors only."""
    retry_budget: int = 500
    """The size of the client's retry budget (PROTOCOL.md 6.4.6), in tokens. 0 turns retries off."""


RETRY_COST = 5
"""Tokens a retry costs (PROTOCOL.md 6.4.6)."""
NO_RESPONSE_RETRY_COST = 10
"""Tokens a retry costs when the attempt it repeats got no response."""
NO_RETRY_REFUND = 1
"""Tokens a call that succeeded without retrying returns."""


class RetryBudget:
    """The retry tokens one client's calls share (PROTOCOL.md 6.4.6): AWS's "standard" retry quota. A retry
    takes its cost; a call that succeeds gives back the cost of its last retry, or 1, up to the size. Safe to use
    from several threads and tasks."""

    def __init__(self, size: int) -> None:
        self.size = max(0, size)
        self._tokens = self.size
        self._lock = threading.Lock()

    @property
    def tokens(self) -> int:
        return self._tokens

    def acquire(self, cost: int) -> bool:
        """Takes ``cost`` tokens for a retry, or returns False, taking nothing, when the budget cannot pay."""
        with self._lock:
            if self._tokens < cost:
                return False
            self._tokens -= cost
            return True

    def release(self, last_retry_cost: int | None) -> None:
        """A call succeeded: give back its last retry's cost, or 1 when it did not retry."""
        with self._lock:
            self._tokens = min(self.size, self._tokens + (last_retry_cost or NO_RETRY_REFUND))


def parse_retry_after(value: str | None) -> float | None:
    """Retry-After as delta-seconds or an HTTP-date."""
    if value is None:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, when.timestamp() - time.time())


def backoff(policy: RetryPolicy, attempt: int) -> float:
    return random.uniform(0, min(policy.max_backoff, policy.base_delay * (2**attempt)))


def error_retry_delay(policy: RetryPolicy, safe: bool, attempt: int, error: CaitlynError) -> float | None:
    """Seconds to wait before the next attempt, or None to raise ``error`` now.
    ``attempt`` is zero-based: the attempt that just failed."""
    if not safe or attempt + 1 >= policy.max_attempts:
        return None
    if not (error.retryable or error.status in policy.retry_statuses):
        return None
    if error.retry_after_seconds is not None:
        return error.retry_after_seconds if error.retry_after_seconds <= policy.max_retry_delay else None
    return backoff(policy, attempt)


def transport_retry_delay(policy: RetryPolicy, safe: bool, attempt: int, error: httpx.TransportError) -> float | None:
    """A failure with no response is retried when the operation is safe to repeat (rule 4)."""
    if not safe or attempt + 1 >= policy.max_attempts:
        return None
    return backoff(policy, attempt)


def format_timeout(seconds: float) -> str:
    """A timeout as the SDKs' messages write it: "300 ms", "1.5 s", "60 s"."""
    return f"{round(seconds * 1000)} ms" if seconds < 1 else f"{seconds:g} s"


_TIMEOUT_PHASES: dict[type[httpx.TimeoutException], tuple[str, str]] = {
    httpx.ConnectTimeout: ("connect", "could not connect within {}"),
    httpx.ReadTimeout: ("read", "no response bytes within {}"),
    httpx.WriteTimeout: ("write", "could not send the request within {}"),
    httpx.PoolTimeout: ("pool", "no connection was free within {}"),
}


def timeout_seconds(error: httpx.TimeoutException) -> float | None:
    """The httpx timeout that ran out (connect, read, write or pool), from the request it ran out on."""
    phase = next((p for t, (p, _) in _TIMEOUT_PHASES.items() if isinstance(error, t)), None)
    try:
        value = cast(dict[str, float | None], error.request.extensions.get("timeout") or {}).get(phase or "")
    except RuntimeError:  # an error not tied to a request
        return None
    return value


def describe_timeout(error: httpx.TimeoutException) -> str:
    """What timed out, and after how long: "no response bytes within 300 ms" (httpx's own message is often empty)."""
    phrase = next((f for t, (_, f) in _TIMEOUT_PHASES.items() if isinstance(error, t)), "timed out within {}")
    seconds = timeout_seconds(error)
    return phrase.format(format_timeout(seconds)) if seconds is not None else phrase.replace(" within {}", "")


def storage_stall_message(error: httpx.TransportError) -> str:
    """A send to storage that a timeout ended (PROTOCOL.md 14): "storage sent nothing for 300 ms". httpx's timeouts are
    per read and per write, reset by each, so they are the stall timeout the other SDKs keep themselves."""
    seconds = timeout_seconds(error) if isinstance(error, httpx.TimeoutException) else None
    if seconds is None:
        return str(error) or type(error).__name__
    return f"storage sent nothing for {format_timeout(seconds)}"
