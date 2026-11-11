//! Sign-in modes, at parity with the TypeScript runtime (`@caitlyn-ai/sdk-core`'s auth.ts). Every mode except
//! `token` and `session` ends in the same thing: a short-lived Caitlyn bearer token from the workspace's OAuth
//! token endpoint (`{endpoint}/oauth/token`), cached until a minute before it expires and fetched by one request
//! at a time however many calls are waiting.
//!
//! | Mode | What it does |
//! | --- | --- |
//! | [`Auth::token`] | A personal access token, sent as it is |
//! | [`ClientCredentials`] | Client ID and secret exchanged for a token; re-requested before expiry |
//! | [`OAuth`] | Authorisation code with PKCE, then refresh tokens; a [`TokenStore`] keeps them |
//! | [`AwsIam`] | STS `GetWebIdentityToken` with the caller's AWS credentials, exchanged (RFC 8693) |
//! | [`WorkloadIdentity`] | A JWT from another trusted issuer (GitLab CI `id_tokens`), exchanged (RFC 8693) |
//! | [`Session`] | A Caitlyn session cookie, with `Origin` on every write (server-side tools and recordings) |
//!
//! The token audience is always the workspace's resource URL, `https://<workspace>/api/v3`, whatever endpoint
//! the client sends requests to.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::aws::{AwsCredentialProvider, AwsCredentials, SigningAlgorithm};
use crate::client::workspace_audience;
use crate::error::{header, AuthError};
use crate::request::BoxFuture;

const TOKEN_EXCHANGE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TYPE: &str = "urn:ietf:params:oauth:token-type:jwt";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const REFRESH_EARLY: Duration = Duration::from_secs(60);

/// How a client signs in. Build one with the constructors ([`Auth::token`], [`Auth::client_credentials`]…).
#[derive(Clone)]
#[non_exhaustive]
pub enum Auth {
    /// A personal access token or API key, sent as it is.
    Token(String),
    ClientCredentials(ClientCredentials),
    OAuth(OAuth),
    AwsIam(AwsIam),
    WorkloadIdentity(WorkloadIdentity),
    Session(Session),
}

impl fmt::Debug for Auth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Auth::Token(_) => "Auth::Token(…)",
            Auth::ClientCredentials(_) => "Auth::ClientCredentials(…)",
            Auth::OAuth(_) => "Auth::OAuth(…)",
            Auth::AwsIam(_) => "Auth::AwsIam(…)",
            Auth::WorkloadIdentity(_) => "Auth::WorkloadIdentity(…)",
            Auth::Session(_) => "Auth::Session(…)",
        })
    }
}

impl Auth {
    /// A personal access token (`pat_…`) or API key.
    pub fn token(token: impl Into<String>) -> Self {
        Auth::Token(token.into())
    }

    /// A machine client's ID and secret, exchanged for short-lived tokens.
    pub fn client_credentials(client_id: impl Into<String>, client_secret: impl Into<String>) -> ClientCredentials {
        ClientCredentials {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            scopes: Vec::new(),
            resource: None,
        }
    }

    /// Authorisation code with PKCE, for an application acting for a person.
    pub fn oauth(client_id: impl Into<String>) -> OAuth {
        OAuth {
            client_id: client_id.into(),
            client_secret: None,
            redirect_uri: None,
            scopes: Vec::new(),
            resource: None,
            token_store: None,
        }
    }

    /// The caller's AWS identity (an IAM role), through STS `GetWebIdentityToken`.
    pub fn aws_iam() -> AwsIam {
        AwsIam::default()
    }

    /// A workload's own identity token from another trusted issuer, for example a GitLab CI `id_tokens` variable.
    pub fn workload_identity<F, Fut>(token: F) -> WorkloadIdentity
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<String, String>> + Send + 'static,
    {
        WorkloadIdentity {
            token: Arc::new(move || Box::pin(token())),
            resource: None,
        }
    }

    /// A Caitlyn session cookie (`caitlyn_session=…`), for server-side tools. Writes carry `Origin`.
    pub fn session(cookie: impl Into<String>) -> Session {
        Session {
            cookie: Some(cookie.into()),
            origin: None,
        }
    }
}

/// The `clientCredentials` mode.
#[derive(Clone, Debug)]
pub struct ClientCredentials {
    client_id: String,
    client_secret: String,
    scopes: Vec<String>,
    resource: Option<String>,
}

