"""The runtime under the generated scopes (PROTOCOL.md 10 and 16): following a thing through its knowledge base's
watch (``watch()``, ``wait()``, ``planned()``), what a call that starts work returns (``Started``), and the
``readers`` shorthand.

A scope follows a thing with ``Follow`` (``AsyncFollow`` on the async client). Its ``watch()`` opens the watch with the
scope's identifier in the watch's filter member and reconnects with no cursor, so every connection starts with a
snapshot of the thing as it stands. ``wait()`` reads those events: it returns the thing (as its ``get`` would) once no
job runs on it, raises a failed job's error as the typed error for its code (``CANCELLED`` for a cancelled one), and
ends when the thing is gone (a success after a delete, else the 404)."""

from __future__ import annotations

import asyncio
import inspect
import threading
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, TypedDict, cast

from ._errors import CaitlynError
from ._models import CaitlynEvent
from ._spec import OperationSpec

if TYPE_CHECKING:
    from ._client import AsyncClientCore, AsyncEventStream, EventDecoder, EventStream, SyncClientCore

FINAL_JOB_STATUSES = frozenset({"succeeded", "completed_with_failures", "failed", "cancelled"})
"""A job (an Operation) in one of these has ended."""
FINAL_BATCH_STATUSES = frozenset({"succeeded", "completed_with_failures", "failed", "cancelled", "expired"})
"""An ingestion batch in one of these has ended."""
BUSY_BATCH_STATUSES = frozenset({"planning", "running"})
"""An ingestion batch in one of these is working; ``draft`` and ``planned`` wait for the caller."""
NOT_PLANNED_BATCH_STATUSES = frozenset({"draft", "planning"})
"""An ingestion batch in one of these is not planned yet: ``planned()`` waits through them."""
BUSY_STATUSES: dict[str | None, frozenset[str]] = {
    None: frozenset({"creating", "moving", "deleting"}),
    "document": frozenset({"pending", "processing", "deleting"}),
    "batch": frozenset({"planning", "running"}),
    "folder": frozenset(),
}
"""Each resource's working statuses, by the watch's filter (None: the knowledge base), from the model's enums
(PROTOCOL.md 16): the thing is busy in one of these even when no job is listed (a knowledge base being created has
none). A folder has no status of its own: it is busy only while a job on it runs."""


class WaitTimeoutError(TimeoutError):
    """A ``wait()`` or ``planned()`` whose time limit passed: a ``TimeoutError`` with ``code`` ``WAIT_TIMEOUT`` and
    ``status`` 0. The watch it read is closed."""

    code = "WAIT_TIMEOUT"
    status = 0

    def __init__(self, timeout: float | None) -> None:
        super().__init__(f"WAIT_TIMEOUT: the wait did not finish within {timeout:g} s" if timeout is not None else "WAIT_TIMEOUT")
        self.timeout = timeout

_ENTITY = {None: "knowledgeBase", "document": "document", "folder": "folder", "batch": "batch"}
"""The snapshot member that holds the thing watched, by the watch's filter member."""


def trim_slashes(path: object) -> str:
    """A folder path as a request path takes it: without its first and last ``/`` (PROTOCOL.md 10)."""
    return str(path).strip("/")


class ReadersSpecific(TypedDict, total=False):
    """``readers`` for only the roles and people listed: ``{"roles": ["hr-team"]}``."""

    roles: Sequence[str]
    people: Sequence[str]


type ReadersShorthand = Literal["inherit", "everyone"] | ReadersSpecific
"""Who may read a folder or a document: ``"inherit"`` (as the folder it is in), ``"everyone"`` (anyone signed in who may
read the knowledge base), or ``{"roles": […], "people": […]}``."""


