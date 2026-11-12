# Caitlyn SDK for Rust

Two crates, Apache-2.0:

| Crate | What it is |
| --- | --- |
| `caitlyn-sdk` | The client, generated from the Caitlyn Smithy model by `codegen/rust`. Never edit it: change the generator or the model and run `make generate`. |
| `caitlyn-sdk-core` | The hand-written runtime: the wire protocol (`model/PROTOCOL.md`), sign-in, retries, streams, uploads and `tracing` spans. |

Async on tokio, TLS through rustls (the ring provider; no OpenSSL), telemetry through the `tracing` crate. Like the
other SDKs it reads no AWS configuration, except in the `awsIam` sign-in mode. Nothing is published yet: the
crates.io release is still to be set up (`release:crates` in `.gitlab-ci.yml` is a placeholder).

## Using it

```rust
use caitlyn_sdk::{Auth, Client, GetAgentVersionInput, SendMessageInput, UpdateDraftVersionInput};

let client = Client::new("your-company.getcaitlyn.ai", Auth::token("cait-pat-…"))?;

// One call: options go on the call, then .await it.
let draft = client.versions().get(GetAgentVersionInput { agent_id: "GHT7YRWXPL".into(), version: "draft".into() }).await?;
let input = UpdateDraftVersionInput { instructions: Some("Cite clause numbers.".into()), ..Default::default() };
client.versions().update_draft("GHT7YRWXPL", input).if_match(&draft.etag).await?;

// A stream of typed events; a dropped connection resumes with Last-Event-ID.
let mut answer = client.conversations().send("c-1", SendMessageInput { message: "How much leave do I get?".into(), ..Default::default() }).await?;
while let Some(event) = answer.next().await {
    println!("{:?}", event?);
}

// A list: items across pages.
let docs = client.documents().list(caitlyn_sdk::ListDocumentsInput { knowledge_base_id: "KB4T7YQ2WL".into(), ..Default::default() }).collect().await?;
```

Errors are `caitlyn_sdk::Error`, one variant per modelled error (`Error::NotFound`, `Error::PreconditionFailed`…)
chosen by HTTP status, each carrying an `ApiError` with `status`, `code` and `request_id`. A call that got no
response (a refused or reset connection, a DNS or TLS failure) is `Error::Connection`, with status 0, code
`CONNECTION_ERROR` and the network error as its `source()`.

A result carries the response it was read from in `response_metadata`: `http_status_code`, `request_id` and `etag`.

### The workspace and the endpoint

The workspace works like an AWS region: it decides where requests go (`https://<workspace>/api`) and the audience
every token is bound to (`https://<workspace>/api`). `Client::builder(…).endpoint(url)` moves only where
requests go (a proxy, a local app); the audience stays the workspace's.

### Sign-in modes

| Mode | Build it with |
| --- | --- |
| Personal access token or API key | `Auth::token("cait-pat-…")` |
| Client credentials | `Auth::client_credentials(id, secret).scopes(["agents:read"])` |
| Authorisation code with PKCE | `Auth::oauth(client_id).redirect_uri(…).token_store(store)`, then `client.auth().authorization_url(…)` and `client.auth().handle_callback(…)` |
| AWS IAM (STS `GetWebIdentityToken`, then token exchange) | `Auth::aws_iam().region("ap-southeast-2")` (credentials from the environment or the container endpoint, or `.credentials(provider)`) |
| Workload identity (GitLab CI `id_tokens` and the like) | `WorkloadIdentity::from_env("CAITLYN_ID_TOKEN")` or `Auth::workload_identity(|| async { … })` |
| Session cookie | `Auth::session("caitlyn_session=…")` |

Every mode except `token` and `session` keeps one cached token, fetched by one request however many calls are
waiting, renewed a minute before it expires (or halfway through a shorter life), and replaced once after a 401.

### Telemetry

Each call is a `caitlyn.call` span with one `caitlyn.attempt` child per HTTP attempt, and an upload's bytes are a
`caitlyn.upload` span, with the names and attributes every Caitlyn SDK uses (`model/PROTOCOL.md` section 13:
`rpc.method`, `url.full`, `http.request.resend_count`, `caitlyn.request_id`, `error.type`…). With `tracing-opentelemetry`
they become OpenTelemetry spans; `ClientBuilder::propagator` sends `traceparent` (see
`caitlyn_sdk_core::telemetry`).

## Working on it

`make rust` runs `scripts/test-rust.sh` in the toolchain image: rustfmt, clippy with warnings as errors, unit and
doc tests, the docs build, then the conformance harness in `conformance/rust` against the mock server.
