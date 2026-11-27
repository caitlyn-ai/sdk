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

/// A workspace given as a hostname or a URL, as its bare hostname: `https://acme.caitlyn.ai/` gives
/// `acme.caitlyn.ai`.
pub fn workspace_host(workspace: &str) -> String {
    if let Ok(host) = parse_workspace(workspace) {
        return host;
    }
    let w = workspace.trim();
    let w = w.strip_prefix("https://").or_else(|| w.strip_prefix("http://")).unwrap_or(w);
    w.split('/').next().unwrap_or_default().to_owned()
}

/// A workspace given as a hostname (`your-company.caitlyn.ai`) or as its URL (`https://your-company.caitlyn.ai`,
/// with or without a trailing slash), as its bare hostname in lower case. Anything else (another scheme, a path, a
/// query string, a fragment, user information, an empty value) is an error message that names the expected form
/// (PROTOCOL.md 12.1). [`ClientBuilder::build`] calls it.
pub fn parse_workspace(workspace: &str) -> Result<String, String> {
    let given = workspace.trim();
    let refuse = |what: &str| {
        Err(format!(
            "must be a hostname such as your-company.caitlyn.ai or https://your-company.caitlyn.ai; {given:?} {what}. \
             Use ClientBuilder::endpoint for a proxy or a local server"
        ))
    };
    if given.is_empty() {
        return refuse("is empty");
    }
    let mut host = given;
    if let Some(i) = given.find("://") {
        let scheme = &given[..i];
        let is_scheme = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c));
        if is_scheme {
            if !scheme.eq_ignore_ascii_case("https") {
                return refuse(&format!("has the scheme {scheme}:// (only https:// is allowed)"));
            }
            host = &given[i + 3..];
        }
    }
    let host = host.strip_suffix('/').unwrap_or(host);
    if host.contains(['?', '#']) {
        return refuse("has a query string or fragment");
    }
    if host.contains('/') {
        return refuse("has a path");
    }
    if host.contains('@') {
        return refuse("has user information");
    }
    let (name, port) = host.split_once(':').unwrap_or((host, ""));
    let name_ok =
        !name.is_empty() && !name.starts_with(['.', '-']) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let port_ok = !host.contains(':') || (!port.is_empty() && port.chars().all(|c| c.is_ascii_digit()));
    if !name_ok || !port_ok {
        return refuse("is not a hostname");
    }
    Ok(host.to_ascii_lowercase())
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
    ci: Option<String>,
    agent: Option<String>,
    propagator: Option<Arc<dyn Propagator>>,
    retry_budget: u32,
    spool_dir: Option<std::path::PathBuf>,
    request_timeout: Option<Duration>,
    storage_stall_timeout: Option<Duration>,
}

