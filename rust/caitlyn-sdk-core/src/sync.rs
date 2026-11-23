//! The `ingestion.sync` helper (PROTOCOL.md 15): keeps a knowledge base in step with a folder of files, or a list of
//! items, through one ingestion batch, in the protocol's order: hash, create, plan (and price), resolve, start,
//! upload, wait.
//!
//! The generated crate's `kb.ingestion().sync(…)` runs [`run`], and `kb.ingestion().estimate_sync(…)` runs
//! [`estimate`], with its own types for the policy, the batch, the items, the resolutions and the estimate. Waiting
//! follows the knowledge base's watch for the batch ([`crate::watch`]).

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::client::Client;
use crate::error::Error;
use crate::request::{path_label, BoxFuture, CallOptions, Operation, Request};
use crate::stream::{batch_deadline, Reread, Stream, StreamSpec};
use crate::upload::{ExternalFailure, PreparedFile, UploadFile};
use crate::watch::{follow, Rules, Until};

/// Items per CreateIngestionBatch and BatchCreateIngestionBatchItems call.
pub const ITEMS_PER_CALL: usize = 10_000;
/// Item identifiers per CompleteIngestionBatchUploads call.
pub const COMPLETE_PER_CALL: usize = 100;
/// Documents per EstimateIngestion call.
pub const ESTIMATE_PER_CALL: usize = 10_000;
/// Uploads at once, unless the caller sets another number.
pub const DEFAULT_CONCURRENCY: usize = 6;
/// A policy with less time than this left is renewed before the next upload starts.
pub const RENEW_BEFORE: Duration = Duration::from_secs(5 * 60);
/// The keep-alive renews at most this often, so a policy that is already short cannot loop.
const KEEP_ALIVE_FLOOR: Duration = Duration::from_secs(1);

/// A file found in the folder, as the caller's functions see it.
#[derive(Debug, Clone)]
pub struct LocalFile {
    /// Where it is on disk.
    pub path: PathBuf,
    /// Its path under the folder, with `/` between the parts (`hr/leave-policy.pdf`).
    pub relative_path: String,
    /// Its size in bytes, when it was found.
    pub size: u64,
}

/// One item of a list given to `sync` instead of a folder.
#[derive(Debug, Clone)]
pub struct SyncItem {
    /// The document's path in the knowledge base (`/hr/leave-policy.pdf`).
    pub path: String,
    /// The file to send; `None` for an item that removes the document at `path`.
    pub file: Option<UploadFile>,
    pub external_id: Option<String>,
    pub source_url: Option<String>,
    pub metadata: Option<serde_json::Map<String, Value>>,
}

impl SyncItem {
    /// Adds `file` at `path`, or a new version of the document there.
    pub fn file(path: impl Into<String>, file: UploadFile) -> Self {
        SyncItem {
            path: path.into(),
            file: Some(file),
            external_id: None,
            source_url: None,
            metadata: None,
        }
    }

    /// Removes the document at `path`.
    pub fn remove(path: impl Into<String>) -> Self {
        SyncItem {
            path: path.into(),
            file: None,
            external_id: None,
            source_url: None,
            metadata: None,
        }
    }

    pub fn external_id(mut self, id: impl Into<String>) -> Self {
        self.external_id = Some(id.into());
        self
    }

    pub fn source_url(mut self, url: impl Into<String>) -> Self {
        self.source_url = Some(url.into());
        self
    }

    pub fn metadata(mut self, metadata: serde_json::Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

/// Where a progress report comes from (PROTOCOL.md 15).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPhase {
    /// Hashing the files: `done` and `total` count files.
    Checksum,
    /// Sending the files: `done` and `total` count bytes.
    Upload,
    /// The batch is being planned.
    Planning,
    /// Every item has an outcome.
    Planned,
    /// The files are in place and wait for ingestion.
    Queued,
    /// Ingestion is running: `done` counts items that finished.
    Processing,
    /// The batch's final status (`succeeded`, `completed_with_failures`, …).
    Final(String),
}

impl SyncPhase {
    /// `checksum`, `upload`, `planning`, `planned`, `queued`, `processing`, or the final status.
    pub fn as_str(&self) -> &str {
        match self {
            SyncPhase::Checksum => "checksum",
            SyncPhase::Upload => "upload",
            SyncPhase::Planning => "planning",
            SyncPhase::Planned => "planned",
            SyncPhase::Queued => "queued",
            SyncPhase::Processing => "processing",
            SyncPhase::Final(s) => s,
        }
    }
}

/// One progress report: the phase, how far it has got, and the item or file it is about, if any.
#[derive(Debug, Clone)]
pub struct IngestionProgress<It> {
    pub phase: SyncPhase,
    pub done: u64,
    pub total: u64,
    /// The batch item the report is about.
    pub item: Option<It>,
    /// The document path the report is about (a file hashed or sent).
    pub path: Option<String>,
}

/// What `sync` returns: the batch as it finished, and every item with its outcome, resolution, status, document,
/// version and failure. An item whose upload failed after its retries is `failed` with `UPLOAD_FAILED`.
#[derive(Debug, Clone)]
pub struct SyncReport<B, It> {
    pub batch: B,
    pub items: Vec<It>,
}

type Ext<F> = Option<Arc<F>>;
type FileFn<T> = Ext<dyn Fn(&LocalFile) -> Option<T> + Send + Sync>;
type ResolverFn<It, R> = Ext<dyn Fn(&It) -> Option<R> + Send + Sync>;
type ConfirmFn<B, It, Est> = Ext<dyn Fn(&SyncPlan<B, It, Est>) -> bool + Send + Sync>;
type ProgressFn<It> = Ext<dyn Fn(&IngestionProgress<It>) + Send + Sync>;

/// What `sync` keeps in step, and how: build it with [`SyncInput::dir`] or [`SyncInput::items`], then set
/// the options, or give a directory (`"./policies"`) or a list of items where a `SyncInput` is taken. `P` is the
/// policy type, `B` the batch, `It` an item, `R` a resolution and `Est` the estimate.
pub struct SyncInput<P, B, It, R, Est> {
    source: Source,
    folder: String,
    include: Vec<String>,
    exclude: Vec<String>,
    policy: Option<P>,
    external_id: FileFn<String>,
    source_url: FileFn<String>,
    metadata: FileFn<serde_json::Map<String, Value>>,
    remove_missing: bool,
    upload_window_seconds: Option<u32>,
    confirm: ConfirmFn<B, It, Est>,
    resolver: ResolverFn<It, R>,
    on_progress: ProgressFn<It>,
    on_item: Ext<dyn Fn(&It) + Send + Sync>,
    concurrency: usize,
    cancel_ingestion: bool,
    estimate_per_call: usize,
}

enum Source {
    Dir(PathBuf),
    Items(Vec<SyncItem>),
}

/// What `sync` will do, before anything is uploaded: the planned batch, its items (each with its outcome and
/// resolution) and the estimate for the items that need bytes (`None` when none do).
#[derive(Debug, Clone)]
pub struct SyncPlan<B, It, Est> {
    pub batch: B,
    pub items: Vec<It>,
    pub estimate: Option<Est>,
    /// Why `estimate` is `None` when EstimateIngestion failed: the error it returned. Only `confirm` sees it, and
    /// decides whether to go on without an estimate; `sync.estimate` returns the error instead (PROTOCOL.md 15).
    pub estimate_error: Option<Arc<Error>>,
}

impl<P, B, It, R, Est> From<&str> for SyncInput<P, B, It, R, Est> {
    fn from(dir: &str) -> Self {
        Self::dir(dir)
    }
}

impl<P, B, It, R, Est> From<String> for SyncInput<P, B, It, R, Est> {
    fn from(dir: String) -> Self {
        Self::dir(dir)
    }
}

impl<P, B, It, R, Est> From<&Path> for SyncInput<P, B, It, R, Est> {
    fn from(dir: &Path) -> Self {
        Self::dir(dir)
    }
}

impl<P, B, It, R, Est> From<PathBuf> for SyncInput<P, B, It, R, Est> {
    fn from(dir: PathBuf) -> Self {
        Self::dir(dir)
    }
}

impl<P, B, It, R, Est> From<Vec<SyncItem>> for SyncInput<P, B, It, R, Est> {
    fn from(items: Vec<SyncItem>) -> Self {
        Self::items(items)
    }
}

impl<P, B, It, R, Est> SyncInput<P, B, It, R, Est> {
    fn with(source: Source) -> Self {
        SyncInput {
            source,
            folder: "/".to_owned(),
            include: Vec::new(),
            exclude: Vec::new(),
            policy: None,
            external_id: None,
            source_url: None,
            metadata: None,
            remove_missing: false,
            upload_window_seconds: None,
            confirm: None,
            resolver: None,
            on_progress: None,
            on_item: None,
            concurrency: DEFAULT_CONCURRENCY,
            cancel_ingestion: false,
            estimate_per_call: ESTIMATE_PER_CALL,
        }
    }

    /// Every file under `dir` (symbolic links are not followed; a `.caitlynignore` file there, `include` and
    /// `exclude` filter them), put at the same relative paths under [`folder`](Self::folder).
    pub fn dir(dir: impl Into<PathBuf>) -> Self {
        Self::with(Source::Dir(dir.into()))
    }

    /// These items, at the paths they name.
    pub fn items(items: Vec<SyncItem>) -> Self {
        Self::with(Source::Items(items))
    }

    /// The knowledge-base folder a directory's files go under (default `/`). It is also the batch's scope, and the
    /// folder `remove_missing` looks in.
    pub fn folder(mut self, folder: impl Into<String>) -> Self {
        let mut f = folder.into();
        if !f.starts_with('/') {
            f.insert(0, '/');
        }
        if !f.ends_with('/') {
            f.push('/');
        }
        self.folder = f;
        self
    }

    /// Only files whose relative path matches one of these globs (`*`, `?`, `**`).
    pub fn include(mut self, glob: impl Into<String>) -> Self {
        self.include.push(glob.into());
        self
    }

    /// Leaves out files whose relative path matches this glob.
    pub fn exclude(mut self, glob: impl Into<String>) -> Self {
        self.exclude.push(glob.into());
        self
    }

    /// The rules that resolve each item's outcome.
    pub fn policy(mut self, policy: P) -> Self {
        self.policy = Some(policy);
        self
    }

    /// Each file's `externalId`.
    pub fn external_id(mut self, f: impl Fn(&LocalFile) -> String + Send + Sync + 'static) -> Self {
        self.external_id = Some(Arc::new(move |l| Some(f(l))));
        self
    }

    /// Each file's `sourceUrl`.
    pub fn source_url(mut self, f: impl Fn(&LocalFile) -> String + Send + Sync + 'static) -> Self {
        self.source_url = Some(Arc::new(move |l| Some(f(l))));
        self
    }