def readers_input(value: object) -> object:
    """The readers shorthand as the modelled ``Readers`` shape: ``"inherit"`` is ``{"kind": "inherit"}``, ``{"roles":
    […]}`` is ``{"kind": "specific", "roles": […]}``. A ``Readers`` model, or a dict with ``kind``, is sent as it is."""
    if isinstance(value, str):
        return {"kind": value}
    if isinstance(value, Mapping):
        m = cast(Mapping[str, object], value)
        if "kind" not in m:
            return {"kind": "specific", **{k: list(cast(Sequence[str], v)) for k, v in m.items()}}
        return m
    return value


def error_for_code(codes: Mapping[str, type[CaitlynError]], code: str, detail: str | None = None) -> CaitlynError:
    """The typed error for a stable code (the error shape whose ``errorCodes`` list it), as a job's failure raises it."""
    cls = codes.get(code, CaitlynError)
    status = cls.http_status or 0
    return cls(f"{code}: {detail}" if detail else code, status=status, code=code, title=detail or code, detail=detail)


def cancelled_error(what: str) -> CaitlynError:
    """``CANCELLED``: the job a wait followed was cancelled. The SDK raises it itself (PROTOCOL.md 16)."""
    return CaitlynError(f"CANCELLED: {what} was cancelled", status=0, code="CANCELLED", title=f"{what} was cancelled")


def expired_error(batch_id: str) -> CaitlynError:
    """``EXPIRED``: the batch's plan expired before it was started. The SDK raises it itself (PROTOCOL.md 16)."""
    return CaitlynError(f"EXPIRED: batch {batch_id} expired before it was started", status=0, code="EXPIRED",
                        title=f"Batch {batch_id} expired before it was started")


PROGRESS_EVENTS = frozenset({"document.progress", "job.progress"})
"""The events that report progress: wait()'s on_progress gets the processing of each one about the thing."""


def processing_for(event: CaitlynEvent, filter: str | None, key: str | None) -> Any:
    """The processing an event gives a thing (PROTOCOL.md 16), the same whether it is a snapshot or a progress event:

    - a document (filter ``document``): its DocumentProcessing, from the snapshot's ``processing`` entry for it or a
      ``document.progress`` event about it;
    - a folder, a batch or the knowledge base: the job running on it, from the snapshot's ``jobs`` or a ``job.progress``
      or ``job.finished`` event, the one whose target is the thing first;
    - with ``filter`` ``"any"``: whichever of those ``key`` names, a document's identifier or a job's.

    None when the event carries none."""
    kind = event.type
    if filter in ("document", "any") and key is not None:
        if kind == "snapshot":
            for entry in _progress_entries(event):
                if str(getattr(entry, "document_id", "")) == key:
                    return getattr(entry, "processing", None)
        elif kind == "document.progress" and str(getattr(event, "document_id", "")) == key:
            return getattr(event, "processing", None)
        if filter == "document":
            return None
    if kind == "snapshot":
        jobs = cast(list[Any], getattr(event, "jobs", None) or [])
    elif kind in ("job.progress", "job.finished"):
        jobs = [getattr(event, "job")]
    else:
        return None
    if filter == "any":
        return next((j for j in jobs if str(getattr(j, "id", "")) == key), None)
    running = [j for j in jobs if str(getattr(j, "status", "")) not in FINAL_JOB_STATUSES or kind == "job.finished"]

    def targets_thing(j: Any) -> bool:
        target = getattr(j, "target", None)
        return target is not None and key is not None and (trim_slashes(getattr(target, "id", "")) == trim_slashes(key) if filter == "folder"
                                                           else str(getattr(target, "id", "")) == key)

    return next((j for j in running if targets_thing(j)), running[0] if running and kind != "job.finished" else None)


def _progress_entries(event: CaitlynEvent) -> list[Any]:
    """The snapshot's documents' progress, each {documentId, processing}: its `progress` list."""
    return cast(list[Any], getattr(event, "progress", None) or [])