/// How long the default HTTP client waits to connect, and for each read of a response (its headers, and each chunk of
/// its body), before an attempt fails as a connection failure with no response (PROTOCOL.md 6.4). Per read, never the
/// whole exchange: a stream, a watch and a wait stay open while events or keep-alives arrive.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// How long a send to storage may send no request bytes and receive no response before that attempt is abandoned and
/// retried (PROTOCOL.md 14). Not an overall limit: a large file on a slow link carries on while its bytes keep moving.
pub const DEFAULT_STORAGE_STALL_TIMEOUT: Duration = Duration::from_secs(60);

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
            ci: None,
            agent: None,
            propagator: None,
            retry_budget: crate::budget::DEFAULT_RETRY_BUDGET,
            spool_dir: None,
            request_timeout: Some(DEFAULT_REQUEST_TIMEOUT),
            storage_stall_timeout: Some(DEFAULT_STORAGE_STALL_TIMEOUT),
        }
    }

    /// How long the client waits to connect, and for each read of a response, before an attempt fails as a connection
    /// failure with no response (default 120 s; `None` waits as long as it takes). Each read, not the whole exchange,
    /// so streams and waits are not cut while their keep-alives arrive. It sets the default HTTP client's
    /// `connect_timeout` and `read_timeout`; an [`http_client`](Self::http_client) of your own keeps its own.
    pub fn request_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.request_timeout = timeout;
        self
    }

    /// How long a send to storage (an upload's bytes) may send and receive nothing before that attempt is abandoned and
    /// retried (default 60 s; `None` never gives up). Not an overall limit (PROTOCOL.md 14).
    pub fn storage_stall_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.storage_stall_timeout = timeout;
        self
    }

    /// Sends requests (and token requests) to `endpoint` instead of `https://<workspace>/api`, for a proxy or a
    /// local app. It never changes the token audience.
    pub fn endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into().trim_end_matches('/').to_owned());
        self
    }

    /// Replaces the HTTP client (for example to set timeouts or a proxy). Build it with
    /// `redirect(reqwest::redirect::Policy::none())`: a document's download address is a 302 the SDK returns, not follows.
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

    /// Adds `ci/<provider>` to the user agent, after `app/`: the CI system the application recognises it is running in
    /// (github, gitlab, buildkite, circleci, jenkins, azure-pipelines, bitbucket, or generic). Declared only, never used
    /// for authorisation (PROTOCOL.md 3.2). The value is 1 to 32 of a-z, 0-9 and -, or `build` fails.
    pub fn ci(mut self, provider: impl Into<String>) -> Self {
        self.ci = Some(provider.into());
        self
    }

    /// Adds `agent/<name>` to the user agent, after `app/` and `ci/`: the AI agent the application recognises is
    /// driving it, such as claude-code. Declared only, never used for authorisation (PROTOCOL.md 3.2). The value is 1 to
    /// 32 of a-z, 0-9 and -, or `build` fails.
    pub fn agent(mut self, name: impl Into<String>) -> Self {
        self.agent = Some(name.into());
        self
    }

    /// Writes `traceparent`, `tracestate` and `baggage` into each attempt's headers. With none, nothing is sent.
    pub fn propagator(mut self, p: impl Propagator + 'static) -> Self {
        self.propagator = Some(Arc::new(p));
        self
    }

    /// Where a one-shot reader past 8 MiB is spooled while it is hashed (PROTOCOL.md 14): a file only its owner can
    /// read, deleted when the call ends. Default: the system's temporary directory.
    pub fn spool_dir(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.spool_dir = Some(dir.into());
        self
    }

    pub fn build(self) -> Result<Client, Error> {
        for (member, value) in [("ci", &self.ci), ("agent", &self.agent)] {
            if let Some(v) = value {
                let valid = (1..=32).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
                if !valid {
                    return Err(Error::Input(crate::error::InputError {
                        operation: "Client".to_owned(),
                        member: member.to_owned(),
                        reason: format!("the {member}/ user-agent value {v:?} must be 1 to 32 of a-z, 0-9 and -"),
                    }));
                }
            }
        }
        let workspace = parse_workspace(&self.workspace).map_err(|reason| {
            Error::Input(crate::error::InputError {
                operation: "Client".to_owned(),
                member: "workspace".to_owned(),
                reason,
            })
        })?;
        let endpoint = self.endpoint.unwrap_or_else(|| workspace_endpoint(&workspace));
        let http = match self.http {
            Some(h) => h,
            None => http_client_with(self.request_timeout)?,
        };
        let auth = AuthSession::new(self.auth, &endpoint, &workspace, http.clone());
        Ok(Client {
            inner: Arc::new(Inner {
                user_agent: user_agent(self.sdk.version, self.app_id.as_deref(), self.ci.as_deref(), self.agent.as_deref()),
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
                spool_dir: self.spool_dir,
                storage_stall_timeout: self.storage_stall_timeout,
            }),
        })
    }
}

