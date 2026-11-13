"""ai.caitlyn.protocols#restJson: HTTP bindings as restJson1, RFC 9457 errors chosen by status,
Caitlyn-Request-Id, unknown fields kept. Shared by the sync and async clients (no I/O here)."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from enum import Enum
from typing import Any, cast
from urllib.parse import quote

import httpx
import pydantic
from pydantic import BaseModel

from ._errors import CaitlynError, NotSupportedByServer
from ._models import CaitlynModel, CaitlynResult, FieldError, ResponseMetadata
from ._retry import parse_retry_after
from ._spec import OperationSpec

REQUEST_ID_HEADER = "Caitlyn-Request-Id"
API_VERSION_HEADER = "Caitlyn-Api-Version"
"""A response header only: the server's model version."""
SDK_MODEL_HEADER = "Caitlyn-Sdk-Model"


def to_wire(value: object) -> Any:
    """A Python value as JSON: models by wire name, enums by value, timestamps as RFC 3339."""
    if isinstance(value, CaitlynModel):
        return value.to_wire()
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, Enum):
        return cast(object, value.value)
    if isinstance(value, datetime):
        return _rfc3339(value)
    if isinstance(value, bytes):
        return base64.b64encode(value).decode()
    if isinstance(value, Mapping):
        return {str(k): to_wire(v) for k, v in cast(Mapping[object, object], value).items()}
    if isinstance(value, (list, tuple)):
        return [to_wire(v) for v in cast(Sequence[object], value)]
    return value


