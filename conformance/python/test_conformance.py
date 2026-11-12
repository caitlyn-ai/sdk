"""Python conformance harness: the protocol cases in conformance/cases/protocol.json and the example cases in
conformance/cases/examples.json, against the mock server. Each test's id starts with the case id in square
brackets (pytest's `ids`); scripts/check-conformance.mjs checks that every case ran and passed."""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import os
import re
import socket
import time
import urllib.parse
import uuid
from collections.abc import AsyncIterable, Awaitable, Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, TypeVar, cast

import caitlyn
import httpx
import pytest
from caitlyn import (
    AsyncCaitlyn,
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
from caitlyn.models import AgentVersion
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


def case(case_id: str) -> Callable[[Callable[..., Any]], Any]:
    """Names the test after its protocol case: pytest shows it as test_x[<case id>]."""
    return pytest.mark.parametrize("case_id", [case_id], ids=[f"[{case_id}]"])


# ------------------------------------------------------------------ retries


@case("retry.429-retry-after")
async def test_retry_429(mock: Mock, case_id: str) -> None:
    mock.faults(status={"ListDocuments": [{"status": 429, "retryAfter": 2}]})
    t0 = time.monotonic()
    docs = await collect(client(mock).documents.list(knowledge_base_id="KB4T7YQ2WL", limit=100))
    assert len(docs) == 7
    assert time.monotonic() - t0 >= 2
    assert len(mock.api()) == 2


@case("retry.503-retry-after")
async def test_retry_503(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 1}]})
    t0 = time.monotonic()
    v = await client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert time.monotonic() - t0 >= 1
    assert v.name == "draft"


@case("retry.long-retry-after")
async def test_retry_long(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 429, "retryAfter": 7}]})
    t0 = time.monotonic()
    await client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert time.monotonic() - t0 >= 7


@case("retry.idempotency-key-kept")
async def test_idempotency_key_kept(mock: Mock, tmp_path: Path, case_id: str) -> None:
    mock.faults(status={"CreateUpload": [{"status": 503, "retryAfter": 0}, {"status": 429, "retryAfter": 0}]})
    f = tmp_path / "hello.txt"
    f.write_text("hello")
    await client(mock).uploads.create(file=f)
    keys = [r["headers"].get("idempotency-key") for r in mock.api() if r.get("path") == "/v3/uploads"]
    assert len(keys) == 3
    assert re.fullmatch(r"[0-9a-f-]{36}", keys[0] or "")
    assert len(set(keys)) == 1


@case("retry.unsafe-not-retried")
async def test_unsafe_not_retried(mock: Mock, case_id: str) -> None:
    mock.faults(status={"SendMessage": [{"status": 503, "retryAfter": 0}]})
    err = await expect_error(client(mock).conversations.send("c-9", message="hi").final_message())
    assert isinstance(err, ServiceUnavailableError)
    assert len(mock.api()) == 1


