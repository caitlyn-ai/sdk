//! The runtime half of a generated client: the workspace and endpoint, request headers, sign-in, retries,
//! `@since` checks and spans (PROTOCOL.md sections 3, 4, 6.4, 9).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use http::{HeaderMap, HeaderName, HeaderValue};
use tracing::field::Empty;
use tracing::Instrument;

use crate::auth::{Auth, AuthSession, Credential};
use crate::error::{header, problem_from_response, ConnectionError, Error, NotSupportedByServer, CONNECTION_ERROR};
use crate::request::{CallOptions, Operation, Request, Response};
use crate::telemetry::Propagator;

/// Identifies the generated SDK that owns a client. Generated code fills it in.
#[derive(Debug, Clone, Copy)]
pub struct SdkInfo {
    /// The SDK's own version, for the user agent.
    pub version: &'static str,
    /// The highest `@since` in the model, sent as `Caitlyn-Sdk-Model`.
    pub model_version: &'static str,
    /// Every error shape in the model, by HTTP status: the class name telemetry reports as `error.type`.
    pub error_shapes: &'static [(u16, &'static str)],
}

/// A workspace given as a hostname or a URL, as its bare hostname: `https://acme.getcaitlyn.ai/` gives
/// `acme.getcaitlyn.ai`.
pub fn workspace_host(workspace: &str) -> String {
    let w = workspace.trim();
    let w = w.strip_prefix("https://").or_else(|| w.strip_prefix("http://")).unwrap_or(w);
    w.split('/').next().unwrap_or_default().to_owned()
}

/// The base URL of a workspace's API, `https://<workspace>/api`; operation paths (`/v3/…`) are appended to it.
pub fn workspace_endpoint(workspace: &str) -> String {
    format!("https://{}/api", workspace_host(workspace))
}

/// The audience every token for a workspace is bound to: `https://<workspace>/api`.
pub fn workspace_audience(workspace: &str) -> String {
    format!("https://{}/api", workspace_host(workspace))
}

/// Builds a [`Client`]. Like an AWS region, the workspace decides where requests go and which audience tokens
/// are bound to; `endpoint` moves only where requests go.
pub struct ClientBuilder {
    sdk: SdkInfo,
    workspace: String,
    auth: Auth,
    endpoint: Option<String>,
    http: Option<reqwest::Client>,
    max_attempts: u32,
    max_retry_delay: Duration,
    app_id: Option<String>,
    propagator: Option<Arc<dyn Propagator>>,
    retry_budget: u32,
}

impl ClientBuilder {
    pub fn new(sdk: SdkInfo, workspace: impl Into<String>, auth: Auth) -> Self {
        ClientBuilder {
            sdk,
            workspace: workspace.into(),
            auth,
            endpoint: None,
            http: None,
            max_attempts: 3,
            max_retry_delay: Duration::from_secs(60),
            app_id: None,
            propagator: None,
            retry_budget: crate::budget::DEFAULT_RETRY_BUDGET,
        }
    }