    /// Each file's metadata.
    pub fn metadata(mut self, f: impl Fn(&LocalFile) -> serde_json::Map<String, Value> + Send + Sync + 'static) -> Self {
        self.metadata = Some(Arc::new(move |l| Some(f(l))));
        self
    }

    /// Also removes each document under the folder that has no file.
    pub fn remove_missing(mut self, yes: bool) -> Self {
        self.remove_missing = yes;
        self
    }

    /// How long, in seconds, the batch waits for its files once it starts: each upload policy lasts this long. The
    /// server's default (30 minutes) when not set; a short window suits a test or a small batch sent at once.
    pub fn upload_window_seconds(mut self, seconds: u32) -> Self {
        self.upload_window_seconds = Some(seconds);
        self
    }

    /// Called with the plan (the planned batch, its items and the estimate) before anything is uploaded; `false`
    /// cancels the batch and fails the call with the cancellation error.
    pub fn confirm(mut self, f: impl Fn(&SyncPlan<B, It, Est>) -> bool + Send + Sync + 'static) -> Self {
        self.confirm = Some(Arc::new(f));
        self
    }

    /// Resolves an item the policy left `unresolved`; `None` leaves it so, and the call fails with
    /// `INGESTION_BATCH_UNRESOLVED`. Without a resolver, any unresolved item fails the call that way, leaving the batch
    /// planned for you to finish.
    pub fn resolver(mut self, f: impl Fn(&It) -> Option<R> + Send + Sync + 'static) -> Self {
        self.resolver = Some(Arc::new(f));
        self
    }

    /// Called with each progress report.
    pub fn on_progress(mut self, f: impl Fn(&IngestionProgress<It>) + Send + Sync + 'static) -> Self {
        self.on_progress = Some(Arc::new(f));
        self
    }

    /// Called once with each item as it finishes: an upload the server accepted, or, at the end, an item that
    /// needed none.
    pub fn on_item(mut self, f: impl Fn(&It) + Send + Sync + 'static) -> Self {
        self.on_item = Some(Arc::new(f));
        self
    }

    /// Uploads at once (default 6).
    pub fn concurrency(mut self, n: usize) -> Self {
        self.concurrency = n.max(1);
        self
    }

    /// When the call is cancelled, also cancel the batch with `ingestion: stop`, stopping ingestion already running.
    pub fn cancel_ingestion(mut self, yes: bool) -> Self {
        self.cancel_ingestion = yes;
        self
    }

    /// Documents per EstimateIngestion call (default and most 10,000), for tests.
    #[doc(hidden)]
    pub fn estimate_per_call(mut self, n: usize) -> Self {
        self.estimate_per_call = n.clamp(1, ESTIMATE_PER_CALL);
        self
    }
}

// ------------------------------------------------------------------ operations

macro_rules! op {
    ($name:ident, $op:literal, $method:literal, $safe:expr, $idem:expr, $if_match:expr) => {
        static $name: Operation = Operation {
            name: $op,
            method: $method,
            since: None,
            retry_safe: $safe,
            sse: false,
            idempotency_header: $idem,
            if_match_required: $if_match,
            retryable: &[429, 503],
            ranges: &[],
        };
    };
}

// CreateIngestionBatch's one caller-set value with a range (PROTOCOL.md 3): the model's `uploadWindowSeconds`, 60 to 3600.
// The other values sync sends are its own, inside their ranges. These operations are the runtime's, so the generated
// rules do not reach them.
static OP_CREATE: Operation = Operation {
    name: "CreateIngestionBatch",
    method: "POST",
    since: None,
    retry_safe: true,
    sse: false,
    idempotency_header: Some("Idempotency-Key"),
    if_match_required: false,
    retryable: &[429, 503],
    ranges: &[crate::ranges::Range {
        place: "body",
        path: "/uploadWindowSeconds",
        min: Some(60.0),
        max: Some(3600.0),
    }],
};
op!(OP_ADD_ITEMS, "BatchCreateIngestionBatchItems", "POST", false, None, false);
op!(OP_GET, "GetIngestionBatch", "GET", true, None, false);
op!(OP_LIST_ITEMS, "ListIngestionBatchItems", "GET", true, None, false);
op!(OP_RESOLVE, "UpdateIngestionBatchItem", "PATCH", true, None, true);
op!(OP_START, "StartIngestionBatch", "POST", false, None, true);
op!(
    OP_RENEW,
    "CreateIngestionBatchUploadPolicy",
    "POST",
    true,
    Some("Idempotency-Key"),
    false
);
op!(OP_COMPLETE, "CompleteIngestionBatchUploads", "POST", true, None, false);
op!(OP_CANCEL, "CancelIngestionBatch", "POST", true, None, false);
op!(OP_LIST_DOCUMENTS, "ListDocuments", "GET", true, None, false);
op!(OP_ESTIMATE, "EstimateIngestion", "POST", true, None, false);

static OP_WATCH: Operation = Operation {
    name: "WatchKnowledgeBase",
    method: "GET",
    since: None,
    retry_safe: true,
    sse: true,
    idempotency_header: None,
    if_match_required: false,
    retryable: &[429, 503],
    ranges: &[],
};

fn batch_path(kb: &str, id: &str, rest: &str) -> String {
    format!("/v3/knowledge-bases/{}/ingestion-batches/{}{rest}", path_label(kb), path_label(id))
}

async fn call_json(
    c: &Client,
    op: &'static Operation,
    mut req: Request,
    body: Option<&Value>,
    opts: &CallOptions,
) -> Result<(Value, Option<String>), Error> {
    if let Some(b) = body {
        req.json_body(b)?;
    }
    let resp = c.send(op, req, opts).await?;
    let etag = resp.header("etag");
    let v: Value = resp.json().await?;
    Ok((v, etag))
}

/// As [`call_json`], also decoding the body as `T` from its own bytes, so a map's order survives (serde_json's
/// `Value` sorts object keys).
async fn call_with<T: DeserializeOwned>(
    c: &Client,
    op: &'static Operation,
    mut req: Request,
    body: Option<&Value>,
    opts: &CallOptions,
) -> Result<(Value, T), Error> {
    if let Some(b) = body {
        req.json_body(b)?;
    }
    let resp = c.send(op, req, opts).await?;
    let operation = resp.operation;
    let bytes = resp
        .inner
        .bytes()
        .await
        .map_err(|e| Error::Connection(crate::error::ConnectionError::new(operation, e)))?;
    let parse = |e| Error::sdk("DECODE_FAILED", "The response could not be decoded", Some(Box::new(e)));
    let v: Value = serde_json::from_slice(&bytes).map_err(parse)?;
    let t: T = serde_json::from_slice(&bytes).map_err(parse)?;
    Ok((v, t))
}

fn sdk(code: &str, title: &str) -> Error {
    Error::sdk(code, title, None)
}

fn decode<T: DeserializeOwned>(v: &Value) -> Result<T, Error> {
    serde_json::from_value(v.clone()).map_err(|e| Error::sdk("DECODE_FAILED", "The response could not be decoded", Some(Box::new(e))))
}

/// The upload policy, with its form fields in the order the server gave them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    upload_url: String,
    form_fields: OrderedFields,
    #[serde(default)]
    max_byte_size: Option<u64>,
    /// None when the policy has no `expiresAt` (PROTOCOL.md 15): such a policy is renewed before each upload starts,
    /// and no keep-alive timer runs for it. One that is not a time fails the call that returned it (`DECODE_FAILED`).
    #[serde(default, with = "crate::time::rfc3339_option")]
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    /// When the policy arrived (decoded): its lifetime, for the renewal margin, runs from here to its expiresAt.
    #[serde(skip, default = "chrono::Utc::now")]
    received: chrono::DateTime<chrono::Utc>,
}

impl Policy {
    /// How long before its expiresAt the policy is renewed (PROTOCOL.md 15): [`RENEW_BEFORE`], or half its lifetime
    /// (from when it arrived to its expiresAt) when that is shorter, so a batch with a short upload window renews
    /// partway through each policy rather than at once and then once a second.
    fn margin(&self) -> chrono::Duration {
        let most = chrono::Duration::from_std(RENEW_BEFORE).unwrap_or_default();
        match self.expires_at {
            None => most,
            Some(e) => most.min((e - self.received).max(chrono::Duration::zero()) / 2),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct OrderedFields(Vec<(String, String)>);

/// A form field an upload sends itself after the policy's (PROTOCOL.md 15, step 6), compared without regard to case as
/// storage compares form field names.
fn is_own_form_field(name: &str) -> bool {
    ["key", "content-type", "x-amz-checksum-algorithm", "x-amz-checksum-sha256", "file"]
        .iter()
        .any(|own| name.eq_ignore_ascii_case(own))
}

impl<'de> Deserialize<'de> for OrderedFields {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = OrderedFields;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of form fields")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<OrderedFields, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, String>()? {
                    out.push((k, v));
                }
                Ok(OrderedFields(out))
            }
        }
        d.deserialize_map(V)
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PolicyHolder {
    upload_policy: Option<Policy>,
}

// ------------------------------------------------------------------ the walk

/// A glob over a `/`-separated relative path: `*` and `?` within a part, `**` across parts. A glob without `/`
/// matches a file name at any depth; one ending in `/` matches everything under such a folder.
pub fn glob_matches(glob: &str, path: &str) -> bool {
    let glob = glob.trim_start_matches("./");
    if let Some(dir) = glob.strip_suffix('/') {
        let parts: Vec<&str> = path.split('/').collect();
        return (1..parts.len()).any(|n| glob_matches(dir, &parts[..n].join("/")));
    }
    if !glob.contains('/') {
        return path.split('/').any(|p| segment_matches(glob.as_bytes(), p.as_bytes()));
    }
    let g: Vec<&str> = glob.trim_start_matches('/').split('/').collect();
    let p: Vec<&str> = path.split('/').collect();
    parts_match(&g, &p)
}

fn parts_match(g: &[&str], p: &[&str]) -> bool {
    match g.first() {
        None => p.is_empty(),
        Some(&"**") => (0..=p.len()).any(|i| parts_match(&g[1..], &p[i..])),
        Some(seg) => !p.is_empty() && segment_matches(seg.as_bytes(), p[0].as_bytes()) && parts_match(&g[1..], &p[1..]),
    }
}

fn segment_matches(g: &[u8], s: &[u8]) -> bool {
    match g.first() {
        None => s.is_empty(),
        Some(b'*') => (0..=s.len()).any(|i| segment_matches(&g[1..], &s[i..])),
        Some(b'?') => !s.is_empty() && segment_matches(&g[1..], &s[1..]),
        Some(c) => s.first() == Some(c) && segment_matches(&g[1..], &s[1..]),
    }
}

/// The files under `root`, sorted by relative path, without following symbolic links, filtered by `.caitlynignore`
/// and the globs.
pub async fn walk(root: &Path, include: &[String], exclude: &[String]) -> std::io::Result<Vec<LocalFile>> {
    let mut ignore: Vec<String> = exclude.to_vec();
    if let Ok(text) = tokio::fs::read_to_string(root.join(".caitlynignore")).await {
        ignore.extend(
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_owned),
        );
    }
    let mut out = Vec::new();
    let mut dirs = VecDeque::from([(root.to_path_buf(), String::new())]);
    while let Some((dir, rel)) = dirs.pop_front() {
        let mut rd = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let meta = tokio::fs::symlink_metadata(entry.path()).await?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                dirs.push_back((entry.path(), relative));
                continue;
            }
            if !meta.is_file() || (rel.is_empty() && name == ".caitlynignore") {
                continue;
            }
            if ignore.iter().any(|g| glob_matches(g, &relative)) {
                continue;
            }
            if !include.is_empty() && !include.iter().any(|g| glob_matches(g, &relative)) {
                continue;
            }
            out.push(LocalFile {
                path: entry.path(),
                relative_path: relative,
                size: meta.len(),
            });
        }
    }
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

