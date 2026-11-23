"""Python conformance harness: the protocol cases in conformance/cases/protocol.json and the example cases in
conformance/cases/examples.json, against the mock server. Each test's id starts with the case id in square
brackets (pytest's `ids`); scripts/check-conformance.mjs checks that every case ran and passed."""

from __future__ import annotations

import asyncio
import base64
import ctypes
import dataclasses
import hashlib
import inspect
import io
import json
import keyword
import os
import re
import socket
import tempfile
import threading
import time
import urllib.parse
import uuid
from types import SimpleNamespace
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, TypeVar, cast

import caitlyn
import caitlyn_core
import httpx
import pytest
from caitlyn import (
    AsyncCaitlyn,
    CallContext,
    Caitlyn,
    Interceptor,
    SyncCancelledError,
    SyncFile,
    SyncInterrupted,
    IngestionItemInput,
    IngestionPolicy,
    IngestionProgress,
    UploadFile,
    UploadId,
    WaitTimeoutError,
    CaitlynConnectionError,
    CaitlynError,
    ConflictError,
    NotFoundError,
    NotSupportedByServer,
    PreconditionFailedError,
    ServiceUnavailableError,
    UnauthenticatedError,
    ValidationError,
)
from caitlyn import _operations as operations  # pyright: ignore[reportPrivateUsage]
from caitlyn.auth import Auth, AwsCredentials, AwsIam, CaitlynAuthError, ClientCredentials, OAuth, OAuthTokens, Session, Token, WorkloadIdentity
from caitlyn.events import TextDeltaEvent
from caitlyn.models import AgentGuidance, AgentVersion, DocumentProcessing, Job
from caitlyn_core import _client as core_client  # pyright: ignore[reportPrivateUsage]
from caitlyn_core import _deadline as core_deadline  # pyright: ignore[reportPrivateUsage]
from caitlyn_core import _files as core_files  # pyright: ignore[reportPrivateUsage]
from caitlyn_core import _sync as core_sync  # pyright: ignore[reportPrivateUsage]
from caitlyn_core import workspace_endpoint
from conftest import ROOT, Mock
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

SDK_VERSION: str = (ROOT / "VERSION").read_text().strip()
"""The version in VERSION, which every SDK sends in its user agent."""
SDK_MODEL: str = json.loads((ROOT / "model" / "model.lock.json").read_text())["stampNext"]
EXAMPLES: list[dict[str, Any]] = json.loads((ROOT / "conformance" / "cases" / "examples.json").read_text())["cases"]
T = TypeVar("T")


def client(mock: Mock, **kw: Any) -> AsyncCaitlyn:
    return AsyncCaitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base, **kw)


async def collect(it: AsyncIterable[T]) -> list[T]:
    return [x async for x in it]


async def expect_error(aw: Awaitable[Any]) -> CaitlynError:
    with pytest.raises(CaitlynError) as info:
        await aw
    return info.value


async def answer(c: AsyncCaitlyn, conversation_id: str, message: str) -> Any:
    """Sends a message and reads its answer to the end: the final event's member."""
    stream = await c.conversations(conversation_id).send(message)
    return await stream.final_message()


def case(case_id: str) -> Callable[[Callable[..., Any]], Any]:
    """Names the test after its protocol case: pytest shows it as test_x[<case id>]."""
    return pytest.mark.parametrize("case_id", [case_id], ids=[f"[{case_id}]"])


# ------------------------------------------------------------------ retries


@case("retry.429-retry-after")
async def test_retry_429(mock: Mock, case_id: str) -> None:
    mock.faults(status={"ListDocuments": [{"status": 429, "retryAfter": 2}]})
    t0 = time.monotonic()
    docs = await collect(client(mock).knowledge_bases("KB4T7YQ2WL").documents.list(limit=100))
    assert len(docs) == 7
    assert time.monotonic() - t0 >= 2
    assert len(mock.api()) == 2


@case("retry.503-retry-after")
async def test_retry_503(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 1}]})
    t0 = time.monotonic()
    v = await client(mock).agents("GHT7YRWXPL").draft.get()
    assert time.monotonic() - t0 >= 1
    assert v.name == "draft"


@case("retry.long-retry-after")
async def test_retry_long(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 429, "retryAfter": 7}]})
    t0 = time.monotonic()
    await client(mock).agents("GHT7YRWXPL").draft.get()
    assert time.monotonic() - t0 >= 7


def fault503(n: int) -> list[dict[str, int]]:
    return [{"status": 503, "retryAfter": 0}] * n


@case("retry.budget-drains")
async def test_retry_budget_drains(mock: Mock, case_id: str) -> None:
    c = client(mock, retry_budget=10)
    mock.faults(status={"GetAgentVersion": fault503(4)})
    first = await expect_error(c.agents("GHT7YRWXPL").draft.get())
    assert isinstance(first, ServiceUnavailableError) and len(mock.api()) == 3  # two retries, 5 tokens each
    t0 = time.monotonic()
    second = await expect_error(c.agents("GHT7YRWXPL").draft.get())
    assert isinstance(second, ServiceUnavailableError) and len(mock.api()) == 4  # spent: no retry
    assert time.monotonic() - t0 < 1
    # A retry after no response costs 10: a budget of 9 pays for a 503's retry but not this one.
    mock.reset()
    mock.faults(status={"GetAgentVersion": [{"close": True}]})
    closed = await expect_error(client(mock, retry_budget=9).agents("GHT7YRWXPL").draft.get())
    assert isinstance(closed, CaitlynConnectionError) and len(mock.api()) == 1


@case("retry.budget-refund")
async def test_retry_budget_refund(mock: Mock, case_id: str) -> None:
    c = client(mock, retry_budget=5)
    mock.faults(status={"GetAgentVersion": fault503(1)})
    await c.agents("GHT7YRWXPL").draft.get()  # retried once, then refunded
    mock.faults(status={"GetAgentVersion": fault503(1)})
    v = await c.agents("GHT7YRWXPL").draft.get()
    assert v.name == "draft" and len(mock.api()) == 4


@case("retry.budget-first-attempt")
async def test_retry_budget_first_attempt(mock: Mock, case_id: str) -> None:
    c = client(mock, retry_budget=0)
    assert (await c.agents("GHT7YRWXPL").draft.get()).name == "draft"
    mock.faults(status={"GetAgentVersion": fault503(1)})
    err = await expect_error(c.agents("GHT7YRWXPL").draft.get())
    assert isinstance(err, ServiceUnavailableError) and len(mock.api()) == 2


@case("retry.idempotency-key-kept")
async def test_idempotency_key_kept(mock: Mock, tmp_path: Path, case_id: str) -> None:
    mock.faults(status={"CreateUpload": [{"status": 503, "retryAfter": 0}, {"status": 429, "retryAfter": 0}]})
    f = tmp_path / "hello.txt"
    f.write_text("hello")
    await client(mock).core.uploads.send(f)
    keys = [r["headers"].get("idempotency-key") for r in mock.api() if r.get("path") == "/v3/uploads"]
    assert len(keys) == 3
    assert re.fullmatch(r"[0-9a-f-]{36}", keys[0] or "")
    assert len(set(keys)) == 1


@case("retry.unsafe-not-retried")
async def test_unsafe_not_retried(mock: Mock, case_id: str) -> None:
    mock.faults(status={"SendMessage": [{"status": 503, "retryAfter": 0}]})
    err = await expect_error(answer(client(mock), "c-9", "hi"))
    assert isinstance(err, ServiceUnavailableError)
    assert len(mock.api()) == 1


@case("retry.above-max-retry-delay")
async def test_above_max_retry_delay(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 429, "retryAfter": 120}]})
    t0 = time.monotonic()
    err = await expect_error(client(mock).agents("GHT7YRWXPL").draft.get())
    assert (err.status, err.retry_after_seconds) == (429, 120)
    assert time.monotonic() - t0 < 1
    assert len(mock.api()) == 1


# ------------------------------------------------------------------ pagination


@case("requests.range")
async def test_requests_range(mock: Mock, case_id: str) -> None:
    c = client(mock)
    listed = await expect_error(c.knowledge_bases("KB4T7YQ2WL").documents.list(limit=500).page())
    assert (type(listed), listed.status, listed.code) == (ValidationError, 0, "VALIDATION_FAILED")
    assert [(e.parameter, e.pointer, e.code) for e in listed.errors] == [("limit", None, "VALIDATION_FAILED")]
    reserved = await expect_error(
        c.core.uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x", expires_in_seconds=30)
    )
    assert (reserved.status, reserved.code) == (0, "VALIDATION_FAILED")
    assert [(e.parameter, e.pointer) for e in reserved.errors] == [(None, "/expiresInSeconds")]
    assert len(mock.api()) == 0, "nothing is sent"
    await c.knowledge_bases("KB4T7YQ2WL").documents.list(limit=100).page()
    assert len(mock.api()) == 1, "a value inside its range is sent"


@case("pagination.to-last-page")
async def test_pagination(mock: Mock, case_id: str) -> None:
    docs = await collect(client(mock).knowledge_bases("KB4T7YQ2WL").documents.list(limit=3))
    assert len(docs) == 7
    reqs = mock.api()
    assert len(reqs) == 3
    assert "cursor=" not in reqs[0]["query"]
    assert "cursor=" in reqs[2]["query"]


@case("pagination.page")
async def test_pagination_page(mock: Mock, case_id: str) -> None:
    docs = client(mock).knowledge_bases("KB4T7YQ2WL").documents
    first = await docs.list(limit=3).page()
    assert len(first.items) == 3 and first.next_cursor
    assert len(mock.api()) == 1, "page() asks for one page only"
    second = await docs.list(limit=3, cursor=first.next_cursor).page()
    assert len(second.items) == 3 and second.next_cursor
    assert not {d.id for d in second.items} & {d.id for d in first.items}, "the second page follows the first"
    reqs = mock.api()
    assert len(reqs) == 2
    assert "cursor=" not in reqs[0]["query"]
    assert urllib.parse.parse_qs(reqs[1]["query"].lstrip("?"))["cursor"] == [first.next_cursor]


@case("pagination.next-page")
async def test_pagination_next_page(mock: Mock, case_id: str) -> None:
    first = await client(mock).knowledge_bases("KB4T7YQ2WL").documents.list(limit=3).page()
    assert first.has_next_page
    second = await first.next_page_async()
    assert second is not None and second.has_next_page and len(second.items) == 3
    third = await second.next_page_async()
    assert third is not None and len(third.items) == 1 and not third.has_next_page
    assert await third.next_page_async() is None
    reqs = mock.api()
    assert len(reqs) == 3, "one request a page, and none after the last"
    assert urllib.parse.parse_qs(reqs[1]["query"].lstrip("?"))["cursor"] == [first.next_cursor]
    assert all(urllib.parse.parse_qs(r["query"].lstrip("?"))["limit"] == ["3"] for r in reqs)
    assert "next_page" not in first.model_dump()


@case("pagination.pages-from-cursor")
async def test_pagination_pages_from_cursor(mock: Mock, case_id: str) -> None:
    docs = client(mock).knowledge_bases("KB4T7YQ2WL").documents
    first = await docs.list(limit=3).page()
    pages = await collect(docs.list(limit=3, cursor=first.next_cursor).pages())
    assert [len(p.items) for p in pages] == [3, 1]
    assert pages[0].next_cursor and pages[1].next_cursor is None
    reqs = mock.api()
    assert len(reqs) == 3
    assert "cursor=" in reqs[1]["query"] and "cursor=" in reqs[2]["query"]


# ------------------------------------------------------------------ SSE


@case("sse.resumed-answer-reset")
async def test_sse_resumed_answer_reset(mock: Mock, case_id: str) -> None:
    # The mock cuts the stream only once the SDK has yielded the two events before the cut, so it always has an
    # event ID to resume from.
    mock.faults(dropAfterEvents=2, dropOnSignal=True, finishWhileAway=True)
    async with await client(mock).conversations("c-away").send("hi") as stream:
        events: list[Any] = []
        async for event in stream:
            events.append(event)
            if len(events) == 2:
                mock._post("/__mock/drop")  # pyright: ignore[reportPrivateUsage]
        assert [e.type for e in events][-1] == "stream.reset" and len(events) == 3  # two events, then the reset
        err = await expect_error(stream.final_message())
    assert err.code == "NO_FINAL_EVENT"
    assert len([r for r in mock.api() if r["method"] == "GET"]) == 1  # one reconnect, and none after the reset


@case("send.break-then-final")
async def test_send_break_then_final(mock: Mock, case_id: str) -> None:
    # Spaced events, so the answer is still arriving when the caller breaks out.
    mock.faults(streamDelayMs=40)
    c = client(mock)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    answer = "Staff receive 20 days of annual leave."

    def requests_for(conversation_id: str) -> list[dict[str, Any]]:
        return [r for r in mock.api() if f"/conversations/{conversation_id}" in str(r["path"])]

    def gone(conversation_id: str) -> bool:
        return any(r.get("event") == "client-disconnected" and r.get("conversationId") == conversation_id for r in mock.requests())

    # Breaking out of the events, or the text, leaves the connection open: final_message() drains that same
    # connection and returns the completed message.
    async def async_final(conversation_id: str, by_text: bool) -> str:
        async with await c.conversations(conversation_id).send("hi") as stream:
            if by_text:
                async for _ in stream.text():
                    break
            else:
                async for _ in stream:
                    break
            return (await stream.final_message()).text

    def sync_final(conversation_id: str, by_text: bool) -> str:
        with sync.conversations(conversation_id).send("hi") as stream:
            for _ in stream.text() if by_text else stream:
                break
            return stream.final_message().text

    for conversation_id, run, by_text in (("c-bf1", "async", False), ("c-bf2", "async", True), ("c-bf3", "sync", False), ("c-bf4", "sync", True)):
        text = await async_final(conversation_id, by_text) if run == "async" else await asyncio.to_thread(sync_final, conversation_id, by_text)
        assert text == answer, (run, by_text)
        assert len(requests_for(conversation_id)) == 1, f"{run}: final_message() reads the same connection, with no request after it"
        assert not gone(conversation_id), f"{run}: the break did not close the connection"

    # A stream left after a break closes on leaving its context, or on close(): the server, holding the stream open
    # after the one event read (holdAfterEvents), sees the client disconnect, and no request follows.
    mock.faults(streamDelayMs=0, holdAfterEvents=1)

    def held(conversation_id: str) -> bool:
        return any(r.get("event") == "server-holding-stream" and r.get("conversationId") == conversation_id for r in mock.requests())
    async def async_leave(conversation_id: str, by_close: bool) -> None:
        async with await c.conversations(conversation_id).send("hi") as stream:
            async for _ in stream:
                break
            if by_close:
                await stream.aclose()

    def sync_leave(conversation_id: str, by_close: bool) -> None:
        with sync.conversations(conversation_id).send("hi") as stream:
            for _ in stream:
                break
            if by_close:
                stream.close()

    for conversation_id, run, by_close in (("c-bl1", "async", False), ("c-bl2", "async", True), ("c-bl3", "sync", False), ("c-bl4", "sync", True)):
        if run == "async":
            await async_leave(conversation_id, by_close)
        else:
            await asyncio.to_thread(sync_leave, conversation_id, by_close)
        deadline = time.monotonic() + 5
        while not gone(conversation_id):
            assert time.monotonic() < deadline, f"{run} {'close()' if by_close else 'context'}: no disconnect"
            await asyncio.sleep(0.02)
        assert held(conversation_id), f"{run}: the server was still holding the stream when the client left"
        assert len(requests_for(conversation_id)) == 1, f"{run}: no request after it"


@case("sse.watch-reconnects")
async def test_sse_watch_reconnects(mock: Mock, case_id: str) -> None:
    c = client(mock)
    async with await c.conversations("c-w").send("hi") as stream:
        await collect(stream)
    mock.faults(watchCloses=7)
    events: list[Any] = []
    async with c.conversations("c-w").watch() as watch:
        async for event in watch:
            events.append(event)
            if event.type == "message.completed":
                break
    assert [e.type for e in events] == [
        "message.started", "progress.updated", "tool.started", "tool.finished", "text.delta", "citation.added", "text.delta", "message.completed",
    ]
    gets = [r for r in mock.api() if r["method"] == "GET" and r["path"] == "/v3/conversations/c-w/stream"]
    assert len(gets) == 8  # seven reconnects, more than three, because each carried an event
    assert [g["headers"].get("last-event-id") for g in gets[1:]] == [e.event_id for e in events[:-1]]


@case("sse.watch-resends-request")
async def test_sse_watch_resends_request(mock: Mock, case_id: str) -> None:
    mock.faults(watchCloses=1)
    events: list[Any] = []
    async with client(mock).events.watch(types=["conversation.created"], conversation_ids=["c-11", "c-12"]) as stream:
        async for event in stream:
            events.append(event)
            if len(events) == 2:
                break
    first, second = [r for r in mock.api() if r["path"] == "/v3/events/stream"]
    assert second["query"] == first["query"]
    assert "type=conversation.created" in second["query"] and "conversationId=c-11" in second["query"]
    assert second["headers"].get("last-event-id") == events[0].event_id


@case("sse.conversation-reset")
async def test_sse_conversation_reset(mock: Mock, case_id: str) -> None:
    c = client(mock)
    async with await c.conversations("c-r").send("hi") as stream:
        answer = await collect(stream)
    events: list[Any] = []
    async with c.conversations("c-r").watch(last_event_id=answer[-1].event_id) as watch:
        async for event in watch:
            events.append(event)
            if event.type == "message.completed":
                break
    reset = events[0]
    assert isinstance(reset, caitlyn.StreamResetEvent) and reset.cursor == reset.event_id
    assert events[-1].type == "message.completed"  # the next answer follows the reset
    assert len([r for r in mock.api() if r["method"] == "GET"]) == 1  # a reset is not an error and is never retried


ID_11 = "0193a6f3-0a1b-7c2d-8e3f-000000000011"


@case("sse.reconnect-backoff")
async def test_sse_reconnect_backoff(mock: Mock, case_id: str) -> None:
    c = client(mock)
    async with await c.conversations("c-b").send("hi") as stream:
        await collect(stream)
    mock.faults(watchEmptyCloses=4)
    async with c.conversations("c-b").watch() as watch:
        err = await expect_error(collect(watch))
    assert err.code == "STREAM_LOST"
    at = [r["at"] for r in mock.api() if r["method"] == "GET"]
    assert len(at) == 4  # the first request and three reconnects
    g1, g2, g3 = at[1] - at[0], at[2] - at[1], at[3] - at[2]
    # The bands (0.25-0.5 s, 0.5-1 s, 1-2 s) do not overlap, so their lower bounds show the pause grows; the upper
    # bounds, three times each band's top, catch a broken cap.
    assert g1 >= 200 and g2 >= 450 and g3 >= 950, (g1, g2, g3)
    assert g1 <= 1500 and g2 <= 3000 and g3 <= 6000, (g1, g2, g3)


@case("sse.reconnect-without-event-id")
async def test_sse_reconnect_without_event_id(mock: Mock, case_id: str) -> None:
    mock.faults(watchEmptyCloses=1)
    async with client(mock).events.watch(types=["conversation.created"], after=ID_11) as stream:
        async for _ in stream:
            break
    first, second = [r for r in mock.api() if r["path"] == "/v3/events/stream"][:2]
    assert "last-event-id" not in second["headers"]
    assert second["query"] == first["query"]  # the same request, after cursor included


@case("sse.reconnect-drops-after")
async def test_sse_reconnect_drops_after(mock: Mock, case_id: str) -> None:
    mock.faults(watchCloses=1)
    events: list[Any] = []
    async with client(mock).events.watch(types=["conversation.created"], after=ID_11) as stream:
        async for event in stream:
            events.append(event)
            if len(events) == 2:
                break
    first, second = [r for r in mock.api() if r["path"] == "/v3/events/stream"][:2]
    assert "after=" in first["query"]
    assert second["headers"].get("last-event-id") == events[0].event_id
    assert "after=" not in second["query"] and "type=conversation.created" in second["query"]


@contextmanager
def connections_lasting(step: float) -> Iterator[None]:
    """The stream clock steps `step` seconds at each reading, so every connection lasts exactly that long (a stream reads
    the clock when a response arrives and when its connection ends); the real clock is put back afterwards."""
    real = core_client.stream_clock
    now = [0.0]

    def stepping() -> float:
        now[0] += step
        return now[0]

    core_client.stream_clock = stepping
    try:
        yield
    finally:
        core_client.stream_clock = real


@case("sse.long-connection-resets-count")
async def test_sse_long_connection_resets_count(mock: Mock, case_id: str) -> None:
    c = client(mock)
    async with await c.conversations("c-l").send("hi") as stream:
        await collect(stream)
    # Five quiet responses in a row (the first and four reconnects), each open just over a minute: one more than the
    # limit, so the watch carries on only because each long connection restarts the count. The sixth carries events.
    mock.faults(watchEmptyCloses=5)
    first: Any = None
    with connections_lasting(core_client.LONG_CONNECTION_SECONDS + 1):
        async with c.conversations("c-l").watch() as watch:
            async for event in watch:
                first = event
                break
    assert first is not None and first.type == "message.started"  # the watch reached the events, with no STREAM_LOST
    assert len([r for r in mock.api() if r["method"] == "GET"]) == 6  # the first request and five reconnects


@case("sse.short-connections-stream-lost")
async def test_sse_short_connections_stream_lost(mock: Mock, case_id: str) -> None:
    c = client(mock)
    async with await c.conversations("c-s").send("hi") as stream:
        await collect(stream)
    mock.faults(watchEmptyCloses=4)
    with connections_lasting(core_client.LONG_CONNECTION_SECONDS - 1):
        async with c.conversations("c-s").watch() as watch:
            err = await expect_error(collect(watch))
    assert err.code == "STREAM_LOST"
    assert len([r for r in mock.api() if r["method"] == "GET"]) == 4  # the first request and three reconnects


@case("sse.duplicate-not-progress")
async def test_sse_duplicate_not_progress(mock: Mock, case_id: str) -> None:
    c = client(mock)
    async with await c.conversations("c-d").send("hi") as stream:
        await collect(stream)
    mock.faults(watchReplayCloses=10)
    seen: list[str] = []

    async def read(watch: Any) -> None:
        async for event in watch:
            seen.append(event.type)

    async with c.conversations("c-d").watch() as watch:
        err = await expect_error(read(watch))
    assert err.code == "STREAM_LOST"
    assert seen == ["message.started"]  # the duplicates were dropped
    assert len([r for r in mock.api() if r["method"] == "GET"]) == 4  # the first request and three reconnects


@case("sse.watch-failed-answer")
async def test_sse_watch_failed_answer(mock: Mock, case_id: str) -> None:
    c = client(mock)
    mock.faults(failStream=True)
    async with await c.conversations("c-f").send("hi") as stream:
        await expect_error(collect(stream))
    types: list[str] = []
    failed: Any = None
    async with c.conversations("c-f").watch() as watch:
        async for event in watch:
            types.append(event.type)
            if event.type == "message.failed":
                failed = event
            if event.type == "message.completed":
                break
    assert failed is not None and failed.code == "SERVICE_UNAVAILABLE"
    assert types.index("message.failed") < types.index("message.completed")  # the next answer follows the failed one


@case("sse.request-id-and-type")
async def test_sse_request_id_and_type(mock: Mock, case_id: str) -> None:
    async with await client(mock).conversations("c-ids").send("hi") as stream:
        events = await collect(stream)
        assert stream.request_id == mock.api()[-1]["requestId"]
    assert (events[0].type, events[-1].type) == ("message.started", "message.completed")


@case("sse.typed-events")
async def test_sse_typed_events(mock: Mock, case_id: str) -> None:
    text = ""
    types: list[str] = []
    async with await client(mock).conversations("c-1").send("How many days?") as stream:
        async for event in stream:
            types.append(event.type)
            match event.type:
                case "text.delta":
                    text += event.delta
                case "citation.added":
                    assert event.citation.document_name == "leave-policy.pdf"
                case _:
                    pass
        answer = await stream.final_message()
    assert text == "Staff receive 20 days of annual leave."
    assert types == ["message.started", "progress.updated", "tool.started", "tool.finished", "text.delta", "citation.added", "text.delta", "message.completed"]
    assert answer.citations is not None and answer.citations[0].page_number == 3
    send = next(r for r in mock.api() if r["method"] == "POST")
    assert send["headers"]["accept"] == "text/event-stream"


@case("sse.resume")
async def test_sse_resume(mock: Mock, case_id: str) -> None:
    mock.faults(dropAfterEvents=3)
    async with await client(mock).conversations("c-2").send("hi") as stream:
        events = await collect(stream)
    ids = [e.event_id for e in events]
    assert len(set(ids)) == len(ids)
    assert events[-1].type == "message.completed"
    resume = next(r for r in mock.api() if r["method"] == "GET" and r["path"] == "/v3/conversations/c-2/stream")
    assert resume["headers"].get("last-event-id") == ids[2]
    assert resume["headers"].get("accept") == "text/event-stream"


STALE_CURSOR = "0190d2a1-0000-7000-8000-000000000001"
"""The mock's cursor the workspace stream cannot carry on from."""
RESET_CURSOR = "0193a6f3-0a1b-7c2d-8e3f-000000000010"
"""The cursor its stream.reset gives instead."""


@case("sse.final-ends-watch")
async def test_sse_final_ends_watch(mock: Mock, case_id: str) -> None:
    mock.faults(dropAfterEvents=2)
    t0 = time.monotonic()
    async with await client(mock).conversations("c-watch").send("hi") as stream:
        answer = await stream.final_message()
    assert answer.text == "Staff receive 20 days of annual leave."
    assert time.monotonic() - t0 < 5, "ended at message.completed, not when the server closed the watch"
    for _ in range(100):
        if any(r.get("event") == "client-disconnected" for r in mock.requests()):
            break
        await asyncio.sleep(0.02)
    else:
        raise AssertionError("the SDK did not close the watch connection")


@case("sse.stream-reset")
async def test_sse_stream_reset(mock: Mock, case_id: str) -> None:
    events: list[Any] = []
    async with client(mock).events.watch(types=["conversation.created"], after=STALE_CURSOR) as stream:
        async for event in stream:
            events.append(event)
            if len(events) == 2:
                break  # a watch carries on until it is closed
    assert [e.type for e in events] == ["stream.reset", "conversation.created"]
    reset, created = events
    assert isinstance(reset, caitlyn.StreamResetEvent)
    assert (reset.cursor, reset.event_id) == (RESET_CURSOR, RESET_CURSOR)
    assert isinstance(created, caitlyn.WorkspaceConversationCreatedEvent)
    assert created.data.agent_id == "GHT7YRWXPL"
    assert len(mock.api()) == 1  # a reset is not an error and is never retried


@case("sse.clean-end-resumes")
async def test_sse_clean_end(mock: Mock, case_id: str) -> None:
    mock.faults(endAfterEvents=2)
    async with await client(mock).conversations("c-5").send("hi") as stream:
        events = await collect(stream)
    assert events[-1].type == "message.completed"
    resume = next(r for r in mock.api() if r["path"] == "/v3/conversations/c-5/stream")
    assert resume["headers"].get("last-event-id") == events[1].event_id