def event_processing(event: CaitlynEvent, key: str | None = None) -> Any:
    """``event.processing``: the processing of the thing the event's scope watches; ``event.processing_of(id)``: of the
    document or job ``id`` names, for the knowledge base's own watch."""
    if key is not None:
        return processing_for(event, "any", key)
    watched = event.watched
    if watched is None:
        return None
    return processing_for(event, watched[0], watched[1])


@dataclass(frozen=True, slots=True)
class Watched:
    """What a scope follows: the watch operation, its input with the scope's identifiers, and the filter member it
    filled (``document``, ``folder`` or ``batch``; ``None`` for the whole knowledge base) with its value."""

    spec: OperationSpec
    params: Mapping[str, object]
    decoder: EventDecoder[Any, None]
    filter: str | None = None
    key: str | None = None


@dataclass(slots=True)
class WaitDone:
    """How a wait ended: with the thing as the last event showed it, or with the thing gone."""

    entity: Mapping[str, Any] | None
    gone: bool = False


class WaitTracker:
    """One wait's decisions, fed each event in turn; shared by the sync and async clients."""

    def __init__(self, watched: Watched, codes: Mapping[str, type[CaitlynError]], *, job_id: str | None, gone_ok: bool,
                 until: Literal["idle", "planned"], cancelled_ok: bool = False) -> None:
        self.cancelled_ok = cancelled_ok
        """The wait of a call that cancels (PROTOCOL.md 16, wait.cancel-returns): the work it cancelled ending
        cancelled is what the call meant, so the wait returns the thing rather than raising CANCELLED."""
        self.watched = watched
        self.codes = codes
        self.job_id = job_id
        self.gone_ok = gone_ok
        self.until = until
        self.jobs: dict[str, Mapping[str, Any]] = {}
        self.followed: set[str] = set()
        """Jobs this wait saw running: one of them failing fails the wait."""
        self.entity: Mapping[str, Any] | None = None
        self.ended = False

    def _same(self, value: object) -> bool:
        key = self.watched.key
        if self.watched.filter == "folder":
            return trim_slashes(value) == trim_slashes(key)
        return str(value) == str(key)

    def progress(self, event: CaitlynEvent) -> Any:
        """The thing's processing an event reports, for on_progress: the snapshot's (when the thing is being processed),
        then each progress event's. None for any other event, and after the wait has ended."""
        if self.ended or (event.type != "snapshot" and event.type not in PROGRESS_EVENTS):
            return None
        return processing_for(event, self.watched.filter, self.watched.key)

    def feed(self, event: CaitlynEvent) -> WaitDone | None:
        try:
            done = self._feed(event)
        except BaseException:
            self.ended = True
            raise
        if done is not None:
            self.ended = True
        return done

    def _feed(self, event: CaitlynEvent) -> WaitDone | None:
        raw = cast(Mapping[str, Any], event.raw)
        kind = self.watched.filter
        match event.type:
            case "snapshot":
                self.jobs = {str(j.get("id")): j for j in cast(list[Mapping[str, Any]], raw.get("jobs") or [])}
                self.entity = cast(Mapping[str, Any] | None, raw.get(_ENTITY.get(kind, "knowledgeBase")))
                if self.entity is None and kind is not None:
                    return self.gone()
            case "job.progress" | "job.finished":
                job = cast(Mapping[str, Any], raw.get("job") or {})
                self.jobs[str(job.get("id"))] = job
            case "document.deleted" if kind == "document" and self._same(raw.get("documentId")):
                return self.gone()
            case "folder.deleted" if kind == "folder" and self._same(raw.get("path")):
                return self.gone()
            case "document.created" | "document.updated" if kind == "document":
                document = cast(Mapping[str, Any], raw.get("document") or {})
                if self._same(document.get("id")):
                    self.entity = document
            case "folder.created" | "folder.updated" if kind == "folder":
                folder = cast(Mapping[str, Any], raw.get("folder") or {})
                if self._same(folder.get("path")):
                    self.entity = folder
            case "knowledge_base.updated" if kind is None:
                self.entity = cast(Mapping[str, Any], raw.get("knowledgeBase") or self.entity)
            case _:
                pass
        return self.decide()

    def gone(self) -> WaitDone:
        if self.gone_ok:
            return WaitDone(None, gone=True)
        raise error_for_code(self.codes, "NOT_FOUND", f"the {self.watched.filter or 'knowledge base'} is gone")

    def _status(self) -> str:
        return str((self.entity or {}).get("status") or "")

    def decide(self) -> WaitDone | None:
        if self.until == "planned":
            status = self._status()
            if not status or status in NOT_PLANNED_BATCH_STATUSES:
                return None
            return self._batch_outcome(status)
        if self.job_id is not None:
            job = self.jobs.get(self.job_id)
            if job is None or str(job.get("status")) not in FINAL_JOB_STATUSES:
                return None
            return self._job_outcome(job)
        running = [j_id for j_id, j in self.jobs.items() if str(j.get("status")) not in FINAL_JOB_STATUSES]
        if running:
            self.followed.update(running)
            return None
        for j_id in sorted(self.followed):
            job = self.jobs.get(j_id)
            status = str(job.get("status")) if job is not None else ""
            if (self.gone_ok or self.cancelled_ok) and status == "cancelled":
                continue  # the delete stopped it: a delete's wait ends on the gone rule, never on CANCELLED
            if job is not None and status in ("failed", "cancelled"):
                return self._job_outcome(job)
        if self._status() in BUSY_STATUSES.get(self.watched.filter, frozenset()):
            return None
        if self.watched.filter == "batch":
            status = self._status()
            if status in BUSY_BATCH_STATUSES:
                return None
            if status in FINAL_BATCH_STATUSES:
                return self._batch_outcome(status)
        return WaitDone(self.entity)

    def _job_outcome(self, job: Mapping[str, Any]) -> WaitDone:
        status = str(job.get("status"))
        if status == "failed":
            error = cast(Mapping[str, Any], job.get("error") or {})
            raise error_for_code(self.codes, str(error.get("code") or "JOB_FAILED"), cast(str | None, error.get("detail")))
        if status == "cancelled" and not self.cancelled_ok:
            raise cancelled_error(f"job {job.get('id')}")
        return WaitDone(None, gone=True) if self.gone_ok else WaitDone(self.entity)

    def _batch_outcome(self, status: str) -> WaitDone:
        if status == "failed":
            failure = cast(Mapping[str, Any], (self.entity or {}).get("failure") or {})
            raise error_for_code(self.codes, str(failure.get("code") or "INGESTION_BATCH_FAILED"), cast(str | None, failure.get("message")))
        if status == "cancelled" and not self.cancelled_ok:
            raise cancelled_error(f"batch {self.watched.key}")
        if status == "expired":
            raise expired_error(str(self.watched.key))
        return WaitDone(self.entity)

    def on_error(self, error: CaitlynError) -> WaitDone:
        """A 404 opening the watch: the thing is gone."""
        if error.status == 404 and self.gone_ok:
            return WaitDone(None, gone=True)
        raise error