    /// Sends requests (and token requests) to `endpoint` instead of `https://<workspace>/api`, for a proxy or a
    /// local app. It never changes the token audience.
    pub fn endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into().trim_end_matches('/').to_owned());
        self
    }

    /// Replaces the HTTP client (for example to set timeouts or a proxy).
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http = Some(client);
        self
    }

    /// Attempts for a retry-safe operation, the first included (default 3).
    pub fn max_attempts(mut self, n: u32) -> Self {
        self.max_attempts = n.max(1);
        self
    }

    /// The longest `Retry-After` the client waits for (default 60 s); a longer one fails at once.
    pub fn max_retry_delay(mut self, d: Duration) -> Self {
        self.max_retry_delay = d;
        self
    }

    /// The size of the client's retry budget, in tokens (default 500). A retry costs 5, or 10 after an attempt that
    /// got no response; a call that succeeds gives back 1, or its last retry's cost. When the budget cannot pay for a
    /// retry, the call fails at once with its error. 0 turns retries off (PROTOCOL.md 6.4.6).
    pub fn retry_budget(mut self, tokens: u32) -> Self {
        self.retry_budget = tokens;
        self
    }

    /// Adds `app/<id>` to the user agent.
    pub fn app_id(mut self, id: impl Into<String>) -> Self {
        self.app_id = Some(id.into());
        self
    }

    /// Writes `traceparent`, `tracestate` and `baggage` into each attempt's headers. With none, nothing is sent.
    pub fn propagator(mut self, p: impl Propagator + 'static) -> Self {
        self.propagator = Some(Arc::new(p));
        self
    }

    pub fn build(self) -> Result<Client, Error> {
        let workspace = workspace_host(&self.workspace);
        if workspace.is_empty() {
            return Err(Error::missing_input("Client", "workspace"));
        }
        let endpoint = self.endpoint.unwrap_or_else(|| workspace_endpoint(&workspace));
        let http = match self.http {
            Some(h) => h,
            None => default_http_client()?,
        };
        let auth = AuthSession::new(self.auth, &endpoint, &workspace, http.clone());
        Ok(Client {
            inner: Arc::new(Inner {
                user_agent: user_agent(self.sdk.version, self.app_id.as_deref()),
                sdk: self.sdk,
                workspace,
                endpoint,
                http,
                max_attempts: self.max_attempts,
                max_retry_delay: self.max_retry_delay,
                propagator: self.propagator,
                auth,
                budget: crate::budget::RetryBudget::new(self.retry_budget),
                server_version: Mutex::new(None),
            }),
        })
    }
}

pub(crate) fn default_http_client() -> Result<reqwest::Client, Error> {
    #[cfg(feature = "rustls-ring")]
    {
        // reqwest's rustls needs a process-wide crypto provider; keep one the application installed.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .build()
        .map_err(|e| Error::sdk("HTTP_CLIENT_FAILED", "The HTTP client could not be built", Some(Box::new(e))))
}

/// `caitlyn-sdk-rust/<v> lang/rust#<rustc> md/rustc os/<os> [app/<id>]` (PROTOCOL.md 3.1).
fn user_agent(version: &str, app_id: Option<&str>) -> String {
    let mut ua = format!(
        "caitlyn-sdk-rust/{version} lang/rust#{} md/rustc os/{}",
        env!("CAITLYN_RUSTC_VERSION"),
        std::env::consts::OS
    );
    if let Some(id) = app_id {
        ua.push_str(" app/");
        ua.push_str(id);
    }
    ua
}

/// The runtime half of a generated client. Cheap to clone; clones share the token cache and the server version.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    sdk: SdkInfo,
    workspace: String,
    endpoint: String,
    http: reqwest::Client,
    max_attempts: u32,
    max_retry_delay: Duration,
    user_agent: String,
    propagator: Option<Arc<dyn Propagator>>,
    auth: AuthSession,
    budget: crate::budget::RetryBudget,
    server_version: Mutex<Option<String>>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("workspace", &self.inner.workspace)
            .field("endpoint", &self.inner.endpoint)
            .finish_non_exhaustive()
    }
}

/// A failure of one attempt, before retries decide.
enum AttemptError {
    /// No response arrived: retryable on a retry-safe operation.
    NoResponse(reqwest::Error),
    Other(Error),
}

impl Client {
    /// The workspace hostname.
    pub fn workspace(&self) -> &str {
        &self.inner.workspace
    }

    /// The base URL requests are sent to: `https://<workspace>/api`, or the `endpoint` override.
    pub fn endpoint(&self) -> &str {
        &self.inner.endpoint
    }

    /// Sign-in: the current token, and the `oauth` mode's sign-in steps.
    pub fn auth(&self) -> &AuthSession {
        &self.inner.auth
    }

