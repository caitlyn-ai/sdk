//! What generated code hands the runtime for one call: the operation's description, the request before the
//! runtime adds its headers, the call options, and the response.

use std::future::{Future, IntoFuture};
use std::pin::Pin;

use http::HeaderMap;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::error::{header, Error};

/// A boxed, sendable future: what generated calls return.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One modelled operation. Generated code declares one `static` per operation.
#[derive(Debug)]
pub struct Operation {
    pub name: &'static str,
    pub method: &'static str,
    /// The operation's `@since`.
    pub since: Option<&'static str>,
    /// `@readonly`, `@idempotent`, or has an `@idempotencyToken` (PROTOCOL.md 6.4).
    pub retry_safe: bool,
    /// `@sseEvents` operations send `Accept: text/event-stream`.
    pub sse: bool,
    /// The header bound to the `@idempotencyToken` member, if any.
    pub idempotency_header: Option<&'static str>,
    /// Refuse to send without an `If-Match` call option.
    pub if_match_required: bool,
    /// Statuses of the modelled `@retryable` errors.
    pub retryable: &'static [u16],
}

/// A member the caller set that carries `@since`, for the version check.
#[derive(Debug, Clone)]
pub struct Since {
    pub member: &'static str,
    pub version: &'static str,
}

/// One call's HTTP request before the runtime adds its own headers.
#[derive(Debug, Default, Clone)]
pub struct Request {
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub content_type: Option<&'static str>,
    pub set: Vec<Since>,
}

impl Request {
    pub fn new(path: impl Into<String>) -> Self {
        Request {
            path: path.into(),
            ..Request::default()
        }
    }

    pub fn query(&mut self, name: &str, value: impl Into<String>) {
        self.query.push((name.to_owned(), value.into()));
    }

    pub fn header(&mut self, name: &str, value: impl Into<String>) {
        self.headers.push((name.to_owned(), value.into()));
    }

    /// Records that the caller set a member carrying `@since`.
    pub fn since(&mut self, member: &'static str, version: &'static str) {
        self.set.push(Since { member, version });
    }

    /// Serialises `body` (an input whose HTTP-bound members are skipped) as the JSON body.
    pub fn json_body<T: Serialize>(&mut self, body: &T) -> Result<(), Error> {
        let b = serde_json::to_vec(body)
            .map_err(|e| Error::sdk("SERIALIZATION_FAILED", "The input could not be serialised", Some(Box::new(e))))?;
        self.body = Some(b);
        self.content_type = Some("application/json");
        Ok(())
    }
}

/// Escapes a label value for one path segment.
pub fn path_label(v: &str) -> String {
    const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    percent_encoding::utf8_percent_encode(v, SEGMENT).to_string()
}

/// Options for one call: `If-Match`, the idempotency key and cancellation (PROTOCOL.md 10).
#[derive(Debug, Clone, Default)]
pub struct CallOptions {
    pub(crate) if_match: Option<String>,
    pub(crate) idempotency_key: Option<String>,
    pub(crate) cancel: Option<CancellationToken>,
}

impl CallOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sends `If-Match: etag`, for optimistic concurrency.
    pub fn if_match(mut self, etag: impl Into<String>) -> Self {
        self.if_match = Some(etag.into());
        self
    }

    /// Sends this `Idempotency-Key` instead of a generated one (kept across retries either way).
    pub fn idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    /// Cancels the call, a stream or a list when `token` fires: the connection is closed and the call fails
    /// with `Cancelled`. Dropping the future or stream also cancels it.
    pub fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// The same cancellation, without `If-Match` or the idempotency key: for the requests a call makes on its
    /// own behalf (resuming a stream).
    pub fn cancellation_only(&self) -> CallOptions {
        CallOptions {
            cancel: self.cancel.clone(),
            ..CallOptions::default()
        }
    }

    pub(crate) async fn cancelled(&self) {
        match &self.cancel {
            Some(t) => t.cancelled().await,
            None => std::future::pending().await,
        }
    }
}

/// A call that has not been sent yet. Set call options on it, then `.await` it.
///
/// ```ignore
/// let draft = client.versions().update_draft(agent_id, input).if_match(etag).await?;
/// ```
#[must_use = "a call does nothing until it is awaited"]
pub struct Call<T, Er> {
    opts: CallOptions,
    run: Box<dyn FnOnce(CallOptions) -> BoxFuture<'static, Result<T, Er>> + Send>,
}

impl<T, Er> Call<T, Er> {
    pub fn new(run: impl FnOnce(CallOptions) -> BoxFuture<'static, Result<T, Er>> + Send + 'static) -> Self {
        Call {
            opts: CallOptions::default(),
            run: Box::new(run),
        }
    }

    /// Sends `If-Match: etag`.
    pub fn if_match(mut self, etag: impl Into<String>) -> Self {
        self.opts = self.opts.if_match(etag);
        self
    }

    /// Sends this idempotency key instead of a generated one.
    pub fn idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.opts = self.opts.idempotency_key(key);
        self
    }

    /// Fails the call with `Cancelled` when `token` fires.
    pub fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.opts = self.opts.cancel_on(token);
        self
    }

    /// Replaces every call option at once.
    pub fn options(mut self, opts: CallOptions) -> Self {
        self.opts = opts;
        self
    }
}

impl<T, Er> IntoFuture for Call<T, Er> {
    type Output = Result<T, Er>;
    type IntoFuture = BoxFuture<'static, Result<T, Er>>;

    fn into_future(self) -> Self::IntoFuture {
        (self.run)(self.opts)
    }
}

/// A successful (2xx) response.
#[derive(Debug)]
pub struct Response {
    pub(crate) inner: reqwest::Response,
    pub(crate) cancel: Option<CancellationToken>,
}

impl Response {
    pub fn headers(&self) -> &HeaderMap {
        self.inner.headers()
    }

    /// The header's value, if present.
    pub fn header(&self, name: &str) -> Option<String> {
        header(self.inner.headers(), name)
    }

    /// Reads the body as JSON. An empty body gives `T::default()`.
    pub async fn json<T: DeserializeOwned + Default>(self) -> Result<T, Error> {
        let bytes = self
            .inner
            .bytes()
            .await
            .map_err(|e| Error::sdk("READ_FAILED", "The response could not be read", Some(Box::new(e))))?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(T::default());
        }
        serde_json::from_slice(&bytes).map_err(|e| Error::sdk("DECODE_FAILED", "The response could not be decoded", Some(Box::new(e))))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn labels_escape_one_segment() {
        assert_eq!(super::path_label("a b/c~d"), "a%20b%2Fc~d");
    }
}
