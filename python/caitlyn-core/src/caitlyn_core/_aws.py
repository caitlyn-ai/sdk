"""The AWS half of the ``AwsIam`` sign-in mode, with no AWS SDK: a minimal Signature Version 4 signer, the two
credential sources AWS workloads actually use (environment variables, and the container credentials endpoint
that ECS, Fargate and AgentCore runtimes set), and one call, STS ``GetWebIdentityToken``. Anything else
(profiles, single sign-on, instance metadata) is reached by passing ``credentials``, for example a function
that returns boto3's ``Session().get_credentials().get_frozen_credentials()`` as ``AwsCredentials``."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from ._steps import Steps, send


@dataclass(frozen=True, slots=True)
class AwsCredentials:
    access_key_id: str
    secret_access_key: str = field(repr=False)
    session_token: str | None = field(default=None, repr=False)
    expiration: datetime | None = None
    """When the credentials stop working, when known."""


class AwsStsError(Exception):
    """STS refused the call: ``code`` is the STS error code (``SignatureDoesNotMatch``…)."""

    def __init__(self, message: str, code: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac(key: bytes, data: str) -> bytes:
    return hmac.new(key, data.encode(), hashlib.sha256).digest()


def _encode(s: str) -> str:
    """RFC 3986 encoding, as Signature Version 4 requires."""
    return quote(s, safe="-_.~")


def sign_v4(
    method: str, url: httpx.URL, headers: dict[str, str], body: bytes, credentials: AwsCredentials, region: str, service: str, now: datetime | None = None
) -> dict[str, str]:
    """Signs a request with Signature Version 4 (header form) and returns the headers to send, including
    ``authorization``, ``x-amz-date``, ``x-amz-content-sha256`` and, for temporary credentials,
    ``x-amz-security-token``. ``host`` is signed but not returned: the HTTP client sets it."""
    amz_date = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    day = amz_date[:8]
    payload_hash = _sha256(body)
    signed: dict[str, str] = {k.lower(): " ".join(v.split()) for k, v in headers.items()}
    signed["host"] = url.netloc.decode()
    signed["x-amz-date"] = amz_date
    signed["x-amz-content-sha256"] = payload_hash
    if credentials.session_token:
        signed["x-amz-security-token"] = credentials.session_token
    names = sorted(signed)
    query = "&".join(f"{k}={v}" for k, v in sorted((_encode(k), _encode(v)) for k, v in url.params.multi_items()))
    path = "/".join(_encode(p) for p in url.path.split("/")) or "/"
    canonical = "\n".join([method, path, query, "".join(f"{n}:{signed[n]}\n" for n in names), ";".join(names), payload_hash])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, _sha256(canonical.encode())])
    key = _hmac(f"AWS4{credentials.secret_access_key}".encode(), day)
    for part in (region, service, "aws4_request"):
        key = _hmac(key, part)
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    signed["authorization"] = f"AWS4-HMAC-SHA256 Credential={credentials.access_key_id}/{scope}, SignedHeaders={';'.join(names)}, Signature={signature}"
    del signed["host"]
    return signed


def default_credentials() -> Steps[AwsCredentials]:
    """``AWS_ACCESS_KEY_ID`` and ``AWS_SECRET_ACCESS_KEY`` (with ``AWS_SESSION_TOKEN``), as Lambda and CI runners
    set them; otherwise the container credentials endpoint (``AWS_CONTAINER_CREDENTIALS_FULL_URI`` or
    ``_RELATIVE_URI``), as ECS, Fargate and AgentCore runtimes set it."""
    env = os.environ
    key_id, secret = env.get("AWS_ACCESS_KEY_ID"), env.get("AWS_SECRET_ACCESS_KEY")
    if key_id and secret:
        return AwsCredentials(key_id, secret, env.get("AWS_SESSION_TOKEN") or None)
    url = env.get("AWS_CONTAINER_CREDENTIALS_FULL_URI")
    if not url and (relative := env.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")):
        url = f"http://169.254.170.2{relative}"
    if url:
        token = env.get("AWS_CONTAINER_AUTHORIZATION_TOKEN")
        if not token and (token_file := env.get("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")):
            token = Path(token_file).read_text().strip()
        response = yield from send(httpx.Request("GET", url, headers={"Authorization": token} if token else {}))
        if not response.is_success:
            raise RuntimeError(f"awsIam: the container credentials endpoint answered {response.status_code}")
        c: dict[str, Any] = response.json()
        expiration = datetime.fromisoformat(c["Expiration"].replace("Z", "+00:00")) if c.get("Expiration") else None
        return AwsCredentials(c["AccessKeyId"], c["SecretAccessKey"], c.get("Token"), expiration)
    raise RuntimeError(
        "awsIam: no AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, run where the container "
        "credentials endpoint is set, or pass credentials= (an AwsCredentials, or a function that returns one)."
    )


def _xml_text(xml: str, tag: str) -> str | None:
    m = re.search(rf"<{tag}>([^<]*)</{tag}>", xml)
    return m.group(1) if m else None


def get_web_identity_token(
    *, region: str, audience: str, credentials: AwsCredentials, signing_algorithm: str, duration_seconds: int, sts_endpoint: str | None
) -> Steps[str]:
    """Calls STS ``GetWebIdentityToken`` (outbound identity federation) on a regional endpoint; returns the JWT."""
    url = httpx.URL(sts_endpoint or f"https://sts.{region}.amazonaws.com/")
    body = urlencode(
        {
            "Action": "GetWebIdentityToken",
            "Version": "2011-06-15",
            "Audience.member.1": audience,
            "DurationSeconds": str(duration_seconds),
            "SigningAlgorithm": signing_algorithm,
        }
    ).encode()
    headers = sign_v4("POST", url, {"content-type": "application/x-www-form-urlencoded; charset=utf-8"}, body, credentials, region, "sts")
    response = yield from send(httpx.Request("POST", url, headers=headers, content=body))
    text = response.text
    if not response.is_success:
        code = _xml_text(text, "Code") or f"HTTP {response.status_code}"
        raise AwsStsError(f"awsIam: STS GetWebIdentityToken failed: {code}: {_xml_text(text, 'Message') or ''}".strip(), code, response.status_code)
    token = _xml_text(text, "WebIdentityToken")
    if not token:
        raise RuntimeError("awsIam: STS answered without a WebIdentityToken")
    return token