@case("retry.above-max-retry-delay")
async def test_above_max_retry_delay(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 429, "retryAfter": 120}]})
    t0 = time.monotonic()
    err = await expect_error(client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft"))
    assert (err.status, err.retry_after_seconds) == (429, 120)
    assert time.monotonic() - t0 < 1
    assert len(mock.api()) == 1


# ------------------------------------------------------------------ pagination


@case("pagination.to-last-page")
async def test_pagination(mock: Mock, case_id: str) -> None:
    docs = await collect(client(mock).documents.list(knowledge_base_id="KB4T7YQ2WL", limit=3))
    assert len(docs) == 7
    reqs = mock.api()
    assert len(reqs) == 3
    assert "cursor=" not in reqs[0]["query"]
    assert "cursor=" in reqs[2]["query"]


# ------------------------------------------------------------------ SSE


@case("sse.resume-finished")
async def test_sse_resume_finished(mock: Mock, case_id: str) -> None:
    c = client(mock)
    first = await collect(c.conversations.send("c-done", message="hi"))
    async with c.conversations.resume("c-done", last_event_id=first[-1].event_id) as resumed:
        assert await collect(resumed) == []
    assert len([r for r in mock.api() if r["method"] == "GET"]) == 1  # one resume request, no reconnects


@case("sse.request-id-and-type")
async def test_sse_request_id_and_type(mock: Mock, case_id: str) -> None:
    async with client(mock).conversations.send("c-ids", message="hi") as stream:
        events = await collect(stream)
        assert stream.request_id == mock.api()[-1]["requestId"]
    assert (events[0].type, events[-1].type) == ("message.started", "message.completed")


@case("sse.typed-events")
async def test_sse_typed_events(mock: Mock, case_id: str) -> None:
    text = ""
    types: list[str] = []
    async with client(mock).conversations.send("c-1", message="How many days?") as stream:
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
    async with client(mock).conversations.send("c-2", message="hi") as stream:
        events = await collect(stream)
    ids = [e.event_id for e in events]
    assert len(set(ids)) == len(ids)
    assert events[-1].type == "message.completed"
    resume = next(r for r in mock.api() if r["method"] == "GET" and r["path"] == "/v3/conversations/c-2/stream")
    assert resume["headers"].get("last-event-id") == ids[2]
    assert resume["headers"].get("accept") == "text/event-stream"


@case("sse.clean-end-resumes")
async def test_sse_clean_end(mock: Mock, case_id: str) -> None:
    mock.faults(endAfterEvents=2)
    async with client(mock).conversations.send("c-5", message="hi") as stream:
        events = await collect(stream)
    assert events[-1].type == "message.completed"
    resume = next(r for r in mock.api() if r["path"] == "/v3/conversations/c-5/stream")
    assert resume["headers"].get("last-event-id") == events[1].event_id


@case("sse.message-failed")
async def test_sse_message_failed(mock: Mock, case_id: str) -> None:
    mock.faults(failStream=True)
    seen: list[str] = []

    async def consume() -> None:
        async with client(mock).conversations.send("c-6", message="hi") as stream:
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
    async with client(mock).conversations.send("c-3", message="hi") as stream:
        events = await collect(stream)
    assert all(e.type != "memory.saved" for e in events)
    assert events[-1].type == "message.completed"


@case("tolerance.unknown-enum")
async def test_unknown_enum(mock: Mock, case_id: str) -> None:
    mock.faults(unknownEnum=True)
    docs = await collect(client(mock).documents.list(knowledge_base_id="KB4T7YQ2WL"))
    assert docs[1].status == "archived"
    v = await client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert v.source == "cloned_from_template"


@case("tolerance.unknown-field-raw")
async def test_unknown_field_raw(mock: Mock, case_id: str) -> None:
    mock.faults(unknownField=True)
    c = client(mock)
    v = await c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert v.raw["reviewState"] == {"required": False}
    assert v.raw["configuration"]["instructions"] == "Answer from the HR policies."
    assert "etag" not in v.raw  # raw is the body as received; header-bound members are attributes only
    async with c.conversations.send("c-6", message="hi") as stream:
        answer = await stream.final_message()
    assert answer.raw["sentiment"] == "neutral"


@case("tolerance.nested-raw")
async def test_nested_raw(mock: Mock, case_id: str) -> None:
    mock.faults(unknownField=True)
    c = client(mock)
    docs = await collect(c.documents.list(knowledge_base_id="KB4T7YQ2WL"))
    assert docs[0].raw["retentionPolicy"] == {"keepDays": 365}
    v = await c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert v.configuration.knowledge_bases is not None
    assert v.configuration.knowledge_bases[0].raw["reranker"] == "cohere"


# ------------------------------------------------------------------ typed errors


@case("errors.404")
async def test_404(mock: Mock, case_id: str) -> None:
    for aws_header in (False, True):
        mock.reset()
        mock.faults(awsErrorTypeHeader=aws_header)
        err = await expect_error(collect(client(mock).documents.list(knowledge_base_id="NOPE")))
        last = mock.api()[-1]
        assert isinstance(err, NotFoundError)
        assert (err.status, err.code, err.request_id) == (404, "NOT_FOUND", last["requestId"])
        assert err.type == "https://build.caitlyn.ai/errors/NOT_FOUND"


@case("errors.409")
async def test_409(mock: Mock, case_id: str) -> None:
    c = client(mock)
    up = await c.uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x")
    err = await expect_error(c.documents.create(knowledge_base_id="KB4T7YQ2WL", upload_id=up.id, folder="hr/"))
    assert isinstance(err, ConflictError)
    assert (err.status, err.code) == (409, "CONFLICT")


@case("errors.412")
async def test_412(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    await c.versions.update_draft("GHT7YRWXPL", if_match=draft.etag, instructions="first")
    err = await expect_error(c.versions.update_draft("GHT7YRWXPL", if_match=draft.etag, instructions="second"))
    assert isinstance(err, PreconditionFailedError)
    assert (err.status, err.code) == (412, "PRECONDITION_FAILED")
    assert err.request_id


@case("errors.429-exhausted")
async def test_429_exhausted(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 429, "retryAfter": 0}] * 3})
    err = await expect_error(client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft"))
    assert (err.status, err.code, err.retry_after_seconds) == (429, "RATE_LIMITED", 0)
    assert len(mock.api()) == 3


# An error page from something in front of the API, not a problem body (PROTOCOL.md 6.1).
HTML_404 = "<!DOCTYPE html><html><head><title>404: This page could not be found</title></head><body><h1>404</h1></body></html>"


@case("errors.html-404")
async def test_html_404(mock: Mock, case_id: str) -> None:
    mock.faults(status={"ListDocuments": [{"status": 404, "contentType": "text/html; charset=utf-8", "body": HTML_404}]})
    err = await expect_error(collect(client(mock).documents.list(knowledge_base_id="KB4T7YQ2WL")))
    assert isinstance(err, NotFoundError)
    assert (err.status, err.code, err.request_id) == (404, "HTTP_404", None)
    assert err.raw_body == HTML_404


@case("errors.empty-405")
async def test_empty_405(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 405, "body": ""}]})
    err = await expect_error(client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft"))
    assert type(err) is CaitlynError
    assert (err.status, err.code, err.request_id, err.raw_body) == (405, "HTTP_405", None, "")


@case("errors.text-502")
async def test_text_502(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 502, "contentType": "text/plain", "body": "Bad Gateway"}]})
    err = await expect_error(client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft"))
    assert type(err) is CaitlynError
    assert (err.status, err.code, err.raw_body) == (502, "HTTP_502", "Bad Gateway")
    assert len(mock.api()) == 1


# A problem body whose status disagrees with the HTTP status (PROTOCOL.md 6.3).
MISMATCHED_409 = '{"type":"https://build.caitlyn.ai/errors/CONFLICT","title":"Conflict","status":400,"code":"CONFLICT","requestId":"01MISMATCHEDSTATUS0000000"}'


@case("errors.status-from-http")
async def test_status_from_http(mock: Mock, case_id: str) -> None:
    mock.faults(status={"CreateUpload": [{"status": 409, "contentType": "application/problem+json", "body": MISMATCHED_409}]})
    reserve = client(mock).uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x")
    err = await expect_error(reserve)
    assert isinstance(err, ConflictError)
    assert (err.status, err.code, err.request_id) == (409, "CONFLICT", "01MISMATCHEDSTATUS0000000")


@case("errors.field-errors")
async def test_field_errors(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    err = await expect_error(c.versions.update_draft("GHT7YRWXPL", if_match=draft.etag, identity="x", clear=["identity"]))
    assert isinstance(err, ValidationError)
    assert (err.status, err.code) == (400, "VALIDATION_FAILED")
    assert err.errors[0]["pointer"] == "/identity"
    assert err.errors[0]["code"] == "VALIDATION_FAILED"
    patch = [r for r in mock.api() if r["method"] == "PATCH"][-1]
    assert json.loads(patch["body"]) == {"identity": "x", "clear": ["identity"]}


# errors.raw-body-limit: a 20 KiB HTML page (ASCII), and a page whose 8 KiB cut would fall inside a three-byte "€".
PAGE_20K = "<!DOCTYPE html>" + "x" * (20480 - 15)
PAGE_STRADDLE = "a" * 8191 + "€" * 10


@case("errors.unmodelled-status")
async def test_unmodelled_status(mock: Mock, case_id: str) -> None:
    mock.faults(status={"CreateUpload": [{"status": 404}, {"status": 405, "body": ""}]})
    c = client(mock)
    not_found = await expect_error(c.uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x"))
    assert type(not_found) is NotFoundError
    assert (not_found.status, not_found.code) == (404, "HTTP_404")
    other = await expect_error(c.uploads.reserve(file_name="a.txt", content_type="text/plain", byte_size=1, sha256="x"))
    assert type(other) is CaitlynError
    assert (other.status, other.code) == (405, "HTTP_405")


@case("errors.raw-body-limit")
async def test_raw_body_limit(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 404, "contentType": "text/html", "body": b} for b in (PAGE_20K, PAGE_STRADDLE)]})
    c = client(mock)
    page = await expect_error(c.versions.get(agent_id="GHT7YRWXPL", version="draft"))
    assert isinstance(page, NotFoundError)
    assert len(page.raw_body.encode()) == 8192
    assert page.raw_body == PAGE_20K[:8192]
    assert page.raw_body_truncated is True
    straddle = await expect_error(c.versions.get(agent_id="GHT7YRWXPL", version="draft"))
    assert (straddle.raw_body, straddle.raw_body_truncated) == ("a" * 8191, True)
    problem = await expect_error(c.versions.get(agent_id="GHT7YRWXPL", version="nope"))
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
    closed = await expect_error(client(mock, max_attempts=1).versions.get(agent_id="GHT7YRWXPL", version="draft"))
    refused_client = AsyncCaitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=refused_endpoint(), max_attempts=1)
    refused = await expect_error(refused_client.versions.get(agent_id="GHT7YRWXPL", version="draft"))
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
        async with client(mock).conversations.send("c-4", message="hi") as stream:
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
    task = asyncio.create_task(client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft"))
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ------------------------------------------------------------------ updates


@case("update.if-match")
async def test_if_match(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    updated = await c.versions.update_draft("GHT7YRWXPL", if_match=draft.etag, instructions="x")
    assert updated.etag != draft.etag
    patch = next(r for r in mock.api() if r["method"] == "PATCH")
    assert patch["headers"]["if-match"] == draft.etag
    assert json.loads(patch["body"]) == {"instructions": "x"}


@case("update.clear")
async def test_clear(mock: Mock, case_id: str) -> None:
    c = client(mock)
    draft = await c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    updated = await c.versions.update_draft("GHT7YRWXPL", if_match=draft.etag, clear=["identity"])
    patch = next(r for r in mock.api() if r["method"] == "PATCH")
    assert json.loads(patch["body"]) == {"clear": ["identity"]}
    assert updated.configuration.identity is None
    assert updated.configuration.instructions == "Answer from the HR policies."


# ------------------------------------------------------------------ wire headers and environment


@case("wire.headers")
async def test_wire_headers(mock: Mock, case_id: str) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}]})
    await client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft")
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
    v = await client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft")
    docs = await collect(client(mock).documents.list(knowledge_base_id="KB4T7YQ2WL", limit=3))
    assert (v.name, len(docs)) == ("draft", 7)
    assert time.monotonic() - t0 < 2, "something waited on the environment"
    assert len([r for r in mock.api() if "/versions/" in r["path"]]) == 2, "AWS_MAX_ATTEMPTS=1 was not ignored"