// ------------------------------------------------------------------ the run

struct Ctx<It> {
    on_progress: ProgressFn<It>,
    _it: PhantomData<It>,
}

impl<It: Clone> Ctx<It> {
    fn progress(&self, phase: SyncPhase, done: u64, total: u64, item: Option<It>, path: Option<String>) {
        if let Some(f) = &self.on_progress {
            f(&IngestionProgress {
                phase,
                done,
                total,
                item,
                path,
            });
        }
    }
}

/// Runs `sync` (PROTOCOL.md 15). Errors are the client's own type `E`. `codes` maps each error code the model
/// lists to its status, for a batch that failed. Cancelling `opts` stops new uploads, aborts those in flight and fails
/// with the cancellation error; with `cancel_ingestion`, the batch is also cancelled with `stopRunning`. (Dropping the
/// future instead stops everything at once, with no request.)
pub async fn run<P, B, It, R, Est, E>(
    client: Client,
    knowledge_base_id: String,
    input: SyncInput<P, B, It, R, Est>,
    codes: &'static [(&'static str, u16)],
    opts: CallOptions,
) -> Result<SyncReport<B, It>, E>
where
    P: Serialize,
    B: DeserializeOwned + Send + Sync + 'static,
    It: DeserializeOwned + Clone + Send + Sync + 'static,
    R: std::fmt::Display,
    Est: DeserializeOwned,
    E: From<Error> + Send + 'static,
{
    let batch_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let cancel_ingestion = input.cancel_ingestion;
    let r = run_inner(&client, &knowledge_base_id, input, codes, &opts, batch_id.clone()).await;
    if r.is_err() && cancel_ingestion && opts.cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
        let id = batch_id.lock().expect("batch id lock").clone();
        if let Some(id) = id {
            let req = Request::new(batch_path(&knowledge_base_id, &id, "/cancel"));
            let _ = call_json(
                &client,
                &OP_CANCEL,
                req,
                Some(&json!({"stopRunning": true})),
                &CallOptions::default(),
            )
            .await;
        }
    }
    r.map_err(E::from)
}

/// Runs steps 1 to 3 of `sync` (PROTOCOL.md 15): hashes the files, creates the batch, waits until it is planned and
/// prices the items that need bytes. Nothing is uploaded; the batch is left planned.
pub async fn estimate<P, B, It, R, Est, E>(
    client: Client,
    knowledge_base_id: String,
    input: SyncInput<P, B, It, R, Est>,
    codes: &'static [(&'static str, u16)],
    opts: CallOptions,
) -> Result<SyncPlan<B, It, Est>, E>
where
    P: Serialize,
    B: DeserializeOwned + Send + Sync + 'static,
    It: DeserializeOwned + Clone + Send + Sync + 'static,
    Est: DeserializeOwned,
    E: From<Error> + Send + 'static,
{
    let ctx = Ctx::<It> {
        on_progress: input.on_progress.clone(),
        _it: PhantomData,
    };
    let prepared = prepare(
        &client,
        &knowledge_base_id,
        &input,
        codes,
        &opts,
        &ctx,
        Arc::new(Mutex::new(None)),
        true,
    )
    .await?;
    Ok(prepared.plan)
}

/// What steps 1 to 3 leave: the batch, its plan, its ETag and the hashed files by document path.
struct Prepared<B, It, Est> {
    id: String,
    plan: SyncPlan<B, It, Est>,
    raw_items: Vec<Value>,
    batch_json: Value,
    etag: String,
    item_count: u64,
    locals: HashMap<String, Arc<PreparedFile>>,
}

/// Opens the knowledge base's watch for one batch, as JSON events (PROTOCOL.md 16): reconnected with no cursor.
fn open_batch_watch(
    c: &Client,
    kb: &str,
    id: &str,
) -> impl FnOnce(CallOptions) -> BoxFuture<'static, Result<Stream<Value, (), Error>, Error>> {
    let c = c.clone();
    let path = format!("/v3/knowledge-bases/{}/events", path_label(kb));
    let get = batch_path(kb, id, "");
    let id = id.to_owned();
    move |opts: CallOptions| {
        Box::pin(async move {
            let request = move || {
                let mut req = Request::new(path.clone());
                req.query("batch", id.clone());
                req
            };
            let resp = c.send(&OP_WATCH, request(), &opts).await?;
            let rc = c.clone();
            let ropts = opts.cancellation_only();
            let resume: crate::stream::Resume = Box::new(move |_last_event_id: String| {
                let c = rc.clone();
                let opts = ropts.clone();
                let req = request();
                Box::pin(async move { c.send(&OP_WATCH, req, &opts).await })
            });
            let mut stream = Stream::open(
                resp,
                StreamSpec {
                    decode: crate::watch::decode_json,
                    final_of: None,
                    map_err: |e| e,
                    resume: Some(resume),
                    fresh: true,
                },
            );
            // The batch is read again once its deadline has passed (PROTOCOL.md 16), as a batch scope's watch reads it.
            let gopts = opts.cancellation_only();
            stream.reread_at_deadline(Reread::new(
                move |base: Option<Value>| {
                    let (c, get, opts) = (c.clone(), get.clone(), gopts.clone());
                    Box::pin(async move {
                        let (batch, _) = call_json(&c, &OP_GET, Request::new(get), None, &opts).await?;
                        let mut snapshot = match base {
                            Some(Value::Object(o)) => Value::Object(o),
                            _ => json!({ "type": "snapshot", "jobs": [], "progress": [] }),
                        };
                        snapshot["batch"] = batch;
                        Ok(snapshot)
                    })
                },
                json_deadline,
            ));
            Ok(stream)
        })
    }
}

/// The deadline a JSON watch event shows: its batch's, read as the model types it (`uploadsExpireAt`, a date-time).
fn json_deadline(ev: &Value) -> Option<Option<DateTime<Utc>>> {
    let batch = &ev["batch"];
    if ev["type"] != "snapshot" || !batch.is_object() {
        return None;
    }
    #[derive(Deserialize)]
    struct Deadline {
        #[serde(default)]
        status: String,
        #[serde(rename = "uploadsExpireAt", default)]
        uploads_expire_at: Option<DateTime<Utc>>,
    }
    let d: Deadline = serde_json::from_value(batch.clone()).ok()?;
    Some(batch_deadline(&d.status, d.uploads_expire_at))
}

/// Waits on the batch through the knowledge base's watch, then reads it (its ETag included).
async fn wait_batch<B: DeserializeOwned>(
    c: &Client,
    kb: &str,
    id: &str,
    until: Until,
    codes: &'static [(&'static str, u16)],
    observe: Option<crate::watch::Observer>,
    opts: &CallOptions,
) -> Result<(Value, B, String), Error> {
    let rules = Rules {
        thing: "batch",
        gone_when: None,
        job: None,
        until,
        codes,
        observe,
    };
    let mut wopts = crate::watch::WaitOptions::new();
    if let Some(t) = &opts.cancel {
        wopts = wopts.cancel_on(t.clone());
    }
    follow(open_batch_watch(c, kb, id), rules, wopts, |e: &Error| e.status() == Some(404)).await?;
    let (v, etag) = call_json(c, &OP_GET, Request::new(batch_path(kb, id, "")), None, opts).await?;
    let etag = etag.or_else(|| v["etag"].as_str().map(str::to_owned)).unwrap_or_default();
    let b: B = decode(&v)?;
    Ok((v, b, etag))
}

