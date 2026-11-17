"""The ``ingestion.sync`` helper (PROTOCOL.md 15): keep a knowledge base in step with a folder of files, or a list of
files, through one ingestion batch. The steps, in order: hash; create the batch to start by hand (10,000 items a call,
the last call with ``last: true``); wait with the batch's ``planned()`` and price the items that need bytes; resolve;
start; upload each file as a form POST under the batch's upload policy (at most 6 at once, renewing the policy, and
reporting finished uploads 100 at a time); wait with the batch's ``wait()``; report. ``sync.estimate`` runs the first
three steps and returns the plan with its estimate.

The pricing and the upload are the same code as ``batch.upload.estimate`` and ``batch.upload``
(``batch_upload_estimate_async`` and ``batch_upload_async``), for a batch built by hand: sync is hash, create,
``planned()``, price, confirm and resolve, ``start()``, upload, ``wait()``.

Written once, for the async client. The synchronous client runs it on an event loop of its own in a worker thread
(``run_sync``), calling the synchronous transport from worker threads, so both clients share one sign-in, one retry
budget and one HTTP client."""

from __future__ import annotations

import asyncio
import fnmatch
import inspect
import os
import threading
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Final, Literal, Protocol, cast

import httpx

from ._errors import CaitlynConnectionError, CaitlynError
from ._files import FileInput, PreparedFile, UploadFile, file_error
from ._models import CaitlynEvent, CaitlynModel, CaitlynResult
from ._retry import RETRY_COST, RetryPolicy, backoff, parse_retry_after
from ._scopes import AsyncFollow, Follow, WaitTimeoutError, Watched, WaitTracker
from ._spec import OperationSpec

if TYPE_CHECKING:
    from ._client import AsyncClientCore, EventDecoder, SyncClientCore

BATCH_LIMIT: Final = 10_000
"""Items a CreateIngestionBatch or BatchCreateIngestionBatchItems call takes."""
ESTIMATE_PER_CALL: Final = 10_000
"""Documents an EstimateIngestion call takes: more are priced in calls of at most this many, added together. The core
functions take a private ``_estimate_per_call`` in its place, for the conformance cases."""
NEEDS_BYTES: Final = frozenset({"add", "new_version", "overwrite"})
"""Resolutions whose items are uploaded: the ones an estimate prices."""
COULD_TAKE_BYTES: Final = frozenset({"new", "changed", "conflict"})
"""Outcomes whose items, while still unresolved, could yet be resolved to an upload: an estimate prices them too."""
COMPLETE_LIMIT: Final = 100
"""Item identifiers a CompleteIngestionBatchUploads call takes."""
RENEW_BEFORE_SECONDS: Final = 300.0
"""The upload policy is renewed before an upload when it has less than this left."""
DEFAULT_CONCURRENCY: Final = 6
FINAL_ITEM_STATUSES: Final = frozenset({"indexed", "skipped", "moved", "updated", "removed", "failed", "cancelled"})
FINAL_BATCH_STATUSES: Final = frozenset({"succeeded", "completed_with_failures", "failed", "cancelled", "expired"})
IGNORE_FILE: Final = ".caitlynignore"

type Phase = Literal["checksum", "upload", "planning", "planned", "queued", "processing"] | str
"""``checksum`` and ``upload`` (in bytes) are the SDK's own counts; ``planning``, ``planned``, ``queued`` and
``processing`` come from the batch; the last event's phase is the batch's final status (``succeeded``…)."""


@dataclass(frozen=True, slots=True)
class SyncApi:
    """The operations and types ``ingestion.sync`` uses, from the generated SDK."""

    create: OperationSpec
    add_items: OperationSpec
    get: OperationSpec
    resolve_item: OperationSpec
    start: OperationSpec
    list_items: OperationSpec
    renew_policy: OperationSpec
    complete: OperationSpec
    cancel: OperationSpec
    list_documents: OperationSpec
    estimate: OperationSpec
    watch: OperationSpec
    watch_events: EventDecoder[Any, None]
    batch: type[CaitlynModel]
    """GetIngestionBatch's result."""
    item: type[CaitlynModel]
    """A listed item."""
    estimate_result: type[CaitlynResult]
    """EstimateIngestion's result."""
    codes: Mapping[str, type[CaitlynError]]
    """Each stable code's error class."""


@dataclass(frozen=True, slots=True)
class SyncFile:
    """One file to sync: its path under the target folder (``hr/leave-policy.pdf``) and the file itself."""

    relative_path: str
    file: FileInput

    @property
    def upload_file(self) -> UploadFile:
        return UploadFile.of(self.file)


@dataclass(frozen=True, slots=True)
class IngestionProgress[I]:
    """Where a sync is: ``done`` of ``total`` files (bytes for ``upload``, items after Start)."""

    phase: Phase
    done: int
    total: int
    item: I | None = None


@dataclass(slots=True)
class SyncPlan[B, I, E]:
    """The planned batch, its items, and what uploading and ingesting the items that need bytes would take and cost
    (``None`` when none do), as ``confirm`` sees them and ``sync.estimate`` returns them."""

    batch: B
    items: list[I]
    estimate: E | None


@dataclass(slots=True)
class SyncReport[B, I]:
    """What happened: the batch as it ended, with its counts, and every item with its outcome, resolution, status,
    document, version and failure."""

    batch: B
    items: list[I]


@dataclass(slots=True)
class BatchUpload[B, I]:
    """What ``batch.upload(files)`` did: the batch as it stood when the call ended, one item for each item the call dealt
    with (accepted by CompleteIngestionBatchUploads, so ``ingesting``; or ``failed`` here, with its ``failure_code`` and
    ``failure_detail``), the paths of awaiting items no file was given for (``not_given``: left awaiting upload), and
    the given paths that matched no awaiting item (``unmatched``: nothing was sent for them)."""

    batch: B
    items: list[I]
    not_given: list[str]
    unmatched: list[str]


type BatchFiles[I] = Mapping[str, FileInput] | Callable[[I], FileInput | None]
"""The files for a batch's items: a mapping from each item's path as the batch stores it (``/hr/leave.pdf``; a key
without its leading ``/`` matches too), or a function from an item to its file, or to None for none. One mapping serves
``batch.upload.estimate`` and ``batch.upload``; an ``UploadFile``'s ``hints`` reach the estimate only."""


class SyncCancelledError(asyncio.CancelledError):
    """The cancellation a cancelled ``sync`` raises on the async client: an ``asyncio.CancelledError`` carrying the
    report so far as ``report`` (every item with its last status, those accepted but not yet final included, and the
    batch with its counts). The synchronous client raises ``SyncInterrupted``, a ``KeyboardInterrupt``, with the same.
    A declined ``confirm`` is neither: it raises ``CaitlynError`` with code ``CANCELLED`` and the report."""

    def __init__(self, *args: object, report: SyncReport[Any, Any]) -> None:
        super().__init__(*args)
        self.report = report


