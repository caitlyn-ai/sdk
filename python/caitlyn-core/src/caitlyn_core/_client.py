"""The transport cores the generated ``Caitlyn`` and ``AsyncCaitlyn`` clients delegate to: one call
loop each (sync on ``httpx.Client``, async on ``httpx.AsyncClient``) with the same rules."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import platform
import random
import time
from collections.abc import AsyncIterator, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Self

import httpx
from opentelemetry.trace import Span, TracerProvider

from ._errors import CaitlynConnectionError, CaitlynError, StreamLostError
from ._hooks import CallContext, Interceptor, Telemetry, record_failure
from ._models import CaitlynEvent, CaitlynModel
from ._protocol import (
    API_VERSION_HEADER,
    REQUEST_ID_HEADER,
    SDK_MODEL_HEADER,
    build_request,
    check_since,
    error_from_problem,
    read_error,
    read_result,
    with_idempotency_token,
)
from ._retry import NO_RESPONSE_RETRY_COST, RETRY_COST, RetryBudget, RetryPolicy, error_retry_delay, transport_retry_delay
from ._spec import OperationSpec
from ._sse import SseDecoder, SseMessage
from .auth import AsyncAuthSession, Auth, SyncAuthSession, workspace_host

USER_AGENT_PREFIX = "caitlyn-sdk-python"


def workspace_endpoint(workspace: str) -> str:
    """The base URL of a workspace's API: its hostname, over HTTPS, with the /api prefix every Caitlyn
    route has. Operation paths (``/v3/…``) are appended to it."""
    return f"https://{workspace_host(workspace)}/api"


@dataclass(frozen=True, slots=True)
class ClientConfig:
    endpoint: str
    auth: Auth | httpx.Auth | None
    """A sign-in mode (``caitlyn_core.auth``), which the client binds to its workspace, or any ``httpx.Auth``."""
    sdk_version: str
    sdk_model: str
    """The model version the SDK was generated from (the highest @since); sent as Caitlyn-Sdk-Model."""
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    timeout: float | httpx.Timeout = 60.0
    tracer_provider: TracerProvider | None = None
    interceptors: tuple[Interceptor, ...] = ()
    app_id: str | None = None
    """Appended to the user agent as ``app/<app_id>``. Declared only; never used for authorisation."""
    max_reconnects: int = 3
    workspace: str = ""
    """The workspace hostname: it sets the token audience, ``https://<workspace>/api``, whatever the endpoint."""

    @classmethod
    def create(
        cls,
        *,
        workspace: str | None,
        endpoint: str | None,
        auth: Auth | httpx.Auth | None,
        sdk_version: str,
        sdk_model: str,
        max_attempts: int | None,
        max_retry_delay: float | None,
        retry: RetryPolicy | None,
        retry_budget: int | None = None,
        timeout: float | httpx.Timeout,
        tracer_provider: TracerProvider | None,
        interceptors: Sequence[Interceptor],
        app_id: str | None,
    ) -> ClientConfig:
        # Endpoints, retries and timeouts come from these options only: no environment, no AWS configuration.
        if endpoint is None:
            if workspace is None:
                raise ValueError("Pass workspace= (for example 'your-company.getcaitlyn.ai') or endpoint=")
            endpoint = workspace_endpoint(workspace)
        # The audience comes from the workspace; with only an endpoint, from the endpoint's host.
        host = workspace_host(workspace) if workspace is not None else httpx.URL(endpoint).host
        policy = retry or RetryPolicy()
        if max_attempts is not None:
            policy = dataclasses.replace(policy, max_attempts=max_attempts)
        if max_retry_delay is not None:
            policy = dataclasses.replace(policy, max_retry_delay=max_retry_delay)
        if retry_budget is not None:
            policy = dataclasses.replace(policy, retry_budget=retry_budget)
        return cls(
            endpoint=endpoint.rstrip("/"),
            auth=auth,
            sdk_version=sdk_version,
            sdk_model=sdk_model,
            retry=policy,
            timeout=timeout,
            tracer_provider=tracer_provider,
            interceptors=tuple(interceptors),
            app_id=app_id,
            workspace=host,
        )

    def headers(self) -> dict[str, str]:
        """PROTOCOL.md 3.1: the user agent and Caitlyn-Sdk-Model (Caitlyn-Api-Version is never sent)."""
        major, minor = platform.python_version_tuple()[:2]
        ua = (
            f"{USER_AGENT_PREFIX}/{self.sdk_version} lang/python#{major}.{minor} "
            f"md/{platform.python_implementation().lower()}#{platform.python_version()}"
        )
        if self.app_id:
            ua += f" app/{self.app_id}"
        return {"User-Agent": ua, SDK_MODEL_HEADER: self.sdk_model}


