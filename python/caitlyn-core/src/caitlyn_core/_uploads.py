"""Upload targets (PROTOCOL.md 10): a file given where an operation takes an upload's id, at a dotted path inside an
input (``avatar.mark.picture_upload_id``). The generated method uploads the file and puts the upload's id in its place."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast

from ._files import FileInput, UploadFile
from ._models import CaitlynModel, camel


def _child(value: object, name: str) -> object:
    if isinstance(value, CaitlynModel):
        return cast(object, getattr(value, name, None))
    if isinstance(value, Mapping):
        m = cast(Mapping[str, object], value)
        return m.get(camel(name), m.get(name))
    return None


def file_at(value: object, path: Sequence[str]) -> UploadFile | None:
    """The file at ``path`` (snake_case attribute names) inside a model or a dict, if one is there."""
    for name in path:
        value = _child(value, name)
        if value is None:
            return None
    return value if isinstance(value, UploadFile) else None


def with_upload_id[T](value: T, path: Sequence[str], upload_id: str) -> T:
    """A copy of ``value`` with the upload's id at ``path`` in place of the file; ``value`` itself is unchanged."""
    name, rest = path[0], path[1:]
    new: object = upload_id if not rest else with_upload_id(_child(value, name), rest, upload_id)
    if isinstance(value, CaitlynModel):
        return cast(T, value.model_copy(update={name: new}))
    m = dict(cast(Mapping[str, Any], value))
    key = camel(name) if camel(name) in m or name not in m else name
    m[key] = new
    return cast(T, m)


@dataclass(frozen=True, slots=True)
class UploadId:
    """An upload already sent, by its id, where a call takes files: ``send(text, attachments=[UploadId("up-1")])``.
    A bare string is a path, as everywhere else."""

    id: str


def _reference(item: object) -> dict[str, object] | None:
    if isinstance(item, UploadId):
        return {"uploadId": item.id}
    if isinstance(item, CaitlynModel):
        return item.to_wire()
    if isinstance(item, Mapping) and "uploadId" in item:
        return dict(cast(Mapping[str, object], item))
    return None


def attachment_refs(items: Sequence[object], send: Callable[[FileInput], object]) -> list[dict[str, object]]:
    """The attachments a message names, in the caller's order: each file uploaded first with ``send`` (which reserves
    it for the conversation), each upload id as it is. One upload failing raises, and nothing is sent after it."""
    out: list[dict[str, object]] = []
    for item in items:
        ref = _reference(item)
        out.append(ref if ref is not None else {"uploadId": cast(Any, send(cast(FileInput, item))).id})
    return out


async def attachment_refs_async(items: Sequence[object], send: Callable[[FileInput], Awaitable[object]]) -> list[dict[str, object]]:
    """As ``attachment_refs``, for the async client."""
    out: list[dict[str, object]] = []
    for item in items:
        ref = _reference(item)
        out.append(ref if ref is not None else {"uploadId": cast(Any, await send(cast(FileInput, item))).id})
    return out