class Follow[T]:
    """How a scope of the synchronous client follows its thing: ``watch()``, ``wait()`` and ``planned()``."""

    def __init__(self, core: SyncClientCore, watched: Watched, codes: Mapping[str, type[CaitlynError]],
                 get: Callable[[], T] | None = None, entity: Callable[[Any], T] | None = None) -> None:
        self.core = core
        self.watched = watched
        self.codes = codes
        self.get = get
        self.entity = entity

    def watch(self) -> EventStream[Any, None]:
        """The thing's events: a snapshot first, then each change; after a reconnect, a new snapshot first."""
        from ._client import Resume

        w = self.watched
        return self.core.stream(w.spec, w.params, w.decoder, Resume(w.spec, w.params, watched=(w.filter, str(w.key)) if w.key is not None else None))

    def _run(self, tracker: WaitTracker, timeout: float | None, on_progress: Callable[[Any], object] | None = None) -> WaitDone:
        stream = self.watch()
        timed_out = threading.Event()
        timer: threading.Timer | None = None
        if timeout is not None:
            def expire() -> None:
                timed_out.set()
                stream.close()

            timer = threading.Timer(timeout, expire)
            timer.daemon = True
            timer.start()
        try:
            for event in stream:
                p = tracker.progress(event)
                if p is not None and on_progress is not None:
                    on_progress(p)
                done = tracker.feed(event)
                if done is not None:
                    return done
            raise WaitTimeoutError(timeout) if timed_out.is_set() else _ended(self.watched)
        except CaitlynError as e:
            if timed_out.is_set():
                raise WaitTimeoutError(timeout) from e
            return tracker.on_error(e)
        finally:
            if timer is not None:
                timer.cancel()
            stream.close()

    def _result(self, done: WaitDone) -> T:
        if self.get is not None:
            return self.get()
        if self.entity is not None and done.entity is not None:
            return self.entity(done.entity)
        return cast(T, done.entity)

    def wait(self, *, job_id: str | None = None, timeout: float | None = None, on_progress: Callable[[Any], object] | None = None,
             cancelled_ok: bool = False) -> T:
        """Returns the thing once no job runs on it (or, with ``job_id``, once that job has ended). ``cancelled_ok``: the
        wait of a call that cancels, which returns the thing when its work ends cancelled."""
        done = self._run(WaitTracker(self.watched, self.codes, job_id=job_id, gone_ok=False, until="idle", cancelled_ok=cancelled_ok), timeout, on_progress)
        return self._result(done)

    def gone(self, *, job_id: str | None = None, timeout: float | None = None, on_progress: Callable[[Any], object] | None = None) -> None:
        """Returns once the thing is gone (after a delete), or the deleting job has ended."""
        self._run(WaitTracker(self.watched, self.codes, job_id=job_id, gone_ok=True, until="idle"), timeout, on_progress)

    def planned(self, *, timeout: float | None = None) -> T:
        """Returns the batch once it is planned or past it; raises its failure when planning failed it."""
        done = self._run(WaitTracker(self.watched, self.codes, job_id=None, gone_ok=False, until="planned"), timeout)
        return self._result(done)


