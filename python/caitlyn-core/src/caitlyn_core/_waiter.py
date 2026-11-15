"""The runtime half of ``@waitable`` (smithy.waiters): poll a read operation until an acceptor matches. Generated
``wait_until_…`` methods supply the read and the acceptors; this does the timing and the errors.

The rules every SDK follows (PROTOCOL.md 10.1, after Smithy's waiter specification):

1. The first read happens at once. Before attempt n+1 the waiter waits a random time between ``min_delay`` and
   ``min(max_delay, min_delay * 2**(n-1))`` seconds.
2. The wait is limited to ``max_wait`` seconds in all. Generated methods default it to the waiter's entry in the
   operation's ``@waitLimits``, or 5 minutes without one; the last pause is clipped to the time left, and running
   out raises ``WaiterError`` with reason ``"timeout"``.
3. The acceptors are checked in order on each result: success returns the output, failure raises ``WaiterError``
   with reason ``"failure"``, and an output no acceptor matches is read again. A success reached through an error
   (``Deleted`` on a 404) returns None: there is no output, and the generated method returns None.
4. An error no acceptor matches ends the wait: ``WaiterError``, reason ``"failure"``, with the error as ``last``.
   Retryable errors (429, 503, connection failures) are first retried inside each read, as for any call.
5. Cancelling the task (``AsyncCaitlyn``) raises ``asyncio.CancelledError``, never ``WaiterError``.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from typing import Literal

type WaitState = Literal["success", "failure", "retry"]
type Acceptor[T] = Callable[[T | None, Exception | None], WaitState | None]
"""Given the output, or the error the read raised, the state of the first acceptor that matches, else None."""

DEFAULT_MAX_WAIT = 300.0
"""The limit of a waiter with no ``@waitLimits`` entry (PROTOCOL.md 10.1)."""


class WaiterError(Exception):
    """A waiter reached a failure state, or ran out of time.

    ``waiter`` is its name (for example ``"Indexed"``), ``reason`` is ``"failure"`` or ``"timeout"``, ``last`` is the
    last output or the error the last read raised, and ``attempts`` counts the reads."""

    def __init__(self, message: str, *, waiter: str, reason: Literal["failure", "timeout"], last: object, attempts: int) -> None:
        super().__init__(message)
        self.waiter = waiter
        self.reason: Literal["failure", "timeout"] = reason
        self.last = last
        self.attempts = attempts


class _Wait[T]:
    """One wait's state and decisions, shared by the sync and async loops."""

    def __init__(self, name: str, accept: Acceptor[T], min_delay: float, max_delay: float, max_wait: float | None) -> None:
        if min_delay <= 0 or max_delay < min_delay:
            raise ValueError(f"{name}: delays must satisfy 0 < min_delay <= max_delay (got {min_delay}, {max_delay})")
        self.name = name
        self.accept = accept
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.max_wait = DEFAULT_MAX_WAIT if max_wait is None else max_wait
        self.deadline = time.monotonic() + self.max_wait
        self.attempts = 0

    def done(self, output: T | None, error: Exception | None) -> bool:
        """Applies the acceptors to one read: True when the output is the result, raises when the wait fails."""
        self.attempts += 1
        state = self.accept(output, error)
        last: object = error if error is not None else output
        if state == "success":
            return True  # through an error, output is None, which the wait returns
        if state == "failure" or (state is None and error is not None):
            raise WaiterError(f"{self.name}: reached a failure state", waiter=self.name, reason="failure", last=last, attempts=self.attempts) from error
        return False

    def pause(self, last: object) -> float:
        """The pause before the next read, clipped to the time left; raises when no time is left."""
        n = self.attempts
        ceiling = min(self.max_delay, self.min_delay * 2 ** min(n - 1, 30))
        delay = random.uniform(self.min_delay, ceiling)
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise WaiterError(
                f"{self.name}: did not finish within {self.max_wait:g} s", waiter=self.name, reason="timeout", last=last, attempts=self.attempts
            )
        return min(delay, left)


def wait_sync[T](
    name: str, read: Callable[[], T], accept: Acceptor[T], *, min_delay: float, max_delay: float, max_wait: float | None = None
) -> T:
    """Calls ``read`` until an acceptor says success (returns the output) or failure (raises ``WaiterError``)."""
    w = _Wait(name, accept, min_delay, max_delay, max_wait)
    while True:
        output: T | None = None
        error: Exception | None = None
        try:
            output = read()
        except Exception as e:
            error = e
        if w.done(output, error):
            return output  # pyright: ignore[reportReturnType]  # None when the success came through an error
        time.sleep(w.pause(error if error is not None else output))


async def wait_async[T](
    name: str, read: Callable[[], Awaitable[T]], accept: Acceptor[T], *, min_delay: float, max_delay: float, max_wait: float | None = None
) -> T:
    """As ``wait_sync``, for the async client. Cancelling the task stops the wait with ``asyncio.CancelledError``."""
    w = _Wait(name, accept, min_delay, max_delay, max_wait)
    while True:
        output: T | None = None
        error: Exception | None = None
        try:
            output = await read()
        except Exception as e:  # CancelledError is a BaseException: it is never caught here
            error = e
        if w.done(output, error):
            return output  # pyright: ignore[reportReturnType]  # None when the success came through an error
        await asyncio.sleep(w.pause(error if error is not None else output))
