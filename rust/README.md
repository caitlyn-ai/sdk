# Caitlyn SDK for Rust

Two crates, Apache-2.0:

| Crate | What it is |
| --- | --- |
| `caitlyn-sdk` | The client, generated from the Caitlyn Smithy model by `codegen/rust`. Never edit it: change the generator or the model and run `make generate`. |
| `caitlyn-sdk-core` | The hand-written runtime: the wire protocol (`model/PROTOCOL.md`), sign-in, retries, streams, uploads and `tracing` spans. |

Async on tokio, TLS through rustls (the ring provider; no OpenSSL), telemetry through the `tracing` crate. Like the
other SDKs it reads no AWS configuration, except in the `awsIam` sign-in mode. Both crates are on crates.io:

```sh
cargo add caitlyn-sdk
```

## Using it

The client is a tree of scopes: `client.knowledge_base(id)` is one knowledge base, and every call about it hangs off
it. Making a scope sends nothing. A call returns a request: required members are its arguments, the rest are
setters, and `.send().await` (or `.await`) sends it.

```rust
use caitlyn_sdk::{Auth, Client, Readers, SyncInput};

let client = Client::new("your-company.getcaitlyn.ai", Auth::token("cait-pat-…"))?;
let kb = client.knowledge_base("KB4T7YQ2WL");

// A call that starts work returns what the call returned, with wait(), which follows that work to its end.
let doc = kb.documents().create("./leave-policy.pdf").folder("/hr/").wait().await?;

// Keep a folder in step, and follow a document after a page reload, with its progress as it changes.
let report = kb.ingestion().sync(SyncInput::dir("./policies").folder("/policies/")).await?;
kb.document(&doc.id).wait().on_progress(|p| println!("{:?}%", p.percent())).await?;

// Who may read a folder: "inherit", Readers::everyone() or Readers::roles([...]).
kb.folder("/hr/investigations/").access().set().readers(Readers::roles(["hr-team"])).await?;

// Agents: create returns the agent's scope; publish its draft, or roll back by publishing an earlier version.
let agent = client.agents().create("HR assistant").await?;
agent.draft().publish().name("v1").await?;
client.agent("GHT7YRWXPL").version("v13").publish().await?;

// A stream of typed events; a dropped connection resumes with Last-Event-ID.
let conversation = client.agent("GHT7YRWXPL").live().conversations().create().await?;
let mut answer = conversation.send("How much leave do I get?").await?.text();
while let Some(text) = answer.next().await {
    print!("{}", text?);
}

// A list: items across pages. Estimates sit beside their jobs, with the same arguments.
let docs = kb.documents().list().folder("/hr/").collect().await?;
let estimate = kb.fields().estimate_fill_in(["policyOwner"]).await?;
```

The scope types are in `caitlyn_sdk::scope`. The building blocks (uploads, ingestion batch items, Operations) are
under `client.core()`, taking their identifiers as arguments.

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