class SyncInterrupted(KeyboardInterrupt):
    """The synchronous client's cancelled ``sync``: a ``KeyboardInterrupt`` carrying the report so far as ``report``."""

    def __init__(self, *args: object, report: SyncReport[Any, Any] | None) -> None:
        super().__init__(*args)
        self.report = report


class _Core(Protocol):
    """What ``ingest`` needs from a client core."""

    async def request[M: CaitlynModel](self, spec: OperationSpec, params: Mapping[str, object], result: type[M]) -> M: ...
    async def prepare_file(self, file: FileInput) -> PreparedFile: ...
    async def describe_file(self, file: FileInput) -> dict[str, object]: ...
    async def stage_file(self, file: FileInput, sha256: str) -> PreparedFile: ...
    def cancel_uploads(self) -> None: ...
    async def uploads_done(self) -> None: ...
    async def post_form(self, url: str, fields: Sequence[tuple[str, str]], file: PreparedFile) -> httpx.Response: ...
    @property
    def max_attempts(self) -> int: ...
    def take_retry(self) -> bool: ...
    def watch(self, watched: Watched) -> AsyncIterator[CaitlynEvent]: ...


class _ItemFailed(Exception):
    """An upload that failed after its retries: it fails its item only (PROTOCOL.md 15)."""

    def __init__(self, error: CaitlynError) -> None:
        super().__init__(str(error))
        self.error = error


class _Json(CaitlynResult):
    """A result read as JSON: ``raw`` is the body."""


async def _call[T](fn: Callable[..., T | Awaitable[T]], *args: object) -> T:
    out = fn(*args)
    if inspect.isawaitable(out):
        return await cast(Awaitable[T], out)
    return cast(T, out)


def _now() -> datetime:
    return datetime.now(UTC)


def _folder(folder: str) -> str:
    folder = "/" + folder.strip("/")
    return folder if folder == "/" else folder + "/"


def walk(directory: str | PathLike[str], *, include: Sequence[str] = (), exclude: Sequence[str] = ()) -> list[SyncFile]:
    """The files under ``directory``, sorted, as ``ingest`` takes them: symbolic links are not followed, and the
    ``include`` and ``exclude`` globs and each folder's ``.caitlynignore`` (one glob a line, ``#`` for comments) filter
    them. A glob matches the path relative to ``directory`` (``hr/*.pdf``) or the file's name (``*.tmp``)."""
    root = Path(directory)
    if not root.is_dir():
        raise NotADirectoryError(f"{root} is not a folder")
    out: list[SyncFile] = []
    ignored: list[tuple[str, str]] = []  # (folder relative to root, glob)
    for here, dirs, files in os.walk(root, followlinks=False):
        rel_dir = PurePosixPath(Path(here).relative_to(root).as_posix())
        ignore = Path(here) / IGNORE_FILE
        if ignore.is_file():
            for line in ignore.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    ignored.append((str(rel_dir), line.rstrip("/")))
        dirs[:] = sorted(d for d in dirs if not (Path(here) / d).is_symlink() and not _ignored(ignored, str(rel_dir / d)))
        for name in sorted(files):
            path = Path(here) / name
            rel = str(rel_dir / name) if str(rel_dir) != "." else name
            if name == IGNORE_FILE or path.is_symlink() or not path.is_file():
                continue
            if include and not any(_match(rel, g) for g in include):
                continue
            if any(_match(rel, g) for g in exclude) or _ignored(ignored, rel):
                continue
            out.append(SyncFile(rel, UploadFile.from_path(path)))
    return sorted(out, key=lambda f: f.relative_path)


def _match(rel: str, glob: str) -> bool:
    return fnmatch.fnmatchcase(rel, glob) or fnmatch.fnmatchcase(PurePosixPath(rel).name, glob)


def _ignored(rules: Sequence[tuple[str, str]], rel: str) -> bool:
    for base, glob in rules:
        inside = rel if base == "." else rel[len(base) + 1 :] if rel.startswith(base + "/") else None
        if inside is not None and _match(inside, glob):
            return True
    return False


@dataclass(slots=True)
class _Job[I]:
    """One awaiting item to send: its object key and checksum, and its file, hashed already (sync) or staged when its
    turn comes (``batch.upload``, which never hashes)."""

    item: I
    key: str
    sha256: str
    byte_size: int
    file: PreparedFile | None = None
    source: FileInput | None = None
    staged: bool = False


