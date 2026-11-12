"""Errors. Every HTTP error is read as RFC 9457 problem details (application/problem+json)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, ClassVar


class CaitlynError(Exception):
    """An error response from the Caitlyn API, read from its RFC 9457 problem details.

    Generated subclasses (``NotFoundError``, ``TooManyRequestsError``…) are chosen by HTTP status
    from the operation's and the service's modelled errors. ``code`` is the stable, documented code
    (for example ``NOT_FOUND``); match on it, not on ``title`` or ``detail``."""

    http_status: ClassVar[int | None] = None
    retryable: ClassVar[bool] = False
    throttling: ClassVar[bool] = False
    members: ClassVar[tuple[tuple[str, str, str], ...]] = ()
    """Modelled members beyond the problem-details fields: (attribute, "header" | "body", wire name)."""

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: str,
        title: str = "",
        detail: str | None = None,
        type: str | None = None,
        request_id: str | None = None,
        retry_after_seconds: float | None = None,
        errors: Sequence[Mapping[str, Any]] = (),
        raw: Mapping[str, Any] | None = None,
        raw_body: str = "",
        raw_body_truncated: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail
        self.type = type
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds
        self.errors: tuple[Mapping[str, Any], ...] = tuple(errors)
        """Field-level problems on a 400 ``VALIDATION_FAILED``: each has ``code`` and a ``pointer`` (JSON
        Pointer into the body) or a ``parameter`` (query parameter), and may have ``detail``."""
        self.raw: Mapping[str, Any] = raw or {}
        """The problem body as received, unknown fields included; empty when the body is not a JSON object."""
        self.raw_body = raw_body
        """The response body as received, as text: the only view of a body that is not problem details (a
        proxy's or a web framework's own error page). At most its first 8 KiB; empty for an empty body and for
        errors the SDK raises."""
        self.raw_body_truncated = raw_body_truncated
        """True when the body was longer than 8 KiB and ``raw_body`` holds only its first 8 KiB."""


class CaitlynConnectionError(CaitlynError):
    """No HTTP response arrived (the connection was refused or reset, DNS or TLS failed, or it timed out
    before the headers), or the connection failed while the body was read (PROTOCOL.md 6.5). ``status`` is 0
    and ``code`` is ``CONNECTION_ERROR``; the httpx error is the ``__cause__``. Raised after the retries."""


class StreamLostError(CaitlynError):
    """A server-sent events stream dropped and could not be resumed."""


class NotSupportedByServer(Exception):
    """The operation, or a member that was set, is newer than the server's Caitlyn-Api-Version.
    Raised before anything is sent."""

    def __init__(self, operation: str, requires: str, server: str) -> None:
        super().__init__(f"{operation} requires Caitlyn {requires}; the server is {server}")
        self.operation = operation
        self.requires = requires
        self.server = server
