//! Watching and waiting (PROTOCOL.md section 16).
//!
//! A scope's `watch()` opens the knowledge base's watch with the scope's identifier as its filter. Every connection
//! starts with a `snapshot`, and a dropped connection is reopened with no cursor ([`StreamSpec::fresh`](crate::StreamSpec)),
//! so the new connection's snapshot is yielded again. `wait()` is built on it: [`follow`] reads the events as JSON (the
//! shape the generated events serialise to, with `type` added) and decides when the thing is done, gone or failed.
//! The generated crate turns the outcome into the thing (as its `get` returns it) or `()`.

use std::collections::HashMap;
use std::future::IntoFuture;
use std::ops::Deref;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{ApiError, Error};
use crate::request::{BoxFuture, CallOptions};
use crate::stream::Stream;

/// Options for one wait: a time limit (none by default) and cancellation.
#[derive(Debug, Clone, Default)]
pub struct WaitOptions {
    pub(crate) timeout: Option<Duration>,
    pub(crate) cancel: Option<CancellationToken>,
}

impl WaitOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fails the wait with `Error::Timeout` once `limit` has passed, closing the watch. There is no limit by default.
    pub fn timeout(mut self, limit: Duration) -> Self {
        self.timeout = Some(limit);
        self
    }

    /// Fails the wait with `Cancelled` when `token` fires, closing the watch.
    pub fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// The options for the calls the wait makes: its cancellation.
    pub fn call_options(&self) -> CallOptions {
        match &self.cancel {
            Some(t) => CallOptions::default().cancel_on(t.clone()),
            None => CallOptions::default(),
        }
    }
}

/// A wait's progress callback, called with the thing's processing as the wait sees it change.
pub type ProgressFn<P> = Arc<dyn Fn(&P) + Send + Sync>;

type WaitRun<T, Er, P> = Box<dyn FnOnce(WaitOptions, Option<ProgressFn<P>>) -> BoxFuture<'static, Result<T, Er>> + Send>;

/// A wait that has not started: set a time limit, cancellation or a progress callback, then `.await` it (PROTOCOL.md
/// 16). `P` is what the progress callback is given (the generated crate's `Processing`).
#[must_use = "a wait does nothing until it is awaited"]
pub struct Waiting<T, Er, P = ()> {
    opts: WaitOptions,
    progress: Option<ProgressFn<P>>,
    run: WaitRun<T, Er, P>,
}

impl<T, Er, P> std::fmt::Debug for Waiting<T, Er, P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Waiting").field("opts", &self.opts).finish_non_exhaustive()
    }
}

impl<T, Er, P> Waiting<T, Er, P> {
    pub fn new(run: impl FnOnce(WaitOptions, Option<ProgressFn<P>>) -> BoxFuture<'static, Result<T, Er>> + Send + 'static) -> Self {
        Waiting {
            opts: WaitOptions::default(),
            progress: None,
            run: Box::new(run),
        }
    }

    /// Calls `f` with the thing's processing: first the snapshot's, if it is being processed, then each progress
    /// event's, in order. It is never called once the wait has returned or raised.
    pub fn on_progress(mut self, f: impl Fn(&P) + Send + Sync + 'static) -> Self {
        self.progress = Some(Arc::new(f));
        self
    }

    /// Sets (or clears) the progress callback, as [`on_progress`](Self::on_progress) does.
    pub fn progress(mut self, f: Option<ProgressFn<P>>) -> Self {
        self.progress = f;
        self
    }

    /// Fails the wait with `Error::Timeout` once `limit` has passed, closing the watch. There is no limit by default.
    pub fn timeout(mut self, limit: Duration) -> Self {
        self.opts.timeout = Some(limit);
        self
    }

    /// Fails the wait with `Cancelled` when `token` fires.
    pub fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.opts.cancel = Some(token);
        self
    }

    /// Replaces every wait option at once.
    pub fn options(mut self, opts: WaitOptions) -> Self {
        self.opts = opts;
        self
    }
}

impl<T, Er, P> IntoFuture for Waiting<T, Er, P> {
    type Output = Result<T, Er>;
    type IntoFuture = BoxFuture<'static, Result<T, Er>>;

    fn into_future(self) -> Self::IntoFuture {
        (self.run)(self.opts, self.progress)
    }
}

/// A scope that can be waited on: the generated scopes with a watch implement it. `follow` waits for the job a call
/// started (or, with `None`, until nothing runs on the thing).
pub trait Follow {
    /// What the wait returns: the thing, as its `get` returns it.
    type Output;
    type Error;
    /// What a wait's progress callback is given.
    type Progress;
    fn follow(&self, job: Option<String>) -> Waiting<Self::Output, Self::Error, Self::Progress>;
}

