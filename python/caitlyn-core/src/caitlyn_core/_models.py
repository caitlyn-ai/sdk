"""Base classes for generated models: Pydantic v2 with snake_case attributes, camelCase wire names,
unknown fields kept, and open enums."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any, ClassVar, Self, cast

from pydantic import (
    AliasGenerator,
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    PrivateAttr,
    ValidationInfo,
    model_validator,
)

WIRE: dict[str, Any] = {"caitlyn_wire": True}
"""Validation context for data read from the wire; models read this way keep their raw JSON."""


def camel(name: str) -> str:
    """snake_case to the camelCase wire name. The generator emits an explicit alias whenever the
    model's wire name differs from this function's result."""
    head, *rest = name.rstrip("_").split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


class CaitlynModel(BaseModel):
    """Base for every generated structure.

    - Attributes are snake_case; the wire names are camelCase (or the model's ``@jsonName``).
    - Fields this SDK version does not model are kept: reachable as ``model.raw`` (the JSON object
      as received) and as snake_case attributes (``doc.retention_policy`` for ``retentionPolicy``).
    """

    model_config: ClassVar[ConfigDict] = ConfigDict(
        extra="allow",
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        alias_generator=AliasGenerator(validation_alias=camel, serialization_alias=camel),
    )

    _raw: dict[str, Any] | None = PrivateAttr(default=None)
    _response_metadata: ResponseMetadata | None = PrivateAttr(default=None)

    @model_validator(mode="wrap")
    @classmethod
    def _keep_raw(cls, data: Any, handler: ModelWrapValidatorHandler[Self], info: ValidationInfo) -> Self:
        model = handler(data)
        context = cast(object, info.context)
        if isinstance(data, dict) and isinstance(context, dict) and cast(dict[str, Any], context).get("caitlyn_wire"):
            model._raw = cast(dict[str, Any], data)
        return model

    @classmethod
    def from_wire(cls, data: object) -> Self:
        """Validate a JSON value received from the server."""
        return cls.model_validate(data, context=WIRE)

    @property
    def raw(self) -> dict[str, Any]:
        """The JSON object as received, including fields this SDK version does not model.

        For a model built in code, the JSON it would send."""
        if self._raw is not None:
            return self._raw
        return self.to_wire()

    def to_wire(self) -> dict[str, Any]:
        """The JSON object for this model, with wire names; unset optional members are omitted."""
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)

    def _set_raw(self, raw: dict[str, Any]) -> None:
        self._raw = raw

    @property
    def response_metadata(self) -> ResponseMetadata | None:
        """The HTTP status, request id and ETag of the response this was read from, for a thing or result one call
        returned (get, update, create, wait); None for a list item, a watch snapshot's entry, or one built in code.
        Never serialised with the model."""
        return self._response_metadata

    def _set_response_metadata(self, metadata: ResponseMetadata) -> None:
        self._response_metadata = metadata

    if not TYPE_CHECKING:
        # Only at runtime, so that type checkers still flag misspelt attributes.
        def __getattr__(self, name: str) -> Any:
            try:
                return super().__getattr__(name)
            except AttributeError:
                extra = self.__pydantic_extra__
                key = camel(name)
                if extra is not None and key in extra:
                    return extra[key]
                raise


class FieldError(CaitlynModel):
    """One problem with one request member or query parameter, from a problem body's ``errors`` (PROTOCOL.md
    6.1). The runtime reads it with the rest of the problem details, so the generated SDK re-exports this class
    rather than generating its own."""

    pointer: str | None = None
    """A JSON Pointer (RFC 6901) into the request body, for example ``/context/0/label``. Absent when the
    problem is with a query parameter."""
    parameter: str | None = None
    """The query parameter at fault, for example ``filter[staus][eq]``. Absent when the problem is in the body."""
    code: str
    """The code for this field's problem, from the same catalogue as the response's own code."""
    detail: str | None = None
    """What is wrong with the field, written for the integrator."""


@dataclass(frozen=True, slots=True)
class ResponseMetadata:
    """The response a call's result was read from (PROTOCOL.md 4.2)."""

    http_status_code: int
    """The HTTP status, for example 200 or 201."""
    request_id: str | None = None
    """The ``Caitlyn-Request-Id`` header; quote it to support."""
    etag: str | None = None
    """The ``ETag`` header, when the response has one."""
    api_version: str | None = None
    """The ``Caitlyn-Api-Version`` header: the server's model version."""


class CaitlynResult(CaitlynModel):
    """Base for the result of a call that is not a thing (an estimate, a comparison, a page): a model that carries the
    response it was read from, as every model a single call returns does (``response_metadata``)."""


class CaitlynPage(CaitlynResult):
    """Base for a page of a list (PROTOCOL.md 10): the operation's output, with the way to the page after it.

    ``next_page()`` (the synchronous client's pages) or ``await next_page_async()`` (the asynchronous client's) reads
    the page after this one with the same input, in exactly one request, and gives ``None`` on the last page without a
    request. ``has_next_page`` says whether there is one. Keep ``next_cursor`` for state that outlives the page: passed
    as ``cursor``, it reads the same next page. Cursors only go forward, so there is no previous page."""

    _next: Callable[[], Any] | None = PrivateAttr(default=None)
    _next_is_async: bool = PrivateAttr(default=False)

    @property
    def has_next_page(self) -> bool:
        """Whether another page follows (this page has a ``next_cursor``)."""
        return bool(getattr(self, "next_cursor", None))

    def next_page(self) -> Self | None:
        """The page after this one, from the synchronous client: one request, or ``None`` on the last page."""
        if self._next_is_async:
            raise TypeError("this page is from the asynchronous client: use `await page.next_page_async()`")
        if not self.has_next_page or self._next is None:
            return None
        return cast("Self", self._next())

    async def next_page_async(self) -> Self | None:
        """The page after this one, from the asynchronous client: one request, or ``None`` on the last page."""
        if not self._next_is_async:
            raise TypeError("this page is from the synchronous client: use `page.next_page()`")
        if not self.has_next_page or self._next is None:
            return None
        return cast("Self", await self._next())

    def _bind_next(self, fetch: Callable[[], Any], is_async: bool) -> None:
        self._next, self._next_is_async = fetch, is_async


class CaitlynEvent(CaitlynModel):
    """Base for server-sent events. ``type`` is the SSE ``event:`` name; ``event_id`` the SSE ``id:``."""

    event_id: str | None = Field(default=None, exclude=True)
    _watched: tuple[str | None, str] | None = PrivateAttr(default=None)
    """For an event from a scope's watch: the watch's filter member (``document``, ``folder``, ``batch``) and the
    scope's identifier, so ``processing`` knows whose processing to give."""

    @property
    def type(self) -> str:
        raise NotImplementedError

    def _bind_watch(self, watched: tuple[str | None, str]) -> None:
        self._watched = watched

    @property
    def watched(self) -> tuple[str | None, str] | None:
        """The scope's watch this event came from: its filter member and the scope's identifier; None otherwise."""
        return self._watched


class OpenEnum(StrEnum):
    """A string enum that accepts values this SDK does not know yet.

    ``DocumentStatus("archived")`` returns a member whose name is ``UNKNOWN`` and whose value is the
    raw string, so it still compares equal to ``"archived"``."""

    @classmethod
    def _missing_(cls, value: object) -> Self | None:
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member

    @property
    def is_known(self) -> bool:
        """False for a value this SDK version does not know."""
        return self._name_ != "UNKNOWN"
