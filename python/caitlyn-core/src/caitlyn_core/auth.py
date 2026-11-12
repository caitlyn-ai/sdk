"""Sign-in modes (model/PROTOCOL.md section 12). Every mode except ``Token`` and ``Session`` ends in the same
thing: a short-lived Caitlyn bearer token from the workspace's token endpoint (``{endpoint}/oauth/token``),
kept until a minute before it expires and renewed by one request however many calls are waiting.

    Token              a personal access token, sent as it is
    ClientCredentials  a client ID and secret exchanged for a token; asked again before it expires
    OAuth              authorisation code with PKCE, then refresh tokens; a token store keeps them
    AwsIam             STS GetWebIdentityToken with the caller's AWS credentials, exchanged (RFC 8693)
    WorkloadIdentity   a JWT from another trusted issuer (a GitLab CI id_tokens variable), exchanged (RFC 8693)
    Session            the browser session cookie, and Origin on every write (the Caitlyn app, local recording)

A mode is only configuration. The client binds it to its workspace and endpoint, and offers the ``OAuth``
mode's sign-in steps as ``client.auth``."""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import os
import secrets
import threading
import time
from collections.abc import AsyncGenerator, Awaitable, Callable, Generator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, cast
from urllib.parse import urlencode

import httpx

from . import _aws
from ._aws import AwsCredentials
from ._steps import Steps, invoke, run_async, run_sync, send

__all__ = [
    "Auth",
    "AuthorizationRequest",
    "AsyncAuthSession",
    "AwsCredentials",
    "AwsIam",
    "CaitlynAuthError",
    "ClientCredentials",
    "OAuth",
    "OAuthTokens",
    "Session",
    "SyncAuthSession",
    "Token",
    "TokenStore",
    "WorkloadIdentity",
    "workspace_audience",
    "workspace_host",
]

TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange"
JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"
REFRESH_EARLY_SECONDS = 60.0
REQUEST_ID_HEADER = "Caitlyn-Request-Id"


def workspace_host(workspace: str) -> str:
    """A workspace given as a hostname or a URL, as its bare hostname."""
    return workspace.split("://", 1)[-1].split("/", 1)[0]


def workspace_audience(workspace: str) -> str:
    """The audience of a workspace's tokens: its resource URL, ``https://<workspace>/api``."""
    return f"https://{workspace_host(workspace)}/api"