/// What a call that starts work returns (PROTOCOL.md 16): its output (`Deref` reaches it) and [`wait`](Self::wait),
/// which follows that work to its end.
pub struct Started<T, W, S, Er, P = ()> {
    pub output: T,
    wait: Arc<dyn Fn() -> Waiting<W, Er, P> + Send + Sync>,
    watch: WatchFn<S, Er>,
}

type WatchFn<S, Er> = Arc<dyn Fn() -> BoxFuture<'static, Result<S, Er>> + Send + Sync>;

impl<T: std::fmt::Debug, W, S, Er, P> std::fmt::Debug for Started<T, W, S, Er, P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Started").field("output", &self.output).finish_non_exhaustive()
    }
}

impl<T, W, S, Er, P> Started<T, W, S, Er, P> {
    pub fn new(
        output: T,
        wait: impl Fn() -> Waiting<W, Er, P> + Send + Sync + 'static,
        watch: impl Fn() -> BoxFuture<'static, Result<S, Er>> + Send + Sync + 'static,
    ) -> Self {
        Started {
            output,
            wait: Arc::new(wait),
            watch: Arc::new(watch),
        }
    }

    /// Watches the thing the work is on: a snapshot first, then each change (PROTOCOL.md 16).
    pub fn watch(&self) -> BoxFuture<'static, Result<S, Er>> {
        (self.watch)()
    }

    /// Waits until the work the call started has ended: the thing it changed (or `()` after a delete), or the
    /// error that stopped the work. A time limit and cancellation are options of the returned wait.
    pub fn wait(&self) -> Waiting<W, Er, P> {
        (self.wait)()
    }

    /// The call's response.
    pub fn result(&self) -> &T {
        &self.output
    }

    /// The call's response, owned.
    pub fn into_output(self) -> T {
        self.output
    }
}

impl<T, W, S, Er, P> Deref for Started<T, W, S, Er, P> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.output
    }
}

/// What a `create` returns (PROTOCOL.md 10): the new thing's scope (`Deref` reaches it, so `agent.draft()` works on
/// it at once) and the call's response, [`result`](Self::result): the thing itself for a create that returns one,
/// or its named result (CreateDocument's `{document, operation}`). Where the scope can be waited on,
/// [`wait`](Self::wait) follows the work the create started.
#[derive(Debug, Clone)]
pub struct Created<S, T> {
    scope: S,
    result: T,
    job: Option<String>,
}

impl<S, T> Created<S, T> {
    pub fn new(scope: S, result: T, job: Option<String>) -> Self {
        Created { scope, result, job }
    }

    /// The call's response: the new thing (a `KnowledgeBase`, an `Agent`…), or the create's named result.
    pub fn result(&self) -> &T {
        &self.result
    }

    /// The call's response, owned.
    pub fn into_result(self) -> T {
        self.result
    }

    /// The new thing's scope.
    pub fn scope(&self) -> &S {
        &self.scope
    }

    /// The new thing's scope, owned.
    pub fn into_scope(self) -> S {
        self.scope
    }

    /// The scope and the response, owned.
    pub fn into_parts(self) -> (S, T) {
        (self.scope, self.result)
    }

    /// The identifier of the job the create started, where it started one.
    pub fn job_id(&self) -> Option<&str> {
        self.job.as_deref()
    }
}

impl<S: Follow, T> Created<S, T> {
    /// Waits until the work the create started has ended, and returns the thing as its `get` would.
    pub fn wait(&self) -> Waiting<S::Output, S::Error, S::Progress> {
        self.scope.follow(self.job.clone())
    }
}

impl<S, T> Deref for Created<S, T> {
    type Target = S;
    fn deref(&self) -> &S {
        &self.scope
    }
}

/// A function called with each event a wait reads, as JSON.
pub type Observer = Box<dyn Fn(&Value) + Send + Sync>;

/// When a wait ends.
pub enum Until {
    /// No job runs on the thing (or the job named in [`Rules::job`] has ended).
    Idle,
    /// The thing is gone (after a delete), or the deleting job has ended.
    Gone,
    /// An ingestion batch is `planned` or past it.
    Planned,
    /// An ingestion batch has ended.
    Ended,
    /// The batch (as JSON) passes the test, or has ended.
    Batch(Box<dyn Fn(&Value) -> bool + Send + Sync>),
    /// A cancel's own wait (PROTOCOL.md 16): as the inner rule, except that the work ending cancelled is the answer,
    /// the thing as it stands, not the `CANCELLED` error.
    Cancelling(Box<Until>),
}