impl ClientCredentials {
    pub fn scopes<I: IntoIterator<Item = S>, S: Into<String>>(mut self, scopes: I) -> Self {
        self.scopes = scopes.into_iter().map(Into::into).collect();
        self
    }

    /// Overrides the token audience (default `https://<workspace>/api/v3`).
    pub fn resource(mut self, resource: impl Into<String>) -> Self {
        self.resource = Some(resource.into());
        self
    }
}

impl From<ClientCredentials> for Auth {
    fn from(v: ClientCredentials) -> Self {
        Auth::ClientCredentials(v)
    }
}

/// Tokens the `oauth` mode keeps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub scope: Option<String>,
}

/// Where the `oauth` mode keeps tokens between processes, for example encrypted on a server. The default keeps
/// them in memory for the life of the client.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> BoxFuture<'_, Option<OAuthTokens>>;
    fn save(&self, tokens: OAuthTokens) -> BoxFuture<'_, ()>;
    fn clear(&self) -> BoxFuture<'_, ()>;
}

/// A [`TokenStore`] in memory.
#[derive(Default)]
pub struct MemoryTokenStore(std::sync::Mutex<Option<OAuthTokens>>);

impl MemoryTokenStore {
    pub fn new(initial: Option<OAuthTokens>) -> Self {
        MemoryTokenStore(std::sync::Mutex::new(initial))
    }

    /// What the store holds now.
    pub fn get(&self) -> Option<OAuthTokens> {
        self.0.lock().expect("token store").clone()
    }
}

impl TokenStore for MemoryTokenStore {
    fn load(&self) -> BoxFuture<'_, Option<OAuthTokens>> {
        let v = self.get();
        Box::pin(async move { v })
    }
    fn save(&self, tokens: OAuthTokens) -> BoxFuture<'_, ()> {
        *self.0.lock().expect("token store") = Some(tokens);
        Box::pin(async {})
    }
    fn clear(&self) -> BoxFuture<'_, ()> {
        *self.0.lock().expect("token store") = None;
        Box::pin(async {})
    }
}

/// The `oauth` mode: authorisation code with PKCE, then refresh tokens.
#[derive(Clone)]
pub struct OAuth {
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: Option<String>,
    scopes: Vec<String>,
    resource: Option<String>,
    token_store: Option<Arc<dyn TokenStore>>,
}

impl OAuth {
    /// For a confidential client on a server.
    pub fn client_secret(mut self, secret: impl Into<String>) -> Self {
        self.client_secret = Some(secret.into());
        self
    }
    pub fn redirect_uri(mut self, uri: impl Into<String>) -> Self {
        self.redirect_uri = Some(uri.into());
        self
    }
    pub fn scopes<I: IntoIterator<Item = S>, S: Into<String>>(mut self, scopes: I) -> Self {
        self.scopes = scopes.into_iter().map(Into::into).collect();
        self
    }
    pub fn resource(mut self, resource: impl Into<String>) -> Self {
        self.resource = Some(resource.into());
        self
    }
    pub fn token_store(mut self, store: Arc<dyn TokenStore>) -> Self {
        self.token_store = Some(store);
        self
    }
}

impl From<OAuth> for Auth {
    fn from(v: OAuth) -> Self {
        Auth::OAuth(v)
    }
}

/// The `awsIam` mode. The only mode that reads AWS configuration: `AWS_REGION` (then `AWS_DEFAULT_REGION`) when
/// no region is set, and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or the container credentials endpoint when
/// no credentials are given.
#[derive(Clone, Default)]
pub struct AwsIam {
    pub(crate) region: Option<String>,
    pub(crate) credentials: Option<Arc<dyn AwsCredentialProvider>>,
    pub(crate) signing_algorithm: SigningAlgorithm,
    pub(crate) duration_seconds: Option<u32>,
    pub(crate) audience: Option<String>,
    pub(crate) sts_endpoint: Option<String>,
}

impl AwsIam {
    /// The regional STS endpoint's region.
    pub fn region(mut self, region: impl Into<String>) -> Self {
        self.region = Some(region.into());
        self
    }
    /// Static credentials, or any [`AwsCredentialProvider`] (for example one built on the AWS SDK's chain).
    pub fn credentials(mut self, provider: impl AwsCredentialProvider + 'static) -> Self {
        self.credentials = Some(Arc::new(provider));
        self
    }
    pub fn signing_algorithm(mut self, alg: SigningAlgorithm) -> Self {
        self.signing_algorithm = alg;
        self
    }
    /// Lifetime of the AWS-signed token, at most 300 (the default).
    pub fn duration_seconds(mut self, s: u32) -> Self {
        self.duration_seconds = Some(s);
        self
    }
    /// The audience the AWS token is minted for (default: the workspace resource URL).
    pub fn audience(mut self, aud: impl Into<String>) -> Self {
        self.audience = Some(aud.into());
        self
    }
    /// Overrides `https://sts.{region}.amazonaws.com/` (tests, FIPS or VPC endpoints).
    pub fn sts_endpoint(mut self, url: impl Into<String>) -> Self {
        self.sts_endpoint = Some(url.into());
        self
    }
}