@case("sse.message-failed")
async def test_sse_message_failed(mock: Mock, case_id: str) -> None:
    mock.faults(failStream=True)
    seen: list[str] = []

    async def consume() -> None:
        async with await client(mock).conversations("c-6").send("hi") as stream:
            async for e in stream:
                seen.append(e.type)

    err = await expect_error(consume())
    assert isinstance(err, ServiceUnavailableError), type(err)
    assert (err.status, err.code, err.request_id) == (503, "SERVICE_UNAVAILABLE", "01JC9Q2W7R4M0H2T6N1S8V3B80")
    assert "message.failed" not in seen
    assert not [r for r in mock.api() if r["path"].endswith("/stream")], "a failure is not resumed"


# ------------------------------------------------------------------ tolerance


@case("tolerance.unknown-event")
async def test_unknown_event(mock: Mock, case_id: str) -> None:
    mock.faults(unknownEvent=True)
    async with await client(mock).conversations("c-3").send("hi") as stream:
        events = await collect(stream)
    assert all(e.type != "memory.saved" for e in events)
    assert events[-1].type == "message.completed"


@case("tolerance.unknown-enum")
async def test_unknown_enum(mock: Mock, case_id: str) -> None:
    mock.faults(unknownEnum=True)
    docs = await collect(client(mock).knowledge_bases("KB4T7YQ2WL").documents.list())
    assert docs[1].status == "archived"
    v = await client(mock).agents("GHT7YRWXPL").draft.get()
    assert v.source == "cloned_from_template"


@case("tolerance.unknown-error-code")
async def test_unknown_error_code(mock: Mock, case_id: str) -> None:
    body = json.dumps({"type": "https://build.caitlyn.ai/errors/SOMETHING_NEW", "title": "Something new", "status": 409, "code": "SOMETHING_NEW", "requestId": "r-1"})
    mock.faults(status={"GetAgentVersion": [{"status": 409, "contentType": "application/problem+json", "body": body}]})
    http = await expect_error(client(mock).agents("GHT7YRWXPL").draft.get())
    assert isinstance(http, ConflictError)
    assert (http.status, http.code) == (409, "SOMETHING_NEW")
    mock.reset()
    mock.faults(busyDocuments={"doc-0002": True}, jobOutcomes={"doc-0002": "failed"}, jobError={"code": "SOMETHING_NEW", "detail": "A failure this SDK does not know."})
    job = await expect_error(client(mock).knowledge_bases("KB4T7YQ2WL").documents("doc-0002").wait(timeout=10))
    assert type(job) is CaitlynError
    assert (job.status, job.code) == (0, "SOMETHING_NEW")


@case("tolerance.unknown-field-raw")
async def test_unknown_field_raw(mock: Mock, case_id: str) -> None:
    mock.faults(unknownField=True)
    c = client(mock)
    v = await c.agents("GHT7YRWXPL").draft.get()
    assert v.raw["reviewState"] == {"required": False}
    assert v.raw["configuration"]["guidance"]["instructions"] == "Answer from the HR policies."
    assert v.raw["etag"] == v.etag  # raw is the body as received; a single read's body carries its etag
    async with await c.conversations("c-6").send("hi") as stream:
        answer = await stream.final_message()
    assert answer.raw["sentiment"] == "neutral"


@case("tolerance.nested-raw")
async def test_nested_raw(mock: Mock, case_id: str) -> None:
    mock.faults(unknownField=True)
    c = client(mock)
    docs = await collect(c.knowledge_bases("KB4T7YQ2WL").documents.list())
    assert docs[0].raw["retentionPolicy"] == {"keepDays": 365}
    v = await c.agents("GHT7YRWXPL").draft.get()
    assert v.configuration is not None and v.configuration.knowledge_bases is not None
    assert v.configuration.knowledge_bases[0].raw["reranker"] == "cohere"


# ------------------------------------------------------------------ typed errors


@case("errors.404")
async def test_404(mock: Mock, case_id: str) -> None:
    for aws_header in (False, True):
        mock.reset()
        mock.faults(awsErrorTypeHeader=aws_header)
        err = await expect_error(collect(client(mock).knowledge_bases("NOPE").documents.list()))
        last = mock.api()[-1]
        assert isinstance(err, NotFoundError)
        assert (err.status, err.code, err.request_id) == (404, "NOT_FOUND", last["requestId"])
        assert err.type == "https://build.caitlyn.ai/errors/NOT_FOUND"


@case("errors.409")
async def test_409(mock: Mock, case_id: str) -> None:
    c = client(mock)
    up = await c.core.uploads.reserve(file_name="a.pdf", content_type="application/pdf", byte_size=1, sha256="x")
    err = await expect_error(c.knowledge_bases("KB4T7YQ2WL").documents.create(upload_id=up.id, folder="/hr/"))
    assert isinstance(err, ConflictError)
    assert (err.status, err.code) == (409, "CONFLICT")
    assert err.code == caitlyn.ErrorCode.CONFLICT and caitlyn.ErrorCode(err.code).is_known


@case("errors.versions-not-numbered")
async def test_versions_not_numbered(mock: Mock, case_id: str) -> None:
    mock.faults(versionsNotNumbered={"doc-0001": True})
    doc = client(mock).knowledge_bases(KB).documents("doc-0001")
    err = await expect_error(doc.versions("1").delete())
    assert isinstance(err, ConflictError)
    assert (err.status, err.code) == (409, caitlyn.ErrorCode.VERSIONS_NOT_NUMBERED)
    assert len([r for r in mock.api() if r["method"] == "DELETE"]) == 1, "not retried"
    assert (await doc.get()).version_count == 1, "nothing deleted"


@case("errors.412")
async def test_412(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.agents("GHT7YRWXPL").draft.get()
    await c.agents("GHT7YRWXPL").draft.update(if_match=draft.etag, guidance=AgentGuidance(instructions="first"))
    err = await expect_error(c.agents("GHT7YRWXPL").draft.update(if_match=draft.etag, guidance=AgentGuidance(instructions="second")))
    assert isinstance(err, PreconditionFailedError)
    assert (err.status, err.code) == (412, "PRECONDITION_FAILED")
    assert err.request_id


@case("errors.decode-failed")
async def test_decode_failed(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetDocument": [{"status": 200, "body": "this is not JSON", "contentType": "application/json"}]})
    err = await expect_error(client(mock).knowledge_bases(KB).documents("doc-0001").get())
    assert (type(err), err.status, err.code) == (CaitlynError, 0, "DECODE_FAILED")
    assert isinstance(err.__cause__, ValueError), repr(err.__cause__)


@case("errors.job-failed-no-code")
async def test_job_failed_no_code(mock: Mock, case_id: str) -> None:
    # The model requires OperationError.code, and this SDK's models hold to it: a job error with no code at all is not
    # the model's shape, so the watch's event is DECODE_FAILED. One whose code is empty is the failure with no code.
    mock.faults(busyDocuments={"doc-0002": True}, jobOutcomes={"doc-0002": "failed"}, jobError={"code": "", "detail": "The job failed and said no more."})
    err = await expect_error(client(mock).knowledge_bases(KB).documents("doc-0002").wait(timeout=10))
    assert (type(err), err.status, err.code) == (CaitlynError, 0, "JOB_FAILED")
    mock.reset()
    mock.faults(busyDocuments={"doc-0002": True}, jobOutcomes={"doc-0002": "failed"}, jobError={"detail": "The job failed and said no more."})
    err = await expect_error(client(mock).knowledge_bases(KB).documents("doc-0002").wait(timeout=10))
    assert (err.status, err.code) == (0, "DECODE_FAILED")


@case("errors.file-unreadable")
async def test_file_unreadable(mock: Mock, tmp_path: Path, case_id: str) -> None:
    broken = OSError("the disk went away")

    async def failing() -> AsyncIterator[bytes]:
        yield b"%PDF-1.7 first part"
        raise broken

    c = client(mock)
    err = await expect_error(c.core.uploads.send(UploadFile.from_stream(failing(), name="scan.pdf")))
    assert (err.status, err.code, err.__cause__) == (0, "FILE_UNREADABLE", broken)
    missing = await expect_error(c.core.uploads.send(str(tmp_path / "no-such-file.pdf")))
    assert (missing.status, missing.code) == (0, "FILE_UNREADABLE")
    assert isinstance(missing.__cause__, FileNotFoundError), repr(missing.__cause__)
    assert mock.api() == [], "nothing was sent"


@case("errors.item-has-no-file")
async def test_item_has_no_file(mock: Mock, tmp_path: Path, case_id: str) -> None:
    mock.faults(strayItem="/hr/stray.pdf")
    root = folder_of(tmp_path, {"annual-leave.md": b"Staff receive 20 days of annual leave."})
    err = await expect_error(client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/"))
    assert (err.status, err.code) == (0, "INGESTION_ITEM_HAS_NO_FILE")
    assert "/hr/stray.pdf" in str(err)
    assert forms(mock) == [], "nothing was uploaded"


@case("errors.429-exhausted")
async def test_429_exhausted(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 429, "retryAfter": 0}] * 3})
    err = await expect_error(client(mock).agents("GHT7YRWXPL").draft.get())
    assert (err.status, err.code, err.retry_after_seconds) == (429, "RATE_LIMITED", 0)
    assert len(mock.api()) == 3


# An error page from something in front of the API, not a problem body (PROTOCOL.md 6.1).
HTML_404 = "<!DOCTYPE html><html><head><title>404: This page could not be found</title></head><body><h1>404</h1></body></html>"


@case("errors.html-404")
async def test_html_404(mock: Mock, case_id: str) -> None:
    mock.faults(status={"ListDocuments": [{"status": 404, "contentType": "text/html; charset=utf-8", "body": HTML_404}]})
    err = await expect_error(collect(client(mock).knowledge_bases("KB4T7YQ2WL").documents.list()))
    assert isinstance(err, NotFoundError)
    assert (err.status, err.code, err.request_id) == (404, "HTTP_404", None)
    assert err.raw_body == HTML_404


@case("errors.empty-405")
async def test_empty_405(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 405, "body": ""}]})
    err = await expect_error(client(mock).agents("GHT7YRWXPL").draft.get())
    assert type(err) is CaitlynError
    assert (err.status, err.code, err.request_id, err.raw_body) == (405, "HTTP_405", None, "")


@case("errors.text-502")
async def test_text_502(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 502, "contentType": "text/plain", "body": "Bad Gateway"}]})
    err = await expect_error(client(mock).agents("GHT7YRWXPL").draft.get())
    assert type(err) is CaitlynError
    assert (err.status, err.code, err.raw_body) == (502, "HTTP_502", "Bad Gateway")
    assert len(mock.api()) == 1


# A problem body whose status disagrees with the HTTP status (PROTOCOL.md 6.3).
MISMATCHED_409 = '{"type":"https://build.caitlyn.ai/errors/CONFLICT","title":"Conflict","status":400,"code":"CONFLICT","requestId":"01MISMATCHEDSTATUS0000000"}'


@case("errors.status-from-http")
async def test_status_from_http(mock: Mock, case_id: str) -> None:
    mock.faults(status={"CreateUpload": [{"status": 409, "contentType": "application/problem+json", "body": MISMATCHED_409}]})
    reserve = client(mock).core.uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x")
    err = await expect_error(reserve)
    assert isinstance(err, ConflictError)
    assert (err.status, err.code, err.request_id) == (409, "CONFLICT", "01MISMATCHEDSTATUS0000000")


@case("errors.field-errors")
async def test_field_errors(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.agents("GHT7YRWXPL").draft.get()
    err = await expect_error(c.agents("GHT7YRWXPL").draft.update(if_match=draft.etag, guidance=AgentGuidance(identity="x"), clear=["guidance.identity"]))
    assert isinstance(err, ValidationError)
    assert (err.status, err.code) == (400, "VALIDATION_FAILED")
    [field] = err.errors
    assert isinstance(field, caitlyn.FieldError)
    assert (field.pointer, field.code) == ("/guidance/identity", "VALIDATION_FAILED")
    patch = [r for r in mock.api() if r["method"] == "PATCH"][-1]
    assert json.loads(patch["body"]) == {"guidance": {"identity": "x"}, "clear": ["guidance.identity"]}


# errors.raw-body-limit: a 20 KiB HTML page (ASCII), and a page whose 8 KiB cut would fall inside a three-byte "€".
PAGE_20K = "<!DOCTYPE html>" + "x" * (20480 - 15)
PAGE_STRADDLE = "a" * 8191 + "€" * 10


@case("errors.unmodelled-status")
async def test_unmodelled_status(mock: Mock, case_id: str) -> None:
    mock.faults(status={"CreateUpload": [{"status": 404}, {"status": 405, "body": ""}]})
    c = client(mock)
    not_found = await expect_error(c.core.uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x"))
    assert type(not_found) is NotFoundError
    assert (not_found.status, not_found.code) == (404, "HTTP_404")
    other = await expect_error(c.core.uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x"))
    assert type(other) is CaitlynError
    assert (other.status, other.code) == (405, "HTTP_405")


@case("errors.raw-body-limit")
async def test_raw_body_limit(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 404, "contentType": "text/html", "body": b} for b in (PAGE_20K, PAGE_STRADDLE)]})
    c = client(mock)
    page = await expect_error(c.agents("GHT7YRWXPL").draft.get())
    assert isinstance(page, NotFoundError)
    assert len(page.raw_body.encode()) == 8192
    assert page.raw_body == PAGE_20K[:8192]
    assert page.raw_body_truncated is True
    straddle = await expect_error(c.agents("GHT7YRWXPL").draft.get())
    assert (straddle.raw_body, straddle.raw_body_truncated) == ("a" * 8191, True)
    problem = await expect_error(c.agents("GHT7YRWXPL").versions("nope").get())
    assert isinstance(problem, NotFoundError)
    assert json.loads(problem.raw_body)["code"] == "NOT_FOUND"
    assert problem.raw_body_truncated is False


def refused_endpoint() -> str:
    """An endpoint nothing listens on: a port the system handed out, then closed."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"


@case("errors.connection")
async def test_connection_error(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"close": True}]})
    closed = await expect_error(client(mock, max_attempts=1).agents("GHT7YRWXPL").draft.get())
    refused_client = AsyncCaitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=refused_endpoint(), max_attempts=1)
    refused = await expect_error(refused_client.agents("GHT7YRWXPL").draft.get())
    for err in (closed, refused):
        assert isinstance(err, CaitlynConnectionError), repr(err)
        assert (err.status, err.code, err.request_id, err.raw_body, err.raw_body_truncated) == (0, "CONNECTION_ERROR", None, "", False)
        assert isinstance(err.__cause__, httpx.TransportError), repr(err.__cause__)
        assert "GetAgentVersion" in str(err)
    assert isinstance(refused.__cause__, httpx.ConnectError)


# ------------------------------------------------------------------ cancellation


@case("cancel.stream")
async def test_cancel_stream(mock: Mock, case_id: str) -> None:
    mock.faults(streamDelayMs=150)
    seen: list[str] = []

    async def consume() -> None:
        async with await client(mock).conversations("c-4").send("hi") as stream:
            async for e in stream:
                seen.append(e.type)

    task = asyncio.create_task(consume())
    while len(seen) < 2:
        await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.3)
    assert any(r.get("event") == "client-disconnected" for r in mock.requests())


@case("cancel.unary")
async def test_cancel_unary(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 2}]})
    task = asyncio.create_task(client(mock).agents("GHT7YRWXPL").draft.get())
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ------------------------------------------------------------------ updates


@case("update.if-match")
async def test_if_match(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.agents("GHT7YRWXPL").draft.get()
    updated = await c.agents("GHT7YRWXPL").draft.update(if_match=draft.etag, guidance=AgentGuidance(instructions="x"))
    assert updated.etag != draft.etag
    patch = next(r for r in mock.api() if r["method"] == "PATCH")
    assert patch["headers"]["if-match"] == draft.etag
    assert json.loads(patch["body"]) == {"guidance": {"instructions": "x"}}


@case("update.clear")
async def test_clear(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.agents("GHT7YRWXPL").draft.get()
    updated = await c.agents("GHT7YRWXPL").draft.update(if_match=draft.etag, clear=["guidance.identity"])
    patch = next(r for r in mock.api() if r["method"] == "PATCH")
    assert json.loads(patch["body"]) == {"clear": ["guidance.identity"]}
    assert updated.configuration is not None
    guidance = updated.configuration.guidance
    assert guidance is not None and guidance.identity is None
    assert guidance.instructions == "Answer from the HR policies."


# ------------------------------------------------------------------ wire headers and environment


@case("wire.headers")
async def test_wire_headers(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}]})
    await client(mock).agents("GHT7YRWXPL").draft.get()
    sent = mock.api()
    assert len(sent) == 2
    for r in sent:
        aws = [h for h in r["headerNames"] if h.startswith(("x-amz", "amz-sdk", "x-amzn"))]
        assert aws == [], f"AWS headers sent: {aws}"
        assert re.fullmatch(rf"caitlyn-sdk-python/{re.escape(SDK_VERSION)} lang/python#3\.\d+ md/[a-z]+#3\.\d+\.\d+", r["headers"]["user-agent"])
        assert r["headers"]["caitlyn-sdk-model"] == SDK_MODEL
        assert "caitlyn-api-version" not in r["headers"]  # a response header only
        assert r["headers"]["authorization"] == "Bearer pat_test"
        assert "content-type" not in r["headers"]  # no body, no Content-Type
        assert "traceparent" not in r["headers"]  # no propagator configured, nothing sent


@case("environment.hostile-aws")
async def test_hostile_aws(mock: Mock, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case_id: str) -> None:
    hostile = "max_attempts = 1\nretry_mode = adaptive\ndefaults_mode = auto\nendpoint_url = http://127.0.0.1:9\nregion = xx-hostile-1\n"
    (tmp_path / "config").write_text(f"[profile hostile]\n{hostile}\n[default]\n{hostile}")
    for k, v in {
        "AWS_PROFILE": "hostile", "AWS_REGION": "xx-hostile-1", "AWS_MAX_ATTEMPTS": "1", "AWS_RETRY_MODE": "adaptive",
        "AWS_DEFAULTS_MODE": "auto", "AWS_ENDPOINT_URL": "http://127.0.0.1:9", "AWS_CONFIG_FILE": str(tmp_path / "config"),
        "AWS_SHARED_CREDENTIALS_FILE": str(tmp_path / "config"), "AWS_EC2_METADATA_SERVICE_ENDPOINT": "http://10.255.255.1",
    }.items():
        monkeypatch.setenv(k, v)
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}]})
    t0 = time.monotonic()
    v = await client(mock).agents("GHT7YRWXPL").draft.get()
    docs = await collect(client(mock).knowledge_bases("KB4T7YQ2WL").documents.list(limit=3))
    assert (v.name, len(docs)) == ("draft", 7)
    assert time.monotonic() - t0 < 2, "something waited on the environment"
    assert len([r for r in mock.api() if "/versions/" in r["path"]]) == 2, "AWS_MAX_ATTEMPTS=1 was not ignored"


# ------------------------------------------------------------------ versions, headers, telemetry, endpoint


@case("since.fails-before-sending")
async def test_since(mock: Mock, case_id: str) -> None:
    mock.faults(apiVersion="5.110.0")
    c = client(mock)
    await c.agents("GHT7YRWXPL").draft.get()  # no check before the first response
    before = len(mock.api())
    with pytest.raises(NotSupportedByServer) as info:
        await c.agents("GHT7YRWXPL").draft.get()
    assert (info.value.requires, info.value.server) == (SDK_MODEL, "5.110.0")
    assert len(mock.api()) == before


@case("since.unknown-operation")
async def test_since_unknown_operation(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [
        {"status": 404, "code": "UNKNOWN_OPERATION"}, {"status": 405, "code": "METHOD_NOT_ALLOWED"}, {"status": 404, "code": "NOT_FOUND"},
    ]})
    c = client(mock)
    for i, answer in enumerate(["404 UNKNOWN_OPERATION", "405 METHOD_NOT_ALLOWED"]):
        with pytest.raises(NotSupportedByServer) as info:
            await c.agents("GHT7YRWXPL").draft.get()
        assert (info.value.operation, info.value.requires, info.value.server) == ("GetAgentVersion", SDK_MODEL, "5.120.0"), answer
        assert len(mock.api()) == i + 1, f"{answer} is not retried"
    err = await expect_error(c.agents("GHT7YRWXPL").draft.get())
    assert (err.status, err.code) == (404, "NOT_FOUND")


@case("headers.request-id")
async def test_request_id(mock: Mock, case_id: str) -> None:
    v = await client(mock).agents("GHT7YRWXPL").draft.get()
    assert v.response_metadata is not None
    assert v.response_metadata.request_id == mock.api()[-1]["requestId"]
    assert v.response_metadata.api_version == "5.120.0"


@case("headers.response-metadata")
async def test_response_metadata(mock: Mock, case_id: str) -> None:
    v = await client(mock).agents("GHT7YRWXPL").draft.get()
    metadata = v.response_metadata
    assert metadata is not None
    assert metadata.http_status_code == 200
    assert metadata.request_id == mock.api()[-1]["requestId"]
    assert metadata.etag == v.etag == '"draft-1"'
    assert "response_metadata" not in v.to_wire()
    assert AgentVersion.model_validate(v.to_wire()).response_metadata is None  # built in code: no response


@case("telemetry.attributes")
async def test_telemetry_attributes(mock: Mock, tmp_path: Path, case_id: str) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    c = client(mock, tracer_provider=provider)
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}]})
    await expect_error(c.agents("GHT7YRWXPL").versions("nope").get())
    await collect(c.knowledge_bases("KB4T7YQ2WL").documents.list(limit=100))
    f = tmp_path / "hello.txt"
    f.write_text("hello")
    await c.core.uploads.send(f)
    spans = exporter.get_finished_spans()
    sent = [r for r in mock.api() if r["path"] == "/v3/agents/GHT7YRWXPL/versions/nope"]

    def attrs(s: ReadableSpan) -> dict[str, Any]:
        return dict(s.attributes or {})

    def children(parent: ReadableSpan) -> list[ReadableSpan]:
        assert parent.context is not None
        return [s for s in spans if s.parent and s.parent.span_id == parent.context.span_id]

    assert {s.name for s in spans} <= {"caitlyn.call", "caitlyn.attempt", "caitlyn.upload"}, [s.name for s in spans]
    assert all("caitlyn.operation" not in attrs(s) for s in spans)

    call = next(s for s in spans if s.name == "caitlyn.call" and attrs(s).get("rpc.method") == "GetAgentVersion")
    a = attrs(call)
    assert (a["rpc.system"], a["error.type"], a["caitlyn.error.code"]) == ("caitlyn", "NotFoundError", "NOT_FOUND")
    assert a["caitlyn.request_id"] == sent[-1]["requestId"]
    assert call.status.status_code == StatusCode.ERROR and call.status.description
    assert any(e.name == "exception" and (e.attributes or {}).get("exception.type") == "NotFoundError" for e in call.events)
    attempts = children(call)
    assert [s.name for s in attempts] == ["caitlyn.attempt"] * 2
    assert [attrs(s)["http.request.resend_count"] for s in attempts] == [0, 1]
    assert [attrs(s)["http.response.status_code"] for s in attempts] == [503, 404]
    assert [attrs(s)["caitlyn.request_id"] for s in attempts] == [r["requestId"] for r in sent]
    for s in attempts:
        a = attrs(s)
        assert (a["http.request.method"], a["server.address"]) == ("GET", "127.0.0.1")
        assert a["url.full"] == f"{mock.base}/v3/agents/GHT7YRWXPL/versions/nope"
        assert a["caitlyn.server.api_version"] == "5.120.0"
        assert s.status.status_code == StatusCode.ERROR and s.status.description
    assert [attrs(s)["error.type"] for s in attempts] == ["ServiceUnavailableError", "NotFoundError"]
    assert [attrs(s)["caitlyn.error.code"] for s in attempts] == ["SERVICE_UNAVAILABLE", "NOT_FOUND"]
    assert [next((e.attributes or {}).get("exception.type") for e in s.events if e.name == "exception") for s in attempts] == [
        "ServiceUnavailableError",
        "NotFoundError",
    ]

    listed = next(s for s in spans if s.name == "caitlyn.call" and attrs(s).get("rpc.method") == "ListDocuments")
    assert [attrs(s)["url.full"] for s in children(listed)] == [f"{mock.base}/v3/knowledge-bases/KB4T7YQ2WL/documents"]
    assert children(listed)[0].status.status_code != StatusCode.ERROR

    upload = next(s for s in spans if s.name == "caitlyn.upload")
    a = attrs(upload)
    assert (a["http.request.method"], a["server.address"], a["http.response.status_code"]) == ("PUT", "127.0.0.1", 200)
    assert re.fullmatch(r"http://127\.0\.0\.1:\d+/__s3/[^?]+", str(a["url.full"])), a["url.full"]


@case("telemetry.spans")
async def test_telemetry(mock: Mock, case_id: str) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}]})
    await client(mock, tracer_provider=provider).agents("GHT7YRWXPL").draft.get()
    spans = exporter.get_finished_spans()
    call = next(s for s in spans if s.name == "caitlyn.call")
    assert call.context is not None
    attempts = [s for s in spans if s.parent and s.parent.span_id == call.context.span_id]
    assert [(s.attributes or {})["http.request.resend_count"] for s in attempts] == [0, 1]
    assert (call.attributes or {})["caitlyn.request_id"] == mock.api()[-1]["requestId"]
    assert all("traceparent" in r["headers"] for r in mock.api())


@case("endpoint.workspace-url")
async def test_endpoint_workspace_url(mock: Mock, case_id: str) -> None:
    for w in ["https://your-company.getcaitlyn.ai", "https://your-company.getcaitlyn.ai/", "your-company.getcaitlyn.ai/", "HTTPS://Your-Company.GetCaitlyn.ai"]:
        c = AsyncCaitlyn(workspace=w, auth=Token("pat_test"))
        assert c.auth.workspace == "your-company.getcaitlyn.ai", w
        assert c.auth.token_endpoint == "https://your-company.getcaitlyn.ai/api/oauth/token", w
        await c.aclose()
    refused = [
        "https://your-company.getcaitlyn.ai/api",
        "https://your-company.getcaitlyn.ai/?x=1",
        "https://your-company.getcaitlyn.ai#top",
        "http://your-company.getcaitlyn.ai",
        "ftp://your-company.getcaitlyn.ai",
        "me@your-company.getcaitlyn.ai",
        "",
    ]
    for w in refused:
        with pytest.raises(ValueError, match="your-company.getcaitlyn.ai or https://your-company.getcaitlyn.ai"):
            AsyncCaitlyn(workspace=w, auth=Token("pat_test"))


@case("endpoint.workspace")
async def test_endpoint(mock: Mock, case_id: str) -> None:
    assert workspace_endpoint("your-company.getcaitlyn.ai") == "https://your-company.getcaitlyn.ai/api"
    c = AsyncCaitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"))
    assert c._core.config.endpoint == "https://your-company.getcaitlyn.ai/api"  # pyright: ignore[reportPrivateUsage]
    await c.aclose()


async def test_own_http_client_uses_the_endpoint(mock: Mock) -> None:
    """A caller's own httpx client, with no base_url or a different one, still sends to the client's endpoint."""
    for own in (httpx.AsyncClient(), httpx.AsyncClient(base_url="http://127.0.0.1:9")):
        async with own:
            v = await client(mock, http_client=own).agents("GHT7YRWXPL").draft.get()
            assert v.name == "draft"
    sync_own = httpx.Client()
    with sync_own:
        c = caitlyn.Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base, http_client=sync_own)
        assert c.agents("GHT7YRWXPL").draft.get().name == "draft"
    assert [r["path"] for r in mock.api()] == ["/v3/agents/GHT7YRWXPL/versions/draft"] * 3


# ------------------------------------------------------------------ sign-in (PROTOCOL.md section 12)
# Against the mock server's OAuth endpoints and STS stand-in (conformance/mock-server/auth.mjs). Each test turns
# on the mock's `require` fault, so every /v3/ request needs a credential the mock issued or accepts.

# The mock's accepted credentials (conformance/mock-server/auth.mjs: MOCK_CLIENT, MOCK_OAUTH_CLIENT, MOCK_AWS…).
MOCK_CLIENT = ("machine-client", "machine-secret")
MOCK_OAUTH_CLIENT = ("studio-client", "studio-secret")
MOCK_AWS = AwsCredentials("AKIDMOCKCAITLYN", "mock-secret-key", "session-token")
MOCK_AWS_REGION = "ap-southeast-2"
MOCK_PAT = "pat_test"
MOCK_SESSION_COOKIE = "caitlyn_session=mock-session"
# The audience comes from the workspace, never from the endpoint override these tests use.
RESOURCE = "https://your-company.getcaitlyn.ai/api"
REDIRECT = "https://app.example.com/callback"


def signed_in(mock: Mock, auth: Auth, workspace: str = "your-company.getcaitlyn.ai") -> AsyncCaitlyn:
    return AsyncCaitlyn(workspace=workspace, endpoint=mock.base, auth=auth)


def read(c: AsyncCaitlyn) -> Awaitable[AgentVersion]:
    return c.agents("GHT7YRWXPL").draft.get()


def cc_auth(**kw: Any) -> ClientCredentials:
    return dataclasses.replace(ClientCredentials(MOCK_CLIENT[0], MOCK_CLIENT[1]), **kw)


def aws_auth(**kw: Any) -> AwsIam:
    return dataclasses.replace(AwsIam(region=MOCK_AWS_REGION, credentials=MOCK_AWS), **kw)


def sign_in_required(mock: Mock) -> None:
    mock.faults(auth={"require": True})


async def auth_error(aw: Awaitable[Any]) -> CaitlynAuthError:
    with pytest.raises(CaitlynAuthError) as info:
        await aw
    return info.value


class MemoryStore:
    """A token store that counts how often it is cleared."""

    def __init__(self, tokens: OAuthTokens | None = None) -> None:
        self.tokens = tokens
        self.clears = 0

    def load(self) -> OAuthTokens | None:
        return self.tokens

    def save(self, tokens: OAuthTokens) -> None:
        self.tokens = tokens

    def clear(self) -> None:
        self.tokens = None
        self.clears += 1


def mock_oidc_token(aud: str) -> str:
    """A workload identity token, as GitLab CI would mint it (the mock reads it without checking a signature)."""

    def b64(d: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    now = int(time.time())
    claims = {"iss": "https://git.example.com", "sub": "project_path:group/project:ref_type:branch:ref:main", "aud": aud, "iat": now, "exp": now + 300, "jti": str(uuid.uuid4())}
    return f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims)}.mock"


async def oauth_sign_in(c: AsyncCaitlyn) -> httpx.URL:
    """The OAuth sign-in steps, following the mock's redirect as a browser would."""
    start = c.auth.authorization_url()
    async with httpx.AsyncClient() as browser:
        redirect = httpx.URL((await browser.get(start.url)).headers["location"])
    await c.auth.handle_callback(code=redirect.params["code"], state=redirect.params.get("state"), expected_state=start.state, code_verifier=start.code_verifier)
    return httpx.URL(start.url)


