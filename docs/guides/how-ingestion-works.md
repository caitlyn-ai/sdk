---
pageType: guide
sinceVersion: 5000115000000
resources:
  - knowledge-base
  - document
  - upload
integrations: []
operations:
  - CreateDocument
  - CreateIngestionBatch
  - BatchCreateIngestionBatchItems
  - GetIngestionBatch
  - ListIngestionBatches
  - ListIngestionBatchItems
  - UpdateIngestionBatchItem
  - EstimateIngestion
  - StartIngestionBatch
  - CreateIngestionBatchUploadPolicy
  - CompleteIngestionBatchUploads
  - CancelIngestionBatch
  - WatchKnowledgeBase
---

# How ingestion works

Ingestion is how files become documents an agent can search and cite. One file is one document and one piece of
work. Many files go through an ingestion batch: Caitlyn plans the whole batch first, so you know what will change and
what it will cost before a single byte is sent, then ingests each file and tells you how each one ended. This page
explains what happens along the way, how to follow it, how to stop it, and what to do when part of it fails.

In short: add one document and wait until it can be searched, or keep a folder of the knowledge base in step with a
folder on disk.

<!-- example: examples/typescript/jobs.ts#add-document+sync-folder "Or keep a whole folder in step with a folder on disk" -->
```ts tab="TypeScript"
const doc = await kb.documents.create('./leave-policy.pdf', { folder: '/hr/' }).wait();

// Or keep a whole folder in step with a folder on disk
const report = await kb.ingestion.sync('./policies', { folder: '/policies/', removeMissing: true });
for (const item of report.items) console.log(item.path, item.outcome, item.status, item.failureCode ?? '');
```
<!-- example: examples/python/jobs.py#add-document+sync-folder "Or keep a whole folder in step with a folder on disk" -->
```python tab="Python"
# The SDK hashes the file, uploads it and creates the document; .wait() returns it once it can be searched.
doc = kb.documents.create("leave-policy.pdf", folder="/hr/").wait()
print(doc.id, doc.status)

# Or keep a whole folder in step with a folder on disk
# Keeps /policies/ in step with a local folder: new files are added, changed ones get a new version and, with
# remove_missing, documents whose file is gone are removed. Files are keyed by their path in the folder.
report = kb.ingestion.sync("./policies", folder="/policies/", remove_missing=True)
for item in report.items:
    print(item.path, item.outcome, item.status, item.failure_code or "")
```
<!-- example: examples/go/documents/documents.go#add-document+sync-folder "Or keep a whole folder in step with a folder on disk" -->
```go tab="Go"
kb := client.KnowledgeBase(knowledgeBaseID)
// PDF, Word (.docx), Markdown, images, audio or video; the content type comes from the extension. The SDK hashes
// the file and uploads it straight to storage: no Caitlyn credentials go with the bytes.
doc, err := kb.Documents.Create(ctx, caitlyn.Path(path), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
if err != nil {
	return nil, err
}
// doc is the new document's scope; Wait follows its ingestion until it can be searched
indexed, err := doc.Wait(ctx)
if err != nil {
	return nil, err // a failed ingestion is its typed error, such as *caitlyn.UnprocessableContentError
}
fmt.Println(indexed.ID, indexed.Status)

// Or keep a whole folder in step with a folder on disk
report, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
	Folder:        "/policies/", // where the files go; files are keyed by their path in dir
	RemoveMissing: true,         // documents under /policies/ with no file are removed
})
if err != nil {
	return nil, err
}
fmt.Println(report.Batch.Status)
for _, item := range report.Items {
	fmt.Println(*item.Path, item.Status, item.FailureCode)
}
```
<!-- example: examples/rust/src/documents.rs#add-document+sync-folder "Or keep a whole folder in step with a folder on disk" -->
```rust tab="Rust"
let kb = client.knowledge_base(knowledge_base_id);
// The SDK hashes the file, uploads it, adds the document, then follows its processing until it is searchable.
// (`.send().await?` instead gives the response at once, with `wait()` and `watch()` for later.)
let doc = kb.documents().create(path).folder("/hr/").wait().await?;
// indexed, or partially_indexed with doc.partial_failures
println!("{} {}", doc.id, doc.status);

// Or keep a whole folder in step with a folder on disk
let kb = client.knowledge_base(knowledge_base_id);
// Each file is keyed by its path under the folder; files gone from the folder are removed from /policies/.
let report = kb
    .ingestion()
    .sync(
        SyncInput::dir(dir)
            .folder("/policies/")
            .remove_missing(true),
    )
    .await?;
for item in &report.items {
    println!("{:?} {:?} {}", item.path, item.outcome, item.status);
}
```


<!-- not-available -->

## Which call to use

| You have | Call | What you get back |
| --- | --- | --- |
| One file | `kb.documents.create(file).wait()` | The document, once it can be searched |
| A folder, or a list of files | `kb.ingestion.sync(folderOrItems, options)` | A report of every file: what happened to it and how it ended |
| Content Caitlyn fetches itself, or a plan someone checks before it starts | `kb.ingestion.batches.create(…)` | A batch you plan, start and wait on yourself |

- **One file.** `kb.documents.create` uploads the file and creates the document; `wait()` returns it once it is
  indexed, or raises the error that stopped it. [Load documents](/guides/load-documents/) covers adding, replacing
  and deleting single documents.