impl From<AwsIam> for Auth {
    fn from(v: AwsIam) -> Self {
        Auth::AwsIam(v)
    }
}

type TokenFn = Arc<dyn Fn() -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

/// The `workloadIdentity` mode.
#[derive(Clone)]
pub struct WorkloadIdentity {
    token: TokenFn,
    resource: Option<String>,
}

impl WorkloadIdentity {
    /// Reads the identity token from an environment variable each time one is needed (GitLab CI `id_tokens`).
    pub fn from_env(var: impl Into<String>) -> Self {
        let var = var.into();
        Auth::workload_identity(move || {
            let r = std::env::var(&var).map_err(|_| format!("workloadIdentity: {var} is not set"));
            async move { r }
        })
    }
    pub fn resource(mut self, resource: impl Into<String>) -> Self {
        self.resource = Some(resource.into());
        self
    }
}

impl From<WorkloadIdentity> for Auth {
    fn from(v: WorkloadIdentity) -> Self {
        Auth::WorkloadIdentity(v)
    }
}

/// The `session` mode.
#[derive(Clone, Debug)]
pub struct Session {
    cookie: Option<String>,
    origin: Option<String>,
}

impl Session {
    /// Sent as `Origin` on every write (default `https://<workspace>`).
    pub fn origin(mut self, origin: impl Into<String>) -> Self {
        self.origin = Some(origin.into());
        self
    }
}

impl From<Session> for Auth {
    fn from(v: Session) -> Self {
        Auth::Session(v)
    }
}

/// What one request carries.
pub(crate) enum Credential {
    Bearer(String),
    Session { cookie: Option<String>, origin: String },
}

/// The start of an `oauth` sign-in: send the person to `url`, and keep `state` and `code_verifier` for the
/// callback.
#[derive(Clone, Debug)]
pub struct AuthorizationUrl {
    pub url: String,
    pub state: String,
    pub code_verifier: String,
}

/// The `oauth` callback's parameters.
#[derive(Clone, Debug, Default)]
pub struct Callback {
    pub code: String,
    pub state: Option<String>,
    /// The `state` from [`AuthorizationUrl`]; a mismatch is refused before any token request.
    pub expected_state: Option<String>,
    pub code_verifier: String,
    pub redirect_uri: Option<String>,
}

struct Cached {
    token: String,
    refresh_at: Option<DateTime<Utc>>,
}

#[derive(Default)]
struct State {
    cached: Option<Cached>,
    /// The token the server last refused with a 401, so `oauth` never reloads it from the token store.
    refused: Option<String>,
    memory: Option<OAuthTokens>,
}

/// A client's sign-in: the current token, and the `oauth` mode's sign-in steps.
pub struct AuthSession {
    auth: Auth,
    http: reqwest::Client,
    token_endpoint: String,
    authorization_endpoint: String,
    resource: String,
    workspace: String,
    workspace_url: String,
    // Held across a token request, so concurrent calls wait for one request and then share its token.
    state: Mutex<State>,
}