def _rfc3339(value: datetime) -> str:
    """RFC 3339 date-time with milliseconds and Z (PROTOCOL.md 3)."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _text(value: object) -> str:
    wire = to_wire(value)
    if isinstance(wire, bool):
        return "true" if wire else "false"
    return str(wire)


def with_idempotency_token(spec: OperationSpec, params: Mapping[str, object]) -> dict[str, object]:
    """Fill an unset @idempotencyToken member once per call, so every retry sends the same key."""
    out = dict(params)
    for m in spec.members:
        if m.idempotency_token and out.get(m.name) is None:
            out[m.name] = str(uuid.uuid4())
    return out


def check_since(spec: OperationSpec, params: Mapping[str, object], server: str | None) -> None:
    if not server:
        return
    have = _version(server)
    if spec.since and _version(spec.since) > have:
        raise NotSupportedByServer(spec.name, spec.since, server)
    for m in spec.members:
        if m.since and params.get(m.name) is not None and _version(m.since) > have:
            raise NotSupportedByServer(f"{spec.name}.{m.wire}", m.since, server)


def _version(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in v.split("-")[0].split(".") if p.isdigit())


def build_request(
    http: httpx.Client | httpx.AsyncClient, endpoint: str, spec: OperationSpec, params: Mapping[str, object], headers: Mapping[str, str]
) -> httpx.Request:
    """The request for one attempt. The URL is absolute (``endpoint`` plus the operation's path), so the
    client's endpoint applies whatever ``http``'s own ``base_url`` is."""
    path = spec.uri
    query: list[tuple[str, str | int | float | bool | None]] = []
    out_headers: dict[str, str] = dict(headers)
    body: dict[str, Any] = {}
    payload: object = None
    has_body_members = False
    for m in spec.members:
        if m.location == "body":
            has_body_members = True
        value = params.get(m.name)
        if value is None:
            continue
        match m.location:
            case "label":
                path = path.replace("{" + m.wire + "}", quote(_text(value), safe=""))
            case "greedy_label":
                path = path.replace("{" + m.wire + "+}", quote(_text(value), safe="/"))
            case "query":
                if isinstance(value, (list, tuple)):
                    query.extend((m.wire, _text(v)) for v in cast(Sequence[object], value))
                else:
                    query.append((m.wire, _text(value)))
            case "header":
                if isinstance(value, (list, tuple)):
                    out_headers[m.wire] = ", ".join(_text(v) for v in cast(Sequence[object], value))
                else:
                    out_headers[m.wire] = _text(value)
            case "body":
                body[m.wire] = to_wire(value)
            case "payload":
                payload = value
    content: bytes | None = None
    if payload is not None:
        if isinstance(payload, bytes):
            content = payload
            out_headers.setdefault("Content-Type", spec.payload_media_type or "application/octet-stream")
        else:
            content = json.dumps(to_wire(payload), separators=(",", ":")).encode()
            out_headers.setdefault("Content-Type", spec.payload_media_type or "application/json")
    elif has_body_members:
        content = json.dumps(body, separators=(",", ":")).encode()
        out_headers.setdefault("Content-Type", "application/json")
    return http.build_request(spec.method, endpoint + path, params=httpx.QueryParams(query) if query else None, headers=out_headers, content=content)


def parse_json_object(content: bytes) -> dict[str, Any]:
    if not content:
        return {}
    try:
        value = json.loads(content)
    except ValueError:
        return {}
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def read_result[M: CaitlynModel](spec: OperationSpec, response: httpx.Response, result: type[M]) -> M:
    body = parse_json_object(response.content)
    data: dict[str, Any] = dict(body)
    for wire, header in spec.response_headers:
        value = response.headers.get(header)
        if value is not None:
            data[wire] = value
    model = result.from_wire(data)
    model._set_raw(body)  # pyright: ignore[reportPrivateUsage]
    if isinstance(model, CaitlynResult):
        model._set_response_metadata(  # pyright: ignore[reportPrivateUsage]
            ResponseMetadata(response.status_code, response.headers.get(REQUEST_ID_HEADER), response.headers.get("ETag"))
        )
    return model


def read_error(spec: OperationSpec, response: httpx.Response) -> CaitlynError:
    """Problem details to the modelled error for this status, or to ``CaitlynError``."""
    err = error_from_problem(
        spec,
        response.status_code,
        parse_json_object(response.content),
        response.headers,
    )
    err.raw_body, err.raw_body_truncated = raw_body_of(response.content)
    return err


RAW_BODY_LIMIT = 8192
"""The most of an error body kept as ``raw_body`` (PROTOCOL.md 6.3)."""


def raw_body_of(content: bytes) -> tuple[str, bool]:
    """An error body as text: whole up to 8 KiB, else its first 8 KiB cut back to a character boundary, and
    whether it was cut."""
    if len(content) <= RAW_BODY_LIMIT:
        return content.decode("utf-8", errors="replace"), False
    end = RAW_BODY_LIMIT
    while end > 0 and content[end] & 0xC0 == 0x80:  # never split a UTF-8 sequence
        end -= 1
    return content[:end].decode("utf-8", errors="replace"), True


def error_from_problem(
    spec: OperationSpec, status: int, body: Mapping[str, Any], headers: Mapping[str, str] | None = None
) -> CaitlynError:
    headers = headers or {}
    if not status:
        # An SSE failure event has no HTTP status of its own, so its body's status chooses the class. A
        # response's status is always the HTTP status, whatever the body says (PROTOCOL.md 6.3).
        body_status = body.get("status")
        if isinstance(body_status, int) and not isinstance(body_status, bool):
            status = body_status
    cls = spec.errors.get(status, CaitlynError) if status else CaitlynError
    code = str(body.get("code") or f"HTTP_{status}")
    title = str(body.get("title") or "")
    detail = body.get("detail")
    request_id = body.get("requestId") or headers.get(REQUEST_ID_HEADER)
    message = f"{status} {code}: {title}" + (f" ({detail})" if detail else "")
    err = cls(
        message,
        status=status,
        code=code,
        title=title,
        detail=str(detail) if detail is not None else None,
        type=_str_or_none(body.get("type")),
        errors=_field_errors(body.get("errors")),
        request_id=str(request_id) if request_id else None,
        retry_after_seconds=parse_retry_after(headers.get("Retry-After")),
        raw=body,
    )
    for attr, where, wire in cls.members:
        value = headers.get(wire) if where == "header" else body.get(wire)
        if value is not None:
            setattr(err, attr, value)
    return err


def _field_errors(value: object) -> list[FieldError]:
    if not isinstance(value, list):
        return []
    out: list[FieldError] = []
    for e in cast(list[object], value):
        try:
            out.append(FieldError.from_wire(e))
        except pydantic.ValidationError:
            continue  # not a field error this SDK can read; still in the error's `raw`
    return out


def _str_or_none(value: object) -> str | None:
    return None if value is None else str(value)