#[allow(clippy::too_many_arguments)] // the run's parts, each its own; plan_only is sync.estimate's
async fn prepare<P, B, It, R, Est>(
    c: &Client,
    kb: &str,
    input: &SyncInput<P, B, It, R, Est>,
    codes: &'static [(&'static str, u16)],
    opts: &CallOptions,
    ctx: &Ctx<It>,
    batch_id_out: Arc<Mutex<Option<String>>>,
    plan_only: bool,
) -> Result<Prepared<B, It, Est>, Error>
where
    P: Serialize,
    B: DeserializeOwned + Send + Sync + 'static,
    It: DeserializeOwned + Clone + Send + Sync + 'static,
    Est: DeserializeOwned,
{
    // 1. Hash.
    let mut items: Vec<Value> = Vec::new();
    let mut locals: HashMap<String, Arc<PreparedFile>> = HashMap::new();
    let mut to_hash: Vec<(String, UploadFile, Value)> = Vec::new();
    let scope = match &input.source {
        Source::Dir(dir) => {
            let files = walk(dir, &input.include, &input.exclude).await.map_err(|e| {
                Error::sdk(
                    "FILE_UNREADABLE",
                    &format!("{} could not be read", dir.display()),
                    Some(Box::new(e)),
                )
            })?;
            for f in files {
                let doc_path = format!("{}{}", input.folder, f.relative_path);
                // Keyed by the relative path unless the caller says otherwise (PROTOCOL.md 15).
                let mut item = json!({"action": "ingest", "path": doc_path, "externalId": f.relative_path});
                if let Some(x) = input.external_id.as_ref().and_then(|g| g(&f)) {
                    item["externalId"] = json!(x);
                }
                if let Some(x) = input.source_url.as_ref().and_then(|g| g(&f)) {
                    item["sourceUrl"] = json!(x);
                }
                if let Some(x) = input.metadata.as_ref().and_then(|g| g(&f)) {
                    item["metadata"] = Value::Object(x);
                }
                let file = UploadFile::from_path(&f.path).map_err(|e| {
                    Error::sdk(
                        "FILE_UNREADABLE",
                        &format!("{} could not be read", f.path.display()),
                        Some(Box::new(e)),
                    )
                })?;
                to_hash.push((doc_path, file, item));
            }
            Some(input.folder.clone())
        }
        Source::Items(list) => {
            for it in list {
                let mut item = json!({"path": it.path});
                if let Some(x) = &it.external_id {
                    item["externalId"] = json!(x);
                }
                if let Some(x) = &it.source_url {
                    item["sourceUrl"] = json!(x);
                }
                if let Some(x) = &it.metadata {
                    item["metadata"] = Value::Object(x.clone());
                }
                match &it.file {
                    Some(f) => {
                        item["action"] = json!("ingest");
                        to_hash.push((it.path.clone(), f.clone(), item));
                    }
                    None => {
                        item["action"] = json!("remove");
                        items.push(item);
                    }
                }
            }
            (input.folder != "/").then(|| input.folder.clone())
        }
    };
    let total_files = to_hash.len() as u64;
    ctx.progress(SyncPhase::Checksum, 0, total_files, None, None);
    // The caller's hints per path: sent to EstimateIngestion only, never with the batch's items.
    let mut hints: HashMap<String, Value> = HashMap::new();
    for (n, (path, file, mut item)) in to_hash.into_iter().enumerate() {
        if let Some(h) = file.hints_json() {
            hints.insert(path.clone(), h.clone());
        }
        let prepared = c.prepare_file(&file, opts).await?;
        item["sha256"] = json!(prepared.sha256());
        item["byteSize"] = json!(prepared.size());
        item["contentType"] = json!(prepared.content_type());
        items.push(item);
        ctx.progress(SyncPhase::Checksum, n as u64 + 1, total_files, None, Some(path.clone()));
        locals.insert(path, Arc::new(prepared));
    }
    if input.remove_missing {
        let mut cursor: Option<String> = None;
        loop {
            let mut req = Request::new(format!("/v3/knowledge-bases/{}/documents", path_label(kb)));
            req.query("filter[folder][eq]", input.folder.clone());
            req.query("deep", "true");
            if let Some(cur) = &cursor {
                req.query("cursor", cur.clone());
            }
            let (page, _) = call_json(c, &OP_LIST_DOCUMENTS, req, None, opts).await?;
            for d in page["items"].as_array().into_iter().flatten() {
                let folder = d["folder"].as_str().unwrap_or("/");
                let path = format!("{}{}", folder, d["name"].as_str().unwrap_or_default());
                let listed = items.iter().any(|i| i["path"].as_str() == Some(path.as_str()));
                if !listed {
                    items.push(json!({"action": "remove", "path": path}));
                }
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
    }

    // 2. Create: `start: manual`, the first 10,000 items, the rest through `addItems`, the last call with `last`.
    let mut chunks = items.chunks(ITEMS_PER_CALL).peekable();
    let first = chunks.next().map(<[Value]>::to_vec).unwrap_or_default();
    let more = chunks.peek().is_some();
    let mut body = json!({"start": "manual", "items": first});
    if more {
        body["awaitMoreItems"] = json!(true);
    }
    if let Some(p) = &input.policy {
        body["policy"] = serde_json::to_value(p)
            .map_err(|e| Error::sdk("SERIALIZATION_FAILED", "The policy could not be serialised", Some(Box::new(e))))?;
    }
    if let Some(folder) = &scope {
        body["scope"] = json!({"folderPath": folder});
    }
    if let Some(seconds) = input.upload_window_seconds {
        body["uploadWindowSeconds"] = json!(seconds);
    }
    let path = format!("/v3/knowledge-bases/{}/ingestion-batches", path_label(kb));
    let (created, _) = call_json(c, &OP_CREATE, Request::new(path), Some(&body), opts).await?;
    let id = created["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| sdk("DECODE_FAILED", "CreateIngestionBatch returned no id"))?;
    *batch_id_out.lock().expect("batch id lock") = Some(id.clone());
    while let Some(chunk) = chunks.next() {
        let mut body = json!({"items": chunk});
        if chunks.peek().is_none() {
            body["last"] = json!(true);
        }
        let (out, _) = call_json(
            c,
            &OP_ADD_ITEMS,
            Request::new(batch_path(kb, &id, "/items:batch-create")),
            Some(&body),
            opts,
        )
        .await?;
        if let Some(failed) = out["results"].as_array().into_iter().flatten().find(|r| r["status"] == "failed") {
            let why = failed["detail"].as_str().unwrap_or("no reason given");
            let title = match failed["code"].as_str() {
                Some(code) => format!("An item was refused ({code}): {why}"),
                None => format!("An item was refused: {why}"),
            };
            return Err(sdk("INGESTION_ITEM_REFUSED", &title));
        }
    }

    // 3. Plan, then price the items that need bytes.
    ctx.progress(SyncPhase::Planning, 0, items.len() as u64, None, None);
    let (planned_json, batch, etag) = wait_batch::<B>(c, kb, &id, Until::Planned, codes, None, opts).await?;
    let item_count = planned_json["itemCount"].as_u64().unwrap_or(items.len() as u64);
    ctx.progress(SyncPhase::Planned, item_count, item_count, None, None);
    let raw_items = list_items_json(c, kb, &id, None, opts).await?;
    // Priced by upload.estimate's own step, from the files this call read: name, content type, size and the caller's
    // hints; the hashes are the batch's, never the estimate's.
    let describe = |raw: &Value| {
        let (path, local) = raw["path"].as_str().and_then(|p| locals.get_key_value(p))?;
        let mut d = json!({"name": local.name(), "contentType": local.content_type(), "byteSize": local.size()});
        if let Some(h) = hints.get(path) {
            d["hints"] = h.clone();
        }
        Some(d)
    };
    // Priced only when someone will see it: sync.estimate, and sync with a confirm (PROTOCOL.md 15). For confirm, an
    // estimate that could not be made is the caller's to judge: the plan carries the error in its place. sync.estimate
    // has nothing else to give, and a cancellation is never caught.
    let (mut estimate, mut estimate_error) = (None, None);
    if plan_only || input.confirm.is_some() {
        match price(c, kb, &raw_items, &describe, input.estimate_per_call, opts).await {
            Ok(Some(v)) => estimate = Some(decode::<Est>(&v)?),
            Ok(None) => {}
            Err(e) if plan_only || matches!(e, Error::Cancelled) => return Err(e),
            Err(e) => estimate_error = Some(Arc::new(e)),
        }
    }
    let typed: Vec<It> = raw_items.iter().map(decode).collect::<Result<_, _>>()?;
    Ok(Prepared {
        id,
        plan: SyncPlan {
            batch,
            items: typed,
            estimate,
            estimate_error,
        },
        raw_items,
        batch_json: planned_json,
        etag,
        item_count,
        locals,
    })
}

async fn run_inner<P, B, It, R, Est>(
    c: &Client,
    kb: &str,
    input: SyncInput<P, B, It, R, Est>,
    codes: &'static [(&'static str, u16)],
    opts: &CallOptions,
    batch_id_out: Arc<Mutex<Option<String>>>,
) -> Result<SyncReport<B, It>, Error>
where
    P: Serialize,
    B: DeserializeOwned + Send + Sync + 'static,
    It: DeserializeOwned + Clone + Send + Sync + 'static,
    R: std::fmt::Display,
    Est: DeserializeOwned,
{
    let ctx = Ctx::<It> {
        on_progress: input.on_progress.clone(),
        _it: PhantomData,
    };
    let prepared = prepare(c, kb, &input, codes, opts, &ctx, batch_id_out, false).await?;
    let Prepared {
        id,
        plan,
        raw_items,
        batch_json: plan_batch_json,
        etag: mut start_etag,
        item_count: total_items,
        locals,
    } = prepared;

    // 4. Resolve.
    if let Some(confirm) = &input.confirm {
        if !confirm(&plan) {
            call_json(c, &OP_CANCEL, Request::new(batch_path(kb, &id, "/cancel")), Some(&json!({})), opts).await?;
            // Declined: the SDK's own CANCELLED (status 0), with the report as planned (PROTOCOL.md 15).
            let report = SyncReport::<B, It> {
                batch: decode(&plan_batch_json)?,
                items: raw_items.iter().map(decode).collect::<Result<_, _>>()?,
            };
            let declined = crate::error::ApiError {
                code: "CANCELLED".to_owned(),
                title: Some("confirm declined the plan; the batch was cancelled".to_owned()),
                ..Default::default()
            };
            return Err(Error::ApiWith(Box::new(declined), crate::error::Partial(Box::new(report))));
        }
    }
    let unresolved: Vec<&Value> = raw_items.iter().filter(|i| i["resolution"] == "unresolved").collect();
    if !unresolved.is_empty() {
        let Some(resolver) = &input.resolver else {
            return Err(sdk(
                "INGESTION_BATCH_UNRESOLVED",
                &format!(
                    "{} items are unresolved under the policy; resolve them, then start the batch {id}",
                    unresolved.len()
                ),
            ));
        };
        let mut left = 0;
        for raw in unresolved {
            let item: It = decode(raw)?;
            match resolver(&item) {
                Some(res) => {
                    let item_id = raw["id"].as_str().unwrap_or_default();
                    let tag = raw["etag"].as_str().unwrap_or_default().to_owned();
                    let mut o = opts.clone();
                    if !tag.is_empty() {
                        o = o.if_match(tag);
                    }
                    call_json(
                        c,
                        &OP_RESOLVE,
                        Request::new(batch_path(kb, &id, &format!("/items/{}", path_label(item_id)))),
                        Some(&json!({"resolution": res.to_string()})),
                        &o,
                    )
                    .await?;
                }
                None => left += 1,
            }
        }
        if left > 0 {
            return Err(sdk(
                "INGESTION_BATCH_UNRESOLVED",
                &format!("{left} items are still unresolved; resolve them, then start the batch {id}"),
            ));
        }
        let (v, e) = call_json(c, &OP_GET, Request::new(batch_path(kb, &id, "")), None, opts).await?;
        start_etag = e.or_else(|| v["etag"].as_str().map(str::to_owned)).unwrap_or(start_etag);
    }

    // 5. Start.
    let (started, holder): (Value, PolicyHolder) = call_with(
        c,
        &OP_START,
        Request::new(batch_path(kb, &id, "/start")),
        Some(&json!({})),
        &opts.clone().if_match(start_etag),
    )
    .await?;
    let policy = holder.upload_policy;
    // What the call knows of each item and of the batch: the report a cancellation carries (PROTOCOL.md 15).
    let mut latest: Vec<Value> = raw_items.clone();
    let batch_so_far = if started["batch"].is_object() {
        started["batch"].clone()
    } else {
        plan_batch_json.clone()
    };

    let result = async {
        // 6. Upload.
        let mut reported: HashSet<String> = HashSet::new();
        // Items whose upload failed after its retries, as reported (`failed`, `UPLOAD_FAILED`), by id.
        let mut upload_failed: HashMap<String, Value> = HashMap::new();
        let awaiting = list_items_json(c, kb, &id, Some(("filter[status][eq]", "awaiting_upload")), opts).await?;
        if policy.is_none() && !awaiting.is_empty() {
            return Err(sdk(
                "UPLOAD_POLICY_MISSING",
                "StartIngestionBatch returned no upload policy, but items are awaiting upload",
            ));
        }
        if let Some(policy) = policy {
            for item in &awaiting {
                note(&mut latest, item.clone());
            }
            let mut jobs: Vec<Job> = Vec::new();
            for item in awaiting {
                let path = item["path"].as_str().unwrap_or_default().to_owned();
                let Some(local) = locals.get(&path) else {
                    return Err(sdk(
                        "INGESTION_ITEM_HAS_NO_FILE",
                        &format!("The batch awaits bytes for {path}, which is not one of the files given"),
                    ));
                };
                let key = item["objectKey"].as_str().unwrap_or_default().to_owned();
                jobs.push(Job {
                    item,
                    file: local.clone(),
                    key,
                });
            }
            // upload's own step (PROTOCOL.md 15).
            let sending = Sending {
                c,
                kb,
                id: &id,
                policy,
                concurrency: input.concurrency,
                ctx: &ctx,
                on_item: input.on_item.clone(),
                own_items: false,
                opts,
            };
            let sent = send_files(sending, jobs, &mut latest).await?;
            for failed in sent.failed {
                let item_id = failed["id"].as_str().unwrap_or_default().to_owned();
                reported.insert(item_id.clone());
                upload_failed.insert(item_id, failed);
            }
        }
        ctx.progress(SyncPhase::Queued, 0, total_items, None, None);

        // 7. Wait: the batch's wait, through the knowledge base's watch.
        let progress = ctx.on_progress.clone();
        let observe: crate::watch::Observer = Box::new(move |ev: &Value| {
            let Some(f) = &progress else { return };
            let b = &ev["batch"];
            if b["status"].as_str() != Some("running") {
                return;
            }
            let by = &b["counts"]["byStatus"];
            let finished: u64 = FINISHED.iter().map(|k| by[*k].as_u64().unwrap_or(0)).sum();
            f(&IngestionProgress {
                phase: SyncPhase::Processing,
                done: finished,
                total: b["itemCount"].as_u64().unwrap_or(0),
                item: None,
                path: None,
            });
        });
        let failed_uploads = upload_failed.len() as u64;
        let until = if failed_uploads == 0 {
            Until::Ended
        } else {
            // Items whose upload failed stay `awaiting_upload` until the server's sweep, so the batch cannot end yet: wait
            // instead until every other item has finished.
            Until::Batch(Box::new(move |b: &Value| {
                let by = &b["counts"]["byStatus"];
                let finished: u64 = FINISHED.iter().map(|k| by[*k].as_u64().unwrap_or(0)).sum();
                b["status"] == "running" && finished + failed_uploads >= b["itemCount"].as_u64().unwrap_or(u64::MAX)
            }))
        };
        let (finished_json, finished, _) = wait_batch::<B>(c, kb, &id, until, codes, Some(observe), opts).await?;
        let mut raw_items = list_items_json(c, kb, &id, None, opts).await?;
        for raw in &mut raw_items {
            if let Some(failed) = upload_failed.get(raw["id"].as_str().unwrap_or_default()) {
                *raw = failed.clone();
            }
        }
        let items: Vec<It> = raw_items.iter().map(decode).collect::<Result<_, _>>()?;
        if let Some(f) = &input.on_item {
            for (raw, it) in raw_items.iter().zip(&items) {
                if !reported.contains(raw["id"].as_str().unwrap_or_default()) {
                    f(it);
                }
            }
        }
        let mut status = finished_json["status"].as_str().unwrap_or_default().to_owned();
        if status == "running" {
            status = "completed_with_failures".to_owned();
        }
        ctx.progress(SyncPhase::Final(status), total_items, total_items, None, None);
        Ok(SyncReport { batch: finished, items })
    }
    .await;
    match result {
        // A cancelled sync carries the report so far: every item with its last status, and the batch.
        Err(Error::Cancelled) => Err(Error::CancelledWith(crate::error::Partial(Box::new(SyncReport::<B, It> {
            batch: decode(&batch_so_far)?,
            items: latest.iter().map(decode).collect::<Result<_, _>>()?,
        })))),
        r => r,
    }
}

/// One file to send, for one item awaiting upload, under its object key.
struct Job {
    item: Value,
    file: Arc<PreparedFile>,
    key: String,
}

/// How [`send_files`] sends: the batch, its upload policy, how many at once and whom it tells.
struct Sending<'a, It> {
    c: &'a Client,
    kb: &'a str,
    id: &'a str,
    policy: Policy,
    concurrency: usize,
    ctx: &'a Ctx<It>,
    on_item: Ext<dyn Fn(&It) + Send + Sync>,
    /// `batch.upload`: an item Complete refuses for good (a second `CHECKSUM_MISMATCH`) fails here and reaches
    /// `on_item`, and the `queued` progress follows each Complete call. Sync leaves both to its wait.
    own_items: bool,
    opts: &'a CallOptions,
}