class AsyncFollow[T]:
    """As ``Follow``, for the asynchronous client. Cancelling the task stops a wait with ``asyncio.CancelledError``."""

    def __init__(self, core: AsyncClientCore, watched: Watched, codes: Mapping[str, type[CaitlynError]],
                 get: Callable[[], Awaitable[T]] | None = None, entity: Callable[[Any], T] | None = None) -> None:
        self.core = core
        self.watched = watched
        self.codes = codes
        self.get = get
        self.entity = entity

    def watch(self) -> AsyncEventStream[Any, None]:
        """The thing's events: a snapshot first, then each change; after a reconnect, a new snapshot first."""
        from ._client import Resume

        w = self.watched
        return self.core.stream(w.spec, w.params, w.decoder, Resume(w.spec, w.params, watched=(w.filter, str(w.key)) if w.key is not None else None))

    async def _run(self, tracker: WaitTracker, timeout: float | None, on_progress: Callable[[Any], object] | None = None) -> WaitDone:
        stream = self.watch()
        try:
            try:
                async with asyncio.timeout(timeout):
                    async for event in stream:
                        p = tracker.progress(event)
                        if p is not None and on_progress is not None:
                            out = on_progress(p)
                            if inspect.isawaitable(out):
                                await out
                        done = tracker.feed(event)
                        if done is not None:
                            return done
            except TimeoutError as e:
                raise WaitTimeoutError(timeout) from e
            raise _ended(self.watched)
        except CaitlynError as e:
            return tracker.on_error(e)
        finally:
            await stream.aclose()

    async def _result(self, done: WaitDone) -> T:
        if self.get is not None:
            return await self.get()
        if self.entity is not None and done.entity is not None:
            return self.entity(done.entity)
        return cast(T, done.entity)

    async def wait(self, *, job_id: str | None = None, timeout: float | None = None, on_progress: Callable[[Any], object] | None = None,
                   cancelled_ok: bool = False) -> T:
        """As ``Follow.wait``."""
        done = await self._run(WaitTracker(self.watched, self.codes, job_id=job_id, gone_ok=False, until="idle", cancelled_ok=cancelled_ok), timeout, on_progress)
        return await self._result(done)

    async def gone(self, *, job_id: str | None = None, timeout: float | None = None, on_progress: Callable[[Any], object] | None = None) -> None:
        """Returns once the thing is gone (after a delete), or the deleting job has ended."""
        await self._run(WaitTracker(self.watched, self.codes, job_id=job_id, gone_ok=True, until="idle"), timeout, on_progress)

    async def planned(self, *, timeout: float | None = None) -> T:
        """Returns the batch once it is planned or past it; raises its failure when planning failed it."""
        done = await self._run(WaitTracker(self.watched, self.codes, job_id=None, gone_ok=False, until="planned"), timeout)
        return await self._result(done)