class _Call:
    """A call in progress: its context, span and hooks, finished exactly once."""

    def __init__(self, core: _CoreBase, spec: OperationSpec, params: dict[str, object]) -> None:
        self.core = core
        self.context = CallContext(spec, params)
        self.span: Span = core.telemetry.start_call(spec)
        self._done = False

    def finish(self, error: BaseException | None) -> None:
        if self._done:
            return
        self._done = True
        try:
            for hook in self.core.config.interceptors:
                hook.after_call(self.context, error)
        finally:
            Telemetry.end_call(self.span, error)


class _CoreBase:
    def __init__(self, config: ClientConfig) -> None:
        self.config = config
        self.telemetry = Telemetry(config.tracer_provider, config.sdk_version)
        self.retry_budget = RetryBudget(config.retry.retry_budget)
        """The retry tokens this client's calls share (PROTOCOL.md 6.4.6)."""
        self.server_api_version: str | None = None
        """The Caitlyn-Api-Version the server last reported; @since checks compare against it."""
        self._headers = config.headers()

    def _begin(self, spec: OperationSpec, params: Mapping[str, object]) -> _Call:
        check_since(spec, params, self.server_api_version)
        call = _Call(self, spec, with_idempotency_token(spec, params))
        try:
            for hook in self.config.interceptors:
                hook.before_call(call.context)
        except BaseException as e:
            call.finish(e)
            raise
        return call

    def _request_for(self, http: httpx.Client | httpx.AsyncClient, call: _Call, accept: str | None) -> tuple[httpx.Request, Span]:
        headers = self._headers if accept is None else {**self._headers, "Accept": accept}
        request = build_request(http, self.config.endpoint, call.context.operation, call.context.params, headers)
        span = self.telemetry.start_attempt(call.span, request, call.context.attempt)
        for hook in self.config.interceptors:
            hook.before_attempt(call.context, request)
        return request, span

    def _after_attempt(
        self,
        call: _Call,
        span: Span,
        request: httpx.Request,
        response: httpx.Response | None,
        error: BaseException | None,
        failure: BaseException | None = None,
    ) -> None:
        """Ends the attempt. ``error`` is what interceptors see (the transport error, or None with a response);
        ``failure`` is what the attempt span records (PROTOCOL.md 13): the error the attempt produced."""
        request_id = Telemetry.end_attempt(span, call.span, response, failure or error, REQUEST_ID_HEADER)
        if request_id:
            call.context.request_id = request_id
        if response is not None and (version := response.headers.get(API_VERSION_HEADER)):
            self.server_api_version = version
        for hook in self.config.interceptors:
            hook.after_attempt(call.context, request, response, error)

    @staticmethod
    def _connection_error(spec: OperationSpec, error: httpx.TransportError) -> CaitlynConnectionError:
        """PROTOCOL.md 6.5: no response, or the connection failed while the body was read. Raised ``from`` the
        httpx error, which stays the ``__cause__``."""
        return CaitlynConnectionError(f"{spec.name}: {type(error).__name__}: {error}", status=0, code="CONNECTION_ERROR", title=str(error))


def _accept(spec: OperationSpec) -> str | None:
    return "text/event-stream" if spec.streaming else None


# --------------------------------------------------------------------------- sync


