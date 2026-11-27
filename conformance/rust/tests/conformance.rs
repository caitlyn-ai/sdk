//! The Rust conformance harness: the protocol cases in conformance/cases/protocol.json (one per case id, named
//! `[<id>] <title>`), the example cases in conformance/cases/examples.json (`[example] <id>`), the sign-in cases
//! (`[auth.…]`, run from the catalogue once it lists them, and from AUTH_CASES until then), and Rust-only cases (`[rust.…]`), against the generated Rust SDK and the mock server. Cases run one at a time,
//! because they share the mock's state. It writes build/conformance/rust.json for scripts/check-conformance.mjs.
//!
//!   cargo test --test conformance                 every case
//!   cargo test --test conformance -- sse.         only cases whose name contains "sse."

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use caitlyn_sdk::auth::ProviderFn;
use caitlyn_sdk::scope;
use caitlyn_sdk::*;
use caitlyn_sdk_core::reqwest;
use serde_json::{json, Value};

type R = Result<(), String>;
type Fut<'a> = Pin<Box<dyn Future<Output = R> + 'a>>;

macro_rules! ensure {
    ($c:expr, $($a:tt)*) => {
        if !$c {
            return Err(format!($($a)*));
        }
    };
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

const KB: &str = "KB4T7YQ2WL";
const AGENT: &str = "GHT7YRWXPL";
const WORKSPACE: &str = "your-company.caitlyn.ai";
const RESOURCE: &str = "https://your-company.caitlyn.ai/api";
const PAT: &str = "pat_test";
const ANSWER: &str = "Staff receive 20 days of annual leave.";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root")
}

fn read_json(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(root().join(rel)).expect(rel)).expect(rel)
}

// ---------------------------------------------------------------------------------------------- the mock

/// Drives conformance/mock-server/server.mjs, started once for the run.
struct Mock {
    base: String,
    http: reqwest::Client,
}

impl Mock {
    async fn post(&self, path: &str, body: Value) {
        self.http
            .post(format!("{}{path}", self.base))
            .body(body.to_string())
            .send()
            .await
            .expect("mock");
    }

    async fn get(&self, path: &str) -> Value {
        self.http
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .expect("mock")
            .json()
            .await
            .expect("mock json")
    }

    async fn reset(&self) {
        self.post("/__mock/reset", Value::Null).await;
    }

    async fn faults(&self, f: Value) {
        self.post("/__mock/faults", f).await;
    }

    async fn requests(&self) -> Vec<Value> {
        self.get("/__mock/requests").await.as_array().cloned().unwrap_or_default()
    }

    /// Requests to the API itself (not the upload target, the token endpoint or STS).
    async fn api(&self) -> Vec<Value> {
        self.requests()
            .await
            .into_iter()
            .filter(|r| str_at(r, "path").starts_with("/v3/"))
            .collect()
    }

    async fn matching(&self, pred: impl Fn(&Value) -> bool) -> Vec<Value> {
        self.requests().await.into_iter().filter(|r| pred(r)).collect()
    }

    async fn counts(&self) -> Value {
        self.get("/__mock/auth").await["counts"].clone()
    }
}

fn str_at<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn header<'a>(r: &'a Value, name: &str) -> Option<&'a str> {
    r["headers"].get(name).and_then(Value::as_str)
}

/// An error page from something in front of the API, not a problem body (PROTOCOL.md 6.1).
const HTML_404: &str = "<!DOCTYPE html><html><head><title>404: This page could not be found</title></head><body><h1>404</h1></body></html>";

/// A problem body whose status disagrees with the HTTP status (PROTOCOL.md 6.3).
const MISMATCHED_409: &str = r#"{"type":"https://build.caitlyn.ai/errors/CONFLICT","title":"Conflict","status":400,"code":"CONFLICT","requestId":"01MISMATCHEDSTATUS0000000"}"#;

fn status(op: &str, faults: &[(u16, u64)]) -> Value {
    json!({"status": {op: faults.iter().map(|(s, ra)| json!({"status": s, "retryAfter": ra})).collect::<Vec<_>>()}})
}

fn client(m: &Mock) -> Client {
    Client::builder(WORKSPACE, Auth::token(PAT))
        .endpoint(&m.base)
        .build()
        .expect("client")
}

fn client_with(m: &Mock, auth: impl Into<Auth>) -> Client {
    Client::builder(WORKSPACE, auth).endpoint(&m.base).build().expect("client")
}

async fn list_all(c: &Client, kb: &str, limit: Option<i32>) -> Result<Vec<Document>, Error> {
    let mut list = c.knowledge_base(kb).documents().list();
    if let Some(n) = limit {
        list = list.limit(n);
    }
    list.collect().await
}

async fn draft(c: &Client) -> Result<AgentVersion, Error> {
    c.agent(AGENT).draft().get().await
}

/// The mock's cursor the workspace stream cannot carry on from, and the cursor its stream.reset gives instead.
const STALE_CURSOR: &str = "0190d2a1-0000-7000-8000-000000000001";
const RESET_CURSOR: &str = "0193a6f3-0a1b-7c2d-8e3f-000000000010";
const ID_11: &str = "0193a6f3-0a1b-7c2d-8e3f-000000000011";

async fn send(c: &Client, conversation: &str) -> Result<ConversationEventStream, Error> {
    c.conversation(conversation).send("hi").await
}

/// Steps the stream clock by `step` at each reading while it lives, so every connection lasts exactly that long (a
/// stream reads the clock when a response arrives and when its connection ends); dropping it puts the real clock back.
struct ConnectionsLasting;

impl ConnectionsLasting {
    fn new(step: Duration) -> Self {
        let mut now = Duration::ZERO;
        caitlyn_sdk_core::stream::set_stream_clock(Some(Box::new(move || {
            now += step;
            now
        })));
        ConnectionsLasting
    }
}

impl Drop for ConnectionsLasting {
    fn drop(&mut self) {
        caitlyn_sdk_core::stream::set_stream_clock(None);
    }
}

async fn collect<E, F: Clone>(s: &mut caitlyn_sdk_core::Stream<E, F, Error>) -> (Vec<E>, Option<Error>) {
    let mut evs = Vec::new();
    while let Some(r) = s.next().await {
        match r {
            Ok(e) => evs.push(e),
            Err(e) => return (evs, Some(e)),
        }
    }
    (evs, None)
}

fn event_name(e: &ConversationEvent) -> &'static str {
    match e {
        ConversationEvent::MessageStarted(_) => "MessageStarted",
        ConversationEvent::PhaseChanged(_) => "PhaseChanged",
        ConversationEvent::ProgressUpdated(_) => "ProgressUpdated",
        ConversationEvent::TextDelta(_) => "TextDelta",
        ConversationEvent::CitationAdded(_) => "CitationAdded",
        ConversationEvent::ToolStarted(_) => "ToolStarted",
        ConversationEvent::ToolFinished(_) => "ToolFinished",
        ConversationEvent::InputRequested(_) => "InputRequested",
        ConversationEvent::MessageCompleted(_) => "MessageCompleted",
        _ => "Other",
    }
}

async fn last_patch(m: &Mock) -> (Value, Value) {
    let p = m.matching(|r| str_at(r, "method") == "PATCH").await.pop().unwrap_or(Value::Null);
    let body = serde_json::from_str(str_at(&p, "body")).unwrap_or(Value::Null);
    (p, body)
}

/// An endpoint nothing listens on: a port the system handed out, then closed.
fn refused_endpoint() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = l.local_addr().expect("address");
    drop(l);
    format!("http://{addr}")
}

/// The version in VERSION, which every SDK sends in its user agent.
fn sdk_version() -> String {
    std::fs::read_to_string(root().join("VERSION")).expect("VERSION").trim().to_owned()
}

fn sdk_model() -> String {
    let next = read_json("model/model.lock.json")["stampNext"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if !next.is_empty() {
        return next;
    }
    // A published model has no "next": the SDK's model version is its highest @since
    let parse = |v: &str| v.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let model = read_json("model/model.json");
    let mut highest = String::new();
    let mut note = |t: &serde_json::Value| {
        if let Some(s) = t["ai.caitlyn.traits#since"].as_str() {
            if s != "next" && (highest.is_empty() || parse(s) > parse(&highest)) {
                highest = s.to_owned();
            }
        }
    };
    for shape in model["shapes"].as_object().into_iter().flat_map(|m| m.values()) {
        note(&shape["traits"]);
        for member in shape["members"].as_object().into_iter().flat_map(|m| m.values()) {
            note(&member["traits"]);
        }
    }
    highest
}

/// GetAgentVersion's @since, as the SDK reads it: the model's release, or sdk_model() where the model says "next".
fn get_agent_version_since() -> String {
    match read_json("model/model.json")["shapes"]["ai.caitlyn.v3#GetAgentVersion"]["traits"]["ai.caitlyn.traits#since"].as_str() {
        Some(since) if since != "next" => since.to_owned(),
        _ => sdk_model(),
    }
}

/// The version the mock reports: 5.120.0, or the model's release when that is later (the lock's stampNext for an app
/// branch build, its version for a published model).
fn server_version() -> String {
    let parse = |v: &str| v.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let lock = read_json("model/model.lock.json");
    let next = match lock["stampNext"].as_str().unwrap_or_default() {
        "" => lock["version"].as_str().unwrap_or_default().to_owned(),
        s => s.to_owned(),
    };
    if !next.is_empty() && parse(&next) > parse("5.120.0") {
        next
    } else {
        "5.120.0".to_owned()
    }
}

fn temp_file(name: &str, data: &[u8]) -> PathBuf {
    let dir = root().join("build/rust-conformance-tmp");
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let p = dir.join(name);
    std::fs::write(&p, data).expect("tmp file");
    p
}

// ---------------------------------------------------------------------------------------------- telemetry capture

#[derive(Clone, Debug, Default)]
struct SpanRec {
    id: u64,
    parent: Option<u64>,
    name: &'static str,
    fields: BTreeMap<String, String>,
    /// The fields of each event recorded inside the span (an `exception` event, say).
    events: Vec<BTreeMap<String, String>>,
}

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<SpanRec>>>);

struct Fields<'a>(&'a mut BTreeMap<String, String>);

impl tracing::field::Visit for Fields<'_> {
    fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
        self.0.insert(f.name().to_owned(), format!("{v:?}").trim_matches('"').to_owned());
    }
    fn record_str(&mut self, f: &tracing::field::Field, v: &str) {
        self.0.insert(f.name().to_owned(), v.to_owned());
    }
}

impl<S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>> tracing_subscriber::Layer<S> for Capture {
    fn on_new_span(&self, attrs: &tracing::span::Attributes<'_>, id: &tracing::span::Id, ctx: tracing_subscriber::layer::Context<'_, S>) {
        let mut rec = SpanRec {
            id: id.into_u64(),
            parent: ctx.span(id).and_then(|s| s.parent()).map(|p| p.id().into_u64()),
            name: attrs.metadata().name(),
            ..Default::default()
        };
        attrs.record(&mut Fields(&mut rec.fields));
        self.0.lock().unwrap().push(rec);
    }
    fn on_event(&self, event: &tracing::Event<'_>, ctx: tracing_subscriber::layer::Context<'_, S>) {
        let Some(span) = ctx.event_span(event) else { return };
        let mut fields = BTreeMap::new();
        event.record(&mut Fields(&mut fields));
        let mut spans = self.0.lock().unwrap();
        if let Some(rec) = spans.iter_mut().find(|r| r.id == span.id().into_u64()) {
            rec.events.push(fields);
        }
    }
    fn on_record(&self, id: &tracing::span::Id, values: &tracing::span::Record<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut spans = self.0.lock().unwrap();
        if let Some(rec) = spans.iter_mut().find(|r| r.id == id.into_u64()) {
            values.record(&mut Fields(&mut rec.fields));
        }
    }
}

// ---------------------------------------------------------------------------------------------- protocol cases