class _Uploads[I]:
    """Sending the awaiting items' files under the policy and reporting them with CompleteIngestionBatchUploads: sync's
    step 6, and ``batch.upload``."""

    def __init__(self, core: _Core, api: SyncApi, ids: dict[str, object], policy: dict[str, Any], concurrency: int,
                 progress: Callable[[IngestionProgress[I]], Awaitable[None]], jobs: dict[str, _Job[I]],
                 item_failed: Callable[[str, CaitlynError], Awaitable[None]],
                 reported: Callable[[int, int], Awaitable[None]] | None = None) -> None:
        self.reported = reported
        """Called after each CompleteIngestionBatchUploads call, with the items accepted so far and the files uploaded."""
        self.core = core
        self.api = api
        self.ids = ids
        self.policy = policy
        self.semaphore = asyncio.Semaphore(max(1, concurrency))
        self.renew_lock = asyncio.Lock()
        self.complete_lock = asyncio.Lock()
        self.pending: list[str] = []
        self.progress = progress
        self.sent_bytes = 0
        self.jobs = jobs
        self.total_bytes = sum(j.byte_size for j in jobs.values())
        self.retried: set[str] = set()
        self.item_failed = item_failed
        self.accepted: list[str] = []
        """Items CompleteIngestionBatchUploads accepted, in the order it did."""
        self.uploaded = 0
        """Files storage took."""

    def _expires_in(self) -> float:
        expires = datetime.fromisoformat(str(self.policy["expiresAt"]).replace("Z", "+00:00"))
        return (expires - _now()).total_seconds()

    async def renew(self, stale: dict[str, Any] | None = None) -> None:
        """A fresh policy, once for all the uploads waiting on it."""
        async with self.renew_lock:
            if stale is not None and self.policy is not stale:
                return  # another upload renewed it already
            if stale is None and self._expires_in() >= RENEW_BEFORE_SECONDS:
                return
            out = await self.core.request(self.api.renew_policy, self.ids, _Json)
            self.policy = cast(dict[str, Any], out.raw["uploadPolicy"])

    async def _file(self, job: _Job[I]) -> PreparedFile:
        """The job's file, staged on first use. A file whose size is not the item's fails it with FILE_CHANGED, before
        any of it is sent."""
        if job.file is None:
            assert job.source is not None
            name = UploadFile.of(job.source).name
            try:
                job.file = await self.core.stage_file(job.source, job.sha256)
            except CaitlynError as e:
                raise _ItemFailed(e) from e
            except OSError as e:
                raise _ItemFailed(file_error("FILE_CHANGED", f"{name} can no longer be read: {e}")) from e
            job.staged = True
            if job.file.byte_size != job.byte_size:
                raise _ItemFailed(file_error("FILE_CHANGED", f"{name} is {job.file.byte_size} bytes, but its item says {job.byte_size}; nothing was sent"))
        return job.file

    async def send(self, key: str, file: PreparedFile) -> None:
        """One file, retried as a call safe to repeat; a 403 saying the policy expired renews it once and resends."""
        renewed = False
        attempt = 0
        while True:
            if self._expires_in() < RENEW_BEFORE_SECONDS:
                await self.renew()
            policy = self.policy
            fields: list[tuple[str, str]] = [(str(k), str(v)) for k, v in cast(dict[str, Any], policy["formFields"]).items()]
            fields += [("key", key), ("Content-Type", file.content_type), ("x-amz-checksum-algorithm", "SHA256"),
                       ("x-amz-checksum-sha256", file.sha256)]
            try:
                file.check_unchanged()
            except CaitlynError as e:
                raise _ItemFailed(e) from e
            try:
                response = await self.core.post_form(str(policy["uploadUrl"]), fields, file)
            except httpx.TransportError as e:
                if attempt + 1 >= self.core.max_attempts or not self.core.take_retry():
                    failure = CaitlynConnectionError(f"UPLOAD_FAILED: {file.name}: {e}", status=0, code="UPLOAD_FAILED", title=f"Uploading {file.name} failed")
                    raise _ItemFailed(failure) from e
                await asyncio.sleep(backoff_delay(attempt))
                attempt += 1
                continue
            if response.status_code < 300:
                return
            text = response.text
            if response.status_code == 403 and "expired" in text.lower() and not renewed:
                renewed = True
                await self.renew(stale=policy)
                continue
            if response.status_code == 400 and "BadDigest" in text:
                # The form carries the item's checksum, so storage refuses other bytes; sending them again cannot succeed.
                raise _ItemFailed(file_error("FILE_CHANGED", f"storage refused {file.name}: its bytes are not the ones the item was made from"))
            if response.status_code in (429, 500, 502, 503, 504) and attempt + 1 < self.core.max_attempts and self.core.take_retry():
                after = parse_retry_after(response.headers.get("Retry-After"))
                await asyncio.sleep(after if after is not None else backoff_delay(attempt))
                attempt += 1
                continue
            raise _ItemFailed(CaitlynError(f"{response.status_code} UPLOAD_FAILED: {file.name}", status=response.status_code, code="UPLOAD_FAILED",
                                           title=f"Uploading {file.name} failed", detail=text[:500] or None))

    async def upload(self, item_id: str) -> None:
        job = self.jobs[item_id]
        try:
            async with self.semaphore:
                await self.send(job.key, await self._file(job))
        except _ItemFailed as e:
            await self.item_failed(item_id, e.error)  # that item only: the other uploads carry on
            return
        self.uploaded += 1
        self.sent_bytes += job.byte_size
        await self.progress(IngestionProgress("upload", self.sent_bytes, self.total_bytes, job.item))
        self.pending.append(item_id)
        if len(self.pending) >= COMPLETE_LIMIT:
            await self.flush()

    async def flush(self) -> None:
        """Report finished uploads, at most 100 a call; an item failed with CHECKSUM_MISMATCH is uploaded once more,
        and a second mismatch fails it."""
        async with self.complete_lock:
            while self.pending:
                group, self.pending = self.pending[:COMPLETE_LIMIT], self.pending[COMPLETE_LIMIT:]
                out = await self.core.request(self.api.complete, {**self.ids, "item_ids": group}, _Json)
                again: list[str] = []
                for r in cast(list[dict[str, Any]], out.raw.get("results") or []):
                    item_id = str(r.get("itemId"))
                    if r.get("status") == "accepted":
                        self.accepted.append(item_id)
                    elif r.get("code") == "CHECKSUM_MISMATCH" and item_id in self.jobs:
                        if item_id not in self.retried:
                            self.retried.add(item_id)
                            again.append(item_id)
                        else:
                            await self.item_failed(item_id, CaitlynError(
                                f"CHECKSUM_MISMATCH: {r.get('detail') or item_id}", status=0, code="CHECKSUM_MISMATCH",
                                title="The stored object did not match the item twice", detail=cast(str | None, r.get("detail"))))
                if self.reported is not None:
                    await self.reported(len(self.accepted), self.uploaded)
                for item_id in again:
                    job = self.jobs[item_id]
                    try:
                        async with self.semaphore:
                            await self.send(job.key, await self._file(job))
                    except _ItemFailed as e:
                        await self.item_failed(item_id, e.error)
                        continue
                    self.pending.append(item_id)

    def close(self) -> None:
        """Delete what staging spooled."""
        for job in self.jobs.values():
            if job.staged and job.file is not None:
                job.file.close()


async def _send[I](core: _Core, api: SyncApi, ids: dict[str, object], jobs: dict[str, _Job[I]], policy: dict[str, Any] | None,
                   concurrency: int, progress: Callable[[IngestionProgress[I]], Awaitable[None]],
                   item_failed: Callable[[str, CaitlynError], Awaitable[None]],
                   reported: Callable[[int, int], Awaitable[None]] | None = None) -> _Uploads[I]:
    """Upload each job's file and report them (PROTOCOL.md 15, sync's step 6): at most ``concurrency`` at once, the
    policy renewed as it runs out, Complete in groups of at most 100. Without ``policy`` (``batch.upload``), a fresh one
    is asked for first. Cancellation aborts the uploads in flight and is raised as itself."""
    if policy is None:
        policy = cast(dict[str, Any], (await core.request(api.renew_policy, ids, _Json)).raw["uploadPolicy"])
    uploads: _Uploads[I] = _Uploads(core, api, ids, policy, concurrency, progress, jobs, item_failed, reported)
    await progress(IngestionProgress("upload", 0, uploads.total_bytes))
    try:
        try:
            async with asyncio.TaskGroup() as tg:
                for item_id in jobs:
                    tg.create_task(uploads.upload(item_id))
        except BaseExceptionGroup as group:  # a batch-stopping error (the policy renewal): raised as itself
            raise group.exceptions[0] from None
        await uploads.flush()
    except asyncio.CancelledError:
        core.cancel_uploads()  # the uploads still sending in worker threads stop within a chunk
        raise
    finally:
        uploads.close()
        await core.uploads_done()
    return uploads


def backoff_delay(attempt: int) -> float:
    return backoff(RetryPolicy(), attempt)


@dataclass(slots=True)
class _Prepared[B, I, E]:
    """Steps 1 to 3: the files hashed, the batch created and planned, and its estimate."""

    ids: dict[str, object]
    """The batch's identifiers, as every batch call takes them."""
    items: list[dict[str, object]]
    prepared: dict[str, PreparedFile]
    plan: SyncPlan[B, I, E]


