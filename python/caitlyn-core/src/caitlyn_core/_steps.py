"""Sign-in steps written once for both clients. A step is a generator that yields what it needs done (an HTTP
request to send, or a caller's function to call) and is sent the result; ``run_sync`` and ``run_async`` do the
I/O. This keeps the sign-in rules in one place while the sync client never touches an event loop and the async
client never blocks one."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Generator
from dataclasses import dataclass
from typing import Any, cast

import httpx


@dataclass(frozen=True, slots=True)
class Invoke:
    """Call a function the caller gave (a token store, a credentials provider, a token function). In the
    async client its result is awaited when it is awaitable."""

    fn: Callable[..., Any]
    args: tuple[Any, ...] = ()


type Effect = httpx.Request | Invoke
type Steps[T] = Generator[Effect, Any, T]


def send(request: httpx.Request) -> Steps[httpx.Response]:
    """Send a request (with no Caitlyn credential) and return the response, body read."""
    response = yield request
    return cast(httpx.Response, response)


def invoke(fn: Callable[..., Any], *args: Any) -> Steps[Any]:
    result = yield Invoke(fn, args)
    return result


def run_sync[T](http: httpx.Client, steps: Steps[T]) -> T:
    value: Any = None
    error: BaseException | None = None
    while True:
        try:
            effect = steps.throw(error) if error is not None else steps.send(value)
        except StopIteration as stop:
            return cast(T, stop.value)
        value, error = None, None
        try:
            if isinstance(effect, httpx.Request):
                value = http.send(effect, auth=None)
            else:
                value = effect.fn(*effect.args)
                if inspect.isawaitable(value):
                    if inspect.iscoroutine(value):
                        value.close()
                    raise TypeError(f"{getattr(effect.fn, '__qualname__', effect.fn)!s} returned an awaitable; use AsyncCaitlyn, or pass a function that returns a value")
        except Exception as e:
            error = e


async def run_async[T](http: httpx.AsyncClient, steps: Steps[T]) -> T:
    value: Any = None
    error: BaseException | None = None
    while True:
        try:
            effect = steps.throw(error) if error is not None else steps.send(value)
        except StopIteration as stop:
            return cast(T, stop.value)
        value, error = None, None
        try:
            if isinstance(effect, httpx.Request):
                value = await http.send(effect, auth=None)
            else:
                value = effect.fn(*effect.args)
                if inspect.isawaitable(value):
                    value = await value
        except Exception as e:
            error = e