fn protocol<'a>(id: &str, m: &'a Mock) -> Option<Fut<'a>> {
    Some(match id {
        // ------------------------------------------------------------------ retries
        "retry.429-retry-after" => Box::pin(async move {
            m.faults(status("ListDocuments", &[(429, 2)])).await;
            let t0 = Instant::now();
            let docs = list_all(&client(m), KB, Some(100)).await.map_err(s)?;
            let n = m.api().await.len();
            ensure!(
                docs.len() == 7 && t0.elapsed() >= Duration::from_secs(2) && n == 2,
                "docs={} after {:?}, {n} requests",
                docs.len(),
                t0.elapsed()
            );
            Ok(())
        }),
        "retry.503-retry-after" => Box::pin(async move {
            m.faults(status("GetAgentVersion", &[(503, 1)])).await;
            let t0 = Instant::now();
            let v = draft(&client(m)).await.map_err(s)?;
            ensure!(
                t0.elapsed() >= Duration::from_secs(1) && v.name == "draft",
                "waited {:?}, name {}",
                t0.elapsed(),
                v.name
            );
            Ok(())
        }),
        "retry.long-retry-after" => Box::pin(async move {
            m.faults(status("GetAgentVersion", &[(429, 7)])).await;
            let t0 = Instant::now();
            draft(&client(m)).await.map_err(s)?;
            ensure!(t0.elapsed() >= Duration::from_secs(7), "waited {:?}, want ≥ 7 s", t0.elapsed());
            Ok(())
        }),
        "retry.budget-drains" => Box::pin(async move {
            let with_budget = |tokens: u32| {
                Client::builder(WORKSPACE, Auth::token(PAT))
                    .endpoint(&m.base)
                    .retry_budget(tokens)
                    .build()
                    .expect("client")
            };
            let c = with_budget(10);
            m.faults(status("GetAgentVersion", &[(503, 0), (503, 0), (503, 0), (503, 0)])).await;
            let r = draft(&c).await;
            let n = m.api().await.len();
            ensure!(
                matches!(r, Err(Error::ServiceUnavailable(_))) && n == 3,
                "first call: {:?} after {n} requests",
                r.err()
            );
            let t0 = Instant::now();
            let r = draft(&c).await;
            let n = m.api().await.len();
            ensure!(
                matches!(r, Err(Error::ServiceUnavailable(_))) && n == 4 && t0.elapsed() < Duration::from_secs(1),
                "second call: {:?} after {n} requests, {:?}",
                r.err(),
                t0.elapsed()
            );
            // A retry after no response costs 10: a budget of 9 pays for a 503's retry but not this one.
            m.reset().await;
            m.faults(json!({"status": {"GetAgentVersion": [{"close": true}]}})).await;
            let r = draft(&with_budget(9)).await;
            let n = m.api().await.len();
            ensure!(
                matches!(r, Err(Error::Connection(_))) && n == 1,
                "no response: {:?} after {n} requests",
                r.err()
            );
            Ok(())
        }),
        "retry.budget-refund" => Box::pin(async move {
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .retry_budget(5)
                .build()
                .map_err(s)?;
            m.faults(status("GetAgentVersion", &[(503, 0)])).await;
            draft(&c).await.map_err(s)?; // retried once, then refunded
            m.faults(status("GetAgentVersion", &[(503, 0)])).await;
            let v = draft(&c).await.map_err(s)?;
            let n = m.api().await.len();
            ensure!(v.name == "draft" && n == 4, "requests {n}");
            Ok(())
        }),
        "retry.budget-first-attempt" => Box::pin(async move {
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .retry_budget(0)
                .build()
                .map_err(s)?;
            draft(&c).await.map_err(s)?;
            m.faults(status("GetAgentVersion", &[(503, 0)])).await;
            let r = draft(&c).await;
            let n = m.api().await.len();
            ensure!(
                matches!(r, Err(Error::ServiceUnavailable(_))) && n == 2,
                "{:?} after {n} requests",
                r.err()
            );
            Ok(())
        }),
        "retry.idempotency-key-kept" => Box::pin(async move {
            m.faults(status("CreateUpload", &[(503, 0), (429, 0)])).await;
            let f = UploadFile::from_path(temp_file("hello.txt", b"hello")).map_err(s)?;
            client(m).core().uploads().send(f).await.map_err(s)?;
            let reqs = m.matching(|r| str_at(r, "path") == "/v3/uploads").await;
            let keys: Vec<_> = reqs.iter().map(|r| header(r, "idempotency-key").unwrap_or_default()).collect();
            let uuid = regex_lite::Regex::new("^[0-9a-f-]{36}$").unwrap();
            ensure!(
                keys.len() == 3 && uuid.is_match(keys[0]) && keys.iter().all(|k| *k == keys[0]),
                "keys {keys:?}"
            );
            Ok(())
        }),
        "retry.unsafe-not-retried" => Box::pin(async move {
            m.faults(status("SendMessage", &[(503, 0)])).await;
            let r = send(&client(m), "c-9").await;
            let n = m.api().await.len();
            ensure!(
                matches!(r, Err(Error::ServiceUnavailable(_))) && n == 1,
                "got {:?}, {n} requests",
                r.err()
            );
            Ok(())
        }),
        "retry.above-max-retry-delay" => Box::pin(async move {
            m.faults(status("GetAgentVersion", &[(429, 120)])).await;
            let t0 = Instant::now();
            let r = draft(&client(m)).await;
            let Err(Error::TooManyRequests(e)) = &r else {
                return Err(format!("got {:?}", r.err()));
            };
            ensure!(e.status == 429 && e.retry_after_seconds == Some(120), "got {e:?}");
            let n = m.api().await.len();
            ensure!(
                t0.elapsed() < Duration::from_secs(1) && n == 1,
                "waited {:?}, {n} requests",
                t0.elapsed()
            );
            Ok(())
        }),

        // ------------------------------------------------------------------ pagination
        "requests.range" => Box::pin(async move {
            let c = client(m);
            let r = c.knowledge_base(KB).documents().list().limit(500).page().await;
            let Err(Error::Validation(e)) = &r else {
                return Err(format!("limit: got {:?}", r.err()));
            };
            ensure!(
                e.status == 0
                    && e.code == "VALIDATION_FAILED"
                    && e.errors.len() == 1
                    && e.errors[0].parameter.as_deref() == Some("limit")
                    && e.errors[0].pointer.is_none(),
                "limit: {e:?}"
            );
            let r = c
                .core()
                .uploads()
                .reserve("a.txt", "text/plain", 1, "x")
                .expires_in_seconds(30)
                .await;
            let Err(Error::Validation(e)) = &r else {
                return Err(format!("expiresInSeconds: got {:?}", r.err()));
            };
            ensure!(
                e.status == 0
                    && e.code == "VALIDATION_FAILED"
                    && e.errors.len() == 1
                    && e.errors[0].pointer.as_deref() == Some("/expiresInSeconds"),
                "expiresInSeconds: {e:?}"
            );
            ensure!(m.api().await.is_empty(), "nothing is sent");
            c.knowledge_base(KB).documents().list().limit(100).page().await.map_err(s)?;
            ensure!(m.api().await.len() == 1, "a value inside its range is sent");
            Ok(())
        }),
        "pagination.to-last-page" => Box::pin(async move {
            let docs = list_all(&client(m), KB, Some(3)).await.map_err(s)?;
            let reqs = m.api().await;
            ensure!(
                docs.len() == 7
                    && reqs.len() == 3
                    && !str_at(&reqs[0], "query").contains("cursor=")
                    && str_at(&reqs[2], "query").contains("cursor="),
                "docs={} requests {reqs:?}",
                docs.len()
            );
            Ok(())
        }),
        "pagination.page" => Box::pin(async move {
            let c = client(m);
            let first = c.knowledge_base(KB).documents().list().limit(3).page().await.map_err(s)?;
            ensure!(first.items.len() == 3 && first.next_cursor.is_some(), "first page {first:?}");
            ensure!(m.api().await.len() == 1, "page() asks for one page only");
            let cursor = first.next_cursor.clone().unwrap_or_default();
            let second = c
                .knowledge_base(KB)
                .documents()
                .list()
                .limit(3)
                .cursor(cursor.clone())
                .page()
                .await
                .map_err(s)?;
            ensure!(second.items.len() == 3 && second.next_cursor.is_some(), "second page {second:?}");
            ensure!(
                !second.items.iter().any(|d| first.items.iter().any(|f| f.id == d.id)),
                "the second page follows the first"
            );
            let reqs = m.api().await;
            let sent = url::form_urlencoded::parse(str_at(&reqs[1], "query").trim_start_matches('?').as_bytes())
                .find(|(k, _)| k == "cursor")
                .map(|(_, v)| v.into_owned());
            ensure!(
                reqs.len() == 2 && !str_at(&reqs[0], "query").contains("cursor=") && sent.as_deref() == Some(cursor.as_str()),
                "requests {reqs:?}"
            );
            Ok(())
        }),
        "pagination.next-page" => Box::pin(async move {
            let first = client(m).knowledge_base(KB).documents().list().limit(3).page().await.map_err(s)?;
            ensure!(first.has_next_page(), "first page {first:?}");
            let second = first.next_page().await.map_err(s)?.ok_or_else(|| "no second page".to_string())?;
            ensure!(second.has_next_page() && second.items.len() == 3, "second page {second:?}");
            let third = second.next_page().await.map_err(s)?.ok_or_else(|| "no third page".to_string())?;
            ensure!(!third.has_next_page() && third.items.len() == 1, "third page {third:?}");
            ensure!(third.next_page().await.map_err(s)?.is_none(), "a page after the last");
            let reqs = m.api().await;
            let param = |r: &Value, k: &str| {
                url::form_urlencoded::parse(str_at(r, "query").trim_start_matches('?').as_bytes())
                    .find(|(n, _)| n == k)
                    .map(|(_, v)| v.into_owned())
            };
            ensure!(
                reqs.len() == 3
                    && param(&reqs[1], "cursor") == first.next_cursor
                    && reqs.iter().all(|r| param(r, "limit").as_deref() == Some("3")),
                "requests {reqs:?}"
            );
            Ok(())
        }),
        "pagination.pages-from-cursor" => Box::pin(async move {
            let c = client(m);
            let first = c.knowledge_base(KB).documents().list().limit(3).page().await.map_err(s)?;
            let cursor = first.next_cursor.clone().unwrap_or_default();
            let pages = c
                .knowledge_base(KB)
                .documents()
                .list()
                .limit(3)
                .cursor(cursor)
                .pages()
                .collect()
                .await
                .map_err(s)?;
            let sizes: Vec<usize> = pages.iter().map(|p| p.items.len()).collect();
            let reqs = m.api().await;
            ensure!(
                sizes == [3, 1]
                    && pages[0].next_cursor.is_some()
                    && pages[1].next_cursor.is_none()
                    && reqs.len() == 3
                    && str_at(&reqs[1], "query").contains("cursor=")
                    && str_at(&reqs[2], "query").contains("cursor="),
                "pages {sizes:?} requests {reqs:?}"
            );
            Ok(())
        }),

        // ------------------------------------------------------------------ SSE
        "sse.resumed-answer-reset" => Box::pin(async move {
            // The mock cuts the stream only once the SDK has yielded the two events before the cut, so it always has
            // an event ID to resume from.
            m.faults(json!({"dropAfterEvents": 2, "dropOnSignal": true, "finishWhileAway": true}))
                .await;
            let mut stream = send(&client(m), "c-away").await.map_err(s)?;
            let mut events = Vec::new();
            let mut err = None;
            while let Some(r) = stream.next().await {
                match r {
                    Ok(e) => events.push(e),
                    Err(e) => {
                        err = Some(e);
                        break;
                    }
                }
                if events.len() == 2 {
                    m.post("/__mock/drop", json!({})).await;
                }
            }
            ensure!(
                err.is_none() && events.len() == 3 && events[2].event_type() == "stream.reset",
                "events {} err {err:?}; want two events, then the reset",
                events.len()
            );
            let fin = stream.final_message().await;
            ensure!(
                matches!(&fin, Err(e) if e.code() == Some("NO_FINAL_EVENT")),
                "final_message: {fin:?}"
            );
            let gets = m.api().await.iter().filter(|r| str_at(r, "method") == "GET").count();
            ensure!(gets == 1, "{gets} reconnects; want one, and none after the reset");
            Ok(())
        }),
        "sse.watch-reconnects" => Box::pin(async move {
            let c = client(m);
            let mut first = send(&c, "c-w").await.map_err(s)?;
            let (_, err) = collect(&mut first).await;
            ensure!(err.is_none(), "send: {err:?}");
            m.faults(json!({"watchCloses": 7})).await;
            let mut watch = c.conversation("c-w").watch().await.map_err(s)?;
            let events = take(&mut watch, |e| e.event_type() == "message.completed").await.map_err(s)?;
            let types: Vec<_> = events.iter().map(|e| e.event_type()).collect();
            ensure!(
                types.join(" ")
                    == "message.started progress.updated tool.started tool.finished text.delta citation.added text.delta message.completed",
                "events {types:?}"
            );
            let gets = m
                .matching(|r| str_at(r, "method") == "GET" && str_at(r, "path") == "/v3/conversations/c-w/stream")
                .await;
            ensure!(
                gets.len() == 8,
                "{} requests; want eight: seven reconnects, because each carried an event",
                gets.len()
            );
            for (i, g) in gets[1..].iter().enumerate() {
                ensure!(
                    header(g, "last-event-id") == events[i].event_id(),
                    "reconnect {} Last-Event-ID {g:?}",
                    i + 1
                );
            }
            Ok(())
        }),
        "sse.watch-resends-request" => Box::pin(async move {
            m.faults(json!({"watchCloses": 1})).await;
            let mut stream = client(m)
                .events()
                .watch()
                .input(WatchWorkspaceEventsInput {
                    types: Some(vec!["conversation.created".into()]),
                    conversation_ids: Some(vec!["c-11".into(), "c-12".into()]),
                    ..Default::default()
                })
                .await
                .map_err(s)?;
            let mut n = 0;
            let events = take(&mut stream, |_| {
                n += 1;
                n == 2
            })
            .await
            .map_err(s)?;
            let reqs = m.matching(|r| str_at(r, "path") == "/v3/events/stream").await;
            ensure!(reqs.len() == 2, "{} requests", reqs.len());
            let (q0, q1) = (str_at(&reqs[0], "query"), str_at(&reqs[1], "query"));
            ensure!(
                q1 == q0
                    && q1.contains("type=conversation.created")
                    && q1.contains("conversationId=c-11")
                    && header(&reqs[1], "last-event-id") == events[0].event_id(),
                "requests {reqs:?}"
            );
            Ok(())
        }),
        "sse.conversation-reset" => Box::pin(async move {
            let c = client(m);
            let mut first = send(&c, "c-r").await.map_err(s)?;
            let (answer, err) = collect(&mut first).await;
            ensure!(err.is_none(), "send: {err:?}");
            let last = answer.last().and_then(|e| e.event_id()).ok_or("no last event id")?.to_owned();
            let mut watch = c
                .conversation("c-r")
                .watch()
                .input(WatchConversationInput {
                    last_event_id: Some(last),
                    ..Default::default()
                })
                .await
                .map_err(s)?;
            let events = take(&mut watch, |e| e.event_type() == "message.completed").await.map_err(s)?;
            let ConversationEvent::StreamReset(reset) = &events[0] else {
                return Err(format!("first event {:?}", events[0]));
            };
            ensure!(events[0].event_id() == Some(reset.cursor.as_str()), "reset {reset:?}");
            let gets = m.api().await.iter().filter(|r| str_at(r, "method") == "GET").count();
            ensure!(gets == 1, "{gets} requests; a reset is not an error and is never retried");
            Ok(())
        }),
        "sse.request-id-and-type" => Box::pin(async move {
            let mut stream = send(&client(m), "c-ids").await.map_err(s)?;
            let (evs, err) = collect(&mut stream).await;
            ensure!(err.is_none(), "{err:?}");
            let reqs = m.api().await;
            ensure!(
                stream.request_id() == Some(str_at(reqs.last().unwrap(), "requestId")),
                "request id {:?}",
                stream.request_id()
            );
            ensure!(
                evs[0].event_type() == "message.started" && evs.last().unwrap().event_type() == "message.completed",
                "event types {:?}",
                evs.iter().map(|e| e.event_type()).collect::<Vec<_>>()
            );
            let json = serde_json::to_value(evs.last().unwrap()).map_err(s)?;
            ensure!(
                json["type"] == "message.completed" && json["message"]["text"] == ANSWER,
                "serialised {json}"
            );
            Ok(())
        }),
        "sse.typed-events" => Box::pin(async move {
            let mut stream = send(&client(m), "c-1").await.map_err(s)?;
            let (mut text, mut names) = (String::new(), Vec::new());
            while let Some(ev) = stream.next().await {
                let ev = ev.map_err(s)?;
                names.push(event_name(&ev));
                match &ev {
                    ConversationEvent::TextDelta(d) => text.push_str(&d.delta),
                    ConversationEvent::CitationAdded(c) => ensure!(
                        c.citation.document_name.as_deref() == Some("leave-policy.pdf"),
                        "citation {:?}",
                        c.citation
                    ),
                    _ => {}
                }
            }
            let want = [
                "MessageStarted",
                "ProgressUpdated",
                "ToolStarted",
                "ToolFinished",
                "TextDelta",
                "CitationAdded",
                "TextDelta",
                "MessageCompleted",
            ];
            ensure!(text == ANSWER && names == want, "text {text:?} events {names:?}");
            let answer = stream.final_message().await.map_err(s)?;
            let page = answer.citations.as_ref().and_then(|c| c.first()).and_then(|c| c.page_number);
            ensure!(page == Some(3), "answer {answer:?}");
            let api = m.api().await;
            ensure!(
                header(&api[0], "accept") == Some("text/event-stream"),
                "accept {:?}",
                header(&api[0], "accept")
            );
            Ok(())
        }),
        "sse.resume" => Box::pin(async move {
            m.faults(json!({"dropAfterEvents": 3})).await;
            let mut stream = send(&client(m), "c-2").await.map_err(s)?;
            let (events, err) = collect(&mut stream).await;
            ensure!(err.is_none(), "{err:?}");
            let mut seen = HashSet::new();
            for e in &events {
                ensure!(
                    seen.insert(e.event_id().unwrap_or_default().to_owned()),
                    "duplicate {:?}",
                    e.event_id()
                );
            }
            let resume = m.matching(|r| str_at(r, "path") == "/v3/conversations/c-2/stream").await;
            ensure!(
                event_name(events.last().unwrap()) == "MessageCompleted"
                    && resume.len() == 1
                    && header(&resume[0], "last-event-id") == events[2].event_id()
                    && header(&resume[0], "accept") == Some("text/event-stream"),
                "events {} resume {resume:?}",
                events.len()
            );
            Ok(())
        }),
        "sse.final-ends-watch" => Box::pin(async move {
            m.faults(json!({"dropAfterEvents": 2})).await;
            let t0 = Instant::now();
            let mut stream = send(&client(m), "c-watch").await.map_err(s)?;
            let answer = stream.final_message().await.map_err(s)?;
            ensure!(answer.text == "Staff receive 20 days of annual leave.", "answer {answer:?}");
            ensure!(
                t0.elapsed() < Duration::from_secs(5),
                "ended when the server closed the watch, not at message.completed"
            );
            drop(stream);
            for i in 0.. {
                if !m.matching(|r| str_at(r, "event") == "client-disconnected").await.is_empty() {
                    break;
                }
                ensure!(i < 100, "the SDK did not close the watch connection");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Ok(())
        }),
        "sse.stream-reset" => Box::pin(async move {
            let mut stream = client(m)
                .events()
                .watch()
                .input(WatchWorkspaceEventsInput {
                    types: Some(vec!["conversation.created".into()]),
                    after: Some(STALE_CURSOR.into()),
                    ..Default::default()
                })
                .await
                .map_err(s)?;
            let mut n = 0;
            // a watch carries on until it is closed
            let events = take(&mut stream, |_| {
                n += 1;
                n == 2
            })
            .await
            .map_err(s)?;
            ensure!(events.len() == 2, "events {}", events.len());
            let WorkspaceEvent::StreamReset(reset) = &events[0] else {
                return Err(format!("first event {:?}", events[0]));
            };
            ensure!(
                events[0].event_type() == "stream.reset" && reset.cursor == RESET_CURSOR && events[0].event_id() == Some(RESET_CURSOR),
                "reset {reset:?}"
            );
            let WorkspaceEvent::ConversationCreated(created) = &events[1] else {
                return Err(format!("second event {:?}", events[1]));
            };
            ensure!(created.data.agent_id == "GHT7YRWXPL", "created {created:?}");
            let n = m.api().await.len();
            ensure!(n == 1, "{n} requests; a reset is not an error and is never retried");
            Ok(())
        }),
        "sse.reconnect-backoff" => Box::pin(async move {
            let c = client(m);
            let mut first = send(&c, "c-b").await.map_err(s)?;
            let (_, err) = collect(&mut first).await;
            ensure!(err.is_none(), "send: {err:?}");
            m.faults(json!({"watchEmptyCloses": 4})).await;
            let mut watch = c.conversation("c-b").watch().await.map_err(s)?;
            let (_, err) = collect(&mut watch).await;
            ensure!(
                matches!(&err, Some(e) if e.code() == Some("STREAM_LOST")),
                "got {err:?}, want STREAM_LOST"
            );
            let at: Vec<i64> = m
                .matching(|r| str_at(r, "method") == "GET")
                .await
                .iter()
                .map(|r| r["at"].as_i64().unwrap_or_default())
                .collect();
            ensure!(at.len() == 4, "{} requests; want the first and three reconnects", at.len());
            let (g1, g2, g3) = (at[1] - at[0], at[2] - at[1], at[3] - at[2]);
            ensure!(
                // The bands do not overlap, so their lower bounds show the pause grows; the upper bounds, three
                // times each band's top, catch a broken cap.
                g1 >= 200 && g2 >= 450 && g3 >= 950 && g1 <= 1500 && g2 <= 3000 && g3 <= 6000,
                "pauses {g1}, {g2}, {g3} ms: want at least 0.25, 0.5 and 1 s, and at most 1.5, 3 and 6 s"
            );
            Ok(())
        }),
        "sse.reconnect-without-event-id" => Box::pin(async move {
            m.faults(json!({"watchEmptyCloses": 1})).await;
            let mut stream = client(m)
                .events()
                .watch()
                .input(WatchWorkspaceEventsInput {
                    types: Some(vec!["conversation.created".into()]),
                    after: Some(ID_11.into()),
                    ..Default::default()
                })
                .await
                .map_err(s)?;
            take(&mut stream, |_| true).await.map_err(s)?;
            let reqs = m.matching(|r| str_at(r, "path") == "/v3/events/stream").await;
            ensure!(reqs.len() >= 2, "{} requests; want a reconnect", reqs.len());
            ensure!(
                header(&reqs[1], "last-event-id").is_none() && str_at(&reqs[1], "query") == str_at(&reqs[0], "query"),
                "reconnect {:?}; want no Last-Event-ID and the same query",
                reqs[1]
            );
            Ok(())
        }),
        "sse.reconnect-drops-after" => Box::pin(async move {
            m.faults(json!({"watchCloses": 1})).await;
            let mut stream = client(m)
                .events()
                .watch()
                .input(WatchWorkspaceEventsInput {
                    types: Some(vec!["conversation.created".into()]),
                    after: Some(ID_11.into()),
                    ..Default::default()
                })
                .await
                .map_err(s)?;
            let mut n = 0;
            let events = take(&mut stream, |_| {
                n += 1;
                n == 2
            })
            .await
            .map_err(s)?;
            let reqs = m.matching(|r| str_at(r, "path") == "/v3/events/stream").await;
            ensure!(reqs.len() >= 2, "{} requests", reqs.len());
            let (q0, q1) = (str_at(&reqs[0], "query"), str_at(&reqs[1], "query"));
            ensure!(
                q0.contains("after=")
                    && !q1.contains("after=")
                    && q1.contains("type=conversation.created")
                    && header(&reqs[1], "last-event-id") == events[0].event_id(),
                "requests {reqs:?}"
            );
            Ok(())
        }),
        "sse.long-connection-resets-count" => Box::pin(async move {
            let c = client(m);
            let mut first = send(&c, "c-l").await.map_err(s)?;
            let (_, err) = collect(&mut first).await;
            ensure!(err.is_none(), "send: {err:?}");
            // Five quiet responses in a row (the first and four reconnects), each open just over a minute: one more
            // than the limit, so the watch carries on only because each long connection restarts the count. The sixth
            // carries events.
            m.faults(json!({"watchEmptyCloses": 5})).await;
            let _clock = ConnectionsLasting::new(caitlyn_sdk_core::stream::LONG_CONNECTION + Duration::from_secs(1));
            let mut watch = c.conversation("c-l").watch().await.map_err(s)?;
            let first = watch.next().await;
            ensure!(
                matches!(&first, Some(Ok(e)) if e.event_type() == "message.started"),
                "first {first:?}; want message.started, with no STREAM_LOST"
            );
            let gets = m.api().await.iter().filter(|r| str_at(r, "method") == "GET").count();
            ensure!(gets == 6, "{gets} requests; want the first and five reconnects");
            Ok(())
        }),
        "sse.short-connections-stream-lost" => Box::pin(async move {
            let c = client(m);
            let mut first = send(&c, "c-s").await.map_err(s)?;
            let (_, err) = collect(&mut first).await;
            ensure!(err.is_none(), "send: {err:?}");
            m.faults(json!({"watchEmptyCloses": 4})).await;
            let _clock = ConnectionsLasting::new(caitlyn_sdk_core::stream::LONG_CONNECTION - Duration::from_secs(1));
            let mut watch = c.conversation("c-s").watch().await.map_err(s)?;
            let (_, err) = collect(&mut watch).await;
            ensure!(
                matches!(&err, Some(e) if e.code() == Some("STREAM_LOST")),
                "got {err:?}, want STREAM_LOST"
            );
            let gets = m.api().await.iter().filter(|r| str_at(r, "method") == "GET").count();
            ensure!(gets == 4, "{gets} requests; want the first and three reconnects");
            Ok(())
        }),
        "sse.duplicate-not-progress" => Box::pin(async move {
            let c = client(m);
            let mut first = send(&c, "c-d").await.map_err(s)?;
            let (_, err) = collect(&mut first).await;
            ensure!(err.is_none(), "send: {err:?}");
            m.faults(json!({"watchReplayCloses": 10})).await;
            let mut watch = c.conversation("c-d").watch().await.map_err(s)?;
            let (events, err) = collect(&mut watch).await;
            ensure!(
                events.len() == 1 && matches!(&err, Some(e) if e.code() == Some("STREAM_LOST")),
                "events {} err {err:?}; want one event, the duplicates dropped, then STREAM_LOST",
                events.len()
            );
            let gets = m.api().await.iter().filter(|r| str_at(r, "method") == "GET").count();
            ensure!(gets == 4, "{gets} requests; want the first and three reconnects");
            Ok(())
        }),
        "sse.watch-failed-answer" => Box::pin(async move {
            let c = client(m);
            m.faults(json!({"failStream": true})).await;
            let mut first = send(&c, "c-f").await.map_err(s)?;
            let (_, err) = collect(&mut first).await;
            ensure!(err.is_some(), "send: want the failure raised");
            let mut watch = c.conversation("c-f").watch().await.map_err(s)?;
            let events = take(&mut watch, |e| e.event_type() == "message.completed").await.map_err(s)?;
            let failed = events
                .iter()
                .position(|e| matches!(e, ConversationEvent::MessageFailed(f) if f.code == "SERVICE_UNAVAILABLE"));
            let completed = events.iter().position(|e| e.event_type() == "message.completed");
            ensure!(
                matches!((failed, completed), (Some(f), Some(c)) if f < c),
                "message.failed at {failed:?}, message.completed at {completed:?}; want the failure delivered, then the next answer"
            );
            Ok(())
        }),
        "sse.clean-end-resumes" => Box::pin(async move {
            m.faults(json!({"endAfterEvents": 2})).await;
            let mut stream = send(&client(m), "c-5").await.map_err(s)?;
            let (events, err) = collect(&mut stream).await;
            let resume = m.matching(|r| str_at(r, "path") == "/v3/conversations/c-5/stream").await;
            ensure!(
                err.is_none()
                    && event_name(events.last().unwrap()) == "MessageCompleted"
                    && resume.len() == 1
                    && header(&resume[0], "last-event-id") == events[1].event_id(),
                "err {err:?} events {} resume {resume:?}",
                events.len()
            );
            Ok(())
        }),
        "sse.message-failed" => Box::pin(async move {
            m.faults(json!({"failStream": true})).await;
            let mut stream = send(&client(m), "c-6").await.map_err(s)?;
            let (events, err) = collect(&mut stream).await;
            let Some(Error::ServiceUnavailable(e)) = &err else {
                return Err(format!("got {err:?}"));
            };
            ensure!(
                e.status == 503 && e.code == "SERVICE_UNAVAILABLE" && e.request_id.as_deref() == Some("01JC9Q2W7R4M0H2T6N1S8V3B80"),
                "got {e:?}"
            );
            let resumed = m.matching(|r| str_at(r, "path").ends_with("/stream")).await.len();
            ensure!(
                events.len() == 7 && resumed == 0,
                "{} events before the failure, {resumed} resumes; a failure is not resumed",
                events.len()
            );
            Ok(())
        }),

        // ------------------------------------------------------------------ tolerance
        "tolerance.unknown-event" => Box::pin(async move {
            m.faults(json!({"unknownEvent": true})).await;
            let mut stream = send(&client(m), "c-3").await.map_err(s)?;
            let (events, err) = collect(&mut stream).await;
            ensure!(
                err.is_none() && events.len() == 8 && event_name(&events[7]) == "MessageCompleted",
                "events {} err {err:?}",
                events.len()
            );
            Ok(())
        }),
        "tolerance.unknown-error-code" => Box::pin(async move {
            let body = json!({"type": "https://build.caitlyn.ai/errors/SOMETHING_NEW", "title": "Something new",
                "status": 409, "code": "SOMETHING_NEW", "requestId": "r-1"});
            m.faults(json!({"status": {"GetAgentVersion": [
                {"status": 409, "contentType": "application/problem+json", "body": body.to_string()}
            ]}}))
            .await;
            let r = client(m).agent(AGENT).draft().get().await;
            ensure!(
                matches!(&r, Err(Error::Conflict(e)) if e.status == 409 && e.code == "SOMETHING_NEW"),
                "response: {:?}",
                r.err()
            );
            m.reset().await;
            m.faults(json!({"busyDocuments": {"doc-0002": true}, "jobOutcomes": {"doc-0002": "failed"},
                "jobError": {"code": "SOMETHING_NEW", "detail": "A failure this SDK does not know."}}))
                .await;
            let r = client(m).knowledge_base(KB).document("doc-0002").wait().await;
            ensure!(
                matches!(&r, Err(Error::Api(e)) if e.status == 0 && e.code == "SOMETHING_NEW"),
                "job: {:?}",
                r.err()
            );
            Ok(())
        }),
        "tolerance.unknown-enum" => Box::pin(async move {
            m.faults(json!({"unknownEnum": true})).await;
            let docs = list_all(&client(m), KB, None).await.map_err(s)?;
            ensure!(
                docs[1].status == DocumentStatus::Unknown("archived".into()) && !docs[1].status.is_known(),
                "status {:?}",
                docs[1].status
            );
            let v = draft(&client(m)).await.map_err(s)?;
            ensure!(
                v.source.as_ref().map(|s| s.as_str()) == Some("cloned_from_template"),
                "source {:?}",
                v.source
            );
            Ok(())
        }),
        // ------------------------------------------------------------------ one type per thing (PROTOCOL.md 4.2)
        "result.thing" => Box::pin(async move {
            // The types are the point: each binding below names the thing's own type, so a wrapper would not compile.
            let c = client(m);
            let kb: KnowledgeBase = c.knowledge_base(KB).get().await.map_err(s)?;
            let kbs: Vec<KnowledgeBase> = c.knowledge_bases().list().collect().await.map_err(s)?;
            let doc: Document = c.knowledge_base(KB).document("doc-0001").get().await.map_err(s)?;
            let waited: Document = c.knowledge_base(KB).document("doc-0001").wait().await.map_err(s)?;
            let docs: Vec<Document> = list_all(&c, KB, None).await.map_err(s)?;
            let agent: Agent = c.agent(AGENT).get().await.map_err(s)?;
            let draft: AgentVersion = c.agent(AGENT).draft().get().await.map_err(s)?;
            let versions: Vec<AgentVersion> = c.agent(AGENT).versions().list().collect().await.map_err(s)?;
            let created: Created<caitlyn_sdk::scope::KnowledgeBaseScope, KnowledgeBase> =
                c.knowledge_bases().create("Policies").await.map_err(s)?;
            let new_kb: &KnowledgeBase = created.result();
            let mut watch = c.knowledge_base(KB).watch().await.map_err(s)?;
            let first = watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            let KnowledgeBaseEvent::Snapshot(snap) = first else {
                return Err(format!("first event {first:?}"));
            };
            let snap_kb: Option<KnowledgeBase> = snap.knowledge_base.clone();
            // Fields at the top level, no wrapper member.
            for (what, v) in [
                ("kb", serde_json::to_value(&kb).map_err(s)?),
                ("doc", serde_json::to_value(&doc).map_err(s)?),
                ("agent", serde_json::to_value(&agent).map_err(s)?),
                ("draft", serde_json::to_value(&draft).map_err(s)?),
                ("created", serde_json::to_value(new_kb).map_err(s)?),
            ] {
                ensure!(
                    v.get("id").or_else(|| v.get("name")).is_some()
                        && ["knowledgeBase", "document", "agent", "version"]
                            .iter()
                            .all(|k| v.get(*k).is_none_or(|x| !x.is_object())),
                    "{what} {v}"
                );
            }
            ensure!(
                kb.id == KB
                    && kbs.iter().any(|k| k.id == KB)
                    && doc.id == "doc-0001"
                    && waited.id == doc.id
                    && docs.iter().any(|d| d.id == doc.id)
                    && agent.id == AGENT
                    && draft.name == "draft"
                    && versions.iter().any(|v| v.name == "draft")
                    && created.id() == new_kb.id
                    && snap_kb.is_some_and(|k| k.id == KB),
                "things"
            );
            // A call whose output is not a thing keeps its named result.
            let _: PublishAgentVersionResult = c.agent(AGENT).draft().publish().name("v9").await.map_err(s)?;
            Ok(())
        }),
        "result.thing-metadata" => Box::pin(async move {
            let c = client(m);
            let kb = c.knowledge_base(KB).get().await.map_err(s)?;
            let reqs = m.api().await;
            let md = kb.response_metadata().ok_or("no metadata on a read")?;
            ensure!(
                md.http_status_code == 200 && md.request_id.as_deref() == Some(str_at(reqs.last().unwrap(), "requestId")),
                "metadata {md:?}"
            );
            let waited = c.knowledge_base(KB).document("doc-0001").wait().await.map_err(s)?;
            ensure!(
                waited.response_metadata().is_some_and(|m| m.http_status_code == 200),
                "wait() {:?}",
                waited.response_metadata()
            );
            let created = c.knowledge_bases().create("Policies").await.map_err(s)?;
            ensure!(
                created
                    .result()
                    .response_metadata()
                    .is_some_and(|m| m.http_status_code == 202 && m.request_id.is_some()),
                "create {:?}",
                created.result().response_metadata()
            );
            let listed = c.knowledge_bases().list().collect().await.map_err(s)?;
            ensure!(listed.iter().all(|k| k.response_metadata().is_none()), "a list item has metadata");
            let mut watch = c.knowledge_base(KB).watch().await.map_err(s)?;
            let first = watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            let KnowledgeBaseEvent::Snapshot(snap) = first else {
                return Err(format!("first event {first:?}"));
            };
            let entry = snap.knowledge_base.as_ref().ok_or("no knowledge base in the snapshot")?;
            ensure!(entry.response_metadata().is_none(), "a snapshot entry has metadata");
            let v = serde_json::to_value(&kb).map_err(s)?;
            ensure!(
                v.get("responseMetadata").is_none() && v.get("response_metadata").is_none() && v.get("$metadata").is_none(),
                "metadata serialised: {v}"
            );
            Ok(())
        }),
        "result.thing-etag" => Box::pin(async move {
            let c = client(m);
            let kb = c.knowledge_base(KB).get().await.map_err(s)?;
            let header = kb.response_metadata().and_then(|m| m.etag.clone()).ok_or("no ETag header")?;
            ensure!(kb.etag == header, "etag {} header {header}", kb.etag);
            let listed = c.knowledge_bases().list().collect().await.map_err(s)?;
            let row = listed.iter().find(|k| k.id == KB).ok_or("not listed")?;
            ensure!(row.etag == kb.etag, "list row etag {} read {}", row.etag, kb.etag);
            let mut watch = c.knowledge_base(KB).watch().await.map_err(s)?;
            let first = watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            let KnowledgeBaseEvent::Snapshot(snap) = first else {
                return Err(format!("first event {first:?}"));
            };
            let entry = snap.knowledge_base.ok_or("no knowledge base in the snapshot")?;
            ensure!(entry.etag == kb.etag, "snapshot etag {} read {}", entry.etag, kb.etag);
            // The body without its etag: the SDK fills it from the header.
            m.faults(json!({"etagHeaderOnly": true})).await;
            let doc = c.knowledge_base(KB).document("doc-0001").get().await.map_err(s)?;
            let header = doc.response_metadata().and_then(|m| m.etag.clone()).ok_or("no ETag header")?;
            ensure!(!doc.etag.is_empty() && doc.etag == header, "etag {:?} header {header}", doc.etag);
            ensure!(
                !doc.raw().get().is_some_and(|r| r.contains_key("etag")),
                "the body had an etag after all"
            );
            Ok(())
        }),
        "result.thing-raw" => Box::pin(async move {
            m.faults(json!({"unknownField": true})).await;
            let v = draft(&client(m)).await.map_err(s)?;
            let raw = v.raw().get().ok_or("no raw")?;
            ensure!(raw.get("reviewState") == Some(&json!({"required": false})), "raw {raw:?}");
            Ok(())
        }),
        "result.list-etag-if-match" => Box::pin(async move {
            let c = client(m);
            let docs = list_all(&c, KB, None).await.map_err(s)?;
            let row = docs.iter().find(|d| d.id == "doc-0001").ok_or("not listed")?;
            let updated = c
                .knowledge_base(KB)
                .document("doc-0001")
                .update()
                .name("renamed.pdf")
                .if_match(&row.etag)
                .await
                .map_err(s)?;
            ensure!(updated.output.document.name == "renamed.pdf", "updated {updated:?}");
            let sent = m.matching(|r| str_at(r, "method") == "PATCH").await;
            ensure!(
                sent.last().and_then(|r| header(r, "if-match")) == Some(row.etag.as_str()),
                "If-Match {:?}",
                sent.last().map(|r| &r["headers"])
            );
            // An agent's version row the same way: the draft from the versions list.
            let versions = c.agent(AGENT).versions().list().collect().await.map_err(s)?;
            let row = versions.iter().find(|v| v.name == "draft").ok_or("no draft row")?;
            c.agent(AGENT)
                .draft()
                .update()
                .guidance(AgentGuidance {
                    instructions: Some("Be brief.".into()),
                    ..Default::default()
                })
                .if_match(&row.etag)
                .await
                .map_err(s)?;
            Ok(())
        }),
        "tolerance.unknown-field-raw" => Box::pin(async move {
            m.faults(json!({"unknownField": true})).await;
            let c = client(m);
            let v = draft(&c).await.map_err(s)?;
            let raw = v.raw.get().ok_or("no raw")?;
            ensure!(
                raw.get("reviewState") == Some(&json!({"required": false})),
                "reviewState {:?}",
                raw.get("reviewState")
            );
            let answer = send(&c, "c-6").await.map_err(s)?.final_message().await.map_err(s)?;
            ensure!(
                answer.raw.get().and_then(|r| r.get("sentiment")) == Some(&json!("neutral")),
                "final raw {:?}",
                answer.raw
            );
            Ok(())
        }),
        "tolerance.nested-raw" => Box::pin(async move {
            m.faults(json!({"unknownField": true})).await;
            let c = client(m);
            let docs = list_all(&c, KB, None).await.map_err(s)?;
            ensure!(
                docs[0].raw.get().and_then(|r| r.get("retentionPolicy")) == Some(&json!({"keepDays": 365})),
                "item raw {:?}",
                docs[0].raw
            );
            let kbs = draft(&c)
                .await
                .map_err(s)?
                .configuration
                .unwrap_or_default()
                .knowledge_bases
                .unwrap_or_default();
            ensure!(
                kbs[0].raw.get().and_then(|r| r.get("reranker")) == Some(&json!("cohere")),
                "nested raw {:?}",
                kbs[0].raw
            );
            Ok(())
        }),

        // ------------------------------------------------------------------ typed errors
        "errors.404" => Box::pin(async move {
            for aws_header in [false, true] {
                m.reset().await;
                m.faults(json!({"awsErrorTypeHeader": aws_header})).await;
                let r = list_all(&client(m), "NOPE", None).await;
                let reqs = m.api().await;
                let last = str_at(reqs.last().unwrap(), "requestId");
                let Err(Error::NotFound(e)) = &r else {
                    return Err(format!("X-Amzn-Errortype {aws_header}: got {:?}", r.err()));
                };
                ensure!(
                    e.status == 404
                        && e.code == "NOT_FOUND"
                        && e.request_id.as_deref() == Some(last)
                        && e.r#type.as_deref() == Some("https://build.caitlyn.ai/errors/NOT_FOUND"),
                    "X-Amzn-Errortype {aws_header}: got {e:?}"
                );
            }
            Ok(())
        }),
        "errors.409" => Box::pin(async move {
            let c = client(m);
            let up = c.core().uploads().reserve("a.pdf", "application/pdf", 1, "x").await.map_err(s)?;
            let r = c
                .knowledge_base(KB)
                .documents()
                .create("a.pdf")
                .upload_id(up.id)
                .folder("/hr/")
                .await;
            ensure!(
                matches!(&r, Err(Error::Conflict(e)) if e.code == "CONFLICT" && e.code == ErrorCode::CONFLICT),
                "got {:?}",
                r.err()
            );
            Ok(())
        }),
        "errors.versions-not-numbered" => Box::pin(async move {
            m.faults(json!({"versionsNotNumbered": {"doc-0001": true}})).await;
            let doc = client(m).knowledge_base(KB).document("doc-0001");
            let r = doc.version("1").delete().await;
            ensure!(
                matches!(&r, Err(Error::Conflict(e)) if e.status == 409 && e.code == ErrorCode::VERSIONS_NOT_NUMBERED),
                "got {:?}",
                r.err()
            );
            let deletes = m.matching(|r| str_at(r, "method") == "DELETE").await;
            ensure!(deletes.len() == 1, "{} DELETEs, want 1 (not retried)", deletes.len());
            let d = doc.get().await.map_err(s)?;
            ensure!(d.version_count == Some(1), "after: {:?}", d.version_count);
            Ok(())
        }),
        "errors.412" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let update = |text: &str| UpdateDraftVersionInput {
                guidance: Some(AgentGuidance {
                    instructions: Some(text.into()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            c.agent(AGENT)
                .draft()
                .update()
                .input(update("first"))
                .if_match(&d.etag)
                .await
                .map_err(s)?;
            let r = c.agent(AGENT).draft().update().input(update("second")).if_match(&d.etag).await;
            ensure!(
                matches!(&r, Err(Error::PreconditionFailed(e)) if e.code == "PRECONDITION_FAILED" && e.request_id.is_some()),
                "got {:?}",
                r.err()
            );
            Ok(())
        }),
        "errors.decode-failed" => Box::pin(async move {
            m.faults(json!({"status": {"GetDocument": [{"status": 200, "body": "this is not JSON", "contentType": "application/json"}]}}))
                .await;
            let e = client(m)
                .knowledge_base(KB)
                .document("doc-0001")
                .get()
                .await
                .err()
                .ok_or("get returned")?;
            ensure!(e.code() == Some("DECODE_FAILED") && e.status() == Some(0), "got {e:?}");
            let cause = std::error::Error::source(&e).ok_or("no cause")?;
            ensure!(cause.downcast_ref::<serde_json::Error>().is_some(), "cause {cause:?}");
            Ok(())
        }),
        "errors.job-failed-no-code" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0002": true}, "jobOutcomes": {"doc-0002": "failed"},
                "jobError": {"detail": "The job failed and said no more."}}))
                .await;
            let e = client(m)
                .knowledge_base(KB)
                .document("doc-0002")
                .wait()
                .timeout(Duration::from_secs(10))
                .await
                .err()
                .ok_or("wait returned")?;
            ensure!(
                e.code() == Some("JOB_FAILED") && e.status() == Some(0) && matches!(e, Error::Api(_)),
                "got {e:?}"
            );
            Ok(())
        }),
        "errors.file-unreadable" => Box::pin(async move {
            /// Some bytes, then the read fails, as a disk going away would.
            struct Failing(bool);
            impl tokio::io::AsyncRead for Failing {
                fn poll_read(
                    mut self: Pin<&mut Self>,
                    _: &mut std::task::Context<'_>,
                    buf: &mut tokio::io::ReadBuf<'_>,
                ) -> std::task::Poll<std::io::Result<()>> {
                    if self.0 {
                        return std::task::Poll::Ready(Err(std::io::Error::other("the disk went away")));
                    }
                    self.0 = true;
                    buf.put_slice(b"%PDF-1.7 first part");
                    std::task::Poll::Ready(Ok(()))
                }
            }
            let c = client(m);
            let e = c
                .core()
                .uploads()
                .send(UploadFile::from_reader("scan.pdf", Failing(false)))
                .await
                .err()
                .ok_or("send returned")?;
            ensure!(e.code() == Some("FILE_UNREADABLE") && e.status() == Some(0), "stream: got {e:?}");
            let cause = std::error::Error::source(&e)
                .and_then(|c| c.downcast_ref::<std::io::Error>())
                .ok_or("no io cause")?;
            ensure!(cause.to_string() == "the disk went away", "stream cause {cause}");
            let missing = root().join("build/rust-conformance-tmp/no-such-file.pdf");
            let e = c
                .core()
                .uploads()
                .send(UploadFile::path_unchecked(&missing))
                .await
                .err()
                .ok_or("send returned")?;
            ensure!(e.code() == Some("FILE_UNREADABLE") && e.status() == Some(0), "path: got {e:?}");
            let cause = std::error::Error::source(&e)
                .and_then(|c| c.downcast_ref::<std::io::Error>())
                .ok_or("no io cause")?;
            ensure!(cause.kind() == std::io::ErrorKind::NotFound, "path cause {cause}");
            ensure!(m.api().await.is_empty(), "nothing was sent");
            Ok(())
        }),
        "errors.item-has-no-file" => Box::pin(async move {
            m.faults(json!({"strayItem": "/hr/stray.pdf"})).await;
            let dir = folder_of(&[("annual-leave.md", "Staff receive 20 days of annual leave.")]);
            let e = client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::dir(&dir).folder("/hr/"))
                .await
                .err()
                .ok_or("sync returned")?;
            ensure!(e.code() == Some("INGESTION_ITEM_HAS_NO_FILE") && e.status() == Some(0), "got {e:?}");
            ensure!(e.to_string().contains("/hr/stray.pdf"), "message {e}");
            let forms = m.matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == "/__s3/").await;
            ensure!(forms.is_empty(), "uploaded {forms:?}");
            Ok(())
        }),
        "errors.429-exhausted" => Box::pin(async move {
            m.faults(status("GetAgentVersion", &[(429, 0), (429, 0), (429, 0)])).await;
            let r = draft(&client(m)).await;
            let e = r
                .as_ref()
                .err()
                .and_then(Error::api)
                .ok_or_else(|| format!("got {:?}", r.as_ref().err()))?;
            let n = m.api().await.len();
            ensure!(
                e.status == 429 && e.code == "RATE_LIMITED" && e.retry_after_seconds == Some(0) && n == 3,
                "got {e:?}, {n} requests"
            );
            Ok(())
        }),
        "errors.html-404" => Box::pin(async move {
            m.faults(json!({"status": {"ListDocuments": [{"status": 404, "contentType": "text/html; charset=utf-8", "body": HTML_404}]}}))
                .await;
            let r = list_all(&client(m), KB, None).await;
            let Err(Error::NotFound(e)) = &r else {
                return Err(format!("got {:?}", r.err()));
            };
            ensure!(
                e.status == 404 && e.code == "HTTP_404" && e.request_id.is_none() && e.raw_body == HTML_404,
                "got {e:?}"
            );
            Ok(())
        }),
        "errors.empty-405" => Box::pin(async move {
            m.faults(json!({"status": {"GetAgentVersion": [{"status": 405, "body": ""}]}}))
                .await;
            let r = draft(&client(m)).await;
            let Err(Error::Api(e)) = &r else {
                return Err(format!("got {:?}", r.err()));
            };
            ensure!(
                e.status == 405 && e.code == "HTTP_405" && e.request_id.is_none() && e.raw_body.is_empty(),
                "got {e:?}"
            );
            Ok(())
        }),
        "errors.text-502" => Box::pin(async move {
            m.faults(json!({"status": {"GetAgentVersion": [{"status": 502, "contentType": "text/plain", "body": "Bad Gateway"}]}}))
                .await;
            let r = draft(&client(m)).await;
            let Err(Error::Api(e)) = &r else {
                return Err(format!("got {:?}", r.err()));
            };
            let n = m.api().await.len();
            ensure!(
                e.status == 502 && e.code == "HTTP_502" && e.raw_body == "Bad Gateway" && n == 1,
                "got {e:?}, {n} requests"
            );
            Ok(())
        }),
        "errors.status-from-http" => {
            Box::pin(async move {
                m.faults(json!({"status": {"CreateUpload": [{"status": 409, "contentType": "application/problem+json", "body": MISMATCHED_409}]}}))
                .await;
                let r = client(m).core().uploads().reserve("a.txt", "text/plain", 1, "x").await;
                let Err(Error::Conflict(e)) = &r else {
                    return Err(format!("got {:?}", r.err()));
                };
                ensure!(
                    e.status == 409 && e.code == "CONFLICT" && e.request_id.as_deref() == Some("01MISMATCHEDSTATUS0000000"),
                    "got {e:?}"
                );
                Ok(())
            })
        }
        "errors.field-errors" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let r = c
                .agent(AGENT)
                .draft()
                .update()
                .input(UpdateDraftVersionInput {
                    guidance: Some(AgentGuidance {
                        identity: Some("x".into()),
                        ..Default::default()
                    }),
                    clear: Some(vec![ClearableDraftField::GuidanceIdentity]),
                    ..Default::default()
                })
                .if_match(&d.etag)
                .await;
            let Err(Error::Validation(e)) = &r else {
                return Err(format!("got {:?}", r.err()));
            };
            ensure!(
                e.code == "VALIDATION_FAILED"
                    && e.errors.len() == 1
                    && e.errors[0].pointer.as_deref() == Some("/guidance/identity")
                    && e.errors[0].code == "VALIDATION_FAILED",
                "got {e:?}"
            );
            let (_, body) = last_patch(m).await;
            ensure!(
                body == json!({"guidance": {"identity": "x"}, "clear": ["guidance.identity"]}),
                "body {body}"
            );
            Ok(())
        }),
        "errors.unmodelled-status" => Box::pin(async move {
            m.faults(json!({"status": {"CreateUpload": [{"status": 404}, {"status": 405, "body": ""}]}}))
                .await;
            let c = client(m);
            let reserve = || c.core().uploads().reserve("a.txt", "text/plain", 1, "x");
            let r = reserve().await;
            let Err(Error::NotFound(e)) = &r else {
                return Err(format!("404: got {:?}", r.err()));
            };
            ensure!(e.status == 404 && e.code == "HTTP_404", "404: {e:?}");
            let r = reserve().await;
            let Err(Error::Api(e)) = &r else {
                return Err(format!("405: got {:?}", r.err()));
            };
            ensure!(e.status == 405 && e.code == "HTTP_405", "405: {e:?}");
            Ok(())
        }),
        "errors.raw-body-limit" => Box::pin(async move {
            let page = format!("<!DOCTYPE html>{}", "x".repeat(20480 - 15));
            let straddle = format!("{}{}", "a".repeat(8191), "€".repeat(10));
            let html = |body: &str| json!({"status": 404, "contentType": "text/html", "body": body});
            m.faults(json!({"status": {"GetAgentVersion": [html(&page), html(&straddle)]}}))
                .await;
            let c = client(m);
            let get = |version: &'static str| {
                let c = c.clone();
                async move {
                    match c.agent(AGENT).version(version).get().await {
                        Err(Error::NotFound(e)) => Ok(e),
                        other => Err(format!("got {:?}", other.err())),
                    }
                }
            };
            let e = get("draft").await?;
            ensure!(
                e.raw_body.len() == 8192 && e.raw_body == page[..8192] && e.raw_body_truncated,
                "page: {} bytes, truncated {}",
                e.raw_body.len(),
                e.raw_body_truncated
            );
            let e = get("draft").await?;
            ensure!(
                e.raw_body == "a".repeat(8191) && e.raw_body_truncated,
                "straddle: {} bytes, truncated {}",
                e.raw_body.len(),
                e.raw_body_truncated
            );
            let e = get("nope").await?;
            let body: Value = serde_json::from_str(&e.raw_body).map_err(s)?;
            ensure!(
                body["code"] == "NOT_FOUND" && !e.raw_body_truncated,
                "problem: {} truncated {}",
                e.raw_body,
                e.raw_body_truncated
            );
            Ok(())
        }),
        "errors.connection" => Box::pin(async move {
            m.faults(json!({"status": {"GetAgentVersion": [{"close": true}]}})).await;
            let once = |endpoint: &str| {
                Client::builder(WORKSPACE, Auth::token(PAT))
                    .endpoint(endpoint)
                    .max_attempts(1)
                    .build()
                    .expect("client")
            };
            let closed = draft(&once(&m.base)).await;
            let refused = draft(&once(&refused_endpoint())).await;
            for r in [&closed, &refused] {
                let Err(e @ Error::Connection(c)) = r else {
                    return Err(format!("not a connection error: {:?}", r.as_ref().err()));
                };
                ensure!(
                    e.status() == Some(0) && e.code() == Some("CONNECTION_ERROR") && e.request_id().is_none(),
                    "status {:?} code {:?} request id {:?}",
                    e.status(),
                    e.code(),
                    e.request_id()
                );
                ensure!(c.operation == "GetAgentVersion" && e.to_string().contains("GetAgentVersion"), "{e}");
                ensure!(std::error::Error::source(e).is_some(), "no cause on {e}");
            }
            let Err(Error::Connection(c)) = &refused else { unreachable!() };
            ensure!(c.source.is_connect(), "the cause of a refused connection is {:?}", c.source);
            ensure!(m.api().await.len() == 1, "requests={}", m.api().await.len());
            Ok(())
        }),

        // ------------------------------------------------------------------ cancellation
        "cancel.stream" => Box::pin(async move {
            m.faults(json!({"streamDelayMs": 150})).await;
            let token = CancellationToken::new();
            let mut stream = client(m).conversation("c-4").send("hi").cancel_on(token.clone()).await.map_err(s)?;
            let mut n = 0;
            let mut last = None;
            while let Some(r) = stream.next().await {
                match r {
                    Err(e) => {
                        last = Some(e);
                        break;
                    }
                    Ok(_) => {
                        n += 1;
                        if n == 2 {
                            token.cancel();
                        }
                    }
                }
            }
            ensure!(matches!(last, Some(Error::Cancelled)), "want Error::Cancelled, got {last:?}");
            tokio::time::sleep(Duration::from_millis(300)).await;
            let gone = m.matching(|r| str_at(r, "event") == "client-disconnected").await.len();
            ensure!(gone > 0, "the mock saw no disconnect");
            Ok(())
        }),
        "cancel.unary" => Box::pin(async move {
            m.faults(status("GetAgentVersion", &[(503, 2)])).await;
            let token = CancellationToken::new();
            let t = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                t.cancel();
            });
            let t0 = Instant::now();
            let r = client(m).agent(AGENT).version("draft").get().cancel_on(token).await;
            ensure!(
                matches!(r, Err(Error::Cancelled)) && t0.elapsed() < Duration::from_secs(1),
                "got {:?} after {:?}",
                r.err(),
                t0.elapsed()
            );
            Ok(())
        }),

        "cancel.before-retry" => Box::pin(async move {
            // A 503 that asks for a retry in 30 s. The cancel comes once the mock has answered it, an event rather than a
            // timer: the call is then between its answer and the retry, or in the wait, and ends cancelled with nothing
            // more sent. (Rust's harness has no client-side hook on a response, so the 500 path the other languages
            // also check is not here; send() checks the token on every attempt's result.)
            m.faults(status("GetAgentVersion", &[(503, 30)])).await;
            let token = CancellationToken::new();
            let t = token.clone();
            let call = {
                let c = client(m);
                tokio::spawn(async move { c.agent(AGENT).version("draft").get().cancel_on(t).await })
            };
            loop {
                let answered = m
                    .api()
                    .await
                    .iter()
                    .any(|r| str_at(r, "path").contains("/versions/") && r["status"].as_i64() == Some(503));
                if answered {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            token.cancel();
            let r = call.await.map_err(s)?;
            ensure!(matches!(r, Err(Error::Cancelled)), "got {:?}", r.err());
            let n = m.api().await.iter().filter(|r| str_at(r, "path").contains("/versions/")).count();
            ensure!(n == 1, "{n} requests: want nothing more sent");
            Ok(())
        }),

        // ------------------------------------------------------------------ updates
        "update.if-match" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let updated = c
                .agent(AGENT)
                .draft()
                .update()
                .input(UpdateDraftVersionInput {
                    guidance: Some(AgentGuidance {
                        instructions: Some("x".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .if_match(&d.etag)
                .await
                .map_err(s)?;
            ensure!(!updated.etag.is_empty() && updated.etag != d.etag, "etag {:?}", updated.etag);
            let (p, body) = last_patch(m).await;
            ensure!(
                header(&p, "if-match") == Some(d.etag.as_str()) && body == json!({"guidance": {"instructions": "x"}}),
                "patch {p}"
            );
            Ok(())
        }),
        "update.clear" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let updated = c
                .agent(AGENT)
                .draft()
                .update()
                .input(UpdateDraftVersionInput {
                    clear: Some(vec![ClearableDraftField::GuidanceIdentity]),
                    ..Default::default()
                })
                .if_match(&d.etag)
                .await
                .map_err(s)?;
            ensure!(
                updated
                    .configuration
                    .as_ref()
                    .and_then(|c| c.guidance.as_ref())
                    .is_some_and(|g| g.identity.is_none() && g.instructions.as_deref() == Some("Answer from the HR policies.")),
                "updated {:?}",
                updated.configuration
            );
            let (_, body) = last_patch(m).await;
            ensure!(body == json!({"clear": ["guidance.identity"]}), "body {body}");
            Ok(())
        }),

        // ------------------------------------------------------------------ wire and environment
        "wire.user-agent-suffixes" => Box::pin(async move {
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .app_id("acme-intake#2.1")
                .ci("gitlab")
                .agent("claude-code")
                .build()
                .map_err(s)?;
            draft(&c).await.map_err(s)?;
            let sent = m.api().await;
            ensure!(sent.len() == 1, "requests={}", sent.len());
            let ua = header(&sent[0], "user-agent").unwrap_or_default();
            ensure!(
                ua.ends_with(" app/acme-intake#2.1 ci/gitlab agent/claude-code"),
                "user agent {ua:?}"
            );
            for (ci, agent) in [
                ("GitLab", "claude-code"),
                ("gitlab", "claude code"),
                (&*"x".repeat(33), "claude-code"),
                ("gitlab", ""),
            ] {
                let built = Client::builder(WORKSPACE, Auth::token(PAT))
                    .endpoint(&m.base)
                    .ci(ci)
                    .agent(agent)
                    .build();
                ensure!(matches!(built, Err(Error::Input(_))), "ci {ci:?} agent {agent:?} built a client");
            }
            ensure!(m.api().await.len() == 1, "an invalid value sent nothing");
            Ok(())
        }),
        "wire.headers" => Box::pin(async move {
            m.faults(status("GetAgentVersion", &[(503, 0)])).await;
            draft(&client(m)).await.map_err(s)?;
            let sent = m.api().await;
            ensure!(sent.len() == 2, "requests={}", sent.len());
            let ua = regex_lite::Regex::new(&format!(
                r"^caitlyn-sdk-rust/{} lang/rust#1\.\d+\.\d+ md/rustc os/[a-z]+$",
                regex_lite::escape(&sdk_version())
            ))
            .unwrap();
            let model = sdk_model();
            for r in &sent {
                for h in r["headerNames"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    ensure!(!(h.starts_with("x-amz") || h.starts_with("amz-sdk")), "AWS header sent: {h}");
                }
                ensure!(
                    ua.is_match(header(r, "user-agent").unwrap_or_default()),
                    "user agent {:?}",
                    header(r, "user-agent")
                );
                ensure!(
                    header(r, "caitlyn-sdk-model") == Some(model.as_str())
                        && header(r, "caitlyn-api-version").is_none()
                        && header(r, "authorization") == Some("Bearer pat_test")
                        && header(r, "content-type").is_none()
                        && header(r, "traceparent").is_none(),
                    "headers {}",
                    r["headers"]
                );
            }
            Ok(())
        }),
        "environment.hostile-aws" => Box::pin(async move {
            let hostile =
                "max_attempts = 1\nretry_mode = adaptive\ndefaults_mode = auto\nendpoint_url = http://127.0.0.1:9\nregion = xx-hostile-1\n";
            let cfg = temp_file(
                "aws-config",
                format!("[profile hostile]\n{hostile}\n[default]\n{hostile}").as_bytes(),
            );
            let vars = [
                ("AWS_PROFILE", "hostile".to_owned()),
                ("AWS_REGION", "xx-hostile-1".into()),
                ("AWS_MAX_ATTEMPTS", "1".into()),
                ("AWS_RETRY_MODE", "adaptive".into()),
                ("AWS_DEFAULTS_MODE", "auto".into()),
                ("AWS_ENDPOINT_URL", "http://127.0.0.1:9".into()),
                ("AWS_CONFIG_FILE", cfg.display().to_string()),
                ("AWS_SHARED_CREDENTIALS_FILE", cfg.display().to_string()),
                ("AWS_EC2_METADATA_SERVICE_ENDPOINT", "http://10.255.255.1".into()),
            ];
            for (k, v) in &vars {
                std::env::set_var(k, v);
            }
            let result = async {
                m.faults(status("GetAgentVersion", &[(503, 0)])).await;
                let t0 = Instant::now();
                let v = draft(&client(m)).await.map_err(s)?;
                let docs = list_all(&client(m), KB, Some(3)).await.map_err(s)?;
                ensure!(
                    v.name == "draft" && docs.len() == 7 && t0.elapsed() < Duration::from_secs(2),
                    "name {} docs {} after {:?}",
                    v.name,
                    docs.len(),
                    t0.elapsed()
                );
                let n = m.matching(|r| str_at(r, "path").contains("/versions/")).await.len();
                ensure!(n == 2, "AWS_MAX_ATTEMPTS=1 was not ignored: {n} requests");
                Ok(())
            }
            .await;
            for (k, _) in &vars {
                std::env::remove_var(k);
            }
            result
        }),

        // ------------------------------------------------------------------ versions, headers, telemetry, endpoint
        "since.fails-before-sending" => Box::pin(async move {
            m.faults(json!({"apiVersion": "5.110.0"})).await;
            let c = client(m);
            draft(&c).await.map_err(s)?; // no check before the first response
            let before = m.api().await.len();
            let r = draft(&c).await;
            let after = m.api().await.len();
            let Err(Error::NotSupportedByServer(e)) = &r else {
                return Err(format!("got {:?}", r.err()));
            };
            ensure!(
                e.operation == "GetAgentVersion" && e.requires == get_agent_version_since() && e.server == "5.110.0" && after == before,
                "got {e:?}, {after} requests"
            );
            Ok(())
        }),
        "since.unknown-operation" => Box::pin(async move {
            m.faults(json!({"status": {"GetAgentVersion": [
                {"status": 404, "code": "UNKNOWN_OPERATION"},
                {"status": 405, "code": "METHOD_NOT_ALLOWED"},
                {"status": 404, "code": "NOT_FOUND"}
            ]}}))
            .await;
            let c = client(m);
            for (i, answer) in ["404 UNKNOWN_OPERATION", "405 METHOD_NOT_ALLOWED"].iter().enumerate() {
                let r = draft(&c).await;
                let Err(Error::NotSupportedByServer(e)) = &r else {
                    return Err(format!("{answer}: got {:?}", r.err()));
                };
                let n = m.api().await.len();
                ensure!(
                    e.operation == "GetAgentVersion"
                        && e.requires == get_agent_version_since()
                        && e.server == server_version()
                        && n == i + 1,
                    "{answer}: got {e:?}, {n} requests"
                );
            }
            let r = draft(&c).await;
            ensure!(
                matches!(&r, Err(e) if !matches!(e, Error::NotSupportedByServer(_)) && e.status() == Some(404) && e.code() == Some("NOT_FOUND")),
                "NOT_FOUND: got {:?}",
                r.err()
            );
            Ok(())
        }),
        "headers.request-id" => Box::pin(async move {
            // A named result has them as members; a thing has them in its response metadata (PROTOCOL.md 4.2).
            let c = client(m);
            let est = c
                .knowledge_base(KB)
                .documents()
                .estimate_create(pdf("a.pdf", b"a"))
                .await
                .map_err(s)?;
            let reqs = m.api().await;
            ensure!(
                est.request_id.as_deref() == Some(str_at(reqs.last().unwrap(), "requestId"))
                    && est.api_version.as_deref() == Some(server_version().as_str()),
                "request id {:?} api version {:?}",
                est.request_id,
                est.api_version
            );
            let v = draft(&c).await.map_err(s)?;
            let reqs = m.api().await;
            let md = v.response_metadata().ok_or("no response metadata on the thing")?;
            ensure!(
                md.request_id.as_deref() == Some(str_at(reqs.last().unwrap(), "requestId"))
                    && md.api_version.as_deref() == Some(server_version().as_str()),
                "thing's metadata {md:?}"
            );
            Ok(())
        }),
        "headers.response-metadata" => Box::pin(async move {
            let v = draft(&client(m)).await.map_err(s)?;
            let reqs = m.api().await;
            let md = v.response_metadata().ok_or("no response metadata")?;
            ensure!(
                md.http_status_code == 200
                    && md.request_id.as_deref() == Some(str_at(reqs.last().unwrap(), "requestId"))
                    && md.etag.as_deref() == Some("\"draft-1\"")
                    && md.etag.as_deref() == Some(v.etag.as_str()),
                "metadata {md:?}"
            );
            ensure!(
                AgentVersion::default().response_metadata().is_none(),
                "a value built in code has metadata"
            );
            ensure!(
                serde_json::to_value(&v).map_err(s)?.get("responseMetadata").is_none(),
                "metadata serialised"
            );
            Ok(())
        }),
        "telemetry.attributes" => Box::pin(async move {
            use tracing_subscriber::layer::SubscriberExt;
            let capture = Capture::default();
            let _guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(capture.clone()));
            let c = client(m);
            m.faults(status("GetAgentVersion", &[(503, 0)])).await;
            let r = c.agent(AGENT).version("nope").get().await;
            ensure!(r.is_err(), "no error");
            list_all(&c, KB, Some(100)).await.map_err(s)?;
            let f = UploadFile::from_path(temp_file("hello.txt", b"hello")).map_err(s)?;
            c.core().uploads().send(f).await.map_err(s)?;
            let spans = capture.0.lock().unwrap().clone();
            let field = |r: &SpanRec, k: &str| r.fields.get(k).cloned().unwrap_or_default();
            let ours: Vec<&SpanRec> = spans.iter().filter(|r| r.name.starts_with("caitlyn.")).collect();
            for r in &ours {
                ensure!(
                    ["caitlyn.call", "caitlyn.attempt", "caitlyn.upload"].contains(&r.name) && field(r, "otel.name") == r.name,
                    "span {} named {}",
                    r.name,
                    field(r, "otel.name")
                );
                ensure!(!r.fields.contains_key("caitlyn.operation"), "caitlyn.operation on {}", r.name);
            }
            let children = |p: &SpanRec| {
                ours.iter()
                    .filter(|r| r.parent == Some(p.id))
                    .map(|r| (*r).clone())
                    .collect::<Vec<_>>()
            };
            let find = |name: &str, method: &str| {
                ours.iter()
                    .find(|r| r.name == name && (method.is_empty() || field(r, "rpc.method") == method))
                    .map(|r| (*r).clone())
                    .ok_or(format!("no {name} {method} span"))
            };
            let sent: Vec<Value> = m
                .api()
                .await
                .into_iter()
                .filter(|r| str_at(r, "path") == "/v3/agents/GHT7YRWXPL/versions/nope")
                .collect();
            let call = find("caitlyn.call", "GetAgentVersion")?;
            ensure!(
                field(&call, "rpc.system") == "caitlyn"
                    && field(&call, "error.type") == "NotFoundError"
                    && field(&call, "caitlyn.error.code") == "NOT_FOUND"
                    && field(&call, "caitlyn.request_id") == str_at(sent.last().unwrap(), "requestId")
                    && field(&call, "otel.status_code") == "ERROR"
                    && !field(&call, "otel.status_message").is_empty(),
                "call span {:?}",
                call.fields
            );
            ensure!(
                call.events
                    .iter()
                    .any(|e| e.get("exception.type").map(String::as_str) == Some("NotFoundError")),
                "no exception event: {:?}",
                call.events
            );
            let attempts = children(&call);
            ensure!(attempts.len() == 2, "attempts {}", attempts.len());
            for (i, a) in attempts.iter().enumerate() {
                let want = [
                    ("http.request.method", "GET".to_owned()),
                    ("server.address", "127.0.0.1".to_owned()),
                    ("url.full", format!("{}/v3/agents/GHT7YRWXPL/versions/nope", m.base)),
                    ("http.request.resend_count", i.to_string()),
                    ("http.response.status_code", ["503", "404"][i].to_owned()),
                    ("caitlyn.request_id", str_at(&sent[i], "requestId").to_owned()),
                    ("caitlyn.server.api_version", server_version()),
                    ("otel.status_code", "ERROR".to_owned()),
                    ("error.type", ["ServiceUnavailableError", "NotFoundError"][i].to_owned()),
                    ("caitlyn.error.code", ["SERVICE_UNAVAILABLE", "NOT_FOUND"][i].to_owned()),
                ];
                for (k, v) in want {
                    ensure!(field(a, k) == v, "attempt {i} {k} = {:?}, want {v:?}", field(a, k));
                }
                ensure!(!field(a, "otel.status_message").is_empty(), "attempt {i} has no status message");
                let want_type = ["ServiceUnavailableError", "NotFoundError"][i];
                ensure!(
                    a.events
                        .iter()
                        .any(|e| e.get("exception.type").map(String::as_str) == Some(want_type)),
                    "attempt {i} exception events {:?}",
                    a.events
                );
            }
            let list = children(&find("caitlyn.call", "ListDocuments")?);
            ensure!(
                list.len() == 1
                    && field(&list[0], "url.full") == format!("{}/v3/knowledge-bases/{KB}/documents", m.base)
                    && field(&list[0], "otel.status_code").is_empty(),
                "list attempts {list:?}"
            );
            let up = find("caitlyn.upload", "")?;
            let url = field(&up, "url.full");
            ensure!(
                field(&up, "http.request.method") == "PUT"
                    && field(&up, "server.address") == "127.0.0.1"
                    && field(&up, "http.response.status_code") == "200"
                    && url.contains("/__s3/")
                    && !url.contains('?'),
                "upload span {:?}",
                up.fields
            );
            Ok(())
        }),
        "telemetry.spans" => Box::pin(async move {
            use tracing_subscriber::layer::SubscriberExt;
            let capture = Capture::default();
            let _guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(capture.clone()));
            m.faults(status("GetAgentVersion", &[(503, 0)])).await;
            let traceparent = |span: &tracing::Span, h: &mut http::HeaderMap| {
                if let Some(id) = span.id() {
                    h.insert(
                        "traceparent",
                        format!("00-{:032x}-{:016x}-01", 0xC417u64, id.into_u64()).parse().unwrap(),
                    );
                }
            };
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .propagator(traceparent)
                .build()
                .map_err(s)?;
            draft(&c).await.map_err(s)?;
            let spans = capture.0.lock().unwrap().clone();
            let call = spans
                .iter()
                .find(|r| r.fields.get("otel.name").map(String::as_str) == Some("caitlyn.call"))
                .ok_or("no call span")?;
            let resends: Vec<_> = spans
                .iter()
                .filter(|r| r.parent == Some(call.id))
                .filter_map(|r| r.fields.get("http.request.resend_count").cloned())
                .collect();
            let reqs = m.api().await;
            ensure!(
                resends == ["0", "1"]
                    && call.fields.get("caitlyn.request_id").map(String::as_str) == Some(str_at(reqs.last().unwrap(), "requestId")),
                "attempt spans {resends:?} call {:?}",
                call.fields
            );
            ensure!(reqs.iter().all(|r| header(r, "traceparent").is_some()), "no traceparent");
            Ok(())
        }),
        "endpoint.workspace-url" => Box::pin(async move {
            for w in [
                "https://your-company.caitlyn.ai",
                "https://your-company.caitlyn.ai/",
                "your-company.caitlyn.ai/",
                "HTTPS://Your-Company.Caitlyn.ai",
            ] {
                let c = Client::new(w, Auth::token(PAT)).map_err(s)?;
                ensure!(
                    c.endpoint() == "https://your-company.caitlyn.ai/api"
                        && c.auth().token_endpoint() == "https://your-company.caitlyn.ai/api/oauth/token",
                    "{w:?}: endpoint {}",
                    c.endpoint()
                );
            }
            for w in [
                "https://your-company.caitlyn.ai/api",
                "https://your-company.caitlyn.ai/?x=1",
                "https://your-company.caitlyn.ai#top",
                "http://your-company.caitlyn.ai",
                "ftp://your-company.caitlyn.ai",
                "me@your-company.caitlyn.ai",
                "",
            ] {
                match Client::new(w, Auth::token(PAT)) {
                    Err(Error::Input(e))
                        if e.member == "workspace" && e.reason.contains("your-company.caitlyn.ai or https://your-company.caitlyn.ai") => {}
                    other => return Err(format!("{w:?}: {:?}", other.err())),
                }
            }
            Ok(())
        }),
        "endpoint.workspace" => Box::pin(async move {
            let c = Client::new(WORKSPACE, Auth::token(PAT)).map_err(s)?;
            ensure!(c.endpoint() == "https://your-company.caitlyn.ai/api", "endpoint {}", c.endpoint());
            Ok(())
        }),
        // ------------------------------------------------------------------ the client tree (PROTOCOL.md 10)
        // ------------------------------------------------------------------ scopes (PROTOCOL.md 10)
        "scope.sends-nothing" => Box::pin(async move {
            let c = client(m);
            let kb = c.knowledge_base(KB);
            let _ = kb.document("doc-0001").version("1");
            let _ = kb.folder("/hr/leave/").access();
            let _ = kb.ingestion().batch("b-1").item("i-1");
            let _ = c.agent(AGENT).draft().conversations();
            let _ = c.agent(AGENT).version("v13");
            let _ = c.conversation("c-1").message("m-1");
            let _ = c.core().operation(KB, "op-1");
            // A request built and never sent sends nothing either.
            let _ = kb.document("doc-0001").get();
            ensure!(m.requests().await.is_empty(), "requests {:?}", m.requests().await);
            Ok(())
        }),
        "scope.fills-identifiers" => Box::pin(async move {
            let c = client(m);
            let doc = c.knowledge_base(KB).document("doc-0002").get().await.map_err(s)?;
            ensure!(doc.id == "doc-0002", "document {doc:?}");
            let _ = c.knowledge_base(KB).folder("/hr/investigations/").delete().await;
            let paths: Vec<String> = m
                .api()
                .await
                .iter()
                .map(|r| format!("{} {}", str_at(r, "method"), str_at(r, "path")))
                .collect();
            ensure!(
                paths
                    == [
                        format!("GET /v3/knowledge-bases/{KB}/documents/doc-0002"),
                        format!("DELETE /v3/knowledge-bases/{KB}/folders/hr/investigations"),
                    ],
                "requests {paths:?}"
            );
            Ok(())
        }),
        "scope.named" => Box::pin(async move {
            let c = client(m);
            let agent = c.agent(AGENT);
            let live = agent.live().get().await.map_err(s)?;
            let draft = agent.draft().get().await.map_err(s)?;
            agent
                .draft()
                .update()
                .guidance(AgentGuidance {
                    instructions: Some("Answer from the HR policies.".into()),
                    ..Default::default()
                })
                .await
                .map_err(s)?;
            let paths: Vec<String> = m
                .api()
                .await
                .iter()
                .map(|r| format!("{} {}", str_at(r, "method"), str_at(r, "path")))
                .collect();
            ensure!(
                paths
                    == [
                        format!("GET /v3/agents/{AGENT}/versions/live"),
                        format!("GET /v3/agents/{AGENT}/versions/draft"),
                        format!("PATCH /v3/agents/{AGENT}/versions/draft"),
                    ],
                "requests {paths:?}, live {live:?}, draft {draft:?}"
            );
            // Rust checks the rest when it compiles: the live scope has no publish or delete, and the draft no delete.
            let src = std::fs::read_to_string(root().join("rust/caitlyn-sdk/src/scope.rs")).map_err(s)?;
            let block = |ty: &str| {
                let at = src.find(&format!("impl {ty} {{")).unwrap_or(0);
                let end = src[at..].find("\n}\n").map(|e| at + e).unwrap_or(src.len());
                src[at..end].to_owned()
            };
            let (live_src, draft_src) = (block("AgentLiveScope"), block("AgentDraftScope"));
            ensure!(
                !live_src.contains("pub fn publish(")
                    && !live_src.contains("pub fn delete(")
                    && live_src.contains("pub fn get(")
                    && !draft_src.contains("pub fn delete(")
                    && draft_src.contains("pub fn publish(")
                    && draft_src.contains("pub fn update("),
                "the named scopes' calls"
            );
            Ok(())
        }),
        "scope.from-scope" => Box::pin(async move {
            let c = client(m);
            let kb = c.knowledge_base(KB);
            kb.folder("/hr/").access().get().await.map_err(s)?;
            let doc_access = kb.document("doc-0001").access().get().await.map_err(s)?;
            kb.document("doc-0001")
                .access()
                .set()
                .readers("inherit")
                .if_match(&doc_access.etag)
                .await
                .map_err(s)?;
            kb.access().get().await.map_err(s)?;
            let reqs = m.api().await;
            let seen: Vec<String> = reqs
                .iter()
                .map(|r| format!("{} {} {}", str_at(r, "method"), str_at(r, "path"), str_at(r, "query")))
                .collect();
            let access = format!("/v3/knowledge-bases/{KB}/access");
            ensure!(
                seen == [
                    format!("GET {access} ?folder=%2Fhr%2F"),
                    format!("GET {access} ?document=doc-0001"),
                    format!("PUT {access} ?document=doc-0001"),
                    format!("GET {access} "),
                ],
                "requests {seen:?}"
            );
            Ok(())
        }),
        "scope.create-returns-scope" => Box::pin(async move {
            let c = client(m);
            let agent = c.agents().create("HR assistant").await.map_err(s)?;
            ensure!(
                agent.id() == agent.result().id && agent.result().name == "HR assistant",
                "agent {agent:?}"
            );
            let draft = agent.draft().get().await.map_err(s)?;
            ensure!(draft.agent_id == agent.result().id, "draft {draft:?}");
            let kb = c.knowledge_base(KB);
            let doc = kb.documents().create(pdf("leave.pdf", b"leave")).folder("/hr/").await.map_err(s)?;
            ensure!(
                doc.id() == doc.result().document.id && doc.knowledge_base_id() == KB && doc.result().document.folder == "/hr/",
                "document {doc:?}"
            );
            let folder = kb.folders().create("/hr/leave/").await.map_err(s)?;
            ensure!(
                folder.folder_path() == "/hr/leave/" && folder.knowledge_base_id() == KB,
                "folder {folder:?}"
            );
            let conversation = c.agent(AGENT).live().conversations().create().title("Leave").await.map_err(s)?;
            ensure!(conversation.id() == conversation.result().id, "conversation {conversation:?}");
            Ok(())
        }),
        "scope.core" => Box::pin(async move {
            let c = client(m);
            let up = c.core().uploads().reserve("a.pdf", "application/pdf", 1, "x").await.map_err(s)?;
            let got = c.core().upload(&up.id).get().await.map_err(s)?;
            ensure!(got.id == up.id, "upload {got:?}");
            let batch = c
                .knowledge_base(KB)
                .ingestion()
                .batches()
                .create()
                .start(StartMode::Manual)
                .await_more_items(true)
                .await
                .map_err(s)?;
            let item: IngestionItemInput =
                serde_json::from_value(json!({"action": "remove", "path": "/policies/policy-1.pdf"})).map_err(s)?;
            c.core()
                .ingestion()
                .add_items(KB, batch.id(), vec![item])
                .last(true)
                .await
                .map_err(s)?;
            let retried = c.knowledge_base(KB).document("doc-0002").retry().await.map_err(s)?;
            let op = c.core().operation(KB, &retried.operation.id).get().await.map_err(s)?;
            ensure!(op.id == retried.operation.id, "operation {op:?}");
            let paths: Vec<String> = m
                .api()
                .await
                .iter()
                .map(|r| format!("{} {}", str_at(r, "method"), str_at(r, "path")))
                .collect();
            let want = [
                "POST /v3/uploads".to_owned(),
                format!("GET /v3/uploads/{}", up.id),
                format!("POST /v3/knowledge-bases/{KB}/ingestion-batches"),
                format!("POST /v3/knowledge-bases/{KB}/ingestion-batches/{}/items:batch-create", batch.id()),
                format!("POST /v3/knowledge-bases/{KB}/documents/doc-0002/retry"),
                format!("GET /v3/knowledge-bases/{KB}/operations/{}", op.id),
            ];
            ensure!(paths == want, "requests {paths:?}");
            Ok(())
        }),
        "scope.estimate" => Box::pin(async move {
            let kb = client(m).knowledge_base(KB);
            let fill = kb.fields().estimate_fill_in(["policyOwner"]).await.map_err(s)?;
            let est = kb.documents().estimate_create(pdf("leave.pdf", b"twenty days")).await.map_err(s)?;
            let reqs = m.requests().await;
            let paths: Vec<String> = reqs
                .iter()
                .map(|r| format!("{} {}", str_at(r, "method"), str_at(r, "path")))
                .collect();
            ensure!(
                paths
                    == [
                        format!("POST /v3/knowledge-bases/{KB}/fields:estimate-fill-in"),
                        format!("POST /v3/knowledge-bases/{KB}/ingestions:estimate"),
                    ],
                "requests {paths:?}: an estimate uploads nothing"
            );
            let bodies: Vec<Value> = reqs
                .iter()
                .map(|r| serde_json::from_str(str_at(r, "body")).unwrap_or(Value::Null))
                .collect();
            ensure!(bodies[0] == json!({"keys": ["policyOwner"]}), "fill-in {}", bodies[0]);
            ensure!(
                bodies[1] == json!({"documents": [{"name": "leave.pdf", "contentType": "application/pdf", "byteSize": 11}]}),
                "estimate {}",
                bodies[1]
            );
            ensure!(fill.documents >= 0 && est.documents == 1, "estimates {fill:?} {est:?}");
            Ok(())
        }),
        "if-match.optional-set" => Box::pin(async move {
            // The set is read from the model: an operation with an If-Match header takes it optionally exactly when the
            // model marks it @ifMatchOptional. The generated request says which (its if_match_required, checked before
            // anything is sent, and "(required)" in its docs); a call without it on an optional operation sends none.
            let model: Value = serde_json::from_str(&std::fs::read_to_string(root().join("model/model.json")).map_err(s)?).map_err(s)?;
            let shapes = model["shapes"].as_object().ok_or("no shapes")?;
            let ops = std::fs::read_to_string(root().join("rust/caitlyn-sdk/src/operations.rs")).map_err(s)?;
            let mut wrong = Vec::new();
            let mut optional = Vec::new();
            for (id, shape) in shapes {
                if shape["type"] != "operation" {
                    continue;
                }
                let Some(input) = shape["input"]["target"].as_str().and_then(|t| shapes.get(t)) else {
                    continue;
                };
                let has_header = input["members"].as_object().into_iter().flatten().any(|(_, m)| {
                    m["traits"]["smithy.api#httpHeader"]
                        .as_str()
                        .is_some_and(|h| h.eq_ignore_ascii_case("if-match"))
                });
                if !has_header {
                    continue;
                }
                let name = id.rsplit('#').next().unwrap_or_default();
                let want_optional = shape["traits"].get("ai.caitlyn.traits#ifMatchOptional").is_some();
                let at = ops.find(&format!("name: \"{name}\",")).ok_or(format!("{name} not generated"))?;
                let window = &ops[at..ops.len().min(at + 600)];
                let required = window.contains("if_match_required: true");
                if required == want_optional {
                    wrong.push(format!("{name}: model optional {want_optional}, SDK required {required}"));
                }
                if want_optional {
                    optional.push(name.to_owned());
                }
            }
            ensure!(wrong.is_empty(), "If-Match: {wrong:?}");
            ensure!(optional.iter().any(|o| o == "StartIngestionBatch"), "optional set {optional:?}");
            // An optional one sent without it carries no If-Match; a required one without it fails before sending.
            let c = client(m);
            c.knowledge_base(KB)
                .folder("/hr/")
                .access()
                .set()
                .readers("inherit")
                .await
                .map_err(s)?;
            let put = m.matching(|r| str_at(r, "method") == "PUT").await.pop().unwrap_or_default();
            ensure!(header(&put, "if-match").is_none(), "PutAccess sent If-Match");
            let before = m.api().await.len();
            let r = c.knowledge_base(KB).update().name("Renamed").await;
            ensure!(
                r.is_err() && m.api().await.len() == before,
                "UpdateKnowledgeBase without if_match: {r:?}"
            );
            Ok(())
        }),
        "start.if-match-optional" => Box::pin(async move {
            // StartIngestionBatch with no If-Match sends none and reads nothing first; a given one is sent as it is;
            // a stale one is refused with 412.
            let kb = client(m).knowledge_base(KB);
            let remove = |p: &str| -> Result<IngestionItemInput, String> {
                serde_json::from_value(json!({"action": "remove", "path": p})).map_err(s)
            };
            let make = |p: &'static str| {
                let kb = kb.clone();
                async move {
                    let batch = kb
                        .ingestion()
                        .batches()
                        .create()
                        .start(StartMode::Manual)
                        .items(vec![remove(p)?])
                        .await
                        .map_err(s)?;
                    let planned = batch.planned().await.map_err(s)?;
                    Ok::<_, String>((batch, planned))
                }
            };
            let (plain, _) = make("/policies/policy-5.pdf").await?;
            let before = m.api().await.len();
            plain.start().await.map_err(s)?;
            let after = m.api().await;
            let sent = &after[before..];
            ensure!(
                sent.len() == 1 && str_at(&sent[0], "path").ends_with("/start") && header(&sent[0], "if-match").is_none(),
                "requests {sent:?}: one start, no read first, no If-Match"
            );
            let (given, planned) = make("/policies/policy-6.pdf").await?;
            given.start().if_match(&planned.etag).await.map_err(s)?;
            let last = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").ends_with("/start"))
                .await
                .pop()
                .unwrap_or_default();
            ensure!(header(&last, "if-match") == Some(planned.etag.as_str()), "start {last}");
            // A stale ETag: the batch's as the create gave it, before planning changed the batch.
            let (stale, planned) = make("/policies/policy-7.pdf").await?;
            let created_etag = stale.result().etag.clone();
            ensure!(created_etag != planned.etag, "planning left the ETag {created_etag}");
            let r = stale.start().if_match(&created_etag).await;
            ensure!(matches!(r, Err(Error::PreconditionFailed(_))), "stale: got {:?}", r.err());
            Ok(())
        }),
        "access.public" => Box::pin(async move {
            let kb = client(m).knowledge_base(KB);
            let folder = kb.folder("/policies/");
            folder.access().set().readers("public").await.map_err(s)?;
            let put = m.matching(|r| str_at(r, "method") == "PUT").await;
            let body: Value = serde_json::from_str(str_at(put.last().ok_or("no PUT")?, "body")).map_err(s)?;
            ensure!(body == json!({"readers": {"kind": "public"}}), "sent {body}");
            let read = folder.access().get().await.map_err(s)?;
            ensure!(
                matches!(read.readers.as_ref().map(|r| &r.kind), Some(ReadersKind::Public)),
                "read {:?}",
                read.readers
            );
            let doc = kb.document("doc-0001");
            doc.access().set().readers(Readers::public()).await.map_err(s)?;
            let read = doc.access().get().await.map_err(s)?;
            ensure!(
                read.readers.as_ref().map(|r| r.kind.as_str()) == Some("public"),
                "document readers {:?}",
                read.readers
            );
            Ok(())
        }),
        "access.set-no-if-match" => Box::pin(async move {
            let folder = client(m).knowledge_base(KB).folder("/hr/investigations/");
            folder.access().set().readers(Readers::roles(["hr-team"])).await.map_err(s)?;
            let reqs = m.api().await;
            ensure!(
                reqs.len() == 1 && str_at(&reqs[0], "method") == "PUT" && header(&reqs[0], "if-match").is_none(),
                "requests {reqs:?}: one PUT, no read first, no If-Match"
            );
            // A given If-Match is sent as it is, and a stale one is refused with 412.
            let current = folder.access().get().await.map_err(s)?;
            folder
                .access()
                .set()
                .readers(Readers::everyone())
                .if_match(&current.etag)
                .await
                .map_err(s)?;
            let put = m.matching(|r| str_at(r, "method") == "PUT").await.pop().unwrap_or_default();
            ensure!(header(&put, "if-match") == Some(current.etag.as_str()), "put {put}");
            let r = folder.access().set().readers("inherit").if_match(&current.etag).await;
            ensure!(matches!(r, Err(Error::PreconditionFailed(_))), "stale: got {:?}", r.err());
            Ok(())
        }),
        "access.readers-shorthand" => Box::pin(async move {
            let kb = client(m).knowledge_base(KB);
            let folder = kb.folder("/hr/investigations/");
            for readers in [
                Readers::from("inherit"),
                Readers::everyone(),
                Readers::public(),
                Readers::specific(["hr-team"], ["user-7"]),
            ] {
                let current = folder.access().get().await.map_err(s)?;
                folder.access().set().readers(readers).if_match(&current.etag).await.map_err(s)?;
            }
            let puts: Vec<Value> = m
                .matching(|r| str_at(r, "method") == "PUT")
                .await
                .iter()
                .map(|r| serde_json::from_str(str_at(r, "body")).unwrap_or(Value::Null))
                .collect();
            ensure!(
                puts == [
                    json!({"readers": {"kind": "inherit"}}),
                    json!({"readers": {"kind": "everyone"}}),
                    json!({"readers": {"kind": "public"}}),
                    json!({"readers": {"kind": "specific", "roles": ["hr-team"], "people": ["user-7"]}}),
                ],
                "bodies {puts:?}"
            );
            Ok(())
        }),

        // ------------------------------------------------------------------ watch and wait (PROTOCOL.md 16)
        "watch.event-types" => Box::pin(async move {
            // Snapshot entries and change events are the model's types: the bindings below are chrono date-times, so
            // a string would not compile. A folder's wait() and its ListFolders row are equal Folders.
            type When = chrono::DateTime<chrono::Utc>;
            let c = client(m);
            let kb = c.knowledge_base(KB);
            let mut watch = kb.folder("/hr/").watch().await.map_err(s)?;
            let first = watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            drop(watch);
            let KnowledgeBaseEvent::Snapshot(snap) = first else {
                return Err(format!("first event {first:?}"));
            };
            let entry = snap.folder.ok_or("no folder in the snapshot")?;
            let _: When = entry.updated_at;
            m.faults(json!({"busyWithoutJob": {"doc-0004": 1}})).await;
            let mut watch = kb.document("doc-0004").watch().await.map_err(s)?;
            let events = take(&mut watch, |e| matches!(e, KnowledgeBaseEvent::DocumentUpdated(_)))
                .await
                .map_err(s)?;
            drop(watch);
            let KnowledgeBaseEvent::Snapshot(snap) = &events[0] else {
                return Err(format!("first event {:?}", events[0]));
            };
            let doc = snap.document.as_ref().ok_or("no document in the snapshot")?;
            let (_, _): (When, When) = (doc.created_at, doc.updated_at);
            let Some(KnowledgeBaseEvent::DocumentUpdated(changed)) = events.last() else {
                return Err(format!("no document.updated: {events:?}"));
            };
            let (_, _): (When, When) = (changed.document.created_at, changed.document.updated_at);
            ensure!(changed.document.updated_at >= doc.updated_at, "updated {changed:?} after {doc:?}");
            let waited: Folder = kb.folder("/hr/").wait().await.map_err(s)?;
            let listed = kb.folders().list().collect().await.map_err(s)?;
            let row = listed.into_iter().find(|f| f.path == "/hr/").ok_or("/hr/ not listed")?;
            ensure!(waited == row, "wait() {waited:?} but ListFolders {row:?}");
            Ok(())
        }),
        "watch.break-closes" => Box::pin(async move {
            // Dropping a watch after its first event closes its connection at once, with no request after it.
            let c = client(m);
            let mut watch = c.knowledge_base(KB).document("doc-0001").watch().await.map_err(s)?;
            watch.next().await.ok_or("no first event")?.map_err(s)?;
            let before = m.requests().await.len();
            drop(watch);
            let t0 = Instant::now();
            loop {
                if !m.matching(|r| str_at(r, "event") == "client-disconnected").await.is_empty() {
                    break;
                }
                ensure!(t0.elapsed() < Duration::from_secs(1), "no disconnect within a second");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let after: Vec<Value> = m.requests().await.into_iter().skip(before).collect();
            ensure!(
                after.iter().all(|r| r.get("method").is_none()),
                "requests after the drop: {after:?}"
            );
            Ok(())
        }),
        "send.break-then-final" => Box::pin(async move {
            // Stopping after the first event (or the first piece of text) leaves the stream open: final_message()
            // reads the rest, gives the completed message and the server finishes the response (no disconnect).
            // Dropping a stream after the first event closes it: the mock sees the disconnect within a second.
            m.faults(json!({"streamDelayMs": 30})).await;
            let c = client(m);
            let disconnects = || m.matching(|r| str_at(r, "event") == "client-disconnected");
            let mut events = send(&c, "c-4").await.map_err(s)?;
            events.next().await.ok_or("no first event")?.map_err(s)?;
            let message = events.final_message().await.map_err(s)?;
            ensure!(!message.id.is_empty() && !message.text.is_empty(), "final {message:?}");
            ensure!(events.next().await.is_none(), "the stream had more after its final message");
            drop(events);
            let mut text = send(&c, "c-4").await.map_err(s)?.text();
            let piece = text.next().await.ok_or("no first text")?.map_err(s)?;
            let message = text.final_message().await.map_err(s)?;
            ensure!(message.text.starts_with(&piece), "final {message:?} after {piece:?}");
            drop(text);
            ensure!(disconnects().await.is_empty(), "a drained stream was cut off");
            // The mock holds the stream after the first event until the client leaves, so the drop, not the answer's
            // end, is what closes it.
            m.faults(json!({"holdAfterEvents": 1})).await;
            let mut left = send(&c, "c-4").await.map_err(s)?;
            left.next().await.ok_or("no first event")?.map_err(s)?;
            let before = m.requests().await.len();
            drop(left);
            let t0 = Instant::now();
            while disconnects().await.is_empty() {
                ensure!(t0.elapsed() < Duration::from_secs(5), "no disconnect within 5 s of the drop");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let log = m.requests().await;
            let holding = log.iter().position(|r| str_at(r, "event") == "server-holding-stream");
            let left_at = log.iter().position(|r| str_at(r, "event") == "client-disconnected");
            ensure!(
                holding.is_some_and(|h| left_at.is_some_and(|l| h < l)) && !log.iter().any(|r| str_at(r, "event") == "server-ended-stream"),
                "the server was not still holding the stream: {:?}",
                log.iter().filter(|r| r.get("event").is_some()).collect::<Vec<_>>()
            );
            let after: Vec<Value> = log.into_iter().skip(before).collect();
            ensure!(
                after.iter().all(|r| r.get("method").is_none()),
                "requests after the drop: {after:?}"
            );
            Ok(())
        }),
        "watch.snapshot-first" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0004": true}})).await;
            let mut watch = client(m).knowledge_base(KB).document("doc-0004").watch().await.map_err(s)?;
            let events = take(&mut watch, |e| e.event_type() == "job.finished").await.map_err(s)?;
            let types: Vec<_> = events.iter().map(|e| e.event_type()).collect();
            let KnowledgeBaseEvent::Snapshot(snap) = &events[0] else {
                return Err(format!("first event {types:?}"));
            };
            ensure!(
                snap.document.as_ref().is_some_and(|d| d.id == "doc-0004") && types[1..].contains(&"job.progress"),
                "events {types:?}"
            );
            let req = m
                .matching(|r| str_at(r, "path") == format!("/v3/knowledge-bases/{KB}/events"))
                .await;
            ensure!(req.len() == 1 && str_at(&req[0], "query") == "?document=doc-0004", "watch {req:?}");
            Ok(())
        }),
        "watch.reconnect-snapshot" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0004": true}, "watchDrops": {"count": 1, "afterEvents": 2}}))
                .await;
            let mut watch = client(m).knowledge_base(KB).document("doc-0004").watch().await.map_err(s)?;
            let events = take(&mut watch, |e| e.event_type() == "job.finished").await.map_err(s)?;
            let types: Vec<_> = events.iter().map(|e| e.event_type()).collect();
            ensure!(
                types[0] == "snapshot" && types[2] == "snapshot",
                "events {types:?}: a new snapshot first after the drop"
            );
            let reqs = m
                .matching(|r| str_at(r, "path") == format!("/v3/knowledge-bases/{KB}/events"))
                .await;
            ensure!(
                reqs.len() == 2
                    && reqs
                        .iter()
                        .all(|r| header(r, "last-event-id").is_none() && str_at(r, "query") == "?document=doc-0004"),
                "connections {reqs:?}: a reconnect sends no cursor"
            );
            Ok(())
        }),
        "wait.done" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0004": true}})).await;
            let doc = client(m).knowledge_base(KB).document("doc-0004").wait().await.map_err(s)?;
            ensure!(doc.id == "doc-0004" && doc.status.as_str() == "indexed", "document {doc:?}");
            let last = m.api().await.pop().unwrap_or_default();
            ensure!(
                str_at(&last, "method") == "GET" && str_at(&last, "path") == format!("/v3/knowledge-bases/{KB}/documents/doc-0004"),
                "the thing as its get returns it: last request {last}"
            );
            // A folder has no get: its wait returns its summary from the watch's snapshot.
            let folder = client(m).knowledge_base(KB).folder("/hr/").wait().await.map_err(s)?;
            ensure!(folder.path == "/hr/", "folder {folder:?}");
            Ok(())
        }),
        "wait.partial" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0004": true}, "jobOutcomes": {"doc-0004": "completed_with_failures"}}))
                .await;
            let doc = client(m).knowledge_base(KB).document("doc-0004").wait().await.map_err(s)?;
            ensure!(
                doc.status.as_str() == "partially_indexed" && doc.partial_failures.as_ref().is_some_and(|p| !p.is_empty()),
                "document {doc:?}"
            );
            Ok(())
        }),
        "wait.failed" => Box::pin(async move {
            m.faults(json!({
                "busyDocuments": {"doc-0004": true, "doc-0005": true},
                "jobOutcomes": {"doc-0004": "failed", "doc-0005": "cancelled"},
            }))
            .await;
            let kb = client(m).knowledge_base(KB);
            let r = kb.document("doc-0004").wait().await;
            ensure!(
                matches!(&r, Err(Error::UnprocessableContent(e)) if e.code == "CONTENT_REJECTED" && e.status == 422),
                "failed: got {:?}",
                r.err()
            );
            let r = kb.document("doc-0005").wait().await;
            ensure!(
                r.as_ref().err().and_then(Error::code) == Some("CANCELLED") && r.as_ref().err().and_then(Error::status) == Some(0),
                "cancelled: got {:?}",
                r.err()
            );
            Ok(())
        }),
        "wait.gone" => Box::pin(async move {
            let kb = client(m).knowledge_base(KB);
            let deleted = kb.document("doc-0006").delete().await.map_err(s)?;
            let () = deleted.wait().await.map_err(s)?;
            let r = kb.document("doc-9999").wait().await;
            ensure!(matches!(&r, Err(Error::NotFound(_))), "a missing document: got {:?}", r.err());
            Ok(())
        }),
        "wait.started-work" => Box::pin(async move {
            let kb = client(m).knowledge_base(KB);
            // The request's own wait(): send, then follow the work it started.
            let doc = kb
                .documents()
                .create(pdf("leave.pdf", b"leave"))
                .folder("/hr/")
                .wait()
                .await
                .map_err(s)?;
            ensure!(doc.status.as_str() == "indexed" && doc.folder == "/hr/", "document {doc:?}");
            // Or send(), then the handle: its result() is the call's response, and it has wait() and watch().
            let started = kb.fields().fill_in(["policyOwner"]).send().await.map_err(s)?;
            let job = started.result().job.id.clone();
            let mut watch = started.watch().await.map_err(s)?;
            let first = watch.next().await.ok_or("no event")?.map_err(s)?;
            ensure!(matches!(first, KnowledgeBaseEvent::Snapshot(_)), "first event {first:?}");
            drop(watch);
            let after = started.wait().await.map_err(s)?;
            ensure!(after.id == KB && !job.is_empty(), "knowledge base {after:?}");
            // And the request's watch(): send, then watch the new thing.
            let mut watch = kb.documents().create(pdf("pay.pdf", b"pay")).watch().await.map_err(s)?;
            let first = watch.next().await.ok_or("no event")?.map_err(s)?;
            ensure!(matches!(first, KnowledgeBaseEvent::Snapshot(_)), "first event {first:?}");
            Ok(())
        }),
        "wait.delete-processing" => Box::pin(async move {
            // A document deleted while it is still being processed: the delete is accepted, its job ends cancelled as
            // part of the delete, and the wait ends on the gone rule with no CANCELLED.
            let kb = client(m).knowledge_base(KB);
            let doc = kb.documents().create(pdf("leave.pdf", b"leave")).folder("/hr/").await.map_err(s)?;
            doc.delete().wait().await.map_err(s)?;
            let r = doc.get().await;
            ensure!(matches!(r, Err(Error::NotFound(_))), "after the delete: {:?}", r.map(|d| d.status));
            let listed = kb.documents().list().folder("/hr/").collect().await.map_err(s)?;
            ensure!(!listed.iter().any(|d| d.id == doc.id()), "the document came back");
            Ok(())
        }),
        "wait.busy-status" => Box::pin(async move {
            // A knowledge base being created has no job: its status alone says it is busy.
            let kb = client(m).knowledge_bases().create("Contracts").await.map_err(s)?;
            ensure!(kb.result().status.as_str() == "creating", "created {:?}", kb.result().status);
            let ready = kb.wait().await.map_err(s)?;
            ensure!(ready.status.as_str() == "ready", "waited {:?}", ready.status);
            // A document that reads processing with no job listed on it is busy too.
            m.faults(json!({"busyWithoutJob": {"doc-0004": 3}})).await;
            let doc = client(m).knowledge_base(KB).document("doc-0004").wait().await.map_err(s)?;
            ensure!(doc.status.as_str() == "indexed", "document {:?}", doc.status);
            Ok(())
        }),
        "wait.timeout" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0004": true}, "jobSteps": 100000})).await;
            let r = client(m)
                .knowledge_base(KB)
                .document("doc-0004")
                .wait()
                .timeout(Duration::from_millis(300))
                .await;
            let e = r.err().ok_or("the wait ended")?;
            ensure!(
                matches!(e, Error::Timeout) && e.code() == Some("WAIT_TIMEOUT") && e.status() == Some(0),
                "got {e:?}"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
            let closed = m
                .matching(|r| str_at(r, "event") == "client-disconnected" && str_at(r, "subject") == format!("kb:{KB}"))
                .await;
            ensure!(!closed.is_empty(), "the watch was not closed");
            Ok(())
        }),
        "scope.download" => Box::pin(async move {
            // A server of this case's own, which also answers the content's 302 (the mock has no download route yet).
            let address = "https://downloads.example.com/doc-1?signature=abc";
            let body = json!({"url": address, "expiresAt": "2026-11-16T01:17:03.000Z"}).to_string();
            let fake = Fake::start(vec![(200, "application/json", body.clone()), (302, "application/json", body)]).await;
            let c = fake.client();
            let download = c.knowledge_base(KB).document("doc-1").download().await.map_err(s)?;
            ensure!(download.url == address, "download {download:?}");
            // GetDocumentContent, the 302, is the building block core.documents.content; it is not followed either.
            let content = c.core().documents().content(KB, "doc-1").await.map_err(s)?;
            ensure!(content.url == address, "content {content:?}");
            let reqs = fake.requests();
            ensure!(
                reqs == [
                    format!("GET /api/v3/knowledge-bases/{KB}/documents/doc-1/download HTTP/1.1"),
                    format!("GET /api/v3/knowledge-bases/{KB}/documents/doc-1/content HTTP/1.1"),
                ] || reqs
                    == [
                        format!("GET /v3/knowledge-bases/{KB}/documents/doc-1/download HTTP/1.1"),
                        format!("GET /v3/knowledge-bases/{KB}/documents/doc-1/content HTTP/1.1"),
                    ],
                "requests {reqs:?}: nothing goes to the address"
            );
            Ok(())
        }),
        "core.content-redirect" => Box::pin(async move {
            // A server of this case's own: a 302 whose Location points back at that server, so a client that followed
            // it would be seen asking for the address.
            let fake = Fake::start_for(|base| {
                let address = format!("{base}/bytes/doc-1?signature=abc");
                let body = json!({"url": address, "expiresAt": "2026-11-16T01:17:03.000Z"}).to_string();
                vec![
                    (302, format!("application/json\r\nLocation: {address}"), body),
                    (200, "application/octet-stream".to_owned(), "the bytes".to_owned()),
                ]
            })
            .await;
            let address = format!("{}/bytes/doc-1?signature=abc", fake.base);
            let content = fake.client().core().documents().content(KB, "doc-1").await.map_err(s)?;
            ensure!(content.location == address && content.url == address, "content {content:?}");
            let reqs = fake.requests();
            ensure!(
                reqs.len() == 1 && reqs[0].contains("/documents/doc-1/content"),
                "requests {reqs:?}: the address must not be requested"
            );
            Ok(())
        }),
        "wait.progress" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0004": true}, "jobSteps": 3})).await;
            let seen = Arc::new(Mutex::new(Vec::<Processing>::new()));
            let log = seen.clone();
            let doc = client(m)
                .knowledge_base(KB)
                .document("doc-0004")
                .wait()
                .on_progress(move |p| log.lock().unwrap().push(p.clone()))
                .await
                .map_err(s)?;
            ensure!(doc.status.as_str() == "indexed", "document {:?}", doc.status);
            let calls = seen.lock().unwrap().clone();
            let percents: Vec<i32> = calls.iter().filter_map(Processing::percent).collect();
            ensure!(
                calls.len() >= 2 && calls.iter().all(|p| matches!(p, Processing::Document(_))) && percents.windows(2).all(|w| w[0] <= w[1]),
                "progress {calls:?}"
            );
            // The snapshot's processing came first: the job was running when the watch connected.
            ensure!(calls[0].stage().is_some(), "first {:?}", calls[0]);
            let n = calls.len();
            tokio::task::yield_now().await;
            ensure!(seen.lock().unwrap().len() == n, "called after the wait returned");
            Ok(())
        }),
        "watch.processing" => Box::pin(async move {
            m.faults(json!({"busyDocuments": {"doc-0004": true}})).await;
            let c = client(m);
            let mut watch = c.knowledge_base(KB).document("doc-0004").watch().await.map_err(s)?;
            let events = take(&mut watch, |e| e.event_type() == "job.finished").await.map_err(s)?;
            let snap = events.first().and_then(KnowledgeBaseEvent::processing);
            ensure!(matches!(snap, Some(Processing::Document(_))), "snapshot {snap:?}");
            let progress: Vec<_> = events.iter().filter(|e| e.event_type() == "document.progress").collect();
            ensure!(
                !progress.is_empty() && progress.iter().all(|e| matches!(e.processing(), Some(Processing::Document(_)))),
                "document.progress {progress:?}"
            );
            ensure!(events.iter().any(|e| e.processing().is_none()), "an event carrying none gives none");
            // The knowledge base's own watch: the accessor takes the document's identifier.
            // Enough steps that the job is still running when the knowledge base's watch connects, however slowly it reads
            m.faults(json!({"busyDocuments": {"doc-0005": true}, "jobSteps": 50})).await;
            let mut doc_watch = c.knowledge_base(KB).document("doc-0005").watch().await.map_err(s)?;
            let mut kb_watch = c.knowledge_base(KB).watch().await.map_err(s)?;
            let kb_events = take(&mut kb_watch, |e| e.event_type() == "document.progress").await.map_err(s)?;
            drop(doc_watch.next().await);
            let last = kb_events.last().ok_or("no events")?;
            ensure!(
                matches!(last.processing_of("doc-0005"), Some(Processing::Document(_))) && last.processing_of("doc-0001").is_none(),
                "processing_of {last:?}"
            );
            Ok(())
        }),
        "send.attachments" => Box::pin(async move {
            let c = client(m);
            let conversation = c.conversation("c-att");
            // An upload made beforehand, reserved for this conversation, passes straight through.
            let purpose = UploadPurpose {
                conversation_id: Some("c-att".into()),
                ..Default::default()
            };
            let made = c
                .core()
                .uploads()
                .send_for(pdf("made.pdf", b"made before"), purpose)
                .await
                .map_err(s)?;
            let before = m.requests().await.len();
            let files = || {
                [
                    Attachment::file(pdf("leave.pdf", b"a leave form")),
                    Attachment::upload_id(&made.id),
                    Attachment::file(pdf("pay.pdf", b"a pay slip")),
                ]
            };
            let answer = conversation
                .send("Does this leave form match our policy?")
                .attachments(files())
                .await
                .map_err(s)?;
            let text = answer.text().collect().await.map_err(s)?;
            ensure!(text == ANSWER, "text {text:?}");
            let reqs = m.requests().await[before..].to_vec();
            let body = |r: &Value| serde_json::from_str::<Value>(str_at(r, "body")).unwrap_or(Value::Null);
            let reserves: Vec<Value> = reqs.iter().filter(|r| str_at(r, "path") == "/v3/uploads").map(body).collect();
            ensure!(
                reserves.len() == 2
                    && reserves.iter().all(|r| r["purpose"] == json!({"conversationId": "c-att"}))
                    && reserves[0]["fileName"] == "leave.pdf"
                    && reserves[1]["fileName"] == "pay.pdf",
                "reserves {reserves:?}"
            );
            let sends: Vec<Value> = reqs
                .iter()
                .filter(|r| str_at(r, "path") == "/v3/conversations/c-att/messages")
                .map(body)
                .collect();
            let ids: Vec<&str> = sends
                .first()
                .and_then(|b| b["attachments"].as_array())
                .into_iter()
                .flatten()
                .map(|a| str_at(a, "uploadId"))
                .collect();
            ensure!(
                sends.len() == 1 && ids.len() == 3 && ids[1] == made.id && ids[0] != ids[2] && !ids.contains(&""),
                "message {sends:?}: every upload, in the order given"
            );
            // The SendMessage came after every upload's bytes.
            let last_put = reqs.iter().rposition(|r| str_at(r, "method") == "PUT").ok_or("no upload")?;
            let message = reqs
                .iter()
                .position(|r| str_at(r, "path") == "/v3/conversations/c-att/messages")
                .ok_or("no message")?;
            ensure!(last_put < message, "the message went before the uploads");
            // Each upload is used up: sending the same files again uploads them again.
            let before = m.requests().await.len();
            let again = [Attachment::file(pdf("leave.pdf", b"a leave form"))];
            conversation
                .send("And this one?")
                .attachments(again)
                .await
                .map_err(s)?
                .final_message()
                .await
                .map_err(s)?;
            let reserved = m.requests().await[before..]
                .iter()
                .filter(|r| str_at(r, "path") == "/v3/uploads")
                .count();
            ensure!(reserved == 1, "{reserved} uploads on the second send");
            // A file whose bytes cannot be sent: no message, and that file's error.
            m.faults(status("PutUpload", &[(503, 0), (503, 0), (503, 0), (503, 0), (503, 0)]))
                .await;
            let before = m.requests().await.len();
            let r = conversation
                .send("And this?")
                .attachments([Attachment::file(pdf("bad.pdf", b"never arrives"))])
                .await;
            ensure!(
                r.as_ref().err().and_then(Error::code) == Some("UPLOAD_PUT_FAILED"),
                "got {:?}",
                r.err()
            );
            let sent = m.requests().await[before..]
                .iter()
                .filter(|r| str_at(r, "path").ends_with("/messages"))
                .count();
            ensure!(sent == 0, "a message was sent after a failed upload");
            Ok(())
        }),
        "send.text" => Box::pin(async move {
            let stream = client(m).conversation("c-text").send("hi").await.map_err(s)?;
            let text = stream.text().collect().await.map_err(s)?;
            ensure!(text == ANSWER, "text {text:?}");
            Ok(())
        }),
        "wait.deadline-reread" => Box::pin(async move {
            // The mock's deadlinePassed: only GetIngestionBatch ends a batch past its deadline, and its watch never
            // shows the end. 'uploads': started, nothing uploaded, uploadsExpireAt a minute gone.
            let batch_reads = |reqs: Vec<Value>| {
                reqs.iter()
                    .filter(|r| str_at(r, "method") == "GET" && str_at(r, "path").rsplit('/').nth(1) == Some("ingestion-batches"))
                    .count()
            };
            m.faults(json!({"deadlinePassed": "uploads"})).await;
            let c = client(m);
            let data = b"%PDF-1.7 annual leave";
            let batch = hand_batch(&c, vec![ingest_item("/hr/annual-leave.pdf", data)], true).await?;
            let done: IngestionBatch = batch.wait().timeout(Duration::from_secs(10)).await.map_err(s)?;
            ensure!(done.status.as_str() == "completed_with_failures", "wait: {done:?}");
            let items = batch.items().list().collect().await.map_err(s)?;
            ensure!(
                items.len() == 1 && items[0].status.as_str() == "failed" && items[0].failure_code.as_deref() == Some("UPLOAD_EXPIRED"),
                "items {items:?}"
            );
            // watch() yields the read as a snapshot: a fresh batch, so that only the SDK's read can show it ended.
            m.reset().await;
            m.faults(json!({"deadlinePassed": "uploads"})).await;
            let c = client(m);
            let watched = hand_batch(&c, vec![ingest_item("/hr/annual-leave.pdf", data)], true).await?;
            let before = batch_reads(m.api().await);
            let mut watch = watched.watch().await.map_err(s)?;
            let ended = tokio::time::timeout(Duration::from_secs(10), async {
                while let Some(ev) = watch.next().await {
                    if let KnowledgeBaseEvent::Snapshot(snap) = ev.map_err(s)? {
                        if let Some(b) = snap.batch.filter(|b| b.status.as_str() == "completed_with_failures") {
                            return Ok::<_, String>(Some(b));
                        }
                    }
                }
                Ok(None)
            })
            .await
            .map_err(|_| "the watch never showed the batch ended".to_owned())??;
            drop(watch);
            ensure!(ended.is_some_and(|b| b.id == watched.id()), "no snapshot of the batch ended");
            ensure!(batch_reads(m.api().await) > before, "no GetIngestionBatch was sent");
            // A sync whose batch is past its upload deadline, with its one upload failing (so it is never made),
            // finishes: the read ends the batch. The report keeps the SDK's own UPLOAD_FAILED for the item; the
            // server's is UPLOAD_EXPIRED.
            m.reset().await;
            m.faults(json!({"deadlinePassed": "uploads", "failUploads": {"/new/a.pdf": true}}))
                .await;
            let c = client(m);
            let input = SyncInput::items(vec![SyncItem::file("/new/a.pdf", pdf("a.pdf", data))]);
            let report = tokio::time::timeout(Duration::from_secs(30), c.knowledge_base(KB).ingestion().sync(input))
                .await
                .map_err(|_| "the sync never finished".to_owned())?
                .map_err(s)?;
            ensure!(
                report.batch.status.as_str() == "completed_with_failures",
                "sync: {:?}",
                report.batch
            );
            ensure!(
                report.items.len() == 1
                    && report.items[0].status.as_str() == "failed"
                    && report.items[0].failure_code.as_deref() == Some("UPLOAD_FAILED"),
                "report items {:?}",
                report.items
            );
            let listed = c
                .knowledge_base(KB)
                .ingestion()
                .batch(report.batch.id.clone())
                .items()
                .list()
                .collect()
                .await
                .map_err(s)?;
            ensure!(
                listed.len() == 1 && listed[0].failure_code.as_deref() == Some("UPLOAD_EXPIRED"),
                "listed items {listed:?}"
            );
            // Each deadline is read once: a server of this case's own whose batch is past its deadline, and whose read
            // returns the same deadline. Its watch ends after each snapshot and reconnects with the same one, which is
            // not read again.
            let due = (chrono::Utc::now() - chrono::Duration::seconds(31)).to_rfc3339();
            let mut running = batch_json("running");
            running["uploadsExpireAt"] = json!(due);
            let sse = format!(
                "id: s-1\nevent: snapshot\ndata: {}\n\n",
                json!({"batch": running, "jobs": [], "progress": []})
            );
            let got = (200, "application/json", running.to_string());
            let stream = |b: &String| (200, "text/event-stream", b.clone());
            let fake = Fake::start(vec![stream(&sse), got, stream(&sse), stream(&sse)]).await;
            let mut watch = fake
                .client()
                .knowledge_base(KB)
                .ingestion()
                .batch("batch-1")
                .watch()
                .await
                .map_err(s)?;
            let mut snapshots = 0;
            let _ = tokio::time::timeout(Duration::from_millis(1500), async {
                while let Some(Ok(ev)) = watch.next().await {
                    if matches!(ev, KnowledgeBaseEvent::Snapshot(_)) {
                        snapshots += 1;
                    }
                }
            })
            .await;
            drop(watch);
            let reads = fake
                .requests()
                .iter()
                .filter(|l| l.starts_with("GET ") && l.contains("/ingestion-batches/batch-1 "))
                .count();
            ensure!(
                reads == 1 && snapshots >= 2,
                "one deadline: {reads} reads and {snapshots} snapshots, from {:?}",
                fake.requests()
            );
            Ok(())
        }),
        "watch.gone" => Box::pin(async move {
            // A server of this case's own: a snapshot, a clean end, then 404 on the reconnect.
            let snapshot = json!({"document": document_json("processing"), "jobs": [], "progress": []});
            let sse = format!("id: s-1\nevent: snapshot\ndata: {snapshot}\n\n");
            let gone = || (404, "application/problem+json", PROBLEM_404.to_owned());
            let fake = Fake::start(vec![(200, "text/event-stream", sse.clone()), gone()]).await;
            let doc = fake.client().knowledge_base(KB).document("doc-1");
            let mut watch = doc.watch().await.map_err(s)?;
            let first = watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            ensure!(matches!(first, KnowledgeBaseEvent::Snapshot(_)), "first {first:?}");
            let end = watch.next().await.ok_or("the watch ended without the 404")?;
            ensure!(matches!(end, Err(Error::NotFound(_))), "got {end:?}");
            ensure!(watch.next().await.is_none(), "the watch carried on");
            ensure!(fake.requests().len() == 2, "requests {:?}: one reconnect, no more", fake.requests());
            // wait() ends by the gone rule: the 404, or success after a delete.
            let fake = Fake::start(vec![(200, "text/event-stream", sse.clone()), gone()]).await;
            let r = fake.client().knowledge_base(KB).document("doc-1").wait().await;
            ensure!(matches!(r, Err(Error::NotFound(_))), "wait: got {:?}", r.err());
            let deleting = document_json("deleting").to_string();
            let fake = Fake::start(vec![(202, "application/json", deleting), (200, "text/event-stream", sse), gone()]).await;
            fake.client()
                .knowledge_base(KB)
                .document("doc-1")
                .delete()
                .wait()
                .await
                .map_err(s)?;
            ensure!(fake.requests().len() == 3, "requests {:?}", fake.requests());
            Ok(())
        }),
        "wait.snapshot-entry" => Box::pin(async move {
            // A batch, a document and a folder already done: each wait finds its thing in the first snapshot (under
            // batch, document and folder), ends there with no further event, and gives the thing's own type.
            let c = client(m);
            let kb = c.knowledge_base(KB);
            let item: IngestionItemInput =
                serde_json::from_value(json!({"action": "remove", "path": "/policies/policy-7.pdf"})).map_err(s)?;
            let batch = kb
                .ingestion()
                .batches()
                .create()
                .start(StartMode::Manual)
                .items(vec![item])
                .await
                .map_err(s)?;
            let planned = batch.planned().await.map_err(s)?;
            batch.start().if_match(&planned.etag).send().await.map_err(s)?;
            let _: IngestionBatch = batch.wait().await.map_err(s)?;
            let events_path = format!("/v3/knowledge-bases/{KB}/events");
            let before = m.matching(|r| str_at(r, "path") == events_path).await.len();
            let ended: IngestionBatch = batch.wait().await.map_err(s)?;
            ensure!(
                ended.id == batch.id() && !matches!(ended.status.as_str(), "planned" | "planning" | "running"),
                "batch {ended:?}"
            );
            let doc: Document = kb.document("doc-0001").wait().await.map_err(s)?;
            ensure!(doc.id == "doc-0001", "document {doc:?}");
            let folder: Folder = kb.folder("/hr/").wait().await.map_err(s)?;
            ensure!(folder.path == "/hr/", "folder {folder:?}");
            let opened = m.matching(|r| str_at(r, "path") == events_path).await.len() - before;
            ensure!(opened == 3, "{opened} watches for three waits");
            let queries: Vec<String> = m
                .matching(|r| str_at(r, "path") == events_path)
                .await
                .iter()
                .rev()
                .take(3)
                .map(|r| str_at(r, "query").to_owned())
                .collect();
            ensure!(
                queries.iter().any(|q| q.starts_with("?batch="))
                    && queries.iter().any(|q| q == "?document=doc-0001")
                    && queries.iter().any(|q| q.starts_with("?folder=")),
                "watches {queries:?}"
            );
            Ok(())
        }),
        "wait.cancel-returns" => Box::pin(async move {
            // A cancel's own wait returns the thing, not CANCELLED; every other wait on it still raises CANCELLED.
            let c = client(m);
            let batch = hand_batch(&c, vec![ingest_item("/new/x.pdf", b"x")], false).await?;
            let cancelled: IngestionBatch = batch.cancel().wait().await.map_err(s)?;
            ensure!(
                cancelled.id == batch.id() && cancelled.status.as_str() == "cancelled",
                "cancel().wait() {cancelled:?}"
            );
            let e = batch.wait().await.err().ok_or("batch.wait() on a cancelled batch returned")?;
            ensure!(e.code() == Some("CANCELLED") && e.status() == Some(0), "batch.wait(): {e:?}");
            // doc.cancel_processing().wait() returns the document as it then stands: its processing (started by a
            // first watch, busyDocuments) is stopped by the call (cancellableProcessing), and the job it cancelled
            // raises nothing.
            m.reset().await;
            m.faults(json!({"busyDocuments": {"doc-0001": true}, "holdJobs": {"doc-0001": true}, "cancellableProcessing": true}))
                .await;
            let doc = client(m).knowledge_base(KB).document("doc-0001");
            let mut watch = doc.watch().await.map_err(s)?;
            watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            drop(watch);
            let stopped: Document = doc.cancel_processing().wait().await.map_err(s)?;
            ensure!(
                stopped.id == "doc-0001" && stopped.processing.is_none(),
                "cancel_processing().wait() {stopped:?}"
            );
            // Any other wait on a job that ends cancelled still raises CANCELLED.
            m.reset().await;
            m.faults(json!({"busyDocuments": {"doc-0001": true}, "jobOutcomes": {"doc-0001": "cancelled"}}))
                .await;
            let e = doc.wait().await.err().ok_or("doc.wait() after a cancelled job returned")?;
            ensure!(e.code() == Some("CANCELLED"), "doc.wait(): {e:?}");
            Ok(())
        }),
        "wait.planned" => Box::pin(async move {
            let kb = client(m).knowledge_base(KB);
            let item: IngestionItemInput =
                serde_json::from_value(json!({"action": "remove", "path": "/policies/policy-1.pdf"})).map_err(s)?;
            let batch = kb
                .ingestion()
                .batches()
                .create()
                .start(StartMode::Manual)
                .items(vec![item])
                .await
                .map_err(s)?;
            let planned = batch.planned().await.map_err(s)?;
            ensure!(
                planned.status.as_str() == "planned" && planned.id == batch.id(),
                "batch {planned:?}"
            );
            // A batch's watch finds the batch in its snapshot under `batch`, its filter's name.
            let mut watch = batch.watch().send().await.map_err(s)?;
            let first = watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            let KnowledgeBaseEvent::Snapshot(snap) = first else {
                return Err(format!("first event {first:?}"));
            };
            ensure!(snap.batch.as_ref().is_some_and(|b| b.id == batch.id()), "snapshot {snap:?}");
            drop(watch);
            // And its wait follows it there to the end.
            batch.start().if_match(&planned.etag).send().await.map_err(s)?;
            let ended = batch.wait().await.map_err(s)?;
            ensure!(
                ended.id == batch.id() && !matches!(ended.status.as_str(), "planned" | "running" | "planning"),
                "waited {ended:?}"
            );
            Ok(())
        }),
        "send.eager" => Box::pin(async move {
            // A Rust request is sent when it is awaited, as every future is; the stream it returns need not be read.
            let c = client(m);
            let stream = c.conversation("c-e").send("hi").await.map_err(s)?;
            drop(stream);
            let posts = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == "/v3/conversations/c-e/messages")
                .await;
            ensure!(posts.len() == 1, "{} messages sent", posts.len());
            let mut watch = c.conversation("c-e").watch().await.map_err(s)?;
            let events = take(&mut watch, |e| e.event_type() == "message.completed").await.map_err(s)?;
            ensure!(
                events.iter().any(|e| e.event_type() == "message.completed"),
                "the answer {events:?}"
            );
            Ok(())
        }),

        "files.sources" => Box::pin(async move {
            let data: Vec<u8> = (0..70_000u32).map(|i| (i % 253) as u8).collect();
            let path = temp_file("same.pdf", &data);
            let c = client(m);
            c.core().uploads().send(UploadFile::from_path(&path).map_err(s)?).await.map_err(s)?;
            c.core()
                .uploads()
                .send(UploadFile::from_bytes("same.pdf", data.clone()))
                .await
                .map_err(s)?;
            let reader = UploadFile::from_reader("same.pdf", std::io::Cursor::new(data.clone()));
            c.core().uploads().send(reader).await.map_err(s)?;
            let reserves = bodies(m, "POST", "/v3/uploads").await;
            let puts = m
                .matching(|r| str_at(r, "method") == "PUT" && str_at(r, "path").starts_with("/__s3/"))
                .await;
            ensure!(
                reserves.len() == 3 && puts.len() == 3,
                "{} reserves, {} puts",
                reserves.len(),
                puts.len()
            );
            for (r, p) in reserves.iter().zip(&puts) {
                ensure!(
                    r["fileName"] == "same.pdf"
                        && r["byteSize"] == json!(data.len())
                        && r["contentType"] == "application/pdf"
                        && r["sha256"] == reserves[0]["sha256"]
                        && r["sha256"].as_str().is_some_and(|h| h.len() == 44 && h.ends_with('='))
                        && p["bodySha256"] == r["sha256"],
                    "reserve {r}, put {}",
                    p["bodySha256"]
                );
            }
            Ok(())
        }),
        "files.content-type" => Box::pin(async move {
            let c = client(m);
            for (name, set) in [
                ("a.pdf", None),
                ("b.docx", None),
                ("c.md", None),
                ("d.unknownext", None),
                ("e.pdf", Some("text/plain")),
            ] {
                let mut f = UploadFile::from_bytes(name, &b"content"[..]);
                if let Some(t) = set {
                    f = f.content_type(t);
                }
                c.core().uploads().send(f).await.map_err(s)?;
            }
            let types: Vec<String> = bodies(m, "POST", "/v3/uploads")
                .await
                .iter()
                .map(|b| str_at(b, "contentType").to_owned())
                .collect();
            ensure!(
                types
                    == [
                        "application/pdf",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "text/markdown",
                        "application/octet-stream",
                        "text/plain",
                    ],
                "types {types:?}"
            );
            // Every extension in the table every SDK shares
            let shared = read_json("conformance/cases/content-types.json");
            for (ext, want) in shared["contentTypes"].as_object().into_iter().flatten() {
                let got = caitlyn_sdk_core::content_type_for(&format!("file.{ext}"));
                ensure!(Some(got) == want.as_str(), ".{ext}: {got}, want {want}");
            }
            Ok(())
        }),
        "files.spool" => Box::pin(async move {
            let dir = fresh_dir("spool");
            let seen = Arc::new(Mutex::new(None));
            let size = 9 * 1024 * 1024 + 123;
            let reader = Generated {
                left: size,
                sent: 0,
                dir: dir.clone(),
                seen: seen.clone(),
            };
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .spool_dir(&dir)
                .build()
                .map_err(s)?;
            c.core()
                .uploads()
                .send(UploadFile::from_reader("big.pdf", reader))
                .await
                .map_err(s)?;
            let during = *seen.lock().unwrap();
            let left = std::fs::read_dir(&dir).map_err(s)?.count();
            let reserve = bodies(m, "POST", "/v3/uploads").await.remove(0);
            let put = m.matching(|r| str_at(r, "method") == "PUT").await.remove(0);
            ensure!(
                during == Some((1, 0o600)),
                "spool files while reading past 8 MiB (count, mode): {during:?}"
            );
            ensure!(left == 0, "{left} files left in the spool directory");
            ensure!(
                put["bodyLength"] == json!(size) && reserve["byteSize"] == json!(size) && put["bodySha256"] == reserve["sha256"],
                "put {} bytes {}, reserved {reserve}",
                put["bodyLength"],
                put["bodySha256"]
            );
            Ok(())
        }),
        "files.too-large" => Box::pin(async move {
            let path = root().join("build/rust-conformance-tmp/too-large.pdf");
            std::fs::create_dir_all(path.parent().unwrap()).map_err(s)?;
            std::fs::File::create(&path).and_then(|f| f.set_len(2_147_483_649)).map_err(s)?;
            let r = client(m).core().uploads().send(UploadFile::from_path(&path).map_err(s)?).await;
            let _ = std::fs::remove_file(&path);
            ensure!(
                r.as_ref().err().and_then(Error::code) == Some("FILE_TOO_LARGE"),
                "got {:?}",
                r.err()
            );
            ensure!(m.requests().await.is_empty(), "requests were sent");
            Ok(())
        }),
        "files.changed" => Box::pin(async move {
            m.faults(json!({"reserveDelayMs": 800})).await;
            let path = temp_file("changing.pdf", b"before");
            let c = client(m);
            let f = UploadFile::from_path(&path).map_err(s)?;
            let call = tokio::spawn(async move { c.core().uploads().send(f).await });
            // Change the file once the reservation has arrived (the mock holds it 800 ms).
            let t0 = Instant::now();
            while m.matching(|r| str_at(r, "path") == "/v3/uploads").await.is_empty() {
                ensure!(t0.elapsed() < Duration::from_secs(5), "CreateUpload never arrived");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            std::fs::write(&path, b"after, and longer").map_err(s)?;
            let r = call.await.map_err(s)?;
            ensure!(r.as_ref().err().and_then(Error::code) == Some("FILE_CHANGED"), "got {:?}", r.err());
            ensure!(m.matching(|r| str_at(r, "method") == "PUT").await.is_empty(), "the bytes were sent");
            Ok(())
        }),
        "files.put-retry" => Box::pin(async move {
            m.faults(status("PutUpload", &[(503, 0)])).await;
            let up = client(m).core().uploads().send(pdf("retry.pdf", b"retry me")).await.map_err(s)?;
            let puts = m.matching(|r| str_at(r, "method") == "PUT").await;
            ensure!(puts.len() == 2, "{} PUTs", puts.len());
            ensure!(
                puts[0]["headers"] == puts[1]["headers"] && puts[0]["bodySha256"] == puts[1]["bodySha256"],
                "PUTs differ: {} / {}",
                puts[0],
                puts[1]
            );
            ensure!(
                header(&puts[1], "x-amz-checksum-sha256") == up.required_headers.get("x-amz-checksum-sha256").map(String::as_str)
                    && header(&puts[1], "authorization").is_none(),
                "headers {}",
                puts[1]["headers"]
            );
            Ok(())
        }),

        // ------------------------------------------------------------------ upload targets (PROTOCOL.md 10)
        "upload-target.top-level" => Box::pin(async move {
            let doc = client(m)
                .knowledge_base(KB)
                .documents()
                .create(pdf("leave-policy.pdf", b"twenty days"))
                .folder("/hr/")
                .send()
                .await
                .map_err(s)?;
            let reqs = m.requests().await;
            let seq: Vec<String> = reqs
                .iter()
                .map(|r| format!("{} {}", str_at(r, "method"), str_at(r, "path")))
                .collect();
            ensure!(seq.len() == 3, "requests {seq:?}");
            let reserve: Value = serde_json::from_str(str_at(&reqs[0], "body")).map_err(s)?;
            let create: Value = serde_json::from_str(str_at(&reqs[2], "body")).map_err(s)?;
            let put = &reqs[1];
            let upload_id = put["path"].as_str().unwrap_or_default().trim_start_matches("/__s3/").to_owned();
            ensure!(
                seq[0] == "POST /v3/uploads"
                    && seq[1].starts_with("PUT /__s3/")
                    && seq[2] == format!("POST /v3/knowledge-bases/{KB}/documents"),
                "requests {seq:?}"
            );
            ensure!(
                header(put, "content-type") == Some("application/pdf")
                    && header(put, "x-amz-checksum-sha256") == reserve["sha256"].as_str()
                    && header(put, "authorization").is_none()
                    && put["headerNames"]
                        .as_array()
                        .is_some_and(|h| !h.iter().any(|n| n == "caitlyn-sdk-model")),
                "PUT {put}"
            );
            ensure!(
                create["uploadId"] == json!(upload_id) && create["folder"] == "/hr/" && create.get("file").is_none(),
                "create {create}"
            );
            ensure!(
                !doc.result().document.id.is_empty() && doc.id() == doc.result().document.id && !doc.result().operation.id.is_empty(),
                "the new document's scope {doc:?}"
            );
            // kb.documents(id).replace(file) adds a version the same way: reserve, PUT, then CreateDocumentVersion.
            let before = m.requests().await.len();
            let existing = client(m).knowledge_base(KB).document("doc-0002");
            let v = existing.replace(pdf("policy-2.pdf", b"twenty-one days")).send().await.map_err(s)?;
            let seq: Vec<String> = m.requests().await[before..]
                .iter()
                .map(|r| format!("{} {}", str_at(r, "method"), str_at(r, "path")))
                .collect();
            let versions = format!("/v3/knowledge-bases/{KB}/documents/doc-0002/versions");
            ensure!(
                seq.len() == 3 && seq[0] == "POST /v3/uploads" && seq[1].starts_with("PUT /__s3/") && seq[2] == format!("POST {versions}"),
                "replace requests {seq:?}"
            );
            let version: Value = bodies(m, "POST", &versions).await.remove(0);
            ensure!(
                version["uploadId"].as_str().is_some_and(|u| seq[1].ends_with(u)),
                "version {version}, {v:?}"
            );
            Ok(())
        }),
        "upload-target.nested" => Box::pin(async move {
            let png = b"\x89PNG\r\n\x1a\nnot really a picture";
            let a = client(m)
                .agents()
                .create("Ava")
                .avatar(AgentAvatarInput {
                    mark: Some(AgentMarkInput {
                        picture: Some(UploadFile::from_bytes("ava.png", &png[..])),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .await
                .map_err(s)?;
            let reserve = bodies(m, "POST", "/v3/uploads").await.remove(0);
            let create = bodies(m, "POST", "/v3/agents").await.remove(0);
            let put = m.matching(|r| str_at(r, "method") == "PUT").await;
            let upload_id = put
                .first()
                .map(|p| str_at(p, "path").trim_start_matches("/__s3/").to_owned())
                .unwrap_or_default();
            ensure!(
                reserve["purpose"] == json!({"agentAvatar": true}) && reserve["contentType"] == "image/png",
                "reserve {reserve}"
            );
            ensure!(
                create["avatar"]["mark"] == json!({"pictureUploadId": upload_id}) && create["name"] == "Ava",
                "create {create}"
            );
            let url = a
                .result()
                .avatar
                .as_ref()
                .and_then(|v| v.mark.as_ref())
                .and_then(|k| k.picture_url.clone());
            ensure!(url.is_some_and(|u| u.contains(&upload_id)), "agent {:?}", a.result().avatar);
            Ok(())
        }),

        // ------------------------------------------------------------------ ingest (PROTOCOL.md 15)
        "sync.flow" => Box::pin(async move {
            let dir = folder_of(&[("leave.pdf", "leave"), ("pay/pay.pdf", "pay"), ("notes.md", "# notes")]);
            let report = client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::dir(&dir).folder("/new/"))
                .await
                .map_err(s)?;
            let seq: Vec<String> = m
                .requests()
                .await
                .iter()
                .map(|r| {
                    format!(
                        "{} {}",
                        str_at(r, "method"),
                        str_at(r, "path")
                            .split('/')
                            .filter(|p| !p.contains('-') || p.len() < 30)
                            .collect::<Vec<_>>()
                            .join("/")
                    )
                })
                .collect();
            let first = |p: &str| seq.iter().position(|x| x.starts_with(p));
            let last = |p: &str| seq.iter().rposition(|x| x.starts_with(p));
            let order = [
                first(&format!("POST /v3/knowledge-bases/{KB}/ingestion-batches")),
                first(&format!("GET /v3/knowledge-bases/{KB}/ingestion-batches")),
                first(&format!("POST /v3/knowledge-bases/{KB}/ingestion-batches/start")),
                first("POST /__s3"),
                first(&format!("POST /v3/knowledge-bases/{KB}/ingestion-batches/complete-uploads")),
                last(&format!("GET /v3/knowledge-bases/{KB}/ingestion-batches/items")),
            ];
            ensure!(
                order.iter().all(Option::is_some) && order.windows(2).all(|w| w[0] < w[1]),
                "order {order:?} in {seq:?}"
            );
            let posts = m.matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == "/__s3/").await;
            ensure!(posts.len() == 3, "{} uploads", posts.len());
            for p in &posts {
                let form = p["form"].as_array().ok_or("no form")?;
                let names: Vec<&str> = form.iter().map(|f| str_at(f, "name")).collect();
                let value = |n: &str| {
                    form.iter()
                        .find(|f| f["name"] == n)
                        .map(|f| str_at(f, "value").to_owned())
                        .unwrap_or_default()
                };
                let file = form.last().ok_or("no file")?;
                let sha = str_at(file, "sha256");
                let url_safe = sha.trim_end_matches('=').replace('+', "-").replace('/', "_");
                ensure!(
                    names
                        == [
                            "bucket",
                            "x-amz-algorithm",
                            "x-amz-credential",
                            "x-amz-date",
                            "policy",
                            "x-amz-signature",
                            "key",
                            "Content-Type",
                            "x-amz-checksum-algorithm",
                            "x-amz-checksum-sha256",
                            "file"
                        ],
                    "fields {names:?}"
                );
                ensure!(
                    value("x-amz-checksum-algorithm") == "SHA256"
                        && value("x-amz-checksum-sha256") == sha
                        && sha.len() == 44
                        && value("key").contains(&url_safe),
                    "form {form:?}"
                );
            }
            ensure!(
                report.items.len() == 3 && report.items.iter().all(|i| i.status.as_str() == "indexed"),
                "items {:?}",
                report.items
            );
            ensure!(report.batch.status.as_str() == "succeeded", "batch {:?}", report.batch.status);
            Ok(())
        }),
        "sync.many-items" => Box::pin(async move {
            let items: Vec<SyncItem> = (0..20_001).map(|i| SyncItem::remove(format!("/gone/old-{i}.pdf"))).collect();
            let report = client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(items))
                .await
                .map_err(s)?;
            let create = bodies(m, "POST", &format!("/v3/knowledge-bases/{KB}/ingestion-batches")).await;
            let create = create.first().ok_or("no create")?;
            let adds = bodies(m, "POST", "/items:batch-create").await;
            let count = |b: &Value| b["items"].as_array().map_or(0, Vec::len);
            ensure!(
                count(create) == 10_000 && create["awaitMoreItems"] == true && create["start"] == "manual",
                "create: {} items, awaitMoreItems {}, start {}",
                count(create),
                create["awaitMoreItems"],
                create["start"]
            );
            ensure!(
                adds.len() == 2
                    && count(&adds[0]) == 10_000
                    && adds[0].get("last").is_none()
                    && count(&adds[1]) == 1
                    && adds[1]["last"] == true,
                "addItems: {:?}",
                adds.iter().map(|b| (count(b), b["last"].clone())).collect::<Vec<_>>()
            );
            ensure!(
                m.matching(|r| str_at(r, "method") == "PATCH").await.is_empty(),
                "no UpdateIngestionBatch: last ends the draft"
            );
            ensure!(
                report.items.len() == 20_001 && report.batch.item_count == 20_001,
                "{} items",
                report.items.len()
            );
            Ok(())
        }),
        "sync.cancelled-item" => Box::pin(async move {
            // An item whose document was deleted while it was being ingested ends cancelled (the mock's cancelItems).
            m.faults(json!({"cancelItems": {"/new/b.pdf": true}})).await;
            let seen = Arc::new(Mutex::new(Vec::<(String, String, Option<String>)>::new()));
            let phases = Arc::new(Mutex::new(Vec::<String>::new()));
            let (log, steps) = (seen.clone(), phases.clone());
            let items = vec![
                SyncItem::file("/new/a.pdf", pdf("a.pdf", b"alpha")),
                SyncItem::file("/new/b.pdf", pdf("b.pdf", b"bravo")),
            ];
            let input = SyncInput::items(items)
                .on_item(move |it: &IngestionBatchItem| {
                    log.lock().unwrap().push((
                        it.path.clone().unwrap_or_default(),
                        it.status.as_str().to_owned(),
                        it.failure_code.clone(),
                    ))
                })
                .on_progress(move |p: &IngestionProgress| steps.lock().unwrap().push(p.phase.as_str().to_owned()));
            let report = client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            let b = report
                .items
                .iter()
                .find(|i| i.path.as_deref() == Some("/new/b.pdf"))
                .ok_or("no b")?;
            let a = report
                .items
                .iter()
                .find(|i| i.path.as_deref() == Some("/new/a.pdf"))
                .ok_or("no a")?;
            ensure!(
                b.status.as_str() == "cancelled"
                    && b.failure_code.is_none()
                    && a.status.as_str() == "indexed"
                    && report.batch.status.as_str() == "succeeded",
                "report {:?} {:?}",
                report.items,
                report.batch.status
            );
            let on_b: Vec<_> = seen.lock().unwrap().iter().filter(|x| x.0 == "/new/b.pdf").cloned().collect();
            ensure!(
                on_b.len() == 1 && on_b[0].1 == "cancelled" && on_b[0].2.is_none(),
                "on_item for b {on_b:?}"
            );
            ensure!(
                phases.lock().unwrap().last().map(String::as_str) == Some("succeeded"),
                "progress {:?}",
                phases.lock().unwrap()
            );
            // Never uploaded or completed again: one form POST each, and b named once by CompleteIngestionBatchUploads.
            let posts = m.matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == "/__s3/").await;
            ensure!(posts.len() == 2, "{} uploads", posts.len());
            let completed: Vec<Value> = bodies(m, "POST", "complete-uploads")
                .await
                .iter()
                .flat_map(|x| x["itemIds"].as_array().cloned().unwrap_or_default())
                .collect();
            ensure!(
                completed.len() == 2 && completed.iter().filter(|id| id.as_str() == Some(b.id.as_str())).count() == 1,
                "completed {completed:?}"
            );
            Ok(())
        }),
        "sync.on-item-once" => Box::pin(async move {
            // A failed upload reaches on_item at once, as failed; the other item once it has finished, with its final
            // status; neither twice, and never when its upload is accepted.
            m.faults(json!({"failUploads": {"/new/b.pdf": true}})).await;
            let seen = Arc::new(Mutex::new(Vec::<(String, String, Option<String>)>::new()));
            let log = seen.clone();
            let items = vec![
                SyncItem::file("/new/a.pdf", pdf("a.pdf", b"alpha")),
                SyncItem::file("/new/b.pdf", pdf("b.pdf", b"bravo")),
            ];
            let input = SyncInput::items(items).on_item(move |it: &IngestionBatchItem| {
                log.lock().unwrap().push((
                    it.path.clone().unwrap_or_default(),
                    it.status.as_str().to_owned(),
                    it.failure_code.clone(),
                ))
            });
            client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            let seen = seen.lock().unwrap().clone();
            ensure!(
                seen == [
                    ("/new/b.pdf".to_owned(), "failed".to_owned(), Some("UPLOAD_FAILED".to_owned())),
                    ("/new/a.pdf".to_owned(), "indexed".to_owned(), None),
                ],
                "on_item {seen:?}"
            );
            Ok(())
        }),
        "sync.cancel-report" => Box::pin(async move {
            // The cancellation error carries the report so far: every item with its last status (those accepted but
            // not yet final included) and the batch; on_item has had only final items (none here).
            //
            // The cancellation point is fixed: one upload at a time, cancelled once the second upload has reached the
            // mock. With one upload at a time the second starts only after the first's CompleteIngestionBatchUploads
            // has answered, so exactly one item has been accepted (ingesting) and the eleven others are still
            // awaiting_upload (the second's upload is never reported to Complete). The upload progress event is not
            // a fixed point: it fires before Complete, so a cancellation there may or may not follow the acceptance.
            m.faults(json!({"uploadDelayMs": 2000})).await;
            let token = CancellationToken::new();
            let on_item = Arc::new(AtomicUsize::new(0));
            let f = on_item.clone();
            let items = (0..12)
                .map(|i| {
                    SyncItem::file(
                        format!("/new/r{i}.pdf"),
                        pdf(&format!("r{i}.pdf"), format!("report {i}").as_bytes()),
                    )
                })
                .collect();
            let input = SyncInput::items(items).concurrency(1).on_item(move |_| {
                f.fetch_add(1, Ordering::SeqCst);
            });
            let c = client(m);
            let t = token.clone();
            let call = tokio::spawn(async move { c.knowledge_base(KB).ingestion().sync(input).cancel_on(t).await });
            let t0 = Instant::now();
            while m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == "/__s3/")
                .await
                .len()
                < 2
            {
                ensure!(t0.elapsed() < Duration::from_secs(10), "the second upload never started");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let completes = m.matching(|r| str_at(r, "path").ends_with("/complete-uploads")).await.len();
            ensure!(
                completes == 1,
                "{completes} CompleteIngestionBatchUploads calls before the cancellation"
            );
            token.cancel();
            let e = call.await.map_err(s)?.err().ok_or("the sync finished")?;
            ensure!(e.is_cancelled(), "got {e:?}");
            let report = e.report().ok_or("no report on the cancelled error")?;
            let statuses: Vec<&str> = report.items.iter().map(|i| i.status.as_str()).collect();
            ensure!(report.items.len() == 12, "{} items in the report", report.items.len());
            ensure!(
                statuses.iter().filter(|s| **s == "ingesting").count() == 1
                    && statuses.iter().filter(|s| **s == "awaiting_upload").count() == 11,
                "statuses {statuses:?}"
            );
            ensure!(
                !report.batch.id.is_empty() && report.batch.item_count == 12,
                "batch {:?}",
                report.batch
            );
            let completes = m.matching(|r| str_at(r, "path").ends_with("/complete-uploads")).await.len();
            ensure!(
                completes == 1,
                "{completes} CompleteIngestionBatchUploads calls after the cancellation"
            );
            ensure!(
                on_item.load(Ordering::SeqCst) == 0,
                "{} items reached on_item",
                on_item.load(Ordering::SeqCst)
            );
            Ok(())
        }),
        "sync.report-shape" => Box::pin(async move {
            // One report type, SyncReport: report.batch (the batch as reading it gives it) and report.items (every
            // item as listing the batch's items gives it). A declined confirm's and a cancellation's errors carry the
            // same type, reached through report().
            #[allow(clippy::type_complexity)]
            fn item_view(
                i: &IngestionBatchItem,
            ) -> (
                String,
                Option<String>,
                Option<String>,
                String,
                Option<String>,
                Option<i32>,
                Option<String>,
            ) {
                (
                    i.id.clone(),
                    i.outcome.as_ref().map(|o| o.as_str().to_owned()),
                    i.resolution.as_ref().map(|r| r.as_str().to_owned()),
                    i.status.as_str().to_owned(),
                    i.document_id.clone(),
                    i.version,
                    i.failure_code.clone(),
                )
            }
            let c = client(m);
            let items = vec![
                SyncItem::file("/new/a.pdf", pdf("a.pdf", b"alpha")),
                SyncItem::file("/new/b.pdf", pdf("b.pdf", b"bravo")),
            ];
            let report: SyncReport = c.knowledge_base(KB).ingestion().sync(SyncInput::items(items)).await.map_err(s)?;
            let batch = c.knowledge_base(KB).ingestion().batch(&report.batch.id);
            let read = batch.get().await.map_err(s)?;
            ensure!(
                report.batch.id == read.id
                    && report.batch.status.as_str() == read.status.as_str()
                    && report.batch.item_count == read.item_count
                    && report.batch.counts.as_ref().map(|k| (&k.by_outcome, &k.by_status))
                        == read.counts.as_ref().map(|k| (&k.by_outcome, &k.by_status))
                    && report.batch.counts.is_some(),
                "report.batch {:?} but the batch reads {read:?}",
                report.batch
            );
            let mut listed: Vec<_> = batch.items().list().collect().await.map_err(s)?.iter().map(item_view).collect();
            let mut got: Vec<_> = report.items.iter().map(item_view).collect();
            listed.sort();
            got.sort();
            ensure!(
                got.len() == 2 && got == listed,
                "report.items {got:?} but the batch lists {listed:?}"
            );
            ensure!(
                report.items.iter().all(|i| i.outcome.is_some()
                    && i.resolution.is_some()
                    && i.status.as_str() == "indexed"
                    && i.document_id.is_some()
                    && i.version.is_some()
                    && i.failure_code.is_none()),
                "items {:?}",
                report.items
            );

            // A declined confirm: the batch as planned, and its items.
            let declined = c
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(vec![SyncItem::file("/new/c.pdf", pdf("c.pdf", b"charlie"))]).confirm(|_: &SyncPlan| false))
                .await
                .err()
                .ok_or("the declined sync went on")?;
            let r: &SyncReport = declined.report().ok_or("no report on the declined confirm")?;
            ensure!(
                !r.batch.id.is_empty()
                    && r.batch.status.as_str() == "planned"
                    && r.batch.item_count == 1
                    && r.items.len() == 1
                    && r.items[0].path.as_deref() == Some("/new/c.pdf")
                    && r.items[0].outcome.is_some(),
                "declined report {r:?}"
            );

            // A cancellation: one upload at a time, cancelled once the second upload has reached the mock (the
            // first is then accepted), so the report is fixed: one item ingesting, one awaiting its upload.
            m.faults(json!({"uploadDelayMs": 2000})).await;
            let token = CancellationToken::new();
            let t = token.clone();
            let c2 = c.clone();
            let call = tokio::spawn(async move {
                let items = vec![
                    SyncItem::file("/new/d.pdf", pdf("d.pdf", b"delta")),
                    SyncItem::file("/new/e.pdf", pdf("e.pdf", b"echo")),
                ];
                c2.knowledge_base(KB)
                    .ingestion()
                    .sync(SyncInput::items(items).concurrency(1))
                    .cancel_on(t)
                    .await
            });
            let t0 = Instant::now();
            let form_uploads = |r: &Value| str_at(r, "method") == "POST" && str_at(r, "path") == "/__s3/";
            // The first sync sent two uploads; the cancelled one's second upload is the fourth.
            while m.matching(form_uploads).await.len() < 4 {
                ensure!(t0.elapsed() < Duration::from_secs(10), "the second upload never started");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            token.cancel();
            let cancelled = call.await.map_err(s)?.err().ok_or("the sync finished")?;
            ensure!(cancelled.is_cancelled(), "got {cancelled:?}");
            let r: &SyncReport = cancelled.report().ok_or("no report on the cancellation")?;
            let mut statuses: Vec<(Option<&str>, &str)> = r.items.iter().map(|i| (i.path.as_deref(), i.status.as_str())).collect();
            statuses.sort();
            ensure!(
                !r.batch.id.is_empty()
                    && r.batch.item_count == 2
                    && statuses == [(Some("/new/d.pdf"), "ingesting"), (Some("/new/e.pdf"), "awaiting_upload")],
                "cancelled report {r:?}"
            );
            Ok(())
        }),
        "sync.estimate-many" => Box::pin(async move {
            // With the call limit at 2 (10,000 in use), three new files are priced in two EstimateIngestion calls, in
            // order (two then one), and the plan's estimate is the two added together: counts and the ends of
            // durationSeconds and cost summed, cost in its unit, details left out. confirm sees the same total.
            let kb = client(m).knowledge_base(KB);
            let items = || {
                vec![
                    SyncItem::file("/new/a.pdf", pdf("a.pdf", b"alpha")),
                    SyncItem::file("/new/b.pdf", pdf("b.pdf", b"bravo")),
                    SyncItem::file("/new/c.pdf", pdf("c.pdf", b"charlie")),
                ]
            };
            let plan = kb
                .ingestion()
                .estimate_sync(SyncInput::items(items()).estimate_per_call(2))
                .await
                .map_err(s)?;
            let est = plan.estimate.ok_or("no estimate")?;
            let calls = bodies(m, "POST", &format!("/v3/knowledge-bases/{KB}/ingestions:estimate")).await;
            let names: Vec<Vec<&str>> = calls
                .iter()
                .map(|b| b["documents"].as_array().into_iter().flatten().map(|d| str_at(d, "name")).collect())
                .collect();
            ensure!(
                names == [vec!["a.pdf", "b.pdf"], vec!["c.pdf"]],
                "EstimateIngestion calls {names:?}"
            );
            ensure!(
                calls
                    .iter()
                    .flat_map(|b| b["documents"].as_array().into_iter().flatten())
                    .all(|d| d.get("sha256").is_none()),
                "an estimate described a file by its hash: {calls:?}"
            );
            // Each part as the API prices it, then added up.
            let mut parts = Vec::new();
            for b in &calls {
                let documents: Vec<UploadDescription> = serde_json::from_value(b["documents"].clone()).map_err(s)?;
                let input = EstimateIngestionInput {
                    documents,
                    ..Default::default()
                };
                parts.push(kb.documents().estimate_create(pdf("x.pdf", b"x")).input(input).await.map_err(s)?);
            }
            let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
            let sum = |f: &dyn Fn(&EstimateIngestionResult) -> f64| parts.iter().map(f).sum::<f64>();
            ensure!(
                est.documents == 3 && parts.iter().map(|p| p.documents).sum::<i64>() == 3,
                "documents {est:?}"
            );
            ensure!(
                close(est.duration_seconds.low, sum(&|p| p.duration_seconds.low))
                    && close(est.duration_seconds.high, sum(&|p| p.duration_seconds.high)),
                "durationSeconds {:?} from parts {parts:?}",
                est.duration_seconds
            );
            let cost = est.cost.as_ref().ok_or("no cost, though every part has one")?;
            ensure!(
                close(cost.low, sum(&|p| p.cost.as_ref().map_or(f64::NAN, |c| c.low)))
                    && close(cost.high, sum(&|p| p.cost.as_ref().map_or(f64::NAN, |c| c.high)))
                    && cost.unit.as_str() == parts[0].cost.as_ref().map_or("", |c| c.unit.as_str()),
                "cost {cost:?} from parts {parts:?}"
            );
            ensure!(
                est.documents_of_unknown_length == Some(parts.iter().filter_map(|p| p.documents_of_unknown_length).sum())
                    && est.details.is_none(),
                "estimate {est:?}"
            );
            // confirm is given the same total.
            let seen = Arc::new(Mutex::new(None));
            let keep = seen.clone();
            let input = SyncInput::items(items()).estimate_per_call(2).confirm(move |p: &SyncPlan| {
                *keep.lock().unwrap() = p
                    .estimate
                    .as_ref()
                    .map(|e| (e.documents, e.duration_seconds.low, e.duration_seconds.high));
                false
            });
            let _ = kb.ingestion().sync(input).await;
            let got = *seen.lock().unwrap();
            ensure!(
                got == Some((est.documents, est.duration_seconds.low, est.duration_seconds.high)),
                "confirm saw {got:?}"
            );
            Ok(())
        }),
        "estimate.caller-hints" => Box::pin(async move {
            // A file with hints and one without, through each estimate: the first's description carries its hints,
            // the second's only its name, content type and size. Batch items carry no hints.
            let kb = client(m).knowledge_base(KB);
            let hints = IngestionHints {
                pages: Some(12),
                scanned_pages: Some(3),
                ..Default::default()
            };
            let hinted = || pdf("hinted.pdf", b"twelve pages").hints(hints.clone());
            let plain = || pdf("plain.pdf", b"no hints");
            kb.documents().estimate_create(hinted()).await.map_err(s)?;
            kb.documents().estimate_create(plain()).await.map_err(s)?;
            kb.document("doc-0001").estimate_replace(hinted()).await.map_err(s)?;
            kb.document("doc-0001").estimate_replace(plain()).await.map_err(s)?;
            kb.ingestion()
                .estimate_sync(SyncInput::items(vec![
                    SyncItem::file("/new/hinted.pdf", hinted()),
                    SyncItem::file("/new/plain.pdf", plain()),
                ]))
                .await
                .map_err(s)?;
            let want = json!({"pages": 12, "scannedPages": 3});
            let described: Vec<Value> = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").contains(":estimate"))
                .await
                .iter()
                .flat_map(|r| {
                    let b: Value = serde_json::from_str(str_at(r, "body")).unwrap_or_default();
                    let mut ds = b["documents"].as_array().cloned().unwrap_or_default();
                    if b["file"].is_object() {
                        ds.push(b["file"].clone());
                    }
                    ds
                })
                .collect();
            ensure!(described.len() == 6, "{} descriptions: {described:?}", described.len());
            for d in &described {
                let ok = match str_at(d, "name") {
                    "hinted.pdf" => d.get("hints") == Some(&want),
                    "plain.pdf" => d.get("hints").is_none() && d.as_object().is_some_and(|o| o.len() == 3),
                    _ => false,
                };
                ensure!(ok, "description {d}");
            }
            let created = bodies(m, "POST", &format!("/v3/knowledge-bases/{KB}/ingestion-batches")).await;
            ensure!(
                created
                    .iter()
                    .flat_map(|b| b["items"].as_array().cloned().unwrap_or_default())
                    .all(|i| i.get("hints").is_none()),
                "a batch item carries hints: {created:?}"
            );
            Ok(())
        }),
        // ------------------------------------------------------------------ a hand-built batch (PROTOCOL.md 15)
        "batch-estimate.priced-items" => Box::pin(async move {
            // add (two new files) is priced; remove is not.
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![
                    ingest_item("/new/a.pdf", b"alpha"),
                    ingest_item("/new/b.pdf", b"bravo"),
                    remove_item("/policies/policy-2.pdf"),
                ],
                false,
            )
            .await?;
            let est: EstimateIngestionResult = batch.estimate_upload().await.map_err(s)?;
            let calls = estimate_calls(m).await;
            let names: Vec<Vec<&str>> = calls.iter().map(|ds| ds.iter().map(|d| str_at(d, "name")).collect()).collect();
            ensure!(
                names == [vec!["a.pdf", "b.pdf"]] && est.documents == 2,
                "calls {names:?}, estimate {est:?}"
            );
            let items = batch.items().list().collect().await.map_err(s)?;
            let removing = items
                .iter()
                .find(|i| i.path.as_deref() == Some("/policies/policy-2.pdf"))
                .ok_or("no remove item")?;
            ensure!(
                removing.resolution.as_ref().map(|r| r.as_str()) == Some("remove"),
                "the remove item resolves {:?}",
                removing.resolution
            );
            Ok(())
        }),
        "batch-estimate.from-items" => Box::pin(async move {
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/hr/leave.pdf", b"twenty days"), ingest_item("/hr/pay.pdf", b"monthly")],
                false,
            )
            .await?;
            batch.estimate_upload().await.map_err(s)?;
            let calls = estimate_calls(m).await;
            ensure!(
                calls
                    == [vec![
                        json!({"name": "leave.pdf", "contentType": "application/pdf", "byteSize": 11}),
                        json!({"name": "pay.pdf", "contentType": "application/pdf", "byteSize": 7}),
                    ]],
                "documents {calls:?}"
            );
            Ok(())
        }),
        "batch-estimate.from-files" => Box::pin(async move {
            // Described from the files: their own names, types and sizes, the hints only where given; a file no item
            // has is left out. The item's checksum is never recomputed: nothing but the size is read.
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/hr/leave.pdf", b"twenty days"), ingest_item("/hr/pay.pdf", b"monthly")],
                false,
            )
            .await?;
            let hints = IngestionHints {
                pages: Some(3),
                ..Default::default()
            };
            let files = BatchFiles::by_path([
                (
                    "/hr/leave.pdf",
                    UploadFile::from_bytes("leave-2026.pdf", b"twenty days".to_vec()).hints(hints),
                ),
                ("/hr/pay.pdf", UploadFile::from_bytes("pay.docx", b"monthly".to_vec())),
                ("/hr/other.pdf", UploadFile::from_bytes("other.pdf", b"not in the batch".to_vec())),
            ]);
            batch.estimate_upload().files(files).await.map_err(s)?;
            let calls = estimate_calls(m).await;
            let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            ensure!(
                calls
                    == [vec![
                        json!({"name": "leave-2026.pdf", "contentType": "application/pdf", "byteSize": 11, "hints": {"pages": 3}}),
                        json!({"name": "pay.docx", "contentType": docx, "byteSize": 7}),
                    ]],
                "documents {calls:?}"
            );
            Ok(())
        }),
        "batch-estimate.draft" => Box::pin(async move {
            let c = client(m);
            let batch = c
                .knowledge_base(KB)
                .ingestion()
                .batches()
                .create()
                .start(StartMode::Manual)
                .await_more_items(true)
                .items(vec![ingest_item("/new/a.pdf", b"alpha")])
                .await
                .map_err(s)?
                .into_scope();
            let before = m.api().await.len();
            let e = batch.estimate_upload().await.err().ok_or("a draft batch was priced")?;
            ensure!(
                e.code() == Some("INGESTION_BATCH_NOT_PLANNED") && e.status() == Some(0),
                "got {e:?}"
            );
            let sent: Vec<String> = m.api().await[before..]
                .iter()
                .map(|r| format!("{} {}", str_at(r, "method"), str_at(r, "path")))
                .collect();
            ensure!(
                sent.len() == 1 && sent[0].starts_with("GET "),
                "sent {sent:?}: one read, nothing more"
            );
            Ok(())
        }),
        "batch-estimate.planning" => Box::pin(async move {
            m.faults(json!({"planningReads": 3})).await;
            let c = client(m);
            let batch = c
                .knowledge_base(KB)
                .ingestion()
                .batches()
                .create()
                .start(StartMode::Manual)
                .items(vec![ingest_item("/new/a.pdf", b"alpha")])
                .await
                .map_err(s)?;
            ensure!(batch.result().status.as_str() == "planning", "created {:?}", batch.result().status);
            let est = batch.estimate_upload().await.map_err(s)?;
            ensure!(est.documents == 1 && estimate_calls(m).await.len() == 1, "estimate {est:?}");
            let now = batch.get().await.map_err(s)?;
            ensure!(now.status.as_str() == "planned", "batch {:?}", now.status);
            Ok(())
        }),
        "batch-estimate.nothing-to-price" => Box::pin(async move {
            let c = client(m);
            let batch = hand_batch(&c, vec![remove_item("/policies/policy-3.pdf")], false).await?;
            let est = batch.estimate_upload().await.map_err(s)?;
            ensure!(
                est.documents == 0 && est.cost.is_none() && est.duration_seconds.high == 0.0 && estimate_calls(m).await.is_empty(),
                "estimate {est:?}"
            );
            Ok(())
        }),
        "batch-estimate.many" => Box::pin(async move {
            // With the limit at 2 (10,000 in use), three items are priced in two calls, in order, added together.
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![
                    ingest_item("/new/a.pdf", b"alpha"),
                    ingest_item("/new/b.pdf", b"bravo"),
                    ingest_item("/new/c.pdf", b"charlie"),
                ],
                false,
            )
            .await?;
            let est = batch.estimate_upload().estimate_per_call(2).await.map_err(s)?;
            let calls = estimate_calls(m).await;
            let names: Vec<Vec<&str>> = calls.iter().map(|ds| ds.iter().map(|d| str_at(d, "name")).collect()).collect();
            ensure!(names == [vec!["a.pdf", "b.pdf"], vec!["c.pdf"]], "calls {names:?}");
            let kb = c.knowledge_base(KB);
            let mut parts = Vec::new();
            for ds in &calls {
                let documents: Vec<UploadDescription> = serde_json::from_value(json!(ds)).map_err(s)?;
                let input = EstimateIngestionInput {
                    documents,
                    ..Default::default()
                };
                parts.push(kb.documents().estimate_create(pdf("x.pdf", b"x")).input(input).await.map_err(s)?);
            }
            let low: f64 = parts.iter().map(|p| p.duration_seconds.low).sum();
            let high: f64 = parts.iter().map(|p| p.duration_seconds.high).sum();
            ensure!(
                est.documents == 3
                    && (est.duration_seconds.low - low).abs() < 1e-9
                    && (est.duration_seconds.high - high).abs() < 1e-9
                    && est.details.is_none(),
                "estimate {est:?} from {parts:?}"
            );
            Ok(())
        }),
        "batch-upload.not-started" => Box::pin(async move {
            // A planned batch with a manual start, and a draft: refused with nothing sent.
            let c = client(m);
            let planned = hand_batch(&c, vec![ingest_item("/new/a.pdf", b"alpha")], false).await?;
            let before = m.api().await.len();
            let e = planned
                .upload([("/new/a.pdf", pdf("a.pdf", b"alpha"))])
                .await
                .err()
                .ok_or("uploaded a batch not started")?;
            ensure!(
                e.code() == Some("INGESTION_BATCH_NOT_STARTED") && e.status() == Some(0),
                "got {e:?}"
            );
            let sent = m.api().await.len() - before;
            ensure!(
                sent == 1 && form_posts(m).await.is_empty(),
                "{sent} requests: one read, nothing more"
            );
            let draft = c
                .knowledge_base(KB)
                .ingestion()
                .batches()
                .create()
                .await_more_items(true)
                .items(vec![ingest_item("/new/b.pdf", b"bravo")])
                .await
                .map_err(s)?
                .into_scope();
            let e = draft
                .upload([("/new/b.pdf", pdf("b.pdf", b"bravo"))])
                .await
                .err()
                .ok_or("uploaded a draft")?;
            ensure!(e.code() == Some("INGESTION_BATCH_NOT_STARTED"), "draft: got {e:?}");
            // A when_planned batch still planning is followed until it runs, then uploaded.
            m.faults(json!({"planningReads": 2})).await;
            let when_planned = |path: &'static str, data: &'static [u8]| {
                let c = c.clone();
                async move {
                    c.knowledge_base(KB)
                        .ingestion()
                        .batches()
                        .create()
                        .start(StartMode::WhenPlanned)
                        .items(vec![ingest_item(path, data)])
                        .await
                        .map_err(s)
                }
            };
            let following = when_planned("/new/c.pdf", b"charlie").await?;
            ensure!(
                following.result().status.as_str() == "planning",
                "created {:?}",
                following.result().status
            );
            let done = following.upload([("/new/c.pdf", pdf("c.pdf", b"charlie"))]).await.map_err(s)?;
            ensure!(
                done.result().items.len() == 1 && done.result().items[0].status.as_str() == "ingesting" && form_posts(m).await.len() == 1,
                "followed batch {:?}",
                done.result()
            );
            ensure!(
                !m.matching(|r| str_at(r, "path") == format!("/v3/knowledge-bases/{KB}/events"))
                    .await
                    .is_empty(),
                "the planning batch was not followed"
            );
            // One that stops at planned (an item left unresolved) is not started either.
            m.faults(json!({"planningReads": 2, "planConflicts": {"/new/d.pdf": "duplicate_path"}}))
                .await;
            let stuck = when_planned("/new/d.pdf", b"delta").await?;
            let e = stuck
                .upload([("/new/d.pdf", pdf("d.pdf", b"delta"))])
                .await
                .err()
                .ok_or("uploaded a batch stopped at planned")?;
            ensure!(
                e.code() == Some("INGESTION_BATCH_NOT_STARTED") && e.status() == Some(0),
                "when_planned stopped at planned: got {e:?}"
            );
            ensure!(form_posts(m).await.len() == 1, "something was sent for the stopped batch");
            Ok(())
        }),
        "batch-upload.keep-alive" => Box::pin(async move {
            // A compressed clock: each policy lasts 2 s, so it is due for renewal 1 s after it arrives (half its life), and
            // the batch stops waiting for bytes 2 s after the latest one. The one file takes 3 s to arrive.
            let renewals = || async {
                m.matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").ends_with("/upload-policies"))
                    .await
                    .len()
            };
            let faults = json!({"uploadReservation": {"policySeconds": 2, "reservationSeconds": 2}, "uploadDelayMs": 3000});
            m.faults(faults.clone()).await;
            let c = client(m);
            let data = b"Staff receive 20 days of annual leave.";
            let files = || BatchFiles::by_path([("/new/annual-leave.pdf".to_owned(), pdf("annual-leave.pdf", data))]);
            let batch = hand_batch(&c, vec![ingest_item("/new/annual-leave.pdf", data)], true).await?;
            let done = batch.upload(files()).await.map_err(s)?;
            let items = &done.result().items;
            ensure!(
                items.len() == 1 && items[0].status.as_str() == "ingesting",
                "items {items:?}: the one accepted, not UPLOAD_EXPIRED"
            );
            let sent = renewals().await;
            ensure!(
                sent >= 3,
                "{sent} policies asked for: the first, then at least two while the upload was in flight"
            );
            tokio::time::sleep(Duration::from_millis(1500)).await;
            ensure!(renewals().await == sent, "a renewal after the call returned");
            // Cancelled during the slow upload: no renewal after the cancellation is raised.
            m.reset().await;
            m.faults(faults).await;
            let c = client(m);
            let batch = hand_batch(&c, vec![ingest_item("/new/annual-leave.pdf", data)], true).await?;
            let token = CancellationToken::new();
            let t = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                t.cancel();
            });
            let r = batch.upload(files()).cancel_on(token).await;
            ensure!(matches!(r, Err(Error::Cancelled)), "got {:?}", r.err());
            let at_cancel = renewals().await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            ensure!(renewals().await == at_cancel, "a renewal after the cancellation");
            Ok(())
        }),
        "batch-upload.short-window" => Box::pin(async move {
            // A 60-second window that the mock's test mode makes 2 s long, and one file that takes 2.5 s to arrive. Each policy lasts 2 s, so its renewal margin is 1 s, not 5 minutes: renewals about 1 s apart.
            m.faults(json!({"shortWindows": true, "uploadDelayMs": 2500})).await;
            let c = client(m);
            let input = SyncInput::items(vec![SyncItem::file(
                "/window/annual-leave.pdf",
                pdf("annual-leave.pdf", b"%PDF annual"),
            )])
            .upload_window_seconds(60);
            let report = c.knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            ensure!(report.batch.status.as_str() == "succeeded", "batch {:?}", report.batch.status);
            let created = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").ends_with("/ingestion-batches"))
                .await;
            let body: Value = serde_json::from_str(created.first().map(|r| str_at(r, "body")).unwrap_or("{}")).unwrap_or_default();
            ensure!(body["uploadWindowSeconds"] == json!(60), "CreateIngestionBatch sent {body}");
            let at: Vec<i64> = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").ends_with("/upload-policies"))
                .await
                .iter()
                .filter_map(|r| r["at"].as_i64())
                .collect();
            ensure!(
                (1..=3).contains(&at.len()),
                "{} renewals in a 2.5 s upload under 2 s policies",
                at.len()
            );
            let gaps: Vec<i64> = at.windows(2).map(|w| w[1] - w[0]).collect();
            ensure!(gaps.iter().all(|g| *g >= 750), "renewals {gaps:?} ms apart");
            // expires_in_seconds on a single file's upload, as given.
            let before = chrono::Utc::now();
            let up = c
                .core()
                .uploads()
                .reserve("a.pdf", "application/pdf", 1, "x")
                .expires_in_seconds(60)
                .await
                .map_err(s)?;
            let life = (up.expires_at - before).num_seconds();
            ensure!((55..=65).contains(&life), "the upload lasts {life} s");
            Ok(())
        }),
        "batch-upload.keep-alive-floor" => Box::pin(async move {
            // Every policy lasts a second, so it is due half a second after it arrives; the one file takes 4 s to arrive.
            // The first ask is upload()'s own policy; the rest are the timer's, the first half a second on and the
            // others a second apart: about five in all, where half-second renewals would be about nine.
            m.faults(json!({"uploadReservation": {"policySeconds": 1, "reservationSeconds": 30}, "uploadDelayMs": 4000}))
                .await;
            let c = client(m);
            let data = b"Staff receive 20 days of annual leave.";
            let batch = hand_batch(&c, vec![ingest_item("/new/annual-leave.pdf", data)], true).await?;
            let done = batch
                .upload(BatchFiles::by_path([(
                    "/new/annual-leave.pdf".to_owned(),
                    pdf("annual-leave.pdf", data),
                )]))
                .await
                .map_err(s)?;
            let items = &done.result().items;
            ensure!(items.len() == 1 && items[0].status.as_str() == "ingesting", "items {items:?}");
            let at: Vec<i64> = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").ends_with("/upload-policies"))
                .await
                .iter()
                .filter_map(|r| r["at"].as_i64())
                .collect();
            ensure!(
                (4..=6).contains(&at.len()),
                "{} policies asked for in 4 s: want the timer's renewals, at most one a second",
                at.len()
            );
            let gaps: Vec<i64> = at.windows(2).skip(1).map(|w| w[1] - w[0]).collect();
            ensure!(gaps.iter().all(|g| *g >= 900), "renewals {gaps:?} ms apart");
            Ok(())
        }),
        "batch-upload.sends" => Box::pin(async move {
            m.faults(json!({"uploadDelayMs": 100})).await;
            let c = client(m);
            let data: Vec<(String, Vec<u8>)> = (0..9)
                .map(|i| (format!("/new/f{i}.pdf"), format!("file {i}").into_bytes()))
                .collect();
            let mut items: Vec<IngestionItemInput> = data.iter().map(|(p, d)| ingest_item(p, d)).collect();
            items.push(remove_item("/policies/policy-4.pdf"));
            let batch = hand_batch(&c, items, true).await?;
            let files = BatchFiles::by_path(
                data.iter()
                    .map(|(p, d)| (p.clone(), pdf(p.rsplit('/').next().unwrap_or("f.pdf"), d))),
            );
            let done = batch.upload(files).await.map_err(s)?;
            let posts = form_posts(m).await;
            ensure!(
                posts.len() == 9 && done.result().items.len() == 9,
                "{} uploads, {} items",
                posts.len(),
                done.result().items.len()
            );
            let up = m.get("/__mock/uploads").await;
            ensure!(
                up["maxInFlight"].as_u64().is_some_and(|n| (2..=6).contains(&n)),
                "in flight {}",
                up["maxInFlight"]
            );
            let names: Vec<&str> = posts[0]["form"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| str_at(f, "name"))
                .collect();
            let n = names.len();
            ensure!(
                n >= 6
                    && names[n - 5..] == ["key", "Content-Type", "x-amz-checksum-algorithm", "x-amz-checksum-sha256", "file"]
                    && names[..n - 5].contains(&"policy"),
                "form fields {names:?}"
            );
            let groups = completed_ids(m).await;
            ensure!(
                groups.iter().all(|g| !g.is_empty() && g.len() <= 100) && groups.iter().map(Vec::len).sum::<usize>() == 9,
                "Complete groups {groups:?}"
            );
            Ok(())
        }),
        "batch-upload.not-given" => Box::pin(async move {
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/new/a.pdf", b"alpha"), ingest_item("/new/b.pdf", b"bravo")],
                true,
            )
            .await?;
            let seen = Arc::new(AtomicUsize::new(0));
            let f = seen.clone();
            let done = batch
                .upload([("/new/a.pdf", pdf("a.pdf", b"alpha"))])
                .on_item(move |_| {
                    f.fetch_add(1, Ordering::SeqCst);
                })
                .await
                .map_err(s)?;
            let r = done.result();
            ensure!(
                r.not_given == ["/new/b.pdf"] && r.items.len() == 1 && r.unmatched.is_empty(),
                "result {r:?}"
            );
            let items = batch.items().list().collect().await.map_err(s)?;
            let b = items.iter().find(|i| i.path.as_deref() == Some("/new/b.pdf")).ok_or("no b")?;
            ensure!(b.status.as_str() == "awaiting_upload", "b is {:?}", b.status);
            ensure!(
                completed_ids(m).await.iter().flatten().all(|id| *id != b.id),
                "b was reported to Complete"
            );
            ensure!(seen.load(Ordering::SeqCst) == 0, "on_item was called");
            Ok(())
        }),
        "batch-upload.unmatched" => Box::pin(async move {
            let c = client(m);
            let batch = hand_batch(&c, vec![ingest_item("/new/a.pdf", b"alpha")], true).await?;
            let done = batch
                .upload([("new/a.pdf", pdf("a.pdf", b"alpha")), ("/new/zzz.pdf", pdf("zzz.pdf", b"nobody's"))])
                .await
                .map_err(s)?;
            let r = done.result();
            ensure!(
                r.unmatched == ["/new/zzz.pdf"] && r.items.len() == 1 && r.not_given.is_empty(),
                "result {r:?}"
            );
            ensure!(form_posts(m).await.len() == 1, "{} uploads", form_posts(m).await.len());
            Ok(())
        }),
        "batch-upload.file-changed" => Box::pin(async move {
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![
                    ingest_item("/new/short.pdf", b"twelve bytes"),
                    ingest_item("/new/other.pdf", b"same size A"),
                    ingest_item("/new/ok.pdf", b"fine"),
                ],
                true,
            )
            .await?;
            let failed = Arc::new(Mutex::new(Vec::new()));
            let log = failed.clone();
            let done = batch
                .upload([
                    ("/new/short.pdf", pdf("short.pdf", b"not twelve bytes at all")),
                    ("/new/other.pdf", pdf("other.pdf", b"same size B")),
                    ("/new/ok.pdf", pdf("ok.pdf", b"fine")),
                ])
                .on_item(move |it: &IngestionBatchItem| {
                    log.lock()
                        .unwrap()
                        .push((it.path.clone().unwrap_or_default(), it.failure_code.clone()))
                })
                .await
                .map_err(s)?;
            let mut got: Vec<(String, String, Option<String>)> = done
                .result()
                .items
                .iter()
                .map(|i| {
                    (
                        i.path.clone().unwrap_or_default(),
                        i.status.as_str().to_owned(),
                        i.failure_code.clone(),
                    )
                })
                .collect();
            got.sort();
            ensure!(
                got == [
                    ("/new/ok.pdf".to_owned(), "ingesting".to_owned(), None),
                    ("/new/other.pdf".to_owned(), "failed".to_owned(), Some("FILE_CHANGED".to_owned())),
                    ("/new/short.pdf".to_owned(), "failed".to_owned(), Some("FILE_CHANGED".to_owned())),
                ],
                "items {got:?}"
            );
            // The wrong size is never sent; the wrong bytes are sent once, not retried.
            let keys: Vec<String> = form_posts(m)
                .await
                .iter()
                .filter_map(|p| {
                    p["form"]
                        .as_array()
                        .and_then(|f| f.iter().find(|x| str_at(x, "name") == "file"))
                        .map(|x| str_at(x, "fileName").to_owned())
                })
                .collect();
            let mut keys = keys;
            keys.sort();
            ensure!(keys == ["ok.pdf", "other.pdf"], "uploads {keys:?}");
            ensure!(failed.lock().unwrap().len() == 2, "on_item {:?}", failed.lock().unwrap());
            Ok(())
        }),
        "batch-upload.upload-failed" => Box::pin(async move {
            m.faults(json!({"failUploads": {"/new/b.pdf": true}})).await;
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/new/a.pdf", b"alpha"), ingest_item("/new/b.pdf", b"bravo")],
                true,
            )
            .await?;
            let seen = Arc::new(Mutex::new(Vec::new()));
            let log = seen.clone();
            let done = batch
                .upload([("/new/a.pdf", pdf("a.pdf", b"alpha")), ("/new/b.pdf", pdf("b.pdf", b"bravo"))])
                .on_item(move |it: &IngestionBatchItem| {
                    log.lock()
                        .unwrap()
                        .push((it.path.clone().unwrap_or_default(), it.failure_code.clone()))
                })
                .await
                .map_err(s)?;
            let b = done
                .result()
                .items
                .iter()
                .find(|i| i.path.as_deref() == Some("/new/b.pdf"))
                .ok_or("no b")?;
            ensure!(
                b.status.as_str() == "failed" && b.failure_code.as_deref() == Some("UPLOAD_FAILED"),
                "b {b:?}"
            );
            ensure!(
                *seen.lock().unwrap() == [("/new/b.pdf".to_owned(), Some("UPLOAD_FAILED".to_owned()))],
                "on_item {:?}",
                seen.lock().unwrap()
            );
            ensure!(
                completed_ids(m).await.iter().flatten().all(|id| *id != b.id),
                "b was reported to Complete"
            );
            let a = done
                .result()
                .items
                .iter()
                .find(|i| i.path.as_deref() == Some("/new/a.pdf"))
                .ok_or("no a")?;
            ensure!(a.status.as_str() == "ingesting", "a {a:?}");
            Ok(())
        }),
        "batch-upload.policy-renewal" => Box::pin(async move {
            // The call's own policy lasts a second, so its renewal margin is half a second; each file takes a second to
            // arrive, one at a time. The first goes with that policy; it is renewed before the second goes.
            m.faults(json!({"renewedPolicySeconds": 1, "uploadDelayMs": 1000})).await;
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/new/a.pdf", b"alpha"), ingest_item("/new/b.pdf", b"bravo")],
                true,
            )
            .await?;
            batch
                .upload([("/new/a.pdf", pdf("a.pdf", b"alpha")), ("/new/b.pdf", pdf("b.pdf", b"bravo"))])
                .concurrency(1)
                .await
                .map_err(s)?;
            let order = upload_order(&m.requests().await);
            ensure!(
                order == ["policy", "upload", "policy", "upload"],
                "POSTs {order:?}: the call's own policy, then its renewal between the uploads"
            );
            // A 403 that says the policy expired: renewed once, and that file sent again.
            m.reset().await;
            m.faults(json!({"firstCreatedPolicyExpired": true})).await;
            let c = client(m);
            let batch = hand_batch(&c, vec![ingest_item("/new/a.pdf", b"alpha")], true).await?;
            let done = batch.upload([("/new/a.pdf", pdf("a.pdf", b"alpha"))]).await.map_err(s)?;
            let policies = m.matching(|r| str_at(r, "path").ends_with("/upload-policies")).await.len();
            let posts = form_posts(m).await.len();
            ensure!(
                policies == 2 && posts == 2 && done.result().items.len() == 1 && done.result().items[0].status.as_str() == "ingesting",
                "{policies} policies, {posts} uploads, result {:?}",
                done.result()
            );
            Ok(())
        }),
        "batch-upload.checksum-mismatch" => Box::pin(async move {
            m.faults(json!({"checksumMismatch": {"/new/a.pdf": 1, "/new/b.pdf": 2}})).await;
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/new/a.pdf", b"alpha"), ingest_item("/new/b.pdf", b"bravo")],
                true,
            )
            .await?;
            let seen = Arc::new(Mutex::new(Vec::new()));
            let log = seen.clone();
            let done = batch
                .upload([("/new/a.pdf", pdf("a.pdf", b"alpha")), ("/new/b.pdf", pdf("b.pdf", b"bravo"))])
                .on_item(move |it: &IngestionBatchItem| log.lock().unwrap().push(it.failure_code.clone()))
                .await
                .map_err(s)?;
            let status = |p: &str| {
                done.result()
                    .items
                    .iter()
                    .find(|i| i.path.as_deref() == Some(p))
                    .map(|i| (i.status.as_str().to_owned(), i.failure_code.clone()))
            };
            ensure!(
                status("/new/a.pdf") == Some(("ingesting".to_owned(), None)),
                "a {:?}",
                status("/new/a.pdf")
            );
            ensure!(
                status("/new/b.pdf") == Some(("failed".to_owned(), Some("CHECKSUM_MISMATCH".to_owned()))),
                "b {:?}",
                status("/new/b.pdf")
            );
            ensure!(form_posts(m).await.len() == 4, "{} uploads: each twice", form_posts(m).await.len());
            ensure!(
                *seen.lock().unwrap() == [Some("CHECKSUM_MISMATCH".to_owned())],
                "on_item {:?}",
                seen.lock().unwrap()
            );
            Ok(())
        }),
        "batch-upload.second-call" => Box::pin(async move {
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/new/a.pdf", b"alpha"), ingest_item("/new/b.pdf", b"bravo")],
                true,
            )
            .await?;
            let files = || BatchFiles::by_path([("/new/a.pdf", pdf("a.pdf", b"alpha")), ("/new/b.pdf", pdf("b.pdf", b"bravo"))]);
            let first = batch.upload([("/new/a.pdf", pdf("a.pdf", b"alpha"))]).await.map_err(s)?;
            ensure!(first.result().not_given == ["/new/b.pdf"], "first {:?}", first.result());
            let second = batch.upload(files()).await.map_err(s)?;
            let r = second.result();
            ensure!(
                r.items.len() == 1 && r.items[0].path.as_deref() == Some("/new/b.pdf") && r.unmatched == ["/new/a.pdf"],
                "second {r:?}"
            );
            ensure!(form_posts(m).await.len() == 2, "{} uploads", form_posts(m).await.len());
            Ok(())
        }),
        "batch-upload.result" => Box::pin(async move {
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/new/a.pdf", b"alpha"), ingest_item("/new/b.pdf", b"bravo")],
                true,
            )
            .await?;
            let started = batch
                .upload([("/new/a.pdf", pdf("a.pdf", b"alpha")), ("/new/x.pdf", pdf("x.pdf", b"x"))])
                .await
                .map_err(s)?;
            let r: &BatchUpload = started.result();
            let _: &IngestionBatch = &r.batch;
            let _: &Vec<IngestionBatchItem> = &r.items;
            ensure!(
                r.batch.id == batch.id()
                    && r.items.len() == 1
                    && r.items[0].status.as_str() == "ingesting"
                    && r.not_given == ["/new/b.pdf"]
                    && r.unmatched == ["/new/x.pdf"],
                "result {r:?}"
            );
            let rest = batch.upload([("/new/b.pdf", pdf("b.pdf", b"bravo"))]).wait().await.map_err(s)?;
            let _: &IngestionBatch = &rest;
            ensure!(rest.id == batch.id() && rest.status.as_str() == "succeeded", "waited {rest:?}");
            Ok(())
        }),
        "batch-upload.cancel" => Box::pin(async move {
            m.faults(json!({"uploadDelayMs": 2000})).await;
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![ingest_item("/new/a.pdf", b"alpha"), ingest_item("/new/b.pdf", b"bravo")],
                true,
            )
            .await?;
            let token = CancellationToken::new();
            let t = token.clone();
            let b2 = batch.clone();
            let call = tokio::spawn(async move {
                b2.upload([("/new/a.pdf", pdf("a.pdf", b"alpha")), ("/new/b.pdf", pdf("b.pdf", b"bravo"))])
                    .cancel_on(t)
                    .await
            });
            let t0 = Instant::now();
            while form_posts(m).await.len() < 2 {
                ensure!(t0.elapsed() < Duration::from_secs(5), "the uploads never started");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            token.cancel();
            let r = call.await.map_err(s)?;
            ensure!(matches!(r, Err(Error::Cancelled)), "got {:?}", r.err());
            ensure!(
                t0.elapsed() < Duration::from_millis(1500),
                "the uploads were waited for, not aborted"
            );
            let t1 = Instant::now();
            while m.matching(|r| str_at(r, "event") == "upload-aborted").await.len() < 2 {
                ensure!(t1.elapsed() < Duration::from_secs(4), "the mock saw no aborted upload");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            ensure!(
                m.matching(|r| str_at(r, "path").ends_with("/cancel")).await.is_empty(),
                "the batch was cancelled"
            );
            ensure!(completed_ids(m).await.is_empty(), "an upload was reported");
            Ok(())
        }),
        "sync.concurrency" => Box::pin(async move {
            m.faults(json!({"uploadDelayMs": 150})).await;
            let items = (0..10)
                .map(|i| SyncItem::file(format!("/new/f{i}.pdf"), pdf(&format!("f{i}.pdf"), format!("file {i}").as_bytes())))
                .collect();
            client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(items))
                .await
                .map_err(s)?;
            let up = m.get("/__mock/uploads").await;
            ensure!(up["maxInFlight"] == 6, "most at once {}", up["maxInFlight"]);
            Ok(())
        }),
        "sync.complete-groups" => Box::pin(async move {
            let items = (0..150)
                .map(|i| SyncItem::file(format!("/new/g{i}.pdf"), pdf(&format!("g{i}.pdf"), format!("group {i}").as_bytes())))
                .collect();
            let report = client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(items))
                .await
                .map_err(s)?;
            let groups: Vec<usize> = bodies(m, "POST", "complete-uploads")
                .await
                .iter()
                .map(|b| b["itemIds"].as_array().map(Vec::len).unwrap_or(0))
                .collect();
            ensure!(
                !groups.is_empty() && groups.iter().all(|n| (1..=100).contains(n)),
                "groups {groups:?}"
            );
            ensure!(
                groups.iter().sum::<usize>() == 150 && report.items.len() == 150,
                "groups {groups:?}"
            );
            Ok(())
        }),
        "sync.policy-renewal" => Box::pin(async move {
            // Start's policy lasts a second, so its renewal margin is half a second; each file takes a second to arrive,
            // one at a time. The first goes with Start's policy; it is renewed before the second goes.
            m.faults(json!({"policySeconds": 1, "uploadDelayMs": 1000})).await;
            let items = vec![
                SyncItem::file("/new/r1.pdf", pdf("r1.pdf", b"renew one")),
                SyncItem::file("/new/r2.pdf", pdf("r2.pdf", b"renew two")),
            ];
            client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(items).concurrency(1))
                .await
                .map_err(s)?;
            let order = upload_order(&m.requests().await);
            ensure!(
                order == ["upload", "policy", "upload"],
                "POSTs {order:?}: the renewal between the uploads"
            );
            // A 403 saying the policy expired renews it once, and the file is sent again.
            m.reset().await;
            m.faults(json!({"startPolicyExpired": true})).await;
            let items = (0..3)
                .map(|i| {
                    SyncItem::file(
                        format!("/new/e{i}.pdf"),
                        pdf(&format!("e{i}.pdf"), format!("expired {i}").as_bytes()),
                    )
                })
                .collect();
            let report = client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(items))
                .await
                .map_err(s)?;
            let renewals = m.matching(|r| str_at(r, "path").ends_with("/upload-policies")).await.len();
            let posts = m.matching(|r| str_at(r, "path") == "/__s3/").await.len();
            ensure!(renewals == 1 && posts == 6, "{renewals} renewals, {posts} uploads");
            ensure!(
                report.items.iter().all(|i| i.status.as_str() == "indexed"),
                "items {:?}",
                report.items
            );
            Ok(())
        }),
        "sync.checksum-mismatch" => Box::pin(async move {
            m.faults(json!({"checksumMismatch": {"/new/a.pdf": 1}})).await;
            let items = vec![
                SyncItem::file("/new/a.pdf", pdf("a.pdf", b"aaaa")),
                SyncItem::file("/new/b.pdf", pdf("b.pdf", b"bbbb")),
            ];
            let report = client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(items))
                .await
                .map_err(s)?;
            let posts = m.matching(|r| str_at(r, "path") == "/__s3/").await;
            let a_posts = posts
                .iter()
                .filter(|p| {
                    p["form"]
                        .as_array()
                        .and_then(|f| f.last())
                        .is_some_and(|f| f["fileName"] == "a.pdf")
                })
                .count();
            let a_id = report
                .items
                .iter()
                .find(|i| i.path.as_deref() == Some("/new/a.pdf"))
                .map(|i| i.id.clone())
                .unwrap_or_default();
            let a_completes = bodies(m, "POST", "complete-uploads")
                .await
                .iter()
                .filter(|b| b["itemIds"].as_array().is_some_and(|ids| ids.iter().any(|x| x == &json!(a_id))))
                .count();
            ensure!(
                a_posts == 2 && a_completes == 2 && posts.len() == 3,
                "a uploaded {a_posts}, completed {a_completes}; {} uploads",
                posts.len()
            );
            ensure!(
                report.items.iter().all(|i| i.status.as_str() == "indexed"),
                "items {:?}",
                report.items
            );
            Ok(())
        }),
        "sync.estimate-unresolved" => Box::pin(async move {
            // a.pdf is a conflict the policy leaves unresolved, b.pdf is new, and policy-5 is removed: the estimate
            // confirm sees (before the resolver runs) prices a and b, the most the batch could cost, not the removal.
            m.faults(json!({"planConflicts": {"/new/a.pdf": "duplicate_path"}})).await;
            let c = client(m);
            let seen = Arc::new(Mutex::new(None));
            let keep = seen.clone();
            let resolved = Arc::new(AtomicUsize::new(0));
            let r = resolved.clone();
            let input = SyncInput::items(vec![
                SyncItem::file("/new/a.pdf", pdf("a.pdf", b"conflict a")),
                SyncItem::file("/new/b.pdf", pdf("b.pdf", b"plain b")),
                SyncItem::remove("/policies/policy-5.pdf"),
            ])
            .confirm(move |p: &SyncPlan| {
                let unresolved = p
                    .items
                    .iter()
                    .filter(|i| i.resolution.as_ref().map(|r| r.as_str()) == Some("unresolved"))
                    .count();
                *keep.lock().unwrap() = Some((p.estimate.as_ref().map(|e| e.documents), unresolved));
                false
            })
            .resolver(move |_: &IngestionBatchItem| {
                r.fetch_add(1, Ordering::SeqCst);
                Some(IngestionItemResolution::Overwrite)
            });
            let _ = c.knowledge_base(KB).ingestion().sync(input).await;
            let got = *seen.lock().unwrap();
            ensure!(
                got == Some((Some(2), 1)) && resolved.load(Ordering::SeqCst) == 0,
                "confirm saw {got:?}"
            );
            let names: Vec<Vec<String>> = estimate_calls(m)
                .await
                .iter()
                .map(|ds| ds.iter().map(|d| str_at(d, "name").to_owned()).collect())
                .collect();
            ensure!(names == [vec!["a.pdf".to_owned(), "b.pdf".to_owned()]], "sync priced {names:?}");
            // batch.estimate_upload prices the same items.
            m.reset().await;
            m.faults(json!({"planConflicts": {"/new/a.pdf": "duplicate_path"}})).await;
            let c = client(m);
            let batch = hand_batch(
                &c,
                vec![
                    ingest_item("/new/a.pdf", b"conflict a"),
                    ingest_item("/new/b.pdf", b"plain b"),
                    remove_item("/policies/policy-5.pdf"),
                ],
                false,
            )
            .await?;
            let est = batch.estimate_upload().await.map_err(s)?;
            let names: Vec<Vec<String>> = estimate_calls(m)
                .await
                .iter()
                .map(|ds| ds.iter().map(|d| str_at(d, "name").to_owned()).collect())
                .collect();
            ensure!(
                est.documents == 2 && names == [vec!["a.pdf".to_owned(), "b.pdf".to_owned()]],
                "estimate_upload priced {names:?}"
            );
            Ok(())
        }),
        "sync.resolve" => Box::pin(async move {
            m.faults(json!({"planConflicts": {"/new/a.pdf": "duplicate_path", "/new/b.pdf": "path_taken"}}))
                .await;
            let files = || {
                vec![
                    SyncItem::file("/new/a.pdf", pdf("a.pdf", b"conflict a")),
                    SyncItem::file("/new/b.pdf", pdf("b.pdf", b"conflict b")),
                    SyncItem::file("/new/c.pdf", pdf("c.pdf", b"plain c")),
                ]
            };
            let input = SyncInput::items(files()).resolver(|it: &IngestionBatchItem| match it.path.as_deref() {
                Some("/new/a.pdf") => Some(IngestionItemResolution::Overwrite),
                _ => Some(IngestionItemResolution::Add),
            });
            let report = client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            let sent: Vec<String> = bodies(m, "PATCH", "/items/")
                .await
                .iter()
                .map(|b| str_at(b, "resolution").to_owned())
                .collect();
            ensure!(
                sent.len() == 2 && sent.contains(&"overwrite".to_owned()) && sent.contains(&"add".to_owned()),
                "resolutions {sent:?}"
            );
            ensure!(
                report.items.iter().all(|i| i.status.as_str() == "indexed"),
                "items {:?}",
                report.items
            );
            m.reset().await;
            m.faults(json!({"planConflicts": {"/new/a.pdf": "duplicate_path"}})).await;
            let r = client(m).knowledge_base(KB).ingestion().sync(SyncInput::items(files())).await;
            ensure!(
                r.as_ref().err().and_then(Error::code) == Some("INGESTION_BATCH_UNRESOLVED"),
                "got {:?}",
                r.err()
            );
            let batches = client(m)
                .knowledge_base(KB)
                .ingestion()
                .batches()
                .list()
                .collect()
                .await
                .map_err(s)?;
            ensure!(batches.len() == 1 && batches[0].status.as_str() == "planned", "batches {batches:?}");
            ensure!(
                m.matching(|r| str_at(r, "path").ends_with("/start")).await.is_empty(),
                "the batch was started"
            );
            Ok(())
        }),
        "sync.confirm" => Box::pin(async move {
            let saw = Arc::new(Mutex::new(Vec::new()));
            let seen = saw.clone();
            let input = SyncInput::items(vec![SyncItem::file("/new/a.pdf", pdf("a.pdf", b"maybe"))]).confirm(move |plan: &SyncPlan| {
                seen.lock()
                    .unwrap()
                    .push((plan.batch.status.as_str().to_owned(), plan.batch.item_count));
                false
            });
            let r = client(m).knowledge_base(KB).ingestion().sync(input).await;
            let e = r.err().ok_or("the sync went on")?;
            // Declined: the SDK's own CANCELLED (status 0), with the report as planned.
            ensure!(
                e.code() == Some("CANCELLED")
                    && e.status() == Some(0)
                    && e.report()
                        .is_some_and(|r| r.items.len() == 1 && r.batch.status.as_str() == "planned"),
                "got {e:?}"
            );
            let cancels = m.matching(|r| str_at(r, "path").ends_with("/cancel")).await;
            ensure!(
                *saw.lock().unwrap() == [("planned".to_owned(), 1)],
                "confirm saw {:?}",
                saw.lock().unwrap()
            );
            ensure!(cancels.len() == 1, "{} cancels", cancels.len());
            ensure!(
                m.matching(|r| str_at(r, "path").ends_with("/start") || str_at(r, "path") == "/__s3/")
                    .await
                    .is_empty(),
                "the batch went on"
            );
            Ok(())
        }),
        "sync.remove-missing" => Box::pin(async move {
            let dir = folder_of(&[("policy-1.pdf", "doc1"), ("new-one.pdf", "a new one")]);
            let input = SyncInput::dir(&dir).folder("/policies/").remove_missing(true);
            client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            let create = bodies(m, "POST", &format!("/v3/knowledge-bases/{KB}/ingestion-batches"))
                .await
                .remove(0);
            let items = create["items"].as_array().cloned().unwrap_or_default();
            let mut removed: Vec<String> = items
                .iter()
                .filter(|i| i["action"] == "remove")
                .map(|i| str_at(i, "path").to_owned())
                .collect();
            removed.sort();
            let want: Vec<String> = (2..=7).map(|i| format!("/policies/policy-{i}.pdf")).collect();
            ensure!(removed == want, "removed {removed:?}");
            ensure!(items.iter().filter(|i| i["action"] == "ingest").count() == 2, "items {items:?}");
            let listed = m
                .matching(|r| str_at(r, "path") == format!("/v3/knowledge-bases/{KB}/documents") && str_at(r, "method") == "GET")
                .await;
            ensure!(
                listed
                    .iter()
                    .any(|r| str_at(r, "query").contains("filter%5Bfolder%5D%5Beq%5D=%2Fpolicies%2F")),
                "list {listed:?}"
            );
            Ok(())
        }),
        "sync.progress" => Box::pin(async move {
            m.faults(json!({"ingestReads": 1})).await;
            let phases = Arc::new(Mutex::new(Vec::<(String, u64, u64)>::new()));
            let items_seen = Arc::new(AtomicUsize::new(0));
            let (p, n) = (phases.clone(), items_seen.clone());
            let dir = folder_of(&[("a.pdf", "alpha"), ("b.pdf", "bravo!"), ("c.pdf", "charlie")]);
            let input = SyncInput::dir(&dir)
                .folder("/new/")
                .on_progress(move |e: &IngestionProgress| p.lock().unwrap().push((e.phase.as_str().to_owned(), e.done, e.total)))
                .on_item(move |_| {
                    n.fetch_add(1, Ordering::SeqCst);
                });
            client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            let all = phases.lock().unwrap().clone();
            let mut order: Vec<String> = Vec::new();
            for (ph, _, _) in &all {
                if order.last() != Some(ph) {
                    order.push(ph.clone());
                }
            }
            // Bytes are sent once the batch is planned and started, so upload follows planned (PROTOCOL.md 15's steps).
            ensure!(
                order == ["checksum", "planning", "planned", "upload", "queued", "processing", "succeeded"],
                "phases {order:?}"
            );
            let last_upload = all.iter().rev().find(|(ph, _, _)| ph == "upload").cloned().unwrap_or_default();
            ensure!(last_upload.1 == 18 && last_upload.2 == 18, "upload bytes {last_upload:?}");
            let last_checksum = all.iter().rev().find(|(ph, _, _)| ph == "checksum").cloned().unwrap_or_default();
            ensure!(last_checksum.1 == 3 && last_checksum.2 == 3, "checksum {last_checksum:?}");
            ensure!(
                items_seen.load(Ordering::SeqCst) == 3,
                "on_item {}",
                items_seen.load(Ordering::SeqCst)
            );
            Ok(())
        }),
        "sync.plan-failed" => Box::pin(async move {
            // A plan that ends the batch failed returns the batch's own failure (code and message); nothing starts.
            let cases = [
                (
                    json!({"planConflicts": {"/new/a.pdf": "duplicate_path"}}),
                    "conflict_policy_fail",
                    "policy rule is `fail`",
                ),
                (json!({"planFails": true}), "planning_failed", "Planning could not finish"),
            ];
            for (faults, code, says) in cases {
                m.reset().await;
                m.faults(faults).await;
                let items = vec![SyncItem::file("/new/a.pdf", pdf("a.pdf", b"alpha"))];
                let policy = IngestionPolicy {
                    on_conflict: Some(ConflictRules {
                        default: Some(ConflictRule::Fail),
                        ..Default::default()
                    }),
                    ..Default::default()
                };
                let r = client(m)
                    .knowledge_base(KB)
                    .ingestion()
                    .sync(SyncInput::items(items).policy(policy))
                    .await;
                ensure!(
                    matches!(&r, Err(e) if e.code() == Some(code) && e.to_string().contains(says)),
                    "got {:?}, want {code}: {says}",
                    r.err()
                );
                ensure!(
                    m.matching(|r| str_at(r, "path").ends_with("/start")).await.is_empty(),
                    "the batch was started"
                );
            }
            Ok(())
        }),
        "sync.cancel" => Box::pin(async move {
            // The first six uploads are answered; every later one is held until the client lets go of it, so the
            // uploads in flight are still in flight when the cancel lands.
            m.faults(json!({"holdUploadsAfter": 6})).await;
            let token = CancellationToken::new();
            let finished = Arc::new(AtomicUsize::new(0));
            let f = finished.clone();
            let items = (0..16)
                .map(|i| {
                    SyncItem::file(
                        format!("/new/x{i}.pdf"),
                        pdf(&format!("x{i}.pdf"), format!("cancel {i}").as_bytes()),
                    )
                })
                .collect();
            // Uploads that finished, as on_progress reports them: on_item reaches an item only once it is final.
            let uploaded = Arc::new(AtomicUsize::new(0));
            let u = uploaded.clone();
            let input = SyncInput::items(items)
                .cancel_ingestion(true)
                .on_item(move |_| {
                    f.fetch_add(1, Ordering::SeqCst);
                })
                .on_progress(move |p: &IngestionProgress| {
                    if p.phase.as_str() == "upload" && p.item.is_some() {
                        u.fetch_add(1, Ordering::SeqCst);
                    }
                });
            let c = client(m);
            let t = token.clone();
            let call = tokio::spawn(async move { c.knowledge_base(KB).ingestion().sync(input).cancel_on(t).await });
            // Cancel once the first six have finished and a later upload is held in flight by the mock.
            let t0 = Instant::now();
            while uploaded.load(Ordering::SeqCst) < 6 || m.matching(|r| str_at(r, "path") == "/__s3/").await.len() < 7 {
                ensure!(t0.elapsed() < Duration::from_secs(5), "uploads never got going");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            token.cancel();
            let r = call.await.map_err(s)?;
            ensure!(r.as_ref().err().is_some_and(Error::is_cancelled), "got {:?}", r.err());
            // No item was final before the cancellation (accepted uploads are not), so none reached on_item, and none
            // reaches it after the cancellation error.
            ensure!(
                finished.load(Ordering::SeqCst) == 0,
                "{} items reached on_item",
                finished.load(Ordering::SeqCst)
            );
            let posts = m.matching(|r| str_at(r, "path") == "/__s3/").await.len();
            ensure!(posts < 16, "{posts} uploads started");
            let cancel = bodies(m, "POST", "/cancel").await;
            ensure!(cancel.len() == 1 && cancel[0] == json!({"stopRunning": true}), "cancel {cancel:?}");
            // Uploads in flight were aborted: the mock logs each as it lets go of it, and stores nothing for it.
            let t0 = Instant::now();
            loop {
                let aborted = m.matching(|r| r["event"] == "upload-aborted").await.len();
                let stored = m.get("/__mock/uploads").await["objects"].as_array().map(Vec::len).unwrap_or(0);
                if aborted + stored >= posts {
                    ensure!(aborted >= 1, "{stored} stored of {posts} started, none aborted");
                    break;
                }
                ensure!(
                    t0.elapsed() < Duration::from_secs(5),
                    "{aborted} aborted, {stored} stored of {posts}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Ok(())
        }),
        // ------------------------------------------------------------------ 0.10.1
        "client.request-timeout" => Box::pin(async move {
            // Rust's request timeout is the default HTTP client's connect and read timeouts: each read waits at most this
            // long, which covers the wait for the headers.
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .request_timeout(Some(Duration::from_millis(300)))
                .build()
                .map_err(s)?;
            m.faults(held("GetKnowledgeBase", 3)).await;
            let t0 = Instant::now();
            let e = c.knowledge_base(KB).get().await.err().ok_or("no error")?;
            ensure!(
                matches!(e, Error::Connection(_)) && e.code() == Some("CONNECTION_ERROR") && e.status() == Some(0),
                "got {e:?}"
            );
            let chain = error_chain(&e);
            ensure!(
                chain.contains("GetKnowledgeBase") && chain.contains("timed out"),
                "the message names neither the operation nor the timeout: {chain}"
            );
            let attempts = m.matching(|r| str_at(r, "path") == format!("/v3/knowledge-bases/{KB}")).await.len();
            ensure!(attempts == 3, "{attempts} attempts; want 3, retried as a read is");
            ensure!(t0.elapsed() < Duration::from_secs(10), "took too long");
            tokio::time::sleep(Duration::from_millis(200)).await;
            let closed = mock_events(m, "request-aborted", "GetKnowledgeBase").await;
            ensure!(closed == 3, "{closed} attempts closed; want each of the 3");
            // A watch whose stream has only keep-alives for longer than the timeout is not cut.
            m.reset().await;
            m.faults(json!({"watchKeepAliveMs": 100})).await;
            let mut watch = c.knowledge_base(KB).watch().await.map_err(s)?;
            let changer = c.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1200)).await;
                if let Ok(current) = changer.knowledge_base(KB).get().await {
                    let _ = changer
                        .knowledge_base(KB)
                        .update()
                        .description("Still watching")
                        .if_match(&current.etag)
                        .await;
                }
            });
            let events = tokio::time::timeout(
                Duration::from_secs(10),
                take(&mut watch, |e| matches!(e, KnowledgeBaseEvent::KnowledgeBaseUpdated(_))),
            )
            .await
            .map_err(s)?
            .map_err(s)?;
            ensure!(
                events.len() == 2 && matches!(events[0], KnowledgeBaseEvent::Snapshot(_)),
                "events {events:?}"
            );
            let connections = m
                .matching(|r| str_at(r, "path") == format!("/v3/knowledge-bases/{KB}/events"))
                .await
                .len();
            ensure!(connections == 1, "{connections} watch connections; want one, never cut");
            Ok(())
        }),
        "files.storage-stall" => Box::pin(async move {
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .storage_stall_timeout(Some(Duration::from_millis(300)))
                .build()
                .map_err(s)?;
            let data = b"Staff receive 20 days of annual leave.";
            let batch = hand_batch(&c, vec![ingest_item("/new/a.pdf", data)], true).await?;
            m.faults(held("PostObject", 3)).await;
            let up = batch
                .upload(BatchFiles::by_path([("/new/a.pdf".to_owned(), pdf("a.pdf", data))]))
                .await
                .map_err(s)?;
            let items = &up.result().items;
            ensure!(
                items.len() == 1 && items[0].status.as_str() == "failed" && items[0].failure_code.as_deref() == Some("UPLOAD_FAILED"),
                "items {items:?}"
            );
            let detail = items[0].failure_detail.clone().unwrap_or_default();
            ensure!(detail.contains("storage sent nothing for 300 ms"), "detail {detail}");
            let posts = form_posts(m).await.len();
            ensure!(posts == 3, "{posts} form POSTs; want 3, retried as a send with no response is");
            tokio::time::sleep(Duration::from_millis(200)).await;
            let closed = mock_events(m, "request-aborted", "PostObject").await;
            ensure!(closed == 3, "{closed} stalled attempts closed; want 3");
            Ok(())
        }),
        "files.slow-not-stalled" => Box::pin(async move {
            let c = Client::builder(WORKSPACE, Auth::token(PAT))
                .endpoint(&m.base)
                .storage_stall_timeout(Some(Duration::from_millis(2500)))
                .build()
                .map_err(s)?;
            let big: Vec<u8> = (0..32 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
            let batch = hand_batch(&c, vec![ingest_item("/hand/large.pdf", &big)], true).await?;
            m.faults(json!({"uploadReadBytesPerSecond": 8 * 1024 * 1024})).await;
            let t0 = Instant::now();
            let up = batch
                .upload(BatchFiles::by_path([("/hand/large.pdf".to_owned(), pdf("large.pdf", &big))]))
                .await
                .map_err(s)?;
            let items = &up.result().items;
            ensure!(items.len() == 1 && items[0].status.as_str() == "ingesting", "items {items:?}");
            ensure!(
                t0.elapsed() > Duration::from_millis(2500),
                "took {:?}: not longer than the stall timeout in all",
                t0.elapsed()
            );
            let posts = form_posts(m).await.len();
            ensure!(posts == 1, "{posts} form POSTs; want one attempt");
            Ok(())
        }),
        "batch-upload.unreadable-expiry" => Box::pin(async move {
            // Start's policy is short, so the first upload renews it; every renewal then has no expiresAt.
            m.faults(json!({"policySeconds": 1, "policyExpiresAt": null})).await;
            let c = client(m);
            let files: Vec<(String, Vec<u8>)> = (0..3)
                .map(|n| (format!("/new/f{n}.pdf"), format!("file {n}").into_bytes()))
                .collect();
            let upload = |batch: &scope::BatchScope| {
                batch
                    .upload(BatchFiles::by_path(files.iter().map(|(p, d)| (p.clone(), pdf("f.pdf", d)))))
                    .concurrency(1)
            };
            let batch = hand_batch(&c, files.iter().map(|(p, d)| ingest_item(p, d)).collect(), true).await?;
            let before = policies_asked(m).await;
            let up = upload(&batch).await.map_err(s)?;
            let items = &up.result().items;
            ensure!(
                items.len() == 3 && items.iter().all(|i| i.status.as_str() == "ingesting"),
                "items {items:?}"
            );
            let asked = policies_asked(m).await - before;
            ensure!(asked >= 3, "{asked} policies asked for; want one before each of 3 uploads");
            let after = policies_asked(m).await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            ensure!(policies_asked(m).await == after, "a renewal after the call returned");
            // An expiresAt that is not a time fails the call that returned it, clearly: never a silent loss of renewal.
            m.reset().await;
            m.faults(json!({"policySeconds": 1, "policyExpiresAt": "not a date"})).await;
            let batch = hand_batch(&c, files.iter().map(|(p, d)| ingest_item(p, d)).collect(), true).await?;
            let e = upload(&batch).await.err().ok_or("the upload went on")?;
            ensure!(e.code() == Some("DECODE_FAILED"), "got {e:?}");
            Ok(())
        }),
        "sync.no-confirm-no-estimate" => Box::pin(async move {
            m.faults(status("EstimateIngestion", &[(503, 0), (503, 0), (503, 0)])).await;
            let input = SyncInput::items(vec![
                SyncItem::file("/new/a.pdf", pdf("a.pdf", b"a")),
                SyncItem::file("/new/b.pdf", pdf("b.pdf", b"b")),
            ]);
            let report = client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            ensure!(
                report.batch.status.as_str() == "succeeded",
                "batch {}",
                report.batch.status.as_str()
            );
            let priced = m.matching(|r| str_at(r, "path").ends_with("/ingestions:estimate")).await.len();
            ensure!(priced == 0, "{priced} EstimateIngestion calls; want none");
            Ok(())
        }),
        "sync.confirm-estimate-unavailable" => Box::pin(async move {
            m.faults(status("EstimateIngestion", &[(400, 0)])).await;
            let saw = Arc::new(Mutex::new(Vec::new()));
            let seen = saw.clone();
            let items = || {
                vec![
                    SyncItem::file("/new/a.pdf", pdf("a.pdf", b"a")),
                    SyncItem::file("/new/b.pdf", pdf("b.pdf", b"b")),
                ]
            };
            let input = SyncInput::items(items()).confirm(move |plan: &SyncPlan| {
                seen.lock().unwrap().push((
                    plan.estimate.is_none(),
                    plan.estimate_error.as_ref().and_then(|e| e.status()),
                    plan.items.len(),
                ));
                true
            });
            let report = client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            ensure!(
                report.batch.status.as_str() == "succeeded",
                "batch {}",
                report.batch.status.as_str()
            );
            ensure!(
                *saw.lock().unwrap() == [(true, Some(400), 2)],
                "confirm saw {:?}; want no estimate and the 400 as estimate_error",
                saw.lock().unwrap()
            );
            m.reset().await;
            m.faults(status("EstimateIngestion", &[(400, 0)])).await;
            let e = client(m)
                .knowledge_base(KB)
                .ingestion()
                .estimate_sync(SyncInput::items(items()))
                .await
                .err()
                .ok_or("sync.estimate went on")?;
            ensure!(e.status() == Some(400), "sync.estimate got {e:?}");
            Ok(())
        }),
        "if-match.never-wildcard" => Box::pin(async move {
            let c = client(m);
            let e = c
                .knowledge_base(KB)
                .update()
                .description("Any version")
                .if_match("*")
                .await
                .err()
                .ok_or("the mock took an unasked *")?;
            ensure!(e.code() == Some("IF_MATCH_WILDCARD_NOT_ASKED"), "got {e:?}");
            m.faults(json!({"allowIfMatchWildcard": true})).await;
            c.knowledge_base(KB)
                .update()
                .description("Any version")
                .if_match("*")
                .await
                .map_err(s)?;
            let (patch, _) = last_patch(m).await;
            ensure!(header(&patch, "if-match") == Some("*"), "sent {:?}", header(&patch, "if-match"));
            // A sync, which sends If-Match on Start, sends the plan's own ETag.
            m.reset().await;
            let report = client(m)
                .knowledge_base(KB)
                .ingestion()
                .sync(SyncInput::items(vec![SyncItem::file("/new/a.pdf", pdf("a.pdf", b"a"))]))
                .await
                .map_err(s)?;
            ensure!(
                report.batch.status.as_str() == "succeeded",
                "batch {}",
                report.batch.status.as_str()
            );
            let starts = m.matching(|r| str_at(r, "path").ends_with("/start")).await;
            let sent = starts.first().and_then(|r| header(r, "if-match")).unwrap_or_default().to_owned();
            ensure!(starts.len() == 1 && !sent.is_empty() && sent != "*", "Start sent If-Match {sent:?}");
            Ok(())
        }),
        "watch.snapshot-not-progress" => Box::pin(async move {
            let path = format!("/v3/knowledge-bases/{KB}/events");
            let watches = || async {
                m.matching(|r| str_at(r, "method") == "GET" && str_at(r, "path") == path)
                    .await
                    .len()
            };
            // Four connections in a row that each end after their snapshot (a fresh id every time): STREAM_LOST.
            m.faults(json!({"watchDrops": {"count": 4, "afterEvents": 1}})).await;
            let c = client(m);
            let mut watch = c.knowledge_base(KB).watch().await.map_err(s)?;
            let mut seen = 0;
            let failed = loop {
                match watch.next().await {
                    Some(Ok(KnowledgeBaseEvent::Snapshot(_))) => seen += 1,
                    Some(Ok(other)) => return Err(format!("unexpected event {other:?}")),
                    Some(Err(e)) => break Some(e),
                    None => break None,
                }
            };
            ensure!(
                matches!(&failed, Some(e) if e.code() == Some("STREAM_LOST")) && seen == 4 && watches().await == 4,
                "{seen} snapshots, error {failed:?}, {} connections; want four snapshots, then STREAM_LOST",
                watches().await
            );
            // Three such connections, then one that stays open and brings a change: the watch carries on to it.
            m.reset().await;
            m.faults(json!({"watchDrops": {"count": 3, "afterEvents": 1}})).await;
            let mut watch = c.knowledge_base(KB).watch().await.map_err(s)?;
            let changer = c.clone();
            let (base, http) = (m.base.clone(), m.http.clone());
            tokio::spawn(async move {
                let path = format!("/v3/knowledge-bases/{KB}/events");
                for _ in 0..200 {
                    let logged: Vec<Value> = match http.get(format!("{base}/__mock/requests")).send().await {
                        Ok(r) => r.json().await.unwrap_or_default(),
                        Err(_) => Vec::new(),
                    };
                    let n = logged
                        .iter()
                        .filter(|r| str_at(r, "method") == "GET" && str_at(r, "path") == path)
                        .count();
                    if n >= 4 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                if let Ok(current) = changer.knowledge_base(KB).get().await {
                    let _ = changer
                        .knowledge_base(KB)
                        .update()
                        .description("Still watching")
                        .if_match(&current.etag)
                        .await;
                }
            });
            let events = tokio::time::timeout(
                Duration::from_secs(20),
                take(&mut watch, |e| matches!(e, KnowledgeBaseEvent::KnowledgeBaseUpdated(_))),
            )
            .await
            .map_err(s)?
            .map_err(s)?;
            ensure!(
                events.len() == 5 && events[..4].iter().all(|e| matches!(e, KnowledgeBaseEvent::Snapshot(_))),
                "events {events:?}"
            );
            Ok(())
        }),
        "batch-upload.policy-sets-key" => Box::pin(async move {
            // The mock's policy has its own `key`, as createPresignedPost makes it, and refuses a form that repeats a field.
            let c = client(m);
            let files: Vec<(String, Vec<u8>)> = (1..=2)
                .map(|n| (format!("/hand/file-{n}.pdf"), format!("%PDF hand {n}").into_bytes()))
                .collect();
            let batch = hand_batch(&c, files.iter().map(|(p, d)| ingest_item(p, d)).collect(), true).await?;
            let up = batch
                .upload(BatchFiles::by_path(files.iter().map(|(p, d)| (p.clone(), pdf("f.pdf", d)))))
                .await
                .map_err(s)?;
            let items = &up.result().items;
            ensure!(
                items.len() == 2 && items.iter().all(|i| i.status.as_str() == "ingesting"),
                "items {items:?}"
            );
            let object_keys: Vec<String> = batch
                .items()
                .list()
                .collect()
                .await
                .map_err(s)?
                .into_iter()
                .filter_map(|i| i.object_key)
                .collect();
            let sent = m.matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == "/__s3/").await;
            ensure!(sent.len() == 2, "{} forms for 2 files", sent.len());
            for f in &sent {
                let keys: Vec<&str> = f["form"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|p| str_at(p, "name").eq_ignore_ascii_case("key"))
                    .map(|p| str_at(p, "value"))
                    .collect();
                ensure!(keys.len() == 1 && object_keys.iter().any(|k| k == keys[0]), "key fields {keys:?}");
            }
            let refused = m.matching(|r| str_at(r, "event") == "storage-refused-repeated-field").await;
            ensure!(refused.is_empty(), "storage refused {refused:?}");
            Ok(())
        }),
        "errors.409-retry-after" => Box::pin(async move {
            let c = client(m);
            // A new document's path, which the started batch reserves until its upload arrives.
            hand_batch(&c, vec![ingest_item("/reserved/file-1.pdf", b"%PDF hand 1")], true).await?;
            let kb = c.knowledge_base(KB);
            let is_409 = |r: &Result<_, Error>| matches!(r, Err(Error::Conflict(e)) if e.code == ErrorCode::TARGET_IN_USE && e.retry_after_seconds == Some(30));
            let created = kb
                .documents()
                .create(pdf("file-1.pdf", b"%PDF another"))
                .folder("/reserved/")
                .await
                .map(|_| ());
            ensure!(is_409(&created), "CreateDocument: {created:?}");
            let sent = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == format!("/v3/knowledge-bases/{KB}/documents"))
                .await;
            ensure!(sent.len() == 1, "CreateDocument sent {} times; a 409 is not retried", sent.len());
            let other = kb
                .documents()
                .create(pdf("other.pdf", b"%PDF other"))
                .folder("/reserved/")
                .await
                .map_err(s)?;
            let current = kb.document(other.id()).get().await.map_err(s)?;
            let renamed = kb
                .document(other.id())
                .update()
                .name("file-1.pdf")
                .if_match(current.etag.clone())
                .await
                .map(|_| ());
            ensure!(is_409(&renamed), "rename: {renamed:?}");
            Ok(())
        }),
        "telemetry.batch-item" => Box::pin(async move {
            use tracing_subscriber::layer::SubscriberExt;
            let capture = Capture::default();
            let _guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(capture.clone()));
            let c = client(m);
            let files = [
                ("/new/a.pdf", &b"a"[..]),
                ("/new/b.pdf", &b"b"[..]),
                ("/new/broken.pdf", &b"broken"[..]),
            ];
            let batch = hand_batch(&c, files.iter().map(|(p, d)| ingest_item(p, d)).collect(), true).await?;
            m.faults(json!({"failUploads": {"/new/broken.pdf": true}})).await;
            batch
                .upload(BatchFiles::by_path(files.iter().map(|(p, d)| ((*p).to_owned(), pdf("f.pdf", d)))))
                .await
                .map_err(s)?;
            let spans = capture.0.lock().unwrap().clone();
            let items: Vec<&SpanRec> = spans.iter().filter(|r| r.name == "caitlyn.batch.item").collect();
            ensure!(items.len() == 3, "{} caitlyn.batch.item spans; want 3", items.len());
            for r in items {
                let field = |k: &str| r.fields.get(k).cloned().unwrap_or_default();
                ensure!(
                    field("caitlyn.ingestion_batch.id") == batch.ingestion_batch_id()
                        && !field("caitlyn.ingestion_batch.item.id").is_empty(),
                    "fields {:?}",
                    r.fields
                );
                let events: Vec<String> = r.events.iter().map(|e| e.get("message").cloned().unwrap_or_default()).collect();
                if field("caitlyn.ingestion_batch.item.path") == "/new/broken.pdf" {
                    ensure!(
                        events.starts_with(&["opened".to_owned(), "checked".to_owned(), "sending".to_owned()])
                            && events.last().map(String::as_str) == Some("failed"),
                        "broken.pdf: events {events:?}"
                    );
                    let last = r.events.last().cloned().unwrap_or_default();
                    ensure!(
                        last.get("caitlyn.error.code").map(String::as_str) == Some("UPLOAD_FAILED"),
                        "failed event {last:?}"
                    );
                    ensure!(field("otel.status_code") == "ERROR", "status {:?}", field("otel.status_code"));
                } else {
                    ensure!(
                        events == ["opened", "checked", "sending", "sent", "completed"],
                        "{}: events {events:?}",
                        field("caitlyn.ingestion_batch.item.path")
                    );
                }
            }
            Ok(())
        }),
        _ => return None,
    })
}