# ------------------------------------------------------------------ versions, headers, telemetry, endpoint


@case("since.fails-before-sending")
async def test_since(mock: Mock, case_id: str) -> None:
    mock.faults(apiVersion="5.110.0")
    c = client(mock)
    await c.versions.get(agent_id="GHT7YRWXPL", version="draft")  # no check before the first response
    before = len(mock.api())
    with pytest.raises(NotSupportedByServer) as info:
        await c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert (info.value.requires, info.value.server) == (SDK_MODEL, "5.110.0")
    assert len(mock.api()) == before


@case("headers.request-id")
async def test_request_id(mock: Mock, case_id: str) -> None:
    v = await client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert v.request_id == mock.api()[-1]["requestId"]
    assert v.api_version == "5.120.0"


@case("headers.response-metadata")
async def test_response_metadata(mock: Mock, case_id: str) -> None:
    v = await client(mock).versions.get(agent_id="GHT7YRWXPL", version="draft")
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
    await expect_error(c.versions.get(agent_id="GHT7YRWXPL", version="nope"))
    await collect(c.documents.list(knowledge_base_id="KB4T7YQ2WL", limit=100))
    f = tmp_path / "hello.txt"
    f.write_text("hello")
    await c.uploads.create(file=f)
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
    await client(mock, tracer_provider=provider).versions.get(agent_id="GHT7YRWXPL", version="draft")
    spans = exporter.get_finished_spans()
    call = next(s for s in spans if s.name == "caitlyn.call")
    assert call.context is not None
    attempts = [s for s in spans if s.parent and s.parent.span_id == call.context.span_id]
    assert [(s.attributes or {})["http.request.resend_count"] for s in attempts] == [0, 1]
    assert (call.attributes or {})["caitlyn.request_id"] == mock.api()[-1]["requestId"]
    assert all("traceparent" in r["headers"] for r in mock.api())


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
            v = await client(mock, http_client=own).versions.get(agent_id="GHT7YRWXPL", version="draft")
            assert v.name == "draft"
    sync_own = httpx.Client()
    with sync_own:
        c = caitlyn.Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"), endpoint=mock.base, http_client=sync_own)
        assert c.versions.get(agent_id="GHT7YRWXPL", version="draft").name == "draft"
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
    return c.versions.get(agent_id="GHT7YRWXPL", version="draft")


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
    await c.versions.update_draft("GHT7YRWXPL", if_match=v.etag, instructions="Cite clause numbers.")
    get, patch = mock.api()
    assert "authorization" not in get["headers"]
    assert get["headers"]["cookie"] == MOCK_SESSION_COOKIE
    assert "origin" not in get["headers"]
    assert patch["headers"]["origin"] == "https://caitlyn.lndo.site"
    assert "authorization" not in patch["headers"]
    assert mock.token_requests() == []