/// Each item's steps (PROTOCOL.md 13): a `caitlyn.batch.item` span per item, with an event for each step (opened,
/// checked, sending, sent, completed or failed). A span ends (is dropped) when its item is completed or fails, or when
/// the upload call returns.
struct ItemSpans<'a> {
    batch_id: &'a str,
    spans: HashMap<String, tracing::Span>,
}

impl ItemSpans<'_> {
    fn step(&mut self, item: &Value, name: &'static str, code: Option<&str>) {
        let item_id = item["id"].as_str().unwrap_or_default().to_owned();
        let batch_id = self.batch_id;
        let span = self.spans.entry(item_id.clone()).or_insert_with(|| {
            tracing::info_span!(
                "caitlyn.batch.item",
                otel.name = "caitlyn.batch.item",
                otel.kind = "internal",
                otel.status_code = tracing::field::Empty,
                caitlyn.ingestion_batch.id = batch_id,
                caitlyn.ingestion_batch.item.id = item_id.as_str(),
                caitlyn.ingestion_batch.item.path = item["path"].as_str().unwrap_or_default(),
            )
        });
        match code {
            Some(code) => tracing::info!(parent: &*span, caitlyn.error.code = code, "{name}"),
            None => tracing::info!(parent: &*span, "{name}"),
        }
        if name == "failed" {
            span.record("otel.status_code", "ERROR");
        }
        if name == "completed" || name == "failed" {
            self.spans.remove(&item_id);
        }
    }
}

/// What [`send_files`] did with each item, as JSON with its status.
struct Sent {
    /// Accepted by CompleteIngestionBatchUploads: `ingesting`.
    accepted: Vec<Value>,
    /// Failed here, never reported to Complete (`UPLOAD_FAILED`, `FILE_CHANGED`): `failed`, still `awaiting_upload` on
    /// the server until its sweep.
    failed: Vec<Value>,
    /// Refused by Complete after the one retry (`own_items` only): `failed`, as the server has it.
    refused: Vec<Value>,
}

fn failed_item<It: DeserializeOwned>(item: &Value, code: &str, detail: &str, on_item: &Ext<dyn Fn(&It) + Send + Sync>) -> Value {
    let mut failed = item.clone();
    failed["status"] = json!("failed");
    failed["failureCode"] = json!(code);
    failed["failureDetail"] = json!(detail);
    if let (Some(f), Ok(it)) = (on_item, decode::<It>(&failed)) {
        f(&it);
    }
    failed
}

