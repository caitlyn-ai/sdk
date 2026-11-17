"""Files (PROTOCOL.md 14): what a caller can give an operation that takes a file, and how the SDK reads it.

A file is hashed (SHA-256) before anything is sent, with streaming reads. A stream that cannot be read twice is
copied while it is hashed: into memory up to 8 MiB, then into a temporary file only its owner can read, which is
deleted when the call ends, whatever happens. A path is checked again before its bytes are sent: a file whose size
or modification time changed since it was hashed fails with ``FILE_CHANGED``."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import os
import tempfile
from collections.abc import AsyncIterable, AsyncIterator, Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from typing import Any, BinaryIO, Final, cast

from pydantic import GetCoreSchemaHandler
from pydantic_core import CoreSchema, core_schema

from ._errors import CaitlynError
from ._models import CaitlynModel

MAX_FILE_SIZE: Final = 2 * 1024 * 1024 * 1024
"""The largest file an SDK sends: 2 GB (2,147,483,648 bytes)."""
SPOOL_MEMORY: Final = 8 * 1024 * 1024
"""A one-shot stream is kept in memory up to this size, and in a temporary file past it."""
CHUNK: Final = 1024 * 1024
"""Bytes read at a time while hashing and sending."""

CONTENT_TYPES: Final[dict[str, str]] = {
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "odt": "application/vnd.oasis.opendocument.text",
    "rtf": "application/rtf",
    "txt": "text/plain",
    "md": "text/markdown",
    "markdown": "text/markdown",
    "csv": "text/csv",
    "html": "text/html",
    "htm": "text/html",
    "json": "application/json",
    "xml": "application/xml",
    "eml": "message/rfc822",
    "zip": "application/zip",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mov": "video/quicktime",
}
"""The content type for each file name extension (PROTOCOL.md 14), shared by every SDK. A name whose extension is
not here is ``application/octet-stream``."""


def content_type_for(name: str) -> str:
    """The content type the shared table gives a file name, by its extension (case ignored)."""
    _, dot, ext = name.rpartition(".")
    return CONTENT_TYPES.get(ext.lower(), "application/octet-stream") if dot else "application/octet-stream"


def url_safe_sha256(sha256: str) -> str:
    """A standard-base64 SHA-256 as object keys carry it: URL-safe base64 (``-`` and ``_``), without padding."""
    return sha256.replace("+", "-").replace("/", "_").rstrip("=")


def file_error(code: str, message: str) -> CaitlynError:
    """An error the SDK raises about a file before (or instead of) sending it: ``status`` is 0."""
    return CaitlynError(f"{code}: {message}", status=0, code=code, title=message)


@contextmanager
def reading(name: object) -> Iterator[None]:
    """A file read: a failure that is not already a Caitlyn error is ``FILE_UNREADABLE`` (PROTOCOL.md 6.3), raised
    ``from`` the native error, which stays the ``__cause__``."""
    try:
        yield
    except CaitlynError:
        raise
    except Exception as e:
        raise file_error("FILE_UNREADABLE", f"{name} could not be read: {e}") from e


def _too_large(name: str, size: int) -> CaitlynError:
    return file_error("FILE_TOO_LARGE", f"{name} is {size:,} bytes; a file can be at most 2 GB ({MAX_FILE_SIZE:,} bytes)")


type ByteStream = Iterable[bytes] | AsyncIterable[bytes] | BinaryIO
"""A stream of bytes: an iterable or async iterable of chunks (``response.iter_bytes()``,
``response.aiter_bytes()``), or a binary file object."""


class UploadFile:
    """A file for an operation that takes one: a path, bytes or a stream, with its name and content type.

    Build one with ``from_path``, ``from_bytes`` or ``from_stream``. Wherever a file is taken, a ``str`` or
    ``os.PathLike`` path is accepted as well. The content type is the one given, else the shared table's for the
    name's extension, else ``application/octet-stream``. A stream is read once; use a new ``UploadFile`` for each
    call."""

    __slots__ = ("_bytes", "_path", "_stream", "content_type", "hints", "name", "size")

    def __init__(
        self,
        *,
        name: str,
        content_type: str | None = None,
        path: Path | None = None,
        data: bytes | None = None,
        stream: ByteStream | None = None,
        size: int | None = None,
        hints: object = None,
    ) -> None:
        if sum(x is not None for x in (path, data, stream)) != 1:
            raise TypeError("UploadFile takes exactly one of path, data and stream; use from_path, from_bytes or from_stream")
        if not name:
            raise ValueError("UploadFile needs a name")
        self.name = name
        """The file's name, sent as the upload's ``fileName``."""
        self.content_type = content_type or content_type_for(name)
        """The media type sent with the file."""
        self.size = size
        """The size in bytes when known before reading (a path's or bytes' size, or a stream's declared one)."""
        self._path = path
        self._bytes = data
        self._stream = stream
        self.hints: object = hints
        """What the caller read of the file (an ``IngestionHints``, or a mapping of its JSON members), sent with the file's
        description to an estimate. None sends none."""

    @classmethod
    def from_path(cls, path: str | PathLike[str], *, name: str | None = None, content_type: str | None = None,
                  hints: CaitlynModel | Mapping[str, object] | None = None) -> UploadFile:
        """A file on disk, read when the call sends it. The name defaults to the path's last part. ``hints`` (the model's
        ``IngestionHints``, or a mapping) is what you read of the file, which an estimate is given with it."""
        p = Path(path)
        return cls(name=name or p.name, content_type=content_type, path=p, hints=hints)

    @classmethod
    def from_bytes(cls, data: bytes, *, name: str, content_type: str | None = None,
                   hints: CaitlynModel | Mapping[str, object] | None = None) -> UploadFile:
        """Bytes in memory, with the file name they are sent as, and any ``hints`` an estimate is given with them."""
        return cls(name=name, content_type=content_type, data=bytes(data), size=len(data), hints=hints)

    @classmethod
    def from_stream(cls, stream: ByteStream, *, name: str, content_type: str | None = None, size: int | None = None,
                    hints: CaitlynModel | Mapping[str, object] | None = None) -> UploadFile:
        """A stream read once: an iterable or async iterable of byte chunks, or a binary file object. It is copied
        while it is hashed (memory up to 8 MiB, then a temporary file deleted when the call ends). ``size``, when
        known, lets a file over 2 GB fail before anything is read; otherwise the bytes are counted as they arrive.
        The synchronous client cannot read an async iterable."""
        if size is not None and size > MAX_FILE_SIZE:
            raise _too_large(name, size)
        return cls(name=name, content_type=content_type, stream=stream, size=size, hints=hints)

    @classmethod
    def of(cls, file: FileInput) -> UploadFile:
        """An ``UploadFile`` as given, or one for a path."""
        return file if isinstance(file, UploadFile) else cls.from_path(file)

    def __repr__(self) -> str:
        source = f"path={str(self._path)!r}" if self._path is not None else "bytes" if self._bytes is not None else "stream"
        return f"UploadFile(name={self.name!r}, content_type={self.content_type!r}, {source})"

    @classmethod
    def __get_pydantic_core_schema__(cls, source: Any, handler: GetCoreSchemaHandler) -> CoreSchema:
        # An input model's upload member (avatar.mark.picture_upload_id) may hold a file; the call uploads it and
        # sends the upload's id in its place, so a file is never serialised.
        return core_schema.is_instance_schema(cls)

    # ------------------------------------------------------------------ describing (estimates)

    def description(self) -> dict[str, object]:
        """The file as an estimate takes it, its name, content type and size, read without hashing: a path's size from
        the file system, bytes' length, or a stream's declared size, else its bytes counted as it is read once."""
        if self.size is not None:
            size = self.size
        elif self._path is not None:
            with reading(self.name):
                size = self._path.stat().st_size
        else:
            stream = self._stream
            if isinstance(stream, AsyncIterable):
                raise TypeError("The synchronous client cannot read an async stream: use AsyncCaitlyn, or pass a sync iterable")
            with reading(self.name):
                size = sum(len(chunk) for chunk in _sync_chunks(cast(Iterable[bytes] | BinaryIO, stream)))
        if size > MAX_FILE_SIZE:
            raise _too_large(self.name, size)
        return self._described(size)

    def hints_wire(self) -> dict[str, object] | None:
        """The hints as an estimate sends them, or None when the caller gave none."""
        if self.hints is None:
            return None
        if isinstance(self.hints, CaitlynModel):
            return self.hints.to_wire()
        return dict(cast(Mapping[str, object], self.hints))

    def _described(self, size: int) -> dict[str, object]:
        out: dict[str, object] = {"name": self.name, "contentType": self.content_type, "byteSize": size}
        hints = self.hints_wire()
        if hints is not None:
            out["hints"] = hints
        return out

    async def description_async(self) -> dict[str, object]:
        """As ``description``, for an async call: an async stream is counted here, anything else in a worker thread."""
        stream = self._stream
        if self.size is None and stream is not None and isinstance(stream, AsyncIterable):
            size = 0
            with reading(self.name):
                async for chunk in stream:
                    size += len(chunk)
            if size > MAX_FILE_SIZE:
                raise _too_large(self.name, size)
            return self._described(size)
        return await asyncio.to_thread(self.description)

    # ------------------------------------------------------------------ staging (batch uploads)

    def stage(self, sha256: str) -> PreparedFile:
        """The file ready to send under a batch item's checksum, for a synchronous call, without hashing it: a path as it
        stands (its size and modification time kept, so a change before sending is caught), bytes as given, a stream
        copied once (memory up to 8 MiB, then a temporary file). Storage checks the bytes against ``sha256``. The caller
        closes the result."""
        if self._bytes is not None:
            return PreparedFile(self.name, self.content_type, len(self._bytes), sha256, data=self._bytes)
        if self._path is not None:
            with reading(self.name):
                st = self._path.stat()
            if st.st_size > MAX_FILE_SIZE:
                raise _too_large(self.name, st.st_size)
            return PreparedFile(self.name, self.content_type, st.st_size, sha256, path=self._path, stat=(st.st_size, st.st_mtime_ns))
        stream = self._stream
        if isinstance(stream, AsyncIterable):
            raise TypeError("The synchronous client cannot read an async stream: use AsyncCaitlyn, or pass a sync iterable")
        spool = _Spool(self.name, hashing=False)
        try:
            with reading(self.name):
                for chunk in _sync_chunks(cast(Iterable[bytes] | BinaryIO, stream)):
                    spool.write(chunk)
            return spool.finish(self, sha256)
        except BaseException:
            spool.discard()
            raise

    async def stage_async(self, sha256: str) -> PreparedFile:
        """As ``stage``, for an async call: disk reads run in a worker thread; an async stream is read here."""
        stream = self._stream
        if stream is None or not isinstance(stream, AsyncIterable):
            return await asyncio.to_thread(self.stage, sha256)
        spool = _Spool(self.name, hashing=False)
        try:
            with reading(self.name):
                async for chunk in stream:
                    spool.write(chunk)
            return spool.finish(self, sha256)
        except BaseException:
            spool.discard()
            raise

    # ------------------------------------------------------------------ hashing

    def prepare(self) -> PreparedFile:
        """Hash the file (and spool a stream), for a synchronous call. The caller closes the result."""
        if self._bytes is not None:
            return PreparedFile.of_bytes(self, self._bytes)
        if self._path is not None:
            with reading(self.name):
                return PreparedFile.of_path(self, self._path)
        stream = self._stream
        if isinstance(stream, AsyncIterable):
            raise TypeError("The synchronous client cannot read an async stream: use AsyncCaitlyn, or pass a sync iterable")
        spool = _Spool(self.name)
        try:
            with reading(self.name):
                for chunk in _sync_chunks(cast(Iterable[bytes] | BinaryIO, stream)):
                    spool.write(chunk)
            return spool.finish(self)
        except BaseException:
            spool.discard()
            raise

    async def prepare_async(self) -> PreparedFile:
        """As ``prepare``, for an async call: disk reads run in a worker thread; an async stream is read here."""
        stream = self._stream
        if stream is None or not isinstance(stream, AsyncIterable):
            return await asyncio.to_thread(self.prepare)
        spool = _Spool(self.name)
        try:
            with reading(self.name):
                async for chunk in stream:
                    spool.write(chunk)
            return spool.finish(self)
        except BaseException:
            spool.discard()
            raise


type FileInput = UploadFile | str | PathLike[str]
"""What a file parameter takes: an ``UploadFile``, or the path of a file on disk."""


def _sync_chunks(stream: Iterable[bytes] | BinaryIO) -> Iterator[bytes]:
    read = getattr(stream, "read", None)
    if callable(read):
        while chunk := cast(bytes, read(CHUNK)):
            yield chunk
        return
    yield from cast(Iterable[bytes], stream)


class _Spool:
    """A one-shot stream's copy, hashed as it is written: memory to 8 MiB, then a 0600 temporary file."""

    def __init__(self, name: str, *, hashing: bool = True) -> None:
        self.name = name
        self.digest = hashlib.sha256() if hashing else None
        self.size = 0
        self.memory: io.BytesIO | None = io.BytesIO()
        self.file: BinaryIO | None = None
        self.path: str | None = None

    def write(self, chunk: bytes) -> None:
        if not chunk:
            return
        self.size += len(chunk)
        if self.size > MAX_FILE_SIZE:
            raise _too_large(self.name, self.size)
        if self.digest is not None:
            self.digest.update(chunk)
        if self.memory is not None and self.size > SPOOL_MEMORY:
            fd, self.path = tempfile.mkstemp(prefix="caitlyn-upload-")  # created 0600: readable only by its owner
            self.file = os.fdopen(fd, "w+b")
            self.file.write(self.memory.getbuffer())
            self.memory = None
        if self.file is not None:
            self.file.write(chunk)
        else:
            assert self.memory is not None
            self.memory.write(chunk)

    def finish(self, source: UploadFile, sha256: str | None = None) -> PreparedFile:
        """The copy as a prepared file: with its own SHA-256, or with ``sha256`` when it was copied without hashing."""
        if self.digest is not None:
            sha = base64.b64encode(self.digest.digest()).decode()
        else:
            assert sha256 is not None, "a copy made without hashing takes the item's checksum"
            sha = sha256
        if self.file is not None:
            self.file.close()
            assert self.path is not None
            return PreparedFile(source.name, source.content_type, self.size, sha, path=Path(self.path), temporary=True)
        assert self.memory is not None
        return PreparedFile(source.name, source.content_type, self.size, sha, data=self.memory.getvalue())

    def discard(self) -> None:
        if self.file is not None:
            self.file.close()
        if self.path is not None:
            Path(self.path).unlink(missing_ok=True)


@dataclass(slots=True)
class PreparedFile:
    """A file hashed and ready to send. Close it when the call ends: a spooled stream's temporary file is deleted."""

    name: str
    content_type: str
    byte_size: int
    sha256: str
    """The SHA-256 as standard base64 (with padding), as bodies and headers carry it."""
    data: bytes | None = None
    path: Path | None = None
    temporary: bool = False
    """``path`` is this SDK's own spool file, deleted on ``close``."""
    stat: tuple[int, int] | None = None
    """For a caller's path: (size, modification time in nanoseconds) when it was hashed."""

    @classmethod
    def of_bytes(cls, source: UploadFile, data: bytes) -> PreparedFile:
        if len(data) > MAX_FILE_SIZE:
            raise _too_large(source.name, len(data))
        return cls(source.name, source.content_type, len(data), base64.b64encode(hashlib.sha256(data).digest()).decode(), data=data)

    @classmethod
    def of_path(cls, source: UploadFile, path: Path) -> PreparedFile:
        before = path.stat()
        if before.st_size > MAX_FILE_SIZE:
            raise _too_large(source.name, before.st_size)
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as f:
            while chunk := f.read(CHUNK):
                size += len(chunk)
                if size > MAX_FILE_SIZE:
                    raise _too_large(source.name, size)
                digest.update(chunk)
        after = path.stat()
        if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns) or size != before.st_size:
            raise file_error("FILE_CHANGED", f"{path} changed while it was being read")
        return cls(source.name, source.content_type, size, base64.b64encode(digest.digest()).decode(), path=path,
                   stat=(before.st_size, before.st_mtime_ns))

    @property
    def sha256_url(self) -> str:
        """The SHA-256 as URL-safe base64 without padding, as object keys carry it."""
        return url_safe_sha256(self.sha256)

    def check_unchanged(self) -> None:
        """Raises ``FILE_CHANGED`` when a caller's path changed size or modification time since it was hashed."""
        if self.stat is None or self.path is None:
            return
        try:
            now = self.path.stat()
        except OSError as e:
            raise file_error("FILE_CHANGED", f"{self.path} can no longer be read: {e}") from e
        if (now.st_size, now.st_mtime_ns) != self.stat:
            raise file_error("FILE_CHANGED", f"{self.path} changed after it was hashed; nothing was sent")

    def chunks(self) -> Iterator[bytes]:
        """The bytes, read again for each attempt."""
        if self.data is not None:
            yield self.data
            return
        assert self.path is not None
        with reading(self.path), self.path.open("rb") as f:
            while chunk := f.read(CHUNK):
                yield chunk

    async def achunks(self) -> AsyncIterator[bytes]:
        """As ``chunks``, for an async client: each disk read runs in a worker thread."""
        if self.data is not None:
            yield self.data
            return
        assert self.path is not None
        with reading(self.path):
            f = await asyncio.to_thread(self.path.open, "rb")
        try:
            while chunk := await asyncio.to_thread(f.read, CHUNK):
                yield chunk
        finally:
            f.close()

    def open(self) -> BinaryIO:
        """A binary file object over the bytes (for a form upload)."""
        if self.data is not None:
            return io.BytesIO(self.data)
        assert self.path is not None
        with reading(self.path):
            return self.path.open("rb")

    def close(self) -> None:
        if self.temporary and self.path is not None:
            self.path.unlink(missing_ok=True)

    def __enter__(self) -> PreparedFile:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