class SyncClientCore(_CoreBase):
    def __init__(self, config: ClientConfig, http_client: httpx.Client | None = None) -> None:
        super().__init__(config)
        # Requests carry absolute URLs (build_request), so a caller's own client needs no base_url.
        self._http = http_client or httpx.Client(timeout=config.timeout)
        self._owns_http = http_client is None
        a = config.auth
        self.auth = SyncAuthSession(a if isinstance(a, Auth) else None, config.endpoint, config.workspace, self._http)
        """The client's sign-in: its token, and the ``OAuth`` mode's sign-in steps."""
        self._send_auth: httpx.Auth | None = self.auth if isinstance(a, Auth) else a

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def send(self, spec: OperationSpec, params: Mapping[str, object]) -> tuple[httpx.Response, _Call]:
        """Send with retries. The response is open (body unread) for streaming operations."""
        call = self._begin(spec, params)
        policy = self.config.retry
        retry_cost: int | None = None  # the cost of this call's last retry (PROTOCOL.md 6.4.6)
        try:
            while True:
                request, span = self._request_for(self._http, call, _accept(spec))
                try:
                    response = self._http.send(request, auth=self._send_auth or httpx.USE_CLIENT_DEFAULT, stream=True)
                except httpx.TransportError as e:
                    connection = self._connection_error(spec, e)
                    self._after_attempt(call, span, request, None, e, connection)
                    delay = transport_retry_delay(policy, spec.retry_safe, call.context.attempt, e)
                    if delay is None or not self.retry_budget.acquire(NO_RESPONSE_RETRY_COST):
                        raise connection from e
                    retry_cost = NO_RESPONSE_RETRY_COST
                    time.sleep(delay)
                    call.context.attempt += 1
                    continue
                except BaseException as e:  # signing in failed, or interrupted while waiting
                    self._after_attempt(call, span, request, None, e)
                    raise
                if not response.is_success or not spec.streaming:
                    try:
                        response.read()
                    except httpx.TransportError as e:  # after response bytes arrived: never retried
                        response.close()
                        connection = self._connection_error(spec, e)
                        self._after_attempt(call, span, request, response, None, connection)
                        raise connection from e
                error = None if response.is_success else read_error(spec, response)
                self._after_attempt(call, span, request, response, None, error)
                if error is None:
                    self.retry_budget.release(retry_cost)
                    return response, call
                response.close()
                delay = error_retry_delay(policy, spec.retry_safe, call.context.attempt, error)
                if delay is None or not self.retry_budget.acquire(RETRY_COST):
                    raise error
                retry_cost = RETRY_COST
                time.sleep(delay)
                call.context.attempt += 1
        except BaseException as e:
            call.finish(e)
            raise

    def request[M: CaitlynModel](self, spec: OperationSpec, params: Mapping[str, object], result: type[M]) -> M:
        response, call = self.send(spec, params)
        try:
            model = read_result(spec, response, result)
        except BaseException as e:
            call.finish(e)
            raise
        call.finish(None)
        return model

    def stream[E: CaitlynEvent, F](
        self, spec: OperationSpec, params: Mapping[str, object], decoder: EventDecoder[E, F], resume: Resume | None = None
    ) -> EventStream[E, F]:
        return EventStream(self, spec, dict(params), decoder, resume)

    def put_presigned(self, method: str, url: str, headers: Mapping[str, str], content: bytes) -> None:
        """Send bytes to a presigned URL: no Caitlyn auth or headers (the URL carries its own grant)."""
        span = self.telemetry.start_upload(method, url)
        try:
            response = self._http.request(method, url, headers=dict(headers), content=content, auth=None)
            span.set_attribute("http.response.status_code", response.status_code)
            _check_put(response)
        except BaseException as e:
            record_failure(span, e)
            raise
        finally:
            span.end()


# --------------------------------------------------------------------------- async


