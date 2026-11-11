//! Errors (PROTOCOL.md section 6). The generated crate wraps [`Error`] in its own enum, with one variant per
//! modelled error shape, chosen by HTTP status; this module holds what every variant carries.

use std::fmt;

use http::HeaderMap;
use serde::Deserialize;
use serde_json::Value;

/// Everything the runtime can fail with. The generated crate's `Error` maps [`Error::Api`] to its typed
/// variants by status and keeps the rest as they are.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// An RFC 9457 problem from Caitlyn, or one the SDK raised itself (`status` 0: `STREAM_LOST`,
    /// `NO_FINAL_EVENT`, `UPLOAD_PUT_FAILED`).
    Api(Box<ApiError>),
    /// An operation, or a member the caller set, is newer than the server. Nothing was sent.
    NotSupportedByServer(NotSupportedByServer),
    /// A required input is missing. Nothing was sent.
    Input(InputError),
    /// Signing in failed: the token endpoint refused, or the identity it exchanges could not be had.
    Auth(AuthError),
    /// No response arrived (connection refused or reset, DNS, a timeout before the headers), after any retries.
    Transport(TransportError),
    /// The call's cancellation token fired.
    Cancelled,
}

impl Error {
    /// The problem details, for an [`Error::Api`].
    pub fn api(&self) -> Option<&ApiError> {
        match self {
            Error::Api(e) => Some(e),
            _ => None,
        }
    }

    /// An error the SDK raises itself, in the problem-details form (status 0).
    pub fn sdk(code: &str, title: &str, source: Option<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Error::Api(Box::new(ApiError {
            code: code.to_owned(),
            title: Some(title.to_owned()),
            source,
            ..ApiError::default()
        }))
    }

    /// A required input member is missing.
    pub fn missing_input(operation: &str, member: &str) -> Self {
        Error::Input(InputError {
            operation: operation.to_owned(),
            member: member.to_owned(),
            reason: "is required".to_owned(),
        })
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Api(e) => e.fmt(f),
            Error::NotSupportedByServer(e) => e.fmt(f),
            Error::Input(e) => e.fmt(f),
            Error::Auth(e) => e.fmt(f),
            Error::Transport(e) => e.fmt(f),
            Error::Cancelled => f.write_str("caitlyn: the call was cancelled"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Api(e) => e.source.as_deref().map(|s| s as _),
            Error::Transport(e) => Some(&e.source),
            _ => None,
        }
    }
}

impl From<AuthError> for Error {
    fn from(e: AuthError) -> Self {
        Error::Auth(e)
    }
}