@contextmanager
def environment(**values: str | None) -> Iterator[None]:
    saved = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@case("auth.workspace")
async def test_auth_workspace(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    # A workspace given as a URL is reduced to its hostname.
    await read(signed_in(mock, cc_auth(), "https://your-company.getcaitlyn.ai/"))
    [form] = mock.token_requests()  # sent to the overriding endpoint
    assert form["resource"] == RESOURCE
    assert len(mock.api()) == 1


@case("auth.token")
async def test_auth_token(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    await read(signed_in(mock, Token(MOCK_PAT)))
    assert mock.api()[0]["headers"]["authorization"] == f"Bearer {MOCK_PAT}"
    assert mock.auth_counts() == {"sts": 0}


@case("auth.client-credentials")
async def test_auth_client_credentials(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    c = signed_in(mock, cc_auth(scopes=["agents:read"]))
    await asyncio.gather(read(c), read(c), read(c))
    await read(c)
    assert mock.auth_counts()["client_credentials"] == 1
    sent = {r["headers"]["authorization"] for r in mock.api()}
    assert len(sent) == 1
    assert sent.pop().startswith("Bearer cai_cc_")
    [form] = mock.token_requests()
    assert form["client_id"] == MOCK_CLIENT[0]
    assert form["resource"] == RESOURCE
    assert form["scope"] == "agents:read"


@case("auth.client-credentials-refused")
async def test_auth_client_credentials_refused(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    err = await auth_error(read(signed_in(mock, cc_auth(client_secret="wrong"))))
    assert (err.code, err.status) == ("invalid_client", 401)
    assert len(mock.api()) == 0


@case("auth.renew-before-expiry")
async def test_auth_renew_before_expiry(mock: Mock, case_id: str) -> None:
    mock.faults(auth={"require": True, "expiresIn": 1})
    c = signed_in(mock, cc_auth())
    await read(c)
    await read(c)
    assert mock.auth_counts()["client_credentials"] == 1, "reused within the first half of its life"
    await asyncio.sleep(0.6)
    await read(c)
    assert mock.auth_counts()["client_credentials"] == 2, "replaced after half its life"
    assert len(mock.api()) == 3, "no call was refused"


@case("auth.401-signs-in-again")
async def test_auth_401_signs_in_again(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    c = signed_in(mock, cc_auth())
    await read(c)
    mock.faults(auth={"revokeIssued": True})
    v = await read(c)
    assert v.agent_id == "GHT7YRWXPL"
    assert mock.auth_counts()["client_credentials"] == 2
    assert len(mock.api()) == 3, "the first call, then the refused attempt and the one after signing in again"


@case("auth.401-once")
async def test_auth_401_once(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    c = signed_in(mock, cc_auth())
    await read(c)
    # From here every token the mock issues expires at once, so the new token is refused too.
    mock.faults(auth={"revokeIssued": True, "expiresIn": 0})
    err = await expect_error(read(c))
    assert isinstance(err, UnauthenticatedError)
    assert (err.status, err.code) == (401, "UNAUTHENTICATED")
    assert mock.auth_counts()["client_credentials"] == 2, "signed in again once"
    assert len(mock.api()) == 3, "the first call, then two attempts at the second"


@case("auth.401-token-mode")
async def test_auth_401_token_mode(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    err = await expect_error(read(signed_in(mock, Token("pat_revoked"))))
    assert (err.status, err.code) == (401, "UNAUTHENTICATED")
    assert len(mock.api()) == 1


@case("auth.oauth-sign-in")
async def test_auth_oauth_sign_in(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    store = MemoryStore()
    c = signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], MOCK_OAUTH_CLIENT[1], redirect_uri=REDIRECT, scopes=["chat:write"], token_store=store))
    u = await oauth_sign_in(c)
    assert u.path == "/oauth/authorize"
    assert u.params["response_type"] == "code"
    assert u.params["code_challenge_method"] == "S256"
    assert u.params["resource"] == RESOURCE
    assert u.params["scope"] == "chat:write"
    [form] = mock.token_requests()
    assert form["grant_type"] == "authorization_code"
    assert form["resource"] == RESOURCE
    assert store.tokens is not None and store.tokens.refresh_token
    await read(c)
    assert mock.api()[0]["headers"]["authorization"].startswith("Bearer cai_code_")


@case("auth.oauth-state")
async def test_auth_oauth_state(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    c = signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], redirect_uri=REDIRECT))
    err = await auth_error(c.auth.handle_callback(code="x", state="forged", expected_state="expected", code_verifier="v"))
    assert err.code == "invalid_state"
    assert mock.token_requests() == []


@case("auth.oauth-refresh")
async def test_auth_oauth_refresh(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    store = MemoryStore()
    await oauth_sign_in(signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], redirect_uri=REDIRECT, token_store=store)))
    assert store.tokens is not None
    first = store.tokens.refresh_token
    # A new process with an expired access token in the store
    store.tokens = dataclasses.replace(store.tokens, expires_at=time.time() - 1)
    later = signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], token_store=store))
    await asyncio.gather(read(later), read(later))
    assert mock.auth_counts()["refresh_token"] == 1, "one refresh however many calls wait"
    assert store.tokens.refresh_token != first
    assert mock.api()[-1]["headers"]["authorization"].startswith("Bearer cai_refresh_")


@case("auth.oauth-401-single-flight")
async def test_auth_oauth_401_single_flight(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    c = signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], redirect_uri=REDIRECT, token_store=MemoryStore()))
    await oauth_sign_in(c)
    await read(c)
    # Every call is sent with the token the server now refuses; the 401s after the first arrive after its refresh.
    mock.faults(auth={"revokeIssued": True, "laterRefusalsDelayMs": 300})
    await asyncio.gather(*(read(c) for _ in range(5)))
    assert mock.auth_counts()["refresh_token"] == 1


class LockingStore(MemoryStore):
    """A token store whose with_lock runs one function at a time: what a database or Redis lock gives a shared store."""

    def __init__(self, tokens: OAuthTokens | None = None) -> None:
        super().__init__(tokens)
        self.lock = asyncio.Lock()
        self.locks = 0

    async def with_lock(self, fn: Callable[[], Awaitable[T]]) -> T:
        self.locks += 1
        async with self.lock:
            return await fn()


@case("auth.oauth-shared-store-lock")
async def test_auth_oauth_shared_store_lock(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    store = LockingStore()
    await oauth_sign_in(signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], redirect_uri=REDIRECT, token_store=store)))
    assert store.tokens is not None
    store.tokens = dataclasses.replace(store.tokens, expires_at=time.time() - 1)  # both clients find it expired
    mock.faults(auth={"refreshDelayMs": 300})  # the first refresh is still in flight when the second client asks
    a = signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], token_store=store))
    b = signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], token_store=store))
    await asyncio.gather(read(a), read(b))
    assert mock.auth_counts()["refresh_token"] == 1
    assert store.locks >= 2
    sent = [r["headers"]["authorization"] for r in mock.api()[-2:]]
    assert sent[0] == sent[1] and sent[0].startswith("Bearer cai_refresh_"), "the second client used the first one's tokens"


@case("auth.oauth-401-refreshes")
async def test_auth_oauth_401_refreshes(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    store = MemoryStore()
    c = signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], redirect_uri=REDIRECT, token_store=store))
    await oauth_sign_in(c)
    await read(c)
    mock.faults(auth={"revokeIssued": True})
    await read(c)
    assert mock.auth_counts()["refresh_token"] == 1
    sent = [r["headers"]["authorization"] for r in mock.api()]
    assert len(sent) == 3
    assert sent[1] == sent[0], "the refused token"
    assert sent[2].startswith("Bearer cai_refresh_")


@case("auth.oauth-refresh-refused")
async def test_auth_oauth_refresh_refused(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    store = MemoryStore(OAuthTokens("old", "rt_unknown", time.time() - 1))
    err = await auth_error(read(signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0], token_store=store))))
    assert err.code == "invalid_grant"
    assert store.tokens is None
    assert store.clears == 1
    assert len(mock.api()) == 0