    /// The latest `Caitlyn-Api-Version` the client has seen, or `None` before any response.
    pub fn server_version(&self) -> Option<String> {
        self.inner.server_version.lock().expect("server version lock").clone()
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.inner.http
    }

    fn note_server_version(&self, headers: &HeaderMap) {
        if let Some(v) = header(headers, "caitlyn-api-version").filter(|v| !v.is_empty()) {
            *self.inner.server_version.lock().expect("server version lock") = Some(v);
        }
    }

    /// Sends a request with retries and returns the 2xx response. Cancellation (the call option, or dropping the
    /// future) closes the connection and stops any wait.
    pub async fn send(&self, op: &'static Operation, req: Request, opts: &CallOptions) -> Result<Response, Error> {
        tokio::select! {
            biased;
            _ = opts.cancelled() => Err(Error::Cancelled),
            r = self.send_inner(op, req, opts) => r,
        }
    }

    async fn send_inner(&self, op: &'static Operation, req: Request, opts: &CallOptions) -> Result<Response, Error> {
        self.check_since(op, &req)?;
        if op.if_match_required && opts.if_match.is_none() {
            return Err(Error::Input(crate::error::InputError {
                operation: op.name.to_owned(),
                member: "If-Match".to_owned(),
                reason: "is required: call .if_match(etag)".to_owned(),
            }));
        }
        let idempotency_key = op
            .idempotency_header
            .map(|_| opts.idempotency_key.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));