/// The SDK's own HTTP client, with the request timeout as its connect and read timeouts.
pub(crate) fn http_client_with(timeout: Option<Duration>) -> Result<reqwest::Client, Error> {
    #[cfg(feature = "rustls-ring")]
    {
        // reqwest's rustls needs a process-wide crypto provider; keep one the application installed.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    // Redirects are not followed: a 302 is an answer (GetDocumentContent's address, which `download()` returns).
    let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Some(t) = timeout {
        b = b.connect_timeout(t).read_timeout(t);
    }
    b.build()
        .map_err(|e| Error::sdk("HTTP_CLIENT_FAILED", "The HTTP client could not be built", Some(Box::new(e))))
}

/// `caitlyn-sdk-rust/<v> lang/rust#<rustc> md/rustc os/<os> [app/<id>] [ci/<provider>] [agent/<name>]` (PROTOCOL.md 3.1).
fn user_agent(version: &str, app_id: Option<&str>, ci: Option<&str>, agent: Option<&str>) -> String {
    let mut ua = format!(
        "caitlyn-sdk-rust/{version} lang/rust#{} md/rustc os/{}",
        env!("CAITLYN_RUSTC_VERSION"),
        std::env::consts::OS
    );
    for (token, value) in [("app", app_id), ("ci", ci), ("agent", agent)] {
        if let Some(v) = value {
            ua.push_str(&format!(" {token}/{v}"));
        }
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
    spool_dir: Option<std::path::PathBuf>,
    storage_stall_timeout: Option<Duration>,
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

    pub(crate) fn max_attempts(&self) -> u32 {
        self.inner.max_attempts
    }

    pub(crate) fn max_retry_delay(&self) -> Duration {
        self.inner.max_retry_delay
    }

    pub(crate) fn storage_stall_timeout(&self) -> Option<Duration> {
        self.inner.storage_stall_timeout
    }

    pub(crate) fn budget(&self) -> &crate::budget::RetryBudget {
        &self.inner.budget
    }

    /// Where one-shot readers are spooled (PROTOCOL.md 14).
    pub fn spool_dir(&self) -> std::path::PathBuf {
        self.inner.spool_dir.clone().unwrap_or_else(std::env::temp_dir)
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
            // Cancelled wins (PROTOCOL.md 6.4.5): a call cancelled by the time its attempt is answered ends cancelled,
            // whatever the answer was.
            r = self.send_inner(op, req, opts) => if opts.is_cancelled() { Err(Error::Cancelled) } else { r },
        }
    }

    async fn send_inner(&self, op: &'static Operation, req: Request, opts: &CallOptions) -> Result<Response, Error> {
        self.check_since(op, &req)?;
        crate::ranges::check(op.ranges, &req)?;
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
                let mut sent_token = None;
                let result = self
                    .attempt(op, &req, opts, idempotency_key.as_deref(), &mut sent_token)
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
                        // Forget only the token that was refused: one renewed meanwhile by another call stays.
                        self.inner.auth.invalidate(sent_token.as_deref()).await;
                        continue;
                    }
                    // An operation the server does not have (PROTOCOL.md 9): its routing answers 404 UNKNOWN_OPERATION
                    // or 405 METHOD_NOT_ALLOWED, even before this client has seen the server's version. Never retried.
                    // A 405 without that code (a proxy's) stays the generic error.
                    if (e.status == 405 && e.code == "METHOD_NOT_ALLOWED") || (e.status == 404 && e.code == "UNKNOWN_OPERATION") {
                        let unsupported = Error::NotSupportedByServer(NotSupportedByServer {
                            operation: op.name.to_owned(),
                            member: None,
                            requires: op.since.unwrap_or("unknown").to_owned(),
                            server: self.server_version().unwrap_or_else(|| "unknown".to_owned()),
                        });
                        crate::telemetry::record_failure(&span, &unsupported, self.inner.sdk.error_shapes);
                        return Err(unsupported);
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
        sent_token: &mut Option<String>,
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
            Credential::Bearer(t) => {
                append(&mut headers, "authorization", &format!("Bearer {t}"));
                *sent_token = Some(t);
            }
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
        // A redirect is the answer itself where the operation answers one (GetDocumentContent's 302).
        if resp.status().is_success() || resp.status().is_redirection() {
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
        assert_eq!(workspace_host("https://acme.caitlyn.ai/"), "acme.caitlyn.ai");
        assert_eq!(workspace_endpoint("acme.caitlyn.ai"), "https://acme.caitlyn.ai/api");
        assert_eq!(workspace_audience("https://acme.caitlyn.ai/x"), "https://acme.caitlyn.ai/api");
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
