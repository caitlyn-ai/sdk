"""Reading a file for a presigned upload: bytes, name, content type and base64 SHA-256."""

from __future__ import annotations

import base64
import hashlib
import mimetypes
from dataclasses import dataclass
from os import PathLike
from pathlib import Path


@dataclass(frozen=True, slots=True)
class UploadFile:
    data: bytes
    file_name: str
    content_type: str
    sha256: str
    """Base64-encoded SHA-256 of ``data``."""

    @property
    def byte_size(self) -> int:
        return len(self.data)


def read_upload(file: str | PathLike[str] | bytes, *, file_name: str | None = None, content_type: str | None = None) -> UploadFile:
    """A path or raw bytes. With bytes, pass ``file_name``."""
    if isinstance(file, bytes):
        data = file
        name = file_name or "upload.bin"
    else:
        path = Path(file)
        data = path.read_bytes()
        name = file_name or path.name
    kind = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    digest = base64.b64encode(hashlib.sha256(data).digest()).decode()
    return UploadFile(data, name, kind, digest)
