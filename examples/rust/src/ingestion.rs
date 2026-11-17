//! The code of the guide "How ingestion works", one region each, with the region names every language's examples
//! share: a sync with its confirm step and report, a batch built by hand, following and resuming a batch, and
//! stopping one. scripts/test-rust.sh runs clippy over it.
use std::path::Path;
use std::time::Duration;

use caitlyn_sdk::{
    BatchFiles, CancellationToken, Client, Error, IngestionBatch, IngestionHints,
    IngestionItemInput, IngestionItemStatus, ItemCreateStatus, KnowledgeBaseEvent, StartMode,
    SyncInput, SyncReport, UploadFile,
};

/// Syncs a folder, asking before anything is uploaded, and reads the report.
pub async fn sync_with_confirm(
    client: &Client,
    knowledge_base_id: &str,
    dir: &Path,
) -> Result<SyncReport, Error> {
    // #region sync-with-confirm
    let kb = client.knowledge_base(knowledge_base_id);
    let report = kb
        .ingestion()
        .sync(
            SyncInput::dir(dir)
                .folder("/policies/")
                .remove_missing(true)
                // Called once with the plan, before anything is uploaded: false cancels the batch
                .confirm(|plan| {
                    let Some(estimate) = &plan.estimate else {
                        return true; // nothing needs its bytes
                    };
                    println!(
                        "{} items, {} to process, up to {:.0} s",
                        plan.items.len(),
                        estimate.documents,
                        estimate.duration_seconds.high
                    );
                    if let Some(cost) = &estimate.cost {
                        println!("{}-{} {}", cost.low, cost.high, cost.unit); // only for callers who may see cost
                    }
                    estimate.documents < 500
                })
                // Called once for each item, when its status is final
                .on_item(|item| println!("{:?} {}", item.path, item.status)),
        )
        .await?;
    println!("{} {:?}", report.batch.status, report.batch.counts); // succeeded, or completed_with_failures
    for item in report
        .items
        .iter()
        .filter(|i| i.status == IngestionItemStatus::Failed)
    {
        println!(
            "{:?} {:?} {:?}",
            item.path, item.failure_code, item.failure_detail
        );
    }
    // #endregion
    Ok(report)
}

/// Lists the failed items of a batch that ended completed_with_failures.
pub async fn batch_failures(
    client: &Client,
    knowledge_base_id: &str,
    batch_id: &str,
) -> Result<(), Error> {
    // #region batch-failures
    let batch = client
        .knowledge_base(knowledge_base_id)
        .ingestion()
        .batch(batch_id);
    let mut failed = batch
        .items()
        .list()
        .status(IngestionItemStatus::Failed)
        .items();
    while let Some(item) = failed.next().await {
        let item = item?;
        println!(
            "{:?} {:?} {:?}",
            item.path, item.failure_code, item.failure_detail
        );
    }
    // #endregion
    Ok(())
}

/// Builds a batch by hand from files on disk: the items, then what their upload would cost, the start and the upload.
/// `items` are the caller's own: each file's path in the knowledge base, SHA-256 (standard base64), size and type.
pub async fn build_batch(
    client: &Client,
    knowledge_base_id: &str,
    items: Vec<IngestionItemInput>,
    dir: &Path,
) -> Result<IngestionBatch, Error> {
    // #region build-batch
    let batch = client
        .knowledge_base(knowledge_base_id)
        .ingestion()
        .batches()
        .create()
        .start(StartMode::Manual) // wait for start() rather than starting once planned
        .items(items)
        .await?;
    batch.planned().await?; // every item has an outcome: new, changed, unchanged…
                            // One set of files serves both calls, keyed by item path: the estimate reads their sizes and hints, the upload their bytes.
    let files = BatchFiles::by_path([
        (
            "/hr/leave.pdf",
            UploadFile::from(dir.join("leave.pdf")).hints(IngestionHints {
                pages: Some(12),
                ..Default::default()
            }),
        ),
        ("/hr/pay.pdf", UploadFile::from(dir.join("pay.pdf"))),
    ]);
    let estimate = batch.estimate_upload().files(files.clone()).await?;
    println!(
        "{} documents, {:?}",
        estimate.documents, estimate.duration_seconds
    );
    batch.start().await?;
    let done = batch.upload(files).wait().await?; // uploads, then waits until the batch has ended
    println!("{} {:?}", done.status, done.counts);
    // #endregion
    Ok(done)
}