# ------------------------------------------------------------------ the model's @examples


def snake(name: str) -> str:
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()


def resource_method(c: AsyncCaitlyn, operation: str) -> Callable[..., Any]:
    """The public method that calls an operation, from the generated METHODS table."""
    namespace, name = operations.METHODS[operation]
    return getattr(getattr(c, namespace), name)


def assert_subset(expected: Any, actual: Any, at: str = "output") -> None:
    if isinstance(expected, dict):
        for k, v in cast(dict[str, Any], expected).items():
            assert_subset(v, getattr(actual, snake(k)) if not isinstance(actual, dict) else actual[k], f"{at}.{k}")
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


@pytest.mark.parametrize("ex", EXAMPLES, ids=[f"[example] {e['id']}" for e in EXAMPLES])
async def test_example(mock: Mock, ex: dict[str, Any]) -> None:
    mock.prime_example(ex["id"])
    c = client(mock)
    method = resource_method(c, ex["operation"])
    kwargs = {snake(k): v for k, v in ex["input"].items()}
    result: Any = None
    error: BaseException | None = None
    try:
        out = method(**kwargs)
        if hasattr(out, "pages"):  # a list: the example is one page
            async for page in out.pages():
                result = page
                break
        elif hasattr(out, "__aenter__"):  # a stream: drain it
            async with out as stream:
                await collect(stream)
        else:
            result = await out
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
        if ex["expected"].get("output"):
            assert_subset(ex["expected"]["output"], result)