@case("auth.oauth-not-signed-in")
async def test_auth_oauth_not_signed_in(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    err = await auth_error(read(signed_in(mock, OAuth(MOCK_OAUTH_CLIENT[0]))))
    assert err.code == "sign_in_required"
    assert len(mock.requests()) == 0


@case("auth.aws-iam")
async def test_auth_aws_iam(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    c = signed_in(mock, aws_auth(sts_endpoint=f"{mock.base}/__sts/"))
    await asyncio.gather(read(c), read(c))
    n = mock.auth_counts()
    assert n["sts"] == 1
    assert n["urn:ietf:params:oauth:grant-type:token-exchange"] == 1
    assert mock.api()[0]["headers"]["authorization"].startswith("Bearer cai_x_aws_")
    sts = dict(urllib.parse.parse_qsl(next(r for r in mock.requests() if r["path"] == "/__sts/")["body"]))
    assert sts["Action"] == "GetWebIdentityToken"
    assert sts["Audience.member.1"] == RESOURCE
    assert sts["SigningAlgorithm"] == "ES384"
    assert sts["DurationSeconds"] == "300"
    [form] = mock.token_requests()
    assert form["subject_token_type"] == "urn:ietf:params:oauth:token-type:jwt"
    assert form["resource"] == RESOURCE


@case("auth.aws-iam-provider")
async def test_auth_aws_iam_provider(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    calls = 0

    async def provider() -> AwsCredentials:
        nonlocal calls
        calls += 1
        return AwsCredentials(MOCK_AWS.access_key_id, MOCK_AWS.secret_access_key)

    await read(signed_in(mock, aws_auth(credentials=provider, sts_endpoint=f"{mock.base}/__sts/")))
    assert calls == 1
    assert mock.auth_counts()["sts"] == 1


@case("auth.aws-iam-env")
async def test_auth_aws_iam_env(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    with environment(AWS_ACCESS_KEY_ID=MOCK_AWS.access_key_id, AWS_SECRET_ACCESS_KEY=MOCK_AWS.secret_access_key, AWS_SESSION_TOKEN=None, AWS_REGION=MOCK_AWS_REGION):
        await read(signed_in(mock, AwsIam(sts_endpoint=f"{mock.base}/__sts/")))
    assert mock.auth_counts()["sts"] == 1


@case("auth.aws-iam-bad-signature")
async def test_auth_aws_iam_bad_signature(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    wrong = AwsCredentials(MOCK_AWS.access_key_id, "wrong")
    err = await auth_error(read(signed_in(mock, aws_auth(credentials=wrong, sts_endpoint=f"{mock.base}/__sts/"))))
    assert err.code == "SignatureDoesNotMatch"
    assert len(mock.api()) == 0


@case("auth.aws-iam-no-credentials")
async def test_auth_aws_iam_no_credentials(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"]
    with environment(**dict.fromkeys(keys)):
        err = await auth_error(read(signed_in(mock, aws_auth(credentials=None, sts_endpoint=f"{mock.base}/__sts/"))))
    assert err.code == "aws_identity_failed"
    assert len(mock.requests()) == 0


@case("auth.workload-identity")
async def test_auth_workload_identity(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    asked = 0

    async def ci_token() -> str:
        nonlocal asked
        asked += 1
        return mock_oidc_token(RESOURCE)

    await read(signed_in(mock, WorkloadIdentity(ci_token)))
    assert asked == 1
    assert mock.api()[0]["headers"]["authorization"].startswith("Bearer cai_x_oidc_")
    err = await auth_error(read(signed_in(mock, WorkloadIdentity(lambda: mock_oidc_token("https://other.getcaitlyn.ai/api")))))
    assert err.code == "invalid_grant"


@case("auth.workload-identity-single-use")
async def test_auth_workload_identity_single_use(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    jwt = mock_oidc_token(RESOURCE)
    await read(signed_in(mock, WorkloadIdentity(lambda: jwt)))
    err = await auth_error(read(signed_in(mock, WorkloadIdentity(lambda: jwt))))
    assert err.code == "invalid_grant"


@case("auth.session")
async def test_auth_session(mock: Mock, case_id: str) -> None:
    sign_in_required(mock)
    c = signed_in(mock, Session(cookie=MOCK_SESSION_COOKIE, origin="https://caitlyn.lndo.site"))
    v = await read(c)
    assert v.etag is not None
    await c.agents("GHT7YRWXPL").draft.update(if_match=v.etag, guidance=AgentGuidance(instructions="Cite clause numbers."))
    get, patch = mock.api()
    assert "authorization" not in get["headers"]
    assert get["headers"]["cookie"] == MOCK_SESSION_COOKIE
    assert "origin" not in get["headers"]
    assert patch["headers"]["origin"] == "https://caitlyn.lndo.site"
    assert "authorization" not in patch["headers"]
    assert mock.token_requests() == []


# ------------------------------------------------------------------ the model's @examples


def param(name: str) -> str:
    """A member's Python parameter name: snake_case, with `_` after a reserved word (`from` gives `from_`)."""
    n = snake(name)
    return n + "_" if keyword.iskeyword(n) or n in ("match", "case") else n


def snake(name: str) -> str:
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()


SCOPE_TREE: dict[str, Any] = json.loads((ROOT / "conformance" / "cases" / "scope-tree.json").read_text())
"""The client as scopes, as every generator places the operations (PROTOCOL.md 10)."""

type Place = tuple[list[dict[str, Any]], dict[str, Any], bool]
"""A method's place: the nodes from the client down to it, the method, and whether it is the method's estimate."""


def places() -> dict[str, list[Place]]:
    out: dict[str, list[Place]] = {}

    def walk(node: dict[str, Any], chain: list[dict[str, Any]]) -> None:
        here = [*chain, node]
        for m in node.get("methods", []):
            out.setdefault(m["operation"], []).append((here, m, False))
            if "estimate" in m:
                out.setdefault(m["estimate"], []).append((here, m, True))
        for c in node.get("children", {}).values():
            walk(c, here)
        if "scope" in node:
            walk(node["scope"], here)

    walk(SCOPE_TREE, [])
    return out


PLACES = places()


def identifier_value(identifier: str, method: dict[str, Any], given: dict[str, Any]) -> Any:
    """The value an example gives an identifier: through the member the method fills from it."""
    for f in method.get("fills", []):
        if f["identifier"] == identifier and f["member"] in given:
            return given[f["member"]]
    return given.get(identifier, "x")


def fixed_fits(place: Place, given: dict[str, Any]) -> bool:
    """A named scope (agent.draft) fits an example only when the example names the same version."""
    chain, method, _ = place
    for node in chain:
        for i in node.get("identifiers", []):
            if "fixed" in i:
                member = next((f["member"] for f in method.get("fills", []) if f["identifier"] == i["name"]), i["name"])
                if given.get(member, i["fixed"]) != i["fixed"]:
                    return False
    return True


def scope_method(c: AsyncCaitlyn, operation: str, given: dict[str, Any]) -> tuple[Callable[..., Any], list[Any], dict[str, Any]]:
    """The method an example's operation is called through, found in the scope tree: the example's input gives the
    identifiers of the scope (and, under core, the leading arguments), and the rest of it the call's arguments."""
    fitting = [p for p in PLACES[operation] if fixed_fits(p, given)]
    chain, method, estimate = max(fitting, key=lambda p: len({f["member"] for f in p[1].get("fills", [])} & set(given)))
    obj: Any = c
    for parent, node in zip(chain, chain[1:], strict=False):
        if node["kind"] == "scope" and parent["kind"] == "collection" and parent.get("scope") is node:
            obj = obj(*[identifier_value(i["name"], method, given) for i in parent["identifiers"]])
        else:
            obj = getattr(obj, snake(node["name"]))
    fn: Any = getattr(obj, snake(method["name"]))
    if estimate:
        fn = fn.estimate
    lead = [identifier_value(i, method, given) for i in method.get("leading", [])]
    filled = {f["member"] for f in method.get("fills", [])}
    return fn, lead, {param(k): v for k, v in given.items() if k not in filled}


def attr(model: Any, name: str) -> Any:
    """A model attribute by snake_case name; a name a model reserves (`fields`) has a trailing underscore."""
    return getattr(model, name) if hasattr(model, name) and not callable(getattr(model, name)) else getattr(model, name + "_")


def assert_subset(expected: Any, actual: Any, at: str = "output") -> None:
    if isinstance(expected, dict):
        for k, v in cast(dict[str, Any], expected).items():
            assert_subset(v, attr(actual, snake(k)) if not isinstance(actual, dict) else actual[k], f"{at}.{k}")
    elif isinstance(expected, list):
        items = cast(list[Any], expected)
        assert len(actual) == len(items), at
        for i, (e, a) in enumerate(zip(items, actual, strict=True)):
            assert_subset(e, a, f"{at}[{i}]")
    elif isinstance(actual, datetime):
        assert actual == datetime.fromisoformat(expected), at
    elif isinstance(actual, Enum):
        assert actual.value == expected, at
    else:
        assert actual == expected, at


def describes_a_file(operation: str) -> bool:
    """An estimate whose job takes a file: its method takes the file itself and describes it, so the example's own
    description is sent through the transport instead."""
    return operation in ("EstimateIngestion", "EstimateDocumentVersion")


@pytest.mark.parametrize("ex", EXAMPLES, ids=[f"[example] {e['id']}" for e in EXAMPLES])
async def test_example(mock: Mock, ex: dict[str, Any]) -> None:
    mock.prime_example(ex["id"])
    c = client(mock)
    spec = getattr(operations, re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", ex["operation"]).upper())
    raw_params = {param(k): v for k, v in ex["input"].items()}
    result: Any = None
    error: BaseException | None = None
    try:
        if spec.streaming:
            # A stream: the example is one response, so read that response's bytes through the transport, as the
            # other harnesses do, rather than events a watch would carry on reconnecting for.
            response, call = await c._core.send(spec, raw_params)  # pyright: ignore[reportPrivateUsage]
            await response.aread()
            await response.aclose()
            call.finish(None)
        elif describes_a_file(ex["operation"]):
            # The estimate's method takes a file and describes it; the example gives the description itself.
            result = await c._core.request(spec, raw_params, caitlyn_core.CaitlynResult)  # pyright: ignore[reportPrivateUsage]
        else:
            fn, lead, kwargs = scope_method(c, ex["operation"], ex["input"])
            out = fn(*lead, **kwargs)
            if hasattr(out, "pages"):  # a list (PROTOCOL.md 10): the example is one page, read with page()
                assert callable(getattr(out, "page", None)), f"{ex['operation']}'s list has no page()"
                result = await out.page()
            else:
                result = await out
                result = getattr(result, "result", None) or result
    except CaitlynError as e:
        error = e
    served = mock.example_result()
    assert served["served"], "the SDK sent no request"
    assert served["mismatches"] == [], "the request differs from the example"
    want = ex["expected"].get("error")
    if want:
        assert isinstance(error, CaitlynError), f"expected {want['shape']}, got {error!r}"
        assert type(error).__name__ == want["shape"]
        assert type(error) is getattr(caitlyn, want["shape"])
        assert (error.status, error.code, error.request_id) == (want["status"], want["code"], want["requestId"])
    else:
        assert error is None, f"unexpected error: {error!r}"
        if ex["expected"].get("output") and not describes_a_file(ex["operation"]):
            assert_subset(ex["expected"]["output"], result)
        elif ex["expected"].get("output"):
            assert_subset(ex["expected"]["output"], result.raw)


# ------------------------------------------------------------------ Python only: the synchronous client


def test_sync_stream_is_incremental(mock: Mock) -> None:
    from caitlyn import Caitlyn

    mock.faults(streamDelayMs=100)
    c = Caitlyn(workspace="x", auth=Token("pat_test"), endpoint=mock.base)
    t0 = time.monotonic()
    first_at: float | None = None
    with c.conversations("c-5").send("hi") as stream:
        for _ in stream:
            if first_at is None:
                first_at = time.monotonic() - t0
        answer = stream.final_message()
    assert answer is not None and answer.text == "Staff receive 20 days of annual leave."
    assert first_at is not None and first_at < 0.5, f"first event after {first_at}s: not incremental"


def test_sync_sign_in_one_token_across_threads(mock: Mock) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from caitlyn import Caitlyn

    sign_in_required(mock)
    c = Caitlyn(workspace="your-company.getcaitlyn.ai", endpoint=mock.base, auth=cc_auth())
    def call(_: int) -> AgentVersion:
        return c.agents("GHT7YRWXPL").draft.get()

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(call, range(8)))
    assert mock.auth_counts()["client_credentials"] == 1
    mock.faults(auth={"revokeIssued": True})
    c.agents("GHT7YRWXPL").draft.get()
    assert mock.auth_counts()["client_credentials"] == 2, "signed in again once after the 401"
    assert len(mock.api()) == 10


def test_sync_oauth_sign_in_refresh_and_sign_out(mock: Mock) -> None:
    from caitlyn import Caitlyn

    sign_in_required(mock)
    store = MemoryStore()
    c = Caitlyn(workspace="your-company.getcaitlyn.ai", endpoint=mock.base, auth=OAuth(MOCK_OAUTH_CLIENT[0], redirect_uri=REDIRECT, token_store=store))
    start = c.auth.authorization_url(state="kept")
    assert start.state == "kept"
    redirect = httpx.URL(httpx.get(start.url).headers["location"])
    c.auth.handle_callback(code=redirect.params["code"], state=redirect.params["state"], expected_state="kept", code_verifier=start.code_verifier)
    c.agents("GHT7YRWXPL").draft.get()
    mock.faults(auth={"revokeIssued": True})
    c.agents("GHT7YRWXPL").draft.get()
    assert mock.auth_counts()["refresh_token"] == 1
    c.auth.sign_out()
    assert store.tokens is None
    revoke = [f for f in mock.token_requests() if f.get("action") == "revoke"]
    assert len(revoke) == 1


def test_sync_client_refuses_async_callbacks(mock: Mock) -> None:
    from caitlyn import Caitlyn

    async def ci_token() -> str:
        return mock_oidc_token(RESOURCE)

    c = Caitlyn(workspace="your-company.getcaitlyn.ai", endpoint=mock.base, auth=WorkloadIdentity(ci_token))
    with pytest.raises(TypeError, match="AsyncCaitlyn"):
        c.agents("GHT7YRWXPL").draft.get()


async def test_oauth_steps_need_oauth_mode(mock: Mock) -> None:
    c = signed_in(mock, cc_auth())
    with pytest.raises(CaitlynAuthError) as info:
        c.auth.authorization_url(redirect_uri=REDIRECT)
    assert info.value.code == "invalid_request"


# ------------------------------------------------------------------ the client tree, files and uploads (PROTOCOL.md 10, 14)

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000") + b"\0" * 64
"""The start of a PNG: enough for the mock's avatar check."""


def sha_b64(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode()


def reservations(mock: Mock) -> list[dict[str, Any]]:
    return [json.loads(r["body"]) for r in mock.api() if r["method"] == "POST" and r["path"] == "/v3/uploads"]


def puts(mock: Mock) -> list[dict[str, Any]]:
    return [r for r in mock.requests() if r["method"] == "PUT" and str(r["path"]).startswith("/__s3/")]


KB = "KB4T7YQ2WL"
"""The mock's knowledge base: HR policies, with documents doc-0001 to doc-0007 under /policies/."""
AGENT = "GHT7YRWXPL"


def api_paths(mock: Mock) -> list[tuple[str, str]]:
    return [(str(r["method"]), str(r["path"])) for r in mock.api()]


def query_of(r: dict[str, Any]) -> dict[str, str]:
    return dict(urllib.parse.parse_qsl(str(r.get("query") or "").lstrip("?")))


@case("scope.sends-nothing")
async def test_scope_sends_nothing(mock: Mock, case_id: str) -> None:
    for c in (client(mock), Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)):
        kb = c.knowledge_bases(KB)
        made: list[object] = [
            kb, kb.documents("doc-0001"), kb.documents("doc-0001").versions("3"), kb.documents("doc-0001").access, kb.folders("/hr/"),
            kb.folders("/hr/").access, kb.fields("policyOwner"), kb.ingestion.batches("b-1").items("i-1"), kb.access, kb.layout_aware_search,
            c.agents(AGENT), c.agents(AGENT).draft, c.agents(AGENT).live, c.agents(AGENT).versions("v13"), c.agents(AGENT).history("h-1"),
            c.conversations("c-1"), c.conversations("c-1").messages("m-1"), c.core.operations(KB, "op-1"), c.core.uploads("u-1"),
        ]
        assert all(m is not None for m in made)
    assert mock.requests() == [], "making a scope sends nothing"


@case("scope.fills-identifiers")
async def test_scope_fills_identifiers(mock: Mock, case_id: str) -> None:
    c = client(mock)
    kb = c.knowledge_bases(KB)
    doc = await kb.documents("doc-0001").get()
    assert doc.id == "doc-0001"
    assert api_paths(mock)[-1] == ("GET", f"/v3/knowledge-bases/{KB}/documents/doc-0001")
    # A folder scope takes its path as people write it; a request path carries it without its first and last /.
    await (await kb.folders("/hr/investigations/").delete()).wait(timeout=10)
    assert ("DELETE", f"/v3/knowledge-bases/{KB}/folders/hr/investigations") in api_paths(mock)
    # Under a scope the identifiers are not arguments.
    assert "knowledge_base_id" not in inspect.signature(kb.documents("doc-0001").update).parameters
    assert kb.documents("doc-0001").id == "doc-0001" and kb.documents("doc-0001").knowledge_base_id == KB


@case("scope.named")
async def test_scope_named(mock: Mock, case_id: str) -> None:
    agent = client(mock).agents(AGENT)
    live = await agent.live.get()
    draft = await agent.draft.get()
    assert api_paths(mock) == [("GET", f"/v3/agents/{AGENT}/versions/live"), ("GET", f"/v3/agents/{AGENT}/versions/draft")]
    assert live.name != draft.name
    # agent.draft is one scope: Version's get and compare, and Draft's update, replace, save and reset.
    await agent.draft.update(guidance=AgentGuidance(instructions="Cite clause numbers."))
    assert api_paths(mock)[-1] == ("PATCH", f"/v3/agents/{AGENT}/versions/draft")
    assert "if-match" not in mock.api()[-1]["headers"], "If-Match is optional on the draft's update"
    for name in ("replace", "save", "reset", "publish", "compare", "get"):
        assert callable(getattr(agent.draft, name))
    # live leaves out what makes no sense for it.
    assert not hasattr(agent.live, "publish") and not hasattr(agent.live, "delete") and not hasattr(agent.live, "update")
    assert callable(agent.versions("v1").publish) and callable(agent.versions("v1").delete)


@case("scope.from-scope")
async def test_scope_from_scope(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    folder = await kb.folders("/hr/").access.get()
    doc = await kb.documents("doc-0001").access.get()
    await kb.documents("doc-0001").access.set(readers="everyone", if_match=doc.etag)
    whole = await kb.access.get()
    get_folder, get_doc, set_doc, get_kb = mock.api()
    assert get_folder["path"] == get_doc["path"] == set_doc["path"] == get_kb["path"] == f"/v3/knowledge-bases/{KB}/access"
    assert query_of(get_folder) == {"folder": "/hr/"}
    assert query_of(get_doc) == {"document": "doc-0001"} and query_of(set_doc) == {"document": "doc-0001"}
    assert query_of(get_kb) == {}
    assert folder.readers is not None and whole.roles


@case("scope.create-returns-scope")
async def test_scope_create_returns_scope(mock: Mock, tmp_path: Path, case_id: str) -> None:
    c = client(mock)
    agent = await c.agents.create("HR assistant", configuration={"guidance": {"instructions": "Answer from the HR policies."}})
    assert agent.id and agent.name == "HR assistant" and agent.result.id == agent.id
    draft = await agent.draft.get()  # at once, with no second lookup
    assert api_paths(mock)[-1] == ("GET", f"/v3/agents/{agent.id}/versions/draft") and draft.etag
    f = tmp_path / "leave-policy.pdf"
    f.write_bytes(b"%PDF-1.7 leave policy")
    kb = c.knowledge_bases(KB)
    doc = await kb.documents.create(f, folder="/hr/")
    assert doc.id == doc.document.id and doc.knowledge_base_id == KB and doc.operation.id
    assert (await doc.get()).id == doc.id
    folder = await kb.folders.create("/hr/leave/")
    assert folder.id == "/hr/leave/" and folder.operation.id
    access = await folder.access.get()
    assert query_of(mock.api()[-1]) == {"folder": "/hr/leave/"} and access.etag


@case("scope.core")
async def test_scope_core(mock: Mock, case_id: str) -> None:
    c = client(mock)
    up = await c.core.uploads.reserve(file_name="a.pdf", content_type="application/pdf", byte_size=1, sha256=sha_b64(b"x"))
    assert (await c.core.uploads(up.id).get()).id == up.id
    batch = await c.knowledge_bases(KB).ingestion.batches.create(start="manual", await_more_items=True)
    item = IngestionItemInput(path="/hr/a.md", sha256=sha_b64(b"a"), byte_size=1, content_type="text/markdown")
    added = await c.core.ingestion.add_items(KB, batch.id, [item], last=True)
    assert added.results[0].status == "created"
    folder = await c.knowledge_bases(KB).folders.create("/hr/core/")
    job = await c.core.operations(KB, folder.operation.id).get()
    assert job.id == folder.operation.id
    paths = api_paths(mock)
    assert ("POST", "/v3/uploads") in paths and ("GET", f"/v3/uploads/{up.id}") in paths
    assert ("POST", f"/v3/knowledge-bases/{KB}/ingestion-batches/{batch.id}/items:batch-create") in paths
    assert paths[-1] == ("GET", f"/v3/knowledge-bases/{KB}/operations/{job.id}")
    assert not hasattr(c, "uploads") and not hasattr(c, "operations")


@case("scope.estimate")
async def test_scope_estimate(mock: Mock, tmp_path: Path, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    fill_in = await kb.fields.fill_in.estimate(["policyOwner"])
    assert fill_in.documents >= 0
    post = mock.api()[-1]
    assert post["path"] == f"/v3/knowledge-bases/{KB}/fields:estimate-fill-in" and json.loads(post["body"]) == {"keys": ["policyOwner"]}
    f = tmp_path / "leave-policy.pdf"
    f.write_bytes(b"%PDF-1.7 leave policy")
    adding = await kb.documents.create.estimate(f)
    assert adding.documents == 1
    estimate = mock.api()[-1]
    assert estimate["path"] == f"/v3/knowledge-bases/{KB}/ingestions:estimate"
    assert json.loads(estimate["body"]) == {"documents": [{"name": "leave-policy.pdf", "contentType": "application/pdf", "byteSize": f.stat().st_size}]}
    assert reservations(mock) == [] and puts(mock) == [], "an estimate uploads nothing"
    await kb.documents("doc-0001").replace.estimate(f)
    assert mock.api()[-1]["path"] == f"/v3/knowledge-bases/{KB}/documents/doc-0001/versions:estimate"
    await kb.documents.reprocess.estimate(out_of_date=True)
    await kb.layout_aware_search.enable.estimate()
    assert [p for _, p in api_paths(mock)[-2:]] == [f"/v3/knowledge-bases/{KB}/documents:estimate-reprocess", f"/v3/knowledge-bases/{KB}/layout-aware-search-estimate"]


@case("access.readers-shorthand")
async def test_access_readers_shorthand(mock: Mock, case_id: str) -> None:
    folder = client(mock).knowledge_bases(KB).folders("/hr/investigations/")
    sent: list[Any] = []
    for readers in ({"roles": ["hr-team"]}, "everyone", "public", "inherit", {"roles": ["hr-team"], "people": ["u-7"]}):
        current = await folder.access.get()
        await folder.access.set(readers=readers, if_match=current.etag)  # pyright: ignore[reportArgumentType]
        sent.append(json.loads(mock.api()[-1]["body"])["readers"])
    assert sent == [
        {"kind": "specific", "roles": ["hr-team"]},
        {"kind": "everyone"},
        {"kind": "public"},
        {"kind": "inherit"},
        {"kind": "specific", "roles": ["hr-team"], "people": ["u-7"]},
    ]
    # The modelled shape is still accepted as it is.
    from caitlyn import Readers

    current = await folder.access.get()
    await folder.access.set(readers=Readers.model_validate({"kind": "everyone"}), if_match=current.etag)
    assert json.loads(mock.api()[-1]["body"])["readers"] == {"kind": "everyone"}


@case("access.public")
async def test_access_public(mock: Mock, case_id: str) -> None:
    from caitlyn.models import ReadersKind

    kb = client(mock).knowledge_bases(KB)
    folder = kb.folders("/policies/")
    await folder.access.set(readers="public")
    assert json.loads(mock.api()[-1]["body"]) == {"readers": {"kind": "public"}}
    read = await folder.access.get()
    assert read.readers is not None and read.readers.kind == ReadersKind.PUBLIC
    doc = kb.documents("doc-0001")
    await doc.access.set(readers={"kind": ReadersKind.PUBLIC})  # pyright: ignore[reportArgumentType]
    doc_read = await doc.access.get()
    assert doc_read.readers is not None and doc_read.readers.kind == "public"


@case("access.set-no-if-match")
async def test_access_set_no_if_match(mock: Mock, case_id: str) -> None:
    for c in (client(mock), Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)):
        mock.reset()
        out = c.knowledge_bases(KB).folders("/hr/investigations/").access.set(readers={"roles": ["hr-team"]})
        if inspect.isawaitable(out):
            await out
        [put] = mock.api()
        assert put["method"] == "PUT" and "if-match" not in put["headers"], "no If-Match, and no read first"
    # A given if_match is sent as it is, and a stale one fails with 412.
    mock.reset()
    folder = client(mock).knowledge_bases(KB).folders("/hr/investigations/")
    current = await folder.access.get()
    await folder.access.set(readers="everyone", if_match=current.etag)
    assert mock.api()[-1]["headers"]["if-match"] == current.etag
    with pytest.raises(PreconditionFailedError):
        await folder.access.set(readers="inherit", if_match=current.etag)


# ------------------------------------------------------------------ one type per thing (PROTOCOL.md 4.2)


@case("result.thing")
async def test_result_thing(mock: Mock, tmp_path: Path, case_id: str) -> None:
    from caitlyn import Agent, AgentVersion, Document, EstimateFillInFieldsResult, KnowledgeBase

    c = client(mock)
    kb = c.knowledge_bases(KB)
    assert type(await kb.get()) is KnowledgeBase
    doc = await kb.documents("doc-0001").get()
    assert type(doc) is Document and doc.id == "doc-0001" and doc.name, "the thing's own fields, at the top level"
    updated = await (await kb.documents("doc-0001").update(name="Leave policy.pdf", if_match=doc.etag)).wait(timeout=10)
    assert type(updated) is Document
    assert type(await c.agents(AGENT).get()) is Agent and type(await c.agents(AGENT).draft.get()) is AgentVersion
    assert all(type(d) is Document for d in await collect(kb.documents.list()))
    assert all(type(k) is KnowledgeBase for k in await collect(c.knowledge_bases.list()))
    created = await c.knowledge_bases.create(name="Pay policies")
    assert type(created.result) is KnowledgeBase and created.id == created.result.id
    async with kb.documents("doc-0002").watch() as stream:
        async for event in stream:
            assert event.type == "snapshot" and type(event.document) is Document
            break
    # A call whose output is not a thing keeps its named result.
    assert type(await kb.fields.fill_in.estimate(["policyOwner"])) is EstimateFillInFieldsResult


@case("result.thing-metadata")
async def test_result_thing_metadata(mock: Mock, case_id: str) -> None:
    c = client(mock)
    kb = c.knowledge_bases(KB)
    doc = await kb.documents("doc-0001").get()
    assert doc.response_metadata is not None
    assert (doc.response_metadata.http_status_code, doc.response_metadata.request_id) == (200, mock.api()[-1]["requestId"])
    waited = await kb.documents("doc-0001").wait(timeout=10)
    assert waited.response_metadata is not None, "wait() ends on a read, so its thing carries that response's"
    listed = await collect(kb.documents.list())
    assert all(d.response_metadata is None for d in listed), "a list item carries none"
    async with kb.documents("doc-0001").watch() as stream:
        async for event in stream:
            assert event.type == "snapshot" and event.document is not None and event.document.response_metadata is None
            break
    for dumped in (doc.to_wire(), doc.model_dump(), doc.model_dump(mode="json", by_alias=True)):
        assert "response_metadata" not in dumped and "responseMetadata" not in dumped, "never serialised with the thing"


@case("result.thing-etag")
async def test_result_thing_etag(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    doc = await kb.documents("doc-0001").get()
    assert doc.etag and doc.etag == doc.response_metadata.etag if doc.response_metadata else False
    [listed] = [d for d in await collect(kb.documents.list()) if d.id == "doc-0001"]
    assert listed.etag == doc.etag
    async with kb.documents("doc-0001").watch() as stream:
        async for event in stream:
            assert event.type == "snapshot" and event.document is not None and event.document.etag == doc.etag
            break
    # A single read whose body has no etag: the SDK fills it from the ETag header.
    body = dict(doc.raw)
    body.pop("etag", None)

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body, headers={"ETag": '"from-the-header"', "Caitlyn-Request-Id": "req-1"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as own:
        filled = await client(mock, http_client=own).knowledge_bases(KB).documents("doc-0001").get()
    assert filled.etag == '"from-the-header"'
    with httpx.Client(transport=httpx.MockTransport(answer)) as own_sync:
        sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base, http_client=own_sync)
        assert sync.knowledge_bases(KB).documents("doc-0001").get().etag == '"from-the-header"'


@case("result.thing-raw")
async def test_result_thing_raw(mock: Mock, case_id: str) -> None:
    mock.faults(unknownField=True)
    version = await client(mock).agents(AGENT).draft.get()
    assert version.raw["reviewState"] == {"required": False}, "an unknown field, kept"
    assert version.raw["name"] == "draft" and version.raw["etag"] == version.etag


@case("result.list-etag-if-match")
async def test_result_list_etag_if_match(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    [listed] = [d for d in await collect(kb.documents.list()) if d.id == "doc-0001"]
    updated = await kb.documents("doc-0001").update(name="Leave policy (2027).pdf", if_match=listed.etag)
    assert updated.result.document.name == "Leave policy (2027).pdf"
    assert mock.api()[-1]["headers"]["if-match"] == listed.etag


@case("estimate.caller-hints")
async def test_estimate_caller_hints(mock: Mock, case_id: str) -> None:
    from caitlyn import IngestionHints

    def unread() -> Iterator[bytes]:
        raise AssertionError("a file is not read for an estimate")
        yield b""  # pragma: no cover

    hinted = UploadFile.from_stream(unread(), name="annual-report.pdf", size=482113, hints=IngestionHints(pages=40, scanned_pages=3))
    plain = UploadFile.from_stream(unread(), name="notes.md", size=1200)
    kb = client(mock).knowledge_bases(KB)
    bodies = Bodies()
    kb = client(mock, interceptors=[bodies]).knowledge_bases(KB)
    await kb.documents.create.estimate(hinted)
    await kb.documents.create.estimate(plain)
    await kb.documents("doc-0001").replace.estimate(UploadFile.from_stream(unread(), name="policy-1.pdf", size=9000, hints={"pages": 12}))
    await kb.documents("doc-0001").replace.estimate(UploadFile.from_stream(unread(), name="policy-1.pdf", size=9000))
    [with_hints, without] = [b["documents"][0] for b in bodies.of("EstimateIngestion")]
    assert with_hints == {"name": "annual-report.pdf", "contentType": "application/pdf", "byteSize": 482113, "hints": {"pages": 40, "scannedPages": 3}}
    assert without == {"name": "notes.md", "contentType": "text/markdown", "byteSize": 1200}
    [replace_hinted, replace_plain] = [b["file"] for b in bodies.of("EstimateDocumentVersion")]
    assert replace_hinted["hints"] == {"pages": 12} and "hints" not in replace_plain
    # sync.estimate: each document's own hints; batch items carry none.
    files = [SyncFile("a.pdf", UploadFile.from_bytes(b"%PDF a", name="a.pdf", hints={"pages": 2})), SyncFile("b.md", UploadFile.from_bytes(b"b", name="b.md"))]
    await kb.ingestion.sync.estimate(files, folder="/hints/")
    documents = bodies.of("EstimateIngestion")[-1]["documents"]
    assert [d.get("hints") for d in documents] == [{"pages": 2}, None]
    assert all("hints" not in i for i in bodies.of("CreateIngestionBatch")[-1]["items"])
    # The synchronous client the same.
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base, interceptors=[bodies])
    sync.knowledge_bases(KB).documents.create.estimate(UploadFile.from_bytes(b"x", name="x.pdf", hints={"pages": 1}))
    assert bodies.of("EstimateIngestion")[-1]["documents"][0]["hints"] == {"pages": 1}


# ------------------------------------------------------------------ watching and waiting (PROTOCOL.md 16)


def watches(mock: Mock) -> list[dict[str, Any]]:
    return [r for r in mock.api() if r["method"] == "GET" and str(r["path"]).endswith("/events")]


@case("watch.snapshot-first")
async def test_watch_snapshot_first(mock: Mock, case_id: str) -> None:
    mock.faults(busyDocuments={"doc-0001": True})
    seen: list[str] = []
    async with client(mock).knowledge_bases(KB).documents("doc-0001").watch() as stream:
        async for event in stream:
            seen.append(event.type)
            if event.type == "snapshot":
                assert event.document is not None and event.document.id == "doc-0001"
            if event.type == "job.finished":
                break
    assert seen[0] == "snapshot" and "job.progress" in seen and "document.progress" in seen
    [watch] = watches(mock)
    assert watch["path"] == f"/v3/knowledge-bases/{KB}/events" and query_of(watch) == {"document": "doc-0001"}
    # The knowledge base's own watch: the whole knowledge base, no filter.
    async with client(mock).knowledge_bases(KB).watch() as stream:
        async for event in stream:
            assert event.type == "snapshot" and event.knowledge_base is not None
            break
    assert query_of(watches(mock)[-1]) == {}


@case("watch.reconnect-snapshot")
async def test_watch_reconnect_snapshot(mock: Mock, case_id: str) -> None:
    mock.faults(watchDrops={"count": 1, "afterEvents": 1})
    seen: list[str] = []
    async with client(mock).knowledge_bases(KB).folders("/policies/").watch() as stream:
        async for event in stream:
            seen.append(event.type)
            if len(seen) == 2:
                break
    assert seen == ["snapshot", "snapshot"], "the new connection starts with a snapshot, and it is delivered"
    first, second = watches(mock)
    assert query_of(first) == query_of(second) == {"folder": "/policies/"}
    assert "last-event-id" not in second["headers"], "a scope's watch reconnects with no cursor"


@case("wait.done")
async def test_wait_done(mock: Mock, case_id: str) -> None:
    mock.faults(busyDocuments={"doc-0001": True})
    doc = await client(mock).knowledge_bases(KB).documents("doc-0001").wait(timeout=10)
    assert doc.id == "doc-0001" and str(doc.status) == "indexed"
    assert api_paths(mock)[-1] == ("GET", f"/v3/knowledge-bases/{KB}/documents/doc-0001"), "it returns the thing as its get would"
    # Nothing running: it returns at once.
    mock.reset()
    assert str((await client(mock).knowledge_bases(KB).documents("doc-0002").wait(timeout=10)).status) == "indexed"
    # A folder has no get: its wait returns its summary from the watch's snapshot.
    folder = await client(mock).knowledge_bases(KB).folders("/policies/").wait(timeout=10)
    assert folder.path == "/policies/" and folder.etag
    # The synchronous client's wait.
    mock.reset()
    mock.faults(busyDocuments={"doc-0003": True})
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    done = await asyncio.to_thread(sync.knowledge_bases(KB).documents("doc-0003").wait, timeout=10)
    assert str(done.status) == "indexed"


@case("wait.partial")
async def test_wait_partial(mock: Mock, case_id: str) -> None:
    mock.faults(busyDocuments={"doc-0001": True}, jobOutcomes={"doc-0001": "completed_with_failures"})
    doc = await client(mock).knowledge_bases(KB).documents("doc-0001").wait(timeout=10)
    assert str(doc.status) == "partially_indexed"
    assert doc.partial_failures and doc.partial_failures[0].code == "PICTURE_DESCRIPTION_FAILED"


@case("wait.failed")
async def test_wait_failed(mock: Mock, case_id: str) -> None:
    from caitlyn import UnprocessableContentError

    mock.faults(busyDocuments={"doc-0001": True}, jobOutcomes={"doc-0001": "failed"})
    with pytest.raises(UnprocessableContentError) as failed:
        await client(mock).knowledge_bases(KB).documents("doc-0001").wait(timeout=10)
    assert (failed.value.status, failed.value.code) == (422, "CONTENT_REJECTED")
    mock.reset()
    mock.faults(busyDocuments={"doc-0001": True}, jobOutcomes={"doc-0001": "cancelled"})
    err = await expect_error(client(mock).knowledge_bases(KB).documents("doc-0001").wait(timeout=10))
    assert (type(err), err.status, err.code) == (CaitlynError, 0, "CANCELLED")
    # A started job's failure, through the wait of the call that started it.
    mock.reset()
    mock.faults(jobOutcomes={"fill_in": "failed"})
    with pytest.raises(UnprocessableContentError):
        await (await client(mock).knowledge_bases(KB).fields.fill_in(["policyOwner"])).wait(timeout=10)


@case("wait.gone")
async def test_wait_gone(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    deleted = await kb.documents("doc-0002").delete()
    assert await deleted.wait(timeout=10) is None
    with pytest.raises(NotFoundError):
        await kb.documents("doc-0002").get()
    # A folder's deletion is a job: its wait returns once it has ended and the folder is gone.
    assert await (await kb.folders("/archive/").delete()).wait(timeout=10) is None
    # On anything else, a 404 ends the wait with the 404.
    err = await expect_error(kb.documents("doc-9999").wait(timeout=10))
    assert (type(err), err.status) == (NotFoundError, 404)


@case("wait.delete-processing")
async def test_wait_delete_processing(mock: Mock, tmp_path: Path, case_id: str) -> None:
    # A document still being processed can be deleted: the delete stops its processing (the job ends cancelled as part
    # of the delete), and the delete's wait ends on the gone rule, never with CANCELLED.
    f = tmp_path / "leave-policy.pdf"
    f.write_bytes(b"%PDF-1.7 leave policy")
    kb = client(mock).knowledge_bases(KB)
    made = await kb.documents.create(f, folder="/hr/")
    assert str(made.document.status) in ("pending", "processing")
    deleted = await made.delete()
    assert await deleted.wait(timeout=10) is None
    with pytest.raises(NotFoundError):
        await made.get()
    assert made.id not in [d.id async for d in kb.documents.list(folder="/hr/")], "it does not come back"
    # The same on the synchronous client.
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    sync_kb = sync.knowledge_bases(KB)
    sync_made = await asyncio.to_thread(lambda: sync_kb.documents.create(f, folder="/pay/"))
    assert await asyncio.to_thread(lambda: sync_made.delete().wait(timeout=10)) is None


@case("wait.started-work")
async def test_wait_started_work(mock: Mock, tmp_path: Path, case_id: str) -> None:
    f = tmp_path / "leave-policy.pdf"
    f.write_bytes(b"%PDF-1.7 leave policy")
    kb = client(mock).knowledge_bases(KB)
    made = await kb.documents.create(f, folder="/hr/")
    assert str(made.document.status) in ("pending", "processing")  # awaiting the call gives the response
    doc = await made.wait(timeout=10)
    assert doc.id == made.id and str(doc.status) == "indexed"
    replaced = await kb.documents(doc.id).replace(UploadFile.from_bytes(b"%PDF-1.7 the 2027 edition", name="leave-policy.pdf"))
    assert replaced.result.version.number == 2 and replaced.version.number == 2  # the response's fields, on the result too
    again = await replaced.wait(timeout=10)
    assert again.version == 2
    filled = await kb.fields.fill_in(["policyOwner"])
    assert filled.result.job.id and filled.job.id == filled.result.job.id
    # The handle's watch(): the events of the thing the work is on, a snapshot first.
    async with filled.watch() as stream:
        async for event in stream:
            assert event.type == "snapshot" and any(j.id == filled.result.job.id for j in event.jobs)
            break
    assert (await filled.wait(timeout=10)).id == KB
    # The synchronous client returns at once, so .wait() chains.
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    chained = await asyncio.to_thread(lambda: sync.knowledge_bases(KB).documents.create(f, folder="/pay/").wait(timeout=10))
    assert str(chained.status) == "indexed" and chained.folder == "/pay/"
    created = await asyncio.to_thread(lambda: sync.knowledge_bases.create(name="Pay policies").wait(timeout=10))
    assert str(created.status) == "ready"


@case("wait.busy-status")
async def test_wait_busy_status(mock: Mock, case_id: str) -> None:
    # A knowledge base being created has no job: its status alone keeps the wait going until it is ready.
    mock.faults(jobSteps=3)
    c = client(mock)
    kb = await c.knowledge_bases.create(name="Pay policies")
    first = await c.knowledge_bases(kb.id).get()
    assert str(first.status) == "creating"
    ready = await kb.wait(timeout=10)
    assert str(ready.status) == "ready"
    async with c.knowledge_bases(kb.id).watch() as stream:
        async for event in stream:
            assert event.type == "snapshot" and event.jobs == [], "no job is listed on a knowledge base being created"
            break
    assert len(watches(mock)) == 2
    # A document being deleted is busy too: its delete's wait goes through `deleting` to the deleted event.
    doc = c.knowledge_bases(KB).documents("doc-0003")
    deleted = await doc.delete()
    assert str((await doc.get()).status) == "deleting"
    assert await deleted.wait(timeout=10) is None
    with pytest.raises(NotFoundError):
        await doc.get()


@case("watch.event-types")
async def test_watch_event_types(mock: Mock, case_id: str) -> None:
    from caitlyn.models import Document

    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base).knowledge_bases(KB)
    kb = client(mock).knowledge_bases(KB)
    # A snapshot entry and a change event (document.updated) carry the model's types: datetimes, not strings.
    for run in ("async", "sync"):
        mock.faults(busyWithoutJob={"doc-0001": 0})
        seen: list[Any] = []
        if run == "async":
            async with kb.documents("doc-0001").watch() as stream:
                async for event in stream:
                    seen.append(event)
                    if event.type == "document.updated":
                        break
        else:
            def read() -> None:
                with sync.documents("doc-0001").watch() as stream:
                    for event in stream:
                        seen.append(event)
                        if event.type == "document.updated":
                            break
            await asyncio.to_thread(read)
        snapshot, change = seen[0], seen[-1]
        assert snapshot.type == "snapshot" and change.type == "document.updated", run
        for document in (snapshot.document, change.document):
            assert type(document) is Document and isinstance(document.created_at, datetime) and isinstance(document.updated_at, datetime), run
    # So a folder's wait() and ListFolders give the same Folder.
    listed = {f.path: f async for f in kb.folders.list()}
    assert await kb.folders("/policies/").wait(timeout=10) == listed["/policies/"]
    assert await asyncio.to_thread(sync.folders("/policies/").wait, timeout=10) == listed["/policies/"]
    assert isinstance(listed["/policies/"].updated_at, datetime)


@case("watch.break-closes")
async def test_watch_break_closes(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base).knowledge_bases(KB)

    async def closed_within_a_second(before: int, requests_before: int, how: str) -> None:
        deadline = time.monotonic() + 1
        while len(disconnected(mock)) == before:
            assert time.monotonic() < deadline, f"{how}: the server did not see the client disconnect within a second"
            await asyncio.sleep(0.02)
        assert len(mock.api()) == requests_before, f"{how}: no further request"

    async def leave_async(by_break: bool) -> None:
        async with kb.documents("doc-0002").watch() as stream:
            async for event in stream:
                assert event.type == "snapshot"
                if by_break:
                    break
                return  # leaves the context from inside the iteration

    def leave_sync(by_break: bool) -> None:
        with sync.documents("doc-0002").watch() as stream:
            for event in stream:
                assert event.type == "snapshot"
                if by_break:
                    break
                return

    for how in ("async break", "async context", "sync break", "sync context"):
        before, requests_before = len(disconnected(mock)), len(mock.api()) + 1
        if how.startswith("async"):
            await leave_async(how.endswith("break"))
        else:
            await asyncio.to_thread(leave_sync, how.endswith("break"))
        await closed_within_a_second(before, requests_before, how)


def disconnected(mock: Mock) -> list[dict[str, Any]]:
    return [r for r in mock.requests() if r.get("event") == "client-disconnected" and str(r.get("subject", "")).startswith("kb:")]


@case("wait.timeout")
async def test_wait_timeout(mock: Mock, case_id: str) -> None:
    mock.faults(busyDocuments={"doc-0001": True}, jobSteps=100_000, watchTickMs=50)
    with pytest.raises(TimeoutError) as timed_out:
        await client(mock).knowledge_bases(KB).documents("doc-0001").wait(timeout=0.5)
    assert isinstance(timed_out.value, WaitTimeoutError) and (timed_out.value.code, timed_out.value.status) == ("WAIT_TIMEOUT", 0)
    await asyncio.sleep(0.2)
    assert len(disconnected(mock)) == 1, "the watch is closed when the time limit passes"
    # The synchronous client: the same error, and the watch closed too.
    mock.reset()
    mock.faults(busyDocuments={"doc-0002": True}, jobSteps=100_000, watchTickMs=50)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    with pytest.raises(WaitTimeoutError) as sync_timed_out:
        await asyncio.to_thread(sync.knowledge_bases(KB).documents("doc-0002").wait, timeout=0.5)
    assert sync_timed_out.value.code == "WAIT_TIMEOUT"
    await asyncio.sleep(0.2)
    assert len(disconnected(mock)) == 1


@case("watch.gone")
async def test_watch_gone(mock: Mock, case_id: str) -> None:
    # The watch's first connection is cut after its snapshot; before it reconnects, the folder is deleted, so the
    # reconnect is answered 404. That ends the watch at once, as the folder being gone, with no further reconnect.
    mock.faults(watchDrops={"count": 1, "afterEvents": 1})
    kb = client(mock).knowledge_bases(KB)
    async with kb.folders("/archive/").watch() as stream:
        events = aiter(stream)
        first = await anext(events)
        assert first.type == "snapshot"
        assert await (await kb.folders("/archive/").delete()).wait(timeout=10) is None
        with pytest.raises(NotFoundError):
            await anext(events)
        assert stream.reconnects == 1, "a 404 does not count towards STREAM_LOST, and is not tried again"
    folder_watches = [r for r in watches(mock) if query_of(r) == {"folder": "/archive/"}]
    assert len(folder_watches) == 3  # the watch, the delete's wait, and the reconnect that found it gone
    # wait() ends by the gone rule: on a scope that was not deleted by the call, the 404.
    err = await expect_error(kb.folders("/archive/").wait(timeout=10))
    assert (type(err), err.status) == (NotFoundError, 404)


@case("wait.deadline-reread")
async def test_wait_deadline_reread(mock: Mock, tmp_path: Path, case_id: str) -> None:
    def batch_reads() -> int:
        return sum(1 for r in mock.api() if r.get("method") == "GET" and re.search(r"/ingestion-batches/[^/]+$", str(r["path"])))

    # The mock's deadlinePassed: only GetIngestionBatch ends a batch past its deadline, and its watch never shows the
    # end. 'uploads': started, nothing uploaded, uploadsExpireAt a minute gone.
    mock.faults(deadlinePassed="uploads")
    data = b"%PDF-1.7 annual leave"
    batch = await built_batch(client(mock), {"/hr/annual-leave.pdf": data})
    done = await batch.wait(timeout=10)
    assert str(done.status) == "completed_with_failures"
    [item] = [i async for i in batch.items.list()]
    assert (str(item.status), item.failure_code) == ("failed", "UPLOAD_EXPIRED")

    # watch() yields the read as a snapshot: a fresh batch, so that only the SDK's read can show it ended.
    mock.reset()
    mock.faults(deadlinePassed="uploads")
    watched = await built_batch(client(mock), {"/hr/annual-leave.pdf": data})
    before = batch_reads()
    ended: Any = None
    async with asyncio.timeout(10):
        async with watched.watch() as stream:
            async for event in stream:
                if event.type == "snapshot" and event.batch is not None and str(event.batch.status) == "completed_with_failures":
                    ended = event.batch
                    break
    assert ended is not None and ended.id == watched.ingestion_batch_id
    assert batch_reads() > before, "GetIngestionBatch was sent"

    # The synchronous client's wait, whose watch is read on a thread of its own.
    mock.reset()
    mock.faults(deadlinePassed="uploads")
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    made = sync.knowledge_bases(KB).ingestion.batches.create(start="manual", items=[batch_item("/hr/annual-leave.pdf", data)])
    made.planned(timeout=10)
    started = made.start()
    finished = await asyncio.to_thread(lambda: started.wait(timeout=10))
    assert str(finished.status) == "completed_with_failures"

    # A sync whose batch is past its upload deadline, with its one upload failing (so it is never made), finishes: the
    # read ends the batch. The report keeps the SDK's own UPLOAD_FAILED for the item; the server's is UPLOAD_EXPIRED.
    for use_sync in (False, True):
        mock.reset()
        mock.faults(deadlinePassed="uploads", failUploads={"/hr/annual-leave.md": True})
        root = folder_of(tmp_path / str(use_sync), {"annual-leave.md": b"Staff receive 20 days of annual leave."})
        async with asyncio.timeout(30):
            if use_sync:
                report = await asyncio.to_thread(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/hr/"))
            else:
                report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/")
        assert str(report.batch.status) == "completed_with_failures", report.batch
        [synced] = report.items
        assert (str(synced.status), synced.failure_code) == ("failed", "UPLOAD_FAILED")
        [listed] = [i async for i in client(mock).knowledge_bases(KB).ingestion.batches(report.batch.id).items.list()]
        assert (str(listed.status), listed.failure_code) == ("failed", "UPLOAD_EXPIRED")

    # Each deadline is read once: a read that returns the same deadline schedules nothing more, and a snapshot with a
    # new deadline starts the timer again.
    def seen(status: str, uploads_expire_at: str) -> Any:
        return SimpleNamespace(status=status, uploads_expire_at=datetime.fromisoformat(uploads_expire_at))

    clock = core_deadline.DeadlineClock()
    first = seen("running", "2026-11-17T10:00:00Z")
    clock.see(first)
    assert clock.due == first.uploads_expire_at.timestamp() + core_deadline.DEADLINE_GRACE
    clock.reading()
    clock.see(seen("running", "2026-11-17T10:00:00Z"))
    assert clock.due is None, "the same deadline is not read again"
    clock.see(seen("running", "2026-11-17T10:30:00Z"))
    assert clock.due is not None, "a new deadline is"
    clock.see(seen("completed_with_failures", "2026-11-17T11:00:00Z"))
    assert clock.due is None, "an ended batch is not read"


@case("wait.progress")
async def test_wait_progress(mock: Mock, case_id: str) -> None:
    mock.faults(busyDocuments={"doc-0001": True}, jobSteps=3)
    seen: list[Any] = []
    doc = client(mock).knowledge_bases(KB).documents("doc-0001")
    first: Any = None
    async with doc.watch() as stream:  # starts the processing, so the wait's snapshot carries it
        async for event in stream:
            if event.type == "document.progress":
                first = event.processing
                break
    done = await doc.wait(timeout=10, on_progress=seen.append)
    assert isinstance(first, DocumentProcessing) and seen[0].percent >= first.percent, "the snapshot's processing first"
    assert str(done.status) == "indexed"
    # The snapshot's processing first (the document is being processed when the watch opens), then each
    # document.progress event's, in order, once each; never again once wait() has returned.
    assert len(seen) >= 2 and all(isinstance(p, DocumentProcessing) for p in seen)
    percents = [p.percent for p in seen]
    assert percents == sorted(percents), "in order: the percentage never goes backwards"
    after = len(seen)
    await asyncio.sleep(0.1)
    assert len(seen) == after
    # The sync client, and an async callback on the async client.
    mock.reset()
    mock.faults(busyDocuments={"doc-0002": True}, jobSteps=2)
    sync_seen: list[Any] = []
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    await asyncio.to_thread(lambda: sync.knowledge_bases(KB).documents("doc-0002").wait(timeout=10, on_progress=sync_seen.append))
    assert sync_seen and sync_seen[0].stage is not None
    mock.reset()
    mock.faults(busyDocuments={"doc-0003": True})
    awaited: list[int] = []

    async def note(p: DocumentProcessing) -> None:
        awaited.append(p.percent)

    await client(mock).knowledge_bases(KB).documents("doc-0003").wait(timeout=10, on_progress=note)
    assert awaited
    # A started call's wait() takes it too: a folder's processing is the running job.
    mock.reset()
    jobs: list[Any] = []
    await (await client(mock).knowledge_bases(KB).folders("/archive/").delete()).wait(timeout=10, on_progress=jobs.append)
    assert jobs and all(str(j.kind) == "folder_change" for j in jobs)


@case("watch.processing")
async def test_watch_processing(mock: Mock, case_id: str) -> None:
    mock.faults(busyDocuments={"doc-0001": True}, jobSteps=3)
    kb = client(mock).knowledge_bases(KB)
    # A first watch starts the document's processing (busyDocuments) and sees it begin; the next opens on a snapshot
    # that already carries it.
    async with kb.documents("doc-0001").watch() as stream:
        async for event in stream:
            if event.type == "document.progress":
                break
    by_type: list[tuple[str, Any]] = []
    async with kb.documents("doc-0001").watch() as stream:
        async for event in stream:
            by_type.append((event.type, event.processing))  # one accessor, whatever the event
            if event.type == "job.finished":
                break
    snapshot = by_type[0]
    assert snapshot[0] == "snapshot" and isinstance(snapshot[1], DocumentProcessing)
    progress = [p for t, p in by_type if t == "document.progress"]
    assert progress and all(isinstance(p, DocumentProcessing) for p in progress)
    assert all(p is None for t, p in by_type if t not in ("snapshot", "document.progress")), "nothing when the event carries none"
    # A folder's watch: the job running on it.
    folder_jobs: list[Any] = []
    deleting = await kb.folders("/archive/").delete()
    async with kb.folders("/archive/").watch() as stream:
        async for event in stream:
            if event.processing is not None:
                folder_jobs.append(event.processing)
            if event.type in ("job.finished", "folder.deleted"):
                break
    assert folder_jobs and all(isinstance(j, Job) and j.id == deleting.result.operation.id for j in folder_jobs)
    # The knowledge base's own watch: the thing named by the identifier given.
    mock.reset()
    # Enough steps that the job is still running when the knowledge base's watch connects, however slowly it reads
    mock.faults(busyDocuments={"doc-0002": True}, jobSteps=50)
    async with client(mock).knowledge_bases(KB).documents("doc-0002").watch() as stream:
        async for event in stream:  # the job starts when the document's watch connects
            if event.type == "document.progress":
                break
    async with client(mock).knowledge_bases(KB).watch() as stream:
        async for event in stream:
            assert event.processing is None, "the knowledge base's own watch names no single thing"
            got = event.processing_of("doc-0002")
            assert isinstance(got, DocumentProcessing) and event.processing_of("doc-9999") is None
            break


@case("wait.planned")
async def test_wait_planned(mock: Mock, case_id: str) -> None:
    mock.faults(planningReads=2)
    kb = client(mock).knowledge_bases(KB)
    item = IngestionItemInput(path="/hr/a.md", sha256=sha_b64(b"a"), byte_size=1, content_type="text/markdown")
    batch = await kb.ingestion.batches.create(start="manual", items=[item])
    planned = await batch.planned(timeout=10)
    assert str(planned.status) == "planned" and planned.id == batch.id
    assert query_of(watches(mock)[0]) == {"batch": batch.id}


@case("start.if-match-optional")
async def test_start_if_match_optional(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base).knowledge_bases(KB)

    async def planned_batch(path: str) -> tuple[str, str]:
        item = IngestionItemInput(path=path, sha256=sha_b64(path.encode()), byte_size=len(path), content_type="text/markdown")
        batch = await kb.ingestion.batches.create(start="manual", items=[item])
        planned = await batch.planned(timeout=10)
        assert planned.etag
        return batch.id, planned.etag

    # No ifMatch: StartIngestionBatch alone, with no If-Match and no read before it, on both clients.
    for run, path in (("async", "/hr/a.md"), ("sync", "/hr/b.md")):
        batch_id, _ = await planned_batch(path)
        before = len(mock.api())
        if run == "async":
            await kb.ingestion.batches(batch_id).start()
        else:
            await asyncio.to_thread(sync.ingestion.batches(batch_id).start)
        sent = mock.api()[before:]
        assert [(r["method"], str(r["path"])) for r in sent] == [("POST", f"/v3/knowledge-bases/{KB}/ingestion-batches/{batch_id}/start")], run
        assert "if-match" not in {k.lower() for k in sent[0]["headers"]}, f"{run}: no If-Match"
    # Given ifMatch: sent as it is.
    batch_id, etag = await planned_batch("/hr/c.md")
    before = len(mock.api())
    await kb.ingestion.batches(batch_id).start(if_match=etag)
    [start] = mock.api()[before:]
    assert {k.lower(): v for k, v in start["headers"].items()}["if-match"] == etag
    # A stale one: 412 PRECONDITION_FAILED.
    batch_id, _ = await planned_batch("/hr/d.md")
    err = await expect_error(kb.ingestion.batches(batch_id).start(if_match='"batch-stale"'))
    assert (type(err), err.status, err.code) == (PreconditionFailedError, 412, "PRECONDITION_FAILED")


@case("wait.snapshot-entry")
async def test_wait_snapshot_entry(mock: Mock, tmp_path: Path, case_id: str) -> None:
    from caitlyn.models import Document, Folder, IngestionBatch

    report = await client(mock).knowledge_bases(KB).ingestion.sync(folder_of(tmp_path, {"a.md": b"# A\n"}), folder="/hr/")
    batch_id = report.batch.id
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    # Each is done already, so the first connection's snapshot ends the wait, with the entry under the scope's filter
    # name, as the thing's type.
    akb, skb = client(mock).knowledge_bases(KB), sync.knowledge_bases(KB)
    waits: list[tuple[str, str, type[Any], Callable[[], Awaitable[Any]], Callable[[], Any]]] = [
        ("batch", batch_id, IngestionBatch, lambda: akb.ingestion.batches(batch_id).wait(timeout=10), lambda: skb.ingestion.batches(batch_id).wait(timeout=10)),
        ("document", "doc-0002", Document, lambda: akb.documents("doc-0002").wait(timeout=10), lambda: skb.documents("doc-0002").wait(timeout=10)),
        ("folder", "/policies/", Folder, lambda: akb.folders("/policies/").wait(timeout=10), lambda: skb.folders("/policies/").wait(timeout=10)),
    ]
    for filter, key, kind, on_async, on_sync in waits:
        for run in ("async", "sync"):
            before = len(watches(mock))
            got: Any = await on_async() if run == "async" else await asyncio.to_thread(on_sync)
            assert type(got) is kind, f"{run} {filter}: {type(got).__name__}"
            if filter == "folder":
                assert got.path == key and got.etag
            else:
                assert got.id == key and str(got.status) == ("succeeded" if filter == "batch" else "indexed")
                # A batch's or a document's wait returns its final read, with that read's metadata (section 16).
                assert got.response_metadata is not None and api_paths(mock)[-1][0] == "GET"
            [watch] = watches(mock)[before:]
            assert query_of(watch) == {filter: key}, "one connection, filtered by the scope's name for the thing"


@case("scope.download")
async def test_scope_download(mock: Mock, case_id: str) -> None:
    # GetDocumentDownload answers 200 {url, expiresAt}: the address comes back, and nothing is sent to it.
    content = await client(mock).knowledge_bases(KB).documents("doc-0001").download()
    assert content.url and content.expires_at is not None
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    assert sync.knowledge_bases(KB).documents("doc-0001").download().url == content.url
    paths = [str(r.get("path")) for r in mock.requests() if r.get("method")]
    assert paths == [f"/v3/knowledge-bases/{KB}/documents/doc-0001/download"] * 2, "no request to the address"


@case("core.content-redirect")
async def test_core_content_redirect(mock: Mock, case_id: str) -> None:
    # GetDocumentContent answers 302: core.documents.content treats it as its success and returns the address in its
    # Location, sending nothing to it, even through a caller's own HTTP client that would follow redirects.
    content_path = f"/v3/knowledge-bases/{KB}/documents/doc-0001/content"
    raw = await client(mock).core.documents.content(KB, "doc-0001")
    assert raw.location and raw.url == raw.location
    async with httpx.AsyncClient(follow_redirects=True) as following:
        again = await client(mock, http_client=following).core.documents.content(KB, "doc-0001")
    with httpx.Client(follow_redirects=True) as following_sync:
        sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base, http_client=following_sync)
        sync_raw = sync.core.documents.content(KB, "doc-0001")
    assert again.location == sync_raw.location == raw.location
    assert [str(r.get("path")) for r in mock.requests() if r.get("method")] == [content_path] * 3, "the address is never requested"


@case("send.text")
async def test_send_text(mock: Mock, case_id: str) -> None:
    c = client(mock)
    deltas: list[str] = []
    async with await c.conversations("c-1").send("How many days?") as stream:
        async for event in stream:
            if isinstance(event, TextDeltaEvent):
                deltas.append(event.delta)
    text = [t async for t in (await c.conversations("c-1").send("How many days?")).text()]
    assert text == deltas and text, "only the answer's text deltas, in order"
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    assert list(sync.conversations("c-1").send("How many days?").text()) == deltas


def uploads_for(mock: Mock, conversation_id: str) -> list[dict[str, Any]]:
    return [b for b in reservations(mock) if b.get("purpose") == {"conversationId": conversation_id}]


def sends(mock: Mock, conversation_id: str) -> list[dict[str, Any]]:
    return [json.loads(r["body"]) for r in mock.api() if r["method"] == "POST" and r["path"] == f"/v3/conversations/{conversation_id}/messages"]


@case("send.attachments")
async def test_send_attachments(mock: Mock, tmp_path: Path, case_id: str) -> None:
    c = client(mock)
    leave = tmp_path / "leave.pdf"
    leave.write_bytes(b"%PDF-1.7 leave form")
    already = await c.core.uploads.send(UploadFile.from_bytes(b"# Pay rates\n", name="pay.md"),
                                       purpose=caitlyn.UploadPurpose.model_validate({"conversationId": "c-1"}))
    stream = await c.conversations("c-1").send("Does this leave form match our policy?",
                                               attachments=[leave, UploadId(already.id), UploadFile.from_bytes(b"notes", name="notes.md")])
    text = [t async for t in stream.text()]
    assert text, "the same stream, and text() on it"
    made = uploads_for(mock, "c-1")
    assert [u["fileName"] for u in made] == ["pay.md", "leave.pdf", "notes.md"], "each file reserved for the conversation"
    [body] = sends(mock, "c-1")
    ids = [a["uploadId"] for a in body["attachments"]]
    assert len(ids) == 3 and ids[1] == already.id, "the caller's order, and an upload id as it is"
    # Each upload is used up by the message: sending the same files again uploads them again.
    await (await c.conversations("c-1").send("And this one?", attachments=[leave])).aclose()
    assert len(uploads_for(mock, "c-1")) == 4
    # A failed upload sends no message, and raises that file's error.
    mock.reset()
    mock.faults(status={"PutUpload": [{"status": 503, "retryAfter": 0}] * 3})
    err = await expect_error(c.conversations("c-2").send("Is this right?", attachments=[leave]))
    assert err.code == "UPLOAD_PUT_FAILED" and sends(mock, "c-2") == []
    # The synchronous client.
    mock.reset()
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    with sync.conversations("c-3").send("Read this", attachments=[str(leave)]) as s:
        s.final_message()
    assert len(uploads_for(mock, "c-3")) == 1 and len(sends(mock, "c-3")[0]["attachments"]) == 1


@case("send.eager")
async def test_send_eager(mock: Mock, case_id: str) -> None:
    c = client(mock)
    stream = await c.conversations("c-5").send("How much leave do part-time staff get?")
    sent = [r for r in mock.api() if r["method"] == "POST" and r["path"] == "/v3/conversations/c-5/messages"]
    assert len(sent) == 1, "the message is sent when send is called, before its stream is read"
    await stream.aclose()
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    dropped = sync.conversations("c-6").send("hi")
    assert len([r for r in mock.api() if r["path"] == "/v3/conversations/c-6/messages"]) == 1
    dropped.close()
    # Read, it gives the answer's text.
    text = "".join([t async for t in (await c.conversations("c-1").send("How many days?")).text()])
    assert text


@case("files.sources")
async def test_file_sources(mock: Mock, tmp_path: Path, case_id: str) -> None:
    data = b"Annual leave: 20 days.\n" * 100
    path = tmp_path / "leave.md"
    path.write_bytes(data)

    def chunks() -> Iterator[bytes]:
        for i in range(0, len(data), 100):
            yield data[i : i + 100]

    async def achunks() -> AsyncIterator[bytes]:
        for i in range(0, len(data), 100):
            yield data[i : i + 100]

    c = client(mock)
    for source in (path, UploadFile.from_path(path), UploadFile.from_bytes(data, name="leave.md"),
                   UploadFile.from_stream(chunks(), name="leave.md"), UploadFile.from_stream(achunks(), name="leave.md"),
                   UploadFile.from_stream(io.BytesIO(data), name="leave.md")):
        await c.core.uploads.send(source)
    bodies = reservations(mock)
    assert len(bodies) == 6
    want = {"fileName": "leave.md", "byteSize": len(data), "contentType": "text/markdown", "sha256": sha_b64(data)}
    for b in bodies:
        assert {k: b[k] for k in want} == want
    assert all(p["bodySha256"] == sha_b64(data) for p in puts(mock))
    # The synchronous client hashes the same way, and refuses an async stream.
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    sync.core.uploads.send(UploadFile.from_stream(chunks(), name="leave.md"))
    assert {k: reservations(mock)[-1][k] for k in want} == want
    with pytest.raises(TypeError, match="async"):
        sync.core.uploads.send(UploadFile.from_stream(achunks(), name="leave.md"))


@case("files.content-type")
async def test_file_content_type(mock: Mock, case_id: str) -> None:
    c = client(mock)
    for name, given in (("a.pdf", None), ("b.DOCX", None), ("c.md", None), ("d.unknownext", None), ("e", None), ("f.pdf", "text/plain")):
        await c.core.uploads.send(UploadFile.from_bytes(b"x", name=name, content_type=given))
    assert [b["contentType"] for b in reservations(mock)] == [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/markdown",
        "application/octet-stream",
        "application/octet-stream",
        "text/plain",
    ]
    # Every extension in the table every SDK shares, and no others.
    shared: dict[str, str] = json.loads((ROOT / "conformance/cases/content-types.json").read_text())["contentTypes"]
    for ext, content_type in shared.items():
        assert core_files.content_type_for(f"file.{ext}") == content_type, ext
    assert set(core_files.CONTENT_TYPES) == set(shared)


def spool_files() -> set[str]:
    return {p.name for p in Path(tempfile.gettempdir()).glob("caitlyn-upload-*")}


@case("files.spool")
async def test_file_spool(mock: Mock, case_id: str) -> None:
    data = os.urandom(9 * 1024 * 1024)
    before = spool_files()

    def chunks() -> Iterator[bytes]:
        for i in range(0, len(data), 1 << 20):
            yield data[i : i + (1 << 20)]

    mock.faults(reserveDelayMs=300)
    task = asyncio.create_task(client(mock).core.uploads.send(UploadFile.from_stream(chunks(), name="big.bin")))
    while not reservations(mock):
        await asyncio.sleep(0.02)
    during = spool_files() - before
    assert len(during) == 1, "a stream over 8 MiB is spooled to a temporary file"
    mode = (Path(tempfile.gettempdir()) / next(iter(during))).stat().st_mode & 0o777
    assert mode == 0o600
    await task
    [put] = puts(mock)
    assert (put["bodyLength"], put["bodySha256"]) == (len(data), sha_b64(data))
    assert spool_files() == before, "nothing is left on disk after the call"
    # Nor when the call fails.
    mock.faults(status={"CreateUpload": [{"status": 400}]})
    await expect_error(client(mock).core.uploads.send(UploadFile.from_stream(chunks(), name="big.bin")))
    assert spool_files() == before


@case("files.too-large")
async def test_file_too_large(mock: Mock, tmp_path: Path, case_id: str) -> None:
    big = tmp_path / "huge.bin"
    with big.open("wb") as f:
        f.truncate(2 * 1024 * 1024 * 1024 + 1)  # sparse: no bytes written
    c = client(mock)
    err = await expect_error(c.core.uploads.send(big))
    assert (err.status, err.code) == (0, "FILE_TOO_LARGE")
    with pytest.raises(CaitlynError) as info:
        UploadFile.from_stream(iter([b"x"]), name="s.bin", size=2 * 1024 * 1024 * 1024 + 1)
    assert info.value.code == "FILE_TOO_LARGE"
    exactly = tmp_path / "limit.bin"
    with exactly.open("wb") as f:
        f.truncate(2 * 1024 * 1024 * 1024)
    assert UploadFile.from_path(exactly).name == "limit.bin"  # 2 GB itself is allowed (not hashed here)
    assert mock.requests() == [], "nothing is sent"


@case("files.changed")
async def test_file_changed(mock: Mock, tmp_path: Path, case_id: str) -> None:
    f = tmp_path / "leave.pdf"
    f.write_bytes(b"%PDF-1.7 version one")
    mock.faults(reserveDelayMs=300)
    task = asyncio.create_task(client(mock).core.uploads.send(f))
    while not reservations(mock):
        await asyncio.sleep(0.02)
    f.write_bytes(b"%PDF-1.7 version two, longer")
    with pytest.raises(CaitlynError) as info:
        await task
    assert info.value.code == "FILE_CHANGED"
    assert puts(mock) == [], "its bytes are not sent"


@case("files.put-retry")
async def test_file_put_retry(mock: Mock, case_id: str) -> None:
    mock.faults(status={"PutUpload": [{"status": 503, "retryAfter": 0}]})
    data = b"%PDF-1.7 leave"
    up = await client(mock).core.uploads.send(UploadFile.from_bytes(data, name="leave.pdf"))
    first, second = puts(mock)
    assert first["headers"] == second["headers"]
    assert first["bodySha256"] == second["bodySha256"] == sha_b64(data)
    assert (await client(mock).core.uploads(up.id).get()).status == "received"
    mock.reset()
    mock.faults(status={"PutUpload": [{"status": 503, "retryAfter": 0}] * 3})
    err = await expect_error(client(mock).core.uploads.send(UploadFile.from_bytes(data, name="leave.pdf")))
    assert (err.status, err.code) == (503, "UPLOAD_PUT_FAILED")
    assert len(puts(mock)) == 3


@case("upload-target.top-level")
async def test_upload_target_top_level(mock: Mock, tmp_path: Path, case_id: str) -> None:
    f = tmp_path / "leave-policy.pdf"
    f.write_bytes(b"%PDF-1.7 leave policy")
    kb = client(mock).knowledge_bases(KB)
    made = await kb.documents.create(f, folder="/hr/")
    assert made.document.name == "leave-policy.pdf" and made.document.folder == "/hr/" and made.operation.id
    assert made.id == made.document.id, "it returns the new document's scope"
    reserve, create = [r for r in mock.api() if r["method"] == "POST"]
    upload_id = next(r for r in mock.requests() if r["method"] == "PUT")["path"].removeprefix("/__s3/")
    [put] = puts(mock)
    required = {"content-type": "application/pdf", "x-amz-checksum-sha256": sha_b64(f.read_bytes())}
    assert {k: v for k, v in put["headers"].items() if k in ("content-type", "x-amz-checksum-sha256", "authorization", "cookie", "idempotency-key")} == required
    assert json.loads(create["body"])["uploadId"] == upload_id
    assert reserve["path"] == "/v3/uploads" and create["path"] == f"/v3/knowledge-bases/{KB}/documents"
    with pytest.raises(TypeError):
        await kb.documents.create(folder="/hr/")  # pyright: ignore[reportCallIssue]  # neither a file nor an upload
    # doc.replace(file): a new version, the same way.
    replaced = await kb.documents("doc-0001").replace(UploadFile.from_bytes(b"%PDF-1.7 the 2027 edition", name="policy-1.pdf"))
    assert replaced.result.result == "created" and replaced.result.version.number == 2 and replaced.result.operation is not None
    version = [r for r in mock.api() if r["method"] == "POST"][-1]
    assert version["path"] == f"/v3/knowledge-bases/{KB}/documents/doc-0001/versions"
    assert json.loads(version["body"])["uploadId"] == puts(mock)[-1]["path"].removeprefix("/__s3/")
    assert "if-match" not in version["headers"]
    assert str((await replaced.wait(timeout=10)).status) == "indexed"


@case("upload-target.nested")
async def test_upload_target_nested(mock: Mock, case_id: str) -> None:
    from caitlyn import AgentAvatarInput, AgentIconName, AgentMarkInput, AvatarColour

    picture = UploadFile.from_bytes(PNG, name="avatar.png")
    avatar = AgentAvatarInput(colour=AvatarColour("sage"), mark=AgentMarkInput(picture_upload_id=picture))
    agent = await client(mock).agents.create("HR assistant", avatar=avatar)
    [reserve] = reservations(mock)
    assert reserve["purpose"] == {"agentAvatar": True} and reserve["contentType"] == "image/png"
    create = [r for r in mock.api() if r["method"] == "POST" and r["path"] == "/v3/agents"][-1]
    upload_id = puts(mock)[0]["path"].removeprefix("/__s3/")
    assert json.loads(create["body"])["avatar"] == {"colour": "sage", "mark": {"pictureUploadId": upload_id}}
    assert agent.avatar is not None
    assert avatar.mark is not None and avatar.mark.picture_upload_id is picture, "the caller's input is not changed"
    # Without a file, nothing is uploaded.
    before = len(reservations(mock))
    await client(mock).agents.create(name="Pay assistant", avatar=AgentAvatarInput(mark=AgentMarkInput(icon=AgentIconName("leaf"))))
    assert len(reservations(mock)) == before


# ------------------------------------------------------------------ the ingestion.sync helper (PROTOCOL.md 15)


def folder_of(tmp_path: Path, files: dict[str, bytes]) -> Path:
    root = tmp_path / "policies"
    for rel, data in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(data)
    return root


def forms(mock: Mock) -> list[dict[str, Any]]:
    return [r for r in mock.requests() if r.get("method") == "POST" and r.get("path") == "/__s3/"]


def calls(mock: Mock, suffix: str, method: str = "POST") -> list[dict[str, Any]]:
    return [r for r in mock.api() if r.get("method") == method and str(r["path"]).endswith(suffix)]


class Bodies(Interceptor):
    """The JSON body of every request, by operation (the mock's log leaves out bodies of 10,000 bytes or more)."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []

    def before_attempt(self, context: CallContext, request: httpx.Request) -> None:
        self.sent.append((context.operation.name, json.loads(request.content) if request.content else None))

    def of(self, operation: str) -> list[Any]:
        return [b for name, b in self.sent if name == operation]


def url_safe(sha: str) -> str:
    return sha.replace("+", "-").replace("/", "_").rstrip("=")


@case("sync.flow")
async def test_sync_flow(mock: Mock, tmp_path: Path, case_id: str) -> None:
    files = {"leave.pdf": b"%PDF-1.7 leave", "pay/rates.md": b"# Pay rates\n", "skip.tmp": b"temporary", "notes/draft.md": b"draft"}
    root = folder_of(tmp_path, files)
    (root / ".caitlynignore").write_text("# not for the knowledge base\nnotes\n")
    (root / "link.pdf").symlink_to(root / "leave.pdf")
    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", exclude=["*.tmp"])
    order = [(r.get("method"), str(r.get("path")).split("?")[0].rsplit("/", 1)[-1]) for r in mock.requests()]
    names = [n for _, n in order]
    assert names.index("ingestion-batches") < names.index("start") < names.index("") < names.index("complete-uploads")
    [create] = calls(mock, f"/v3/knowledge-bases/{KB}/ingestion-batches")
    body = json.loads(create["body"])
    assert body["start"] == "manual" and "awaitMoreItems" not in body and create["path"] == f"/v3/knowledge-bases/{KB}/ingestion-batches"
    assert [(i["path"], i["externalId"], i["sha256"]) for i in body["items"]] == [
        ("/hr/leave.pdf", "leave.pdf", sha_b64(files["leave.pdf"])),
        ("/hr/pay/rates.md", "pay/rates.md", sha_b64(files["pay/rates.md"])),
    ]
    listed = [r for r in mock.api() if r["method"] == "GET" and "filter[status][eq]=awaiting_upload" in urllib.parse.unquote(r["query"])]
    assert listed, "the items to upload are listed with filter[status][eq]=awaiting_upload"
    posted = forms(mock)
    assert len(posted) == 2
    for p in posted:
        parts = p["form"]
        names = [x["name"] for x in parts]
        assert names[-5:] == ["key", "Content-Type", "x-amz-checksum-algorithm", "x-amz-checksum-sha256", "file"]
        value = {x["name"]: x.get("value") for x in parts}
        assert value["x-amz-checksum-algorithm"] == "SHA256"
        assert value["x-amz-checksum-sha256"] == parts[-1]["sha256"]
        assert url_safe(parts[-1]["sha256"]) in str(value["key"])
    [complete] = calls(mock, "/complete-uploads")
    assert len(json.loads(complete["body"])["itemIds"]) == 2
    assert str(report.batch.status) == "succeeded"
    assert [(i.path, str(i.status), i.document_id is not None, i.version) for i in report.items] == [
        ("/hr/leave.pdf", "indexed", True, 1),
        ("/hr/pay/rates.md", "indexed", True, 1),
    ]


@case("sync.many-items")
async def test_sync_many_items(mock: Mock, case_id: str) -> None:
    files = [SyncFile(f"f{n:05}.md", UploadFile.from_bytes(f"file {n}".encode(), name=f"f{n:05}.md")) for n in range(10_050)]
    bodies = Bodies()
    plans: list[Any] = []

    def confirm(plan: Any) -> bool:
        plans.append(plan)
        return False  # the shape of the calls is the case; stop before 10,050 uploads

    declined = await expect_error(client(mock, interceptors=[bodies]).knowledge_bases(KB).ingestion.sync(files, folder="/bulk/", confirm=confirm))
    assert declined.code == "CANCELLED"
    [create] = bodies.of("CreateIngestionBatch")
    assert len(create["items"]) == 10_000 and create["awaitMoreItems"] is True and create["start"] == "manual"
    assert [(len(b["items"]), b.get("last")) for b in bodies.of("BatchCreateIngestionBatchItems")] == [(50, True)]
    assert bodies.of("UpdateIngestionBatch") == [], "the last addItems ends the draft"
    [plan] = plans
    assert len(plan.items) == 10_050 and plan.estimate is not None and plan.estimate.documents == 10_050
    assert [len(b["documents"]) for b in bodies.of("EstimateIngestion")] == [10_000, 50]


@case("sync.concurrency")
async def test_sync_concurrency(mock: Mock, tmp_path: Path, case_id: str) -> None:
    mock.faults(uploadDelayMs=150)
    root = folder_of(tmp_path, {f"f{n}.md": f"file {n}".encode() for n in range(14)})
    await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/")
    assert mock.uploads()["maxInFlight"] == 6
    mock.reset()
    mock.faults(uploadDelayMs=100)
    await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr2/", concurrency=2)
    assert mock.uploads()["maxInFlight"] == 2


@case("sync.complete-groups")
async def test_sync_complete_groups(mock: Mock, case_id: str) -> None:
    files = [SyncFile(f"f{n:03}.md", UploadFile.from_bytes(f"file {n}".encode(), name=f"f{n:03}.md")) for n in range(250)]
    await client(mock).knowledge_bases(KB).ingestion.sync(files, folder="/many/")
    sizes = [len(json.loads(r["body"])["itemIds"]) for r in calls(mock, "/complete-uploads")]
    assert max(sizes) <= 100 and sum(sizes) == 250


@case("sync.policy-renewal")
async def test_sync_policy_renewal(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b"})
    # Start's policy lasts a second, so its renewal margin is half a second; each file takes a second to arrive, one at a
    # time. The first goes with Start's policy; it is renewed before the second goes.
    mock.faults(policySeconds=1, uploadDelayMs=1000)
    await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", concurrency=1)
    order = [("upload" if r.get("path") == "/__s3/" else "renew") for r in mock.requests()
             if r.get("method") == "POST" and (r.get("path") == "/__s3/" or str(r.get("path")).endswith("/upload-policies"))]
    assert order == ["upload", "renew", "upload"], f"{order}: renewed between the uploads"
    mock.reset()
    mock.faults(startPolicyExpired=True)  # 403 "Policy expired": renewed once, and that file sent again
    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", concurrency=1)
    assert len(calls(mock, "/upload-policies")) == 1
    assert len(forms(mock)) == 3
    assert str(report.batch.status) == "succeeded"


@case("sync.checksum-mismatch")
async def test_sync_checksum_mismatch(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b"})
    mock.faults(checksumMismatch={"/hr/a.md": 1})
    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/")
    sent = [next(x["value"] for x in p["form"] if x["name"] == "key") for p in forms(mock)]
    assert len(sent) == 3 and len(set(sent)) == 2
    completed = [json.loads(r["body"])["itemIds"] for r in calls(mock, "/complete-uploads")]
    assert len(completed) == 2 and len(completed[1]) == 1
    assert all(str(i.status) == "indexed" for i in report.items)


@case("sync.resolve")
async def test_sync_resolve(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b"})
    mock.faults(planConflicts={"/hr/a.md": "duplicate_path"})
    seen: list[str] = []

    def resolver(items: list[Any]) -> dict[str, str]:
        seen.extend(str(i.path) for i in items)
        return {str(i.id): "overwrite" for i in items}

    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", resolver=resolver)
    assert seen == ["/hr/a.md"]
    [patch] = [r for r in mock.api() if r["method"] == "PATCH"]
    assert json.loads(patch["body"]) == {"resolution": "overwrite"} and patch["headers"]["if-match"]
    assert str(report.batch.status) == "succeeded"
    # With no resolver: INGESTION_BATCH_UNRESOLVED, and the batch is left planned.
    mock.reset()
    mock.faults(planConflicts={"/hr/a.md": "duplicate_path"})
    c = client(mock)
    err = await expect_error(c.knowledge_bases(KB).ingestion.sync(root, folder="/hr/"))
    assert (err.status, err.code) == (0, "INGESTION_BATCH_UNRESOLVED")
    batch_id = json.loads(calls(mock, f"/v3/knowledge-bases/{KB}/ingestion-batches")[0]["body"]) and mock.api()[0]
    [batch] = [b async for b in c.knowledge_bases(KB).ingestion.batches.list()]
    assert str(batch.status) == "planned" and batch_id
    assert not calls(mock, "/start")


@case("sync.confirm")
async def test_sync_confirm(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"a.md": b"a"})
    plans: list[Any] = []

    async def confirm(plan: Any) -> bool:
        plans.append(plan)
        return False

    # Declining the plan cancels the batch and ends the call with CANCELLED: an ordinary error, which `except
    # Exception` catches, never the language's cancellation.
    caught: Exception | None = None
    try:
        await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", confirm=confirm)
    except Exception as e:  # noqa: BLE001 - the point: an ordinary handler catches it
        caught = e
    assert type(caught) is CaitlynError and (caught.status, caught.code) == (0, "CANCELLED")
    assert caught.report is not None and [str(i.path) for i in caught.report.items] == ["/hr/a.md"]
    [plan] = plans
    assert str(plan.batch.status) == "planned" and [str(i.outcome) for i in plan.items] == ["new"]
    assert len(calls(mock, "/cancel")) == 1 and not calls(mock, "/start") and not forms(mock)
    [batch] = [b async for b in client(mock).knowledge_bases(KB).ingestion.batches.list()]
    assert str(batch.status) == "cancelled"
    # The same on the synchronous client: CaitlynError, not KeyboardInterrupt.
    mock.reset()
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    with pytest.raises(CaitlynError) as sync_declined:
        await asyncio.to_thread(sync.knowledge_bases(KB).ingestion.sync, root, folder="/hr/", confirm=lambda plan: False)
    assert sync_declined.value.code == "CANCELLED" and sync_declined.value.report is not None
    assert len(calls(mock, "/cancel")) == 1
    # True carries on.
    mock.reset()
    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", confirm=lambda plan: True)
    assert str(report.batch.status) == "succeeded"


@case("sync.remove-missing")
async def test_sync_remove_missing(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"policy-1.pdf": b"%PDF-1.7 policy one, again", "new.md": b"new"})
    await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/policies/", remove_missing=True)
    listed = [r for r in mock.api() if r["method"] == "GET" and r["path"] == "/v3/knowledge-bases/KB4T7YQ2WL/documents"]
    assert listed and "filter[folder][eq]=/policies/" in urllib.parse.unquote(listed[0]["query"])
    items = json.loads(calls(mock, f"/v3/knowledge-bases/{KB}/ingestion-batches")[0]["body"])["items"]
    removes = sorted(i["path"] for i in items if i.get("action") == "remove")
    assert removes == [f"/policies/policy-{n}.pdf" for n in range(2, 8)]


@case("sync.progress")
async def test_sync_progress(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"a.md": b"aaaa", "b.md": b"bb"})
    mock.faults(ingestReads=2)
    seen: list[IngestionProgress[Any]] = []
    finished: list[str] = []
    await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", on_progress=seen.append, on_item=lambda i: finished.append(str(i.path))
    )
    phases = [p.phase for p in seen]
    distinct = [p for n, p in enumerate(phases) if n == 0 or phases[n - 1] != p]
    # The flow's own order (PROTOCOL.md 15): uploads happen after Start, so after planned.
    assert distinct == ["checksum", "planning", "planned", "upload", "queued", "processing", "succeeded"]
    assert [(p.done, p.total) for p in seen if p.phase == "checksum"][-1] == (2, 2)
    assert [(p.done, p.total) for p in seen if p.phase == "upload"][-1] == (6, 6), "upload counts bytes"
    assert sorted(finished) == ["/hr/a.md", "/hr/b.md"]


def aborted(mock: Mock) -> int:
    return len([r for r in mock.requests() if r.get("event") == "upload-aborted"])


async def interrupted(call: Callable[[], object], mock: Mock, uploads: int = 6) -> BaseException:
    """Runs ``call`` (a synchronous client's) in a thread of its own and raises KeyboardInterrupt in that thread, as
    Ctrl-C does, once ``uploads`` form uploads have started; returns what the call raised."""
    outcome: dict[str, BaseException] = {}

    def run() -> None:
        try:
            call()
        except BaseException as e:  # noqa: BLE001 - kept for the test to look at
            outcome["error"] = e

    worker = threading.Thread(target=run)
    worker.start()
    while len(forms(mock)) < uploads:
        await asyncio.sleep(0.02)
    assert worker.ident is not None
    ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(worker.ident), ctypes.py_object(KeyboardInterrupt))
    return await uploads_dropped(mock, uploads, lambda: asyncio.to_thread(worker.join), outcome)


async def uploads_dropped(mock: Mock, uploads: int, finish: Callable[[], Awaitable[object]], outcome: dict[str, BaseException]) -> BaseException:
    """Every upload in flight is dropped: the mock notes each one aborted within a second (each was held 1 s from
    before the interrupt), and no new upload starts."""
    deadline = time.monotonic() + 1
    while aborted(mock) < uploads:
        assert time.monotonic() < deadline, f"{aborted(mock)} of {uploads} uploads in flight dropped within a second"
        await asyncio.sleep(0.02)
    await finish()
    assert len(forms(mock)) == uploads, "no upload starts after the interrupt"
    assert mock.uploads()["objects"] == []
    return outcome["error"]


@case("sync.cancel")
async def test_sync_cancel(mock: Mock, tmp_path: Path, case_id: str) -> None:
    # policy-1.pdf has the bytes the knowledge base's policy-1.pdf has: unchanged, so skipped (finished) at Start.
    root = folder_of(tmp_path, {"policy-1.pdf": b"doc1", **{f"f{n:02}.md": f"file {n}".encode() for n in range(12)}})
    # Every upload is held until the client lets go of it, so all six in flight are still in flight when the cancel lands.
    mock.faults(holdUploadsAfter=0)
    finished: list[str] = []
    task = asyncio.create_task(client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/policies/", cancel_ingestion=True, on_item=lambda i: finished.append(f"{i.path} {i.status}")))
    while len(forms(mock)) < 6:
        await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    deadline = time.monotonic() + 5
    while aborted(mock) < 6 and time.monotonic() < deadline:  # the mock notes each one as it sees its connection close
        await asyncio.sleep(0.02)
    assert len(forms(mock)) == 6, "no upload starts after the cancel"
    assert aborted(mock) == 6 and mock.uploads()["objects"] == []
    [cancel] = calls(mock, "/cancel")
    assert json.loads(cancel["body"]) == {"stopRunning": True}
    assert finished == ["/policies/policy-1.pdf skipped"], "every item finished before the cancel reached on_item"
    # The synchronous client, Ctrl-C: the uploads in flight are dropped at once too; SyncInterrupted carries the report.
    mock.reset()
    mock.faults(holdUploadsAfter=0)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    error = await interrupted(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/policies/", cancel_ingestion=True), mock)
    assert isinstance(error, SyncInterrupted) and error.report is not None and len(error.report.items) == 13, repr(error)
    [cancel] = calls(mock, "/cancel")
    assert json.loads(cancel["body"]) == {"stopRunning": True}


FINAL_ITEMS = {"indexed", "skipped", "moved", "updated", "removed", "cancelled", "failed"}


@case("sync.on-item-once")
async def test_sync_on_item_once(mock: Mock, tmp_path: Path, case_id: str) -> None:
    # policy-1.pdf is unchanged (skipped at Start), a.md and c.md are ingested over a few reads, b.md's upload always fails.
    root = folder_of(tmp_path, {"policy-1.pdf": b"doc1", "a.md": b"a", "b.md": b"b", "c.md": b"c"})
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    for use_sync in (False, True):
        mock.reset()
        mock.faults(failUploads={"/policies/b.md": True}, ingestReads=3)
        calls_: list[tuple[str, str, str]] = []

        def on_item(i: Any) -> None:
            calls_.append((str(i.path), str(i.status), str(i.failure_code or "")))

        if use_sync:
            await asyncio.to_thread(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/policies/", on_item=on_item))
        else:
            await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/policies/", on_item=on_item)
        paths = [p for p, _, _ in calls_]
        assert sorted(paths) == ["/policies/a.md", "/policies/b.md", "/policies/c.md", "/policies/policy-1.pdf"], "once per item"
        assert all(status in FINAL_ITEMS for _, status, _ in calls_), "only at a final status, never when an upload is accepted"
        assert ("/policies/b.md", "failed", "UPLOAD_FAILED") in calls_
        assert paths.index("/policies/b.md") < paths.index("/policies/a.md"), "a failed upload reaches it at once"


@case("sync.cancel-report")
async def test_sync_cancel_report(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"policy-1.pdf": b"doc1", **{f"f{n:02}.md": f"file {n}".encode() for n in range(12)}})
    mock.faults(uploadDelayMs=1000)
    finished: list[str] = []
    task = asyncio.create_task(client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/policies/", on_item=lambda i: finished.append(str(i.path))))
    while len(forms(mock)) < 6:
        await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError) as info:
        await task
    assert isinstance(info.value, SyncCancelledError), "the language's own cancellation, carrying the report"
    report = info.value.report
    assert len(report.items) == 13, "every item, including those not yet final"
    statuses = {str(i.path): str(i.status) for i in report.items}
    assert statuses["/policies/policy-1.pdf"] == "skipped" and statuses["/policies/f00.md"] == "awaiting_upload", "each with its last status"
    assert report.batch.counts is not None
    assert finished == ["/policies/policy-1.pdf"], "on_item had only items final before the cancellation"
    await asyncio.sleep(1.1)
    assert finished == ["/policies/policy-1.pdf"], "and is never called after the cancellation error"
    # The synchronous client, Ctrl-C: SyncInterrupted, a KeyboardInterrupt with the report. The interrupt is raised in
    # the calling thread as Ctrl-C raises it, once the uploads have started.
    mock.reset()
    mock.faults(uploadDelayMs=1000)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    stopped = await interrupted(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/policies/"), mock)
    assert isinstance(stopped, SyncInterrupted) and stopped.report is not None, repr(stopped.__cause__)
    assert len(stopped.report.items) == 13
    # A declined confirm is neither kind of cancellation: CANCELLED with the report ([sync.confirm]).
    mock.reset()
    declined = await expect_error(client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/policies/", confirm=lambda plan: False))
    assert declined.code == "CANCELLED" and declined.report is not None and len(declined.report.items) == 13


def assert_report_shape(report: Any, items: int) -> None:
    """batch (as reading the batch gives it, with status and counts) and items (as listing them gives them), only."""
    assert {f.name for f in dataclasses.fields(report)} == {"batch", "items"}
    assert isinstance(report.batch, caitlyn.IngestionBatch) and report.batch.status and report.batch.counts is not None
    assert len(report.items) == items
    for i in report.items:
        assert isinstance(i, caitlyn.IngestionBatchItem)
        for attribute in ("outcome", "resolution", "status", "document_id", "version", "failure_code"):
            assert hasattr(i, attribute), attribute


@case("sync.report-shape")
async def test_sync_report_shape(mock: Mock, tmp_path: Path, case_id: str) -> None:
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b"})
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    # A finished sync, on both clients.
    assert_report_shape(await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/"), 2)
    mock.reset()
    assert_report_shape(await asyncio.to_thread(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/hr/")), 2)
    # A declined confirm's report, on both clients.
    mock.reset()
    declined = await expect_error(client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", confirm=lambda plan: False))
    assert_report_shape(declined.report, 2)
    mock.reset()
    with pytest.raises(CaitlynError) as sync_declined:
        await asyncio.to_thread(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/hr/", confirm=lambda plan: False))
    assert_report_shape(sync_declined.value.report, 2)
    # A cancellation's report (the async client's cancelled task; Ctrl-C's is [sync.cancel-report]).
    mock.reset()
    mock.faults(uploadDelayMs=1000)
    task = asyncio.create_task(client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/"))
    while len(forms(mock)) < 1:
        await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(SyncCancelledError) as cancelled:
        await task
    assert_report_shape(cancelled.value.report, 2)


@case("sync.estimate-many")
async def test_sync_estimate_many(mock: Mock, tmp_path: Path, case_id: str) -> None:
    # EstimateIngestion takes at most 10,000 documents a call. The core's private _estimate_per_call (not part of
    # sync()) is 2 here, so five files need three calls.
    root = folder_of(tmp_path, {f"f{n}.md": b"x" * (100 * (n + 1)) for n in range(5)})
    bodies = Bodies()
    c = client(mock, interceptors=[bodies])
    api = operations.SYNC_API
    core = caitlyn_core.AsyncHelperCore(c._core)  # pyright: ignore[reportPrivateUsage]
    plan = await core_sync.sync_estimate_async(core, api, api.batch, api.item, api.estimate_result, KB, root, folder="/many/",
                                               _estimate_per_call=2)
    sent = bodies.of("EstimateIngestion")
    assert [len(b["documents"]) for b in sent] == [2, 2, 1], "in calls of at most the limit"
    assert [d["name"] for b in sent for d in b["documents"]] == [f"f{n}.md" for n in range(5)], "in order"
    parts = [(await c._core.request(operations.ESTIMATE_INGESTION, {"knowledge_base_id": KB, "documents": b["documents"]},  # pyright: ignore[reportPrivateUsage]
                                    caitlyn_core.CaitlynResult)).raw for b in sent]
    total = cast(Any, plan.estimate)
    assert total is not None
    assert total.documents == sum(p["documents"] for p in parts) == 5
    assert total.duration_seconds.low == sum(p["durationSeconds"]["low"] for p in parts)
    assert total.duration_seconds.high == sum(p["durationSeconds"]["high"] for p in parts)
    if all("cost" in p for p in parts):
        assert total.cost is not None and abs(total.cost.high - sum(p["cost"]["high"] for p in parts)) < 1e-9
    else:
        assert total.cost is None
    assert "details" not in total.raw, "details are left out of a total"
    # confirm sees the same total.
    mock.reset()
    seen: list[Any] = []
    declined = await expect_error(core_sync.sync_async(core, api, api.batch, api.item, api.estimate_result, KB, root, folder="/many/",
                                                       confirm=lambda p: seen.append(p) is not None, _estimate_per_call=2))
    assert declined.code == "CANCELLED" and seen[0].estimate.documents == 5
    assert seen[0].estimate.duration_seconds.high == total.duration_seconds.high
    assert "_estimate_per_call" not in inspect.signature(c.knowledge_bases(KB).ingestion.sync).parameters, "not part of sync()"


# The rules of PROTOCOL.md 15 at app !2061 b12fd86f8f and 634c4927b0, ahead of their case ids.


async def test_sync_upload_failed(mock: Mock, tmp_path: Path) -> None:
    """An upload that still fails after its retries fails only its item: UPLOAD_FAILED through on_item and the report,
    never sent to Complete; the other uploads carry on and sync returns."""
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b", "c.md": b"c"})
    mock.faults(failUploads={"/hr/a.md": True})  # every upload of a.md answers 500
    finished: dict[str, str] = {}
    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", on_item=lambda i: finished.__setitem__(str(i.path), f"{i.status} {i.failure_code or ''}".strip())
    )
    assert finished == {"/hr/a.md": "failed UPLOAD_FAILED", "/hr/b.md": "indexed", "/hr/c.md": "indexed"}
    by_path = {str(i.path): i for i in report.items}
    assert (str(by_path["/hr/a.md"].status), by_path["/hr/a.md"].failure_code) == ("failed", "UPLOAD_FAILED")
    failed_id = by_path["/hr/a.md"].id
    completed = [x for r in calls(mock, "/complete-uploads") for x in json.loads(r["body"])["itemIds"]]
    assert failed_id not in completed and len(completed) == 2
    assert len(forms(mock)) == 5


@case("sync.cancelled-item")
async def test_sync_cancelled_item(mock: Mock, tmp_path: Path, case_id: str) -> None:
    # The mock's cancelItems: /hr/a.pdf ends cancelled while it is being ingested (its document was deleted).
    root = folder_of(tmp_path, {"a.pdf": b"%PDF-1.7 a", "b.md": b"b"})
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    for use_sync in (False, True):
        mock.reset()
        mock.faults(cancelItems={"/hr/a.pdf": True})
        finished: list[str] = []
        seen: list[IngestionProgress[Any]] = []

        def on_item(i: Any) -> None:
            finished.append(f"{i.path} {i.status} {i.failure_code or ''}".strip())

        if use_sync:
            report = await asyncio.to_thread(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/hr/", on_item=on_item, on_progress=seen.append))
        else:
            report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", on_item=on_item, on_progress=seen.append)
        assert finished.count("/hr/a.pdf cancelled") == 1, "reported once, as cancelled, with no failure code"
        assert "/hr/b.md indexed" in finished
        assert str(report.batch.status) == "succeeded"
        by_path = {str(i.path): i for i in report.items}
        assert str(by_path["/hr/a.pdf"].status) == "cancelled" and by_path["/hr/a.pdf"].failure_code is None
        assert len(forms(mock)) == 2, "each file is uploaded once: a cancelled item is never uploaded again"
        completed = [x for r in calls(mock, "/complete-uploads") for x in json.loads(r["body"])["itemIds"]]
        assert completed.count(by_path["/hr/a.pdf"].id) == 1, "nor completed again"
        assert seen[-1].phase == "succeeded" and seen[-1].done == seen[-1].total == 2, "it counts as done"


@case("sync.plan-failed")
async def test_sync_plan_failed(mock: Mock, case_id: str, tmp_path: Path) -> None:
    """Planning that ends the batch failed makes sync raise the batch's own failure (its code and message); nothing
    is started or uploaded."""
    root = folder_of(tmp_path, {"a.md": b"a"})
    policy = IngestionPolicy.model_validate({"onConflict": {"default": "fail"}})
    for faults, code, says in (
        ({"planConflicts": {"/hr/a.md": "duplicate_path"}}, "conflict_policy_fail", "policy rule is `fail`"),
        ({"planFails": True}, "planning_failed", "Planning could not finish"),
    ):
        mock.reset()
        mock.faults(**faults)
        err = await expect_error(client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", policy=policy))
        assert (err.status, err.code) == (0, code)
        assert says in str(err)
        assert not calls(mock, "/start") and not forms(mock)


# ------------------------------------------------------------------ batch.upload and batch.upload.estimate (PROTOCOL.md 15)

from caitlyn._client import AsyncBatchScope  # noqa: E402  # pyright: ignore[reportPrivateUsage]
from caitlyn.models import IngestionItemAction  # noqa: E402


def batch_item(path: str, data: bytes, **kw: Any) -> IngestionItemInput:
    """An item for the file ``data``, at ``path``."""
    return IngestionItemInput(path=path, sha256=sha_b64(data), byte_size=len(data), content_type=caitlyn_core.content_type_for(path), **kw)


def by_path(contents: dict[str, bytes]) -> dict[str, UploadFile]:
    return {p: UploadFile.from_bytes(d, name=p.rsplit("/", 1)[-1]) for p, d in contents.items()}


async def built_batch(c: AsyncCaitlyn, contents: dict[str, bytes], *, start: bool = True, extra: list[IngestionItemInput] | None = None,
                      **create: Any) -> AsyncBatchScope:
    """A batch built by hand from ``contents``, planned and (by default) started; its scope."""
    kb = c.knowledge_bases(KB)
    made = await kb.ingestion.batches.create(start="manual", items=[*(batch_item(p, d) for p, d in contents.items()), *(extra or [])], **create)
    await made.planned(timeout=10)
    if start:
        await made.start()
    return kb.ingestion.batches(made.id)


def form_keys(mock: Mock) -> list[str]:
    return [str(next(x["value"] for x in p["form"] if x["name"] == "key")) for p in forms(mock)]


def sent_for(mock: Mock, data: bytes) -> int:
    """Form POSTs of the file ``data``: its object key carries its checksum."""
    return sum(url_safe(sha_b64(data)) in k for k in form_keys(mock))


def completed_ids(mock: Mock) -> list[str]:
    return [x for r in calls(mock, "/complete-uploads") for x in json.loads(r["body"])["itemIds"]]


@case("batch-estimate.priced-items")
async def test_batch_estimate_priced_items(mock: Mock, case_id: str) -> None:
    # add (new), new_version (changed), overwrite (a conflict whose rule is overwrite); skip (unchanged), remove, and
    # update_metadata (resolved by hand) are not priced. The mock plans no move.
    mock.faults(planConflicts={"/hr/clash.md": "duplicate_path"})
    bodies = Bodies()
    c = client(mock, interceptors=[bodies])
    batch = await built_batch(c, {"/hr/new.md": b"new", "/policies/policy-1.pdf": b"changed", "/policies/policy-2.pdf": b"doc2",
                                  "/policies/policy-4.pdf": b"doc4", "/hr/clash.md": b"clash"}, start=False,
                              extra=[IngestionItemInput(action=IngestionItemAction.REMOVE, path="/policies/policy-5.pdf")],
                              policy={"onConflict": {"default": "overwrite"}})
    items = {str(i.path): i async for i in batch.items.list()}
    await batch.items(items["/policies/policy-4.pdf"].id).resolve("update_metadata", if_match=items["/policies/policy-4.pdf"].etag)
    resolutions = {str(i.path): str(i.resolution) async for i in batch.items.list()}
    assert resolutions == {"/hr/new.md": "add", "/policies/policy-1.pdf": "new_version", "/policies/policy-2.pdf": "skip",
                           "/policies/policy-4.pdf": "update_metadata", "/hr/clash.md": "overwrite", "/policies/policy-5.pdf": "remove"}
    await batch.upload.estimate()
    [sent] = bodies.of("EstimateIngestion")
    assert sorted(d["name"] for d in sent["documents"]) == ["clash.md", "new.md", "policy-1.pdf"]


@case("sync.estimate-unresolved")
async def test_sync_estimate_unresolved(mock: Mock, tmp_path: Path, case_id: str) -> None:
    # a.md is a conflict the policy leaves unresolved; b.md is new (add); policy-2.pdf is unchanged (skip).
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b", "policy-2.pdf": b"doc2"})
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    for use_sync in (False, True):
        mock.reset()
        mock.faults(planConflicts={"/policies/a.md": "duplicate_path"})
        order: list[str] = []
        seen: list[Any] = []

        def confirm(plan: Any, order: list[str] = order, seen: list[Any] = seen) -> bool:
            order.append("confirm")
            seen.append(plan)
            return True

        def resolver(items: list[Any], order: list[str] = order) -> dict[str, str]:
            order.append("resolver")
            return {i.id: "skip" for i in items}

        if use_sync:
            await asyncio.to_thread(lambda: sync.knowledge_bases(KB).ingestion.sync(root, folder="/policies/", confirm=confirm, resolver=resolver))  # noqa: B023
        else:
            await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/policies/", confirm=confirm, resolver=resolver)
        assert order == ["confirm", "resolver"], "confirm sees the estimate before the resolver runs"
        [plan] = seen
        assert {str(i.path): str(i.resolution) for i in plan.items} == {"/policies/a.md": "unresolved", "/policies/b.md": "add", "/policies/policy-2.pdf": "skip"}
        assert plan.estimate is not None and plan.estimate.documents == 2, "the unresolved conflict is priced, the skip is not"
    # batch.upload.estimate prices the same items, on both clients.
    mock.reset()
    mock.faults(planConflicts={"/policies/a.md": "duplicate_path"})
    bodies = Bodies()
    batch = await built_batch(client(mock, interceptors=[bodies]), {"/policies/a.md": b"a", "/policies/b.md": b"b", "/policies/policy-2.pdf": b"doc2"}, start=False)
    assert (await batch.upload.estimate()).documents == 2
    [sent] = bodies.of("EstimateIngestion")
    assert sorted(d["name"] for d in sent["documents"]) == ["a.md", "b.md"]
    assert (await asyncio.to_thread(sync.knowledge_bases(KB).ingestion.batches(batch.id).upload.estimate)).documents == 2


@case("batch-estimate.from-items")
async def test_batch_estimate_from_items(mock: Mock, case_id: str) -> None:
    bodies = Bodies()
    c = client(mock, interceptors=[bodies])
    batch = await built_batch(c, {"/hr/a.md": b"a", "/hr/pay/rates.pdf": b"%PDF rates"}, start=False)
    estimate = await batch.upload.estimate()
    [sent] = bodies.of("EstimateIngestion")
    assert sent["documents"] == [{"name": "a.md", "contentType": "text/markdown", "byteSize": 1},
                                 {"name": "rates.pdf", "contentType": "application/pdf", "byteSize": 10}]
    assert type(estimate).__name__ == "EstimateIngestionResult" and estimate.documents == 2
    # The synchronous client's.
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    assert (await asyncio.to_thread(sync.knowledge_bases(KB).ingestion.batches(batch.id).upload.estimate)).documents == 2


@case("batch-estimate.from-files")
async def test_batch_estimate_from_files(mock: Mock, monkeypatch: pytest.MonkeyPatch, case_id: str) -> None:
    from caitlyn.models import IngestionHints

    bodies = Bodies()
    c = client(mock, interceptors=[bodies])
    batch = await built_batch(c, {"/hr/a.md": b"a", "/hr/b.md": b"bb", "/policies/policy-2.pdf": b"doc2"}, start=False)
    read: list[bytes] = []

    def chunks() -> Iterator[bytes]:
        read.append(b"bb")
        yield b"bb"

    files: dict[str, caitlyn_core.FileInput] = {
        "/hr/a.md": UploadFile.from_bytes(b"a", name="a-local.md", hints=IngestionHints(pages=3, characters=1200)),
        "hr/b.md": UploadFile.from_stream(chunks(), name="b.md", size=2),  # no hints given; its bytes never read
        "/policies/policy-2.pdf": UploadFile.from_bytes(b"doc2", name="policy-2.pdf", hints={"pages": 9}),  # skipped: not priced
        "/hr/elsewhere.md": UploadFile.from_bytes(b"e", name="elsewhere.md", hints={"pages": 1}),  # matches no item
    }

    def no_hashing(*_: object) -> None:
        raise AssertionError("an estimate hashes nothing")

    monkeypatch.setattr(core_files.hashlib, "sha256", no_hashing)
    await batch.upload.estimate(files)
    monkeypatch.undo()
    [sent] = bodies.of("EstimateIngestion")
    assert sent["documents"] == [{"name": "a-local.md", "contentType": "text/markdown", "byteSize": 1, "hints": {"pages": 3, "characters": 1200}},
                                 {"name": "b.md", "contentType": "text/markdown", "byteSize": 2}]
    assert read == [], "no content read beyond the size"


@case("batch-estimate.draft")
async def test_batch_estimate_draft(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    made = await kb.ingestion.batches.create(start="manual", items=[batch_item("/hr/a.md", b"a")], await_more_items=True)
    assert str((await made.get()).status) == "draft"
    for estimate in (kb.ingestion.batches(made.id).upload.estimate(),
                     asyncio.to_thread(Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
                                       .knowledge_bases(KB).ingestion.batches(made.id).upload.estimate)):
        before = len(mock.api())
        err = await expect_error(estimate)
        assert (type(err), err.status, err.code) == (CaitlynError, 0, "INGESTION_BATCH_NOT_PLANNED")
        assert [r["method"] for r in mock.api()[before:]] == ["GET"], "nothing sent but the batch's read: no retry, no estimate"


@case("batch-estimate.planning")
async def test_batch_estimate_planning(mock: Mock, case_id: str) -> None:
    mock.faults(planningReads=3)
    bodies = Bodies()
    kb = client(mock, interceptors=[bodies]).knowledge_bases(KB)
    made = await kb.ingestion.batches.create(start="manual", items=[batch_item("/hr/a.md", b"a"), batch_item("/hr/b.md", b"b")])
    assert str((await made.get()).status) == "planning"
    estimate = await kb.ingestion.batches(made.id).upload.estimate(timeout=10)
    assert str((await made.get()).status) == "planned" and estimate.documents == 2
    assert len(bodies.of("EstimateIngestion")) == 1 and watches(mock), "waited through the batch's watch, then priced"


@case("batch-estimate.nothing-to-price")
async def test_batch_estimate_nothing_to_price(mock: Mock, case_id: str) -> None:
    bodies = Bodies()
    batch = await built_batch(client(mock, interceptors=[bodies]), {"/policies/policy-2.pdf": b"doc2"}, start=False)
    estimate = await batch.upload.estimate(by_path({"/policies/policy-2.pdf": b"doc2"}))
    assert (estimate.documents, estimate.cost) == (0, None)
    assert bodies.of("EstimateIngestion") == [], "no call sent"


@case("batch-estimate.many")
async def test_batch_estimate_many(mock: Mock, case_id: str) -> None:
    # The core's private _estimate_per_call (not part of the method) is 2 here: five items in three calls, added as
    # sync.estimate-many adds them.
    bodies = Bodies()
    c = client(mock, interceptors=[bodies])
    batch = await built_batch(c, {f"/many/f{n}.md": b"x" * (100 * (n + 1)) for n in range(5)}, start=False)
    api = operations.SYNC_API
    core = caitlyn_core.AsyncHelperCore(c._core)  # pyright: ignore[reportPrivateUsage]
    total: Any = await core_sync.batch_upload_estimate_async(core, api, api.batch, api.item, api.estimate_result, KB, batch.id, _estimate_per_call=2)
    sent = bodies.of("EstimateIngestion")
    assert [len(b["documents"]) for b in sent] == [2, 2, 1]
    assert [d["name"] for b in sent for d in b["documents"]] == [f"f{n}.md" for n in range(5)]
    parts = [(await c._core.request(operations.ESTIMATE_INGESTION, {"knowledge_base_id": KB, "documents": b["documents"]},  # pyright: ignore[reportPrivateUsage]
                                    caitlyn_core.CaitlynResult)).raw for b in sent]
    assert total.documents == 5
    assert total.duration_seconds.low == sum(p["durationSeconds"]["low"] for p in parts)
    assert total.duration_seconds.high == sum(p["durationSeconds"]["high"] for p in parts)
    assert "details" not in total.raw


@case("batch-upload.not-started")
async def test_batch_upload_not_started(mock: Mock, case_id: str) -> None:
    c = client(mock)
    contents = {"/hr/a.md": b"a"}
    planned = await built_batch(c, contents, start=False)
    made = await c.knowledge_bases(KB).ingestion.batches.create(start="manual", items=[batch_item("/hr/b.md", b"b")], await_more_items=True)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base).knowledge_bases(KB).ingestion
    for upload in (planned.upload(by_path(contents)), c.knowledge_bases(KB).ingestion.batches(made.id).upload(by_path({"/hr/b.md": b"b"})),
                   asyncio.to_thread(sync.batches(planned.id).upload, by_path(contents))):
        before = len(mock.api())
        err = await expect_error(upload)
        assert (type(err), err.status, err.code) == (CaitlynError, 0, "INGESTION_BATCH_NOT_STARTED")
        assert "batch.start()" in str(err)
        assert [r["method"] for r in mock.api()[before:]] == ["GET"] and forms(mock) == [], "nothing sent"
    # A when_planned batch still planning is followed until it runs, then uploaded.
    mock.faults(planningReads=3)
    when = await c.knowledge_bases(KB).ingestion.batches.create(start="when_planned", items=[batch_item("/hr/c.md", b"c")])
    assert str((await when.get()).status) == "planning"
    done = await c.knowledge_bases(KB).ingestion.batches(when.id).upload(by_path({"/hr/c.md": b"c"}))
    assert [str(i.path) for i in done.items] == ["/hr/c.md"] and sent_for(mock, b"c") == 1


@case("batch-upload.keep-alive")
async def test_batch_upload_keep_alive(mock: Mock, case_id: str) -> None:
    # A compressed clock: each policy lasts 2 s, so it is due for renewal 1 s after it arrives (half its life), and the
    # batch stops waiting for bytes 2 s after the latest one. The one file takes 3 s to arrive.
    def renewals() -> int:
        return len(calls(mock, "/upload-policies"))

    reservation = {"policySeconds": 2, "reservationSeconds": 2}
    contents = {"/hr/annual-leave.md": b"Staff receive 20 days of annual leave."}
    mock.faults(uploadReservation=reservation, uploadDelayMs=3000)
    c = client(mock)
    uploaded = await (await built_batch(c, contents)).upload(by_path(contents))
    assert [(str(i.status), i.failure_code) for i in uploaded.items] == [("ingesting", None)], "accepted, not UPLOAD_EXPIRED"
    sent = renewals()
    assert sent >= 3, f"{sent} policies asked for: the first, then at least two while the upload was in flight"
    await asyncio.sleep(1.5)
    assert renewals() == sent, "no renewal after the call returned"
    # Cancelled during the slow upload: no renewal after the cancellation is raised.
    mock.reset()
    mock.faults(uploadReservation=reservation, uploadDelayMs=3000)
    batch = await built_batch(c, contents)
    task = asyncio.create_task(batch.upload(by_path(contents)))
    await asyncio.sleep(1.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    at_cancel = renewals()
    await asyncio.sleep(1.5)
    assert renewals() == at_cancel, "no renewal after the cancellation"


@case("batch-upload.short-window")
async def test_batch_upload_short_window(mock: Mock, case_id: str) -> None:
    # A 60-second window that the mock's test mode makes 2 s long, and one file that takes 2.5 s to arrive. Each policy lasts 2 s, so its renewal margin is 1 s, not 5 minutes: renewals about 1 s apart, not at once
    # and then on each of the keep-alive's ticks.
    mock.faults(shortWindows=True, uploadDelayMs=2500)
    c = client(mock)
    files = [SyncFile("annual-leave.pdf", UploadFile.from_bytes(b"%PDF annual", name="annual-leave.pdf"))]
    report = await c.knowledge_bases(KB).ingestion.sync(files, folder="/window/", upload_window_seconds=60)
    assert str(report.batch.status) == "succeeded"
    created = [r for r in mock.api() if r["method"] == "POST" and str(r["path"]).endswith("/ingestion-batches")][0]
    assert json.loads(created["body"])["uploadWindowSeconds"] == 60, "sent as given"
    at = [int(r["at"]) for r in calls(mock, "/upload-policies")]
    assert 1 <= len(at) <= 3, f"{len(at)} renewals in a 2.5 s upload under 2 s policies"
    gaps = [b - a for a, b in zip(at, at[1:])]
    assert all(g >= 750 for g in gaps), f"renewals {gaps} ms apart"
    # expires_in_seconds on a single file's upload, as given.
    before = time.time()
    up = await c.core.uploads.reserve(file_name="a.pdf", content_type="application/pdf", byte_size=1, sha256=sha_b64(b"a"), expires_in_seconds=60)
    sent = [r for r in mock.api() if r["method"] == "POST" and r["path"] == "/v3/uploads"][-1]
    assert json.loads(sent["body"])["expiresInSeconds"] == 60
    life = up.expires_at.timestamp() - before
    assert 55 < life < 65, f"the upload lasts {life:.1f} s"


@case("batch-upload.keep-alive-floor")
async def test_batch_upload_keep_alive_floor(mock: Mock, case_id: str) -> None:
    # Every policy lasts a second, so it is due half a second after it arrives; the one file takes 4 s to arrive. The first
    # ask is upload()'s own policy; the rest are the timer's, the first half a second on and the others a second apart:
    # about five in all, where half-second renewals would be about nine.
    mock.faults(uploadReservation={"policySeconds": 1, "reservationSeconds": 30}, uploadDelayMs=4000)
    contents = {"/hr/annual-leave.md": b"Staff receive 20 days of annual leave."}
    uploaded = await (await built_batch(client(mock), contents)).upload(by_path(contents))
    assert [(str(i.status), i.failure_code) for i in uploaded.items] == [("ingesting", None)]
    at = [int(r["at"]) for r in calls(mock, "/upload-policies")]
    assert 4 <= len(at) <= 6, f"{len(at)} policies asked for in 4 s: want the timer's renewals, at most one a second"
    gaps = [b - a for a, b in zip(at[1:], at[2:])]
    assert all(g >= 900 for g in gaps), f"renewals {gaps} ms apart"


@case("batch-upload.sends")
async def test_batch_upload_sends(mock: Mock, case_id: str) -> None:
    c = client(mock)
    # At most 6 at once, by default, and as concurrency says.
    mock.faults(uploadDelayMs=150)
    contents = {f"/hr/f{n:02}.md": f"file {n}".encode() for n in range(14)}
    await (await built_batch(c, contents)).upload(by_path(contents))
    assert mock.uploads()["maxInFlight"] == 6
    mock.reset()
    mock.faults(uploadDelayMs=100)
    await (await built_batch(c, contents)).upload(by_path(contents), concurrency=2)
    assert mock.uploads()["maxInFlight"] == 2
    # Only awaiting items with a file; the policy's fields in order, then key, Content-Type, the checksum and the file;
    # Complete in groups of at most 100.
    mock.reset()
    many = {f"/many/f{n:03}.md": f"file {n}".encode() for n in range(130)}
    batch = await built_batch(c, {**many, "/many/left.md": b"left"})
    seen: list[Any] = []
    out = await batch.upload(by_path(many), on_progress=seen.append)
    assert len(forms(mock)) == 130 and sent_for(mock, b"left") == 0
    # Progress: upload in bytes, with the item; then queued after each Complete, items accepted of items uploaded.
    sent_bytes = sum(len(d) for d in many.values())
    upload = [p for p in seen if p.phase == "upload"]
    assert (upload[-1].done, upload[-1].total) == (sent_bytes, sent_bytes) and str(upload[-1].item.path).startswith("/many/")
    queued = [(p.done, p.total) for p in seen if p.phase == "queued"]
    assert len(queued) == len(calls(mock, "/complete-uploads")) and queued[-1] == (130, 130)
    for p in forms(mock):
        names = [x["name"] for x in p["form"]]
        assert names == ["bucket", "x-amz-algorithm", "x-amz-credential", "x-amz-date", "policy", "x-amz-signature", "key", "Content-Type",
                         "x-amz-checksum-algorithm", "x-amz-checksum-sha256", "file"]
    sizes = [len(json.loads(r["body"])["itemIds"]) for r in calls(mock, "/complete-uploads")]
    assert max(sizes) <= 100 and sum(sizes) == 130
    assert len(out.items) == 130 and out.not_given == ["/many/left.md"]


@case("batch-upload.not-given")
async def test_batch_upload_not_given(mock: Mock, case_id: str) -> None:
    contents = {"/hr/a.md": b"a", "/hr/b.md": b"b"}
    batch = await built_batch(client(mock), contents)
    ended: list[str] = []
    out = await batch.upload(by_path({"/hr/a.md": b"a"}), on_item=lambda i: ended.append(str(i.path)))
    assert out.not_given == ["/hr/b.md"] and [str(i.path) for i in out.items] == ["/hr/a.md"]
    statuses = {str(i.path): str(i.status) async for i in batch.items.list()}
    assert statuses["/hr/b.md"] == "awaiting_upload", "left awaiting upload, not failed"
    [left] = [i.id async for i in batch.items.list() if str(i.path) == "/hr/b.md"]
    assert left not in completed_ids(mock) and ended == []


@case("batch-upload.unmatched")
async def test_batch_upload_unmatched(mock: Mock, case_id: str) -> None:
    batch = await built_batch(client(mock), {"/hr/a.md": b"a"})
    out = await batch.upload({"hr/a.md": UploadFile.from_bytes(b"a", name="a.md"), "/hr/zzz.md": UploadFile.from_bytes(b"z", name="zzz.md")})
    assert out.unmatched == ["/hr/zzz.md"] and [str(i.path) for i in out.items] == ["/hr/a.md"], "a key without its leading / matches"
    assert sent_for(mock, b"a") == 1 and sent_for(mock, b"z") == 0 and len(forms(mock)) == 1


@case("batch-upload.file-changed")
async def test_batch_upload_file_changed(mock: Mock, case_id: str) -> None:
    batch = await built_batch(client(mock), {"/hr/size.md": b"s", "/hr/digest.md": b"d", "/hr/fine.md": b"f"})
    ended: dict[str, str] = {}
    out = await batch.upload({"/hr/size.md": UploadFile.from_bytes(b"ss", name="size.md"),     # the wrong size
                              "/hr/digest.md": UploadFile.from_bytes(b"x", name="digest.md"),  # the right size, other bytes
                              "/hr/fine.md": UploadFile.from_bytes(b"f", name="fine.md")},
                             on_item=lambda i: ended.__setitem__(str(i.path), str(i.failure_code)))
    assert ended == {"/hr/size.md": "FILE_CHANGED", "/hr/digest.md": "FILE_CHANGED"}
    keys = form_keys(mock)
    assert not any(url_safe(sha_b64(b"s")) in k for k in keys), "the wrong size is caught before sending"
    assert sum(url_safe(sha_b64(b"d")) in k for k in keys) == 1, "storage's refusal is not retried"
    assert sent_for(mock, b"f") == 1, "neither stops the other uploads"
    status = {str(i.path): (str(i.status), i.failure_code) for i in out.items}
    assert status == {"/hr/size.md": ("failed", "FILE_CHANGED"), "/hr/digest.md": ("failed", "FILE_CHANGED"), "/hr/fine.md": ("ingesting", None)}


@case("batch-upload.upload-failed")
async def test_batch_upload_upload_failed(mock: Mock, case_id: str) -> None:
    mock.faults(failUploads={"/hr/a.md": True})  # every upload of a.md answers 500
    batch = await built_batch(client(mock), {"/hr/a.md": b"a", "/hr/b.md": b"b"})
    ended: list[tuple[str, str]] = []
    out = await batch.upload(by_path({"/hr/a.md": b"a", "/hr/b.md": b"b"}), on_item=lambda i: ended.append((str(i.path), str(i.failure_code))))
    assert ended == [("/hr/a.md", "UPLOAD_FAILED")]
    failed = next(i for i in out.items if str(i.path) == "/hr/a.md")
    assert (str(failed.status), failed.failure_code) == ("failed", "UPLOAD_FAILED")
    assert sent_for(mock, b"a") > 1, "retried before it failed"
    assert failed.id not in completed_ids(mock) and len(completed_ids(mock)) == 1


@case("batch-upload.policy-renewal")
async def test_batch_upload_policy_renewal(mock: Mock, case_id: str) -> None:
    # The policy upload() asks for lasts a second, so its renewal margin is half a second; each file takes a second to
    # arrive, one at a time. The first goes with that policy; it is renewed before the second goes.
    contents = {"/hr/a.md": b"a", "/hr/b.md": b"b"}
    c = client(mock)
    batch = await built_batch(c, contents)
    mock.faults(renewedPolicySeconds=1, uploadDelayMs=1000)
    await batch.upload(by_path(contents), concurrency=1)
    order = [("upload" if r.get("path") == "/__s3/" else "policy") for r in mock.requests()
             if r.get("method") == "POST" and (r.get("path") == "/__s3/" or str(r.get("path")).endswith("/upload-policies"))]
    assert order == ["policy", "upload", "policy", "upload"], f"{order}: the policy asked for, then renewed between the uploads"
    # A 403 saying the policy expired: renewed once, and that file sent again. The mock refuses the first policy
    # CreateIngestionBatchUploadPolicy gives the batch (firstCreatedPolicyExpired), once.
    mock.reset()
    batch = await built_batch(c, contents)
    mock.faults(firstCreatedPolicyExpired=True)
    out = await batch.upload(by_path(contents), concurrency=1)
    assert len(calls(mock, "/upload-policies")) == 2, "the first policy, and one renewal after the 403"
    assert len(forms(mock)) == 3 and all(str(i.status) == "ingesting" for i in out.items), "the refused file sent again"


@case("batch-upload.checksum-mismatch")
async def test_batch_upload_checksum_mismatch(mock: Mock, case_id: str) -> None:
    mock.faults(checksumMismatch={"/hr/a.md": 1})
    batch = await built_batch(client(mock), {"/hr/a.md": b"a", "/hr/b.md": b"b"})
    out = await batch.upload(by_path({"/hr/a.md": b"a", "/hr/b.md": b"b"}))
    assert sent_for(mock, b"a") == 2 and all(str(i.status) == "ingesting" for i in out.items), "uploaded once more, then accepted"
    mock.reset()
    mock.faults(checksumMismatch={"/hr/c.md": 2})
    batch = await built_batch(client(mock), {"/hr/c.md": b"c"})
    ended: list[str] = []
    out = await batch.upload(by_path({"/hr/c.md": b"c"}), on_item=lambda i: ended.append(str(i.failure_code)))
    assert sent_for(mock, b"c") == 2 and ended == ["CHECKSUM_MISMATCH"], "a second mismatch fails it"
    assert [(str(i.status), i.failure_code) for i in out.items] == [("failed", "CHECKSUM_MISMATCH")]


@case("batch-upload.second-call")
async def test_batch_upload_second_call(mock: Mock, case_id: str) -> None:
    contents = {"/hr/a.md": b"a", "/hr/b.md": b"b", "/hr/c.md": b"c"}
    batch = await built_batch(client(mock), contents)
    first = await batch.upload(by_path({"/hr/a.md": b"a"}))
    assert first.not_given == ["/hr/b.md", "/hr/c.md"]
    second = await batch.upload(by_path(contents))
    assert [sent_for(mock, d) for d in contents.values()] == [1, 1, 1], "only the items still awaiting upload"
    assert sorted(str(i.path) for i in second.items) == ["/hr/b.md", "/hr/c.md"] and second.unmatched == ["/hr/a.md"]


@case("batch-upload.result")
async def test_batch_upload_result(mock: Mock, case_id: str) -> None:
    from caitlyn.models import IngestionBatch, IngestionBatchItem

    contents = {"/hr/a.md": b"a", "/hr/b.md": b"b"}
    batch = await built_batch(client(mock), contents)
    started = await batch.upload(by_path(contents))
    result = started.result
    assert type(result).__name__ == "BatchUpload" and type(result.batch) is IngestionBatch
    assert all(type(i) is IngestionBatchItem and str(i.status) == "ingesting" for i in result.items) and len(result.items) == 2
    assert (result.not_given, result.unmatched) == ([], [])
    done = await started.wait(timeout=10)
    assert type(done) is IngestionBatch and str(done.status) == "succeeded"
    # The synchronous client's: the same, and its wait.
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    other = await built_batch(client(mock), {"/hr/c.md": b"c"})

    def run() -> tuple[Any, Any]:
        s = sync.knowledge_bases(KB).ingestion.batches(other.id).upload(by_path({"/hr/c.md": b"c"}))
        return s.result, s.wait(timeout=10)

    got, finished = await asyncio.to_thread(run)
    assert type(got.batch) is IngestionBatch and [str(i.path) for i in got.items] == ["/hr/c.md"]
    assert type(finished) is IngestionBatch and str(finished.status) == "succeeded"


@case("batch-upload.cancel")
async def test_batch_upload_cancel(mock: Mock, case_id: str) -> None:
    contents = {f"/hr/f{n:02}.md": f"file {n}".encode() for n in range(12)}
    batch = await built_batch(client(mock), contents)
    mock.faults(uploadDelayMs=1000)
    task = asyncio.create_task(batch.upload(by_path(contents)))
    while len(forms(mock)) < 6:
        await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(1.1)  # the mock notes the aborted uploads once their hold ends
    assert len(forms(mock)) == 6, "no upload starts after the cancel"
    assert len([r for r in mock.requests() if r.get("event") == "upload-aborted"]) == 6
    assert calls(mock, "/cancel") == [], "the batch is not cancelled"
    assert str((await batch.get()).status) == "running"
    # The synchronous client, Ctrl-C: the same, raised as a KeyboardInterrupt.
    mock.reset()
    batch = await built_batch(client(mock), contents)
    mock.faults(uploadDelayMs=1000)
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    error = await interrupted(lambda: sync.knowledge_bases(KB).ingestion.batches(batch.id).upload(by_path(contents)), mock)
    assert isinstance(error, KeyboardInterrupt), repr(error)
    assert calls(mock, "/cancel") == [], "the batch is not cancelled"
    assert str((await batch.get()).status) == "running"


async def test_form_upload_through_a_callers_client(mock: Mock) -> None:
    """Through a caller's own httpx.Client, the synchronous client sends the form in 64 KiB chunks with its
    Content-Length (no chunked transfer encoding), byte for byte as httpx encodes the form, and stops at the next
    chunk once cancelled."""
    contents = {"/hr/a.md": b"a" * 200_000, "/hr/b.md": b"b"}
    batch = await built_batch(client(mock), contents)
    own = httpx.Client()
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base, http_client=own)
    out = await asyncio.to_thread(sync.knowledge_bases(KB).ingestion.batches(batch.id).upload, by_path(contents))
    assert all(str(i.status) == "ingesting" for i in out.items), "storage took both: the bytes match their checksums"
    for p in forms(mock):
        assert "content-length" in p["headerNames"] and "transfer-encoding" not in p["headerNames"]
        assert int(p["headers"]["content-length"]) == p["bodyLength"]
        fields = {x["name"]: x["value"] for x in p["form"] if "value" in x}
        [file] = [x for x in p["form"] if "sha256" in x]
        data = contents["/hr/a.md"] if file["byteSize"] > 1 else contents["/hr/b.md"]
        assert file["sha256"] == sha_b64(data)
        encoded = httpx.Request("POST", "http://x/", headers={"Content-Type": p["headers"]["content-type"]}, data=fields,
                                files={"file": (file["fileName"], data, file["contentType"])}).read()
        assert sha_b64(encoded) == p["bodySha256"], "byte for byte as httpx encodes data and files"
    # Cancelled: the next chunk raises, and the half-sent form is never taken.
    mock.reset()
    cancelled = threading.Event()
    cancelled.set()
    core = sync._core  # pyright: ignore[reportPrivateUsage]
    prepared = UploadFile.from_bytes(b"c" * 200_000, name="c.md").stage(sha_b64(b"c" * 200_000))
    with pytest.raises(core_client.UploadCancelled):
        await asyncio.to_thread(core.post_form, f"{mock.base}/__s3/", [("key", "k")], prepared, cancelled)
    assert forms(mock) == [] and mock.uploads()["objects"] == []
    own.close()


# ------------------------------------------------------------------ If-Match: optional on the model's set only


def if_match_operations() -> dict[str, bool]:
    """Every operation of the model with an If-Match header, and whether the model marks it @ifMatchOptional."""
    shapes: dict[str, Any] = json.loads((ROOT / "model" / "model.json").read_text())["shapes"]
    out: dict[str, bool] = {}
    for shape_id, shape in shapes.items():
        target = shape.get("input", {}).get("target") if shape.get("type") == "operation" else None
        members: dict[str, Any] = shapes.get(target, {}).get("members", {}) if target else {}
        if any(str(m.get("traits", {}).get("smithy.api#httpHeader", "")).lower() == "if-match" for m in members.values()):
            out[shape_id.split("#")[1]] = "ai.caitlyn.traits#ifMatchOptional" in shape.get("traits", {})
    return out


@case("if-match.optional-set")
async def test_if_match_optional_set(mock: Mock, case_id: str) -> None:
    operations_ = if_match_operations()
    assert any(operations_.values()) and not all(operations_.values()), "the model has both kinds"
    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    # The signatures, on both clients: optional (None by default) on exactly the model's set, a required keyword elsewhere.
    for operation, optional in operations_.items():
        for c in (client(mock), sync):
            for place in PLACES[operation]:
                given = {f["member"]: "x" for f in place[1].get("fills", [])}
                fn, _, _ = scope_method(cast(AsyncCaitlyn, c), operation, given)
                parameter = inspect.signature(fn).parameters["if_match"]
                assert parameter.kind is inspect.Parameter.KEYWORD_ONLY, operation
                if optional:
                    assert parameter.default is None, f"{operation}: if_match is optional on {type(c).__name__}"
                else:
                    assert parameter.default is inspect.Parameter.empty, f"{operation}: if_match is required on {type(c).__name__}"
    # The wire: each operation of the set, called without if_match, sends no If-Match header.
    for operation in (o for o, optional in operations_.items() if optional):
        ex = next(e for e in EXAMPLES if e["operation"] == operation and "synthesised" not in e["id"])
        mock.reset()
        mock.prime_example(ex["id"])
        given = {k: v for k, v in ex["input"].items() if k != "ifMatch"}
        fn, lead, kwargs = scope_method(client(mock), operation, given)
        try:
            await fn(*lead, **kwargs)
        except CaitlynError:
            pass  # the example may be of a refusal: the request is what is checked
        [sent] = [r for r in mock.api() if r["method"] != "GET"]
        assert "if-match" not in {k.lower() for k in sent["headers"]}, f"{operation} sent If-Match without being given one"


async def test_long_running_handles(mock: Mock) -> None:
    """The calls the model marks @longRunning return handles whose wait() follows the thing: CreateIngestionBatch,
    StartIngestionBatch, CancelIngestionBatch and CancelDocumentProcessing."""
    from caitlyn import AsyncStarted
    from caitlyn.models import Document, IngestionBatch

    kb = client(mock).knowledge_bases(KB)
    made = await kb.ingestion.batches.create(start="manual", items=[batch_item("/policies/policy-2.pdf", b"doc2")])
    planned = await made.wait(timeout=10)
    assert type(planned) is IngestionBatch and str(planned.status) == "planned"
    finished = await (await kb.ingestion.batches(made.id).start()).wait(timeout=10)
    assert type(finished) is IngestionBatch and str(finished.status) == "succeeded"
    other = await kb.ingestion.batches.create(start="manual", items=[batch_item("/hr/a.md", b"a")])
    await other.planned(timeout=10)
    # The two cancels return handles too, with the thing as their result; their waits are [wait.cancel-returns].
    handle = await kb.ingestion.batches(other.id).cancel()
    assert isinstance(handle, AsyncStarted) and type(handle.result) is IngestionBatch and str(handle.result.status) in ("cancelled", "cancelling")
    mock.prime_example("CancelDocumentProcessing: Stop a document's ingestion")
    stopping = await client(mock).knowledge_bases(KB).documents("doc-3b7f9e21").cancel_processing()
    assert isinstance(stopping, AsyncStarted) and type(stopping.result) is Document
    mock.reset()


@case("wait.cancel-returns")
async def test_wait_cancel_returns(mock: Mock, case_id: str) -> None:
    from caitlyn.models import Document, IngestionBatch

    sync = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base)
    # batch.cancel().wait() returns the cancelled batch, on both clients.
    for run in ("async", "sync"):
        made = await client(mock).knowledge_bases(KB).ingestion.batches.create(start="manual", items=[batch_item(f"/hr/{run}.md", run.encode())])
        await made.planned(timeout=10)
        if run == "async":
            done = await (await client(mock).knowledge_bases(KB).ingestion.batches(made.id).cancel()).wait(timeout=10)
        else:
            done = await asyncio.to_thread(lambda: sync.knowledge_bases(KB).ingestion.batches(made.id).cancel().wait(timeout=10))  # noqa: B023
        assert type(done) is IngestionBatch and str(done.status) == "cancelled", run
        # Every other wait of that batch still raises CANCELLED.
        err = await expect_error(client(mock).knowledge_bases(KB).ingestion.batches(made.id).wait(timeout=10))
        assert (err.status, err.code) == (0, "CANCELLED")
    # doc.cancel_processing().wait() returns the document as it then stands: its processing (started by a first
    # watch, busyDocuments) is stopped by the call (cancellableProcessing), and the job it cancelled raises nothing.
    for run in ("async", "sync"):
        mock.reset()
        mock.faults(busyDocuments={"doc-0001": True}, jobSteps=10_000, cancellableProcessing=True)
        async with client(mock).knowledge_bases(KB).documents("doc-0001").watch() as stream:
            async for _ in stream:
                break
        if run == "async":
            got = await (await client(mock).knowledge_bases(KB).documents("doc-0001").cancel_processing()).wait(timeout=10)
        else:
            got = await asyncio.to_thread(lambda: sync.knowledge_bases(KB).documents("doc-0001").cancel_processing().wait(timeout=10))
        assert type(got) is Document and got.id == "doc-0001" and got.processing is None, run
        # Any other wait on a job that ends cancelled still raises CANCELLED.
        mock.reset()
        mock.faults(busyDocuments={"doc-0001": True}, jobOutcomes={"doc-0001": "cancelled"})
        err = await expect_error(client(mock).knowledge_bases(KB).documents("doc-0001").wait(timeout=10))
        assert (err.status, err.code) == (0, "CANCELLED")


# ------------------------------------------------------------------ 0.10.1: timeouts, unreadable expiry, sync estimates, If-Match: *


def held(op: str, n: int) -> dict[str, list[dict[str, bool]]]:
    """n hold faults for an operation: requests the mock never answers."""
    return {op: [{"hold": True}] * n}


def mock_events(mock: Mock, event: str, op: str = "") -> list[dict[str, Any]]:
    return [r for r in mock.requests() if r.get("event") == event and (not op or r.get("op") == op)]


def policies_asked(mock: Mock) -> int:
    return len(calls(mock, "/upload-policies"))


@case("client.request-timeout")
async def test_request_timeout(mock: Mock, case_id: str) -> None:
    # Python's `timeout` (default 120 s) is httpx's: each read waits at most this long, which covers the wait for the headers.
    c = client(mock, timeout=0.3)
    mock.faults(status=held("GetKnowledgeBase", 3))
    started = time.monotonic()
    err = await expect_error(c.knowledge_bases(KB).get())
    assert type(err) is CaitlynConnectionError and (err.status, err.code) == (0, "CONNECTION_ERROR")
    assert "GetKnowledgeBase" in str(err) and "300 ms" in str(err), f"the message names the operation and the timeout: {err}"
    assert len([r for r in mock.api() if r["path"] == f"/v3/knowledge-bases/{KB}"]) == 3, "retried as a read is"
    assert time.monotonic() - started < 10
    await asyncio.sleep(0.2)
    assert len(mock_events(mock, "request-aborted", "GetKnowledgeBase")) == 3, "each timed-out attempt was closed"
    # A watch whose stream has only keep-alives for longer than the timeout is not cut.
    mock.reset()
    mock.faults(watchKeepAliveMs=100)
    kb = c.knowledge_bases(KB)
    seen: list[str] = []

    async def change() -> None:
        await asyncio.sleep(1.2)
        current = await kb.get()
        await kb.update(description="Still watching", if_match=str(current.etag))

    changing = asyncio.create_task(change())
    async with kb.watch() as watch:
        async for event in watch:
            seen.append(str(event.type))
            if event.type == "knowledge_base.updated":
                break
    await changing
    assert seen == ["snapshot", "knowledge_base.updated"]
    assert len([r for r in mock.api() if r["path"] == f"/v3/knowledge-bases/{KB}/events"]) == 1, "one connection, never cut"


@case("files.storage-stall")
async def test_storage_stall(mock: Mock, case_id: str) -> None:
    # Python's storage stall timer is httpx's timeout on each send to storage: each write and each read waits at most this
    # long. API calls keep their own 120 s, so only `storage_stall_timeout` can end this.
    c = client(mock, storage_stall_timeout=0.3)
    defaults = inspect.signature(AsyncCaitlyn.__init__).parameters
    assert (defaults["timeout"].default, defaults["storage_stall_timeout"].default) == (120.0, 60.0)
    contents = {"/hr/a.md": b"Staff receive 20 days of annual leave."}
    batch = await built_batch(c, contents)
    mock.faults(status=held("PostObject", 3))
    up = await batch.upload(by_path(contents))
    assert [(str(i.status), i.failure_code) for i in up.items] == [("failed", "UPLOAD_FAILED")]
    assert "storage sent nothing for 300 ms" in str(up.items[0].failure_detail), up.items[0].failure_detail
    assert len(forms(mock)) == 3, "retried as a send with no response is"
    await asyncio.sleep(0.2)
    assert len(mock_events(mock, "request-aborted", "PostObject")) == 3, "each stalled attempt was closed"


@case("files.slow-not-stalled")
async def test_slow_not_stalled(mock: Mock, case_id: str) -> None:
    c = client(mock, storage_stall_timeout=2.5)
    big = bytes(i % 251 for i in range(32 * 1024 * 1024))
    contents = {"/hand/large.pdf": big}
    batch = await built_batch(c, contents)
    mock.faults(uploadReadBytesPerSecond=8 * 1024 * 1024)
    started = time.monotonic()
    up = await batch.upload(by_path(contents))
    assert [(str(i.status), i.failure_code) for i in up.items] == [("ingesting", None)]
    assert time.monotonic() - started > 2.5, "longer than the stall timeout in all"
    assert len(forms(mock)) == 1, "one attempt"


@case("batch-upload.unreadable-expiry")
async def test_unreadable_expiry(mock: Mock, case_id: str) -> None:
    # Start's policy is short, so the first upload renews it; every renewal then has no expiresAt.
    mock.faults(policySeconds=1, policyExpiresAt=None)
    c = client(mock)
    contents = {f"/hr/f{n}.md": f"file {n}".encode() for n in range(3)}
    batch = await built_batch(c, contents)
    before = policies_asked(mock)
    up = await batch.upload(by_path(contents), concurrency=1)
    assert [str(i.status) for i in up.items] == ["ingesting"] * 3
    assert policies_asked(mock) - before >= 3, "one policy before each of 3 uploads"
    after = policies_asked(mock)
    await asyncio.sleep(1.5)
    assert policies_asked(mock) == after, "no renewal after the call returned"
    # An expiresAt that is not a time fails the call that returned it, clearly: never a silent loss of renewal.
    mock.reset()
    mock.faults(policySeconds=1, policyExpiresAt="not a date")
    again = await built_batch(c, contents)
    err = await expect_error(again.upload(by_path(contents), concurrency=1))
    assert err.code == "DECODE_FAILED"


@case("sync.no-confirm-no-estimate")
async def test_sync_no_confirm_no_estimate(mock: Mock, tmp_path: Path, case_id: str) -> None:
    mock.faults(status={"EstimateIngestion": [{"status": 503, "retryAfter": 0}] * 3})
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b"})
    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/")
    assert str(report.batch.status) == "succeeded"
    assert not calls(mock, "/ingestions:estimate"), "nothing was priced"


@case("sync.confirm-estimate-unavailable")
async def test_sync_confirm_estimate_unavailable(mock: Mock, tmp_path: Path, case_id: str) -> None:
    mock.faults(status={"EstimateIngestion": [{"status": 400}]})
    root = folder_of(tmp_path, {"a.md": b"a", "b.md": b"b"})
    plans: list[Any] = []

    def confirm(plan: Any) -> bool:
        plans.append(plan)
        return True

    report = await client(mock).knowledge_bases(KB).ingestion.sync(root, folder="/hr/", confirm=confirm)
    assert str(report.batch.status) == "succeeded"
    [plan] = plans
    assert plan.estimate is None and isinstance(plan.estimate_error, CaitlynError) and plan.estimate_error.status == 400
    assert len(plan.items) == 2
    mock.reset()
    mock.faults(status={"EstimateIngestion": [{"status": 400}]})
    err = await expect_error(client(mock).knowledge_bases(KB).ingestion.sync.estimate(root, folder="/hr/"))
    assert err.status == 400


@case("if-match.never-wildcard")
async def test_if_match_never_wildcard(mock: Mock, tmp_path: Path, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)
    err = await expect_error(kb.update(description="Any version", if_match="*"))
    assert err.code == "IF_MATCH_WILDCARD_NOT_ASKED", "unasked, the mock refuses it"
    mock.faults(allowIfMatchWildcard=True)
    updated = await kb.update(description="Any version", if_match="*")
    assert updated.description == "Any version"
    patches = [r for r in mock.api() if r["method"] == "PATCH" and r["path"] == f"/v3/knowledge-bases/{KB}"]
    assert patches[-1]["headers"]["if-match"] == "*"
    # A sync, which sends If-Match on Start, sends the plan's own ETag.
    mock.reset()
    report = await client(mock).knowledge_bases(KB).ingestion.sync(folder_of(tmp_path, {"a.md": b"a"}), folder="/hr/")
    assert str(report.batch.status) == "succeeded"
    [start] = calls(mock, "/start")
    assert start["headers"].get("if-match") not in (None, "", "*")


@case("watch.snapshot-not-progress")
async def test_watch_snapshot_not_progress(mock: Mock, case_id: str) -> None:
    kb = client(mock).knowledge_bases(KB)

    def watches() -> int:
        return len([r for r in mock.api() if r["method"] == "GET" and r["path"] == f"/v3/knowledge-bases/{KB}/events"])

    # Four connections in a row that each end after their snapshot (a fresh id every time): STREAM_LOST.
    mock.faults(watchDrops={"count": 4, "afterEvents": 1})
    seen: list[str] = []

    async def watch_all() -> None:
        async with kb.watch() as watch:
            async for event in watch:
                seen.append(str(event.type))

    err = await expect_error(watch_all())
    assert err.code == "STREAM_LOST", err
    assert seen == ["snapshot"] * 4, seen
    assert watches() == 4, "the first connection and three reconnects"
    # Three such connections, then one that stays open and brings a change: the watch carries on to it.
    mock.reset()
    mock.faults(watchDrops={"count": 3, "afterEvents": 1})

    async def change() -> None:
        while watches() < 4:
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.1)
        current = await kb.get()
        await kb.update(description="Still watching", if_match=str(current.etag))

    changing = asyncio.create_task(change())
    types: list[str] = []
    async with kb.watch() as watch:
        async for event in watch:
            types.append(str(event.type))
            if event.type == "knowledge_base.updated":
                break
    await changing
    assert types == ["snapshot"] * 4 + ["knowledge_base.updated"], types


@case("batch-upload.policy-sets-key")
async def test_policy_sets_key(mock: Mock, case_id: str) -> None:
    # The mock's policy has its own `key`, as createPresignedPost makes it, and refuses a form that repeats a field.
    c = client(mock)
    contents = {"/hand/file-1.pdf": b"%PDF hand 1", "/hand/file-2.pdf": b"%PDF hand 2"}
    batch = await built_batch(c, contents)
    up = await batch.upload(by_path(contents))
    assert [(str(i.status), i.failure_code) for i in up.items] == [("ingesting", None)] * 2
    object_keys = {i.object_key async for i in batch.items.list()}
    sent = forms(mock)
    assert len(sent) == 2
    for f in sent:
        keys = [p for p in f["form"] if str(p["name"]).lower() == "key"]
        assert len(keys) == 1 and keys[0]["value"] in object_keys, f["form"]
    assert mock_events(mock, "storage-refused-repeated-field") == []


@case("errors.409-retry-after")
async def test_409_retry_after(mock: Mock, case_id: str) -> None:
    c = client(mock)
    await built_batch(c, {"/reserved/file-1.pdf": b"%PDF hand 1"})
    kb = c.knowledge_bases(KB)
    created = await expect_error(kb.documents.create(UploadFile.from_bytes(b"%PDF another", name="file-1.pdf"), folder="/reserved/"))
    assert isinstance(created, ConflictError) and (created.code, created.retry_after_seconds) == ("TARGET_IN_USE", 30), created
    assert len([r for r in mock.api() if r["method"] == "POST" and r["path"] == f"/v3/knowledge-bases/{KB}/documents"]) == 1, "a 409 is not retried"
    other = await kb.documents.create(UploadFile.from_bytes(b"%PDF other", name="other.pdf"), folder="/reserved/")
    current = await kb.documents(other.id).get()
    renamed = await expect_error(kb.documents(other.id).update(name="file-1.pdf", if_match=current.etag))
    assert isinstance(renamed, ConflictError) and (renamed.code, renamed.retry_after_seconds) == ("TARGET_IN_USE", 30), renamed


@case("telemetry.batch-item")
async def test_telemetry_batch_item(mock: Mock, case_id: str) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    c = client(mock, tracer_provider=provider)
    contents = {"/hr/a.md": b"a", "/hr/b.md": b"b", "/hr/broken.md": b"broken"}
    batch = await built_batch(c, contents)
    mock.faults(failUploads={"/hr/broken.md": True})
    await batch.upload(by_path(contents))
    spans = [s for s in exporter.get_finished_spans() if s.name == "caitlyn.batch.item"]
    assert len(spans) == 3
    for s in spans:
        attrs = dict(s.attributes or {})
        assert attrs["caitlyn.ingestion_batch.id"] == batch.id and attrs["caitlyn.ingestion_batch.item.id"]
        events = [e.name for e in s.events]
        if attrs["caitlyn.ingestion_batch.item.path"] == "/hr/broken.md":
            assert events[:3] == ["opened", "checked", "sending"] and events[-1] == "failed", events
            assert dict(s.events[-1].attributes or {})["caitlyn.error.code"] == "UPLOAD_FAILED"
            assert s.status.status_code.name == "ERROR"
        else:
            assert events == ["opened", "checked", "sending", "sent", "completed"], events
