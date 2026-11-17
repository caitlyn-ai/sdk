//! A hand-built ingestion batch's two helpers (PROTOCOL.md 15): `batch.estimate_upload()` prices the items that need
//! bytes, and `batch.upload(files)` sends them, with the same steps `ingestion.sync` is built from
//! ([`crate::sync::estimate_upload`], [`crate::sync::upload_batch`]). The generated crate names the types.

use std::future::IntoFuture;
use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

use crate::client::Client;
use crate::error::Error;
use crate::request::{BoxFuture, CallOptions};
use crate::sync::{BatchFiles, BatchUpload, IngestionProgress, UploadOptions, ESTIMATE_PER_CALL};
use crate::watch::{Started, Waiting};

type FollowFn<W, Er, P> = Arc<dyn Fn() -> Waiting<W, Er, P> + Send + Sync>;
type WatchFn<S, Er> = Arc<dyn Fn() -> BoxFuture<'static, Result<S, Er>> + Send + Sync>;

/// `batch.upload(files)`: set its options, then await it (or `send()`) for the [`Started`] handle, whose `result()`
/// is the [`BatchUpload`] and whose `wait()` follows the batch to its end; `wait()` here does both.
pub struct UploadRequest<B, It, W, S, Er, P> {
    client: Client,
    kb: String,
    id: String,
    files: BatchFiles<It>,
    options: UploadOptions<It>,
    opts: CallOptions,
    codes: &'static [(&'static str, u16)],
    follow: FollowFn<W, Er, P>,
    watch: WatchFn<S, Er>,
    _b: PhantomData<fn() -> B>,
}

impl<B, It, W, S, Er, P> UploadRequest<B, It, W, S, Er, P>
where
    B: DeserializeOwned + Send + 'static,
    It: DeserializeOwned + Clone + Send + Sync + 'static,
    W: Send + 'static,
    S: Send + 'static,
    Er: From<Error> + Send + 'static,
    P: Send + 'static,
{
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        client: Client,
        kb: String,
        id: String,
        files: BatchFiles<It>,
        codes: &'static [(&'static str, u16)],
        follow: impl Fn() -> Waiting<W, Er, P> + Send + Sync + 'static,
        watch: impl Fn() -> BoxFuture<'static, Result<S, Er>> + Send + Sync + 'static,
    ) -> Self {
        UploadRequest {
            client,
            kb,
            id,
            files,
            options: UploadOptions::default(),
            opts: CallOptions::default(),
            codes,
            follow: Arc::new(follow),
            watch: Arc::new(watch),
            _b: PhantomData,
        }
    }

    /// Uploads at once (default 6).
    pub fn concurrency(mut self, n: usize) -> Self {
        self.options.concurrency = n.max(1);
        self
    }

    /// Called with each progress report: phase `upload` (bytes sent of bytes to send, with the item), then `queued`
    /// (items Complete accepted of items uploaded).
    pub fn on_progress(mut self, f: impl Fn(&IngestionProgress<It>) + Send + Sync + 'static) -> Self {
        self.options.on_progress = Some(Arc::new(f));
        self
    }

    /// Called with each item that ends during this call: an upload that failed (`UPLOAD_FAILED`, `FILE_CHANGED`, or a
    /// second `CHECKSUM_MISMATCH`), with its `failure_code` and `failure_detail`. Accepted items end later, during
    /// ingestion: the batch's `watch()` and `wait()` report them.
    pub fn on_item(mut self, f: impl Fn(&It) + Send + Sync + 'static) -> Self {
        self.options.on_item = Some(Arc::new(f));
        self
    }

    /// Cancelling the token stops new uploads, aborts those in flight and fails with [`Error::Cancelled`]. The batch
    /// is not cancelled: `batch.cancel()` does that.
    pub fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.opts = self.opts.cancel_on(token);
        self
    }

    /// Sets every call option at once.
    pub fn options(mut self, opts: CallOptions) -> Self {
        self.opts = opts;
        self
    }

    /// Uploads, and returns the handle: `result()` is the [`BatchUpload`]; `wait()` follows the batch to its end.
    #[allow(clippy::type_complexity)]
    pub fn send(self) -> BoxFuture<'static, Result<Started<BatchUpload<B, It>, W, S, Er, P>, Er>> {
        Box::pin(async move {
            let UploadRequest {
                client,
                kb,
                id,
                files,
                options,
                opts,
                codes,
                follow,
                watch,
                ..
            } = self;
            let out = crate::sync::upload_batch::<B, It>(&client, &kb, &id, &files, options, codes, &opts).await?;
            Ok(Started::new(out, move || follow(), move || watch()))
        })
    }

    /// Uploads, then waits until the batch has ended, and returns it as its `get` would.
    pub fn wait(self) -> Waiting<W, Er, P> {
        Waiting::new(move |wopts, progress| {
            Box::pin(async move {
                let started = self.send().await?;
                started.wait().options(wopts).progress(progress).await
            })
        })
    }
}