/// When to replace a token: a minute before it expires, or halfway through a lifetime shorter than two minutes.
fn refresh_at(expires_at: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    let exp = expires_at?;
    let left = (exp - Utc::now()).to_std().unwrap_or_default();
    let early = REFRESH_EARLY.min(left / 2);
    Some(exp - chrono::Duration::from_std(early).unwrap_or_default())
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_string(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::getrandom(&mut b);
    b64url(&b)
}

impl AuthSession {
    pub(crate) fn new(auth: Auth, endpoint: &str, workspace: &str, http: reqwest::Client) -> Self {
        let resource = match &auth {
            Auth::ClientCredentials(c) => c.resource.clone(),
            Auth::OAuth(o) => o.resource.clone(),
            Auth::WorkloadIdentity(w) => w.resource.clone(),
            _ => None,
        }
        .unwrap_or_else(|| workspace_audience(workspace));
        AuthSession {
            auth,
            http,
            token_endpoint: format!("{endpoint}/oauth/token"),
            authorization_endpoint: format!("{endpoint}/oauth/authorize"),
            resource,
            workspace: workspace.to_owned(),
            workspace_url: format!("https://{workspace}"),
            state: Mutex::new(State::default()),
        }
    }

    /// The workspace hostname.
    pub fn workspace(&self) -> &str {
        &self.workspace
    }

    /// The audience every token is bound to: `https://<workspace>/api/v3`, from the workspace, never from an
    /// endpoint override.
    pub fn resource(&self) -> &str {
        &self.resource
    }

    /// `{endpoint}/oauth/token`.
    pub fn token_endpoint(&self) -> &str {
        &self.token_endpoint
    }

    /// The sign-in mode: `token`, `clientCredentials`, `oauth`, `awsIam`, `workloadIdentity` or `session`.
    pub fn mode(&self) -> &'static str {
        match self.auth {
            Auth::Token(_) => "token",
            Auth::ClientCredentials(_) => "clientCredentials",
            Auth::OAuth(_) => "oauth",
            Auth::AwsIam(_) => "awsIam",
            Auth::WorkloadIdentity(_) => "workloadIdentity",
            Auth::Session(_) => "session",
        }
    }

    /// Whether a 401 is worth one more try with a new token.
    pub(crate) fn can_refresh(&self) -> bool {
        !matches!(self.auth, Auth::Token(_) | Auth::Session(_))
    }

    /// Forgets the cached token, so the next call signs in again (done once after a 401).
    pub async fn invalidate(&self) {
        let mut st = self.state.lock().await;
        if let Some(c) = st.cached.take() {
            st.refused = Some(c.token);
        }
    }

    pub(crate) async fn credential(&self) -> Result<Credential, AuthError> {
        match &self.auth {
            Auth::Session(s) => Ok(Credential::Session {
                cookie: s.cookie.clone(),
                origin: s.origin.clone().unwrap_or_else(|| self.workspace_url.clone()),
            }),
            _ => Ok(Credential::Bearer(self.token().await?)),
        }
    }

    /// The bearer token for the next request: cached, or fetched once however many calls ask at the same time.
    pub async fn token(&self) -> Result<String, AuthError> {
        match &self.auth {
            Auth::Token(t) => return Ok(t.clone()),
            Auth::Session(_) => return Err(AuthError::new("invalid_request", "session mode has no bearer token")),
            _ => {}
        }
        let mut st = self.state.lock().await;
        if let Some(c) = &st.cached {
            if c.refresh_at.is_none_or(|at| at > Utc::now()) {
                return Ok(c.token.clone());
            }
        }
        let t = self.fetch_token(&mut st).await?;
        st.cached = Some(Cached {
            token: t.access_token.clone(),
            refresh_at: refresh_at(t.expires_at),
        });
        Ok(t.access_token)
    }

    async fn fetch_token(&self, st: &mut State) -> Result<OAuthTokens, AuthError> {
        match &self.auth {
            Auth::ClientCredentials(c) => {
                let mut p = vec![
                    ("grant_type", "client_credentials".to_owned()),
                    ("client_id", c.client_id.clone()),
                    ("client_secret", c.client_secret.clone()),
                    ("resource", self.resource.clone()),
                ];
                if !c.scopes.is_empty() {
                    p.push(("scope", c.scopes.join(" ")));
                }
                self.request_token(&p).await
            }
            Auth::OAuth(o) => {
                let stored = self.load_tokens(o, st).await;
                let held = st.cached.as_ref().map(|c| c.token.clone()).or_else(|| st.refused.clone());
                match stored {
                    // Signed in or refreshed by another process, or not yet used by this client.
                    Some(t)
                        if t.expires_at
                            .is_none_or(|e| e - chrono::Duration::from_std(REFRESH_EARLY).unwrap_or_default() > Utc::now())
                            && Some(&t.access_token) != held.as_ref() =>
                    {
                        Ok(t)
                    }
                    Some(OAuthTokens {
                        refresh_token: Some(rt), ..
                    }) => {
                        let mut p = vec![("grant_type", "refresh_token".to_owned()), ("refresh_token", rt.clone())];
                        p.extend(client_params(&o.client_id, o.client_secret.as_deref()));
                        let mut t = match self.request_token(&p).await {
                            Ok(t) => t,
                            Err(e) => {
                                if e.code == "invalid_grant" {
                                    st.memory = None;
                                    if let Some(s) = &o.token_store {
                                        s.clear().await;
                                    }
                                }
                                return Err(e);
                            }
                        };
                        if t.refresh_token.is_none() {
                            t.refresh_token = Some(rt);
                        }
                        self.save_tokens(o, st, t.clone()).await;
                        Ok(t)
                    }
                    _ => Err(AuthError::new(
                        "sign_in_required",
                        "oauth: not signed in. Call auth().authorization_url() and auth().handle_callback() first.",
                    )),
                }
            }
            Auth::AwsIam(a) => {
                let region = a
                    .region
                    .clone()
                    .or_else(|| std::env::var("AWS_REGION").ok())
                    .or_else(|| std::env::var("AWS_DEFAULT_REGION").ok())
                    .ok_or_else(|| {
                        AuthError::new(
                            "invalid_request",
                            "awsIam: set region, or AWS_REGION, for the regional STS endpoint",
                        )
                    })?;
                let creds: AwsCredentials = match &a.credentials {
                    Some(p) => p.credentials().await,
                    None => crate::aws::default_credentials(&self.http).await,
                }
                .map_err(|m| AuthError::new("aws_identity_failed", m))?;
                let subject = crate::aws::get_web_identity_token(
                    &self.http,
                    &crate::aws::WebIdentityTokenRequest {
                        region: &region,
                        audience: a.audience.as_deref().unwrap_or(&self.resource),
                        credentials: &creds,
                        signing_algorithm: a.signing_algorithm,
                        duration_seconds: a.duration_seconds.unwrap_or(300),
                        sts_endpoint: a.sts_endpoint.as_deref(),
                    },
                )
                .await?;
                self.exchange(&subject).await
            }
            Auth::WorkloadIdentity(w) => {
                let subject = (w.token)().await.map_err(|m| AuthError::new("workload_identity_failed", m))?;
                self.exchange(&subject).await
            }
            Auth::Token(_) | Auth::Session(_) => Err(AuthError::new("invalid_request", "no token to fetch in this mode")),
        }
    }

    async fn exchange(&self, subject: &str) -> Result<OAuthTokens, AuthError> {
        self.request_token(&[
            ("grant_type", TOKEN_EXCHANGE.to_owned()),
            ("subject_token", subject.to_owned()),
            ("subject_token_type", JWT_TYPE.to_owned()),
            ("requested_token_type", ACCESS_TOKEN_TYPE.to_owned()),
            ("resource", self.resource.clone()),
        ])
        .await
    }

    async fn request_token(&self, params: &[(&str, String)]) -> Result<OAuthTokens, AuthError> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())))
            .finish();
        let res = self
            .http
            .post(&self.token_endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| AuthError::new("token_endpoint_unreachable", e.to_string()))?;
        let status = res.status();
        let request_id = header(res.headers(), "caitlyn-request-id");
        let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
        let s = |k: &str| body.get(k).and_then(|v| v.as_str()).map(str::to_owned);
        match s("access_token") {
            Some(access_token) if status.is_success() => Ok(OAuthTokens {
                access_token,
                refresh_token: s("refresh_token"),
                expires_at: body
                    .get("expires_in")
                    .and_then(|v| v.as_f64())
                    .map(|secs| Utc::now() + chrono::Duration::milliseconds((secs * 1000.0) as i64)),
                scope: s("scope"),
            }),
            _ => {
                let code = s("error")
                    .or_else(|| s("code"))
                    .unwrap_or_else(|| format!("http_{}", status.as_u16()));
                Err(AuthError {
                    message: s("error_description")
                        .or_else(|| s("detail"))
                        .unwrap_or_else(|| format!("Sign-in failed: {code}")),
                    code,
                    status: Some(status.as_u16()),
                    request_id,
                })
            }
        }
    }

    // ------------------------------------------------------------------ oauth

    fn oauth(&self) -> Result<&OAuth, AuthError> {
        match &self.auth {
            Auth::OAuth(o) => Ok(o),
            _ => Err(AuthError::new(
                "invalid_request",
                format!("This client signs in with {}, not oauth", self.mode()),
            )),
        }
    }

    async fn load_tokens(&self, o: &OAuth, st: &State) -> Option<OAuthTokens> {
        match &o.token_store {
            Some(s) => s.load().await,
            None => st.memory.clone(),
        }
    }

    async fn save_tokens(&self, o: &OAuth, st: &mut State, t: OAuthTokens) {
        st.cached = Some(Cached {
            token: t.access_token.clone(),
            refresh_at: refresh_at(t.expires_at),
        });
        st.memory = Some(t.clone());
        if let Some(s) = &o.token_store {
            s.save(t).await;
        }
    }

    /// Starts an `oauth` sign-in: the URL to send the person to, and the state and PKCE verifier to keep.
    pub fn authorization_url(
        &self,
        state: Option<String>,
        scopes: Option<Vec<String>>,
        redirect_uri: Option<String>,
    ) -> Result<AuthorizationUrl, AuthError> {
        let o = self.oauth()?;
        let code_verifier = random_string(48);
        let state = state.unwrap_or_else(|| random_string(16));
        let challenge = b64url(&Sha256::digest(code_verifier.as_bytes()));
        let redirect = redirect_uri
            .or_else(|| o.redirect_uri.clone())
            .ok_or_else(|| AuthError::new("invalid_request", "oauth: redirect_uri is required"))?;
        let scopes = scopes.unwrap_or_else(|| o.scopes.clone());
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        q.append_pair("response_type", "code")
            .append_pair("client_id", &o.client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", &self.resource);
        if !scopes.is_empty() {
            q.append_pair("scope", &scopes.join(" "));
        }
        Ok(AuthorizationUrl {
            url: format!("{}?{}", self.authorization_endpoint, q.finish()),
            state,
            code_verifier,
        })
    }

    /// Finishes an `oauth` sign-in: checks the state, exchanges the code and saves the tokens.
    pub async fn handle_callback(&self, cb: Callback) -> Result<OAuthTokens, AuthError> {
        let o = self.oauth()?;
        if cb.expected_state.is_some() && cb.state != cb.expected_state {
            return Err(AuthError::new("invalid_state", "oauth: the state does not match"));
        }
        let mut p = vec![
            ("grant_type", "authorization_code".to_owned()),
            ("code", cb.code),
            ("code_verifier", cb.code_verifier),
            ("resource", self.resource.clone()),
        ];
        if let Some(r) = cb.redirect_uri.or_else(|| o.redirect_uri.clone()) {
            p.push(("redirect_uri", r));
        }
        p.extend(client_params(&o.client_id, o.client_secret.as_deref()));
        let t = self.request_token(&p).await?;
        let mut st = self.state.lock().await;
        self.save_tokens(o, &mut st, t.clone()).await;
        Ok(t)
    }

    /// Signs out (`oauth` mode): revokes the refresh token where possible and clears the store.
    pub async fn sign_out(&self) -> Result<(), AuthError> {
        let o = self.oauth()?;
        let mut st = self.state.lock().await;
        if let Some(rt) = self.load_tokens(o, &st).await.and_then(|t| t.refresh_token) {
            let mut p = vec![("action", "revoke".to_owned()), ("token", rt)];
            p.extend(client_params(&o.client_id, o.client_secret.as_deref()));
            let body = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(p.iter().map(|(k, v)| (*k, v.as_str())))
                .finish();
            let _ = self
                .http
                .post(&self.token_endpoint)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body)
                .send()
                .await;
        }
        st.cached = None;
        st.memory = None;
        if let Some(s) = &o.token_store {
            s.clear().await;
        }
        Ok(())
    }
}

fn client_params(id: &str, secret: Option<&str>) -> Vec<(&'static str, String)> {
    let mut p = vec![("client_id", id.to_owned())];
    if let Some(s) = secret {
        p.push(("client_secret", s.to_owned()));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_lifetimes_refresh_halfway() {
        let exp = Utc::now() + chrono::Duration::seconds(10);
        let at = refresh_at(Some(exp)).unwrap();
        let early = (exp - at).num_milliseconds();
        assert!((4_900..=5_100).contains(&early), "{early}");
        let long = Utc::now() + chrono::Duration::hours(1);
        assert_eq!((long - refresh_at(Some(long)).unwrap()).num_seconds(), 60);
    }

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        let s = AuthSession::new(
            Auth::oauth("c").redirect_uri("https://app.example.com/cb").into(),
            "https://w.example/api",
            "w.example",
            crate::client::default_http_client().unwrap(),
        );
        let a = s.authorization_url(None, None, None).unwrap();
        let u = url::Url::parse(&a.url).unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge"], b64url(&Sha256::digest(a.code_verifier.as_bytes())));
        assert_eq!(q["resource"], "https://w.example/api/v3");
    }
}