/// Makes a batch with more items than one call takes: it stays a draft until the last call.
pub async fn add_batch_items(
    client: &Client,
    knowledge_base_id: &str,
    first: Vec<IngestionItemInput>,
    rest: Vec<IngestionItemInput>,
) -> Result<(), Error> {
    // #region add-batch-items
    let batch = client
        .knowledge_base(knowledge_base_id)
        .ingestion()
        .batches()
        .create()
        .start(StartMode::Manual)
        .await_more_items(true)
        .items(first)
        .await?;
    // `last(true)` ends the draft, and planning starts
    let added = client
        .core()
        .ingestion()
        .add_items(knowledge_base_id, &batch.result().id, rest)
        .last(true)
        .await?;
    for r in added
        .results
        .iter()
        .filter(|r| r.status == ItemCreateStatus::Failed)
    {
        println!("item {}: {:?}", r.index, r.code);
    }
    // #endregion
    Ok(())
}

/// Follows a batch from its identifier alone, after a page reload or a restart.
pub async fn follow_batch(
    client: &Client,
    knowledge_base_id: &str,
    batch_id: &str,
) -> Result<IngestionBatch, Error> {
    // #region follow-batch
    // The batch's running job as it stands, then at each change; the percentage never goes backwards.
    let batch = client
        .knowledge_base(knowledge_base_id)
        .ingestion()
        .batch(batch_id)
        .wait()
        .on_progress(|p| println!("{:?}% {:?}", p.percent(), p.eta().map(|e| e.seconds.high)))
        .timeout(Duration::from_secs(3600)) // then Error::Timeout, with the code WAIT_TIMEOUT
        .await?;
    println!("{} {:?}", batch.status, batch.counts);
    // #endregion
    Ok(batch)
}

/// Reads the raw watch under wait(): a snapshot first, then each change.
pub async fn watch_batch(
    client: &Client,
    knowledge_base_id: &str,
    batch_id: &str,
) -> Result<(), Error> {
    // #region watch-batch
    let batch = client
        .knowledge_base(knowledge_base_id)
        .ingestion()
        .batch(batch_id);
    let mut events = batch.watch().await?;
    while let Some(event) = events.next().await {
        let event = event?;
        // The same in the snapshot and in each job.progress event
        if let Some(p) = event.processing() {
            println!("{:?}%", p.percent());
        }
        if let KnowledgeBaseEvent::JobFinished(_) = event {
            break;
        }
    }
    // #endregion
    Ok(())
}

/// Stops a sync part way: the error carries the report so far.
pub async fn cancel_sync(
    client: &Client,
    knowledge_base_id: &str,
    dir: &Path,
) -> Result<(), Error> {
    // #region cancel-sync
    let token = CancellationToken::new();
    let stop = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        stop.cancel();
    });
    let kb = client.knowledge_base(knowledge_base_id);
    let input = SyncInput::dir(dir)
        .folder("/policies/")
        .cancel_ingestion(true);
    match kb.ingestion().sync(input).cancel_on(token).await {
        Ok(report) => println!("{}", report.batch.status),
        Err(err) if err.is_cancelled() => {
            // Error::SyncCancelled, with the report so far: every item with its last status
            for item in err.report().map(|r| r.items.as_slice()).unwrap_or_default() {
                println!("{:?} {}", item.path, item.status);
            }
        }
        Err(err) => return Err(err),
    }
    // #endregion
    Ok(())
}

/// Handles a plan the confirm step declines: CANCELLED, with the plan's items in the report.
pub async fn sync_declined(
    client: &Client,
    knowledge_base_id: &str,
    dir: &Path,
) -> Result<(), Error> {
    // #region sync-declined
    let kb = client.knowledge_base(knowledge_base_id);
    let input = SyncInput::dir(dir)
        .folder("/policies/")
        .confirm(|plan| plan.estimate.as_ref().is_none_or(|e| e.cost.is_none()));
    match kb.ingestion().sync(input).await {
        Ok(report) => println!("{}", report.batch.status),
        // Error::SyncDeclined: the code CANCELLED, never a cancellation
        Err(err) if err.code() == Some("CANCELLED") => {
            println!(
                "Not started; the batch is {:?}",
                err.report().map(|r| &r.batch.status)
            );
        }
        Err(err) => return Err(err),
    }
    // #endregion
    Ok(())
}

/// Cancels a batch, also stopping ingestion already running.
pub async fn cancel_batch(
    client: &Client,
    knowledge_base_id: &str,
    batch_id: &str,
) -> Result<(), Error> {
    // #region cancel-batch
    // Without stop_running, items already being ingested finish; with it, they stop too.
    let batch = client
        .knowledge_base(knowledge_base_id)
        .ingestion()
        .batch(batch_id);
    batch.cancel().stop_running(true).await?;
    // #endregion
    Ok(())
}
