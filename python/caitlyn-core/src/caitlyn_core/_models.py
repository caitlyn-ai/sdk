"""Base classes for generated models: Pydantic v2 with snake_case attributes, camelCase wire names,
unknown fields kept, and open enums."""

from __future__ import annotations

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


class CaitlynEvent(CaitlynModel):
    """Base for server-sent events. ``type`` is the SSE ``event:`` name; ``event_id`` the SSE ``id:``."""

    event_id: str | None = Field(default=None, exclude=True)

    @property
    def type(self) -> str:
        raise NotImplementedError


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