/// Upload's step (PROTOCOL.md 15, sync's step 6): sends the files at most `concurrency` at once under the policy
/// (renewed when it runs low, and once after a 403 that says it expired), reports the accepted uploads to
/// CompleteIngestionBatchUploads 100 at a time, uploads an item once more after `CHECKSUM_MISMATCH`, and fails only its
/// own item when an upload fails. Cancelling stops new uploads and aborts those in flight.
async fn send_files<It: DeserializeOwned + Clone>(s: Sending<'_, It>, jobs: Vec<Job>, latest: &mut [Value]) -> Result<Sent, Error> {
    let Sending {
        c,
        kb,
        id,
        policy,
        concurrency,
        ctx,
        on_item,
        own_items,
        opts,
    } = s;
    let mut sent = Sent {
        accepted: Vec::new(),
        failed: Vec::new(),
        refused: Vec::new(),
    };
    let total_bytes: u64 = jobs.iter().map(|j| j.file.size()).sum();
    ctx.progress(SyncPhase::Upload, 0, total_bytes, None, None);
    let uploader = Uploader {
        c: c.clone(),
        kb: kb.to_owned(),
        id: id.to_owned(),
        policy: Arc::new(tokio::sync::Mutex::new(policy)),
        last_renewal: Arc::new(Mutex::new(None)),
        opts: opts.clone(),
    };
    let cancelled = || opts.cancel.as_ref().is_some_and(|t| t.is_cancelled());
    let mut retried: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<Job> = jobs.into();
    let mut pending: Vec<Job> = Vec::new();
    let (mut done_bytes, mut uploaded) = (0u64, 0u64);
    let mut running = FuturesUnordered::new();
    // The keep-alive (PROTOCOL.md 15), polled beside the uploads while any is in flight and dropped when none is, or
    // when this call returns: no renewal starts after that.
    let mut keep_alive: Option<Pin<Box<dyn Future<Output = ()> + Send>>> = None;
    let mut steps = ItemSpans {
        batch_id: id,
        spans: HashMap::new(),
    };
    loop {
        while running.len() < concurrency && !cancelled() {
            let Some(job) = queue.pop_front() else { break };
            steps.step(&job.item, "opened", None);
            steps.step(&job.item, "checked", None);
            steps.step(&job.item, "sending", None);
            let u = uploader.clone();
            running.push(async move {
                let r = u.upload(&job.file, &job.key).await;
                (job, r)
            });
        }
        if running.is_empty() {
            keep_alive = None;
        } else if keep_alive.is_none() {
            keep_alive = Some(Box::pin(uploader.clone().keep_alive()));
        }
        let renewing = async {
            match keep_alive.as_mut() {
                Some(k) => k.await,
                None => std::future::pending().await,
            }
        };
        // Cancelling aborts the uploads in flight: they are dropped here.
        let next = tokio::select! {
            biased;
            _ = opts.cancelled() => return Err(Error::Cancelled),
            n = running.next() => n,
            _ = renewing => continue, // never ends: it runs until it is dropped
        };
        let Some((job, r)) = next else {
            if cancelled() {
                return Err(Error::Cancelled);
            }
            break;
        };
        match r {
            Ok(()) => steps.step(&job.item, "sent", None),
            Err(UploadError::Stop(e)) => return Err(e),
            Err(UploadError::Item(e)) => {
                // This item fails; the others carry on. It is not reported to Complete.
                let code = match e.code() {
                    Some("FILE_CHANGED") => "FILE_CHANGED",
                    _ => "UPLOAD_FAILED",
                };
                steps.step(&job.item, "failed", Some(code));
                let failed = failed_item(&job.item, code, &e.to_string(), &on_item);
                note(latest, failed.clone());
                sent.failed.push(failed);
                continue;
            }
        }
        done_bytes += job.file.size();
        uploaded += 1;
        ctx.progress(
            SyncPhase::Upload,
            done_bytes,
            total_bytes,
            decode::<It>(&job.item).ok(),
            job.item["path"].as_str().map(str::to_owned),
        );
        // Reported as they finish: everything finished so far, 100 at a time.
        pending.push(job);
        if cancelled() {
            return Err(Error::Cancelled);
        }
        while !pending.is_empty() {
            let group: Vec<Job> = pending.drain(..pending.len().min(COMPLETE_PER_CALL)).collect();
            let ids: Vec<&str> = group.iter().map(|g| g.item["id"].as_str().unwrap_or_default()).collect();
            let (out, _) = call_json(
                c,
                &OP_COMPLETE,
                Request::new(batch_path(kb, id, "/complete-uploads")),
                Some(&json!({"itemIds": ids})),
                opts,
            )
            .await?;
            let mut group: Vec<Option<Job>> = group.into_iter().map(Some).collect();
            for (n, res) in out["results"].as_array().into_iter().flatten().enumerate() {
                let item_id = res["itemId"].as_str().unwrap_or_default().to_owned();
                let at = group
                    .iter()
                    .position(|g| g.as_ref().is_some_and(|g| g.item["id"].as_str() == Some(item_id.as_str())))
                    .unwrap_or(n);
                let Some(g) = group.get_mut(at).and_then(Option::take) else {
                    continue;
                };
                if res["status"] == "failed" {
                    if res["code"] == "CHECKSUM_MISMATCH" && !retried.contains(&item_id) {
                        steps.step(&g.item, "retrying", Some("CHECKSUM_MISMATCH"));
                    } else {
                        steps.step(&g.item, "failed", res["code"].as_str().or(Some("UPLOAD_FAILED")));
                    }
                    if res["code"] == "CHECKSUM_MISMATCH" && retried.insert(item_id.clone()) {
                        done_bytes = done_bytes.saturating_sub(g.file.size());
                        uploaded = uploaded.saturating_sub(1);
                        queue.push_back(g);
                    } else if own_items {
                        let code = res["code"].as_str().unwrap_or("UPLOAD_FAILED");
                        let detail = res["detail"].as_str().unwrap_or("CompleteIngestionBatchUploads refused the upload");
                        let refused = failed_item(&g.item, code, detail, &on_item);
                        note(latest, refused.clone());
                        sent.refused.push(refused);
                    }
                    continue;
                }
                // An accepted upload is not final: the item ends later, during ingestion.
                steps.step(&g.item, "completed", None);
                let mut accepted = g.item.clone();
                accepted["status"] = json!("ingesting");
                note(latest, accepted.clone());
                sent.accepted.push(accepted);
            }
            if own_items {
                ctx.progress(SyncPhase::Queued, sent.accepted.len() as u64, uploaded, None, None);
            }
        }
        if cancelled() {
            return Err(Error::Cancelled);
        }
    }
    if !queue.is_empty() || cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(sent)
}

// ------------------------------------------------------------------ a hand-built batch: upload and its estimate

/// A function from a batch item to its file.
pub type FileFor<It> = Arc<dyn Fn(&It) -> Option<UploadFile> + Send + Sync>;

/// The files for a hand-built batch's items (PROTOCOL.md 15): keyed by the item's path as the batch stores it
/// (`/hr/leave.pdf`; a key without the leading `/` is read as if it had one), or a function from an item to its file,
/// for files made or fetched only when needed. One value serves `estimate_upload` and `upload`: the hints a file
/// carries ([`UploadFile::hints`]) go to the estimate, and only its bytes are sent.
pub enum BatchFiles<It> {
    ByPath(HashMap<String, UploadFile>),
    With(FileFor<It>),
}

impl<It> Clone for BatchFiles<It> {
    fn clone(&self) -> Self {
        match self {
            BatchFiles::ByPath(m) => BatchFiles::ByPath(m.clone()),
            BatchFiles::With(f) => BatchFiles::With(f.clone()),
        }
    }
}

impl<It> std::fmt::Debug for BatchFiles<It> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BatchFiles::ByPath(m) => f.debug_tuple("ByPath").field(m).finish(),
            BatchFiles::With(_) => f.write_str("With(…)"),
        }
    }
}

fn with_slash(path: &str) -> String {
    if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    }
}

impl<It> BatchFiles<It> {
    /// The files by item path.
    pub fn by_path<K: Into<String>, F: Into<UploadFile>>(files: impl IntoIterator<Item = (K, F)>) -> Self {
        BatchFiles::ByPath(files.into_iter().map(|(k, f)| (with_slash(&k.into()), f.into())).collect())
    }

    /// A function from an item to its file, or `None` for an item this call has no file for.
    pub fn with(f: impl Fn(&It) -> Option<UploadFile> + Send + Sync + 'static) -> Self {
        BatchFiles::With(Arc::new(f))
    }

    fn file_for(&self, raw: &Value) -> Option<UploadFile>
    where
        It: DeserializeOwned,
    {
        match self {
            BatchFiles::ByPath(m) => raw["path"].as_str().and_then(|p| m.get(&with_slash(p))).cloned(),
            BatchFiles::With(f) => decode::<It>(raw).ok().and_then(|it| f(&it)),
        }
    }

    /// The paths given (a map's keys), with their leading `/`.
    fn given(&self) -> Vec<String> {
        match self {
            BatchFiles::ByPath(m) => {
                let mut keys: Vec<String> = m.keys().map(|k| with_slash(k)).collect();
                keys.sort();
                keys
            }
            BatchFiles::With(_) => Vec::new(),
        }
    }
}

impl<It> From<HashMap<String, UploadFile>> for BatchFiles<It> {
    fn from(m: HashMap<String, UploadFile>) -> Self {
        BatchFiles::by_path(m)
    }
}

impl<It> From<std::collections::BTreeMap<String, UploadFile>> for BatchFiles<It> {
    fn from(m: std::collections::BTreeMap<String, UploadFile>) -> Self {
        BatchFiles::by_path(m)
    }
}

impl<It, K: Into<String>, F: Into<UploadFile>> From<Vec<(K, F)>> for BatchFiles<It> {
    fn from(v: Vec<(K, F)>) -> Self {
        BatchFiles::by_path(v)
    }
}

impl<It, K: Into<String>, F: Into<UploadFile>, const N: usize> From<[(K, F); N]> for BatchFiles<It> {
    fn from(v: [(K, F); N]) -> Self {
        BatchFiles::by_path(v)
    }
}

/// What `batch.upload(files)` gives once its uploads are done (PROTOCOL.md 15): the batch as it stood when the call
/// ended, one item for each item this call dealt with (`ingesting` when Complete accepted it, `failed` with its
/// `failure_code` when it failed here), the paths of awaiting items it had no file for (`not_given`: left
/// `awaiting_upload`), and the given paths that matched no awaiting item (`unmatched`: nothing sent for them).
#[derive(Debug, Clone, PartialEq)]
pub struct BatchUpload<B, It> {
    pub batch: B,
    pub items: Vec<It>,
    pub not_given: Vec<String>,
    pub unmatched: Vec<String>,
}

/// `batch.upload`'s options: how many at once, and its callbacks, which mean what they mean in sync.
pub struct UploadOptions<It> {
    pub concurrency: usize,
    pub on_progress: ProgressFn<It>,
    pub on_item: Ext<dyn Fn(&It) + Send + Sync>,
}

impl<It> Default for UploadOptions<It> {
    fn default() -> Self {
        UploadOptions {
            concurrency: DEFAULT_CONCURRENCY,
            on_progress: None,
            on_item: None,
        }
    }
}

impl<It> Clone for UploadOptions<It> {
    fn clone(&self) -> Self {
        UploadOptions {
            concurrency: self.concurrency,
            on_progress: self.on_progress.clone(),
            on_item: self.on_item.clone(),
        }
    }
}

const FINAL_BATCH: [&str; 4] = ["succeeded", "completed_with_failures", "failed", "cancelled"];

/// `batch.upload.estimate(files?)` (PROTOCOL.md 15): reads the batch (a draft fails with the SDK's
/// `INGESTION_BATCH_NOT_PLANNED`, status 0, with nothing more sent; a planning batch is waited on until planned), then
/// prices the items that need bytes, each described from its matched file (name, content type, size and the caller's
/// hints; nothing is hashed or read beyond the size) or, with no file, from the item itself. With nothing to price,
/// the estimate is empty and no call is sent.
pub async fn estimate_upload<It, Est>(
    c: &Client,
    kb: &str,
    id: &str,
    files: Option<&BatchFiles<It>>,
    per_call: usize,
    codes: &'static [(&'static str, u16)],
    opts: &CallOptions,
) -> Result<Est, Error>
where
    It: DeserializeOwned,
    Est: DeserializeOwned,
{
    let (mut batch, _) = call_json(c, &OP_GET, Request::new(batch_path(kb, id, "")), None, opts).await?;
    match batch["status"].as_str().unwrap_or_default() {
        "draft" => {
            return Err(sdk(
                "INGESTION_BATCH_NOT_PLANNED",
                &format!("The batch {id} is a draft: add its last items (last: true) so it is planned, then estimate its upload"),
            ))
        }
        "planning" => batch = wait_batch::<Value>(c, kb, id, Until::Planned, codes, None, opts).await?.0,
        _ => {}
    }
    let empty = || decode::<Est>(&json!({"documents": 0, "durationSeconds": {"low": 0, "high": 0}}));
    if FINAL_BATCH.contains(&batch["status"].as_str().unwrap_or_default()) {
        return empty();
    }
    let items = list_items_json(c, kb, id, None, opts).await?;
    // Each file's description, by item id: read before pricing, so the pricing step itself stays synchronous.
    let mut described: HashMap<String, Value> = HashMap::new();
    if let Some(files) = files {
        for raw in items.iter().filter(|i| needs_bytes(i)) {
            if let Some(file) = files.file_for(raw) {
                let d = c.describe_file(&file, opts).await?;
                let mut doc = json!({"name": d.name, "contentType": d.content_type, "byteSize": d.size});
                if let Some(h) = d.hints {
                    doc["hints"] = h;
                }
                described.insert(raw["id"].as_str().unwrap_or_default().to_owned(), doc);
            }
        }
    }
    let describe = |raw: &Value| {
        if let Some(d) = described.get(raw["id"].as_str().unwrap_or_default()) {
            return Some(d.clone());
        }
        let path = raw["path"].as_str().unwrap_or_default();
        Some(json!({
            "name": path.rsplit('/').next().unwrap_or(path),
            "contentType": raw["contentType"].as_str().unwrap_or("application/octet-stream"),
            "byteSize": raw["byteSize"].as_u64().unwrap_or(0),
        }))
    };
    match price(c, kb, &items, &describe, per_call, opts).await? {
        Some(v) => decode(&v),
        None => empty(),
    }
}