/// n hold faults for an operation: requests the mock never answers.
fn held(op: &str, n: usize) -> Value {
    json!({"status": {op: vec![json!({"hold": true}); n]}})
}

/// The mock's own log entries of this kind (request-aborted, request-held) for this operation.
async fn mock_events(m: &Mock, event: &str, op: &str) -> usize {
    m.requests()
        .await
        .iter()
        .filter(|r| str_at(r, "event") == event && str_at(r, "op") == op)
        .count()
}

async fn policies_asked(m: &Mock) -> usize {
    m.matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").ends_with("/upload-policies"))
        .await
        .len()
}

/// An error and its sources, as one string.
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut next = e.source();
    while let Some(c) = next {
        out.push_str(" <- ");
        out.push_str(&c.to_string());
        next = c.source();
    }
    out
}

// ---------------------------------------------------------------------------------------------- files and ingest

fn pdf(name: &str, data: &[u8]) -> UploadFile {
    UploadFile::from_bytes(name.to_owned(), data.to_vec())
}

/// A batch item that ingests these bytes at `path`, as a caller builds it by hand: its SHA-256, size and type.
/// The order of the storage form POSTs ("upload") and upload policy requests ("policy") among the logged requests.
fn upload_order(requests: &[Value]) -> Vec<&'static str> {
    requests
        .iter()
        .filter_map(|r| match (str_at(r, "method"), str_at(r, "path")) {
            ("POST", "/__s3/") => Some("upload"),
            ("POST", p) if p.ends_with("/upload-policies") => Some("policy"),
            _ => None,
        })
        .collect()
}

