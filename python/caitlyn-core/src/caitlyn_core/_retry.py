"""Retry policy: exponential backoff with full jitter; Retry-After honoured in full up to a maximum."""

from __future__ import annotations

import email.utils
import random
import time
from dataclasses import dataclass, field

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
