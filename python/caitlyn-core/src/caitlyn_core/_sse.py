"""Incremental server-sent events parser (WHATWG HTML, "Interpreting an event stream")."""

from __future__ import annotations

import codecs
import re
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SseMessage:
    id: str | None
    """The last event ID in effect when this message was dispatched."""
    event: str
    data: str
    own_id: bool = False
    """The message carried its own ``id:`` field (only those are de-duplicated on resume)."""


class SseDecoder:
    """Feed bytes as they arrive; get complete messages back. Comments and retry fields are ignored."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._last_id: str | None = None
        self._event = ""
        self._data: list[str] = []
        self._own_id = False
        self._pending_cr = False

    def feed(self, chunk: bytes) -> list[SseMessage]:
        text = self._decoder.decode(chunk)
        if self._pending_cr and text.startswith("\n"):
            text = text[1:]
        self._pending_cr = text.endswith("\r")
        self._buffer += text
        out: list[SseMessage] = []
        while True:
            cut = _line_end(self._buffer)
            if cut is None:
                return out
            end, nxt = cut
            line, self._buffer = self._buffer[:end], self._buffer[nxt:]
            message = self._line(line)
            if message is not None:
                out.append(message)

    def _line(self, line: str) -> SseMessage | None:
        if line == "":
            if not self._data:
                self._event, self._own_id = "", False
                return None
            message = SseMessage(self._last_id, self._event or "message", "\n".join(self._data), self._own_id)
            self._event, self._data, self._own_id = "", [], False
            return message
        if line.startswith(":"):
            return None
        name, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if name == "data":
            self._data.append(value)
        elif name == "event":
            self._event = value
        elif name == "id" and "\0" not in value:
            self._last_id = value or None
            self._own_id = True
        return None


_NEWLINE = re.compile(r"\r\n|\r|\n")


def _line_end(buffer: str) -> tuple[int, int] | None:
    """A lone CR at the end of the buffer ends a line; an LF arriving next is dropped by feed()."""
    m = _NEWLINE.search(buffer)
    return None if m is None else (m.start(), m.end())