async def _prepare[B: CaitlynModel, I: CaitlynModel, E: CaitlynResult](
    core: _Core,
    api: SyncApi,
    batch_type: type[B],
    item_type: type[I],
    estimate_type: type[E],
    knowledge_base_id: str,
    source: str | PathLike[str] | Sequence[SyncFile],
    *,
    folder: str,
    policy: object,
    include: Sequence[str],
    exclude: Sequence[str],
    key: Callable[[SyncFile], str | None] | None,
    source_url: Callable[[SyncFile], str | None] | None,
    metadata: Callable[[SyncFile], Mapping[str, object] | None] | None,
    remove_missing: bool,
    progress: Callable[[IngestionProgress[I]], Awaitable[None]],
    created: Callable[[str], None],
    estimate_per_call: int,
) -> _Prepared[B, I, E]:
    folder = _folder(folder)
    files = walk(source, include=include, exclude=exclude) if isinstance(source, (str, PathLike)) else list(source)
    prepared: dict[str, PreparedFile] = {}
    hints: dict[str, dict[str, object]] = {}
    try:
        # 1. Hash
        items: list[dict[str, object]] = []
        await progress(IngestionProgress("checksum", 0, len(files)))
        for n, f in enumerate(files, 1):
            p = await core.prepare_file(f.file)
            path = folder + f.relative_path.lstrip("/")
            prepared[path] = p
            caller_hints = UploadFile.of(f.file).hints_wire()
            if caller_hints is not None:
                hints[path] = caller_hints
            item: dict[str, object] = {"path": path, "sha256": p.sha256, "byteSize": p.byte_size, "contentType": p.content_type}
            # Keys default to the relative path (PROTOCOL.md 15), so a file keeps its document wherever the folder goes.
            external = key(f) if key is not None else f.relative_path.lstrip("/")
            if external is not None:
                item["externalId"] = external
            for name, fn in (("sourceUrl", source_url), ("metadata", metadata)):
                value = fn(f) if fn is not None else None
                if value is not None:
                    item[name] = value
            items.append(item)
            await progress(IngestionProgress("checksum", n, len(files)))
        if remove_missing:
            items += await _removals(core, api, knowledge_base_id, folder, items)

        # 2. Create, to start by hand; the rest of the items 10,000 a call, the last with `last: true`
        first, rest = items[:BATCH_LIMIT], items[BATCH_LIMIT:]
        create: dict[str, object] = {"knowledge_base_id": knowledge_base_id, "start": "manual", "items": first}
        if rest:
            create["await_more_items"] = True
        if policy is not None:
            create["policy"] = policy
        if folder != "/":
            create["scope"] = {"folderPath": folder}
        batch = await core.request(api.create, create, _Json)
        ids: dict[str, object] = {"knowledge_base_id": knowledge_base_id, "ingestion_batch_id": str(batch.raw["id"])}
        created(str(batch.raw["id"]))
        for i in range(0, len(rest), BATCH_LIMIT):
            await core.request(api.add_items, {**ids, "items": rest[i : i + BATCH_LIMIT], "last": i + BATCH_LIMIT >= len(rest)}, _Json)

        # 3. Plan, then price the items that need bytes
        await progress(IngestionProgress("planning", 0, len(items)))
        planned = await _follow(core, api, batch_type, ids, "planned")
        all_items = await _items(core, api, item_type, ids)
        await progress(IngestionProgress("planned", len(all_items), len(items)))
        # Each file described as an estimate takes it, from what step 1 read (no second read of the file).
        described: dict[str, dict[str, object]] = {}
        for path, p in prepared.items():
            described[path] = {"name": p.name, "contentType": p.content_type, "byteSize": p.byte_size}
            if path in hints:
                described[path]["hints"] = dict(hints[path])  # what the caller read of the file, as it gave it
        estimate = await _price(core, api, estimate_type, knowledge_base_id, _documents(_priceable(all_items), described), estimate_per_call)
        return _Prepared(ids, items, prepared, SyncPlan(planned, all_items, estimate))
    except BaseException:
        for p in prepared.values():
            p.close()
        raise


def _priceable[I: CaitlynModel](items: Sequence[I]) -> list[I]:
    """The items an estimate prices: every item that could need its bytes, as the most the batch could cost. Those
    resolved add, new_version or overwrite, and those still unresolved whose outcome could take bytes (new, changed or
    a conflict); with status ``draft`` or ``awaiting_upload``, so neither final nor uploaded already. Items resolved
    skip, remove, move or update are not priced."""
    def could_need_bytes(i: I) -> bool:
        resolution = str(getattr(i, "resolution", ""))
        return resolution in NEEDS_BYTES or (resolution == "unresolved" and str(getattr(i, "outcome", "")) in COULD_TAKE_BYTES)

    return [i for i in items if could_need_bytes(i) and str(getattr(i, "status", "")) in ("draft", "awaiting_upload")]


def _documents(items: Sequence[CaitlynModel], described: Mapping[str, Mapping[str, object]]) -> list[dict[str, object]]:
    """Each item as EstimateIngestion takes it, ``{name, contentType, byteSize, hints?}``: its file's description where
    a file was given for it, else the item's own name, content type and size, with no hints."""
    out: list[dict[str, object]] = []
    for i in items:
        path = str(getattr(i, "path", "") or "")
        if path in described:
            out.append(dict(described[path]))
            continue
        out.append({"name": PurePosixPath(path).name or str(getattr(i, "id")),
                    "contentType": str(getattr(i, "content_type", "") or "application/octet-stream"),
                    "byteSize": int(getattr(i, "byte_size", 0) or 0)})
    return out


async def _price[E: CaitlynResult](core: _Core, api: SyncApi, estimate_type: type[E], knowledge_base_id: str,
                                   documents: Sequence[Mapping[str, object]], per_call: int) -> E | None:
    """EstimateIngestion for the documents, in calls of at most ``per_call`` added together; None when there are none."""
    if not documents:
        return None
    parts = [
        dict((await core.request(api.estimate, {"knowledge_base_id": knowledge_base_id, "documents": list(documents[n : n + per_call])}, _Json)).raw)
        for n in range(0, len(documents), per_call)
    ]
    return estimate_type.from_wire(parts[0] if len(parts) == 1 else _add_estimates(parts))


