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
const WORKSPACE: &str = "your-company.getcaitlyn.ai";
const RESOURCE: &str = "https://your-company.getcaitlyn.ai/api/v3";
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
    c.documents()
        .list(ListDocumentsInput {
            knowledge_base_id: kb.into(),
            limit,
            ..Default::default()
        })
        .collect()
        .await
}

async fn draft(c: &Client) -> Result<AgentVersion, Error> {
    c.versions()
        .get(GetAgentVersionInput {
            agent_id: AGENT.into(),
            version: "draft".into(),
        })
        .await
}

async fn send(c: &Client, conversation: &str) -> Result<ConversationEventStream, Error> {
    c.conversations()
        .send(
            conversation,
            SendMessageInput {
                message: "hi".into(),
                ..Default::default()
            },
        )
        .await
}

async fn collect(s: &mut ConversationEventStream) -> (Vec<ConversationEvent>, Option<Error>) {
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

fn sdk_model() -> String {
    read_json("model/model.lock.json")["stampNext"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
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
    fields: BTreeMap<String, String>,
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
            ..Default::default()
        };
        attrs.record(&mut Fields(&mut rec.fields));
        self.0.lock().unwrap().push(rec);
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
        "retry.idempotency-key-kept" => Box::pin(async move {
            m.faults(status("CreateUpload", &[(503, 0), (429, 0)])).await;
            let f = UploadFile::from_path(temp_file("hello.txt", b"hello")).map_err(s)?;
            client(m).uploads().create(f).await.map_err(s)?;
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

        // ------------------------------------------------------------------ SSE
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
            ensure!(!raw.contains_key("etag"), "raw holds the header-bound etag");
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
            let kbs = draft(&c).await.map_err(s)?.configuration.knowledge_bases.unwrap_or_default();
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
            let up = c
                .uploads()
                .reserve(CreateUploadInput {
                    file_name: "a.txt".into(),
                    content_type: "text/plain".into(),
                    byte_size: 1,
                    sha256: "x".into(),
                })
                .await
                .map_err(s)?;
            let r = c
                .documents()
                .create(CreateDocumentInput {
                    knowledge_base_id: KB.into(),
                    upload_id: up.id,
                    folder: "hr/".into(),
                    ..Default::default()
                })
                .await;
            ensure!(matches!(&r, Err(Error::Conflict(e)) if e.code == "CONFLICT"), "got {:?}", r.err());
            Ok(())
        }),
        "errors.412" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let update = |text: &str| UpdateDraftVersionInput {
                instructions: Some(text.into()),
                ..Default::default()
            };
            c.versions()
                .update_draft(AGENT, update("first"))
                .if_match(&d.etag)
                .await
                .map_err(s)?;
            let r = c.versions().update_draft(AGENT, update("second")).if_match(&d.etag).await;
            ensure!(
                matches!(&r, Err(Error::PreconditionFailed(e)) if e.code == "PRECONDITION_FAILED" && e.request_id.is_some()),
                "got {:?}",
                r.err()
            );
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
        "errors.field-errors" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let r = c
                .versions()
                .update_draft(
                    AGENT,
                    UpdateDraftVersionInput {
                        identity: Some("x".into()),
                        clear: Some(vec![ClearableDraftField::Identity]),
                        ..Default::default()
                    },
                )
                .if_match(&d.etag)
                .await;
            let Err(Error::Validation(e)) = &r else {
                return Err(format!("got {:?}", r.err()));
            };
            ensure!(
                e.code == "VALIDATION_FAILED"
                    && e.errors.len() == 1
                    && e.errors[0].pointer.as_deref() == Some("/identity")
                    && e.errors[0].code == "VALIDATION_FAILED",
                "got {e:?}"
            );
            let (_, body) = last_patch(m).await;
            ensure!(body == json!({"identity": "x", "clear": ["identity"]}), "body {body}");
            Ok(())
        }),

        // ------------------------------------------------------------------ cancellation
        "cancel.stream" => Box::pin(async move {
            m.faults(json!({"streamDelayMs": 150})).await;
            let token = CancellationToken::new();
            let mut stream = client(m)
                .conversations()
                .send(
                    "c-4",
                    SendMessageInput {
                        message: "hi".into(),
                        ..Default::default()
                    },
                )
                .cancel_on(token.clone())
                .await
                .map_err(s)?;
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
            let r = client(m)
                .versions()
                .get(GetAgentVersionInput {
                    agent_id: AGENT.into(),
                    version: "draft".into(),
                })
                .cancel_on(token)
                .await;
            ensure!(
                matches!(r, Err(Error::Cancelled)) && t0.elapsed() < Duration::from_secs(1),
                "got {:?} after {:?}",
                r.err(),
                t0.elapsed()
            );
            Ok(())
        }),

        // ------------------------------------------------------------------ updates
        "update.if-match" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let updated = c
                .versions()
                .update_draft(
                    AGENT,
                    UpdateDraftVersionInput {
                        instructions: Some("x".into()),
                        ..Default::default()
                    },
                )
                .if_match(&d.etag)
                .await
                .map_err(s)?;
            ensure!(!updated.etag.is_empty() && updated.etag != d.etag, "etag {:?}", updated.etag);
            let (p, body) = last_patch(m).await;
            ensure!(
                header(&p, "if-match") == Some(d.etag.as_str()) && body == json!({"instructions": "x"}),
                "patch {p}"
            );
            Ok(())
        }),
        "update.clear" => Box::pin(async move {
            let c = client(m);
            let d = draft(&c).await.map_err(s)?;
            let updated = c
                .versions()
                .update_draft(
                    AGENT,
                    UpdateDraftVersionInput {
                        clear: Some(vec![ClearableDraftField::Identity]),
                        ..Default::default()
                    },
                )
                .if_match(&d.etag)
                .await
                .map_err(s)?;
            ensure!(
                updated.configuration.identity.is_none() && updated.configuration.instructions == "Answer from the HR policies.",
                "updated {:?}",
                updated.configuration
            );
            let (_, body) = last_patch(m).await;
            ensure!(body == json!({"clear": ["identity"]}), "body {body}");
            Ok(())
        }),

        // ------------------------------------------------------------------ wire and environment
        "wire.headers" => Box::pin(async move {
            m.faults(status("GetAgentVersion", &[(503, 0)])).await;
            draft(&client(m)).await.map_err(s)?;
            let sent = m.api().await;
            ensure!(sent.len() == 2, "requests={}", sent.len());
            let ua = regex_lite::Regex::new(r"^caitlyn-sdk-rust/0\.0\.1 lang/rust#1\.\d+\.\d+ md/rustc os/[a-z]+$").unwrap();
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
                e.operation == "GetAgentVersion" && e.requires == sdk_model() && e.server == "5.110.0" && after == before,
                "got {e:?}, {after} requests"
            );
            Ok(())
        }),
        "headers.request-id" => Box::pin(async move {
            let v = draft(&client(m)).await.map_err(s)?;
            let reqs = m.api().await;
            ensure!(
                v.request_id.as_deref() == Some(str_at(reqs.last().unwrap(), "requestId")) && v.api_version.as_deref() == Some("5.120.0"),
                "request id {:?} api version {:?}",
                v.request_id,
                v.api_version
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
                .find(|r| r.fields.get("otel.name").map(String::as_str) == Some("caitlyn GetAgentVersion"))
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
        "endpoint.workspace" => Box::pin(async move {
            let c = Client::new(WORKSPACE, Auth::token(PAT)).map_err(s)?;
            ensure!(
                c.endpoint() == "https://your-company.getcaitlyn.ai/api",
                "endpoint {}",
                c.endpoint()
            );
            Ok(())
        }),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------------------------- example cases

fn labels(input: &Value, k: &str) -> String {
    str_at(input, k).to_owned()
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

async fn drain(r: Result<ConversationEventStream, Error>) -> Result<Value, Error> {
    let mut s = r?;
    while let Some(ev) = s.next().await {
        ev?;
    }
    Ok(Value::Null)
}

/// Calls the operation with an example's input. A new operation in the model fails until it has an entry here.
async fn call_example(c: &Client, op: &str, input: &Value) -> Option<Result<Value, Error>> {
    let body = |_: ()| input.clone();
    Some(match op {
        "CreateDocument" => {
            let mut i: CreateDocumentInput = serde_json::from_value(body(())).ok()?;
            i.knowledge_base_id = labels(input, "knowledgeBaseId");
            c.documents()
                .create(i)
                .options(options(input))
                .await
                .map(|o| with_headers(&o, &[("location", o.location.as_deref()), ("requestId", o.request_id.as_deref())]))
        }
        "CreateUpload" => {
            let i: CreateUploadInput = serde_json::from_value(body(())).ok()?;
            c.uploads()
                .reserve(i)
                .options(options(input))
                .await
                .map(|o| with_headers(&o, &[("location", o.location.as_deref()), ("requestId", o.request_id.as_deref())]))
        }
        "GetAgentVersion" => c
            .versions()
            .get(GetAgentVersionInput {
                agent_id: labels(input, "agentId"),
                version: labels(input, "version"),
            })
            .await
            .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str())), ("requestId", o.request_id.as_deref())])),
        "ListDocuments" => {
            let i = ListDocumentsInput {
                knowledge_base_id: labels(input, "knowledgeBaseId"),
                limit: input.get("limit").and_then(Value::as_i64).map(|n| n as i32),
                cursor: opt(input, "cursor"),
                sort: opt(input, "sort"),
                folder: opt(input, "folder"),
                status: opt(input, "status").map(DocumentStatus::from),
                name_prefix: opt(input, "namePrefix"),
            };
            match c.documents().list_pages(i).next().await? {
                Ok(p) => Ok(with_headers(&p, &[("requestId", p.request_id.as_deref())])),
                Err(e) => Err(e),
            }
        }
        "ResumeConversationStream" => {
            drain(
                c.conversations()
                    .resume(
                        labels(input, "conversationId"),
                        ResumeConversationStreamInput {
                            last_event_id: opt(input, "lastEventId"),
                        },
                    )
                    .await,
            )
            .await
        }
        "SendMessage" => {
            let i: SendMessageInput = serde_json::from_value(body(())).ok()?;
            drain(c.conversations().send(labels(input, "conversationId"), i).await).await
        }
        "UpdateDraftVersion" => {
            let i: UpdateDraftVersionInput = serde_json::from_value(body(())).ok()?;
            c.versions()
                .update_draft(labels(input, "agentId"), i)
                .options(options(input))
                .await
                .map(|o| with_headers(&o, &[("etag", Some(o.etag.as_str())), ("requestId", o.request_id.as_deref())]))
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

fn auth_case<'a>(id: &str, m: &'a Mock) -> Option<Fut<'a>> {
    let oauth = || Auth::oauth("studio-client").redirect_uri("https://app.example.com/callback");
    Some(match id {
        "auth.workspace" => Box::pin(async move {
            let plain = Client::new("https://your-company.getcaitlyn.ai/", Auth::token(PAT)).map_err(s)?;
            ensure!(
                plain.auth().workspace() == WORKSPACE && plain.workspace() == WORKSPACE,
                "workspace {}",
                plain.auth().workspace()
            );
            ensure!(plain.auth().resource() == RESOURCE, "resource {}", plain.auth().resource());
            ensure!(
                plain.auth().token_endpoint() == "https://your-company.getcaitlyn.ai/api/oauth/token",
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
                "https://your-company.getcaitlyn.ai/",
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
                    Auth::workload_identity(|| async { Ok(oidc_token("https://other.getcaitlyn.ai/api/v3")) }),
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
            c.versions()
                .update_draft(
                    AGENT,
                    UpdateDraftVersionInput {
                        instructions: Some("Cite clause numbers.".into()),
                        ..Default::default()
                    },
                )
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
        "rust.typed-error-has-problem" => Box::pin(async move {
            let r = client(m)
                .versions()
                .get(GetAgentVersionInput {
                    agent_id: AGENT.into(),
                    version: "v99".into(),
                })
                .await;
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
            let r = client(m)
                .versions()
                .update_draft(
                    AGENT,
                    UpdateDraftVersionInput {
                        instructions: Some("x".into()),
                        ..Default::default()
                    },
                )
                .await;
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
        "rust.typed-error-has-problem",
        "a typed variant also reads as a problem: status, code, shape",
    ),
    (
        "rust.final-message-after-break",
        "final_message drains the rest of the stream after the caller stops reading",
    ),
    (
        "rust.if-match-required-before-sending",
        "an update without if_match fails before anything is sent",
    ),
    (
        "rust.stream-is-incremental",
        "events arrive as they are sent, not after the stream ends",
    ),
    ("rust.drop-closes-stream", "dropping a stream closes the connection"),
    ("rust.into-stream", "a stream is also a futures Stream"),
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