fn ingest_item(path: &str, data: &[u8]) -> IngestionItemInput {
    let dir = std::env::temp_dir();
    let sha = futures_util::FutureExt::now_or_never(caitlyn_sdk_core::PreparedFile::read(&pdf("x.pdf", data), &dir))
        .and_then(Result::ok)
        .map(|p| p.sha256().to_owned())
        .unwrap_or_default();
    serde_json::from_value(json!({
        "action": "ingest", "path": path, "sha256": sha, "byteSize": data.len(), "contentType": "application/pdf"
    }))
    .unwrap_or_default()
}

fn remove_item(path: &str) -> IngestionItemInput {
    serde_json::from_value(json!({"action": "remove", "path": path})).unwrap_or_default()
}

/// A hand-built batch with a manual start, planned; started too when `start` is true.
async fn hand_batch(c: &Client, items: Vec<IngestionItemInput>, start: bool) -> Result<scope::BatchScope, String> {
    let batch = c
        .knowledge_base(KB)
        .ingestion()
        .batches()
        .create()
        .start(StartMode::Manual)
        .items(items)
        .await
        .map_err(s)?
        .into_scope();
    batch.planned().await.map_err(s)?;
    if start {
        batch.start().await.map_err(s)?;
    }
    Ok(batch)
}