# ------------------------------------------------------------------ Python only: the synchronous client


def test_sync_stream_is_incremental(mock: Mock) -> None:
    from caitlyn import Caitlyn

    mock.faults(streamDelayMs=100)
    c = Caitlyn(workspace="x", auth=Token("pat_test"), endpoint=mock.base)
    t0 = time.monotonic()
    first_at: float | None = None
    with c.conversations.send("c-5", message="hi") as stream:
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
        return c.versions.get(agent_id="GHT7YRWXPL", version="draft")

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(call, range(8)))
    assert mock.auth_counts()["client_credentials"] == 1
    mock.faults(auth={"revokeIssued": True})
    c.versions.get(agent_id="GHT7YRWXPL", version="draft")
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
    c.versions.get(agent_id="GHT7YRWXPL", version="draft")
    mock.faults(auth={"revokeIssued": True})
    c.versions.get(agent_id="GHT7YRWXPL", version="draft")
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
        c.versions.get(agent_id="GHT7YRWXPL", version="draft")


async def test_oauth_steps_need_oauth_mode(mock: Mock) -> None:
    c = signed_in(mock, cc_auth())
    with pytest.raises(CaitlynAuthError) as info:
        c.auth.authorization_url(redirect_uri=REDIRECT)
    assert info.value.code == "invalid_request"
