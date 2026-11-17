# The guide "How ingestion works" shows these regions: a sync with its confirm step and report, a batch built by hand,
# following and resuming a batch, and stopping one, with the same region names in every language. In every region
# `kb` is `caitlyn.knowledge_bases(kb_id)`. scripts/test-python.sh type-checks this file against the SDK.
import base64
import hashlib
from pathlib import Path

from caitlyn import (
    Caitlyn,
    CaitlynError,
    EstimateIngestionResult,
    IngestionBatch,
    IngestionBatchItem,
    IngestionHints,
    IngestionItemInput,
    KnowledgeBaseScope,
    SyncInterrupted,
    SyncPlan,
    SyncReport,
    UploadFile,
)


def sync_with_confirm(kb: KnowledgeBaseScope) -> SyncReport[IngestionBatch, IngestionBatchItem]:
    # #region sync-with-confirm
    # Called once with the plan, before anything is uploaded: False cancels the batch.
    def confirm(plan: SyncPlan[IngestionBatch, IngestionBatchItem, EstimateIngestionResult]) -> bool:
        estimate = plan.estimate
        if estimate is None:  # nothing needs its bytes
            return True
        print(len(plan.items), "items,", estimate.documents, "to process, up to", estimate.duration_seconds.high, "s")
        if estimate.cost:  # only for callers allowed to see cost
            print(estimate.cost.low, "to", estimate.cost.high, estimate.cost.unit)
        return estimate.documents < 500

    report = kb.ingestion.sync(
        "./policies",
        folder="/policies/",
        remove_missing=True,
        confirm=confirm,
        # Called once for each item, when its status is final
        on_item=lambda item: print(item.path, item.status, item.failure_code or ""),
    )
    print(report.batch.status, report.batch.counts)  # succeeded, or completed_with_failures
    for item in report.items:
        if item.status == "failed":
            print(item.path, item.failure_code, item.failure_detail)
    # #endregion
    return report


def batch_failures(kb: KnowledgeBaseScope, batch_id: str) -> None:
    # #region batch-failures
    for item in kb.ingestion.batches(batch_id).items.list(status="failed"):
        print(item.path, item.failure_code, item.failure_detail)
    # #endregion


def build_batch(kb: KnowledgeBaseScope) -> IngestionBatch:
    # #region build-batch
    # Items you describe yourself, each file's SHA-256, size and type, with its own metadata; start="manual" waits for
    # start(). One map of files, keyed by each item's path, serves the estimate and the upload; hints reach the estimate.
    def item(path: str, local: Path, region: str) -> IngestionItemInput:
        data = local.read_bytes()
        return IngestionItemInput(path=path, sha256=base64.b64encode(hashlib.sha256(data).digest()).decode(), byte_size=len(data),
                                  content_type="application/pdf", metadata={"region": region})

    files = {
        "/news/2026-11.pdf": UploadFile.from_path("./news/2026-11.pdf", hints=IngestionHints(pages=12)),
        "/news/2026-10.pdf": UploadFile.from_path("./news/2026-10.pdf"),
    }
    batch = kb.ingestion.batches.create(
        start="manual",
        items=[item("/news/2026-11.pdf", Path("./news/2026-11.pdf"), "Otago"), item("/news/2026-10.pdf", Path("./news/2026-10.pdf"), "Canterbury")],
    )
    planned = batch.planned()  # every item has an outcome: new, changed, unchanged…
    estimate = batch.upload.estimate(files)  # what uploading them would take and cost, before anything is sent
    print(planned.counts, estimate.documents, "to process, up to", estimate.duration_seconds.high, "s")
    batch.start()
    sent = batch.upload(files)  # the files of the items awaiting upload, 6 at a time
    print(sent.not_given, sent.unmatched)  # awaiting items with no file given; paths that matched no awaiting item
    done = sent.wait()
    print(done.status, done.counts)
    # #endregion
    return done


def add_batch_items(caitlyn: Caitlyn, kb_id: str, first: list[IngestionItemInput], rest: list[IngestionItemInput]) -> None:
    # #region add-batch-items
    # The batch stays a draft while it takes more items; last=True ends the draft, and planning starts.
    batch = caitlyn.knowledge_bases(kb_id).ingestion.batches.create(start="manual", await_more_items=True, items=first)
    added = caitlyn.core.ingestion.add_items(kb_id, batch.id, rest, last=True)
    for result in added.results:
        if result.status == "failed":
            print("item", result.index, result.code)
    # #endregion


def follow_batch(kb: KnowledgeBaseScope, batch_id: str) -> IngestionBatch:
    # #region follow-batch
    # From the batch's identifier alone, after a restart: its running job as it stands, then at each change. The
    # percentage never goes backwards. timeout= (seconds) raises TimeoutError with the code WAIT_TIMEOUT.
    batch = kb.ingestion.batches(batch_id).wait(
        on_progress=lambda job: print(f"{job.percent or 0}%", job.eta.seconds.high if job.eta else "?", "s left"),
        timeout=3600,
    )
    print(batch.status, batch.counts)
    # #endregion
    return batch


def watch_batch(kb: KnowledgeBaseScope, batch_id: str) -> None:
    # #region watch-batch
    # A snapshot first, then each change; .processing reads both the same way.
    for event in kb.ingestion.batches(batch_id).watch():
        job = event.processing
        if job is not None:
            print(f"{job.percent}%")
        if event.type == "job.finished":
            break
    # #endregion


def cancel_sync(kb: KnowledgeBaseScope) -> None:
    # #region cancel-sync
    # Ctrl-C drops the uploads in flight and starts no new ones; cancel_ingestion=True also stops ingestion already running.
    try:
        kb.ingestion.sync("./policies", folder="/policies/", cancel_ingestion=True)
    except SyncInterrupted as stopped:  # a KeyboardInterrupt, with the report so far
        if stopped.report is not None:
            for item in stopped.report.items:
                print(item.path, item.status)
        raise
    # #endregion


def sync_declined(kb: KnowledgeBaseScope) -> None:
    # #region sync-declined
    try:
        kb.ingestion.sync("./policies", folder="/policies/", confirm=lambda plan: plan.estimate is None or plan.estimate.cost is None)
    except CaitlynError as err:
        if err.code != "CANCELLED":
            raise
        print("Not started; the batch is cancelled", err.report)
    # #endregion


def cancel_batch(kb: KnowledgeBaseScope, batch_id: str) -> None:
    # #region cancel-batch
    # Without stop_running, items already being ingested finish; with it, they stop too.
    kb.ingestion.batches(batch_id).cancel(stop_running=True)
    # #endregion