def _ended(watched: Watched) -> CaitlynError:
    return CaitlynError(f"{watched.spec.name}: the watch ended before the wait did", status=0, code="STREAM_LOST",
                        title="The watch ended")


class Started[R, T]:
    """What a call that starts work returns (PROTOCOL.md 16): the response as ``result`` (its fields are also readable
    on this object), ``wait()`` for the work to finish, and ``watch()`` for its events.

    ``doc.update(name="Leave policy", if_match=etag).wait()`` returns the document once the change is applied."""

    def __init__(self, result: R, wait: Callable[[float | None, Callable[[Any], object] | None], T], watch: Callable[[], EventStream[Any, None]]) -> None:
        self.result = result
        """The call's response."""
        self._wait = wait
        self._watch = watch

    def wait(self, *, timeout: float | None = None, on_progress: Callable[[Any], object] | None = None) -> T:
        """Waits for the work the call started; raises its error if it failed. ``timeout`` in seconds (no limit by
        default) raises ``TimeoutError``; ``on_progress`` is called with the thing's processing as it changes."""
        return self._wait(timeout, on_progress)

    def watch(self) -> EventStream[Any, None]:
        """The events of the thing the work is on: a snapshot first, then each change."""
        return self._watch()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") or name == "result":
            raise AttributeError(name)
        return getattr(self.result, name)

    def __repr__(self) -> str:
        return f"Started({self.result!r})"


class AsyncStarted[R, T]:
    """As ``Started``, for the asynchronous client: ``await`` the call, then ``await …wait()``."""

    def __init__(self, result: R, wait: Callable[[float | None, Callable[[Any], object] | None], Awaitable[T]],
                 watch: Callable[[], AsyncEventStream[Any, None]]) -> None:
        self.result = result
        """The call's response."""
        self._wait = wait
        self._watch = watch

    async def wait(self, *, timeout: float | None = None, on_progress: Callable[[Any], object] | None = None) -> T:
        """Waits for the work the call started; raises its error if it failed. ``timeout`` in seconds (no limit by
        default) raises ``TimeoutError``; ``on_progress`` is called with the thing's processing as it changes."""
        return await self._wait(timeout, on_progress)

    def watch(self) -> AsyncEventStream[Any, None]:
        """The events of the thing the work is on: a snapshot first, then each change."""
        return self._watch()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") or name == "result":
            raise AttributeError(name)
        return getattr(self.result, name)

    def __repr__(self) -> str:
        return f"AsyncStarted({self.result!r})"
