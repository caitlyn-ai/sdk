"""The waiter runtime behind generated `wait_until_…` methods: delays, time limit, acceptors, errors and
cancellation, the same in the sync and the async client."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from caitlyn_core import WaiterError, WaitState, wait_async, wait_sync


class NotReady(Exception):
    pass


class Gone(Exception):
    pass


def accept(output: str | None, error: Exception | None) -> WaitState | None:
    """Like a generated acceptor: success on "ready", failure on "broken", retry on NotReady."""
    if output == "broken":
        return "failure"
    if output == "ready":
        return "success"
    if isinstance(error, NotReady):
        return "retry"
    return None


class Reads:
    """Answers each read from a script: a value, or an exception to raise. Records when each read happened."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.at: list[float] = []

    def __call__(self) -> str:
        self.at.append(time.monotonic())
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, Exception):
            raise step
        return step

    async def read(self) -> str:
        return self()


FAST = {"min_delay": 0.01, "max_delay": 0.04}


def test_first_read_at_once_then_success() -> None:
    reads = Reads("pending", NotReady(), "ready")
    t0 = time.monotonic()
    assert wait_sync("Ready", reads, accept, **FAST) == "ready"
    assert len(reads.at) == 3
    assert reads.at[0] - t0 < 0.01, "the first read is not delayed"


def test_delays_grow_between_min_and_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[tuple[float, float]] = []
    monkeypatch.setattr("caitlyn_core._waiter.random.uniform", lambda a, b: asked.append((a, b)) or a)  # pyright: ignore[reportUnknownLambdaType]
    monkeypatch.setattr("caitlyn_core._waiter.time.sleep", lambda s: None)  # pyright: ignore[reportUnknownLambdaType]
    wait_sync("Ready", Reads("pending", "pending", "pending", "pending", "ready"), accept, min_delay=2, max_delay=30)
    # random(minDelay, min(maxDelay, minDelay * 2^(n-1))) before attempt n+1
    assert asked == [(2, 2), (2, 4), (2, 8), (2, 16)]
    asked.clear()
    wait_sync("Ready", Reads(*["pending"] * 6, "ready"), accept, min_delay=2, max_delay=30)
    assert asked[-1] == (2, 30), "the ceiling stops at max_delay"


def test_failure_state() -> None:
    with pytest.raises(WaiterError) as info:
        wait_sync("Indexed", Reads("pending", "broken"), accept, **FAST)
    e = info.value
    assert (e.waiter, e.reason, e.last, e.attempts) == ("Indexed", "failure", "broken", 2)
    assert str(e) == "Indexed: reached a failure state"


def test_error_no_acceptor_matches_is_a_failure() -> None:
    gone = Gone("deleted")
    with pytest.raises(WaiterError) as info:
        wait_sync("Indexed", Reads(NotReady(), gone), accept, **FAST)
    assert (info.value.reason, info.value.last, info.value.attempts) == ("failure", gone, 2)
    assert info.value.__cause__ is gone


def test_time_limit() -> None:
    reads = Reads("pending")
    t0 = time.monotonic()
    with pytest.raises(WaiterError) as info:
        wait_sync("Indexed", reads, accept, min_delay=0.05, max_delay=0.2, max_wait=0.3)
    elapsed = time.monotonic() - t0
    assert info.value.reason == "timeout"
    assert info.value.last == "pending"
    assert info.value.attempts == len(reads.at) >= 2
    assert 0.3 <= elapsed < 0.6, "the last pause is clipped to the time left"


def test_bad_delays() -> None:
    with pytest.raises(ValueError):
        wait_sync("Ready", Reads("ready"), accept, min_delay=5, max_delay=1)


async def test_async_success_and_failure() -> None:
    assert await wait_async("Ready", Reads("pending", "ready").read, accept, **FAST) == "ready"
    with pytest.raises(WaiterError) as info:
        await wait_async("Ready", Reads("broken").read, accept, **FAST)
    assert info.value.reason == "failure"


async def test_async_cancellation_is_not_a_waiter_error() -> None:
    task = asyncio.create_task(wait_async("Ready", Reads("pending").read, accept, min_delay=10, max_delay=20))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