class AsyncClientCore(_CoreBase):
    def __init__(self, config: ClientConfig, http_client: httpx.AsyncClient | None = None) -> None:
        super().__init__(config)
        # Requests carry absolute URLs (build_request), so a caller's own client needs no base_url.
        self._http = http_client or httpx.AsyncClient(timeout=config.timeout)
        self._owns_http = http_client is None
        a = config.auth
        self.auth = AsyncAuthSession(a if isinstance(a, Auth) else None, config.endpoint, config.workspace, self._http)
        """The client's sign-in: its token, and the ``OAuth`` mode's sign-in steps."""
        self._send_auth: httpx.Auth | None = self.auth if isinstance(a, Auth) else a

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def send(self, spec: OperationSpec, params: Mapping[str, object]) -> tuple[httpx.Response, _Call]:
        call = self._begin(spec, params)
        policy = self.config.retry
        retry_cost: int | None = None  # the cost of this call's last retry (PROTOCOL.md 6.4.6)
        try:
            while True:
                request, span = self._request_for(self._http, call, _accept(spec))
                try:
                    response = await self._http.send(request, auth=self._send_auth or httpx.USE_CLIENT_DEFAULT, stream=True)
                except httpx.TransportError as e:
                    connection = self._connection_error(spec, e)
                    self._after_attempt(call, span, request, None, e, connection)
                    delay = transport_retry_delay(policy, spec.retry_safe, call.context.attempt, e)
                    if delay is None or not self.retry_budget.acquire(NO_RESPONSE_RETRY_COST):
                        raise connection from e
                    retry_cost = NO_RESPONSE_RETRY_COST
                    await asyncio.sleep(delay)
                    call.context.attempt += 1
                    continue
                except BaseException as e:  # cancelled while waiting for the response
                    self._after_attempt(call, span, request, None, e)
                    raise
                if not response.is_success or not spec.streaming:
                    try:
                        await response.aread()
                    except httpx.TransportError as e:  # after response bytes arrived: never retried
                        connection = self._connection_error(spec, e)
                        self._after_attempt(call, span, request, response, None, connection)
                        raise connection from e
                    finally:
                        await response.aclose()
                error = None if response.is_success else read_error(spec, response)
                self._after_attempt(call, span, request, response, None, error)
                if error is None:
                    self.retry_budget.release(retry_cost)
                    return response, call
                delay = error_retry_delay(policy, spec.retry_safe, call.context.attempt, error)
                if delay is None or not self.retry_budget.acquire(RETRY_COST):
                    raise error
                retry_cost = RETRY_COST
                await asyncio.sleep(delay)
                call.context.attempt += 1
        except BaseException as e:
            call.finish(e)
            raise

    async def request[M: CaitlynModel](self, spec: OperationSpec, params: Mapping[str, object], result: type[M]) -> M:
        response, call = await self.send(spec, params)
        try:
            model = read_result(spec, response, result)
        except BaseException as e:
            call.finish(e)
            raise
        call.finish(None)
        return model

    def stream[E: CaitlynEvent, F](
        self, spec: OperationSpec, params: Mapping[str, object], decoder: EventDecoder[E, F], resume: Resume | None = None
    ) -> AsyncEventStream[E, F]:
        return AsyncEventStream(self, spec, dict(params), decoder, resume)

    async def put_presigned(self, method: str, url: str, headers: Mapping[str, str], content: bytes) -> None:
        span = self.telemetry.start_upload(method, url)
        try:
            response = await self._http.request(method, url, headers=dict(headers), content=content, auth=None)
            span.set_attribute("http.response.status_code", response.status_code)
            _check_put(response)
        except BaseException as e:
            record_failure(span, e)
            raise
        finally:
            span.end()


def _check_put(response: httpx.Response) -> None:
    if response.status_code >= 300:
        raise CaitlynError(
            f"{response.status_code} UPLOAD_PUT_FAILED",
            status=response.status_code,
            code="UPLOAD_PUT_FAILED",
            title="Upload of bytes failed",
            detail=response.text[:500] or None,
        )


# --------------------------------------------------------------------------- server-sent events


@dataclass(frozen=True, slots=True)
class EventDecoder[E: CaitlynEvent, F]:
    """How to read one SSE operation's events, generated from ``@sseEvents``."""

    events: Mapping[str, type[E]]
    """SSE ``event:`` name to event class. Names not listed are skipped."""
    final: Callable[[E], F | None]
    """The final result carried by an event, if it is the final event."""
    error_event: type[E] | None = None
    """An event that ends the stream with a problem-details error."""
    has_final: bool = False
    """Whether the stream ends at a final event (SendMessage), or is open-ended (a watch)."""


@dataclass(frozen=True, slots=True)
class Resume:
    """The operation that re-attaches to the stream, its parameters, and the parameter that takes
    the last event ID (bound to the Last-Event-ID header)."""

    operation: OperationSpec
    params: Mapping[str, object]
    last_event_id_param: str


LONG_CONNECTION_SECONDS = 60.0
"""A connection that stayed open at least this long before it ended restarts the reconnect count (PROTOCOL.md 5.6)."""


def stream_clock() -> float:
    """The clock that times each connection, for the rule above, in seconds. Replace it only in tests (set
    ``caitlyn_core._client.stream_clock``): the conformance cases step it so that a connection lasts an hour, or under a
    minute, without waiting."""
    return time.monotonic()


