"""Fixtures for the Python conformance harness: one mock server per session, reset before each test."""

import json
import os
import random
import subprocess
import urllib.parse
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]


class Mock:
    def __init__(self, base: str) -> None:
        self.base = base

    def _post(self, path: str, body: Any = None) -> None:
        data = json.dumps(body).encode() if body is not None else b""
        urllib.request.urlopen(urllib.request.Request(self.base + path, data=data, method="POST"))

    def _get(self, path: str) -> Any:
        return json.load(urllib.request.urlopen(self.base + path))

    def reset(self) -> None:
        self._post("/__mock/reset")

    def faults(self, **f: Any) -> None:
        self._post("/__mock/faults", f)

    def requests(self) -> list[dict[str, Any]]:
        return self._get("/__mock/requests")

    def api(self) -> list[dict[str, Any]]:
        """Requests to the API itself (not the upload target)."""
        return [r for r in self.requests() if str(r.get("path", "")).startswith("/v3/")]

    def auth_counts(self) -> dict[str, int]:
        """Sign-in counters: token requests by grant type, and STS calls."""
        return self._get("/__mock/auth")["counts"]

    def token_requests(self) -> list[dict[str, str]]:
        """The forms posted to the token endpoint, in order."""
        return [dict(urllib.parse.parse_qsl(r.get("body") or "")) for r in self.requests() if r.get("path") == "/oauth/token"]

    def prime_example(self, case_id: str) -> None:
        self._post("/__mock/example", {"id": case_id})

    def example_result(self) -> dict[str, Any]:
        return self._get("/__mock/example")


@pytest.fixture(scope="session")
def mock_server() -> Iterator[Mock]:
    port = 4600 + random.randint(0, 300)
    proc = subprocess.Popen(["node", str(ROOT / "conformance" / "mock-server" / "server.mjs")], env={**os.environ, "PORT": str(port)}, stdout=subprocess.PIPE)
    assert proc.stdout is not None
    proc.stdout.readline()
    yield Mock(f"http://127.0.0.1:{port}")
    proc.terminate()


@pytest.fixture
def mock(mock_server: Mock) -> Mock:
    mock_server.reset()
    return mock_server