- **Many files.** `kb.ingestion.sync` puts them all through one batch. It sends only the files that need their bytes
  (a file that has not changed is not sent again), removes documents whose file has gone if you ask, and returns a
  report rather than raising when some files fail. It takes a list of files as well as a folder, and any number of
  them, and gives each its own external ID, source address and metadata through the functions you pass, so most code
  never needs a batch of its own.
- **A batch of your own.** Build one when Caitlyn should fetch each file from an address rather than you uploading
  it, when the plan has to wait for someone to check it before it starts, or when you are building a sync of your
  own.

## Sync a folder

[`kb.ingestion.sync`](/reference/helpers/ingestion-sync/) runs the whole flow in one call. It hashes every file,
creates a batch, waits until the batch is planned, asks you to confirm the plan, starts the batch, uploads the files
that need their bytes (six at a time), waits until every item has finished, and returns the report.

<!-- example: examples/typescript/ingestion.ts#sync-with-confirm -->
```ts tab="TypeScript"
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
```
<!-- example: examples/python/ingestion.py#sync-with-confirm -->
```python tab="Python"
# Called once with the plan, before anything is uploaded: False cancels the batch.
def confirm(plan: SyncPlan[IngestionBatch, IngestionBatchItem, EstimateIngestionResult]) -> bool:
    estimate = plan.estimate
    if estimate is None:  # nothing needs its bytes
        return True
    print(len(plan.items), "items,", estimate.documents, "to process, up to", estimate.duration_seconds.high, "s")
    if cost := estimate.cost:  # only for callers allowed to see cost, in the form the organisation sees it
        print(f"US${cost.low:.2f}–{cost.high:.2f}" if cost.unit == "usd" else f"{cost.low:.1f}–{cost.high:.1f}% of usage")
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
```
<!-- example: examples/go/ingestion/ingestion.go#sync-with-confirm -->
```go tab="Go"
report, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
	Folder:        "/policies/",
	RemoveMissing: true,
	// Called once with the plan, before anything is uploaded: false cancels the batch
	Confirm: func(_ context.Context, plan *caitlyn.SyncPlan) (bool, error) {
		e := plan.Estimate
		if e == nil { // nothing needs its bytes
			return true, nil
		}
		fmt.Println(len(plan.Items), "items,", e.Documents, "to process, up to", e.DurationSeconds.High, "s")
		if e.Cost != nil { // only for callers who may see cost
			switch e.Cost.Unit { // the form the organisation sees its costs in
			case caitlyn.CostUnitUsd:
				fmt.Printf("US$%.2f–%.2f\n", e.Cost.Low, e.Cost.High)
			case caitlyn.CostUnitPercentOfPlan:
				fmt.Printf("%.1f–%.1f%% of usage\n", e.Cost.Low, e.Cost.High)
			default:
				fmt.Printf("%.2f–%.2f %s\n", e.Cost.Low, e.Cost.High, e.Cost.Unit)
			}
		}
		return e.Documents < 500, nil
	},
	// Called once for each item, when its status is final
	OnItem: func(item caitlyn.IngestionBatchItem) { fmt.Println(*item.Path, item.Status) },
})
if err != nil {
	return nil, err
}
fmt.Println(report.Batch.Status) // succeeded, or completed_with_failures
for _, item := range report.Items {
	if item.Status == caitlyn.IngestionItemStatusFailed {
		fmt.Println(*item.Path, *item.FailureCode) // FailureDetail says what to do
	}
}
```
<!-- example: examples/rust/src/ingestion.rs#sync-with-confirm -->
```rust tab="Rust"
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
                    // only for callers who may see cost
                    match &cost.unit {
                        // the form the organisation sees its costs in
                        CostUnit::Usd => println!("US${:.2}-{:.2}", cost.low, cost.high),
                        CostUnit::PercentOfPlan => {
                            println!("{:.1}-{:.1}% of usage", cost.low, cost.high)
                        }
                        other => println!("{}-{} {}", cost.low, cost.high, other),
                    }
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
```

- **`folder`** is where the files go in the knowledge base, starting and ending in `/`. Each file is keyed by its
  path below the folder on disk, so the same file keeps its document from one sync to the next.