/// An RFC 9457 problem (PROTOCOL.md 6.3): every typed error carries these fields.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct ApiError {
    /// The HTTP status, or 0 for an error the SDK raised itself.
    pub status: u16,
    /// The stable product code, for example `NOT_FOUND`.
    pub code: String,
    pub title: Option<String>,
    pub detail: Option<String>,
    /// The code's page in the error reference, `https://build.caitlyn.ai/errors/{code}`.
    pub r#type: Option<String>,
    /// From the body, else the `Caitlyn-Request-Id` header. Quote it to support.
    pub request_id: Option<String>,
    /// `Retry-After`, in whole seconds, on 429 and 503.
    pub retry_after_seconds: Option<u64>,
    /// Field problems on a 400 `VALIDATION_FAILED`.
    pub errors: Vec<FieldError>,
    /// The problem body as received, unknown fields included.
    pub raw: Option<Value>,
    /// What caused an SDK-raised error, where there is one.
    pub source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("caitlyn: ")?;
        if self.status != 0 {
            write!(f, "{} ", self.status)?;
        }
        f.write_str(&self.code)?;
        if let Some(t) = &self.title {
            write!(f, ": {t}")?;
        }
        if let Some(d) = &self.detail {
            write!(f, " ({d})")?;
        }
        if let Some(r) = &self.request_id {
            write!(f, " [{r}]")?;
        }
        if let Some(s) = &self.source {
            write!(f, ": {s}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ApiError {}

/// One problem with one request member or query parameter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct FieldError {
    /// A JSON Pointer into the request body, for example `/identity`.
    #[serde(default)]
    pub pointer: Option<String>,
    /// The query parameter at fault.
    #[serde(default)]
    pub parameter: Option<String>,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Problem {
    #[serde(rename = "type")]
    kind: Option<String>,
    title: Option<String>,
    status: Option<u16>,
    detail: Option<String>,
    code: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    errors: Vec<FieldError>,
}

/// Builds the problem for an error response. The class is chosen by the HTTP status (PROTOCOL.md 6.2), so
/// `status` is always the response's own.
pub(crate) fn problem_from_response(status: u16, headers: &HeaderMap, body: &[u8]) -> ApiError {
    let mut e = problem_from_body(status, body);
    e.status = status;
    if e.request_id.is_none() {
        e.request_id = header(headers, "caitlyn-request-id");
    }
    if e.code.is_empty() {
        e.code = format!("HTTP_{status}");
    }
    if status == 429 || status == 503 {
        e.retry_after_seconds = header(headers, "retry-after").and_then(|v| parse_retry_after(&v));
    }
    e
}

/// Builds the problem carried by an SSE failure event: its status comes from the body.
pub(crate) fn problem_from_body(status: u16, body: &[u8]) -> ApiError {
    let mut e = ApiError {
        status,
        ..ApiError::default()
    };
    if let Ok(raw) = serde_json::from_slice::<Value>(body) {
        if let Ok(p) = Problem::deserialize(&raw) {
            e.r#type = p.kind;
            e.title = p.title;
            e.detail = p.detail;
            e.code = p.code.unwrap_or_default();
            e.request_id = p.request_id;
            e.errors = p.errors;
            if let Some(s) = p.status.filter(|s| *s != 0) {
                e.status = s;
            }
        }
        e.raw = Some(raw);
    }
    e
}

pub(crate) fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// `Retry-After` as delta-seconds or an HTTP-date, rounded up to whole seconds.
pub(crate) fn parse_retry_after(v: &str) -> Option<u64> {
    let v = v.trim();
    if let Ok(n) = v.parse::<u64>() {
        return Some(n);
    }
    let at = chrono::DateTime::parse_from_rfc2822(v).ok()?;
    let ms = (at.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_milliseconds().max(0);
    Some((ms as u64).div_ceil(1000))
}

/// An operation, or a member the caller set, needs a newer server (PROTOCOL.md section 9).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct NotSupportedByServer {
    pub operation: String,
    /// The member, when the operation itself is supported.
    pub member: Option<String>,
    /// The release the operation or member needs.
    pub requires: String,
    /// The server's `Caitlyn-Api-Version`.
    pub server: String,
}

impl fmt::Display for NotSupportedByServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "caitlyn: {}", self.operation)?;
        if let Some(m) = &self.member {
            write!(f, ".{m}")?;
        }
        write!(f, " needs Caitlyn {}; the server is {}", self.requires, self.server)
    }
}

impl std::error::Error for NotSupportedByServer {}

/// A required input is missing; nothing was sent.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct InputError {
    pub operation: String,
    pub member: String,
    pub reason: String,
}

impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "caitlyn: {}: {} {}", self.operation, self.member, self.reason)
    }
}

impl std::error::Error for InputError {}

/// A sign-in failure: the token endpoint's OAuth error, or a failure to get the identity it exchanges.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct AuthError {
    /// The OAuth error code (`invalid_client`, `invalid_grant`…), the STS code, or `sign_in_required`,
    /// `invalid_state`, `invalid_request`.
    pub code: String,
    pub message: String,
    /// The HTTP status of the refusal, where there was one.
    pub status: Option<u16>,
    pub request_id: Option<String>,
}

impl AuthError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        AuthError {
            code: code.to_owned(),
            message: message.into(),
            status: None,
            request_id: None,
        }
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "caitlyn: sign-in failed: {}: {}", self.code, self.message)
    }
}

impl std::error::Error for AuthError {}

/// No response arrived.
#[derive(Debug)]
pub struct TransportError {
    pub source: reqwest::Error,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "caitlyn: no response: {}", self.source)
    }
}

impl std::error::Error for TransportError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_seconds_and_dates() {
        assert_eq!(parse_retry_after("7"), Some(7));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), Some(0));
        assert_eq!(parse_retry_after("soon"), None);
    }

    #[test]
    fn status_comes_from_the_response() {
        let mut h = HeaderMap::new();
        h.insert("caitlyn-request-id", "R1".parse().unwrap());
        h.insert("retry-after", "3".parse().unwrap());
        let e = problem_from_response(429, &h, br#"{"status":400,"code":"RATE_LIMITED"}"#);
        assert_eq!(
            (e.status, e.code.as_str(), e.request_id.as_deref(), e.retry_after_seconds),
            (429, "RATE_LIMITED", Some("R1"), Some(3))
        );
    }
}