/// What a wait follows.
pub struct Rules {
    /// The snapshot member that holds the thing: `document`, `folder`, `batch` or `knowledgeBase`.
    pub thing: &'static str,
    /// For a document or a folder: the member of its deleted event that names it, and the value
    /// (`documentId` and the id, `path` and the folder's path).
    pub gone_when: Option<(&'static str, String)>,
    /// The job (Operation) the call started, when it returned one.
    pub job: Option<String>,
    pub until: Until,
    /// Every error code the model lists, with its HTTP status: a failed job raises the typed error for its code.
    pub codes: &'static [(&'static str, u16)],
    /// Called with each event (as JSON) before it is weighed: a caller's progress reports.
    pub observe: Option<Observer>,
}

/// How a wait ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Done: the thing as the last snapshot or event showed it (`Null` when the watch does not carry it).
    Ready(Value),
    /// The thing is gone.
    Gone,
}

const RUNNING: &[&str] = &["queued", "running"];
/// A thing in one of these states is still being worked on, whether or not a job says so (a knowledge base being set up).
const BUSY: &[&str] = &["creating", "moving", "deleting", "pending", "processing", "planning", "running"];
const BATCH_OPEN: &[&str] = &["draft", "planning", "planned", "running"];
const BATCH_PLANNING: &[&str] = &["draft", "planning"];

/// The typed error for a code: its status from the model's table (0 when the model does not list it).
pub fn coded_error(code: &str, detail: Option<&str>, codes: &[(&str, u16)]) -> Error {
    let status = codes.iter().find(|(c, _)| *c == code).map(|(_, s)| *s).unwrap_or(0);
    Error::Api(Box::new(ApiError {
        status,
        code: code.to_owned(),
        title: Some(detail.unwrap_or(code).to_owned()),
        detail: detail.map(str::to_owned),
        ..ApiError::default()
    }))
}

fn job_failure(job: &Value, codes: &[(&str, u16)]) -> Option<Error> {
    match job["status"].as_str()? {
        "failed" => Some(coded_error(
            // A job that failed with no code of its own (none, or an empty one) is JOB_FAILED (PROTOCOL.md 6.3).
            job["error"]["code"].as_str().filter(|c| !c.is_empty()).unwrap_or("JOB_FAILED"),
            job["error"]["detail"].as_str(),
            codes,
        )),
        "cancelled" => Some(Error::sdk("CANCELLED", "The work was cancelled", None)),
        _ => None,
    }
}

fn batch_failure(batch: &Value, codes: &[(&str, u16)]) -> Option<Error> {
    match batch["status"].as_str()? {
        "failed" => {
            let id = batch["id"].as_str().unwrap_or_default();
            let fallback = format!("Ingestion batch {id} failed");
            Some(coded_error(
                batch["failure"]["code"].as_str().unwrap_or("INGESTION_BATCH_FAILED"),
                Some(batch["failure"]["message"].as_str().unwrap_or(&fallback)),
                codes,
            ))
        }
        "cancelled" => Some(Error::sdk("CANCELLED", "The batch was cancelled", None)),
        _ => None,
    }
}

fn not_found() -> Error {
    Error::Api(Box::new(ApiError {
        status: 404,
        code: "NOT_FOUND".to_owned(),
        title: Some("The thing watched is gone".to_owned()),
        ..ApiError::default()
    }))
}

/// What the events so far say.
struct State {
    thing: Value,
    jobs: HashMap<String, Value>,
    gone: bool,
    snapshot: bool,
}

impl State {
    fn apply(&mut self, rules: &Rules, ev: &Value) {
        let ty = ev["type"].as_str().unwrap_or_default();
        match ty {
            "snapshot" => {
                self.snapshot = true;
                self.thing = ev[rules.thing].clone();
                self.jobs.clear();
                for j in ev["jobs"].as_array().into_iter().flatten() {
                    if let Some(id) = j["id"].as_str() {
                        self.jobs.insert(id.to_owned(), j.clone());
                    }
                }
                // A snapshot of a document or folder that no longer exists carries none.
                if rules.gone_when.is_some() && self.thing.is_null() {
                    self.gone = true;
                }
            }
            "job.progress" | "job.finished" => {
                if let Some(id) = ev["job"]["id"].as_str() {
                    self.jobs.insert(id.to_owned(), ev["job"].clone());
                }
            }
            _ if ty.ends_with(".deleted") => {
                if let Some((member, value)) = &rules.gone_when {
                    if ev[*member].as_str() == Some(value.as_str()) {
                        self.gone = true;
                    }
                }
            }
            _ => {}
        }
        // A change event carrying the thing (`document.updated`, `folder.updated`, `knowledge_base.updated`).
        if ty != "snapshot" && ev[rules.thing].is_object() {
            let same = match &rules.gone_when {
                Some((member, value)) => {
                    let key = if *member == "documentId" { "id" } else { *member };
                    ev[rules.thing][key].as_str() == Some(value.as_str())
                }
                None => true,
            };
            if same {
                self.thing = ev[rules.thing].clone();
            }
        }
    }