class _StreamState[E: CaitlynEvent, F]:
    def __init__(self, spec: OperationSpec, params: dict[str, object], decoder: EventDecoder[E, F], resume: Resume | None, max_reconnects: int) -> None:
        self.spec, self.params, self.decoder, self.resume, self.max_reconnects = spec, params, decoder, resume, max_reconnects
        self.sse = SseDecoder()
        self.seen: set[str] = set()
        self.last_event_id: str | None = None
        self.final: F | None = None
        self.done = False
        self.reconnects = 0
        """Reconnects so far, in all."""
        self.attempts = 0
        """Reconnects since the last event: at most max_reconnects in a row (PROTOCOL.md 5.6)."""
        self.ended_by_reset = False
        self.request_id: str | None = None
        self.opened_at: float | None = None
        """When the current connection's response arrived, on stream_clock; None between connections."""

    def connected(self) -> None:
        self.opened_at = stream_clock()

    def disconnected(self) -> None:
        """A connection that stayed open a minute or more starts the count again, like a new event: the server ends
        every stream within an hour, and a quiet watch must outlive that (PROTOCOL.md 5.6)."""
        if self.opened_at is not None and stream_clock() - self.opened_at >= LONG_CONNECTION_SECONDS:
            self.attempts = 0
        self.opened_at = None

    def reconnecting(self) -> float:
        """Counts a reconnect and returns how long to wait before it (PROTOCOL.md 5.6): an exponential backoff
        with jitter, 0.25-0.5 s, then 0.5-1 s, then 1-2 s, so each pause in a row is longer than the last."""
        self.reconnects += 1
        self.attempts += 1
        return min(8.0, 0.5 * 2 ** (self.attempts - 1)) * random.uniform(0.5, 1.0)

    def opening(self) -> tuple[OperationSpec, Mapping[str, object]]:
        if self.reconnects == 0 or self.resume is None:
            return self.spec, self.params
        self.sse = SseDecoder()
        params = dict(self.resume.params)
        if self.last_event_id is not None:
            # Last-Event-ID carries the position: a watch's own `after` cursor is left out (PROTOCOL.md 5.6). Before
            # any event, the header is left out and the request is sent as it was.
            params.pop("after", None)
            params[self.resume.last_event_id_param] = self.last_event_id
        return self.resume.operation, params

    def accept(self, message: SseMessage) -> E | None:
        if message.own_id and message.id is not None:
            if message.id in self.seen:
                return None
            self.seen.add(message.id)
            self.last_event_id = message.id
            self.attempts = 0  # only a new event counts as progress (PROTOCOL.md 5.6)
        cls = self.decoder.events.get(message.event)
        if cls is None:
            return None  # an event type this SDK does not know: skipped
        try:
            data: Any = json.loads(message.data) if message.data else {}
        except ValueError:
            data = {}
        event = cls.from_wire(data)
        event.event_id = message.id if message.own_id else None
        if message.event == "stream.reset" and self.decoder.has_final and self.reconnects > 0:
            # PROTOCOL.md 5.9: the answer finished while the stream was disconnected, so its final event went to
            # the earlier connection. The stream ends at the reset, with no error and no further reconnect.
            self.ended_by_reset = True
        if self.decoder.has_final and self.decoder.error_event is not None and isinstance(event, self.decoder.error_event):
            # PROTOCOL.md 5.5: a failure event ends only a stream with a final event. On a watch it is delivered.
            raise error_from_problem(self.spec, 0, event.raw)
        final = self.decoder.final(event)
        if final is not None:
            self.final = final
        return event

    def can_resume(self) -> bool:
        return self.resume is not None and self.attempts < self.max_reconnects

    def finished(self) -> bool:
        """The stream has ended on its own: at its final event (5.4), or at a reset that took its place (5.9)."""
        return self.final is not None or self.ended_by_reset

    def ended_cleanly(self) -> bool:
        """At a clean end of the response: whether the stream ends there. It does when it has finished, or when
        the operation cannot resume (5.7, 5.9). Otherwise it reconnects (5.6, 5.7), or fails with STREAM_LOST
        once can_resume() says no."""
        return self.finished() or self.resume is None

    def lost(self, cause: BaseException | None) -> StreamLostError:
        return StreamLostError(
            f"{self.spec.name}: stream dropped after {self.reconnects} reconnects (last event {self.last_event_id})",
            status=0,
            code="STREAM_LOST",
            title=str(cause) if cause else "Stream ended early",
            request_id=self.request_id,
        )

    def missing_final(self) -> CaitlynError:
        return CaitlynError(f"{self.spec.name}: stream ended without its final event", status=0, code="NO_FINAL_EVENT", request_id=self.request_id)


