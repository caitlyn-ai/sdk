"""Python conformance harness: the protocol cases in conformance/cases/protocol.json and the example cases in
conformance/cases/examples.json, against the mock server. Each test's id starts with the case id in square
brackets (pytest's `ids`); scripts/check-conformance.mjs checks that every case ran and passed."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterable, Awaitable, Callable
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, TypeVar, cast

import caitlyn
import pytest
from caitlyn import (
    AsyncCaitlyn,
    CaitlynError,
    ConflictError,
    NotFoundError,
    NotSupportedByServer,
    PreconditionFailedError,
    ServiceUnavailableError,
    ValidationError,
)
from caitlyn import _operations as operations  # pyright: ignore[reportPrivateUsage]
from caitlyn.auth import Token
from caitlyn_core import workspace_endpoint
from conftest import ROOT, Mock
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

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
        assert re.fullmatch(r"caitlyn-sdk-python/0\.0\.1 lang/python#3\.\d+ md/[a-z]+#3\.\d+\.\d+", r["headers"]["user-agent"])
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


@case("telemetry.spans")
async def test_telemetry(mock: Mock, case_id: str) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}]})
    await client(mock, tracer_provider=provider).versions.get(agent_id="GHT7YRWXPL", version="draft")
    spans = exporter.get_finished_spans()
    call = next(s for s in spans if s.name == "caitlyn GetAgentVersion")
    assert call.context is not None
    attempts = [s for s in spans if s.parent and s.parent.span_id == call.context.span_id]
    assert [(s.attributes or {})["http.request.resend_count"] for s in attempts] == [0, 1]
    assert (call.attributes or {})["caitlyn.request_id"] == mock.api()[-1]["requestId"]
    assert all("traceparent" in r["headers"] for r in mock.api())


@case("endpoint.workspace")
async def test_endpoint(mock: Mock, case_id: str) -> None:
    assert workspace_endpoint("your-company.getcaitlyn.ai") == "https://your-company.getcaitlyn.ai/api"
    c = AsyncCaitlyn(workspace="your-company.getcaitlyn.ai", auth=Token("pat_test"))
    assert str(c._core._http.base_url) == "https://your-company.getcaitlyn.ai/api/"  # pyright: ignore[reportPrivateUsage]
    await c.aclose()


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
