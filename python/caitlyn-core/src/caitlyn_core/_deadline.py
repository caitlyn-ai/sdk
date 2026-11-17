"""A batch's watch reads the batch again once its deadline has passed (PROTOCOL.md 16).

The server ends a batch whose deadline has passed only when the batch is next read, not on its own, so the batch's
watch can stay silent. Each time the batch is seen (in a snapshot, or a read), its read is due at its
``uploads_expire_at`` plus ``DEADLINE_GRACE``. If nothing has shown the batch again by then and it is still open, the watch reads it with GetIngestionBatch
and yields the read as a ``snapshot`` holding the batch, with no jobs and no progress. A snapshot that arrives already
past its due time has its batch read at once, and is yielded with the read's batch in its place. Each deadline is read
once: a read that returns the same deadline schedules nothing more."""

from __future__ import annotations

import asyncio
import contextlib
import queue
import threading
import time
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Iterator, Mapping
from datetime import datetime
from typing import Any, cast

from ._client import AsyncClientCore, AsyncEventStream, EventDecoder, EventStream, Resume, SyncClientCore
from ._models import CaitlynEvent
from ._spec import OperationSpec

DEADLINE_GRACE = 30.0
"""Seconds after a batch's deadline before its watch reads it, if it is still open. Fixed: not an option."""
_FINAL = frozenset({"succeeded", "completed_with_failures", "failed", "cancelled"})


def batch_deadline(batch: Any) -> float | None:
    """A batch's deadline, as a POSIX timestamp: its ``uploads_expire_at``, while it is open. None once it has ended."""
    if batch is None or str(getattr(batch, "status", "")) in _FINAL:
        return None
    at = cast(datetime | None, getattr(batch, "uploads_expire_at", None))
    return at.timestamp() if at is not None else None


def _json(batch: Any) -> dict[str, Any]:
    """The batch as the server sent it, to put into a snapshot."""
    return dict(cast(Mapping[str, Any], getattr(batch, "raw")))


class DeadlineClock:
    """When a batch's read is due, from what was last seen of it; each deadline is read once."""

    def __init__(self) -> None:
        self.read: set[float] = set()
        self.deadline: float | None = None
        self.due: float | None = None

    def see(self, batch: Any) -> None:
        self.deadline = batch_deadline(batch)
        self.due = None if self.deadline is None or self.deadline in self.read else self.deadline + DEADLINE_GRACE

    def reading(self) -> None:
        if self.deadline is not None:
            self.read.add(self.deadline)
        self.due = None

    def overdue(self) -> bool:
        return self.due is not None and self.due <= time.time()

    def wait(self) -> float | None:
        """Seconds until the read is due (0 when it already is), or None when none is."""
        return None if self.due is None else max(0.0, self.due - time.time())


def _snapshot(decoder: EventDecoder[Any, Any], resume: Resume | None, data: dict[str, Any], event_id: str | None) -> Any:
    event = cast(type[CaitlynEvent], decoder.events["snapshot"]).from_wire(data)
    event.event_id = event_id
    if resume is not None and resume.watched is not None:
        event._bind_watch(resume.watched)  # pyright: ignore[reportPrivateUsage]
    return event


def _batch_of(event: CaitlynEvent) -> Any:
    """The batch a snapshot shows (the model's IngestionBatch), or None."""
    return getattr(event, "batch", None) if event.type == "snapshot" else None


class DeadlineEventStream(EventStream[Any, None]):
    """A batch's watch on the synchronous client, reading the batch at its deadline. The watch is read on a thread of
    its own, so that the caller's thread can wait for the next event or the due time, whichever comes first."""

    def __init__(self, core: SyncClientCore, spec: OperationSpec, params: dict[str, object], decoder: EventDecoder[Any, None],
                 resume: Resume | None, read: Callable[[], object]) -> None:
        super().__init__(core, spec, params, decoder, resume)
        self._decoder, self._resume, self._read = decoder, resume, read
        self._clock = DeadlineClock()

    def _reread(self, base: dict[str, Any], event_id: str | None) -> Any:
        self._clock.reading()
        batch = self._read()
        self._clock.see(batch)
        return _snapshot(self._decoder, self._resume, {**base, "batch": _json(batch)}, event_id)

    def __iter__(self) -> Iterator[Any]:
        inbox: queue.Queue[tuple[str, Any]] = queue.Queue()
        stop = threading.Event()
        events = super().__iter__()

        def pump() -> None:
            try:
                for event in events:
                    inbox.put(("event", event))
                    if stop.is_set():
                        return
                inbox.put(("end", None))
            except BaseException as e:  # handed to the caller's thread, which raises it
                inbox.put(("error", e))

        threading.Thread(target=pump, name="caitlyn-batch-watch", daemon=True).start()
        try:
            while True:
                try:
                    kind, item = inbox.get(timeout=self._clock.wait())
                except queue.Empty:
                    yield self._reread({"jobs": [], "progress": []}, None)
                    continue
                if kind == "end":
                    return
                if kind == "error":
                    raise cast(BaseException, item)
                event = cast(CaitlynEvent, item)
                batch = _batch_of(event)
                if batch is not None:
                    self._clock.see(batch)
                    if self._clock.overdue():
                        event = self._reread(dict(cast(Mapping[str, Any], event.raw)), event.event_id)
                yield event
        finally:
            # Leaving the watch closes it: the thread reading it ends with the connection.
            stop.set()
            self.close()


class AsyncDeadlineEventStream(AsyncEventStream[Any, None]):
    """As ``DeadlineEventStream``, for the asynchronous client."""

    def __init__(self, core: AsyncClientCore, spec: OperationSpec, params: dict[str, object], decoder: EventDecoder[Any, None],
                 resume: Resume | None, read: Callable[[], Awaitable[object]]) -> None:
        super().__init__(core, spec, params, decoder, resume)
        self._decoder, self._resume, self._read = decoder, resume, read
        self._clock = DeadlineClock()

    async def _reread(self, base: dict[str, Any], event_id: str | None) -> Any:
        self._clock.reading()
        batch = await self._read()
        self._clock.see(batch)
        return _snapshot(self._decoder, self._resume, {**base, "batch": _json(batch)}, event_id)

    async def __aiter__(self) -> AsyncIterator[Any]:
        events = cast(AsyncGenerator[Any, None], super().__aiter__())

        async def following() -> Any:
            return await anext(events)

        pending: asyncio.Task[Any] | None = None
        try:
            while True:
                if pending is None:
                    pending = asyncio.ensure_future(following())
                finished, _ = await asyncio.wait({pending}, timeout=self._clock.wait())
                if not finished:
                    yield await self._reread({"jobs": [], "progress": []}, None)
                    continue
                task, pending = pending, None
                try:
                    event = cast(CaitlynEvent, task.result())
                except StopAsyncIteration:
                    return
                batch = _batch_of(event)
                if batch is not None:
                    self._clock.see(batch)
                    if self._clock.overdue():
                        event = await self._reread(dict(cast(Mapping[str, Any], event.raw)), event.event_id)
                yield event
        finally:
            if pending is not None:
                pending.cancel()
                with contextlib.suppress(BaseException):
                    await pending
            with contextlib.suppress(BaseException):
                await events.aclose()
            await self.aclose()