        // PROTOCOL.md 13: one caitlyn.call span, one caitlyn.attempt child per HTTP attempt.
        let span = tracing::info_span!(
            "caitlyn.call",
            otel.name = "caitlyn.call",
            otel.kind = "client",
            otel.status_code = Empty,
            otel.status_message = Empty,
            rpc.system = "caitlyn",
            rpc.method = op.name,
            caitlyn.request_id = Empty,
            error.type = Empty,
            caitlyn.error.code = Empty,
        );
        let (server_address, url_full) = crate::telemetry::http_target(&format!("{}{}", self.inner.endpoint, req.path));
        async {
            let mut attempt: u32 = 0;
            let mut signed_in_again = false;
            let mut last_retry_cost: Option<u32> = None; // PROTOCOL.md 6.4.6
            loop {
                let attempt_span = tracing::info_span!(
                    "caitlyn.attempt",
                    otel.name = "caitlyn.attempt",
                    otel.kind = "client",
                    otel.status_code = Empty,
                    otel.status_message = Empty,
                    error.type = Empty,
                    caitlyn.error.code = Empty,
                    http.request.method = op.method,
                    server.address = server_address.as_str(),
                    url.full = url_full.as_str(),
                    http.request.resend_count = attempt,
                    http.response.status_code = Empty,
                    caitlyn.request_id = Empty,
                    caitlyn.server.api_version = Empty,
                );
                let result = self
                    .attempt(op, &req, opts, idempotency_key.as_deref())
                    .instrument(attempt_span)
                    .await;
                let span = tracing::Span::current();
                let err = match result {
                    Ok(resp) => {
                        if let Some(id) = resp.header("caitlyn-request-id") {
                            span.record("caitlyn.request_id", id.as_str());
                        }
                        self.inner.budget.release(last_retry_cost);
                        return Ok(resp);
                    }
                    Err(e) => e,
                };
                if let AttemptError::Other(Error::Api(e)) = &err {
                    if let Some(id) = &e.request_id {
                        span.record("caitlyn.request_id", id.as_str());
                    }
                    // One more try with a new token when the server stopped accepting the cached one.
                    if e.status == 401 && !signed_in_again && self.inner.auth.can_refresh() {
                        signed_in_again = true;
                        self.inner.auth.invalidate().await;
                        continue;
                    }
                }
                // The budget pays for the retry, or the call fails at once with this attempt's error.
                let cost = match err {
                    AttemptError::NoResponse(_) => crate::budget::NO_RESPONSE_RETRY_COST,
                    AttemptError::Other(_) => crate::budget::RETRY_COST,
                };
                let delay = self.retry_delay(op, &err, attempt).filter(|_| self.inner.budget.acquire(cost));
                if delay.is_some() {
                    last_retry_cost = Some(cost);
                }
                match delay {
                    Some(delay) => {
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                    }
                    None => {
                        let e = match err {
                            AttemptError::NoResponse(source) => Error::Connection(ConnectionError::new(op.name, source)),
                            AttemptError::Other(e) => e,
                        };
                        crate::telemetry::record_failure(&span, &e, self.inner.sdk.error_shapes);
                        return Err(e);
                    }
                }
            }
        }
        .instrument(span)
        .await
    }

    async fn attempt(
        &self,
        op: &'static Operation,
        req: &Request,
        opts: &CallOptions,
        idempotency_key: Option<&str>,
    ) -> Result<Response, AttemptError> {
        let mut url = format!("{}{}", self.inner.endpoint, req.path);
        if !req.query.is_empty() {
            let mut q = url::form_urlencoded::Serializer::new(String::new());
            for (k, v) in &req.query {
                q.append_pair(k, v);
            }
            url.push('?');
            url.push_str(&q.finish());
        }
        let method = http::Method::from_bytes(op.method.as_bytes())
            .map_err(|e| AttemptError::Other(Error::sdk("BAD_METHOD", "The operation's method is not valid", Some(Box::new(e)))))?;
        let mut headers = HeaderMap::new();
        for (k, v) in &req.headers {
            append(&mut headers, k, v);
        }
        append(&mut headers, "user-agent", &self.inner.user_agent);
        append(&mut headers, "caitlyn-sdk-model", self.inner.sdk.model_version);
        if let Some(ct) = req.content_type {
            append(&mut headers, "content-type", ct);
        }
        if op.sse {
            append(&mut headers, "accept", "text/event-stream");
        }
        if let (Some(h), Some(k)) = (op.idempotency_header, idempotency_key) {
            append(&mut headers, h, k);
        }
        if let Some(m) = &opts.if_match {
            append(&mut headers, "if-match", m);
        }
        match self.inner.auth.credential().await.map_err(|e| AttemptError::Other(e.into()))? {
            Credential::Bearer(t) => append(&mut headers, "authorization", &format!("Bearer {t}")),
            Credential::Session { cookie, origin } => {
                if let Some(c) = cookie {
                    append(&mut headers, "cookie", &c);
                }
                if method != http::Method::GET && method != http::Method::HEAD {
                    append(&mut headers, "origin", &origin);
                }
            }
        }
        if let Some(p) = &self.inner.propagator {
            p.inject(&tracing::Span::current(), &mut headers);
        }

        let mut rb = self.inner.http.request(method, url).headers(headers);
        if let Some(b) = &req.body {
            rb = rb.body(b.clone());
        }
        let attempt_span = tracing::Span::current();
        let resp = rb.send().await.map_err(|e| {
            // The call raises this as Error::Connection once retries are spent; the attempt reports it as one.
            let message = format!("caitlyn: {CONNECTION_ERROR}: {}: no response: {e}", op.name);
            crate::telemetry::record_failure_fields(&attempt_span, "CaitlynConnectionError", Some(CONNECTION_ERROR), &message);
            AttemptError::NoResponse(e)
        })?;
        let status = resp.status().as_u16();
        attempt_span.record("http.response.status_code", status);
        if let Some(id) = header(resp.headers(), "caitlyn-request-id") {
            attempt_span.record("caitlyn.request_id", id.as_str());
        }
        if let Some(v) = header(resp.headers(), "caitlyn-api-version") {
            attempt_span.record("caitlyn.server.api_version", v.as_str());
        }
        self.note_server_version(resp.headers());
        if resp.status().is_success() {
            return Ok(Response {
                inner: resp,
                cancel: opts.cancel.clone(),
                operation: op.name,
            });
        }
        let headers = resp.headers().clone();
        let body = read_limited(resp, 1 << 20).await;
        let e = Error::Api(Box::new(problem_from_response(status, &headers, &body)));
        crate::telemetry::record_failure(&attempt_span, &e, self.inner.sdk.error_shapes);
        Err(AttemptError::Other(e))
    }

    /// PROTOCOL.md 6.4: only retry-safe operations, only modelled retryable statuses or no response at all.
    fn retry_delay(&self, op: &Operation, err: &AttemptError, attempt: u32) -> Option<Duration> {
        if !op.retry_safe || attempt + 1 >= self.inner.max_attempts {
            return None;
        }
        match err {
            AttemptError::NoResponse(_) => Some(backoff(attempt)),
            AttemptError::Other(Error::Api(e)) if op.retryable.contains(&e.status) => match e.retry_after_seconds {
                Some(s) if Duration::from_secs(s) > self.inner.max_retry_delay => None,
                Some(s) => Some(Duration::from_secs(s)),
                None => Some(backoff(attempt)),
            },
            AttemptError::Other(_) => None,
        }
    }

    fn check_since(&self, op: &Operation, req: &Request) -> Result<(), Error> {
        let Some(server) = self.server_version() else { return Ok(()) };
        if let Some(since) = op.since {
            if compare_versions(since, &server).is_gt() {
                return Err(Error::NotSupportedByServer(NotSupportedByServer {
                    operation: op.name.to_owned(),
                    member: None,
                    requires: since.to_owned(),
                    server,
                }));
            }
        }
        for m in &req.set {
            if compare_versions(m.version, &server).is_gt() {
                return Err(Error::NotSupportedByServer(NotSupportedByServer {
                    operation: op.name.to_owned(),
                    member: Some(m.member.to_owned()),
                    requires: m.version.to_owned(),
                    server,
                }));
            }
        }
        Ok(())
    }
}

