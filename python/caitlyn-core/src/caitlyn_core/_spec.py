"""Operation descriptions the generator emits. The runtime serialises requests and reads responses
from these; generated code carries no per-operation serialisation logic."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from ._errors import CaitlynError

Location = Literal["label", "greedy_label", "query", "header", "body", "payload"]


@dataclass(frozen=True, slots=True)
class Member:
    name: str
    """Python parameter name."""
    wire: str
    """Wire name: the JSON member name, header name, query key or label name."""
    location: Location
    since: str | None = None
    idempotency_token: bool = False


@dataclass(frozen=True, slots=True)
class OperationSpec:
    name: str
    method: str
    uri: str
    code: int = 200
    members: tuple[Member, ...] = ()
    response_headers: tuple[tuple[str, str], ...] = ()
    """(model wire name, header name) for header-bound output members."""
    errors: Mapping[int, type[CaitlynError]] = field(default_factory=dict[int, type[CaitlynError]])
    retry_safe: bool = False
    """@readonly, @idempotent, or has an @idempotencyToken member."""
    since: str | None = None
    stability: str = "ga"
    streaming: bool = False
    payload_media_type: str | None = None

    def member(self, name: str) -> Member | None:
        for m in self.members:
            if m.name == name:
                return m
        return None