class EventStream[E: CaitlynEvent, F]:
    """A server-sent events stream: ``with … as stream: for event in stream``. Unknown event types
    are skipped; a dropped connection is resumed with Last-Event-ID and duplicates are discarded.
    Events arrive as the server sends them."""

    def __init__(self, core: SyncClientCore, spec: OperationSpec, params: dict[str, object], decoder: EventDecoder[E, F], resume: Resume | None) -> None:
        self._core = core
        self._state = _StreamState(spec, params, decoder, resume, core.config.max_reconnects)
        self._response: httpx.Response | None = None
        self._call: _Call | None = None

    @property
    def last_event_id(self) -> str | None:
        return self._state.last_event_id

    @property
    def reconnects(self) -> int:
        return self._state.reconnects

    @property
    def request_id(self) -> str | None:
        return self._state.request_id

    def _open(self) -> httpx.Response:
        if self._response is None:
            spec, params = self._state.opening()
            self._response, self._call = self._core.send(spec, params)
            self._state.connected()
            self._state.request_id = self._response.headers.get(REQUEST_ID_HEADER)
        return self._response

    def _release(self, error: BaseException | None) -> None:
        if self._response is not None:
            self._response.close()
            self._response = None
            self._state.disconnected()
        if self._call is not None:
            self._call.finish(error)
            self._call = None

    def __enter__(self) -> Self:
        self._open()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the connection now. Safe to call more than once."""
        self._release(None)

    def __iter__(self) -> Iterator[E]:
        state = self._state
        while not state.done:
            response = self._open()
            try:
                for chunk in response.iter_bytes():
                    for message in state.sse.feed(chunk):
                        event = state.accept(message)
                        if event is not None:
                            yield event
                        if state.finished():
                            break
                    if state.finished():
                        # PROTOCOL.md 5.4: the stream ends at its final event, whether or not the response does. A
                        # resumed answer arrives on WatchConversation, which carries on after it until it is closed.
                        break
            except httpx.TransportError as e:
                self._release(e)
                if not state.can_resume():
                    raise state.lost(e) from e
                time.sleep(state.reconnecting())
                continue
            except BaseException as e:
                self._release(e)
                raise
            self._release(None)
            if state.ended_cleanly():
                state.done = True
            elif not state.can_resume():
                raise state.lost(None)
            else:
                time.sleep(state.reconnecting())

    def final_message(self) -> F:
        """Read the rest of the stream and return its final result."""
        for _ in self:
            pass
        if self._state.final is None:
            raise self._state.missing_final()
        return self._state.final


class AsyncEventStream[E: CaitlynEvent, F]:
    """``async with … as stream: async for event in stream``. As ``EventStream``; cancelling the task
    that reads it closes the connection."""

    def __init__(self, core: AsyncClientCore, spec: OperationSpec, params: dict[str, object], decoder: EventDecoder[E, F], resume: Resume | None) -> None:
        self._core = core
        self._state = _StreamState(spec, params, decoder, resume, core.config.max_reconnects)
        self._response: httpx.Response | None = None
        self._call: _Call | None = None

    @property
    def last_event_id(self) -> str | None:
        return self._state.last_event_id

    @property
    def reconnects(self) -> int:
        return self._state.reconnects

    @property
    def request_id(self) -> str | None:
        return self._state.request_id

    async def _open(self) -> httpx.Response:
        if self._response is None:
            spec, params = self._state.opening()
            self._response, self._call = await self._core.send(spec, params)
            self._state.connected()
            self._state.request_id = self._response.headers.get(REQUEST_ID_HEADER)
        return self._response

    async def _release(self, error: BaseException | None) -> None:
        response, self._response = self._response, None
        call, self._call = self._call, None
        if response is not None:
            self._state.disconnected()
        try:
            if response is not None:
                await response.aclose()
        finally:
            if call is not None:
                call.finish(error)

    async def __aenter__(self) -> Self:
        await self._open()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the connection now. Safe to call more than once."""
        await self._release(None)

    async def __aiter__(self) -> AsyncIterator[E]:
        state = self._state
        while not state.done:
            response = await self._open()
            try:
                async for chunk in response.aiter_bytes():
                    for message in state.sse.feed(chunk):
                        event = state.accept(message)
                        if event is not None:
                            yield event
                        if state.finished():
                            break
                    if state.finished():
                        # PROTOCOL.md 5.4: the stream ends at its final event, whether or not the response does. A
                        # resumed answer arrives on WatchConversation, which carries on after it until it is closed.
                        break
            except httpx.TransportError as e:
                await self._release(e)
                if not state.can_resume():
                    raise state.lost(e) from e
                await asyncio.sleep(state.reconnecting())
                continue
            except BaseException as e:
                await self._release(e)
                raise
            await self._release(None)
            if state.ended_cleanly():
                state.done = True
            elif not state.can_resume():
                raise state.lost(None)
            else:
                await asyncio.sleep(state.reconnecting())

    async def final_message(self) -> F:
        """Read the rest of the stream and return its final result."""
        async for _ in self:
            pass
        if self._state.final is None:
            raise self._state.missing_final()
        return self._state.final