- **`removeMissing`** removes each document under the folder that has no file any more.
- **`confirm`** is called once, with the plan, before anything is uploaded: the batch, every item with what will
  happen to it, and the estimate. The estimate prices every item that could need its bytes, items still
  `unresolved` whose outcome could take bytes included, so it is the most the batch could cost; `confirm` sees it
  before your resolver runs. It gives the documents to process, how long that takes as a range of seconds and, if you
  may see costs, its cost, in the form your organisation sees it. There is no estimate when no item could need its bytes. Return false to stop: the batch is cancelled and the call raises `CANCELLED`
  ([Decline the plan](#decline-the-plan)).
- **`onItem`** is called once for each item, when its status is final: `indexed`, `skipped`, `moved`, `updated`,
  `removed`, `cancelled` or `failed`. An upload being accepted never calls it. An item that needs no bytes (one
  skipped or removed, say) reaches it as soon as the batch starts; an upload that fails reaches it at once; the rest
  reach it when the batch has finished.
- **The report** lists every item with its outcome, how it was resolved, its status, its document and version, and
  its failure code and detail if it failed, with the batch's final status and counts. In TypeScript the batch's
  status and counts are on the report itself (`report.status`); in the other SDKs they are on `report.batch`.

Each SDK spells the options in its own style, as the example shows. [Load documents](/guides/load-documents/#keep-a-folder-in-step)
covers the rest: choosing files with `include`, `exclude` and `.caitlynignore`, the policy that settles clashes, and
the resolver.

## What happens to a batch

Every batch, whether `sync` made it or you did, goes through the same steps.

1. **Draft.** A batch takes items while it is created with `awaitMoreItems`. Most batches skip this step: they are
   created with all their items.
2. **Planning.** Caitlyn matches each item to the knowledge base's documents, by its external ID or else by its
   path, and gives it an outcome: `new`, `changed`, `unchanged`, `moved`, `to_remove`, `in_progress` (the document
   is being ingested already), `conflict` or `fetch_failed`.
3. **Planned.** Every item has a resolution as well: what will be done with it, such as `add`, `new_version`, `move`,
   `update_metadata`, `remove` or `skip`. The batch's policy chooses each one. An item the policy cannot decide is
   `unresolved`, and the batch cannot start until you decide it. The plan goes stale after 5 minutes, and starting the
   batch plans it again. A batch never started is cleared after 7 days.
4. **Estimate and confirm.** `sync` prices the items that need their bytes and asks `confirm`. A batch you build
   yourself starts when you start it, or as soon as it is planned with nothing unresolved if you did not ask to start
   it by hand.
5. **Running.** Starting the batch claims each write: a new document is reserved at its path, and an existing one is
   protected, so a document that changed since the plan becomes a `changed_since_plan` conflict rather than being
   overwritten. Items that need their bytes wait for them (`awaiting_upload`), then are ingested (`ingesting`).
   Items that need no bytes finish at once.
6. **Finished.** The batch ends in one of the final statuses below.

| Batch status | What it means |
| --- | --- |
| `draft` | Taking items. |
| `planning` | Working out each item's outcome. |
| `planned` | Every item has an outcome; waiting to be started, or for unresolved items. |
| `running` | Started: items are being uploaded and ingested. |
| `succeeded` | Every item finished and none failed. Final. |
| `completed_with_failures` | Every item finished, and at least one failed. Final. |
| `failed` | The batch itself stopped, for example because a policy rule said `fail`; its `failure` says why. Final. |
| `cancelled` | Cancelled. Final. |

| Item status | What it means |
| --- | --- |
| `draft` | Not started. |
| `awaiting_upload` | Waiting for its bytes. |
| `ingesting` | Being ingested. |
| `indexed` | Ingested and searchable. Final. |
| `skipped`, `moved`, `updated`, `removed` | Done, with nothing to ingest. Final. |
| `cancelled` | Its document was deleted while it was being ingested. Final, and not a failure. |
| `failed` | Failed; `failureCode` says why. Final. |

### Cancelled items

An item ends `cancelled` when someone deletes its document while it is being ingested: the delete stops it. That is
not a failure. The item reaches `onItem` once, with no failure code, counts as done, and is never uploaded again. A
batch whose items all ended `indexed`, `skipped` or `cancelled` still ends `succeeded`, and neither `sync` nor
`wait()` raises.

### When some items fail

A batch that ends `completed_with_failures` finished every item, and some of them failed. Neither `sync` nor the
batch's `wait()` raises for it: `sync` returns the report, and `wait()` returns the batch. Read each failed item's
`failureCode` and `failureDetail`, in the report or by listing the batch's failed items:

<!-- example: examples/typescript/ingestion.ts#batch-failures -->
```ts tab="TypeScript"
for await (const item of kb.ingestion.batches(batchId).items.list({ status: 'failed' })) {
  console.log(item.path, item.failureCode, item.failureDetail);
}
```
<!-- example: examples/python/ingestion.py#batch-failures -->
```python tab="Python"
for item in kb.ingestion.batches(batch_id).items.list(status="failed"):
    print(item.path, item.failure_code, item.failure_detail)
```
<!-- example: examples/go/ingestion/ingestion.go#batch-failures -->
```go tab="Go"
batch := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID)
failed := &caitlyn.ListIngestionBatchItemsInput{Status: caitlyn.Ptr(caitlyn.IngestionItemStatusFailed)}
for item, err := range batch.Items.List(ctx, failed) {
	if err != nil {
		return err
	}
	fmt.Println(*item.Path, *item.FailureCode) // FailureDetail says what to do
}
```
<!-- example: examples/rust/src/ingestion.rs#batch-failures -->
```rust tab="Rust"
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
```

The detail says what to do. Some codes you may see:

- `UPLOAD_FAILED`: the SDK could not send the file after its retries, so its bytes never arrived. Sync it again.
- `UPLOAD_EXPIRED`: no bytes arrived for the item before its reservation ended.
- `FILE_CHANGED`: a file is not the one its item describes: it changed on disk between being hashed and being sent,
  or its size or bytes differ from the item's.
- `VALIDATION_FAILED`: for a new version, bytes of another file type than the document's.
- `DOCUMENT_INGESTION_IN_PROGRESS`: an earlier version of the document was still being processed.

A batch that ends `failed` is different: the batch itself stopped, and its `failure` has a code and a message.
`conflict_policy_fail` means an item had a conflict whose policy rule is `fail`, and `planning_failed` that planning
could not finish; in both, nothing was changed, so make a new batch. A document that is indexed with some parts left
out (a picture description or a table, say) is not a failed item either: it is `partially_indexed`, and its
[partial failures](/guides/load-documents/#wait-until-it-is-indexed) say what was left out.

## Build a batch yourself

[CreateIngestionBatch](/reference/create-ingestion-batch/) makes a batch with up to 10,000 items. Each item is a
document's path and its content: either an address Caitlyn fetches the file from while planning (`fetchUrl`), or
the file's description (its SHA-256, size and content type) for bytes you upload. `start: 'manual'` keeps the batch
`planned` until you start it, so you can read the plan first; without it, the batch starts as soon as it is planned
with nothing unresolved.

For the items whose bytes you upload, the batch has the two steps sync takes for you. Both take the same files, keyed
by each item's path:

- `batch.upload.estimate(files)` ([Estimate the upload](/reference/helpers/batch-upload-estimate/)) says what
  uploading them would take and cost, before you start the batch. It waits until the batch is planned, and reads no
  file: each is described by its name, content type and size, plus any hints you give with it. Without files, each
  item is priced from its own description.
- `batch.upload(files)` ([Upload files](/reference/helpers/batch-upload/)) sends them once the batch has started.
  An item you give no file for is left awaiting upload and listed in `notGiven`, so you can upload in several calls; a
  path that matches no item awaiting upload is listed in `unmatched`, and nothing is sent for it. A failed upload is
  that item's alone, with its `failureCode`, and never raised.

<!-- example: examples/typescript/ingestion.ts#build-batch -->
```ts tab="TypeScript"
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
```
<!-- example: examples/python/ingestion.py#build-batch -->
```python tab="Python"
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
```
<!-- example: examples/go/ingestion/ingestion.go#build-batch -->
```go tab="Go"
// One item a file: its document path, checksum, size and content type, as the batch plans from them
var items []caitlyn.IngestionItemInput
upload := map[string]caitlyn.File{}
for docPath, local := range files {
	data, err := os.ReadFile(local)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	items = append(items, caitlyn.IngestionItemInput{
		Path:        caitlyn.Ptr(docPath),
		SHA256:      caitlyn.Ptr(base64.StdEncoding.EncodeToString(sum[:])),
		ByteSize:    caitlyn.Ptr(int64(len(data))),
		ContentType: caitlyn.Ptr("application/pdf"),
		Metadata:    map[string]any{"owner": "hr"},
	})
	upload[docPath] = caitlyn.Path(local)
}
batch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batches.Create(ctx, &caitlyn.CreateIngestionBatchInput{
	Start: caitlyn.Ptr(caitlyn.StartModeManual), // wait for Start rather than starting once planned
	Items: items,
})
if err != nil {
	return nil, err
}
// Waits until the batch is planned, then prices the items that need their bytes, from the files' sizes (and any
// hints given with caitlyn.WithHints): nothing is uploaded or hashed
estimate, err := batch.EstimateUpload(ctx, caitlyn.FilesByPath(upload))
if err != nil {
	return nil, err
}
fmt.Println(estimate.Documents, estimate.DurationSeconds.High, "seconds at most")
if _, err := batch.Start(ctx); err != nil { // starts the batch as it stands
	return nil, err
}
sent, err := batch.Upload(ctx, caitlyn.FilesByPath(upload), nil)
if err != nil {
	return nil, err
}
fmt.Println(len(sent.Result.Items), "uploaded;", sent.Result.NotGiven, "left awaiting their files")
done, err := sent.Wait(ctx) // the batch, once it has finished
if err != nil {
	return nil, err
}
fmt.Println(done.Status)
```
<!-- example: examples/rust/src/ingestion.rs#build-batch -->
```rust tab="Rust"
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
```

- **Fetched content.** A `fetchUrl` is a public `http` or `https` address of a file of at most 100 MB, and needs the
  files create permission. A batch takes at most 1,000 such items. A file that cannot be fetched gives its item the
  outcome `fetch_failed`, with a `reason` such as `fetch_timeout` or `fetch_too_large`, and the item is skipped.
- **Uploaded content.** An item described by its checksum waits for its bytes after the batch starts, under the
  batch's upload policy, and `batch.upload` sends them. Storage checks each file against the item's checksum, so a
  file that changed since you described it fails its item with `FILE_CHANGED`. For a folder of files you have, `sync`
  does all of this in one call.
- **Metadata.** Each item can carry `metadata` for the knowledge base's fields, an `externalId` that keeps the
  document wherever it moves, and a `sourceUrl` that citations link to (the `fetchUrl` by default).
- **Starting.** [StartIngestionBatch](/reference/start-ingestion-batch/) starts the batch as it stands; give the
  planned batch's ETag to start only the plan you read ([conditional writes](/errors/#conditional-writes-etags-and-if-match)). Decide any `unresolved` item first, with
  `kb.ingestion.batches(batchId).items(itemId).resolve(…)` ([UpdateIngestionBatchItem](/reference/update-ingestion-batch-item/));
  until then, starting is refused with `INGESTION_BATCH_UNRESOLVED`.

## Follow the progress

Waiting needs only the batch's ID, so it works the same in the process that started the batch, after a page reload,
or in another process altogether. `kb.ingestion.batches(batchId).wait()` returns the batch, as `get()` does, once
nothing is running on it.

<!-- example: examples/typescript/ingestion.ts#follow-batch -->
```ts tab="TypeScript"
// The batch's running job as it stands, then at each change; the percentage never goes backwards
const batch = await kb.ingestion.batches(batchId).wait({
  onProgress: (job) => console.log(`${job.percent ?? 0}%, about ${job.eta?.seconds.high ?? '?'} s left`),
  timeoutMs: 60 * 60_000, // a TimeoutError with the code WAIT_TIMEOUT after an hour; no limit by default
});
console.log(batch.status, batch.counts?.byStatus);
```
<!-- example: examples/python/ingestion.py#follow-batch -->
```python tab="Python"
# From the batch's identifier alone, after a restart: its running job as it stands, then at each change. The
# percentage never goes backwards. timeout= (seconds) raises TimeoutError with the code WAIT_TIMEOUT.
batch = kb.ingestion.batches(batch_id).wait(
    on_progress=lambda job: print(f"{job.percent or 0}%", job.eta.seconds.high if job.eta else "?", "s left"),
    timeout=3600,
)
print(batch.status, batch.counts)
```
<!-- example: examples/go/ingestion/ingestion.go#follow-batch -->
```go tab="Go"
// The batch's running job as it stands, then at each change; the percentage never goes backwards. Past the time
// limit, the error is an *Error with the code WAIT_TIMEOUT, and errors.Is(err, context.DeadlineExceeded) holds.
batch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID).Wait(ctx,
	caitlyn.WithProgress(func(p caitlyn.Processing) {
		if p.Percent != nil {
			fmt.Println(*p.Percent, "%")
		}
	}),
	caitlyn.WithTimeLimit(time.Hour),
)
if err != nil {
	return nil, err
}
fmt.Println(batch.Status) // succeeded, or completed_with_failures
```
<!-- example: examples/rust/src/ingestion.rs#follow-batch -->
```rust tab="Rust"
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
```

- **Progress.** `onProgress` is called first with the batch's processing as it stands, then once for each progress
  report, in order, and never after `wait()` has returned or raised. A batch's processing is the job running on it:
  its `percent`, which never goes backwards, and its `eta`, a range of seconds, once it has run long enough to say. A
  document's processing has a `stage` too ([Load documents](/guides/load-documents/#wait-until-it-is-indexed)).
- **Busy.** A batch is busy while it is `planning` or `running`. `batch.planned()` waits the same way, but only until
  the batch is planned or past it.
- **Handles.** A call that starts work returns a handle with `wait()` and `watch()`:
  `kb.documents.create(file).wait()` waits for the document it creates, and the scope a batch's `create` returns has
  `planned()` and `wait()`.

`wait()` is built on `watch()`, which you can read yourself. Its first event is always a snapshot of the batch as it
stands, with its running and recently finished jobs; then one event per change. The server ends a connection after
at most an hour, and a connection can drop: either way the SDK reconnects, and the new connection starts with a
snapshot again, so nothing is replayed and nothing is missed. Every event has the same `processing` accessor, which
reads the snapshot and the progress events alike.

<!-- example: examples/typescript/ingestion.ts#watch-batch -->
```ts tab="TypeScript"
for await (const event of kb.ingestion.batches(batchId).watch()) {
  if (event.type === 'snapshot') console.log('now', event.batch?.status);
  const job = event.processing; // the same in the snapshot and in each job.progress event
  if (job) console.log(`${job.percent ?? 0}%`);
  if (event.type === 'job.finished') break;
}
```
<!-- example: examples/python/ingestion.py#watch-batch -->
```python tab="Python"
# A snapshot first, then each change; .processing reads both the same way.
for event in kb.ingestion.batches(batch_id).watch():
    job = event.processing
    if job is not None:
        print(f"{job.percent}%")
    if event.type == "job.finished":
        break
```
<!-- example: examples/go/ingestion/ingestion.go#watch-batch -->
```go tab="Go"
watch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID).Watch(ctx)
if err != nil {
	return err
}
defer watch.Close()
for event, err := range watch.Events() {
	if err != nil {
		return err
	}
	// The same in the snapshot and in each job.progress event
	if p := event.GetProcessing(); p != nil && p.Percent != nil {
		fmt.Println(*p.Percent, "%")
	}
	if event.EventType() == "job.finished" {
		break
	}
}
```
<!-- example: examples/rust/src/ingestion.rs#watch-batch -->
```rust tab="Rust"
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
```

On the knowledge base's own watch (`kb.watch()`), where an event can be about any document, folder or batch,
`processingOf(id)` reads the processing of the one you name ([WatchKnowledgeBase](/reference/watch-knowledge-base/)).

## Stop ingestion

### Cancel a sync

Cancel a sync the way your language cancels anything: an abort signal in TypeScript, Ctrl-C or a cancelled task in
Python, a cancelled context in Go, a cancellation token in Rust. The SDK stops starting uploads, aborts those in
flight, and raises your language's own cancellation error. That error carries the report so far: every item, with
its last status.

<!-- example: examples/typescript/ingestion.ts#cancel-sync -->
```ts tab="TypeScript"
const controller = new AbortController();
setTimeout(() => controller.abort(), 10 * 60_000);
try {
  await kb.ingestion.sync('./policies', { folder: '/policies/', signal: controller.signal, cancelIngestion: true });
} catch (err) {
  if (!isSyncAborted(err)) throw err;
  // The signal's reason, with the report so far: the batch, and every item with its last status
  for (const item of err.report.items) console.log(item.path, item.status);
}
```
<!-- example: examples/python/ingestion.py#cancel-sync -->
```python tab="Python"
# Ctrl-C drops the uploads in flight and starts no new ones; cancel_ingestion=True also stops ingestion already running.
try:
    kb.ingestion.sync("./policies", folder="/policies/", cancel_ingestion=True)
except SyncInterrupted as stopped:  # a KeyboardInterrupt, with the report so far
    if stopped.report is not None:
        for item in stopped.report.items:
            print(item.path, item.status)
    raise
```
<!-- example: examples/go/ingestion/ingestion.go#cancel-sync -->
```go tab="Go"
ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
defer cancel()
_, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
	Folder:          "/policies/",
	CancelIngestion: true, // also stop ingestion already running
})
var cancelled *caitlyn.SyncCancelledError // errors.Is(err, context.DeadlineExceeded) holds too
if errors.As(err, &cancelled) {
	for _, item := range cancelled.Report.Items { // every item with its last status
		fmt.Println(*item.Path, item.Status)
	}
	return nil
}
```
<!-- example: examples/rust/src/ingestion.rs#cancel-sync -->
```rust tab="Rust"
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
```

- **TypeScript** raises the signal's reason, with `report` on it.
- **Python** raises `SyncInterrupted`, a `KeyboardInterrupt`, from the synchronous client, and `SyncCancelledError`,
  an `asyncio.CancelledError`, from the asynchronous one; both have `report`. On the synchronous client, Ctrl-C drops the
  uploads in flight; with your own `httpx.Client`, an upload that has finished sending waits for storage's answer,
  up to that client's timeout.
- **Go** returns a `*caitlyn.SyncCancelledError` with `Report`; `errors.Is(err, context.Canceled)` holds (or
  `context.DeadlineExceeded`, for a deadline).
- **Rust** returns `Error::SyncCancelled`, for which `is_cancelled()` is true and `report()` gives the report.
  Dropping the future instead stops everything at once, with no report.

By the time the error is raised, `onItem` has seen every item that reached a final status, and it is never called
again. Files already handed over keep being ingested, unless you also set `cancelIngestion`, which cancels the batch
and stops them too.

### Decline the plan

A `confirm` that returns false cancels the batch before anything is uploaded. The call raises `CANCELLED` with status
0, an error the SDK raises itself, as your language's ordinary error type, never its cancellation type, so code that
treats cancellation as "the user stopped it" does not mistake one for the other. It carries the report too: the
planned items.

<!-- example: examples/typescript/ingestion.ts#sync-declined -->
```ts tab="TypeScript"
try {
  await kb.ingestion.sync('./policies', { folder: '/policies/', confirm: ({ estimate }) => !estimate?.cost });
} catch (err) {
  if (!(err instanceof CaitlynError && err.code === 'CANCELLED')) throw err;
  console.log(`Not started; batch ${err.report?.batch.id} is ${err.report?.batch.status}`); // cancelled
}
```
<!-- example: examples/python/ingestion.py#sync-declined -->
```python tab="Python"
try:
    kb.ingestion.sync("./policies", folder="/policies/", confirm=lambda plan: plan.estimate is None or plan.estimate.cost is None)
except CaitlynError as err:
    if err.code != "CANCELLED":
        raise
    print("Not started; the batch is cancelled", err.report)
```
<!-- example: examples/go/ingestion/ingestion.go#sync-declined -->
```go tab="Go"
_, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
	Folder: "/policies/",
	Confirm: func(_ context.Context, plan *caitlyn.SyncPlan) (bool, error) {
		return plan.Estimate == nil || plan.Estimate.Cost == nil, nil
	},
})
var declined *caitlyn.SyncDeclinedError // an *Error with the code CANCELLED; not context.Canceled
if errors.As(err, &declined) {
	fmt.Println("Not started; the batch is", declined.Report.Batch.Status)
	return nil
}
```
<!-- example: examples/rust/src/ingestion.rs#sync-declined -->
```rust tab="Rust"
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
```

### Cancel a batch

[CancelIngestionBatch](/reference/cancel-ingestion-batch/) cancels any batch that has not finished. Items not yet
uploaded are stopped, and the documents reserved for them released. Items already being ingested finish, unless you
pass `stopRunning`: then they stop too, a stopped new document is removed, and a stopped new version leaves the
current one serving. The batch becomes `cancelled` once nothing is left running, and a `wait()` on it then raises
`CANCELLED`. A batch that has already finished is refused with 409 `CONFLICT`.

<!-- example: examples/typescript/ingestion.ts#cancel-batch -->
```ts tab="TypeScript"
// Without stopRunning, items already being ingested finish; with it, they stop too
await kb.ingestion.batches(batchId).cancel({ stopRunning: true });
```
<!-- example: examples/python/ingestion.py#cancel-batch -->
```python tab="Python"
# Without stop_running, items already being ingested finish; with it, they stop too.
kb.ingestion.batches(batch_id).cancel(stop_running=True)
```
<!-- example: examples/go/ingestion/ingestion.go#cancel-batch -->
```go tab="Go"
// Without StopRunning, items already being ingested finish; with it, they stop too
_, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID).Cancel(ctx, &caitlyn.CancelIngestionBatchInput{StopRunning: caitlyn.Ptr(true)})
```
<!-- example: examples/rust/src/ingestion.rs#cancel-batch -->
```rust tab="Rust"
// Without stop_running, items already being ingested finish; with it, they stop too.
let batch = client
    .knowledge_base(knowledge_base_id)
    .ingestion()
    .batch(batch_id);
batch.cancel().stop_running(true).await?;
```

## Errors and retries

- **One item, not the batch.** A file whose upload still fails after its retries fails its own item, with
  `UPLOAD_FAILED`, and the other uploads carry on. `sync` reports it through `onItem` and in the report, and never
  raises it.
- **What stops a sync.** `sync` raises only when you cancel it, or when the whole batch stops: it could not be
  created, planned or started, or its upload policy could not be renewed. A plan that fails the batch raises the
  batch's own failure (`conflict_policy_fail` or `planning_failed`). An item the policy left unresolved, with no
  resolver, raises `INGESTION_BATCH_UNRESOLVED` and leaves the batch planned for you to finish.
- **Time limits.** No wait has a time limit unless you give one. One that runs out raises the code `WAIT_TIMEOUT`
  with status 0, as your language's own timeout: a `TimeoutError` in TypeScript and Python, an `*Error` for which
  `errors.Is(err, context.DeadlineExceeded)` holds in Go, and `Error::Timeout` in Rust. The batch carries on; wait
  again to pick it up.
- **Gone.** A thing that is gone ends its wait: after you deleted it, as success; otherwise with `NOT_FOUND`. A watch
  whose reconnection finds the thing gone ends at once.
- **Failed or cancelled work.** A wait on work that failed raises the typed error for its code; on work that was
  cancelled, `CANCELLED`.

The SDK retries for you: calls that are safe to repeat, on the statuses and with the delays [Retries](/retries/)
describes; each upload, which is safe to send twice because its bytes are bound to their checksum; a file whose
checksum did not match once it arrived, which is sent once more; the batch's upload policy, renewed when less than 5
minutes of it are left (on a timer while any upload is in flight, so the batch keeps waiting for a large file still on
its way), and once more when storage says it has expired; and the watch, reconnected whenever it drops.
[Errors](/errors/) lists the error types and codes.

## What it costs

See what an ingestion will cost before you start. `kb.ingestion.sync.estimate` takes the same
arguments as `sync` and runs it as far as the plan: it hashes the files, plans the batch and prices the items that
need their bytes, and uploads nothing ([Estimate a sync](/reference/helpers/ingestion-sync-estimate/)). Because it
plans a real batch, it reads every file through to hash it, as a sync does, so on a large folder it takes about as long
as a sync's first step; pricing one file with `kb.documents.create.estimate(file)` reads only its name, type and size. It prices every
item that could need its bytes, items still `unresolved` included, so its estimate is the most the batch could cost. The batch it
planned is left planned: its plan goes stale after 5 minutes, and starting the batch plans it again; a batch never
started is cleared after 7 days. `confirm` sees the same estimate inside a sync, so one call can ask and go on.

<!-- example: examples/typescript/jobs.ts#sync-estimate -->
```ts tab="TypeScript"
const plan = await kb.ingestion.sync.estimate('./policies', { folder: '/policies/', removeMissing: true });
console.log(`${plan.items.length} items; ${plan.estimate?.documents ?? 0} to upload, about ${plan.estimate?.durationSeconds.high ?? 0} s`);
```
<!-- example: examples/python/jobs.py#sync-estimate -->
```python tab="Python"
# What the same sync would do and cost, before anything is uploaded.
plan = kb.ingestion.sync.estimate("./policies", folder="/policies/", remove_missing=True)
if plan.estimate is not None:
    print(plan.estimate.documents, "documents,", plan.estimate.duration_seconds.high, "seconds at most")
    if cost := plan.estimate.cost:  # only for callers allowed to see cost, in the form the organisation sees it
        print(f"US${cost.low:.2f}–{cost.high:.2f}" if cost.unit == "usd" else f"{cost.low:.1f}–{cost.high:.1f}% of usage")
```
<!-- example: examples/go/documents/documents.go#sync-estimate -->
```go tab="Go"
plan, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.EstimateSync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
	Folder:        "/policies/",
	RemoveMissing: true,
})
if err != nil {
	return nil, err
}
for _, item := range plan.Items {
	fmt.Println(*item.Path, *item.Outcome) // new, changed, unchanged, moved, to_remove…
}
if e := plan.Estimate; e != nil && e.Cost != nil { // cost only for callers who may see it
	switch e.Cost.Unit { // the form the organisation sees its costs in
	case caitlyn.CostUnitUsd:
		fmt.Printf("%d documents, US$%.2f–%.2f\n", e.Documents, e.Cost.Low, e.Cost.High)
	case caitlyn.CostUnitPercentOfPlan:
		fmt.Printf("%d documents, %.1f–%.1f%% of usage\n", e.Documents, e.Cost.Low, e.Cost.High)
	default:
		fmt.Printf("%d documents, %.2f–%.2f %s\n", e.Documents, e.Cost.Low, e.Cost.High, e.Cost.Unit)
	}
}
```
<!-- example: examples/rust/src/documents.rs#sync-estimate -->
```rust tab="Rust"
let kb = client.knowledge_base(knowledge_base_id);
let plan = kb
    .ingestion()
    .estimate_sync(
        SyncInput::dir(dir)
            .folder("/policies/")
            .remove_missing(true),
    )
    .await?;
println!("{} items", plan.items.len());
if let Some(estimate) = &plan.estimate {
    let time = &estimate.duration_seconds;
    println!(
        "{} documents, {:.0}-{:.0} s",
        estimate.documents, time.low, time.high
    );
    if let Some(cost) = &estimate.cost {
        // only for callers who may see cost
        match &cost.unit {
            // the form the organisation sees its costs in
            CostUnit::Usd => println!("US${:.2}-{:.2}", cost.low, cost.high),
            CostUnit::PercentOfPlan => println!("{:.1}-{:.1}% of usage", cost.low, cost.high),
            other => println!("{}-{} {}", cost.low, cost.high, other),
        }
    }
}
```

An estimate gives the documents to process, their pages and seconds of audio and video where known, how many could
not be measured (priced as a typical file), and how long the work takes, as a range of seconds. Its `cost` is there
only for callers who may open the knowledge base's settings, in the form your organisation sees its costs: US
dollars (`usd`), or a percentage of its monthly usage allowance (`percent_of_plan`). Its `unit` says which. For a single file, `kb.documents.create.estimate(file)` sends the
file's description, never its bytes ([EstimateIngestion](/reference/estimate-ingestion/)). While the work runs, a job's
`costSoFar` says what it has cost so far, in the same form. Other work on a knowledge base has a cost too, and an
estimate of its own: [filling in fields](/reference/fill-in-fields/), [reprocessing documents](/reference/reprocess-documents/) and
[layout-aware search](/reference/enable-layout-aware-search/).

## Under the hood

`kb.ingestion.sync` is built from the batch operations, and you can call each of them yourself:

1. [CreateIngestionBatch](/reference/create-ingestion-batch/) with `start: 'manual'` and the first 10,000 items, then
   `core.ingestion.addItems` ([BatchCreateIngestionBatchItems](/reference/batch-create-ingestion-batch-items/)) for
   the rest, the last call with `last: true`.
2. `batch.planned()`, which follows the knowledge base's watch, then
   [EstimateIngestion](/reference/estimate-ingestion/) for the items that need their bytes.
3. `confirm`, and the resolver for each `unresolved` item.
4. [StartIngestionBatch](/reference/start-ingestion-batch/), guarded by the plan's ETag, which returns the upload policy.
5. The uploads, reported with [CompleteIngestionBatchUploads](/reference/complete-ingestion-batch-uploads/)
   ([How a sync uploads](/guides/load-documents/#how-a-sync-uploads) has the details).
6. `batch.wait()`, then [ListIngestionBatchItems](/reference/list-ingestion-batch-items/) for the report.

### More items than one call takes

A batch created with `awaitMoreItems` stays a draft and takes more items through `core.ingestion.addItems`, up to
10,000 a call. Each item gets its own result, `created` or `failed` with a code, so one bad item never refuses the
rest. The call with `last: true` ends the draft, and planning starts. A batch takes at most 100,000 items, and at most
1,000 of them with a `fetchUrl`.

<!-- example: examples/typescript/ingestion.ts#add-batch-items -->
```ts tab="TypeScript"
const batch = await kb.ingestion.batches.create({ start: 'manual', awaitMoreItems: true, items: first });
// `last: true` ends the draft, and planning starts
const { results } = await caitlyn.core.ingestion.addItems(kbId, batch.ingestionBatchId, rest, { last: true });
for (const r of results) if (r.status === 'failed') console.log(`item ${r.index}: ${r.code}`);
```
<!-- example: examples/python/ingestion.py#add-batch-items -->
```python tab="Python"
# The batch stays a draft while it takes more items; last=True ends the draft, and planning starts.
batch = caitlyn.knowledge_bases(kb_id).ingestion.batches.create(start="manual", await_more_items=True, items=first)
added = caitlyn.core.ingestion.add_items(kb_id, batch.id, rest, last=True)
for result in added.results:
    if result.status == "failed":
        print("item", result.index, result.code)
```
<!-- example: examples/go/ingestion/ingestion.go#add-batch-items -->
```go tab="Go"
batch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batches.Create(ctx, &caitlyn.CreateIngestionBatchInput{
	Start:          caitlyn.Ptr(caitlyn.StartModeManual),
	AwaitMoreItems: caitlyn.Ptr(true),
	Items:          first,
})
if err != nil {
	return err
}
// Last ends the draft, and planning starts
added, err := client.Core.Ingestion.AddItems(ctx, knowledgeBaseID, batch.ID(), &caitlyn.BatchCreateIngestionBatchItemsInput{
	Items: rest,
	Last:  caitlyn.Ptr(true),
})
if err != nil {
	return err
}
for _, r := range added.Results {
	if r.Status == caitlyn.ItemCreateStatusFailed {
		fmt.Println("item", r.Index, *r.Code)
	}
}
```
<!-- example: examples/rust/src/ingestion.rs#add-batch-items -->
```rust tab="Rust"
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
```
