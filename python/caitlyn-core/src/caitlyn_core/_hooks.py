"""Interceptor hooks and OpenTelemetry spans (OTel API only: no SDK, no exporter)."""

from __future__ import annotations

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
    """One span per call (``caitlyn <Operation>``) and one child span per HTTP attempt, with
    ``traceparent`` injected from the attempt's span."""

    def __init__(self, tracer_provider: TracerProvider | None, version: str) -> None:
        provider = tracer_provider or trace.get_tracer_provider()
        self._tracer = provider.get_tracer("caitlyn-sdk-python", version)

    def start_call(self, spec: OperationSpec) -> Span:
        return self._tracer.start_span(
            f"caitlyn {spec.name}", kind=SpanKind.CLIENT, attributes={"caitlyn.operation": spec.name, "rpc.system": "caitlyn"}
        )

    def start_attempt(self, call: Span, request: httpx.Request, attempt: int) -> Span:
        span = self._tracer.start_span(
            f"HTTP {request.method}",
            context=trace.set_span_in_context(call),
            kind=SpanKind.CLIENT,
            attributes={
                "http.request.method": request.method,
                "url.full": str(request.url.copy_with(query=None)),
                "http.request.resend_count": attempt,
            },
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
            if response.status_code >= 400:
                span.set_status(Status(StatusCode.ERROR))
        if error is not None:
            span.set_status(Status(StatusCode.ERROR))
            span.set_attribute("error.type", type(error).__name__)
        span.end()
        return request_id

    @staticmethod
    def end_call(span: Span, error: BaseException | None) -> None:
        if error is not None:
            span.set_status(Status(StatusCode.ERROR))
            span.set_attribute("error.type", type(error).__name__)
            code = getattr(error, "code", None)
            if isinstance(code, str):
                span.set_attribute("caitlyn.error.code", code)
        span.end()