fn append(headers: &mut HeaderMap, name: &str, value: &str) {
    if let (Ok(n), Ok(v)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) {
        headers.append(n, v);
    }
}

async fn read_limited(mut resp: reqwest::Response, limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        out.extend_from_slice(&chunk);
        if out.len() >= limit {
            out.truncate(limit);
            break;
        }
    }
    out
}

/// Full-jitter exponential: `random(0, min(8 s, 0.5 s × 2^retry))`.
pub(crate) fn backoff(retry: u32) -> Duration {
    let ceil_ms: u64 = 500u64.checked_shl(retry.min(10)).unwrap_or(8_000).min(8_000);
    Duration::from_millis(random_u64() % (ceil_ms + 1))
}

pub(crate) fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    let _ = getrandom::getrandom(&mut b);
    u64::from_le_bytes(b)
}

/// Compares dotted release numbers (`5.115.0`).
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) {
        let o = x.get(i).copied().unwrap_or(0).cmp(&y.get(i).copied().unwrap_or(0));
        if o.is_ne() {
            return o;
        }
    }
    std::cmp::Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_decides_endpoint_and_audience() {
        assert_eq!(workspace_host("https://acme.getcaitlyn.ai/"), "acme.getcaitlyn.ai");
        assert_eq!(workspace_endpoint("acme.getcaitlyn.ai"), "https://acme.getcaitlyn.ai/api");
        assert_eq!(workspace_audience("https://acme.getcaitlyn.ai/x"), "https://acme.getcaitlyn.ai/api");
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(compare_versions("5.115.0", "5.20.1").is_gt());
        assert!(compare_versions("5.115", "5.115.0").is_eq());
    }

    #[test]
    fn backoff_is_capped() {
        for r in 0..40 {
            assert!(backoff(r) <= Duration::from_secs(8));
        }
    }
}