def _add_estimates(parts: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Estimates of the parts of one job as one: counts summed, the time's low and high ends summed, the cost's low and
    high ends summed in its unit and present only when every part has one, and no details (PROTOCOL.md 15)."""
    out: dict[str, Any] = {}
    for k in ("documents", "pages", "mediaSeconds", "documentsOfUnknownLength"):
        if any(k in p for p in parts):
            out[k] = sum(int(p.get(k) or 0) for p in parts)
    durations = [cast(Mapping[str, Any], p["durationSeconds"]) for p in parts if isinstance(p.get("durationSeconds"), dict)]
    if durations:
        out["durationSeconds"] = {"low": sum(d["low"] for d in durations), "high": sum(d["high"] for d in durations)}
    costs = [cast(Mapping[str, Any], p["cost"]) for p in parts if isinstance(p.get("cost"), dict)]
    if costs and len(costs) == len(parts):
        out["cost"] = {"low": sum(c["low"] for c in costs), "high": sum(c["high"] for c in costs), "unit": costs[0]["unit"]}
    return out


async def sync_estimate_async[B: CaitlynModel, I: CaitlynModel, E: CaitlynResult](
    core: _Core,
    api: SyncApi,
    batch_type: type[B],
    item_type: type[I],
    estimate_type: type[E],
    knowledge_base_id: str,
    source: str | PathLike[str] | Sequence[SyncFile],
    *,
    folder: str = "/",
    policy: object = None,
    include: Sequence[str] = (),
    exclude: Sequence[str] = (),
    key: Callable[[SyncFile], str | None] | None = None,
    source_url: Callable[[SyncFile], str | None] | None = None,
    metadata: Callable[[SyncFile], Mapping[str, object] | None] | None = None,
    remove_missing: bool = False,
    _estimate_per_call: int = ESTIMATE_PER_CALL,
) -> SyncPlan[B, I, E]:
    """``sync.estimate``: steps 1 to 3 of PROTOCOL.md 15, uploading nothing. The batch is left planned: its plan goes stale after 5 minutes, and a batch never started is cleared after 7 days."""

    async def progress(_: IngestionProgress[I]) -> None:
        return None

    done = await _prepare(core, api, batch_type, item_type, estimate_type, knowledge_base_id, source, folder=folder, policy=policy,
                          include=include, exclude=exclude, key=key, source_url=source_url, metadata=metadata,
                          remove_missing=remove_missing, progress=progress, created=lambda _: None,
                          estimate_per_call=_estimate_per_call)
    for p in done.prepared.values():
        p.close()
    return done.plan


async def sync_async[B: CaitlynModel, I: CaitlynModel, E: CaitlynResult](
    core: _Core,
    api: SyncApi,
    batch_type: type[B],
    item_type: type[I],
    estimate_type: type[E],
    knowledge_base_id: str,
    source: str | PathLike[str] | Sequence[SyncFile],
    *,
    folder: str = "/",
    policy: object = None,
    include: Sequence[str] = (),
    exclude: Sequence[str] = (),
    key: Callable[[SyncFile], str | None] | None = None,
    source_url: Callable[[SyncFile], str | None] | None = None,
    metadata: Callable[[SyncFile], Mapping[str, object] | None] | None = None,
    remove_missing: bool = False,
    confirm: Callable[[SyncPlan[B, I, E]], bool | Awaitable[bool]] | None = None,
    resolver: Callable[[list[I]], Mapping[str, str] | Awaitable[Mapping[str, str]]] | None = None,
    on_progress: Callable[[IngestionProgress[I]], object] | None = None,
    on_item: Callable[[I], object] | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    cancel_ingestion: bool = False,
    _estimate_per_call: int = ESTIMATE_PER_CALL,
) -> SyncReport[B, I]:
    """PROTOCOL.md 15, in order. See the generated ``ingestion.sync`` for the options."""

    async def progress(p: IngestionProgress[I]) -> None:
        if on_progress is not None:
            await _call(on_progress, p)

    reported: set[str] = set()
    batch_ids: list[dict[str, object]] = []
    batch_cancelled = False
    upload_failures: dict[str, CaitlynError] = {}
    prepared: dict[str, PreparedFile] = {}
    try:
        # 1 to 3: hash, create, plan and price
        done = await _prepare(core, api, batch_type, item_type, estimate_type, knowledge_base_id, source, folder=folder, policy=policy,
                              include=include, exclude=exclude, key=key, source_url=source_url, metadata=metadata,
                              remove_missing=remove_missing, progress=progress,
                              created=lambda batch_id: batch_ids.append({"knowledge_base_id": knowledge_base_id, "ingestion_batch_id": batch_id}),
                              estimate_per_call=_estimate_per_call)
        ids, items, prepared, plan = done.ids, done.items, done.prepared, done.plan
        planned, all_items = plan.batch, plan.items

        # 4. Resolve
        if confirm is not None and not await _call(confirm, plan):
            # Declining the plan cancels the batch and ends the call with CANCELLED, an ordinary CaitlynError carrying
            # the report so far: a decision of the caller's code, not the language's cancellation.
            await core.request(api.cancel, ids, _Json)
            batch_cancelled = True
            declined = CaitlynError("CANCELLED: confirm declined the plan; the batch was cancelled", status=0, code="CANCELLED",
                                    title="confirm declined the plan")
            declined.report = await _after_cancel(core, api, batch_type, item_type, ids, False, upload_failures)
            raise declined
        unresolved = [i for i in all_items if str(getattr(i, "resolution", "")) == "unresolved"]
        if unresolved:
            batch_id = str(ids["ingestion_batch_id"])
            if resolver is None:
                err = file_error("INGESTION_BATCH_UNRESOLVED",
                                 f"{len(unresolved)} item(s) of batch {batch_id} need a decision; pass resolver=, or resolve them and start the batch")
                err.detail = batch_id
                raise err
            chosen = await _call(resolver, unresolved)
            for i in unresolved:
                item_id = str(getattr(i, "id"))
                resolution = chosen.get(item_id)
                if resolution is None:
                    raise file_error("INGESTION_BATCH_UNRESOLVED", f"the resolver left item {item_id} of batch {batch_id} unresolved")
                await core.request(api.resolve_item, {**ids, "item_id": item_id, "if_match": getattr(i, "etag"), "resolution": str(resolution)}, _Json)
            planned = await core.request(api.get, ids, batch_type)

        # 5. Start
        etag = planned.response_metadata.etag if planned.response_metadata else None
        start = await core.request(api.start, {**ids, "if_match": etag or getattr(planned, "etag", None)}, _Json)
        upload_policy = cast(dict[str, Any] | None, start.raw.get("uploadPolicy"))

        # Items Start made final (skipped, removed, moved, updated) reach on_item now, once each: so a cancellation
        # later has nothing left to report, and on_item never hears of an item that became final after it.
        if on_item is not None:
            for i in await _items(core, api, item_type, ids):
                item_id = str(getattr(i, "id"))
                if str(getattr(i, "status", "")) in FINAL_ITEM_STATUSES and item_id not in reported:
                    reported.add(item_id)
                    await _call(on_item, i)

        # 6. Upload
        awaiting = await _items(core, api, item_type, ids, status="awaiting_upload")
        if awaiting:
            if upload_policy is None:
                raise CaitlynError("StartIngestionBatch returned no upload policy, but items are awaiting upload",
                                   status=0, code="UPLOAD_POLICY_MISSING", title="No upload policy")
            by_sha = {p.sha256: p for p in prepared.values()}
            jobs: dict[str, _Job[I]] = {}
            for i in awaiting:
                path, sha, object_key = getattr(i, "path", None), getattr(i, "sha256", None), getattr(i, "object_key", None)
                file = prepared.get(str(path)) or by_sha.get(str(sha))
                if file is None or object_key is None:
                    raise CaitlynError(f"item {getattr(i, 'id')} ({path}) is awaiting upload, but no file given has it",
                                       status=0, code="SYNC_FILE_UNKNOWN", title="Unknown item")
                jobs[str(getattr(i, "id"))] = _Job(i, str(object_key), file.sha256, file.byte_size, file=file)
            by_id = {str(getattr(i, "id")): i for i in awaiting}

            async def item_failed(item_id: str, error: CaitlynError) -> None:
                upload_failures[item_id] = error
                failed = _failed_item(item_type, by_id[item_id], error)
                if on_item is not None and item_id not in reported:
                    reported.add(item_id)
                    await _call(on_item, failed)

            await _send(core, api, ids, jobs, upload_policy, concurrency, progress, item_failed)
            await progress(IngestionProgress("queued", 0, len(items)))

        # 7. Wait, with the batch's wait(): each snapshot of the batch reports progress and the items that finished
        async def emit(raw: Mapping[str, Any]) -> None:
            total = int(raw.get("itemCount") or len(items))
            counts = cast(dict[str, Any], raw.get("counts") or {})
            by_status = cast(dict[str, int], counts.get("byStatus") or {})
            final = sum(v for k, v in by_status.items() if k in FINAL_ITEM_STATUSES)
            if by_status.get("ingesting"):
                await progress(IngestionProgress("processing", final, total))
            elif str(raw.get("status")) == "running":
                await progress(IngestionProgress("queued", final, total))
            if on_item is not None and final > len(reported):
                for i in await _items(core, api, item_type, ids):
                    item_id = str(getattr(i, "id"))
                    if str(getattr(i, "status", "")) in FINAL_ITEM_STATUSES and item_id not in reported:
                        reported.add(item_id)
                        await _call(on_item, i)

        finished = await _follow(core, api, batch_type, ids, "idle", emit)
        report_items = [_failed_item(item_type, i, upload_failures[str(getattr(i, "id"))]) if str(getattr(i, "id")) in upload_failures else i
                        for i in await _items(core, api, item_type, ids)]
        if on_item is not None:
            for i in report_items:
                if str(getattr(i, "id")) not in reported:
                    reported.add(str(getattr(i, "id")))
                    await _call(on_item, i)
        final_status = str(getattr(finished, "status"))
        await progress(IngestionProgress(final_status, len(report_items), len(report_items)))
        return SyncReport(finished, report_items)
    except asyncio.CancelledError as e:
        if not batch_ids:
            raise
        report = await asyncio.shield(_after_cancel(core, api, batch_type, item_type, batch_ids[0], cancel_ingestion and not batch_cancelled,
                                                    upload_failures))
        # The language's own cancellation, carrying the report so far (PROTOCOL.md 15).
        cancelled = SyncCancelledError(*e.args, report=report)
        raise cancelled from e
    finally:
        for p in prepared.values():
            p.close()


# --------------------------------------------------------------------------- batch.upload and batch.upload.estimate


def _sdk_error(code: str, message: str, detail: str | None = None) -> CaitlynError:
    """An error the SDK raises itself, with nothing sent for it: status 0, never retried (PROTOCOL.md 6.3)."""
    return CaitlynError(f"{code}: {message}", status=0, code=code, title=message, detail=detail)


def _path_key(path: object) -> str:
    return "/" + str(path or "").lstrip("/")


class _Given[I: CaitlynModel]:
    """The files a caller gave, by item path or by function."""

    def __init__(self, files: BatchFiles[I]) -> None:
        if isinstance(files, Mapping):
            by_path = cast(Mapping[str, FileInput], files)
            self.by_path: dict[str, FileInput] | None = {_path_key(k): v for k, v in by_path.items()}
            self.fn: Callable[[I], FileInput | None] | None = None
        else:
            self.by_path = None
            self.fn = files

    def file(self, item: I) -> FileInput | None:
        if self.by_path is not None:
            return self.by_path.get(_path_key(getattr(item, "path", "")))
        assert self.fn is not None
        return self.fn(item)

    def unmatched(self, matched: set[str]) -> list[str]:
        return [p for p in self.by_path if p not in matched] if self.by_path is not None else []


async def _within[T](timeout: float | None, waiting: Awaitable[T]) -> T:
    if timeout is None:
        return await waiting
    try:
        async with asyncio.timeout(timeout):
            return await waiting
    except TimeoutError as e:
        if isinstance(e, WaitTimeoutError):
            raise
        raise WaitTimeoutError(timeout) from e


def _empty_estimate[E: CaitlynResult](estimate_type: type[E]) -> E:
    return estimate_type.from_wire({"documents": 0, "pages": 0, "mediaSeconds": 0, "documentsOfUnknownLength": 0,
                                    "durationSeconds": {"low": 0, "high": 0}})


async def batch_upload_estimate_async[B: CaitlynModel, I: CaitlynModel, E: CaitlynResult](
    core: _Core,
    api: SyncApi,
    batch_type: type[B],
    item_type: type[I],
    estimate_type: type[E],
    knowledge_base_id: str,
    ingestion_batch_id: str,
    files: BatchFiles[I] | None = None,
    *,
    timeout: float | None = None,
    _estimate_per_call: int = ESTIMATE_PER_CALL,
) -> E:
    """``batch.upload.estimate(files)`` (PROTOCOL.md 15): what uploading the batch's items that need bytes would take
    and cost. A planning batch is waited on (``timeout`` as ``planned()`` takes it); a draft one raises
    ``INGESTION_BATCH_NOT_PLANNED``. Each item is described by its file when one is given (name, content type, size and
    the hints given with it, never hashed and never read), else by the item; with none to price, the estimate is empty
    and nothing is sent."""
    ids: dict[str, object] = {"knowledge_base_id": knowledge_base_id, "ingestion_batch_id": ingestion_batch_id}
    status = str((await core.request(api.get, ids, _Json)).raw.get("status"))
    if status == "draft":
        raise _sdk_error("INGESTION_BATCH_NOT_PLANNED", f"batch {ingestion_batch_id} is a draft: add its last items (last=True) first, then estimate it",
                         ingestion_batch_id)
    if status == "planning":
        await _within(timeout, _follow(core, api, batch_type, ids, "planned"))
    elif status in FINAL_BATCH_STATUSES:
        return _empty_estimate(estimate_type)
    priced = _priceable(await _items(core, api, item_type, ids))
    described: dict[str, dict[str, object]] = {}
    if files is not None:
        given = _Given(files)
        for i in priced:
            f = given.file(i)
            if f is not None:
                described[str(getattr(i, "path", "") or "")] = await core.describe_file(f)
    out = await _price(core, api, estimate_type, knowledge_base_id, _documents(priced, described), _estimate_per_call)
    return out if out is not None else _empty_estimate(estimate_type)


async def batch_upload_async[B: CaitlynModel, I: CaitlynModel](
    core: _Core,
    api: SyncApi,
    batch_type: type[B],
    item_type: type[I],
    knowledge_base_id: str,
    ingestion_batch_id: str,
    files: BatchFiles[I],
    *,
    concurrency: int = DEFAULT_CONCURRENCY,
    on_progress: Callable[[IngestionProgress[I]], object] | None = None,
    on_item: Callable[[I], object] | None = None,
) -> BatchUpload[B, I]:
    """``batch.upload(files)`` (PROTOCOL.md 15): sends the files of the batch's items awaiting upload, as sync's step 6
    does, and reports them. A ``when_planned`` batch still planning is followed until it runs; one not started raises
    ``INGESTION_BATCH_NOT_STARTED``. Files are not hashed: one whose size is not its item's fails that item with
    ``FILE_CHANGED`` before sending, and storage refuses other bytes of the right size (``FILE_CHANGED`` too). An item
    with no file given is left awaiting upload. Cancelling aborts the uploads and leaves the batch as it is."""

    async def progress(p: IngestionProgress[I]) -> None:
        if on_progress is not None:
            await _call(on_progress, p)

    ids: dict[str, object] = {"knowledge_base_id": knowledge_base_id, "ingestion_batch_id": ingestion_batch_id}
    given = _Given(files)
    raw = (await core.request(api.get, ids, _Json)).raw
    status = str(raw.get("status"))
    if status == "planning" and str(raw.get("start")) == "when_planned":
        status = str(getattr(await _follow(core, api, batch_type, ids, "planned"), "status"))
    if status in FINAL_BATCH_STATUSES:
        return BatchUpload(await core.request(api.get, ids, batch_type), [], [], given.unmatched(set()))
    if status != "running":
        raise _sdk_error("INGESTION_BATCH_NOT_STARTED",
                         f"batch {ingestion_batch_id} is {status}, not running: start it with batch.start() (resolving any unresolved items first), then upload",
                         ingestion_batch_id)
    awaiting = await _items(core, api, item_type, ids, status="awaiting_upload")
    jobs: dict[str, _Job[I]] = {}
    not_given: list[str] = []
    matched: set[str] = set()
    for i in awaiting:
        path = _path_key(getattr(i, "path", ""))
        f = given.file(i)
        if f is None:
            not_given.append(path)
            continue
        matched.add(path)
        jobs[str(getattr(i, "id"))] = _Job(i, str(getattr(i, "object_key")), str(getattr(i, "sha256")), int(getattr(i, "byte_size", 0) or 0), source=f)
    failures: dict[str, CaitlynError] = {}
    accepted: list[str] = []
    if jobs:
        async def item_failed(item_id: str, error: CaitlynError) -> None:
            failures[item_id] = error
            if on_item is not None:
                await _call(on_item, _failed_item(item_type, jobs[item_id].item, error))

        async def reported(done: int, uploaded: int) -> None:
            await progress(IngestionProgress("queued", done, uploaded))  # after each Complete: accepted of uploaded

        accepted = (await _send(core, api, ids, jobs, None, concurrency, progress, item_failed, reported)).accepted
    dealt = set(accepted) | set(failures)
    items = [_failed_item(item_type, i, failures[item_id]) if (item_id := str(getattr(i, "id"))) in failures else i
             for i in await _items(core, api, item_type, ids) if str(getattr(i, "id")) in dealt]
    return BatchUpload(await core.request(api.get, ids, batch_type), items, not_given, given.unmatched(matched))


def _failed_item[I: CaitlynModel](item_type: type[I], item: I, error: CaitlynError) -> I:
    """The item as the report gives it once its upload failed: ``failed``, with the upload's error."""
    raw = dict(cast(dict[str, Any], getattr(item, "raw", {}) or {}))
    raw.update(status="failed", failureCode=error.code, failureDetail=error.detail or error.title)
    return item_type.from_wire(raw)


async def _after_cancel[B: CaitlynModel, I: CaitlynModel](core: _Core, api: SyncApi, batch_type: type[B], item_type: type[I],
                                                         ids: dict[str, object], stop: bool, upload_failures: Mapping[str, CaitlynError]
                                                         ) -> SyncReport[B, I]:
    """On cancellation: cancel the batch when asked, stopping ingestion already running, then read the report so far:
    the batch with its counts, and every item with its last status (an upload that failed, as failed). on_item is not
    called again: it has had every item final before the cancellation as each became final, and no other."""
    if stop:
        await core.request(api.cancel, {**ids, "stop_running": True}, _Json)
    batch = await core.request(api.get, ids, batch_type)
    items = [_failed_item(item_type, i, upload_failures[str(getattr(i, "id"))]) if str(getattr(i, "id")) in upload_failures else i
             for i in await _items(core, api, item_type, ids)]
    return SyncReport(batch, items)


async def _follow[B: CaitlynModel](core: _Core, api: SyncApi, batch_type: type[B], ids: Mapping[str, object],
                                    until: Literal["idle", "planned"], each: Callable[[Mapping[str, Any]], Awaitable[None]] | None = None) -> B:
    """The batch's ``planned()`` or ``wait()``: its watch, until it is planned (or past it) or has ended; then the batch as
    GetIngestionBatch returns it. A batch that ended failed raises its own failure code."""
    batch_id = str(ids["ingestion_batch_id"])
    watched = Watched(api.watch, {"knowledge_base_id": ids["knowledge_base_id"], "batch": batch_id}, api.watch_events, "batch", batch_id)
    tracker = WaitTracker(watched, api.codes, job_id=None, gone_ok=False, until=until)
    async for event in core.watch(watched):
        done = tracker.feed(event)
        if each is not None and event.type == "snapshot" and tracker.entity is not None:
            await each(tracker.entity)
        if done is not None:
            break
    return await core.request(api.get, ids, batch_type)


async def _items[I: CaitlynModel](core: _Core, api: SyncApi, item_type: type[I], ids: Mapping[str, object], *, status: str | None = None) -> list[I]:
    out: list[I] = []
    cursor: str | None = None
    while True:
        params: dict[str, object] = {**ids, "cursor": cursor}
        if status is not None:
            params["status"] = status
        page = await core.request(api.list_items, params, _Json)
        out += [item_type.from_wire(i) for i in cast(list[object], page.raw.get("items") or [])]
        cursor = cast(str | None, page.raw.get("nextCursor"))
        if not cursor:
            return out


async def _removals(core: _Core, api: SyncApi, knowledge_base_id: str, folder: str, items: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    """A ``remove`` item for each document under ``folder`` that no file names, by path or ``externalId``."""
    paths = {str(i["path"]) for i in items}
    keys = {str(i["externalId"]) for i in items if "externalId" in i}
    out: list[dict[str, object]] = []
    cursor: str | None = None
    while True:
        params: dict[str, object] = {"knowledge_base_id": knowledge_base_id, "folder": folder, "deep": True, "cursor": cursor}
        page = await core.request(api.list_documents, params, _Json)
        for d in cast(list[dict[str, Any]], page.raw.get("items") or []):
            path = _folder(str(d.get("folder") or "/")) + str(d.get("name"))
            if path in paths or (d.get("externalId") is not None and str(d.get("externalId")) in keys):
                continue
            out.append({"action": "remove", "path": path})
        cursor = cast(str | None, page.raw.get("nextCursor"))
        if not cursor:
            return out


# --------------------------------------------------------------------------- the two clients' cores


@dataclass(slots=True)
class AsyncHelperCore:
    """The helper's view of the async client's core."""

    core: AsyncClientCore

    async def request[M: CaitlynModel](self, spec: OperationSpec, params: Mapping[str, object], result: type[M]) -> M:
        return await self.core.request(spec, params, result)

    async def prepare_file(self, file: FileInput) -> PreparedFile:
        return await self.core.prepare_file(file)

    async def describe_file(self, file: FileInput) -> dict[str, object]:
        return await self.core.describe_file(file)

    async def stage_file(self, file: FileInput, sha256: str) -> PreparedFile:
        return await UploadFile.of(file).stage_async(sha256)

    def cancel_uploads(self) -> None:
        return None  # cancelling the upload tasks closes their connections

    async def uploads_done(self) -> None:
        return None

    async def post_form(self, url: str, fields: Sequence[tuple[str, str]], file: PreparedFile) -> httpx.Response:
        return await self.core.post_form(url, fields, file)

    @property
    def max_attempts(self) -> int:
        return self.core.config.retry.max_attempts

    def take_retry(self) -> bool:
        return self.core.retry_budget.acquire(RETRY_COST)

    async def watch(self, watched: Watched) -> AsyncIterator[CaitlynEvent]:
        stream = AsyncFollow[None](self.core, watched, {}).watch()
        try:
            async for event in stream:
                yield event
        finally:
            await stream.aclose()


@dataclass(slots=True)
class SyncHelperCore:
    """The helper's view of the synchronous client's core: each call runs in a worker thread."""

    core: SyncClientCore
    lock: threading.Lock = field(default_factory=threading.Lock)
    uploads_http: httpx.AsyncClient | None = None
    """The form uploads' HTTP client, on this helper's loop, when the client made its own HTTP client: an upload's
    task, cancelled (Ctrl-C), closes its connection at once, whether the form is being sent or the answer awaited."""
    cancelled: threading.Event = field(default_factory=threading.Event)
    """Set on cancellation: an upload sent through a caller's own HTTP client stops within its next 64 KiB."""

    async def request[M: CaitlynModel](self, spec: OperationSpec, params: Mapping[str, object], result: type[M]) -> M:
        return await asyncio.to_thread(self.core.request, spec, params, result)

    async def prepare_file(self, file: FileInput) -> PreparedFile:
        return await asyncio.to_thread(self.core.prepare_file, file)

    async def describe_file(self, file: FileInput) -> dict[str, object]:
        return await asyncio.to_thread(self.core.describe_file, file)

    async def stage_file(self, file: FileInput, sha256: str) -> PreparedFile:
        return await asyncio.to_thread(UploadFile.of(file).stage, sha256)

    async def post_form(self, url: str, fields: Sequence[tuple[str, str]], file: PreparedFile) -> httpx.Response:
        if self.core.owns_http:
            if self.uploads_http is None:
                self.uploads_http = httpx.AsyncClient(timeout=self.core.config.timeout)
            return await self.core.post_form_async(self.uploads_http, url, fields, file)
        # A caller's own httpx.Client, in a worker thread: the form goes in chunks, each after a look at `cancelled`.
        return await asyncio.to_thread(self.core.post_form, url, fields, file, self.cancelled)

    def cancel_uploads(self) -> None:
        self.cancelled.set()

    async def uploads_done(self) -> None:
        http, self.uploads_http = self.uploads_http, None
        if http is not None:
            await http.aclose()

    @property
    def max_attempts(self) -> int:
        return self.core.config.retry.max_attempts

    def take_retry(self) -> bool:
        return self.core.retry_budget.acquire(RETRY_COST)

    async def watch(self, watched: Watched) -> AsyncIterator[CaitlynEvent]:
        """The synchronous watch, read in a worker thread and handed to this loop event by event."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()
        stream = Follow[None](self.core, watched, {}).watch()

        def post(item: tuple[str, object]) -> None:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, item)
            except RuntimeError:
                pass  # the loop has finished with the watch (and closed it): nothing is waiting for this

        def read() -> None:
            try:
                events: Iterator[CaitlynEvent] = iter(stream)
                for event in events:
                    post(("event", event))
                post(("end", None))
            except BaseException as e:  # handed to the loop
                post(("error", e))

        worker = threading.Thread(target=read, name="caitlyn-sync-watch", daemon=True)
        worker.start()
        try:
            while True:
                kind, value = await queue.get()
                if kind == "event":
                    yield cast(CaitlynEvent, value)
                elif kind == "end":
                    return
                else:
                    raise cast(BaseException, value)
        finally:
            stream.close()


def run_sync[T](make: Callable[[], Awaitable[T]]) -> T:
    """Runs a helper for the synchronous client on an event loop of its own, in a worker thread (so it works whether
    or not the calling thread has a loop). KeyboardInterrupt cancels it: the uploads in flight are dropped, no new ones start, and it is raised again."""
    loop = asyncio.new_event_loop()
    result: list[T] = []
    error: list[BaseException] = []
    task_ref: list[asyncio.Task[T]] = []

    def run() -> None:
        async def main() -> T:
            task = asyncio.ensure_future(make())
            task_ref.append(task)
            return await task

        try:
            result.append(loop.run_until_complete(main()))
        except BaseException as e:  # handed to the calling thread
            error.append(e)
        finally:
            loop.close()
            finished.set()

    # An Event, not Thread.join: a KeyboardInterrupt that lands while join() is waiting can leave it returning early.
    finished = threading.Event()
    worker = threading.Thread(target=run, name="caitlyn-sync", daemon=True)
    worker.start()
    try:
        while not finished.wait(0.1):
            pass
    except KeyboardInterrupt as interrupt:
        if task_ref:
            loop.call_soon_threadsafe(task_ref[0].cancel)
        finished.wait()
        report = cast(SyncReport[Any, Any] | None, getattr(error[0], "report", None)) if error else None
        raise SyncInterrupted(*interrupt.args, report=report) from (error[0] if error else interrupt)
    if error:
        if isinstance(error[0], asyncio.CancelledError):
            # The synchronous client's cancellation is KeyboardInterrupt (Ctrl-C).
            raise SyncInterrupted(str(error[0]) or "sync was cancelled", report=cast(SyncReport[Any, Any] | None, getattr(error[0], "report", None))) from error[0]
        raise error[0]
    return result[0]