    /// `Some` once the wait has its answer.
    fn decide(&self, rules: &Rules) -> Option<Result<Outcome, Error>> {
        self.decide_until(rules, &rules.until)
    }

    fn decide_until(&self, rules: &Rules, until: &Until) -> Option<Result<Outcome, Error>> {
        if !self.snapshot {
            return None;
        }
        if let Until::Cancelling(inner) = until {
            return match self.decide_until(rules, inner) {
                Some(Err(e)) if e.code() == Some("CANCELLED") => Some(Ok(Outcome::Ready(self.thing.clone()))),
                r => r,
            };
        }
        let followed = rules.job.as_ref().and_then(|id| self.jobs.get(id));
        let running = self
            .jobs
            .values()
            .any(|j| RUNNING.contains(&j["status"].as_str().unwrap_or_default()));
        match until {
            // Unwrapped above.
            Until::Cancelling(_) => None,
            Until::Gone => {
                if self.gone {
                    return Some(Ok(Outcome::Gone));
                }
                match followed {
                    Some(j) if RUNNING.contains(&j["status"].as_str().unwrap_or_default()) => None,
                    // A job the delete stopped ends cancelled as part of the delete: keep waiting for the thing to go.
                    Some(j) if j["status"] == "cancelled" => None,
                    Some(j) => Some(match job_failure(j, rules.codes) {
                        Some(e) => Err(e),
                        None => Ok(Outcome::Gone),
                    }),
                    None => None,
                }
            }
            _ if self.gone => Some(Err(not_found())),
            Until::Planned | Until::Ended | Until::Batch(_) => {
                let status = self.thing["status"].as_str()?;
                let done = match until {
                    Until::Planned => !BATCH_PLANNING.contains(&status),
                    Until::Batch(test) => !BATCH_OPEN.contains(&status) || test(&self.thing),
                    _ => !BATCH_OPEN.contains(&status),
                };
                if !done {
                    return None;
                }
                Some(match batch_failure(&self.thing, rules.codes) {
                    Some(e) => Err(e),
                    None => Ok(Outcome::Ready(self.thing.clone())),
                })
            }
            Until::Idle => {
                let decisive = match followed {
                    Some(j) if RUNNING.contains(&j["status"].as_str().unwrap_or_default()) => return None,
                    Some(j) => Some(j),
                    None if running => return None,
                    None if rules.job.is_none() && BUSY.contains(&self.thing["status"].as_str().unwrap_or_default()) => return None,
                    // Nothing runs: the latest job to end decides.
                    None => self
                        .jobs
                        .values()
                        .filter(|j| rules.job.is_none() || j["id"].as_str() == rules.job.as_deref())
                        .max_by(|a, b| {
                            a["endedAt"]
                                .as_str()
                                .unwrap_or_default()
                                .cmp(b["endedAt"].as_str().unwrap_or_default())
                        }),
                };
                Some(match decisive.and_then(|j| job_failure(j, rules.codes)) {
                    Some(e) => Err(e),
                    None => Ok(Outcome::Ready(self.thing.clone())),
                })
            }
        }
    }
}

/// Decodes an event as JSON with `type`, its SSE event name, added: the shape generated events serialise to. For a
/// caller with no generated event types (the `sync` helper's batch watch).
pub fn decode_json(name: &str, _id: Option<&str>, data: &[u8]) -> Result<crate::stream::Decoded<Value>, serde_json::Error> {
    let mut v: Value = serde_json::from_slice(data)?;
    if let Value::Object(o) = &mut v {
        o.insert("type".to_owned(), Value::from(name));
    }
    Ok(crate::stream::Decoded::Event(v))
}