class CaitlynAuthError(Exception):
    """A sign-in failure: the token endpoint's OAuth error, or a failure to get the identity it exchanges.

    ``code`` is the OAuth error (``invalid_client``, ``invalid_grant``…), else the body's ``code``, else
    ``http_<status>``; or one the SDK raises itself: ``sign_in_required``, ``invalid_state``,
    ``invalid_request``, an STS error code, or ``aws_identity_failed``. A 401 from an operation is not a
    sign-in error: it is ``UnauthenticatedError``."""

    def __init__(self, message: str, code: str, status: int | None = None, request_id: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.request_id = request_id


# --------------------------------------------------------------------------- the modes


class Auth:
    """Base class of the sign-in modes."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class Token(Auth):
    """A personal access token, sent as ``Authorization: Bearer <token>`` and never renewed."""

    token: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class ClientCredentials(Auth):
    """A service signing in with its client ID and secret (the OAuth client-credentials grant)."""

    client_id: str
    client_secret: str = field(repr=False)
    scopes: Sequence[str] = ()
    resource: str | None = None
    """The token audience. Default: the workspace's, ``https://<workspace>/api``."""


@dataclass(frozen=True, slots=True)
class OAuthTokens:
    """The tokens the ``OAuth`` mode keeps. ``expires_at`` is seconds since the epoch."""

    access_token: str = field(repr=False)
    refresh_token: str | None = field(default=None, repr=False)
    expires_at: float | None = None
    scope: str | None = None


class TokenStore(Protocol):
    """Where the ``OAuth`` mode keeps tokens between processes, for example encrypted on a server. The
    methods may be ``async`` when the client is ``AsyncCaitlyn``."""

    def load(self) -> OAuthTokens | None | Awaitable[OAuthTokens | None]: ...
    def save(self, tokens: OAuthTokens) -> None | Awaitable[None]: ...
    def clear(self) -> None | Awaitable[None]: ...


@dataclass(frozen=True, slots=True)
class OAuth(Auth):
    """A person signing in: authorisation code with PKCE, then refresh tokens. Start with
    ``client.auth.authorization_url()`` and finish with ``client.auth.handle_callback()``."""

    client_id: str
    client_secret: str | None = field(default=None, repr=False)
    """For a confidential client on a server only."""
    redirect_uri: str | None = None
    scopes: Sequence[str] = ()
    resource: str | None = None
    """The token audience. Default: the workspace's, ``https://<workspace>/api``."""
    token_store: TokenStore | None = None
    """Default: kept in memory for the life of the client."""


type AwsCredentialSource = AwsCredentials | Callable[[], AwsCredentials | Awaitable[AwsCredentials]]


@dataclass(frozen=True, slots=True)
class AwsIam(Auth):
    """A workload in AWS signing in with its IAM role: STS ``GetWebIdentityToken``, then a token exchange.

    The region is ``region``, else ``AWS_REGION``, else ``AWS_DEFAULT_REGION``. Credentials are ``credentials``
    (or a function the SDK calls at each sign-in), else ``AWS_ACCESS_KEY_ID`` and ``AWS_SECRET_ACCESS_KEY``,
    else the container credentials endpoint. No AWS SDK is needed."""

    region: str | None = None
    credentials: AwsCredentialSource | None = None
    signing_algorithm: Literal["ES384", "RS256"] = "ES384"
    duration_seconds: int = 300
    """The lifetime of the AWS-signed token, at most 300."""
    audience: str | None = None
    """The audience of the AWS token. Default: the workspace's, ``https://<workspace>/api``."""
    sts_endpoint: str | None = None
    """Overrides ``https://sts.<region>.amazonaws.com/`` (FIPS or VPC endpoints, tests)."""


@dataclass(frozen=True, slots=True)
class WorkloadIdentity(Auth):
    """A workload signing in with a JWT from another trusted issuer, for example a GitLab CI ``id_tokens``
    variable. ``token`` is called at every sign-in: the server accepts each JWT once."""

    token: Callable[[], str | Awaitable[str]]
    resource: str | None = None
    """The token audience. Default: the workspace's, ``https://<workspace>/api``."""


@dataclass(frozen=True, slots=True)
class Session(Auth):
    """The Caitlyn app's own browser session: no ``Authorization`` header, the cookie, and ``Origin`` on writes."""

    cookie: str | None = field(default=None, repr=False)
    origin: str | None = None
    """Sent as ``Origin`` on every request other than GET and HEAD. Default: ``https://<workspace>``."""


@dataclass(frozen=True, slots=True)
class AuthorizationRequest:
    """Where to send the person, and the state and PKCE verifier to keep until the callback."""

    url: str
    state: str
    code_verifier: str = field(repr=False)


# --------------------------------------------------------------------------- the bound session


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _refresh_at(t: OAuthTokens) -> float | None:
    """A minute before the token expires, or halfway through a life shorter than two minutes."""
    if t.expires_at is None:
        return None
    return t.expires_at - min(REFRESH_EARLY_SECONDS, (t.expires_at - time.time()) / 2)


@dataclass(slots=True)
class _Cached:
    token: str
    refresh_at: float | None

    def fresh(self) -> bool:
        return self.refresh_at is None or self.refresh_at > time.time()


class _AuthState:
    """The sign-in rules, shared by both clients. Holds one cached token per client."""

    def __init__(self, mode: Auth | None, endpoint: str, workspace: str) -> None:
        self.mode = mode
        self.endpoint = endpoint
        self.workspace = workspace
        self.token_endpoint = f"{endpoint}/oauth/token"
        self.authorization_endpoint = f"{endpoint}/oauth/authorize"
        self.workspace_url = f"https://{workspace}"
        # From the workspace, never from an endpoint override: a token is always for the workspace it names.
        resource = getattr(mode, "resource", None)
        self.resource: str = resource if isinstance(resource, str) and resource else workspace_audience(workspace)
        self._cached: _Cached | None = None
        self._refused: str | None = None
        """The token the server last refused with a 401, so ``OAuth`` never reloads it from the store."""
        self._memory: OAuthTokens | None = None

    @property
    def renews(self) -> bool:
        """Whether a 401 is worth one more try with a new token."""
        return isinstance(self.mode, (ClientCredentials, OAuth, AwsIam, WorkloadIdentity))

    def _cached_token(self) -> str | None:
        return self._cached.token if self._cached is not None and self._cached.fresh() else None

    def _forget(self, token: str) -> None:
        """Forget a token the server refused, so the next call signs in again."""
        self._refused = token
        if self._cached is not None and self._cached.token == token:
            self._cached = None

    def _prepare(self, request: httpx.Request) -> bool:
        """Adds the credential of the modes that need no token. Returns False when a token is needed."""
        m = self.mode
        if isinstance(m, Token):
            request.headers["Authorization"] = f"Bearer {m.token}"
            return True
        if isinstance(m, Session):
            request.headers.pop("Authorization", None)
            if m.cookie:
                request.headers["Cookie"] = m.cookie
            if request.method not in ("GET", "HEAD"):
                request.headers["Origin"] = m.origin or self.workspace_url
            return True
        return False

    # ------------------------------------------------------------------ OAuth steps

    def _oauth(self) -> OAuth:
        if not isinstance(self.mode, OAuth):
            name = type(self.mode).__name__ if self.mode is not None else "no sign-in mode"
            raise CaitlynAuthError(f"This client signs in with {name}, not OAuth", "invalid_request")
        return self.mode

    def authorization_url(self, *, state: str | None = None, scopes: Sequence[str] | None = None, redirect_uri: str | None = None) -> AuthorizationRequest:
        """Starts sign-in (``OAuth`` mode): the URL to send the person to, and the state and PKCE verifier to
        keep for ``handle_callback``."""
        o = self._oauth()
        redirect_uri = redirect_uri or o.redirect_uri
        if not redirect_uri:
            raise CaitlynAuthError("OAuth: redirect_uri is required", "invalid_request")
        verifier = _b64url(secrets.token_bytes(48))
        state = state if state is not None else _b64url(secrets.token_bytes(16))
        scopes = scopes if scopes is not None else o.scopes
        params = {
            "response_type": "code",
            "client_id": o.client_id,
            "redirect_uri": redirect_uri,
            "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()),
            "code_challenge_method": "S256",
            "state": state,
            "resource": self.resource,
        }
        if scopes:
            params["scope"] = " ".join(scopes)
        return AuthorizationRequest(f"{self.authorization_endpoint}?{urlencode(params)}", state, verifier)

    def _callback(self, code: str, code_verifier: str, state: str | None, expected_state: str | None, redirect_uri: str | None) -> Steps[OAuthTokens]:
        o = self._oauth()
        if expected_state is not None and state != expected_state:
            raise CaitlynAuthError("OAuth: the state does not match", "invalid_state")
        params = {"grant_type": "authorization_code", "code": code, "code_verifier": code_verifier}
        if redirect_uri := redirect_uri or o.redirect_uri:
            params["redirect_uri"] = redirect_uri
        params["resource"] = self.resource
        tokens = yield from self._request_token({**params, **self._client_params()})
        yield from self._save(tokens)
        return tokens

    def _sign_out(self) -> Steps[None]:
        o = self._oauth()
        t = yield from self._load()
        if t is not None and t.refresh_token:
            try:
                yield from send(self._form({"action": "revoke", "token": t.refresh_token, **self._client_params()}))
            except Exception:
                pass  # a failed revoke does not stop signing out
        self._cached = None
        self._memory = None
        if o.token_store is not None:
            yield from invoke(o.token_store.clear)

    def _client_params(self) -> dict[str, str]:
        m = self.mode
        out: dict[str, str] = {}
        if isinstance(m, (ClientCredentials, OAuth)):
            out["client_id"] = m.client_id
            if m.client_secret:
                out["client_secret"] = m.client_secret
        return out

    def _load(self) -> Steps[OAuthTokens | None]:
        o = self._oauth()
        if o.token_store is None:
            return self._memory
        tokens: OAuthTokens | None = yield from invoke(o.token_store.load)
        return tokens

    def _save(self, t: OAuthTokens) -> Steps[None]:
        o = self._oauth()
        self._memory = t
        self._cached = _Cached(t.access_token, _refresh_at(t))
        if o.token_store is not None:
            yield from invoke(o.token_store.save, t)

    # ------------------------------------------------------------------ fetching tokens

    def _fetch(self) -> Steps[str]:
        m = self.mode
        if isinstance(m, ClientCredentials):
            params = {"grant_type": "client_credentials", **self._client_params(), "resource": self.resource}
            if m.scopes:
                params["scope"] = " ".join(m.scopes)
            t = yield from self._request_token(params)
        elif isinstance(m, OAuth):
            stored = yield from self._load()
            held = self._cached.token if self._cached is not None else self._refused
            if stored is not None and (stored.expires_at is None or stored.expires_at - REFRESH_EARLY_SECONDS > time.time()) and stored.access_token != held:
                t = stored  # signed in or refreshed by another process (or not yet used by this client)
            elif stored is not None and stored.refresh_token:
                try:
                    t = yield from self._request_token({"grant_type": "refresh_token", "refresh_token": stored.refresh_token, **self._client_params()})
                except CaitlynAuthError as e:
                    if e.code == "invalid_grant":
                        self._memory = None
                        if m.token_store is not None:
                            yield from invoke(m.token_store.clear)
                    raise
                if t.refresh_token is None:
                    t = dataclasses.replace(t, refresh_token=stored.refresh_token)
                yield from self._save(t)
            else:
                raise CaitlynAuthError("OAuth: not signed in. Call auth.authorization_url() and auth.handle_callback() first.", "sign_in_required")
        elif isinstance(m, AwsIam):
            region = m.region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
            if not region:
                raise CaitlynAuthError("AwsIam: set region, or AWS_REGION, for the regional STS endpoint", "invalid_request")
            try:
                if m.credentials is None:
                    credentials = yield from _aws.default_credentials()
                elif isinstance(m.credentials, AwsCredentials):
                    credentials = m.credentials
                else:
                    credentials = yield from invoke(m.credentials)
                subject = yield from _aws.get_web_identity_token(
                    region=region,
                    audience=m.audience or self.resource,
                    credentials=credentials,
                    signing_algorithm=m.signing_algorithm,
                    duration_seconds=m.duration_seconds,
                    sts_endpoint=m.sts_endpoint,
                )
            except _aws.AwsStsError as e:
                raise CaitlynAuthError(str(e), e.code, e.status) from e
            except Exception as e:
                raise CaitlynAuthError(str(e), "aws_identity_failed") from e
            t = yield from self._exchange(subject)
        elif isinstance(m, WorkloadIdentity):
            subject = yield from invoke(m.token)
            t = yield from self._exchange(str(subject))
        else:
            raise CaitlynAuthError(f"No token to fetch in {type(m).__name__} mode", "invalid_request")
        self._cached = _Cached(t.access_token, _refresh_at(t))
        return t.access_token

    def _exchange(self, subject_token: str) -> Steps[OAuthTokens]:
        return self._request_token(
            {
                "grant_type": TOKEN_EXCHANGE,
                "subject_token": subject_token,
                "subject_token_type": JWT_TYPE,
                "requested_token_type": ACCESS_TOKEN_TYPE,
                "resource": self.resource,
            }
        )

    def _form(self, params: dict[str, str]) -> httpx.Request:
        return httpx.Request(
            "POST",
            self.token_endpoint,
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            content=urlencode(params).encode(),
        )

    def _request_token(self, params: dict[str, str]) -> Steps[OAuthTokens]:
        response = yield from send(self._form(params))
        request_id = response.headers.get(REQUEST_ID_HEADER)
        try:
            parsed: Any = response.json()
        except ValueError:
            parsed = {}
        body = cast(dict[str, Any], parsed) if isinstance(parsed, dict) else {}
        access_token = body.get("access_token")
        if not response.is_success or not isinstance(access_token, str):
            code = str(body.get("error") or body.get("code") or f"http_{response.status_code}")
            message = str(body.get("error_description") or body.get("detail") or f"Sign-in failed: {code}")
            raise CaitlynAuthError(message, code, response.status_code, request_id)
        refresh_token = body.get("refresh_token")
        expires_in = body.get("expires_in")
        scope = body.get("scope")
        return OAuthTokens(
            access_token=access_token,
            refresh_token=refresh_token if isinstance(refresh_token, str) else None,
            expires_at=time.time() + expires_in if isinstance(expires_in, (int, float)) and not isinstance(expires_in, bool) else None,
            scope=scope if isinstance(scope, str) else None,
        )


class _SyncFlight:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.token: str | None = None
        self.error: BaseException | None = None


class SyncAuthSession(_AuthState, httpx.Auth):
    """``Caitlyn.auth``: the client's sign-in, bound to its workspace. Signs every request, keeps one token
    renewed by one request across threads, and signs in again once after a 401."""

    def __init__(self, mode: Auth | None, endpoint: str, workspace: str, http: httpx.Client) -> None:
        super().__init__(mode, endpoint, workspace)
        self._http = http
        self._lock = threading.Lock()
        self._flight: _SyncFlight | None = None

    def handle_callback(
        self, *, code: str, code_verifier: str, state: str | None = None, expected_state: str | None = None, redirect_uri: str | None = None
    ) -> OAuthTokens:
        """Finishes sign-in (``OAuth`` mode): checks the state when ``expected_state`` is given, exchanges the
        code and saves the tokens to the token store."""
        return run_sync(self._http, self._callback(code, code_verifier, state, expected_state, redirect_uri))

    def sign_out(self) -> None:
        """Signs out (``OAuth`` mode): revokes the refresh token where possible and clears the token store."""
        run_sync(self._http, self._sign_out())

    def token(self) -> str:
        """The bearer token for the next request: cached, or fetched by one request however many threads ask."""
        with self._lock:
            if (cached := self._cached_token()) is not None:
                return cached
            flight = self._flight
            leader = flight is None
            if flight is None:
                flight = self._flight = _SyncFlight()
        if not leader:
            flight.done.wait()
            if flight.error is not None:
                raise flight.error
            assert flight.token is not None
            return flight.token
        try:
            flight.token = run_sync(self._http, self._fetch())
            return flight.token
        except BaseException as e:
            flight.error = e
            raise
        finally:
            with self._lock:
                self._flight = None
            flight.done.set()

    def sync_auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        if self._prepare(request):
            yield request
            return
        token = self.token()
        request.headers["Authorization"] = f"Bearer {token}"
        response = yield request
        if response.status_code == 401 and self.renews:
            with self._lock:
                self._forget(token)
            request.headers["Authorization"] = f"Bearer {self.token()}"
            yield request

    async def async_auth_flow(self, request: httpx.Request) -> AsyncGenerator[httpx.Request, httpx.Response]:
        raise RuntimeError("Caitlyn signs in synchronously; use AsyncCaitlyn with httpx.AsyncClient")
        yield request  # pragma: no cover


class AsyncAuthSession(_AuthState, httpx.Auth):
    """``AsyncCaitlyn.auth``: as ``SyncAuthSession``, for one event loop."""

    def __init__(self, mode: Auth | None, endpoint: str, workspace: str, http: httpx.AsyncClient) -> None:
        super().__init__(mode, endpoint, workspace)
        self._http = http
        self._flight: asyncio.Future[str] | None = None

    async def handle_callback(
        self, *, code: str, code_verifier: str, state: str | None = None, expected_state: str | None = None, redirect_uri: str | None = None
    ) -> OAuthTokens:
        """Finishes sign-in (``OAuth`` mode): checks the state when ``expected_state`` is given, exchanges the
        code and saves the tokens to the token store."""
        return await run_async(self._http, self._callback(code, code_verifier, state, expected_state, redirect_uri))

    async def sign_out(self) -> None:
        """Signs out (``OAuth`` mode): revokes the refresh token where possible and clears the token store."""
        await run_async(self._http, self._sign_out())

    async def token(self) -> str:
        """The bearer token for the next request: cached, or fetched by one request however many calls ask."""
        if (cached := self._cached_token()) is not None:
            return cached
        if self._flight is not None:
            return await asyncio.shield(self._flight)
        flight: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        flight.add_done_callback(lambda f: f.cancelled() or f.exception())  # retrieved even when nobody waits
        self._flight = flight
        try:
            token = await run_async(self._http, self._fetch())
        except BaseException as e:
            if isinstance(e, Exception):
                flight.set_exception(e)
            else:
                flight.cancel()
            raise
        else:
            flight.set_result(token)
            return token
        finally:
            self._flight = None

    def sync_auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        raise RuntimeError("AsyncCaitlyn signs in asynchronously; use Caitlyn with httpx.Client")
        yield request  # pragma: no cover

    async def async_auth_flow(self, request: httpx.Request) -> AsyncGenerator[httpx.Request, httpx.Response]:
        if self._prepare(request):
            yield request
            return
        token = await self.token()
        request.headers["Authorization"] = f"Bearer {token}"
        response = yield request
        if response.status_code == 401 and self.renews:
            self._forget(token)
            request.headers["Authorization"] = f"Bearer {await self.token()}"
            yield request