/// `batch.upload(files)` (PROTOCOL.md 15): reads the batch (a running one is uploaded; a `when_planned` one still
/// planning is followed until it runs; a draft, a planned one with a manual start, or a `when_planned` one that stopped
/// at planned fails with the SDK's `INGESTION_BATCH_NOT_STARTED`, status 0, with nothing more sent; a final one has
/// nothing awaiting), takes an upload policy, then sends the file for each item awaiting upload with sync's own step:
/// not hashed (the form carries the item's checksum), a file whose size is not the item's failing it with
/// `FILE_CHANGED` before anything is sent. An awaiting item with no file is left awaiting (`not_given`); a given path no
/// awaiting item has is `unmatched`. Cancelling aborts the uploads and leaves the batch as it is.
pub async fn upload_batch<B, It>(
    c: &Client,
    kb: &str,
    id: &str,
    files: &BatchFiles<It>,
    options: UploadOptions<It>,
    codes: &'static [(&'static str, u16)],
    opts: &CallOptions,
) -> Result<BatchUpload<B, It>, Error>
where
    B: DeserializeOwned,
    It: DeserializeOwned + Clone,
{
    let (mut batch, _) = call_json(c, &OP_GET, Request::new(batch_path(kb, id, "")), None, opts).await?;
    let not_started = |why: &str| {
        sdk(
            "INGESTION_BATCH_NOT_STARTED",
            &format!("The batch {id} {why}: start it with batch.start() (resolving any unresolved items first), then upload"),
        )
    };
    let status = batch["status"].as_str().unwrap_or_default().to_owned();
    match status.as_str() {
        "running" => {}
        "planning" if batch["start"] == "when_planned" => {
            let until = Until::Batch(Box::new(|b: &Value| b["status"] != "planning"));
            batch = wait_batch::<Value>(c, kb, id, until, codes, None, opts).await?.0;
            match batch["status"].as_str().unwrap_or_default() {
                "running" => {}
                s if FINAL_BATCH.contains(&s) => {}
                _ => return Err(not_started("stopped at planned, with items left unresolved")),
            }
        }
        "draft" | "planning" => return Err(not_started(&format!("is {status}"))),
        "planned" => return Err(not_started("is planned and waits for its start")),
        _ => {}
    }
    if FINAL_BATCH.contains(&batch["status"].as_str().unwrap_or_default()) {
        return Ok(BatchUpload {
            batch: decode(&batch)?,
            items: Vec::new(),
            not_given: Vec::new(),
            unmatched: files.given(),
        });
    }
    let awaiting = list_items_json(c, kb, id, Some(("filter[status][eq]", "awaiting_upload")), opts).await?;
    let ctx = Ctx::<It> {
        on_progress: options.on_progress.clone(),
        _it: PhantomData,
    };
    let mut not_given = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut jobs: Vec<Job> = Vec::new();
    let awaiting_paths: HashSet<String> = awaiting.iter().filter_map(|i| i["path"].as_str()).map(with_slash).collect();
    for item in &awaiting {
        let path = item["path"].as_str().unwrap_or_default().to_owned();
        let Some(file) = files.file_for(item) else {
            not_given.push(path);
            continue;
        };
        let sha = item["sha256"].as_str().unwrap_or_default().to_owned();
        let prepared = c.prepare_unhashed(&file, sha, opts).await?;
        let want = item["byteSize"].as_u64();
        if want.is_some_and(|w| w != prepared.size()) {
            let detail = format!(
                "{} is {} bytes; the batch item expects {} bytes",
                prepared.name(),
                prepared.size(),
                want.unwrap_or_default()
            );
            failed.push(failed_item(item, "FILE_CHANGED", &detail, &options.on_item));
            continue;
        }
        jobs.push(Job {
            item: item.clone(),
            file: Arc::new(prepared),
            key: item["objectKey"].as_str().unwrap_or_default().to_owned(),
        });
    }
    let unmatched: Vec<String> = files.given().into_iter().filter(|p| !awaiting_paths.contains(p)).collect();
    let mut items: Vec<Value> = failed;
    if !jobs.is_empty() {
        let (_, holder): (Value, PolicyHolder) = call_with(
            c,
            &OP_RENEW,
            Request::new(batch_path(kb, id, "/upload-policies")),
            Some(&json!({})),
            &opts.cancellation_only(),
        )
        .await?;
        let policy = holder.upload_policy.ok_or_else(|| {
            sdk(
                "UPLOAD_POLICY_MISSING",
                "CreateIngestionBatchUploadPolicy returned no upload policy",
            )
        })?;
        let sending = Sending {
            c,
            kb,
            id,
            policy,
            concurrency: options.concurrency.max(1),
            ctx: &ctx,
            on_item: options.on_item.clone(),
            own_items: true,
            opts,
        };
        let mut latest: Vec<Value> = Vec::new();
        let sent = send_files(sending, jobs, &mut latest).await?;
        items.extend(sent.accepted);
        items.extend(sent.failed);
        items.extend(sent.refused);
    }
    let (now, _) = call_json(c, &OP_GET, Request::new(batch_path(kb, id, "")), None, opts).await?;
    Ok(BatchUpload {
        batch: decode(&now)?,
        items: items.iter().map(decode).collect::<Result<_, _>>()?,
        not_given,
        unmatched,
    })
}

/// Whether an item could need its bytes, and so is priced (PROTOCOL.md 15): resolved `add`, `new_version` or
/// `overwrite`, or still `unresolved` with an outcome that could take bytes (`new`, `changed`, `conflict`), as the most
/// the batch could cost; and neither final nor already uploaded. `skip`, `remove`, `move` and `update_metadata` are not.
fn needs_bytes(item: &Value) -> bool {
    let could = match item["resolution"].as_str() {
        Some("add" | "new_version" | "overwrite") => true,
        Some("unresolved") => matches!(item["outcome"].as_str(), Some("new" | "changed" | "conflict")),
        _ => false,
    };
    could && matches!(item["status"].as_str(), None | Some("draft" | "awaiting_upload"))
}

/// Prices the items that need bytes (PROTOCOL.md 15, `upload.estimate`): each described by `describe` (name, content
/// type, size, and hints only as the caller gave them), at most `per_call` documents an EstimateIngestion call, in
/// order, the parts added together. `None` when nothing needs pricing: no call is sent.
async fn price(
    c: &Client,
    kb: &str,
    items: &[Value],
    describe: &(dyn Fn(&Value) -> Option<Value> + Sync),
    per_call: usize,
    opts: &CallOptions,
) -> Result<Option<Value>, Error> {
    let documents: Vec<Value> = items.iter().filter(|i| needs_bytes(i)).filter_map(describe).collect();
    if documents.is_empty() {
        return Ok(None);
    }
    let mut parts = Vec::new();
    for chunk in documents.chunks(per_call.max(1)) {
        let req = Request::new(format!("/v3/knowledge-bases/{}/ingestions:estimate", path_label(kb)));
        let (est, _) = call_json(c, &OP_ESTIMATE, req, Some(&json!({"documents": chunk})), opts).await?;
        parts.push(est);
    }
    Ok(Some(add_estimates(parts)))
}

/// Adds EstimateIngestion results together: documents, pages, mediaSeconds and documentsOfUnknownLength summed (a count
/// no part has stays absent), durationSeconds' and cost's low and high ends summed, cost present only when every part
/// has one, and details left out. One part is returned as it is.
fn add_estimates(mut parts: Vec<Value>) -> Value {
    if parts.len() == 1 {
        return parts.pop().unwrap_or_default();
    }
    let mut total = json!({});
    for key in ["documents", "pages", "mediaSeconds", "documentsOfUnknownLength"] {
        let have: Vec<&Value> = parts.iter().filter_map(|p| p.get(key)).filter(|v| !v.is_null()).collect();
        if key == "documents" || !have.is_empty() {
            total[key] = json!(have.iter().filter_map(|v| v.as_i64()).sum::<i64>());
        }
    }
    let range = |of: &dyn Fn(&Value) -> &Value| -> Value {
        // Rounded to 1e-9, so adding decimal amounts leaves no binary noise (0.1 + 0.2 is 0.3).
        let sum = |end: &str| (parts.iter().map(|p| of(p)[end].as_f64().unwrap_or(0.0)).sum::<f64>() * 1e9).round() / 1e9;
        json!({"low": sum("low"), "high": sum("high")})
    };
    total["durationSeconds"] = range(&|p| &p["durationSeconds"]);
    if parts.iter().all(|p| p["cost"].is_object()) {
        let mut cost = range(&|p| &p["cost"]);
        cost["unit"] = parts[0]["cost"]["unit"].clone();
        total["cost"] = cost;
    }
    total
}

/// Replaces an item the call knows by its id with what it now knows of it.
fn note(latest: &mut [Value], item: Value) {
    if let Some(slot) = latest.iter_mut().find(|i| i["id"] == item["id"]) {
        *slot = item;
    }
}

/// Item statuses that are final.
const FINISHED: [&str; 7] = ["indexed", "skipped", "moved", "updated", "removed", "failed", "cancelled"];

async fn list_items_json(c: &Client, kb: &str, id: &str, filter: Option<(&str, &str)>, opts: &CallOptions) -> Result<Vec<Value>, Error> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut req = Request::new(batch_path(kb, id, "/items"));
        req.query("limit", "1000");
        if let Some((k, v)) = filter {
            req.query(k, v);
        }
        if let Some(cur) = &cursor {
            req.query("cursor", cur.clone());
        }
        let (page, _) = call_json(c, &OP_LIST_ITEMS, req, None, opts).await?;
        out.extend(page["items"].as_array().cloned().unwrap_or_default());
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            return Ok(out);
        }
    }
}

