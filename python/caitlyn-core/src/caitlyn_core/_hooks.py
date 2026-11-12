"""Interceptor hooks and OpenTelemetry spans (OTel API only: no SDK, no exporter)."""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from typing import Any

import httpx
from opentelemetry import propagate, trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode, TracerProvider

from ._spec import OperationSpec


@dataclass(slots=True)
class CallContext:
    """One SDK call, across all its attempts. ``properties`` is free for interceptors to use."""

    operation: OperationSpec
    params: dict[str, object]
    attempt: int = 0
    request_id: str | None = None
    properties: dict[str, Any] = field(default_factory=dict[str, Any])


class Interceptor:
    """Subclass and override the hooks you need. Hooks run in the order given to the client, in
    both the sync and the async client. An exception raised in a hook propagates unchanged."""

    def before_call(self, context: CallContext) -> None:
        """Before anything is sent, after the @since check and idempotency key."""

    def before_attempt(self, context: CallContext, request: httpx.Request) -> None:
        """The request may be changed in place (headers, URL)."""

    def after_attempt(self, context: CallContext, request: httpx.Request, response: httpx.Response | None, error: BaseException | None) -> None:
        """After each attempt, with its response (body not yet read for streams) or its transport error."""

    def after_call(self, context: CallContext, error: BaseException | None) -> None:
        """After the call finished, successfully or not. For a stream: when the stream ends or closes."""


class Telemetry:
    """The spans every SDK emits (PROTOCOL.md 13): ``caitlyn.call`` per call, a ``caitlyn.attempt`` child per HTTP
    attempt with ``traceparent`` injected from it, and ``caitlyn.upload`` for an upload's bytes."""

    def __init__(self, tracer_provider: TracerProvider | None, version: str) -> None:
        provider = tracer_provider or trace.get_tracer_provider()
        self._tracer = provider.get_tracer("caitlyn-sdk-python", version)

    def start_call(self, spec: OperationSpec) -> Span:
        return self._tracer.start_span("caitlyn.call", kind=SpanKind.CLIENT, attributes={"rpc.system": "caitlyn", "rpc.method": spec.name})

    def start_attempt(self, call: Span, request: httpx.Request, attempt: int) -> Span:
        span = self._tracer.start_span(
            "caitlyn.attempt",
            context=trace.set_span_in_context(call),
            kind=SpanKind.CLIENT,
            attributes={**http_attributes(request.method, request.url), "http.request.resend_count": attempt},
        )
        carrier: dict[str, str] = {}
        propagate.inject(carrier, context=trace.set_span_in_context(span))
        for k, v in carrier.items():
            request.headers[k] = v
        return span

    @staticmethod
    def end_attempt(span: Span, call: Span, response: httpx.Response | None, error: BaseException | None, request_id_header: str) -> str | None:
        request_id: str | None = None
        if response is not None:
            span.set_attribute("http.response.status_code", response.status_code)
            request_id = response.headers.get(request_id_header)
            if request_id:
                span.set_attribute("caitlyn.request_id", request_id)
                call.set_attribute("caitlyn.request_id", request_id)
            api_version = response.headers.get("Caitlyn-Api-Version")
            if api_version:
                span.set_attribute("caitlyn.server.api_version", api_version)
        if error is not None:
            record_failure(span, error)
        span.end()
        return request_id

    @staticmethod
    def end_call(span: Span, error: BaseException | None) -> None:
        if error is not None:
            record_failure(span, error)
        span.end()

    def start_upload(self, method: str, url: str) -> Span:
        return self._tracer.start_span("caitlyn.upload", kind=SpanKind.CLIENT, attributes=http_attributes(method, httpx.URL(url)))


def http_attributes(method: str, url: httpx.URL) -> dict[str, str]:
    """``http.request.method``, ``server.address`` and ``url.full``. The URL loses its query, fragment and user
    information, which can carry secrets (a presigned URL's signature)."""
    return {
        "http.request.method": method,
        "server.address": url.host,
        "url.full": str(url.copy_with(query=None, fragment=None, userinfo=b"")),
    }


def record_failure(span: Span, error: BaseException) -> None:
    """Status (with the error's message), ``error.type`` (the error's class name), ``caitlyn.error.code`` and an
    exception event whose ``exception.type`` is that class name too, as in every SDK. (``span.record_exception``
    would qualify it with the module, ``caitlyn.errors.NotFoundError``.)"""
    span.add_event(
        "exception",
        {
            "exception.type": type(error).__name__,
            "exception.message": str(error),
            "exception.stacktrace": "".join(traceback.format_exception(error)),
        },
    )
    span.set_status(Status(StatusCode.ERROR, str(error)))
    span.set_attribute("error.type", type(error).__name__)
    code = getattr(error, "code", None)
    if isinstance(code, str):
        span.set_attribute("caitlyn.error.code", code)