/// Opens the watch and follows it until `rules` say the wait is over (PROTOCOL.md 16). `open` opens one watch (the
/// stream reconnects by itself, with no cursor); `is_not_found` tells a 404 from the other errors, so that a thing
/// already gone ends a wait after a delete as success.
pub async fn follow<E, F, Er>(
    open: impl FnOnce(CallOptions) -> BoxFuture<'static, Result<Stream<E, F, Er>, Er>>,
    rules: Rules,
    opts: WaitOptions,
    is_not_found: fn(&Er) -> bool,
) -> Result<Outcome, Er>
where
    E: Serialize,
    F: Clone,
    Er: From<Error>,
{
    let timeout = opts.timeout;
    let cancel = opts.cancel.clone();
    let call_options = opts.call_options();
    let run = async move {
        let mut stream = match open(call_options).await {
            Ok(s) => s,
            Err(e) if is_not_found(&e) && matches!(rules.until, Until::Gone) => return Ok(Outcome::Gone),
            Err(e) => return Err(e),
        };
        let mut state = State {
            thing: Value::Null,
            jobs: HashMap::new(),
            gone: false,
            snapshot: false,
        };
        loop {
            let ev = match stream.next().await {
                Some(Ok(ev)) => ev,
                Some(Err(e)) if is_not_found(&e) && matches!(rules.until, Until::Gone) => return Ok(Outcome::Gone),
                Some(Err(e)) => return Err(e),
                None => return Err(Error::sdk("STREAM_LOST", "The watch ended before the wait was over", None).into()),
            };
            let v = serde_json::to_value(&ev).unwrap_or(Value::Null);
            if let Some(f) = &rules.observe {
                f(&v);
            }
            state.apply(&rules, &v);
            if let Some(r) = state.decide(&rules) {
                return r.map_err(Er::from);
            }
        }
    };
    let limited = async move {
        match timeout {
            Some(limit) => match tokio::time::timeout(limit, run).await {
                Ok(r) => r,
                // The watch is dropped with the future, which closes its connection.
                Err(_) => Err(Error::Timeout.into()),
            },
            None => run.await,
        }
    };
    match cancel {
        Some(t) => tokio::select! {
            biased;
            _ = t.cancelled() => Err(Error::Cancelled.into()),
            r = limited => r,
        },
        None => limited.await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(until: Until, job: Option<&str>) -> Rules {
        Rules {
            thing: "document",
            gone_when: Some(("documentId", "d1".to_owned())),
            job: job.map(str::to_owned),
            until,
            codes: &[("NOT_FOUND", 404), ("CONFLICT", 409)],
            observe: None,
        }
    }

    fn state() -> State {
        State {
            thing: Value::Null,
            jobs: HashMap::new(),
            gone: false,
            snapshot: false,
        }
    }

    #[test]
    fn idle_after_the_job_ends() {
        let r = rules(Until::Idle, None);
        let mut s = state();
        s.apply(
            &r,
            &json!({"type": "snapshot", "document": {"id": "d1"}, "jobs": [{"id": "j1", "status": "running"}]}),
        );
        assert!(s.decide(&r).is_none());
        s.apply(
            &r,
            &json!({"type": "job.finished", "job": {"id": "j1", "status": "completed_with_failures"}}),
        );
        assert_eq!(s.decide(&r).unwrap().unwrap(), Outcome::Ready(json!({"id": "d1"})));
    }

    #[test]
    fn a_failed_job_is_its_code() {
        let r = rules(Until::Idle, Some("j1"));
        let mut s = state();
        s.apply(&r, &json!({"type": "snapshot", "document": {"id": "d1"}, "jobs": []}));
        assert!(s.decide(&r).is_some(), "a job not in the snapshot has ended");
        s.apply(
            &r,
            &json!({"type": "job.finished", "job": {"id": "j1", "status": "failed", "error": {"code": "CONFLICT"}}}),
        );
        let e = s.decide(&r).unwrap().unwrap_err();
        assert_eq!((e.status(), e.code()), (Some(409), Some("CONFLICT")));
    }

    #[test]
    fn gone_after_a_delete() {
        let r = rules(Until::Gone, None);
        let mut s = state();
        s.apply(&r, &json!({"type": "snapshot", "document": {"id": "d1"}, "jobs": []}));
        assert!(s.decide(&r).is_none());
        s.apply(&r, &json!({"type": "document.deleted", "documentId": "d1"}));
        assert_eq!(s.decide(&r).unwrap().unwrap(), Outcome::Gone);
        let r = rules(Until::Idle, None);
        let e = s.decide(&r).unwrap().unwrap_err();
        assert_eq!(e.status(), Some(404));
    }
}
