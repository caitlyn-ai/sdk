"""Sign-in modes. Each is an ``httpx.Auth``, so a mode can add headers, refresh a token, or sign the
whole request (body included) in both the sync and the async client.

Implemented: ``Token`` (a personal access token or service token, sent as a bearer token).
Interfaces ready, not implemented yet: ``OAuth``, ``ClientCredentials``, ``AwsIam``."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable, Generator
from dataclasses import dataclass, field

import httpx


class Auth(httpx.Auth):
    """Base class for a sign-in mode. Subclasses override ``auth_flow`` (or the sync and async
    flows separately when they need I/O, as a refreshing OAuth mode does)."""

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        yield request


@dataclass(frozen=True, slots=True)
class Token(Auth):
    """A static bearer token: ``Authorization: Bearer <token>``."""

    token: str

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        request.headers["Authorization"] = f"Bearer {self.token}"
        yield request


@dataclass(frozen=True, slots=True)
class OAuth(Auth):
    """User sign-in with OAuth 2.0 (authorisation code with PKCE). Not implemented yet (lane K2):
    ``access_token`` returns the current token and refreshes it when it expires."""

    access_token: Callable[[], str]

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        request.headers["Authorization"] = f"Bearer {self.access_token()}"
        yield request


@dataclass(frozen=True, slots=True)
class ClientCredentials(Auth):
    """Service sign-in with the OAuth 2.0 client-credentials grant. Not implemented yet (lane K2)."""

    client_id: str
    client_secret: str = field(repr=False)
    token_url: str | None = None

    def sync_auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        raise NotImplementedError("ClientCredentials is not implemented yet (lane K2)")
        yield request  # pragma: no cover

    async def async_auth_flow(self, request: httpx.Request) -> AsyncGenerator[httpx.Request, httpx.Response]:
        raise NotImplementedError("ClientCredentials is not implemented yet (lane K2)")
        yield request  # pragma: no cover


@dataclass(frozen=True, slots=True)
class AwsIam(Auth):
    """Signs each request with the caller's AWS credentials (SigV4), for Caitlyn deployed inside an
    AWS account. The signer is injected so that this package never depends on an AWS runtime.
    Not implemented yet (lane K2)."""

    sign: Callable[[httpx.Request], None]

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        self.sign(request)
        yield request