/// The documents each EstimateIngestion call described, call by call.
async fn estimate_calls(m: &Mock) -> Vec<Vec<Value>> {
    bodies(m, "POST", &format!("/v3/knowledge-bases/{KB}/ingestions:estimate"))
        .await
        .iter()
        .map(|b| b["documents"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// The form uploads the mock received.
async fn form_posts(m: &Mock) -> Vec<Value> {
    m.matching(|r| str_at(r, "method") == "POST" && str_at(r, "path") == "/__s3/").await
}

/// The item ids each CompleteIngestionBatchUploads call reported.
async fn completed_ids(m: &Mock) -> Vec<Vec<String>> {
    m.matching(|r| str_at(r, "path").ends_with("/complete-uploads"))
        .await
        .iter()
        .map(|r| {
            let b: Value = serde_json::from_str(str_at(r, "body")).unwrap_or_default();
            b["itemIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .collect()
}

/// The JSON bodies of the requests with this method whose path contains `path`, in order.
async fn bodies(m: &Mock, method: &str, path: &str) -> Vec<Value> {
    m.matching(|r| str_at(r, "method") == method && str_at(r, "path").contains(path))
        .await
        .iter()
        .map(|r| serde_json::from_str(str_at(r, "body")).unwrap_or(Value::Null))
        .collect()
}

/// A new, empty directory under build/rust-conformance-tmp.
fn fresh_dir(name: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = root().join(format!(
        "build/rust-conformance-tmp/{name}-{stamp}-{}",
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("tmp dir");
    dir
}

/// A folder holding these files, by relative path.
fn folder_of(files: &[(&str, &str)]) -> PathBuf {
    let dir = fresh_dir("ingest");
    for (rel, text) in files {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("tmp dir");
        std::fs::write(p, text).expect("tmp file");
    }
    dir
}

/// A one-shot reader of `left` bytes. Once it has handed over more than 8 MiB and a chunk, it records how many files
/// the spool directory holds and the first one's mode.
struct Generated {
    left: usize,
    sent: usize,
    dir: PathBuf,
    seen: Arc<Mutex<Option<(usize, u32)>>>,
}

impl tokio::io::AsyncRead for Generated {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.sent > 8 * 1024 * 1024 + 256 * 1024 && self.seen.lock().unwrap().is_none() {
            let files: Vec<_> = std::fs::read_dir(&self.dir).map(|d| d.flatten().collect()).unwrap_or_default();
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                files
                    .first()
                    .and_then(|f| f.metadata().ok())
                    .map(|m| m.permissions().mode() & 0o777)
                    .unwrap_or(0)
            };
            #[cfg(not(unix))]
            let mode = 0o600;
            *self.seen.lock().unwrap() = Some((files.len(), mode));
        }
        let n = buf.remaining().min(self.left).min(32 * 1024);
        let start = self.sent;
        let chunk: Vec<u8> = (start..start + n).map(|i| (i % 251) as u8).collect();
        buf.put_slice(&chunk);
        self.left -= n;
        self.sent += n;
        std::task::Poll::Ready(Ok(()))
    }
}

// ---------------------------------------------------------------------------------------------- example cases

/// An input member bound to the path, the query or a header, read from the example's input as its own type.
fn field<T: serde::de::DeserializeOwned + Default>(input: &Value, k: &str) -> T {
    input
        .get(k)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn opt(input: &Value, k: &str) -> Option<String> {
    input.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn options(input: &Value) -> CallOptions {
    let mut o = CallOptions::new();
    if let Some(k) = opt(input, "idempotencyKey") {
        o = o.idempotency_key(k);
    }
    if let Some(m) = opt(input, "ifMatch") {
        o = o.if_match(m);
    }
    o
}

/// The output as JSON, with its header-bound members added under their model names.
fn with_headers<T: serde::Serialize>(out: &T, headers: &[(&str, Option<&str>)]) -> Value {
    let mut v = serde_json::to_value(out).unwrap_or(Value::Null);
    if let Value::Object(o) = &mut v {
        for (k, h) in headers {
            if let Some(h) = h {
                o.insert((*k).to_owned(), json!(h));
            }
        }
    }
    v
}

/// Reads a stream's first event, or its error (a watch carries on until it is closed).
async fn drain<E, F: Clone>(r: Result<caitlyn_sdk_core::Stream<E, F, Error>, Error>) -> Result<Value, Error> {
    let mut s = r?;
    if let Some(ev) = s.next().await {
        ev?;
    }
    Ok(Value::Null)
}

/// Reads events until `stop` returns true for one, or the stream ends.
async fn take<E, F: Clone>(s: &mut caitlyn_sdk_core::Stream<E, F, Error>, mut stop: impl FnMut(&E) -> bool) -> Result<Vec<E>, Error> {
    let mut evs = Vec::new();
    while let Some(ev) = s.next().await {
        let ev = ev?;
        let done = stop(&ev);
        evs.push(ev);
        if done {
            break;
        }
    }
    Ok(evs)
}

/// Calls the operation with an example's input. A new operation in the model fails until it has an entry here.
/// Calls the operation with an example's input, through the scope tree (PROTOCOL.md 10): the input's identifiers make
/// the scope, and the rest is set with `input(…)`. A new operation in the model fails until it has an entry here.
async fn call_example(c: &Client, op: &str, input: &Value) -> Option<Result<Value, Error>> {
    Some(match op {
        "BatchCreateIngestionBatchItems" => {
            let mut i: BatchCreateIngestionBatchItemsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            c.core()
                .ingestion()
                .add_items(
                    field::<String>(input, "knowledgeBaseId"),
                    field::<String>(input, "ingestionBatchId"),
                    Vec::<IngestionItemInput>::new(),
                )
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "BatchDeleteDocuments" => {
            let mut i: BatchDeleteDocumentsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .documents()
                .delete_many(Vec::<String>::new())
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "CancelDocumentProcessing" => {
            let mut i: CancelDocumentProcessingInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .cancel_processing()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| o.into_output())
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "CancelIngestionBatch" => {
            let mut i: CancelIngestionBatchInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .cancel()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| o.into_output())
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "CancelOperation" => {
            let mut i: CancelOperationInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.operation_id = field(input, "operationId");
            c.core()
                .operation(field::<String>(input, "knowledgeBaseId"), field::<String>(input, "operationId"))
                .cancel()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[]))
        }
        "CompareAgentVersions" => {
            let mut i: CompareAgentVersionsInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.version = field(input, "version");
            i.with_version = field(input, "withVersion");
            c.agent(field::<String>(input, "agentId"))
                .version(field::<String>(input, "version"))
                .compare(field::<String>(input, "withVersion"))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "CompleteIngestionBatchUploads" => {
            let mut i: CompleteIngestionBatchUploadsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            c.core()
                .ingestion()
                .complete_uploads(
                    field::<String>(input, "knowledgeBaseId"),
                    field::<String>(input, "ingestionBatchId"),
                    Vec::<String>::new(),
                )
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "CreateAgent" => {
            let i: CreateAgentInput = serde_json::from_value(input.clone()).ok()?;
            c.agents()
                .create(field::<String>(input, "name"))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = o.result();
                    with_headers(o, &[("etag", Some(o.etag.as_str()))])
                })
        }
        "CreateConversation" => {
            let mut i: CreateConversationInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.version = field(input, "version");
            c.agent(field::<String>(input, "agentId"))
                .version(field::<String>(input, "version"))
                .conversations()
                .create()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = o.result();
                    with_headers(o, &[])
                })
        }
        "CreateDocument" => {
            let mut i: CreateDocumentInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .documents()
                .create(UploadFile::from_bytes("example.pdf", Vec::<u8>::new()))
                .input(i)
                .upload_id(field::<String>(input, "uploadId"))
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = o.result();
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                            ("etag", Some(o.etag.as_str())),
                        ],
                    )
                })
        }
        "CreateDocumentVersion" => {
            let mut i: CreateDocumentVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .replace(UploadFile::from_bytes("example.pdf", Vec::<u8>::new()))
                .input(i)
                .upload_id(field::<String>(input, "uploadId"))
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "CreateField" => {
            let mut i: CreateFieldInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .fields()
                .create(field::<String>(input, "key"), field::<String>(input, "name"), FieldType::default())
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = o.result();
                    with_headers(o, &[("etag", Some(o.etag.as_str()))])
                })
        }
        "CreateFolder" => {
            let mut i: CreateFolderInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .folders()
                .create(field::<String>(input, "path"))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = o.result();
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "CreateIngestionBatch" => {
            let mut i: CreateIngestionBatchInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batches()
                .create()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = o.result();
                    with_headers(o, &[("etag", Some(o.etag.as_str()))])
                })
        }
        "CreateIngestionBatchUploadPolicy" => {
            let mut i: CreateIngestionBatchUploadPolicyInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            c.core()
                .ingestion()
                .upload_policy(
                    field::<String>(input, "knowledgeBaseId"),
                    field::<String>(input, "ingestionBatchId"),
                )
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "CreateKnowledgeBase" => {
            let i: CreateKnowledgeBaseInput = serde_json::from_value(input.clone()).ok()?;
            c.knowledge_bases()
                .create(field::<String>(input, "name"))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = o.result();
                    with_headers(o, &[("etag", Some(o.etag.as_str()))])
                })
        }
        "CreateUpload" => {
            let i: CreateUploadInput = serde_json::from_value(input.clone()).ok()?;
            c.core()
                .uploads()
                .reserve(
                    field::<String>(input, "fileName"),
                    field::<String>(input, "contentType"),
                    Default::default(),
                    field::<String>(input, "sha256"),
                )
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "DeleteAgent" => {
            let mut i: DeleteAgentInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            c.agent(field::<String>(input, "agentId"))
                .delete()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "DeleteAgentVersion" => {
            let mut i: DeleteAgentVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.version = field(input, "version");
            c.agent(field::<String>(input, "agentId"))
                .version(field::<String>(input, "version"))
                .delete()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "DeleteDocument" => {
            let mut i: DeleteDocumentInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .delete()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(o, &[("etag", Some(o.etag.as_str()))])
                })
        }
        "DeleteDocumentVersion" => {
            let mut i: DeleteDocumentVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            i.version = field(input, "version");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .version(field::<String>(input, "version"))
                .delete()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "DeleteField" => {
            let mut i: DeleteFieldInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.field_key = field(input, "fieldKey");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .field(field::<String>(input, "fieldKey"))
                .delete()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "DeleteFolder" => {
            let mut i: DeleteFolderInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.folder_path = field(input, "folderPath");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .folder(field::<String>(input, "folderPath"))
                .delete()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "DeleteKnowledgeBase" => {
            let mut i: DeleteKnowledgeBaseInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .delete()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "EnableLayoutAwareSearch" => {
            let mut i: EnableLayoutAwareSearchInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .layout_aware_search()
                .enable()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "EstimateDocumentVersion" => {
            let mut i: EstimateDocumentVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .estimate_replace(UploadFile::from_bytes("example.pdf", Vec::<u8>::new()))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "EstimateFillInFields" => {
            let mut i: EstimateFillInFieldsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .fields()
                .estimate_fill_in(Vec::<String>::new())
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "EstimateIngestion" => {
            let mut i: EstimateIngestionInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .documents()
                .estimate_create(UploadFile::from_bytes("example.pdf", Vec::<u8>::new()))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "EstimateLayoutAwareSearch" => {
            let mut i: EstimateLayoutAwareSearchInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .layout_aware_search()
                .estimate_enable()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "EstimateReprocessDocuments" => {
            let mut i: EstimateReprocessDocumentsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .documents()
                .estimate_reprocess()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "FillInFields" => {
            let mut i: FillInFieldsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .fields()
                .fill_in(Vec::<String>::new())
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "GetAccess" => {
            let mut i: GetAccessInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.folder = field(input, "folder");
            i.document = field(input, "document");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .access()
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetAgent" => {
            let mut i: GetAgentInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            c.agent(field::<String>(input, "agentId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetAgentVersion" => {
            let mut i: GetAgentVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.version = field(input, "version");
            c.agent(field::<String>(input, "agentId"))
                .version(field::<String>(input, "version"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetCaller" => {
            let i: GetCallerInput = serde_json::from_value(input.clone()).ok()?;
            c.me().input(i).options(options(input)).send().await.map(|o| {
                with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )
            })
        }
        "GetConversation" => {
            let mut i: GetConversationInput = serde_json::from_value(input.clone()).ok()?;
            i.conversation_id = field(input, "conversationId");
            c.conversation(field::<String>(input, "conversationId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[]))
        }
        "GetDocument" => {
            let mut i: GetDocumentInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetDocumentContent" => {
            let mut i: GetDocumentContentInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            i.version = field(input, "version");
            c.core()
                .documents()
                .content(field::<String>(input, "knowledgeBaseId"), field::<String>(input, "documentId"))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("location", Some(o.location.as_str())),
                        ],
                    )
                })
        }
        "GetDocumentDownload" => {
            let mut i: GetDocumentDownloadInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            i.version = field(input, "version");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .download()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "GetDocumentVersion" => {
            let mut i: GetDocumentVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            i.version = field(input, "version");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .version(field::<String>(input, "version"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[]))
        }
        "GetField" => {
            let mut i: GetFieldInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.field_key = field(input, "fieldKey");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .field(field::<String>(input, "fieldKey"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetHistoryEntry" => {
            let mut i: GetHistoryEntryInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.history_entry_id = field(input, "historyEntryId");
            c.agent(field::<String>(input, "agentId"))
                .history_entry(field::<String>(input, "historyEntryId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[]))
        }
        "GetIngestionBatch" => {
            let mut i: GetIngestionBatchInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetIngestionBatchItem" => {
            let mut i: GetIngestionBatchItemInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            i.item_id = field(input, "itemId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .item(field::<String>(input, "itemId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetKnowledgeBase" => {
            let mut i: GetKnowledgeBaseInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "GetOperation" => {
            let mut i: GetOperationInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.operation_id = field(input, "operationId");
            c.core()
                .operation(field::<String>(input, "knowledgeBaseId"), field::<String>(input, "operationId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[]))
        }
        "GetUpload" => {
            let mut i: GetUploadInput = serde_json::from_value(input.clone()).ok()?;
            i.upload_id = field(input, "uploadId");
            c.core()
                .upload(field::<String>(input, "uploadId"))
                .get()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[]))
        }
        "ListAgentVersions" => {
            let mut i: ListAgentVersionsInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c
                .agent(field::<String>(input, "agentId"))
                .versions()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListAgents" => {
            let mut i: ListAgentsInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c.agents().list().input(i).options(options(input)).page().await {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListConversations" => {
            let mut i: ListConversationsInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c
                .agent(field::<String>(input, "agentId"))
                .conversations()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListDocumentVersions" => {
            let mut i: ListDocumentVersionsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c
                .knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .versions()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListDocuments" => {
            let mut i: ListDocumentsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            i.sort = field(input, "sort");
            i.folder = field(input, "folder");
            i.deep = field(input, "deep");
            i.q = field(input, "q");
            i.status = field(input, "status");
            i.name_prefix = field(input, "namePrefix");
            i.external_id = field(input, "externalId");
            i.content_type_prefix = field(input, "contentTypePrefix");
            i.sha256 = field(input, "sha256");
            i.out_of_date = field(input, "outOfDate");
            match c
                .knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .documents()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListFields" => {
            let mut i: ListFieldsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c
                .knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .fields()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListFolders" => {
            let mut i: ListFoldersInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            i.parent = field(input, "parent");
            i.deep = field(input, "deep");
            i.q = field(input, "q");
            match c
                .knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .folders()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListGuardrails" => {
            let mut i: ListGuardrailsInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c.agents().options().guardrails().input(i).options(options(input)).page().await {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListHistoryEntries" => {
            let mut i: ListHistoryEntriesInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c
                .agent(field::<String>(input, "agentId"))
                .history()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListIngestionBatchItems" => {
            let mut i: ListIngestionBatchItemsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            i.action = field(input, "action");
            i.outcome = field(input, "outcome");
            i.status = field(input, "status");
            i.resolution = field(input, "resolution");
            match c
                .knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .items()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListIngestionBatches" => {
            let mut i: ListIngestionBatchesInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.status = field(input, "status");
            match c
                .knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batches()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListKnowledgeBases" => {
            let mut i: ListKnowledgeBasesInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            i.status = field(input, "status");
            match c.knowledge_bases().list().input(i).options(options(input)).page().await {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListMemoryStores" => {
            let mut i: ListMemoryStoresInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c.agents().options().memory_stores().input(i).options(options(input)).page().await {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListMessages" => {
            let mut i: ListMessagesInput = serde_json::from_value(input.clone()).ok()?;
            i.conversation_id = field(input, "conversationId");
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c
                .conversation(field::<String>(input, "conversationId"))
                .messages()
                .list()
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListModels" => {
            let mut i: ListModelsInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c.agents().options().models().input(i).options(options(input)).page().await {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListOperations" => {
            let mut i: ListOperationsInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.target_type = field(input, "targetType");
            i.target_id = field(input, "targetId");
            i.kind = field(input, "kind");
            i.status = field(input, "status");
            match c
                .core()
                .operations()
                .list(field::<String>(input, "knowledgeBaseId"))
                .input(i)
                .options(options(input))
                .page()
                .await
            {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListTools" => {
            let mut i: ListToolsInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c.agents().options().tools().input(i).options(options(input)).page().await {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "ListVoices" => {
            let mut i: ListVoicesInput = serde_json::from_value(input.clone()).ok()?;
            i.limit = field(input, "limit");
            i.cursor = field(input, "cursor");
            match c.agents().options().voices().input(i).options(options(input)).page().await {
                Ok(o) => Ok(with_headers(
                    &o,
                    &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                )),
                Err(e) => Err(e),
            }
        }
        "PublishAgentVersion" => {
            let mut i: PublishAgentVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            i.version = field(input, "version");
            c.agent(field::<String>(input, "agentId"))
                .version(field::<String>(input, "version"))
                .publish()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    with_headers(
                        &o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("etag", Some(o.etag.as_str())),
                        ],
                    )
                })
        }
        "PutAccess" => {
            let mut i: PutAccessInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.folder = field(input, "folder");
            i.document = field(input, "document");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .access()
                .set()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "ReplaceDraftVersion" => {
            let mut i: ReplaceDraftVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            c.agent(field::<String>(input, "agentId"))
                .draft()
                .replace()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "ReprocessDocuments" => {
            let mut i: ReprocessDocumentsInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .documents()
                .reprocess()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[("requestId", o.request_id.as_deref()), ("apiVersion", o.api_version.as_deref())],
                    )
                })
        }
        "ResetDraftVersion" => {
            let mut i: ResetDraftVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            c.agent(field::<String>(input, "agentId"))
                .draft()
                .reset(field::<String>(input, "from"))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "RetryDocument" => {
            let mut i: RetryDocumentInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .retry()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("etag", Some(o.etag.as_str())),
                        ],
                    )
                })
        }
        "SaveDraftVersion" => {
            let mut i: SaveDraftVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            c.agent(field::<String>(input, "agentId"))
                .draft()
                .save(field::<String>(input, "name"))
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "SendMessage" => {
            let mut i: SendMessageInput = serde_json::from_value(input.clone()).ok()?;
            i.conversation_id = field(input, "conversationId");
            drain(
                c.conversation(field::<String>(input, "conversationId"))
                    .send(field::<String>(input, "message"))
                    .input(i)
                    .options(options(input))
                    .send()
                    .await,
            )
            .await
        }
        "StartIngestionBatch" => {
            let mut i: StartIngestionBatchInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .start()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| o.into_output())
                .map(|o| {
                    with_headers(
                        &o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("etag", Some(o.etag.as_str())),
                        ],
                    )
                })
        }
        "UpdateAgent" => {
            let mut i: UpdateAgentInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            c.agent(field::<String>(input, "agentId"))
                .update()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "UpdateDocument" => {
            let mut i: UpdateDocumentInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document_id = field(input, "documentId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .document(field::<String>(input, "documentId"))
                .update()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("etag", Some(o.etag.as_str())),
                        ],
                    )
                })
        }
        "UpdateDraftVersion" => {
            let mut i: UpdateDraftVersionInput = serde_json::from_value(input.clone()).ok()?;
            i.agent_id = field(input, "agentId");
            c.agent(field::<String>(input, "agentId"))
                .draft()
                .update()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "UpdateField" => {
            let mut i: UpdateFieldInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.field_key = field(input, "fieldKey");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .field(field::<String>(input, "fieldKey"))
                .update()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "UpdateFolder" => {
            let mut i: UpdateFolderInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.folder_path = field(input, "folderPath");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .folder(field::<String>(input, "folderPath"))
                .update()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| {
                    let o = &o.output;
                    with_headers(
                        o,
                        &[
                            ("requestId", o.request_id.as_deref()),
                            ("apiVersion", o.api_version.as_deref()),
                            ("etag", Some(o.etag.as_str())),
                            ("location", o.location.as_deref()),
                        ],
                    )
                })
        }
        "UpdateIngestionBatch" => {
            let mut i: UpdateIngestionBatchInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .update()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "CancelIngestionBatchItem" => {
            let mut i: CancelIngestionBatchItemInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            i.item_id = field(input, "itemId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .item(field::<String>(input, "itemId"))
                .cancel()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "UpdateIngestionBatchItem" => {
            let mut i: UpdateIngestionBatchItemInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.ingestion_batch_id = field(input, "ingestionBatchId");
            i.item_id = field(input, "itemId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .ingestion()
                .batch(field::<String>(input, "ingestionBatchId"))
                .item(field::<String>(input, "itemId"))
                .resolve(IngestionItemResolution::default())
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "UpdateKnowledgeBase" => {
            let mut i: UpdateKnowledgeBaseInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            c.knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .update()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str()))]))
        }
        "WatchConversation" => {
            let mut i: WatchConversationInput = serde_json::from_value(input.clone()).ok()?;
            i.conversation_id = field(input, "conversationId");
            i.last_event_id = field(input, "lastEventId");
            drain(
                c.conversation(field::<String>(input, "conversationId"))
                    .watch()
                    .input(i)
                    .options(options(input))
                    .send()
                    .await,
            )
            .await
        }
        "WatchKnowledgeBase" => {
            let mut i: WatchKnowledgeBaseInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.document = field(input, "document");
            i.folder = field(input, "folder");
            i.batch = field(input, "batch");
            let r = c
                .knowledge_base(field::<String>(input, "knowledgeBaseId"))
                .watch()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|_| Value::Null);
            r
        }
        "WatchOperation" => {
            let mut i: WatchOperationInput = serde_json::from_value(input.clone()).ok()?;
            i.knowledge_base_id = field(input, "knowledgeBaseId");
            i.operation_id = field(input, "operationId");
            i.last_event_id = field(input, "lastEventId");
            let r = c
                .core()
                .operation(field::<String>(input, "knowledgeBaseId"), field::<String>(input, "operationId"))
                .watch()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|_| Value::Null);
            r
        }
        "WatchWorkspaceEvents" => {
            let mut i: WatchWorkspaceEventsInput = serde_json::from_value(input.clone()).ok()?;
            i.types = field(input, "types");
            i.conversation_ids = field(input, "conversationIds");
            i.after = field(input, "after");
            i.last_event_id = field(input, "lastEventId");
            let r = c
                .events()
                .watch()
                .input(i)
                .options(options(input))
                .send()
                .await
                .map(|_| Value::Null);
            r
        }
        _ => return None,
    })
}

/// Every member of the expected JSON is in the actual JSON; timestamps compare as instants, numbers as numbers.
fn assert_subset(expected: &Value, actual: &Value, at: &str) -> R {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            for (k, v) in e {
                assert_subset(v, a.get(k).unwrap_or(&Value::Null), &format!("{at}.{k}"))?;
            }
            Ok(())
        }
        (Value::Array(e), Value::Array(a)) => {
            ensure!(e.len() == a.len(), "{at}: expected {} items, got {}", e.len(), a.len());
            for (i, (x, y)) in e.iter().zip(a).enumerate() {
                assert_subset(x, y, &format!("{at}[{i}]"))?;
            }
            Ok(())
        }
        (Value::String(e), Value::String(a)) => {
            if let (Ok(x), Ok(y)) = (chrono::DateTime::parse_from_rfc3339(e), chrono::DateTime::parse_from_rfc3339(a)) {
                ensure!(x == y, "{at}: expected {e}, got {a}");
            } else {
                ensure!(e == a, "{at}: expected {e:?}, got {a:?}");
            }
            Ok(())
        }
        (Value::Number(e), Value::Number(a)) => {
            // A model float is 32-bit; serde_json::to_value widens it, so compare at its own precision too.
            let (x, y) = (e.as_f64().unwrap_or(f64::NAN), a.as_f64().unwrap_or(f64::NAN));
            ensure!(x == y || x as f32 == y as f32, "{at}: expected {e}, got {a}");
            Ok(())
        }
        _ => {
            ensure!(expected == actual, "{at}: expected {expected}, got {actual}");
            Ok(())
        }
    }
}

async fn example(m: &Mock, ex: &Value) -> R {
    let id = str_at(ex, "id");
    m.post("/__mock/example", json!({"id": id})).await;
    let out = call_example(&client(m), str_at(ex, "operation"), &ex["input"])
        .await
        .ok_or_else(|| format!("no example entry for {}", str_at(ex, "operation")))?;
    let res = m.get("/__mock/example").await;
    ensure!(
        res["served"] == json!(true) && res["mismatches"].as_array().is_none_or(|a| a.is_empty()),
        "served {}, request differs from the example: {}",
        res["served"],
        res["mismatches"]
    );
    if let Some(want) = ex["expected"].get("error").filter(|e| !e.is_null()) {
        let err = out.err().ok_or("expected an error")?;
        let api = err.api().ok_or_else(|| format!("want a problem, got {err:?}"))?;
        ensure!(
            err.shape() == want["shape"].as_str()
                && Some(api.status as u64) == want["status"].as_u64()
                && Some(api.code.as_str()) == want["code"].as_str()
                && api.request_id.as_deref() == want["requestId"].as_str(),
            "got {:?} {api:?}, want {want}",
            err.shape()
        );
        return Ok(());
    }
    let out = out.map_err(|e| format!("unexpected error {e}"))?;
    match ex["expected"].get("output") {
        Some(want) if !want.is_null() => assert_subset(want, &out, "output"),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------- a server of a case's own

const PROBLEM_404: &str = r#"{"type":"https://build.caitlyn.ai/errors/NOT_FOUND","title":"Not found","status":404,"code":"NOT_FOUND","requestId":"01FAKE00000000000000000000"}"#;

/// A tiny HTTP server answering each connection with the next canned response, then closing it: for states the mock
/// server has no fault for (a thing gone between a watch's connections, a batch past its upload deadline).
struct Fake {
    base: String,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    async fn start(responses: Vec<(u16, &'static str, String)>) -> Fake {
        Fake::start_for(move |_| responses.into_iter().map(|(st, ct, b)| (st, ct.to_owned(), b)).collect()).await
    }

    /// As `start`, with responses made from the server's own address (for a Location that points back at it). A
    /// content type may carry further header lines after `\r\n`.
    async fn start_for(responses: impl FnOnce(&str) -> Vec<(u16, String, String)>) -> Fake {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let responses = responses(&base);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            for (status, content_type, body) in responses {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut head = Vec::new();
                let mut buf = [0u8; 4096];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&head).lines().next().unwrap_or_default().to_owned();
                log.lock().unwrap().push(line);
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCaitlyn-Request-Id: 01FAKE\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        Fake { base, seen }
    }

    fn client(&self) -> Client {
        Client::builder(WORKSPACE, Auth::token(PAT))
            .endpoint(&self.base)
            .build()
            .expect("client")
    }

    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn document_json(status: &str) -> Value {
    json!({
        "id": "doc-1", "knowledgeBaseId": KB, "name": "leave.pdf", "folder": "/hr/", "status": status,
        "createdAt": "2026-11-01T00:00:00.000Z", "updatedAt": "2026-11-01T00:00:00.000Z", "etag": "\"doc-1-1\""
    })
}

fn batch_json(status: &str) -> Value {
    json!({
        "id": "batch-1", "knowledgeBaseId": KB, "status": status, "start": "manual", "awaitMoreItems": false,
        "policy": {}, "itemCount": 1, "createdAt": "2026-11-01T00:00:00.000Z", "updatedAt": "2026-11-01T00:00:00.000Z",
        "etag": "\"batch-1-1\""
    })
}

// ---------------------------------------------------------------------------------------------- sign-in cases

fn b64url(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

static JTI: AtomicUsize = AtomicUsize::new(0);

/// A workload identity token, as GitLab CI would mint it (the mock's mockOidcToken).
fn oidc_token(aud: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let jti = format!("jti-{}-{}", std::process::id(), JTI.fetch_add(1, Ordering::SeqCst) + now as usize);
    let claims = json!({"iss": "https://git.example.com", "sub": "project_path:group/project:ref_type:branch:ref:main", "aud": aud, "iat": now, "exp": now + 300, "jti": jti});
    format!(
        "{}.{}.mock",
        b64url(br#"{"alg":"none","typ":"JWT"}"#),
        b64url(claims.to_string().as_bytes())
    )
}

async fn read(c: &Client) -> Result<AgentVersion, Error> {
    draft(c).await
}

fn auth_err(r: Result<impl std::fmt::Debug, Error>) -> Result<AuthError, String> {
    match r {
        Err(Error::Auth(e)) => Ok(e),
        other => Err(format!("expected a sign-in error, got {other:?}")),
    }
}

fn aws(m: &Mock) -> caitlyn_sdk::auth::AwsIam {
    Auth::aws_iam()
        .region("ap-southeast-2")
        .sts_endpoint(format!("{}/__sts/", m.base))
        .credentials(AwsCredentials::new(
            "AKIDMOCKCAITLYN",
            "mock-secret-key",
            Some("session-token".into()),
        ))
}

async fn sign_in(m: &Mock, c: &Client) -> R {
    let a = c.auth().authorization_url(None, None, None).map_err(s)?;
    let no_redirect = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(s)?;
    let loc = no_redirect
        .get(&a.url)
        .send()
        .await
        .map_err(s)?
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let q: BTreeMap<String, String> = url::Url::parse(&loc).map_err(s)?.query_pairs().into_owned().collect();
    c.auth()
        .handle_callback(Callback {
            code: q.get("code").cloned().unwrap_or_default(),
            state: q.get("state").cloned(),
            expected_state: Some(a.state),
            code_verifier: a.code_verifier,
            redirect_uri: None,
        })
        .await
        .map_err(s)?;
    let _ = m;
    Ok(())
}

/// A token store whose `with_lock` runs one piece of work at a time: what a database or Redis lock gives a shared store.
#[derive(Default)]
struct LockingStore {
    inner: MemoryTokenStore,
    lock: tokio::sync::Mutex<()>,
    locks: AtomicUsize,
}

impl TokenStore for LockingStore {
    fn load(&self) -> caitlyn_sdk_core::BoxFuture<'_, Option<OAuthTokens>> {
        self.inner.load()
    }
    fn save(&self, tokens: OAuthTokens) -> caitlyn_sdk_core::BoxFuture<'_, ()> {
        self.inner.save(tokens)
    }
    fn clear(&self) -> caitlyn_sdk_core::BoxFuture<'_, ()> {
        self.inner.clear()
    }
    fn with_lock<'a>(&'a self, work: caitlyn_sdk_core::BoxFuture<'a, ()>) -> caitlyn_sdk_core::BoxFuture<'a, ()> {
        self.locks.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let _held = self.lock.lock().await;
            work.await;
        })
    }
}

fn auth_case<'a>(id: &str, m: &'a Mock) -> Option<Fut<'a>> {
    let oauth = || Auth::oauth("studio-client").redirect_uri("https://app.example.com/callback");
    Some(match id {
        "auth.workspace" => Box::pin(async move {
            let plain = Client::new("https://your-company.caitlyn.ai/", Auth::token(PAT)).map_err(s)?;
            ensure!(
                plain.auth().workspace() == WORKSPACE && plain.workspace() == WORKSPACE,
                "workspace {}",
                plain.auth().workspace()
            );
            ensure!(plain.auth().resource() == RESOURCE, "resource {}", plain.auth().resource());
            ensure!(
                plain.auth().token_endpoint() == "https://your-company.caitlyn.ai/api/oauth/token",
                "token endpoint {}",
                plain.auth().token_endpoint()
            );
            let proxied = client(m);
            ensure!(
                proxied.auth().resource() == RESOURCE && proxied.auth().token_endpoint() == format!("{}/oauth/token", m.base),
                "proxied {}",
                proxied.auth().token_endpoint()
            );
            // A workspace given as a URL, with the endpoint moved to the mock: one token request to the mock,
            // still for the workspace's audience, then one call.
            let c = Client::builder(
                "https://your-company.caitlyn.ai/",
                Auth::client_credentials("machine-client", "machine-secret"),
            )
            .endpoint(&m.base)
            .build()
            .map_err(s)?;
            read(&c).await.map_err(s)?;
            let tokens = m.matching(|r| str_at(r, "path") == "/oauth/token").await;
            ensure!(tokens.len() == 1, "{} token requests", tokens.len());
            let form: BTreeMap<String, String> = url::form_urlencoded::parse(str_at(&tokens[0], "body").as_bytes())
                .into_owned()
                .collect();
            ensure!(form.get("resource").map(String::as_str) == Some(RESOURCE), "form {form:?}");
            ensure!(m.api().await.len() == 1, "{} calls", m.api().await.len());
            Ok(())
        }),
        "auth.token" => Box::pin(async move {
            read(&client(m)).await.map_err(s)?;
            ensure!(
                header(&m.api().await[0], "authorization") == Some("Bearer pat_test"),
                "authorization"
            );
            ensure!(m.counts().await == json!({"sts": 0}), "counts {}", m.counts().await);
            Ok(())
        }),
        "auth.client-credentials" => Box::pin(async move {
            let c = client_with(
                m,
                Auth::client_credentials("machine-client", "machine-secret").scopes(["agents:read"]),
            );
            let (a, b, d) = tokio::join!(read(&c), read(&c), read(&c));
            a.and(b).and(d).map_err(s)?;
            read(&c).await.map_err(s)?;
            ensure!(m.counts().await["client_credentials"] == json!(1), "counts {}", m.counts().await);
            let auths: HashSet<String> = m
                .api()
                .await
                .iter()
                .filter_map(|r| header(r, "authorization").map(str::to_owned))
                .collect();
            ensure!(
                auths.len() == 1 && auths.iter().all(|a| a.starts_with("Bearer cai_cc_")),
                "authorizations {auths:?}"
            );
            let token_req = m
                .matching(|r| str_at(r, "path") == "/oauth/token")
                .await
                .pop()
                .ok_or("no token request")?;
            let form: BTreeMap<String, String> = url::form_urlencoded::parse(str_at(&token_req, "body").as_bytes())
                .into_owned()
                .collect();
            ensure!(
                form.get("resource").map(String::as_str) == Some(RESOURCE) && form.get("scope").map(String::as_str) == Some("agents:read"),
                "form {form:?}"
            );
            Ok(())
        }),
        "auth.client-credentials-refused" => Box::pin(async move {
            let e = auth_err(read(&client_with(m, Auth::client_credentials("machine-client", "wrong"))).await)?;
            ensure!(e.code == "invalid_client" && e.status == Some(401), "got {e:?}");
            Ok(())
        }),
        "auth.renew-before-expiry" => Box::pin(async move {
            m.faults(json!({"auth": {"expiresIn": 1}})).await;
            let c = client_with(m, Auth::client_credentials("machine-client", "machine-secret"));
            read(&c).await.map_err(s)?;
            read(&c).await.map_err(s)?;
            ensure!(
                m.counts().await["client_credentials"] == json!(1),
                "reused within the first half of its life"
            );
            tokio::time::sleep(Duration::from_millis(600)).await;
            read(&c).await.map_err(s)?;
            ensure!(m.counts().await["client_credentials"] == json!(2), "replaced after half its life");
            ensure!(m.api().await.len() == 3, "no call was refused");
            Ok(())
        }),
        "auth.401-signs-in-again" => Box::pin(async move {
            let c = client_with(m, Auth::client_credentials("machine-client", "machine-secret"));
            read(&c).await.map_err(s)?;
            m.faults(json!({"auth": {"revokeIssued": true}})).await;
            let v = read(&c).await.map_err(s)?;
            ensure!(
                v.agent_id == AGENT && m.counts().await["client_credentials"] == json!(2),
                "counts {}",
                m.counts().await
            );
            Ok(())
        }),
        "auth.401-once" => Box::pin(async move {
            let c = client_with(m, Auth::client_credentials("machine-client", "machine-secret"));
            read(&c).await.map_err(s)?;
            m.faults(json!({"auth": {"revokeIssued": true, "expiresIn": 0}})).await;
            let r = read(&c).await;
            ensure!(
                matches!(&r, Err(Error::Unauthenticated(e)) if e.code == "UNAUTHENTICATED"),
                "got {:?}",
                r.err()
            );
            ensure!(
                m.counts().await["client_credentials"] == json!(2) && m.api().await.len() == 3,
                "counts {}, {} calls",
                m.counts().await,
                m.api().await.len()
            );
            Ok(())
        }),
        "auth.oauth-401-refreshes" => Box::pin(async move {
            let store = Arc::new(MemoryTokenStore::default());
            let c = client_with(m, oauth().token_store(store.clone()));
            sign_in(m, &c).await?;
            read(&c).await.map_err(s)?;
            m.faults(json!({"auth": {"revokeIssued": true}})).await;
            read(&c).await.map_err(s)?;
            ensure!(m.counts().await["refresh_token"] == json!(1), "counts {}", m.counts().await);
            let calls = m.api().await;
            let auth = |i: usize| header(&calls[i], "authorization").unwrap_or_default().to_owned();
            ensure!(calls.len() == 3, "{} calls", calls.len());
            ensure!(auth(1) == auth(0), "the second call did not reuse the token");
            ensure!(auth(2).starts_with("Bearer cai_refresh_"), "third call sent {}", auth(2));
            Ok(())
        }),
        "auth.aws-iam-no-credentials" => Box::pin(async move {
            let vars = [
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            ];
            let saved: Vec<_> = vars.iter().map(|k| (*k, std::env::var_os(k))).collect();
            for k in vars {
                std::env::remove_var(k);
            }
            let r = read(&client_with(
                m,
                Auth::aws_iam().region("ap-southeast-2").sts_endpoint(format!("{}/__sts/", m.base)),
            ))
            .await;
            for (k, v) in saved {
                if let Some(v) = v {
                    std::env::set_var(k, v);
                }
            }
            let e = auth_err(r)?;
            ensure!(
                e.code == "aws_identity_failed" && m.requests().await.is_empty(),
                "got {e:?}, {} requests",
                m.requests().await.len()
            );
            Ok(())
        }),
        "auth.401-token-mode" => Box::pin(async move {
            let r = read(&client_with(m, Auth::token("pat_revoked"))).await;
            ensure!(
                matches!(&r, Err(Error::Unauthenticated(e)) if e.code == "UNAUTHENTICATED"),
                "got {:?}",
                r.err()
            );
            ensure!(m.api().await.len() == 1, "retried");
            Ok(())
        }),
        "auth.oauth-sign-in" => Box::pin(async move {
            let store = Arc::new(MemoryTokenStore::default());
            let c = client_with(
                m,
                oauth()
                    .client_secret("studio-secret")
                    .scopes(["chat:write"])
                    .token_store(store.clone()),
            );
            let a = c.auth().authorization_url(None, None, None).map_err(s)?;
            let q: BTreeMap<String, String> = url::Url::parse(&a.url).map_err(s)?.query_pairs().into_owned().collect();
            ensure!(
                q["code_challenge_method"] == "S256" && q["resource"] == RESOURCE && q["scope"] == "chat:write",
                "query {q:?}"
            );
            sign_in(m, &c).await?;
            ensure!(store.get().and_then(|t| t.refresh_token).is_some(), "no refresh token saved");
            read(&c).await.map_err(s)?;
            ensure!(
                header(&m.api().await[0], "authorization")
                    .unwrap_or_default()
                    .starts_with("Bearer cai_code_"),
                "authorization"
            );
            Ok(())
        }),
        "auth.oauth-state" => Box::pin(async move {
            let c = client_with(m, oauth());
            let e = c
                .auth()
                .handle_callback(Callback {
                    code: "x".into(),
                    state: Some("forged".into()),
                    expected_state: Some("expected".into()),
                    code_verifier: "v".into(),
                    redirect_uri: None,
                })
                .await
                .err()
                .ok_or("accepted a forged state")?;
            ensure!(
                e.code == "invalid_state" && m.counts().await.get("authorization_code").is_none(),
                "got {e:?}"
            );
            Ok(())
        }),
        "auth.oauth-refresh" => Box::pin(async move {
            let store = Arc::new(MemoryTokenStore::default());
            let c = client_with(m, oauth().token_store(store.clone()));
            sign_in(m, &c).await?;
            let first = store.get().and_then(|t| t.refresh_token);
            // A new process with an expired access token in the store.
            let mut t = store.get().ok_or("nothing stored")?;
            t.expires_at = Some(chrono::Utc::now() - chrono::Duration::seconds(1));
            let store = Arc::new(MemoryTokenStore::new(Some(t)));
            let later = client_with(m, Auth::oauth("studio-client").token_store(store.clone()));
            let (a, b) = tokio::join!(read(&later), read(&later));
            a.and(b).map_err(s)?;
            ensure!(
                m.counts().await["refresh_token"] == json!(1),
                "one refresh however many calls wait: {}",
                m.counts().await
            );
            ensure!(
                store.get().and_then(|t| t.refresh_token) != first,
                "the rotated refresh token was not saved"
            );
            ensure!(
                header(m.api().await.last().unwrap(), "authorization")
                    .unwrap_or_default()
                    .starts_with("Bearer cai_refresh_"),
                "authorization"
            );
            Ok(())
        }),
        "auth.oauth-401-single-flight" => Box::pin(async move {
            let c = client_with(m, oauth().token_store(Arc::new(MemoryTokenStore::default())));
            sign_in(m, &c).await?;
            read(&c).await.map_err(s)?;
            // Every call is sent with the token the server now refuses; the 401s after the first arrive after its refresh.
            m.faults(json!({"auth": {"revokeIssued": true, "laterRefusalsDelayMs": 300}})).await;
            let (r1, r2, r3, r4, r5) = tokio::join!(read(&c), read(&c), read(&c), read(&c), read(&c));
            r1.and(r2).and(r3).and(r4).and(r5).map_err(s)?;
            let n = m.counts().await["refresh_token"].clone();
            ensure!(n == json!(1), "{n} refreshes, want 1");
            Ok(())
        }),
        "auth.oauth-shared-store-lock" => Box::pin(async move {
            let store = Arc::new(LockingStore::default());
            sign_in(m, &client_with(m, oauth().token_store(store.clone()))).await?;
            let mut t = store.inner.get().ok_or("nothing stored")?;
            t.expires_at = Some(chrono::Utc::now() - chrono::Duration::seconds(1)); // both clients find it expired
            store.inner.save(t).await;
            // The first refresh is still in flight when the second client asks.
            m.faults(json!({"auth": {"refreshDelayMs": 300}})).await;
            let a = client_with(m, Auth::oauth("studio-client").token_store(store.clone()));
            let b = client_with(m, Auth::oauth("studio-client").token_store(store.clone()));
            let (ra, rb) = tokio::join!(read(&a), read(&b));
            ra.and(rb).map_err(s)?;
            let n = m.counts().await["refresh_token"].clone();
            ensure!(n == json!(1), "{n} refreshes, want 1");
            let api = m.api().await;
            let sent: Vec<_> = api[api.len() - 2..]
                .iter()
                .map(|r| header(r, "authorization").unwrap_or_default())
                .collect();
            ensure!(
                sent[0] == sent[1] && sent[0].starts_with("Bearer cai_refresh_") && store.locks.load(Ordering::SeqCst) >= 2,
                "sent {sent:?} after {} locks; want the first client's tokens twice",
                store.locks.load(Ordering::SeqCst)
            );
            Ok(())
        }),
        "auth.oauth-refresh-refused" => Box::pin(async move {
            let store = Arc::new(MemoryTokenStore::new(Some(OAuthTokens {
                access_token: "old".into(),
                refresh_token: Some("rt_unknown".into()),
                expires_at: Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
                scope: None,
            })));
            let e = auth_err(read(&client_with(m, Auth::oauth("studio-client").token_store(store.clone()))).await)?;
            ensure!(
                e.code == "invalid_grant" && store.get().is_none(),
                "got {e:?}, store {:?}",
                store.get()
            );
            Ok(())
        }),
        "auth.oauth-not-signed-in" => Box::pin(async move {
            let e = auth_err(read(&client_with(m, Auth::oauth("studio-client"))).await)?;
            ensure!(e.code == "sign_in_required" && m.api().await.is_empty(), "got {e:?}");
            Ok(())
        }),
        "auth.aws-iam" => Box::pin(async move {
            let c = client_with(m, aws(m));
            let (a, b) = tokio::join!(read(&c), read(&c));
            a.and(b).map_err(s)?;
            let n = m.counts().await;
            ensure!(
                n["sts"] == json!(1) && n["urn:ietf:params:oauth:grant-type:token-exchange"] == json!(1),
                "counts {n}"
            );
            ensure!(
                header(&m.api().await[0], "authorization")
                    .unwrap_or_default()
                    .starts_with("Bearer cai_x_aws_"),
                "authorization"
            );
            let sts = m.matching(|r| str_at(r, "path") == "/__sts/").await.pop().ok_or("no STS call")?;
            let form: BTreeMap<String, String> = url::form_urlencoded::parse(str_at(&sts, "body").as_bytes()).into_owned().collect();
            ensure!(
                form["Audience.member.1"] == RESOURCE && form["SigningAlgorithm"] == "ES384" && form["DurationSeconds"] == "300",
                "form {form:?}"
            );
            Ok(())
        }),
        "auth.aws-iam-provider" => Box::pin(async move {
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = calls.clone();
            let provider = ProviderFn(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                async { Ok(AwsCredentials::new("AKIDMOCKCAITLYN", "mock-secret-key", None)) }
            });
            read(&client_with(m, aws(m).credentials(provider))).await.map_err(s)?;
            ensure!(
                calls.load(Ordering::SeqCst) == 1,
                "provider called {} times",
                calls.load(Ordering::SeqCst)
            );
            Ok(())
        }),
        "auth.aws-iam-env" => Box::pin(async move {
            let vars = [
                ("AWS_ACCESS_KEY_ID", "AKIDMOCKCAITLYN"),
                ("AWS_SECRET_ACCESS_KEY", "mock-secret-key"),
                ("AWS_REGION", "ap-southeast-2"),
            ];
            for (k, v) in vars {
                std::env::set_var(k, v);
            }
            let r = read(&client_with(m, Auth::aws_iam().sts_endpoint(format!("{}/__sts/", m.base)))).await;
            for (k, _) in vars {
                std::env::remove_var(k);
            }
            r.map_err(s)?;
            ensure!(m.counts().await["sts"] == json!(1), "counts {}", m.counts().await);
            Ok(())
        }),
        "auth.aws-iam-bad-signature" => Box::pin(async move {
            let e = auth_err(
                read(&client_with(
                    m,
                    aws(m).credentials(AwsCredentials::new("AKIDMOCKCAITLYN", "wrong", None)),
                ))
                .await,
            )?;
            ensure!(e.code == "SignatureDoesNotMatch" && m.api().await.is_empty(), "got {e:?}");
            Ok(())
        }),
        "auth.workload-identity" => Box::pin(async move {
            let asked = Arc::new(AtomicUsize::new(0));
            let a = asked.clone();
            read(&client_with(
                m,
                Auth::workload_identity(move || {
                    a.fetch_add(1, Ordering::SeqCst);
                    async { Ok(oidc_token(RESOURCE)) }
                }),
            ))
            .await
            .map_err(s)?;
            ensure!(asked.load(Ordering::SeqCst) == 1, "asked {} times", asked.load(Ordering::SeqCst));
            ensure!(
                header(&m.api().await[0], "authorization")
                    .unwrap_or_default()
                    .starts_with("Bearer cai_x_oidc_"),
                "authorization"
            );
            let e = auth_err(
                read(&client_with(
                    m,
                    Auth::workload_identity(|| async { Ok(oidc_token("https://other.caitlyn.ai/api")) }),
                ))
                .await,
            )?;
            ensure!(e.code == "invalid_grant", "got {e:?}");
            Ok(())
        }),
        "auth.workload-identity-single-use" => Box::pin(async move {
            let jwt = oidc_token(RESOURCE);
            let (j1, j2) = (jwt.clone(), jwt);
            read(&client_with(
                m,
                Auth::workload_identity(move || {
                    let j = j1.clone();
                    async move { Ok(j) }
                }),
            ))
            .await
            .map_err(s)?;
            let e = auth_err(
                read(&client_with(
                    m,
                    Auth::workload_identity(move || {
                        let j = j2.clone();
                        async move { Ok(j) }
                    }),
                ))
                .await,
            )?;
            ensure!(e.code == "invalid_grant", "got {e:?}");
            Ok(())
        }),
        "auth.session" => Box::pin(async move {
            let c = client_with(m, Auth::session("caitlyn_session=mock-session").origin("https://caitlyn.lndo.site"));
            let v = read(&c).await.map_err(s)?;
            c.agent(AGENT)
                .draft()
                .update()
                .input(UpdateDraftVersionInput {
                    guidance: Some(AgentGuidance {
                        instructions: Some("Cite clause numbers.".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .if_match(&v.etag)
                .await
                .map_err(s)?;
            let reqs = m.api().await;
            let (get, patch) = (&reqs[0], &reqs[1]);
            ensure!(
                header(get, "authorization").is_none()
                    && header(get, "cookie") == Some("caitlyn_session=mock-session")
                    && header(get, "origin").is_none(),
                "get {get}"
            );
            ensure!(
                header(patch, "origin") == Some("https://caitlyn.lndo.site") && header(patch, "authorization").is_none(),
                "patch {patch}"
            );
            Ok(())
        }),
        _ => return None,
    })
}

const AUTH_CASES: &[(&str, &str)] = &[
    (
        "auth.workspace",
        "the workspace decides the endpoint and the audience; endpoint overrides only where requests go",
    ),
    (
        "auth.token",
        "a personal access token is sent as the bearer token, with no token request",
    ),
    (
        "auth.client-credentials",
        "one token request serves concurrent calls, bound to the workspace resource",
    ),
    (
        "auth.client-credentials-refused",
        "a wrong secret is an Error::Auth with the OAuth code",
    ),
    (
        "auth.renew-before-expiry",
        "a token is replaced before it expires: a minute early, or halfway through a short life",
    ),
    (
        "auth.401-signs-in-again",
        "a token the server stopped accepting is replaced once, and the call succeeds",
    ),
    (
        "auth.401-token-mode",
        "a refused personal access token fails with 401, without retrying",
    ),
    (
        "auth.oauth-sign-in",
        "authorisation code with PKCE, then calls with the saved token",
    ),
    (
        "auth.oauth-state",
        "a callback whose state does not match is refused before any token request",
    ),
    (
        "auth.oauth-refresh",
        "an expired access token is refreshed with the stored refresh token, and the rotated one saved",
    ),
    (
        "auth.oauth-refresh-refused",
        "a refused refresh token clears the store and asks for sign-in",
    ),
    (
        "auth.oauth-not-signed-in",
        "a call before sign-in fails with sign_in_required and sends nothing",
    ),
    (
        "auth.aws-iam",
        "a signed STS GetWebIdentityToken call, one token exchange, then bearer calls",
    ),
    (
        "auth.aws-iam-provider",
        "credentials can come from a provider, as the AWS SDK's credential chain does",
    ),
    (
        "auth.aws-iam-env",
        "without credentials it uses AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
    ),
    ("auth.aws-iam-bad-signature", "an STS refusal is an Error::Auth with the STS code"),
    (
        "auth.workload-identity",
        "a CI identity token is exchanged once; a token for another workspace is refused",
    ),
    ("auth.workload-identity-single-use", "a replayed identity token is refused"),
    ("auth.session", "the session cookie, Origin on writes, and no Authorization header"),
    (
        "auth.401-once",
        "a second 401 after signing in again is raised, with no third attempt",
    ),
    (
        "auth.oauth-401-refreshes",
        "a stored access token the server refuses is not sent again: the refresh token replaces it",
    ),
    (
        "auth.aws-iam-no-credentials",
        "with no AWS credentials anywhere, awsIam fails with aws_identity_failed and sends nothing",
    ),
];

// ---------------------------------------------------------------------------------------------- Rust only

fn rust_case<'a>(id: &str, m: &'a Mock) -> Option<Fut<'a>> {
    Some(match id {
        "rust.sync-upload-failed" => Box::pin(async move {
            m.faults(json!({"failUploads": {"/new/b.pdf": true}})).await;
            let seen = Arc::new(Mutex::new(Vec::<(String, String, Option<String>)>::new()));
            let s2 = seen.clone();
            let items = vec![
                SyncItem::file("/new/a.pdf", pdf("a.pdf", b"alpha")),
                SyncItem::file("/new/b.pdf", pdf("b.pdf", b"bravo")),
                SyncItem::file("/new/c.pdf", pdf("c.pdf", b"charlie")),
            ];
            let input = SyncInput::items(items).on_item(move |it: &IngestionBatchItem| {
                s2.lock().unwrap().push((
                    it.path.clone().unwrap_or_default(),
                    it.status.as_str().to_owned(),
                    it.failure_code.clone(),
                ));
            });
            let report = client(m).knowledge_base(KB).ingestion().sync(input).await.map_err(s)?;
            let b = report
                .items
                .iter()
                .find(|i| i.path.as_deref() == Some("/new/b.pdf"))
                .ok_or("no b")?;
            ensure!(
                b.status.as_str() == "failed" && b.failure_code.as_deref() == Some("UPLOAD_FAILED"),
                "b {:?} {:?}",
                b.status,
                b.failure_code
            );
            let others_indexed = report
                .items
                .iter()
                .filter(|i| i.path.as_deref() != Some("/new/b.pdf"))
                .all(|i| i.status.as_str() == "indexed");
            ensure!(others_indexed && report.items.len() == 3, "items {:?}", report.items);
            let on_b: Vec<_> = seen.lock().unwrap().iter().filter(|x| x.0 == "/new/b.pdf").cloned().collect();
            ensure!(
                on_b == [("/new/b.pdf".to_owned(), "failed".to_owned(), Some("UPLOAD_FAILED".to_owned()))],
                "on_item for b {on_b:?}"
            );
            let completed: Vec<Value> = bodies(m, "POST", "complete-uploads")
                .await
                .iter()
                .flat_map(|b| b["itemIds"].as_array().cloned().unwrap_or_default())
                .collect();
            ensure!(completed.len() == 2 && !completed.contains(&json!(b.id)), "completed {completed:?}");
            Ok(())
        }),
        "rust.document-replace" => Box::pin(async move {
            let doc = client(m).knowledge_base(KB).document("doc-0002");
            let started = doc
                .replace(pdf("policy-2.pdf", b"the 2027 version"))
                .note("2027")
                .if_match("\"doc-0002-1\"")
                .send()
                .await
                .map_err(s)?;
            let create = m
                .matching(|r| str_at(r, "method") == "POST" && str_at(r, "path").ends_with("/documents/doc-0002/versions"))
                .await;
            ensure!(
                create.len() == 1 && header(&create[0], "if-match") == Some("\"doc-0002-1\""),
                "create {create:?}"
            );
            let body: Value = serde_json::from_str(str_at(&create[0], "body")).map_err(s)?;
            ensure!(
                body["note"] == "2027" && body["uploadId"].as_str().is_some_and(|u| !u.is_empty()),
                "body {body}"
            );
            ensure!(started.result == VersionResult::Created, "result {:?}", started.result);
            let indexed = started.wait().await.map_err(s)?;
            ensure!(
                indexed.id == "doc-0002" && indexed.status.as_str() == "indexed",
                "indexed {indexed:?}"
            );
            Ok(())
        }),
        "rust.typed-error-has-problem" => Box::pin(async move {
            let r = client(m).agent(AGENT).version("v99").get().await;
            let e = r.err().ok_or("no error")?;
            ensure!(
                matches!(e, Error::NotFound(_)) && e.status() == Some(404) && e.shape() == Some("NotFoundError"),
                "got {e:?}"
            );
            Ok(())
        }),
        "rust.final-message-after-break" => Box::pin(async move {
            let mut stream = send(&client(m), "c-7").await.map_err(s)?;
            stream.next().await.ok_or("no event")?.map_err(s)?;
            let answer = stream.final_message().await.map_err(s)?;
            ensure!(answer.text == ANSWER, "answer {answer:?}");
            Ok(())
        }),
        "rust.if-match-required-before-sending" => Box::pin(async move {
            // ResetDraftVersion requires If-Match (the model does not mark it @ifMatchOptional).
            let r = client(m).agent(AGENT).draft().reset("live").await;
            ensure!(matches!(r, Err(Error::Input(_))) && m.api().await.is_empty(), "got {:?}", r.err());
            Ok(())
        }),
        "rust.stream-is-incremental" => Box::pin(async move {
            m.faults(json!({"streamDelayMs": 100})).await;
            let t0 = Instant::now();
            let mut stream = send(&client(m), "c-5").await.map_err(s)?;
            let first = stream.next().await.ok_or("no event")?.map_err(s).map(|_| t0.elapsed())?;
            let answer = stream.final_message().await.map_err(s)?;
            ensure!(
                answer.text == ANSWER && first < Duration::from_millis(500),
                "first event after {first:?}"
            );
            Ok(())
        }),
        "rust.drop-closes-stream" => Box::pin(async move {
            m.faults(json!({"streamDelayMs": 150})).await;
            let mut stream = send(&client(m), "c-4").await.map_err(s)?;
            stream.next().await.ok_or("no event")?.map_err(s)?;
            drop(stream);
            tokio::time::sleep(Duration::from_millis(300)).await;
            ensure!(
                !m.matching(|r| str_at(r, "event") == "client-disconnected").await.is_empty(),
                "the mock saw no disconnect"
            );
            Ok(())
        }),
        "rust.batch-handles" => Box::pin(async move {
            let c = client(m);
            let kb = c.knowledge_base(KB);
            // create: Created, whose wait() follows the batch (here until it is planned and started by hand).
            let created = kb
                .ingestion()
                .batches()
                .create()
                .start(StartMode::Manual)
                .items(vec![remove_item("/policies/policy-6.pdf")])
                .await
                .map_err(s)?;
            created.planned().await.map_err(s)?;
            // start: result() is StartIngestionBatchResult, wait() the ended batch.
            let started = created.start().send().await.map_err(s)?;
            let r: &StartIngestionBatchResult = started.result();
            ensure!(r.batch.id == created.id(), "start result {r:?}");
            let ended: IngestionBatch = started.wait().await.map_err(s)?;
            ensure!(ended.status.as_str() == "succeeded", "start's wait {ended:?}");
            let waited: IngestionBatch = created.wait().await.map_err(s)?;
            ensure!(waited.id == ended.id, "create's wait {waited:?}");
            // cancel: result() is the batch as cancelled, wait() follows it to cancelled.
            let other = hand_batch(&c, vec![ingest_item("/new/x.pdf", b"x")], false).await?;
            let cancelling = other.cancel().send().await.map_err(s)?;
            let _: &IngestionBatch = cancelling.result();
            // How it ends ([wait.cancel-returns]) is that case's: here, that it follows the batch to its end.
            let r = cancelling.wait().await;
            ensure!(
                r.as_ref().is_ok_and(|b| b.status.as_str() == "cancelled")
                    || r.as_ref().err().is_some_and(|e| e.code() == Some("CANCELLED")),
                "cancel's wait {r:?}"
            );
            // cancel_processing: result() is the document, wait() follows it until no job runs on it, then reads it.
            m.faults(json!({"busyDocuments": {"doc-0001": true}, "holdJobs": {"doc-0001": true}, "cancellableProcessing": true}))
                .await;
            let doc = c.knowledge_base(KB).document("doc-0001");
            let mut watch = doc.watch().await.map_err(s)?;
            watch.next().await.ok_or("no snapshot")?.map_err(s)?;
            drop(watch);
            let stopping = doc.cancel_processing().send().await.map_err(s)?;
            let _: &Document = stopping.result();
            ensure!(stopping.result().id == "doc-0001", "result {:?}", stopping.result());
            let idle: Document = stopping.wait().await.map_err(s)?;
            ensure!(idle.id == "doc-0001" && idle.processing.is_none(), "cancel_processing: {idle:?}");
            Ok(())
        }),
        "rust.into-stream" => Box::pin(async move {
            use futures_util::StreamExt;
            let mut stream = std::pin::pin!(send(&client(m), "c-8").await.map_err(s)?.into_stream());
            let mut n = 0;
            while let Some(ev) = stream.next().await {
                ev.map_err(s)?;
                n += 1;
            }
            ensure!(n == 8, "{n} events");
            Ok(())
        }),
        _ => return None,
    })
}

const RUST_CASES: &[(&str, &str)] = &[
    (
        "rust.sync-upload-failed",
        "an upload that fails after its retries fails only its item (UPLOAD_FAILED, through on_item and the report, never completed); the rest carry on",
    ),
    (
        "rust.document-replace",
        "doc.replace(file) uploads the file and adds a version with If-Match and the note; its wait() returns the document indexed",
    ),
    (
        "rust.typed-error-has-problem",
        "a typed variant also reads as a problem: status, code, shape",
    ),
    (
        "rust.final-message-after-break",
        "final_message drains the rest of the stream after the caller stops reading",
    ),
    (
        "rust.if-match-required-before-sending",
        "a reset without if_match fails before anything is sent",
    ),
    (
        "rust.stream-is-incremental",
        "events arrive as they are sent, not after the stream ends",
    ),
    ("rust.drop-closes-stream", "dropping a stream closes the connection"),
    ("rust.into-stream", "a stream is also a futures Stream"),
    (
        "rust.batch-handles",
        "start, cancel, a batch's create and cancel_processing give handles: result() is the response, wait() follows the thing to its end",
    ),
];

// ---------------------------------------------------------------------------------------------- runner

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let filter = std::env::args().skip(1).find(|a| !a.starts_with('-')).unwrap_or_default();

    let port = 4900 + (std::process::id() % 300);
    let mut server = tokio::process::Command::new("node")
        .arg(root().join("conformance/mock-server/server.mjs"))
        .env("PORT", port.to_string())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("node: the suite needs Node to run the mock server");
    {
        use tokio::io::AsyncBufReadExt;
        let mut line = String::new();
        tokio::io::BufReader::new(server.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .expect("mock server");
    }
    let m = Mock {
        base: format!("http://127.0.0.1:{port}"),
        http: reqwest::Client::new(),
    };

    let mut cases: Vec<(String, String, &str)> = Vec::new(); // (name, id, kind)
    let catalogue = read_json("conformance/cases/protocol.json")["cases"].as_array().unwrap().clone();
    for c in &catalogue {
        let id = str_at(c, "id");
        let kind = if id.starts_with("auth.") { "auth" } else { "protocol" };
        cases.push((format!("[{id}] {}", str_at(c, "title")), id.to_owned(), kind));
    }
    let examples = read_json("conformance/cases/examples.json")["cases"].as_array().unwrap().clone();
    for ex in &examples {
        cases.push((format!("[example] {}", str_at(ex, "id")), str_at(ex, "id").to_owned(), "example"));
    }
    // The sign-in cases the shared catalogue doesn't list yet.
    for (id, title) in AUTH_CASES {
        if !catalogue.iter().any(|c| str_at(c, "id") == *id) {
            cases.push((format!("[{id}] {title}"), (*id).to_owned(), "auth"));
        }
    }
    for (id, title) in RUST_CASES {
        cases.push((format!("[{id}] {title}"), (*id).to_owned(), "rust"));
    }

    let mut results = serde_json::Map::new();
    let (mut passed, mut failed) = (0, 0);
    for (name, id, kind) in cases {
        if !name.contains(&filter) {
            continue;
        }
        m.reset().await;
        if kind == "auth" {
            m.faults(json!({"auth": {"require": true}})).await;
        }
        let t0 = Instant::now();
        let fut = match kind {
            "protocol" => protocol(&id, &m),
            "auth" => auth_case(&id, &m),
            "rust" => rust_case(&id, &m),
            _ => {
                let ex = examples.iter().find(|e| str_at(e, "id") == id).unwrap();
                Some(Box::pin(example(&m, ex)) as Fut)
            }
        };
        let r = match fut {
            Some(f) => tokio::time::timeout(Duration::from_secs(30), f)
                .await
                .unwrap_or_else(|_| Err("timed out after 30 s".into())),
            None => Err(format!("no Rust test for {kind} case {id}")),
        };
        match &r {
            Ok(()) => {
                passed += 1;
                println!("ok    {name} ({} ms)", t0.elapsed().as_millis());
            }
            Err(e) => {
                failed += 1;
                println!("FAIL  {name}: {e}");
            }
        }
        results.insert(name, json!(r.is_ok()));
    }
    let report = root().join("build/conformance/rust.json");
    std::fs::create_dir_all(report.parent().unwrap()).expect("report dir");
    std::fs::write(&report, serde_json::to_string_pretty(&json!({"results": results})).unwrap()).expect("report");
    println!("\n{passed} passed, {failed} failed");
    let _ = server.kill().await;
    std::process::exit(if failed > 0 { 1 } else { 0 });
}
