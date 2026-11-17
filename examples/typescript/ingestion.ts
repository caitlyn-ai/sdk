// The guide "How ingestion works" shows these regions: a sync with its confirm step and report, a batch built by
// hand, following and resuming a batch, and stopping one, with the same region names in every language. In each,
// `kb` is `caitlyn.knowledgeBases(kbId)`. scripts/test-typescript.sh type-checks this file against the SDK.
import { CaitlynError, isSyncAborted, withHints, type Caitlyn } from '@caitlyn-ai/sdk';

/** Syncs a folder, asking before anything is uploaded, and reads the report. */
export async function syncWithConfirm(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region sync-with-confirm
  const report = await kb.ingestion.sync('./policies', {
    folder: '/policies/',
    removeMissing: true,
    // Called once with the plan, before anything is uploaded: false cancels the batch
    confirm: ({ items, estimate }) => {
      console.log(`${items.length} items, ${estimate?.documents ?? 0} to process, up to ${estimate?.durationSeconds.high ?? 0} s`);
      if (estimate?.cost) {
        const { low, high, unit } = estimate.cost; // in the form the organisation sees its costs
        console.log(unit === 'usd' ? `US$${low.toFixed(2)}–${high.toFixed(2)}` : `${low.toFixed(1)}–${high.toFixed(1)}% of usage`);
      }
      return (estimate?.documents ?? 0) < 500;
    },
    // Called once for each item, when its status is final
    onItem: (item) => console.log(item.path, item.status, item.failureCode ?? ''),
  });
  console.log(report.batch.status, report.batch.counts?.byStatus); // succeeded, or completed_with_failures
  for (const item of report.items.filter((i) => i.status === 'failed')) console.log(item.path, item.failureCode, item.failureDetail);
  // #endregion
  return report;
}

/** The failed items of a batch that ended completed_with_failures. */
export async function batchFailures(caitlyn: Caitlyn, kbId: string, batchId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region batch-failures
  for await (const item of kb.ingestion.batches(batchId).items.list({ status: 'failed' })) {
    console.log(item.path, item.failureCode, item.failureDetail);
  }
  // #endregion
}

/** A batch built by hand from files on disk: priced before it starts, then uploaded and followed to its end. */
export async function buildBatch(caitlyn: Caitlyn, kbId: string, sha256Of: (path: string) => Promise<string>, sizeOf: (path: string) => Promise<number>) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region build-batch
  // The files, by the path each has in the knowledge base. A file can carry what you know of it, for the estimate
  const files = {
    '/news/2026-11.pdf': './news/2026-11.pdf',
    '/news/2026-10.pdf': withHints('./news/2026-10.pdf', { pages: 40 }),
  };
  const batch = await kb.ingestion.batches.create({
    start: 'manual', // wait for start() rather than starting once planned
    items: await Promise.all(
      Object.keys(files).map(async (path) => ({
        path,
        sha256: await sha256Of(`.${path}`), // base64: the upload is checked against it
        byteSize: await sizeOf(`.${path}`),
        contentType: 'application/pdf',
      })),
    ),
  });
  // What the upload would take and cost; waits until the batch is planned, and reads no file
  const estimate = await batch.upload.estimate(files);
  console.log(`${estimate.documents} documents, up to ${estimate.durationSeconds.high} s`);
  if (estimate.cost) {
    const { low, high, unit } = estimate.cost; // in the form the organisation sees its costs
    console.log(unit === 'usd' ? `US$${low.toFixed(2)}–${high.toFixed(2)}` : `${low.toFixed(1)}–${high.toFixed(1)}% of usage`);
  }
  await batch.start();
  const upload = batch.upload(files, { onItem: (item) => console.log(item.path, item.failureCode) }); // a failed upload
  const { notGiven, unmatched } = await upload; // items with no file given, and given paths that matched no item
  console.log(notGiven, unmatched);
  const done = await upload.wait(); // the batch, once it has finished
  console.log(done.status, done.counts?.byStatus);
  // #endregion
  return done;
}

/** More items than one call takes: the batch stays a draft until the last call. */
export async function addBatchItems(caitlyn: Caitlyn, kbId: string, first: { path: string; fetchUrl: string }[], rest: { path: string; fetchUrl: string }[]) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region add-batch-items
  const batch = await kb.ingestion.batches.create({ start: 'manual', awaitMoreItems: true, items: first });
  // `last: true` ends the draft, and planning starts
  const { results } = await caitlyn.core.ingestion.addItems(kbId, batch.ingestionBatchId, rest, { last: true });
  for (const r of results) if (r.status === 'failed') console.log(`item ${r.index}: ${r.code}`);
  // #endregion
  return batch;
}

/** Follows a batch from its identifier alone, after a page reload or a restart. */
export async function followBatch(caitlyn: Caitlyn, kbId: string, batchId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region follow-batch
  // The batch's running job as it stands, then at each change; the percentage never goes backwards
  const batch = await kb.ingestion.batches(batchId).wait({
    onProgress: (job) => console.log(`${job.percent ?? 0}%, about ${job.eta?.seconds.high ?? '?'} s left`),
    timeoutMs: 60 * 60_000, // a TimeoutError with the code WAIT_TIMEOUT after an hour; no limit by default
  });
  console.log(batch.status, batch.counts?.byStatus);
  // #endregion
  return batch;
}

/** The raw watch under wait(): a snapshot first, then each change. */
export async function watchBatch(caitlyn: Caitlyn, kbId: string, batchId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region watch-batch
  for await (const event of kb.ingestion.batches(batchId).watch()) {
    if (event.type === 'snapshot') console.log('now', event.batch?.status);
    const job = event.processing; // the same in the snapshot and in each job.progress event
    if (job) console.log(`${job.percent ?? 0}%`);
    if (event.type === 'job.finished') break;
  }
  // #endregion
}

/** Stops a sync part way: the error carries the report so far. */
export async function cancelSync(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region cancel-sync
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    await kb.ingestion.sync('./policies', { folder: '/policies/', signal: controller.signal, cancelIngestion: true });
  } catch (err) {
    if (!isSyncAborted(err)) throw err;
    // The signal's reason, with the report so far: the batch, and every item with its last status
    for (const item of err.report.items) console.log(item.path, item.status);
  }
  // #endregion
}

/** A plan the confirm step declines: CANCELLED, with the plan's items in the report. */
export async function syncDeclined(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region sync-declined
  try {
    await kb.ingestion.sync('./policies', { folder: '/policies/', confirm: ({ estimate }) => !estimate?.cost });
  } catch (err) {
    if (!(err instanceof CaitlynError && err.code === 'CANCELLED')) throw err;
    console.log(`Not started; batch ${err.report?.batch.id} is ${err.report?.batch.status}`); // cancelled
  }
  // #endregion
}

/** Cancels a batch, also stopping ingestion already running. */
export async function cancelBatch(caitlyn: Caitlyn, kbId: string, batchId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region cancel-batch
  // Without stopRunning, items already being ingested finish; with it, they stop too
  await kb.ingestion.batches(batchId).cancel({ stopRunning: true });
  // #endregion
}
