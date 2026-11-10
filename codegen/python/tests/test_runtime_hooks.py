"""Interceptor hooks run around every call and attempt, in the sync and the async client."""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "conformance" / "python")]

from caitlyn import AsyncCaitlyn, CallContext, Caitlyn, Interceptor, ServiceUnavailableError  # noqa: E402
from caitlyn.auth import Token  # noqa: E402
from conftest import Mock, mock, mock_server  # noqa: E402,F401  (fixtures)


class Recorder(Interceptor):
    def __init__(self) -> None:
        self.log: list[str] = []

    def before_call(self, context: CallContext) -> None:
        self.log.append(f"call {context.operation.name}")

    def before_attempt(self, context: CallContext, request: httpx.Request) -> None:
        request.headers["x-test-attempt"] = str(context.attempt)
        self.log.append(f"attempt {context.attempt}")

    def after_attempt(self, context: CallContext, request: httpx.Request, response: httpx.Response | None, error: BaseException | None) -> None:
        self.log.append(f"status {response.status_code if response else error}")

    def after_call(self, context: CallContext, error: BaseException | None) -> None:
        self.log.append(f"done {type(error).__name__ if error else 'ok'} {context.request_id is not None}")


def test_sync_hooks_order(mock: Mock) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}]})
    rec = Recorder()
    Caitlyn(workspace="x", auth=Token("t"), endpoint=mock.base, interceptors=[rec]).versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert rec.log == ["call GetAgentVersion", "attempt 0", "status 503", "attempt 1", "status 200", "done ok True"]


async def test_async_hooks_see_the_final_error(mock: Mock) -> None:
    mock.faults(status={"GetAgentVersion": [{"status": 503, "retryAfter": 0}] * 3})
    rec = Recorder()
    with pytest.raises(ServiceUnavailableError):
        await AsyncCaitlyn(workspace="x", auth=Token("t"), endpoint=mock.base, interceptors=[rec]).versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert rec.log[-1] == "done ServiceUnavailableError True"
    assert rec.log.count("status 503") == 3


async def test_hook_can_change_the_request(mock: Mock) -> None:
    await AsyncCaitlyn(workspace="x", auth=Token("t"), endpoint=mock.base, interceptors=[Recorder()]).versions.get(agent_id="GHT7YRWXPL", version="draft")
    assert "x-test-attempt" in mock.requests()[-1]["headerNames"]