#[derive(Clone)]
struct Uploader {
    c: Client,
    kb: String,
    id: String,
    policy: Arc<tokio::sync::Mutex<Policy>>,
    /// When the last renewal ended, whoever asked for it: the keep-alive's floor counts from it.
    last_renewal: Arc<Mutex<Option<tokio::time::Instant>>>,
    opts: CallOptions,
}

impl Uploader {
    /// Renews the policy on a timer (PROTOCOL.md 15): once it has less than its renewal margin left, at most once a second.
    /// The server judges each file by when its bytes arrive against the batch's uploadsExpireAt, which a renewal moves
    /// on. A renewal that fails leaves the uploads in flight on the policy they have, and is tried again at the next
    /// tick. It never ends: the caller polls it while uploads are in flight, and drops it.
    async fn keep_alive(self) {
        loop {
            let (expires_at, margin) = {
                let p = self.policy.lock().await;
                (p.expires_at, p.margin())
            };
            let Some(expires_at) = expires_at else {
                // No time to keep it alive by: each upload renews it before it starts instead. Look again later, in
                // case a renewal brings a policy with an expiresAt; nothing is sent meanwhile.
                tokio::time::sleep(KEEP_ALIVE_FLOOR).await;
                continue;
            };
            let left = expires_at - chrono::Utc::now();
            let due = (left - margin).to_std().unwrap_or_default();
            tokio::time::sleep(due.max(self.floor_left())).await;
            // The lock waits out a renewal in flight; one that ended less than a second ago, whoever asked for it, is
            // this tick's, and the loop waits again from the policy as it then stands.
            drop(self.policy.lock().await);
            if !self.floor_left().is_zero() {
                continue;
            }
            // Renews only when less than the renewal margin is left; an error leaves the policy in hand.
            let _ = self.policy(None).await;
        }
    }

    /// How long until the keep-alive may renew again: a second after the last renewal ended.
    fn floor_left(&self) -> Duration {
        self.last_renewal
            .lock()
            .ok()
            .and_then(|l| *l)
            .map(|l| (l + KEEP_ALIVE_FLOOR).saturating_duration_since(tokio::time::Instant::now()))
            .unwrap_or_default()
    }

    /// The current policy, renewed first when it has less than its renewal margin left.
    async fn policy(&self, force_after: Option<chrono::DateTime<chrono::Utc>>) -> Result<Policy, Error> {
        let mut p = self.policy.lock().await;
        // A policy with no expiresAt counts as due now: renewed before each upload (PROTOCOL.md 15).
        let left = p.expires_at.map_or(chrono::Duration::MIN, |t| t - chrono::Utc::now());
        let stale = force_after.is_some_and(|t| p.expires_at.is_none_or(|e| e <= t));
        if stale || left < p.margin() {
            let renewed = call_with(
                &self.c,
                &OP_RENEW,
                Request::new(batch_path(&self.kb, &self.id, "/upload-policies")),
                Some(&json!({})),
                &self.opts.cancellation_only(),
            )
            .await;
            if let Ok(mut last) = self.last_renewal.lock() {
                *last = Some(tokio::time::Instant::now());
            }
            let (_, holder): (Value, PolicyHolder) = renewed?;
            *p = holder.upload_policy.ok_or_else(|| {
                sdk(
                    "UPLOAD_POLICY_MISSING",
                    "CreateIngestionBatchUploadPolicy returned no upload policy",
                )
            })?;
        }
        Ok(p.clone())
    }

    /// Sends one file. A policy that cannot be renewed stops the batch; a file that cannot be sent fails its item.
    async fn upload(&self, file: &PreparedFile, key: &str) -> Result<(), UploadError> {
        let mut policy = self.policy(None).await.map_err(UploadError::Stop)?;
        let mut renewed = false;
        loop {
            if let Some(max) = policy.max_byte_size {
                if file.size() > max {
                    return Err(UploadError::Item(sdk(
                        "FILE_TOO_LARGE",
                        &format!("{} is larger than the upload policy allows ({max} bytes)", file.name()),
                    )));
                }
            }
            match self.post(&policy, file, key).await {
                Ok(()) => return Ok(()),
                Err(PostFailure::Expired) if !renewed => {
                    renewed = true;
                    policy = self
                        .policy(Some(policy.expires_at.unwrap_or(chrono::DateTime::<chrono::Utc>::MAX_UTC)))
                        .await
                        .map_err(UploadError::Stop)?;
                }
                Err(PostFailure::Expired) => {
                    return Err(UploadError::Item(sdk(
                        "UPLOAD_FAILED",
                        "The upload policy was refused as expired after it was renewed",
                    )))
                }
                Err(PostFailure::Error(Error::Cancelled)) => return Err(UploadError::Stop(Error::Cancelled)),
                Err(PostFailure::Error(e)) => return Err(UploadError::Item(e)),
            }
        }
    }

    async fn post(&self, policy: &Policy, file: &PreparedFile, key: &str) -> Result<(), PostFailure> {
        let boundary = format!("caitlyn-{}", uuid::Uuid::new_v4().simple());
        let mut head = String::new();
        let mut field = |name: &str, value: &str| {
            head.push_str(&format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{value}\r\n",
                escape(name)
            ));
        };
        // The policy's fields, less any sent below: storage refuses a form that repeats a field (PROTOCOL.md 15).
        for (k, v) in policy.form_fields.0.iter().filter(|(k, _)| !is_own_form_field(k)) {
            field(k, v);
        }
        field("key", key);
        field("Content-Type", file.content_type());
        field("x-amz-checksum-algorithm", "SHA256");
        field("x-amz-checksum-sha256", file.sha256());
        head.push_str(&format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            escape(file.name()),
            file.content_type()
        ));
        let tail = format!("\r\n--{boundary}--\r\n");
        let head = Bytes::from(head);
        let tail = Bytes::from(tail);
        let length = head.len() as u64 + file.size() + tail.len() as u64;
        let content_type = format!("multipart/form-data; boundary={boundary}");
        let build = |touch: crate::upload::Touch| {
            let (head, tail, content_type) = (head.clone(), tail.clone(), content_type.clone());
            async move {
                let stream = file.stream().await?;
                let body = futures_util::stream::once(std::future::ready(Ok(head)))
                    .chain(stream)
                    .chain(futures_util::stream::once(std::future::ready(Ok(tail))));
                Ok(self
                    .c
                    .http()
                    .post(&policy.upload_url)
                    .header(http::header::CONTENT_TYPE, content_type)
                    .header(http::header::CONTENT_LENGTH, length)
                    .body(touch.counted(body)))
            }
        };
        match self.c.send_to_storage(build, &self.opts).await {
            Ok(_) => Ok(()),
            Err(ExternalFailure::Status(resp)) => {
                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                if status == 403 && text.to_ascii_lowercase().contains("expired") {
                    return Err(PostFailure::Expired);
                }
                let said: String = text.chars().take(300).collect();
                // The form carries the item's checksum: bytes that do not match it are a file that changed, and sending
                // them again cannot succeed.
                if status == 400 && text.contains("BadDigest") {
                    return Err(PostFailure::Error(Error::sdk(
                        "FILE_CHANGED",
                        &format!(
                            "Storage refused {}: its bytes do not match the batch item's checksum ({said})",
                            file.name()
                        ),
                        None,
                    )));
                }
                Err(PostFailure::Error(Error::sdk(
                    "UPLOAD_FAILED",
                    &format!("The upload policy's URL refused {} (HTTP {status}): {said}", file.name()),
                    None,
                )))
            }
            Err(ExternalFailure::NoResponse(e)) => Err(PostFailure::Error(Error::sdk(
                "UPLOAD_FAILED",
                "The file could not be sent",
                Some(Box::new(e)),
            ))),
            Err(ExternalFailure::Stalled(after)) => Err(PostFailure::Error(Error::sdk(
                "UPLOAD_FAILED",
                &format!(
                    "The file could not be sent: storage sent nothing for {}",
                    crate::upload::format_timeout(after)
                ),
                None,
            ))),
            Err(ExternalFailure::Other(e)) => Err(PostFailure::Error(e)),
        }
    }
}

enum UploadError {
    /// Stops the whole batch (the policy could not be renewed, or the call was cancelled).
    Stop(Error),
    /// Fails this item only (`UPLOAD_FAILED`).
    Item(Error),
}

enum PostFailure {
    Expired,
    Error(Error),
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    #[test]
    fn estimates_add_up() {
        use super::add_estimates;
        use serde_json::json;
        let a = json!({"documents": 10000, "pages": 40, "durationSeconds": {"low": 1.5, "high": 3}, "cost": {"low": 0.1, "high": 0.2, "unit": "usd"}, "details": {"x": 1}});
        let b = json!({"documents": 2, "mediaSeconds": 60, "documentsOfUnknownLength": 1, "durationSeconds": {"low": 2, "high": 4}, "cost": {"low": 0.2, "high": 0.4, "unit": "usd"}});
        assert_eq!(
            add_estimates(vec![a.clone(), b.clone()]),
            json!({"documents": 10002, "pages": 40, "mediaSeconds": 60, "documentsOfUnknownLength": 1,
                "durationSeconds": {"low": 3.5, "high": 7.0}, "cost": {"low": 0.3, "high": 0.6, "unit": "usd"}})
        );
        // cost only when every part has one
        let mut no_cost = b.clone();
        no_cost.as_object_mut().unwrap().remove("cost");
        assert!(add_estimates(vec![a.clone(), no_cost]).get("cost").is_none());
        // one part is returned as it is
        assert_eq!(add_estimates(vec![a.clone()]), a);
    }

    use super::*;

    #[test]
    fn globs() {
        assert!(glob_matches("*.pdf", "hr/leave.pdf"));
        assert!(!glob_matches("*.pdf", "hr/leave.docx"));
        assert!(glob_matches("hr/**", "hr/a/b.md"));
        assert!(glob_matches("**/drafts/*", "x/drafts/a.md"));
        assert!(glob_matches("drafts/", "x/drafts/a.md"));
        assert!(!glob_matches("hr/*.md", "hr/a/b.md"));
        assert!(glob_matches("?.md", "a.md"));
    }

    #[test]
    fn form_fields_keep_their_order() {
        let p: PolicyHolder = serde_json::from_str(
            r#"{"uploadPolicy":{"uploadUrl":"u","formFields":{"z":"1","a":"2","m":"3"},"keyPrefix":"k/","maxByteSize":5,"expiresAt":"2030-01-01T00:00:00Z"}}"#,
        )
        .unwrap();
        let names: Vec<_> = p.upload_policy.unwrap().form_fields.0.into_iter().map(|(k, _)| k).collect();
        assert_eq!(names, ["z", "a", "m"]);
    }
}