impl<B, It, W, S, Er, P> IntoFuture for UploadRequest<B, It, W, S, Er, P>
where
    B: DeserializeOwned + Send + 'static,
    It: DeserializeOwned + Clone + Send + Sync + 'static,
    W: Send + 'static,
    S: Send + 'static,
    Er: From<Error> + Send + 'static,
    P: Send + 'static,
{
    type Output = Result<Started<BatchUpload<B, It>, W, S, Er, P>, Er>;
    type IntoFuture = BoxFuture<'static, Self::Output>;
    fn into_future(self) -> Self::IntoFuture {
        self.send()
    }
}

/// `batch.estimate_upload()`: optionally `.files(…)` (the same files `upload` takes, for their sizes and hints), then
/// await it for the estimate.
pub struct EstimateUploadRequest<It, Est, Er> {
    client: Client,
    kb: String,
    id: String,
    files: Option<BatchFiles<It>>,
    per_call: usize,
    timeout: Option<Duration>,
    opts: CallOptions,
    codes: &'static [(&'static str, u16)],
    _t: PhantomData<fn() -> (Est, Er)>,
}

impl<It, Est, Er> EstimateUploadRequest<It, Est, Er>
where
    It: DeserializeOwned + Send + Sync + 'static,
    Est: DeserializeOwned + Send + 'static,
    Er: From<Error> + Send + 'static,
{
    #[doc(hidden)]
    pub fn new(client: Client, kb: String, id: String, codes: &'static [(&'static str, u16)]) -> Self {
        EstimateUploadRequest {
            client,
            kb,
            id,
            files: None,
            per_call: ESTIMATE_PER_CALL,
            timeout: None,
            opts: CallOptions::default(),
            codes,
            _t: PhantomData,
        }
    }

    /// The files the upload will send: each priced item is described from its file (name, content type, size and the
    /// hints it carries) instead of from the item. Nothing is hashed or read beyond the size.
    pub fn files(mut self, files: impl Into<BatchFiles<It>>) -> Self {
        self.files = Some(files.into());
        self
    }

    /// A time limit for the whole estimate, a planning batch's wait included: past it, [`Error::Timeout`].
    pub fn timeout(mut self, limit: Duration) -> Self {
        self.timeout = Some(limit);
        self
    }

    /// Documents per EstimateIngestion call (default and most 10,000), for tests.
    #[doc(hidden)]
    pub fn estimate_per_call(mut self, n: usize) -> Self {
        self.per_call = n.clamp(1, ESTIMATE_PER_CALL);
        self
    }

    /// Cancelling the token fails the estimate with [`Error::Cancelled`].
    pub fn cancel_on(mut self, token: CancellationToken) -> Self {
        self.opts = self.opts.cancel_on(token);
        self
    }

    /// Sets every call option at once.
    pub fn options(mut self, opts: CallOptions) -> Self {
        self.opts = opts;
        self
    }

    /// Sends the request.
    pub fn send(self) -> BoxFuture<'static, Result<Est, Er>> {
        Box::pin(async move {
            let EstimateUploadRequest {
                client,
                kb,
                id,
                files,
                per_call,
                timeout,
                opts,
                codes,
                ..
            } = self;
            let run = crate::sync::estimate_upload::<It, Est>(&client, &kb, &id, files.as_ref(), per_call, codes, &opts);
            let r = match timeout {
                Some(limit) => tokio::time::timeout(limit, run).await.unwrap_or(Err(Error::Timeout)),
                None => run.await,
            };
            r.map_err(Er::from)
        })
    }
}

impl<It, Est, Er> IntoFuture for EstimateUploadRequest<It, Est, Er>
where
    It: DeserializeOwned + Send + Sync + 'static,
    Est: DeserializeOwned + Send + 'static,
    Er: From<Error> + Send + 'static,
{
    type Output = Result<Est, Er>;
    type IntoFuture = BoxFuture<'static, Self::Output>;
    fn into_future(self) -> Self::IntoFuture {
        self.send()
    }
}
