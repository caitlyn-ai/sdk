---
pageType: guide
sinceVersion: 5000115000000
resources:
  - document
  - knowledge-base
  - upload
integrations: []
operations:
  - CreateDocument
  - CreateDocumentVersion
  - GetDocument
  - GetDocumentVersion
  - ListDocuments
  - DeleteDocument
  - BatchDeleteDocuments
  - CreateIngestionBatch
  - StartIngestionBatch
  - CompleteIngestionBatchUploads
  - CreateIngestionBatchUploadPolicy
  - BatchCreateIngestionBatchItems
  - GetIngestionBatch
  - CreateUpload
  - GetUpload
  - PutAccess
  - GetAccess
---

# Load documents

Put files into a knowledge base, keep them up to date, and remove them. Give the SDK a file and it does the rest:
it hashes the file, uploads it straight to storage, creates the document and, if you ask, waits until the document
is indexed. An agent that uses the knowledge base can cite a document once it is indexed. For a whole folder, one
call keeps the knowledge base in step with it.

In short: add a document and wait until it can be searched, or keep a folder of the knowledge base in step with a
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

## Add a document from a file

[CreateDocument](/reference/create-document/) adds a file to a knowledge base, in the folder you name, and starts
indexing it. Pass the file itself: a path, bytes, a stream or, in a browser, a `File` or `Blob`. The SDK works
out its SHA-256 before anything is sent, uploads the bytes to storage (no Caitlyn credentials go with them), then
creates the document. It returns the new document and the operation that indexes it. A folder is a path from the
knowledge base's root that starts and ends in `/`, such as `/policies/`.

<!-- example: examples/typescript/documents.ts#add-document-from-file -->
```ts tab="TypeScript"
// `file` is a path, a File or Blob, or an UploadFile (fromPath, fromBytes, fromStream). The SDK hashes it,
// uploads it and then creates the document. A folder is a path from the root that starts and ends in /.
const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents.create(file, { folder: '/policies/' });
console.log(`${document.name} is ${document.status}; operation ${document.operation.id}`);
```
<!-- example: examples/python/documents.py#add-document-from-file -->
```python tab="Python"
# The SDK hashes the file, uploads it, then creates the document. A folder path starts and ends in /:
# "/policies/", or "/" for the knowledge base's top level. Ingestion carries on after the response: the result is
# the new document's scope, with the response's fields, and .wait() waits for it.
created = kb.documents.create(path, folder="/policies/")
print(created.id, created.document.status, created.operation.id)
```
<!-- example: examples/go/documents/documents.go#add-document-from-file -->
```go tab="Go"
// PDF, Word (.docx), Markdown, images, audio or video; the content type comes from the extension. The SDK hashes
// the file and uploads it straight to storage (no Caitlyn credentials go with the bytes), then creates the
// document from the upload.
created, err := client.KnowledgeBase(knowledgeBaseID).Documents.Create(ctx, caitlyn.Path(path), &caitlyn.CreateDocumentInput{
	Folder: "/policies/", // from the root, starting and ending in /
	// Name defaults to the file's name
})
if err != nil {
	return nil, err
}
// Indexing carries on after the call returns: created.Wait(ctx) waits for it
fmt.Println(created.ID(), created.Result.Document.Status, created.Result.Operation.ID)
```
<!-- example: examples/rust/src/documents.rs#add-document-from-file -->
```rust tab="Rust"
// The file is uploaded first: a path, UploadFile or a name with bytes. A file over 2 GB fails with FILE_TOO_LARGE.
let created = kb
    .documents()
    .create(path)
    .folder("/policies/")
    .send()
    .await?;
// The new document's scope, with the response as `output`; its processing runs in the background.
println!("{} {}", created.id(), created.result().document.status);
```

A file can be at most 2 GB; a larger one fails with `FILE_TOO_LARGE` before anything is sent. If a file on disk
changes between being hashed and being sent, the call fails with `FILE_CHANGED`. The content type comes from the
file name's extension unless you give one.

### From a stream

A stream that can only be read once, such as a download, works too. The SDK copies it while it hashes it, in
memory up to 8 MiB and past that into a temporary file only you can read, which it deletes when the call ends.

<!-- example: examples/typescript/documents.ts#add-document-from-stream -->
```ts tab="TypeScript"
const res = await fetch(url);
// A stream is read once: the SDK copies it as it hashes it (to memory up to 8 MiB, then to a temporary file
// only you can read, removed when the call ends)
const file = UploadFile.fromStream(res.body!, { name: 'q3-report.pdf' });
const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents.create(file, { folder: '/finance/' });
```
<!-- example: examples/python/documents.py#add-document-from-stream -->
```python tab="Python"
# A stream is read once: the SDK copies it while hashing (in memory up to 8 MiB, then a temporary file only you
# can read, deleted when the call ends). Give it a name, which sets the content type (.pdf: application/pdf).
with httpx.stream("GET", url) as response:
    file = UploadFile.from_stream(response.iter_bytes(), name="q3-report.pdf")
    created = kb.documents.create(file, folder="/finance/")
```
<!-- example: examples/go/documents/documents.go#add-document-from-stream -->
```go tab="Go"
req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
if err != nil {
	return nil, err
}
res, err := http.DefaultClient.Do(req)
if err != nil {
	return nil, err
}
defer res.Body.Close()
// The stream is read once: kept in memory up to 8 MiB and past that in a temporary file only you can read,
// removed when the call returns
file := caitlyn.FileFromReader("q3-report.pdf", res.Body, caitlyn.WithSize(res.ContentLength))
created, err := client.KnowledgeBase(knowledgeBaseID).Documents.Create(ctx, file, &caitlyn.CreateDocumentInput{Folder: "/finance/"})
if err != nil {
	return nil, err
}
fmt.Println(created.ID(), created.Result.Document.Status)
```
<!-- example: examples/rust/src/documents.rs#add-document-from-stream -->
```rust tab="Rust"
use futures_util::TryStreamExt;
let body = caitlyn_sdk_core::reqwest::get(url)
    .await?
    .error_for_status()?
    .bytes_stream()
    .map_err(std::io::Error::other);
// The SDK copies the stream while it hashes it: in memory up to 8 MiB, then in a temporary file only you can read,
// deleted when the call ends.
let file = UploadFile::from_reader("q3-report.pdf", tokio_util::io::StreamReader::new(body));
let created = client
    .knowledge_base(knowledge_base_id)
    .documents()
    .create(file)
    .folder("/finance/")
    .await?;
println!("{} {}", created.id(), created.result().document.status);
```

## Wait until it is indexed

[GetDocument](/reference/get-document/) reads the document's status. A document that is partially indexed can
be cited, and its `partialFailures` say what was left out, such as a picture description or a table. They
never fail the document. A document that could not be indexed is `failed`, and its `failure` says why: a code
(`file_unreadable`, `processing_interrupted` or `processing_failed`, and more may be added) and a message that
says what to do.

<!-- example: examples/typescript/documents.ts#get-document -->
```ts tab="TypeScript"
const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).get();
console.log(document.name, document.status, document.version, document.partialFailures?.length ?? 0);
// A failed document says why: a code such as file_unreadable, and a message saying what to do
if (document.failure) console.log(document.failure.code, document.failure.message);
```
<!-- example: examples/python/documents.py#get-document -->
```python tab="Python"
doc = kb.documents(document_id).get()
print(doc.name, doc.status, doc.processing.percent if doc.processing else 100)
if doc.failure:  # only on a failed document: a code such as file_unreadable, and what to do about it
    print(doc.failure.code, doc.failure.message)
```
<!-- example: examples/go/documents/documents.go#get-document -->
```go tab="Go"
document, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Get(ctx)
if err != nil {
	return nil, err
}
fmt.Println(document.Name, document.Status)
for _, f := range document.PartialFailures { // parts that could not be indexed, when it is partially_indexed
	fmt.Println(f.Code)
}
if document.Failure != nil { // only when it is failed: a code such as file_unreadable, and what to do
	fmt.Println(document.Failure.Code, document.Failure.Message)
}
```
<!-- example: examples/rust/src/documents.rs#get-document -->
```rust tab="Rust"
let document = kb.document(&document_id).get().await?;
println!(
    "{} {} in {}",
    document.name, document.status, document.folder
);
```

Rather than reading the document in a loop, wait for it. `wait()` follows the document's watch until nothing is
running on it, then returns the document as `get()` does. A document that fails to index ends the wait with its
error, and one deleted while you wait ends it with `NOT_FOUND`; one indexed with partial failures returns them on
the document. There is no time limit unless you set one, and a wait that runs out of time raises `WAIT_TIMEOUT`.

<!-- example: examples/typescript/documents.ts#wait-for-processing -->
```ts tab="TypeScript"
// Follows the document through the knowledge base's watch until no job on it is running: a failed job throws its
// error, and one with partial failures returns them on the document. `timeoutMs` sets a limit; there is none by default
const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).wait();
console.log(`${document.name} is ${document.status}`);
```
<!-- example: examples/python/documents.py#wait-for-processing -->
```python tab="Python"
# Returns the document once nothing runs on it, from its identifier alone (after a page reload, say). A
# failed ingestion raises its error; some enrichments not completing does not.
doc = kb.documents(document_id).wait(timeout=3600)
for failure in doc.partial_failures or []:  # partially_indexed: some enrichments did not complete
    print("skipped:", failure.code, failure.detail)
```
<!-- example: examples/go/documents/documents.go#wait-for-processing -->
```go tab="Go"
// Follows the document's watch until nothing is running on it, then reads it. A failed ingestion is its typed
// error; WithTimeLimit bounds the wait (an *Error with the code WAIT_TIMEOUT), and there is no default.
document, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Wait(ctx, caitlyn.WithTimeLimit(20*time.Minute))
if err != nil {
	return nil, err
}
fmt.Println(document.Name, document.Status)
```
<!-- example: examples/rust/src/documents.rs#wait-for-processing -->
```rust tab="Rust"
// Follows the document through the knowledge base's watch until nothing runs on it, then reads it as get does.
let indexed = kb.document(&document_id).wait().await?;
println!("{} {:?}", indexed.status, indexed.partial_failures);
```

## Replace a document with a new version

[CreateDocumentVersion](/reference/create-document-version/) adds a new version of a document: the document keeps
its ID, its history and its place, and its current version keeps answering questions until the new one is
indexed. In the SDKs it is the document's `replace` with a file (`Replace` in Go), and its `wait()` returns
once the new version is indexed. The document's ETag (`ifMatch`) is optional; with it, a document changed since you
read it is refused ([conditional writes](/errors/#conditional-writes-etags-and-if-match)). Bytes the same as the current version's make no new version: the result says `unchanged`.

<!-- example: examples/typescript/documents.ts#replace-document -->
```ts tab="TypeScript"
// The new bytes become the document's next version; the current one keeps serving search until it is indexed.
// The same bytes as the current version make no new version (result: 'unchanged'); another file type is refused,
// because that is a new document. wait() returns the document once the new version is searchable.
const doc = caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId);
const replaced = doc.replace(file, { note: 'The 2027 edition' });
const { result, version } = await replaced;
const indexed = await replaced.wait();
console.log(`${result}: version ${version.number}; the document is ${indexed.status} at version ${indexed.version}`);
```
<!-- example: examples/python/documents.py#replace-document -->
```python tab="Python"
# A new version of the same document: it keeps its id and history, and the current version keeps answering until
# the new one is indexed. .wait() returns the document once it is.
replaced = kb.documents(document_id).replace(path, note="The 2027 edition")
print(replaced.result.result)  # created, unchanged (the same bytes as now) or restored (an earlier version's bytes)
doc = replaced.wait()
print(doc.version, doc.status)
```
<!-- example: examples/go/documents/documents.go#replace-document -->
```go tab="Go"
replaced, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Replace(ctx, caitlyn.Path(path), nil)
if err != nil {
	return nil, err // a *caitlyn.ConflictError while an earlier version is still processing
}
// The current version keeps answering until the new one is indexed
indexed, err := replaced.Wait(ctx)
if err != nil {
	return nil, err
}
fmt.Println(replaced.Result.Result, indexed.Status) // created, unchanged or restored
```
<!-- example: examples/rust/src/documents.rs#replace-document -->
```rust tab="Rust"
let doc = client
    .knowledge_base(knowledge_base_id)
    .document(document_id);
// The current version keeps answering until the new one is indexed.
let replaced = doc.replace(path).note("The 2027 policy").send().await?;
println!("{:?} version {}", replaced.result, replaced.version.number);
let doc = replaced.wait().await?;
println!("{} version {:?}", doc.status, doc.version);
```

A document's name, folder and metadata change with the document's `update`
([UpdateDocument](/reference/update-document/)). While an earlier version is still being processed, a new one is
refused with 409 `DOCUMENT_INGESTION_IN_PROGRESS` and a `Retry-After`: wait for it first.

## Keep a folder in step

`kb.ingestion.sync` keeps a knowledge base in step with a folder of files, or with a list of items, through
one [ingestion batch](/reference/create-ingestion-batch/). It hashes every file, asks Caitlyn what each one
means for the knowledge base (new, changed, unchanged or moved), uploads only the files that need their bytes, and
waits until they are indexed. Files that have not changed are not sent again.

<!-- example: examples/typescript/documents.ts#sync-folder-with-policy -->
```ts tab="TypeScript"
// Hashes every file, plans the batch (what is new, changed, unchanged or to remove), uploads only what needs
// bytes, six at a time, and waits until every item has finished. Each file's relative path is its external ID,
// so a renamed file keeps its document
const report = await caitlyn.knowledgeBases(knowledgeBaseId).ingestion.sync(dir, {
  folder: '/policies/',
  externalId: (f) => f.relativePath,
  removeMissing: true,
  policy: { onConflict: { default: 'skip' } },
  onProgress: (p) => console.log(p.phase, `${p.done}/${p.total}`),
});
for (const item of report.items) console.log(item.path, item.outcome, item.status, item.failureCode ?? '');
```
<!-- example: examples/python/documents.py#sync-folder-with-policy -->
```python tab="Python"
# Keeps the knowledge base's /policies/ folder in step with a local folder, through one ingestion batch: new
# files are added, changed ones get a new version, and with remove_missing documents whose file is gone are
# removed. .caitlynignore files and exclude= leave files out; at most 6 upload at once. A file keeps its document
# by its path in the folder; key= gives another key.
def progress(p: IngestionProgress[IngestionBatchItem]) -> None:
    print(p.phase, f"{p.done}/{p.total}")

report = kb.ingestion.sync(
    folder,
    folder="/policies/",
    exclude=["*.tmp"],
    remove_missing=True,
    policy=IngestionPolicy.model_validate({"onConflict": {"default": "new_version"}, "onRemove": "remove"}),
    confirm=lambda plan: plan.estimate is None or plan.estimate.documents < 1000,  # before anything is uploaded
    on_progress=progress,
)
print(report.batch.status, report.batch.counts)
for item in report.items:
    print(item.path, item.outcome, item.resolution, item.status, item.document_id, item.failure_code or "")
```
<!-- example: examples/go/documents/documents.go#sync-folder-with-policy -->
```go tab="Go"
report, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
	Folder:        "/policies/", // where the files go; symbolic links are not followed, a .caitlynignore leaves files out
	Exclude:       []string{"drafts/"},
	RemoveMissing: true, // documents under /policies/ with no file are removed
	Policy: &caitlyn.IngestionPolicy{
		OnConflict: &caitlyn.ConflictRules{Default: caitlyn.Ptr(caitlyn.ConflictRuleNewVersion)},
	},
	// Anything the policy leaves unresolved is asked about here; without Resolve, Sync stops with
	// INGESTION_BATCH_UNRESOLVED and leaves the batch planned
	Resolve: func(_ context.Context, item caitlyn.IngestionBatchItem) (caitlyn.IngestionItemResolution, error) {
		return caitlyn.IngestionItemResolutionSkip, nil
	},
	OnProgress: func(p caitlyn.IngestionProgress) { fmt.Println(p.Phase, p.Done, "of", p.Total) },
})
if err != nil {
	return nil, err
}
fmt.Println(report.Batch.Status)
for _, item := range report.Items {
	fmt.Println(*item.Path, item.Status, item.FailureCode)
}
```
<!-- example: examples/rust/src/documents.rs#sync-folder-with-policy -->
```rust tab="Rust"
let kb = client.knowledge_base(knowledge_base_id);
let report = kb
    .ingestion()
    .sync(
        SyncInput::dir(dir)
            .folder("/policies/")
            .remove_missing(true),
    )
    .await?;
println!(
    "{} items, the batch {}",
    report.items.len(),
    report.batch.status
);
```

- **What it sends.** Each file the plan needs goes straight to storage, six at a time unless you set another
  number ([Under the hood](#under-the-hood) says how). Symbolic links are not followed, and `include`, `exclude`
  and a `.caitlynignore` file choose the files.
- **Clashes.** A file can clash with what is there, such as one whose bytes match a document in another
  folder. The policy you give settles each kind of clash (`add`, `new_version`, `overwrite` and the others the
  reference lists). Anything the policy leaves open goes to your resolver; with none, the call fails with
  `INGESTION_BATCH_UNRESOLVED` and leaves the batch planned, for you to finish.
- **Removing.** With `removeMissing`, documents under the folder that have no file any more are deleted.
- **Progress.** `onProgress` reports each phase in order: `checksum`, `planning`, `planned`, `upload` (with
  the bytes sent), `queued`, `processing`, then the final state. `onItem` is called with each item as it
  finishes.
- **The report.** It lists every item with its outcome, how it was resolved, its status, its document and
  version, and its failure, if any, with the batch's counts. A file whose upload still fails after retries fails
  on its own, with `UPLOAD_FAILED`, and the others carry on. The call itself fails only for something that
  stops the whole batch: the batch could not be created, planned or started, or its uploads could no longer be
  sent.
- **Cancelling.** Cancelling the call stops new uploads, aborts those in flight and raises your language's
  cancellation error; every item that finished before then has already reached `onItem`. Ingestion already
  running carries on, unless you ask for it to stop too (`cancelIngestion`).

## List the documents

[ListDocuments](/reference/list-documents/) lists a knowledge base's documents, a page at a time. The SDK
fetches the next page as you iterate; see [Pagination](/pagination/).

<!-- example: examples/typescript/documents.ts#list-documents -->
```ts tab="TypeScript"
for await (const document of caitlyn.knowledgeBases(knowledgeBaseId).documents.list()) {
  console.log(document.folder, document.name, document.status);
  ids.push(document.id);
}
```
<!-- example: examples/python/documents.py#list-documents -->
```python tab="Python"
# Iterating fetches each page as it is needed.
for doc in kb.documents.list(folder="/policies/", status="indexed"):
    names.append(doc.name)
```
<!-- example: examples/go/documents/documents.go#list-documents -->
```go tab="Go"
// Every document in the folder, newest first: the next page is fetched as the loop reaches it
var documents []caitlyn.Document
input := &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Sort: caitlyn.Ptr("-updatedAt")}
for document, err := range client.KnowledgeBase(knowledgeBaseID).Documents.List(ctx, input) {
	if err != nil {
		return nil, err
	}
	fmt.Println(document.Name, document.Status)
	documents = append(documents, document)
}
```
<!-- example: examples/rust/src/documents.rs#list-documents -->
```rust tab="Rust"
let kb = client.knowledge_base(knowledge_base_id);
let mut documents = kb.documents().list().folder("/hr/").deep(true).items();
let mut n = 0;
while let Some(document) = documents.next().await {
    let document = document?;
    println!("{} {}", document.name, document.status);
    n += 1;
}
```

## Delete documents

[DeleteDocument](/reference/delete-document/) deletes one document. The delete is accepted at once: the
document reads as `deleting` while it is removed from search, and once it is gone, reading it returns 404.
Deleting it again while it is still `deleting` is accepted again. A document that is still being processed
(`pending` or `processing`) can be deleted too: its processing stops, and it never comes back.

<!-- example: examples/typescript/documents.ts#delete-document -->
```ts tab="TypeScript"
// Accepted at once (202), even while the document is still being processed, whose processing stops: it reads as
// deleting until it is gone, then 404s. delete().wait() waits until it is gone
const deleted = await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).delete();
console.log(`deleting; its ETag is ${deleted.etag}`);
```
<!-- example: examples/python/documents.py#delete-document -->
```python tab="Python"
# The delete is accepted at once, even while the document is still being processed (its processing stops); the
# document and its search entries go shortly after.
kb.documents(document_id).delete()
```
<!-- example: examples/go/documents/documents.go#delete-document -->
```go tab="Go"
deleted, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Delete(ctx)
if err != nil {
	return nil, err
}
fmt.Println(deleted.Result.Name, deleted.Result.Status) // deleting, until it is gone
```
<!-- example: examples/rust/src/documents.rs#delete-document -->
```rust tab="Rust"
// Accepted at once, also while the document is still being processed: its processing stops. It reads as
// deleting until it is gone, then 404s.
let deleting = kb.document(&document_id).delete().send().await?;
println!("{} is {}", deleting.id, deleting.status);
```

[BatchDeleteDocuments](/reference/batch-delete-documents/) deletes up to 100 documents in one call. It returns
one result per identifier, in the order you sent them: `accepted`, or `failed` with a code, such as
`NOT_FOUND` for a document that is already gone. One document that cannot be deleted does not stop the others,
so check each result. Sending no identifiers, more than 100, or the same one twice is refused as a whole.

<!-- example: examples/typescript/documents.ts#batch-delete-documents -->
```ts tab="TypeScript"
// 1 to 100 distinct IDs; one that cannot be deleted (NOT_FOUND)
// fails on its own, and the rest still go
const { results } = await caitlyn.knowledgeBases(knowledgeBaseId).documents.deleteMany(documentIds);
for (const result of results) {
  if (result.status === 'accepted') console.log(`${result.documentId} is being deleted`);
  else console.log(`${result.documentId} was not deleted: ${result.code}`);
}
```
<!-- example: examples/python/documents.py#batch-delete-documents -->
```python tab="Python"
# Up to 100 documents in one call, whether or not they are still being processed. One that cannot be deleted
# (NOT_FOUND) does not stop the others: each identifier gets its own result, in the order you sent them.
batch = kb.documents.delete_many(document_ids)
for result in batch.results:
    if result.status == "accepted":
        print(result.document_id, "is being deleted")
    else:
        print(result.document_id, "was not deleted:", result.code, result.detail)
```
<!-- example: examples/go/documents/documents.go#batch-delete-documents -->
```go tab="Go"
// From 1 to 100 identifiers, each at most once. One that cannot be deleted (NOT_FOUND, say) does not stop the
// others; one still being processed is deleted too, its processing stopped.
batch, err := client.KnowledgeBase(knowledgeBaseID).Documents.DeleteMany(ctx, &caitlyn.BatchDeleteDocumentsInput{DocumentIDs: documentIDs})
if err != nil {
	return nil, err
}
for _, r := range batch.Results { // in the order you sent them
	switch r.Status {
	case caitlyn.DocumentDeleteStatusAccepted:
		fmt.Println(r.DocumentID, "is being deleted")
	case caitlyn.DocumentDeleteStatusFailed:
		fmt.Println(r.DocumentID, "was not deleted:", *r.Code) // NOT_FOUND, for example
	}
}
```
<!-- example: examples/rust/src/documents.rs#batch-delete-documents -->
```rust tab="Rust"
// 1 to 100 distinct IDs; one that cannot be deleted (NOT_FOUND, say) fails on its own, and the rest still go.
let deleted = client
    .knowledge_base(knowledge_base_id)
    .documents()
    .delete_many(document_ids)
    .await?;
for result in &deleted.results {
    println!(
        "{} {:?} {:?}",
        result.document_id, result.status, result.code
    );
}
```

To know when a document is gone, wait for it. `wait()` on the delete follows the document's watch until the
document is gone, and returns nothing. If the document was still being processed, its processing stopping is part
of the delete, not a failure. As with any wait, there is no time limit unless you set one.

<!-- example: examples/typescript/documents.ts#wait-for-delete -->
```ts tab="TypeScript"
// delete() returns something to wait on: it ends when the document is gone, and returns nothing
await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).delete().wait();
console.log(`${documentId} is gone`);
```
<!-- example: examples/python/documents.py#wait-for-delete -->
```python tab="Python"
# Returns once the document is gone (reading it is a 404). timeout= (seconds) raises TimeoutError if it takes longer.
kb.documents(document_id).delete().wait(timeout=900)
```
<!-- example: examples/go/documents/documents.go#wait-for-delete -->
```go tab="Go"
// nil once the document is gone; a document still being processed when it was deleted has its processing
// stopped, which is part of the delete
if err := deleted.Wait(ctx); err != nil {
	return err
}
```
<!-- example: examples/rust/src/documents.rs#wait-for-delete -->
```rust tab="Rust"
// Waits until the document is gone; `kb.document(id).delete().wait()` does both in one call.
deleting.wait().await?;
```

## Choose who can read

Who may use a knowledge base is its role grants; who may read a folder's or a document's contents is its readers.
`access.set` sets either, on the knowledge base, a folder or a document, and `access.get` reads them back as they
were set.

<!-- example: examples/typescript/jobs.ts#set-access -->
```ts tab="TypeScript"
await kb.folders('/hr/investigations/').access.set({ readers: { roles: ['hr-team'] } });
await kb.documents(documentId).access.set({ readers: 'inherit' });
```
<!-- example: examples/python/jobs.py#set-access -->
```python tab="Python"
# Only the HR team may read what is in /hr/investigations/; the document follows its folder again.
kb.folders("/hr/investigations/").access.set(readers={"roles": ["hr-team"]})
kb.documents(document_id).access.set(readers="inherit")
```
<!-- example: examples/go/documents/documents.go#set-access -->
```go tab="Go"
kb := client.KnowledgeBase(knowledgeBaseID)
// ReadersOf(roles, people), ReadersEveryone, ReadersPublic or ReadersInherit
if _, err := kb.Folder("/hr/investigations/").Access.Set(ctx, &caitlyn.PutAccessInput{
	Readers: caitlyn.ReadersOf([]string{"hr-team"}, nil),
}); err != nil {
	return err
}
// A guarded write: with the ETag you read, a change someone made since is refused (*caitlyn.PreconditionFailedError)
if _, err := kb.Document(documentID).Access.Set(ctx, &caitlyn.PutAccessInput{Readers: caitlyn.ReadersInherit()},
	caitlyn.WithIfMatch(etag)); err != nil {
	return err
}
```
<!-- example: examples/rust/src/documents.rs#set-access -->
```rust tab="Rust"
let kb = client.knowledge_base(knowledge_base_id);
kb.folder("/hr/investigations/")
    .access()
    .set()
    .readers(Readers::roles(["hr-team"]))
    .await?;
kb.document(document_id)
    .access()
    .set()
    .readers("inherit")
    .await?;

// A guarded write: refused with Error::PreconditionFailed (412) if the access changed since it was read.
let current = kb.folder("/hr/").access().get().await?;
kb.folder("/hr/")
    .access()
    .set()
    .readers(Readers::everyone())
    .if_match(&current.etag)
    .await?;
```

A folder's or a document's readers are one of these, widest first:

| Readers | Who may read it | For |
| --- | --- | --- |
| Public | Anyone who can reach the knowledge base, signed in or not: guests and anonymous visitors of a public agent included | Content meant to be shared openly |
| Everyone | Anyone signed in to the workspace who may read the knowledge base, but no guest or anonymous visitor | Content every colleague may see |
| Specific | Only the roles and people you list | Restricted content |
| Inherit | Whoever may read the folder it is in, so a change there applies here too | Following the folder |

Each SDK writes them its own way:

<!-- example: examples/typescript/jobs.ts#readers-values -->
```ts tab="TypeScript"
// The four kinds of readers, widest first
await kb.folders('/handbook/').access.set({ readers: 'public' });
await kb.folders('/staff/').access.set({ readers: 'everyone' });
await kb.folders('/hr/').access.set({ readers: { roles: ['hr-team'], people: ['u-1'] } });
await kb.folders('/hr/handbook/').access.set({ readers: 'inherit' });
```
<!-- example: examples/python/jobs.py#readers-values -->
```python tab="Python"
# The four kinds of readers, widest first
kb.folders("/handbook/").access.set(readers="public")
kb.folders("/staff/").access.set(readers="everyone")
kb.folders("/hr/").access.set(readers={"roles": ["hr-team"], "people": ["u-1"]})
kb.folders("/hr/handbook/").access.set(readers="inherit")
```
<!-- example: examples/go/documents/documents.go#readers-values -->
```go tab="Go"
// The four kinds of readers, widest first
for folder, readers := range map[string]*caitlyn.Readers{
	"/handbook/":    caitlyn.ReadersPublic(),
	"/staff/":       caitlyn.ReadersEveryone(),
	"/hr/":          caitlyn.ReadersOf([]string{"hr-team"}, []string{"u-1"}),
	"/hr/handbook/": caitlyn.ReadersInherit(),
} {
	if _, err := kb.Folder(folder).Access.Set(ctx, &caitlyn.PutAccessInput{Readers: readers}); err != nil {
		return err
	}
}
```
<!-- example: examples/rust/src/documents.rs#readers-values -->
```rust tab="Rust"
// The four kinds of readers, widest first
kb.folder("/handbook/")
    .access()
    .set()
    .readers(Readers::public())
    .await?;
kb.folder("/staff/")
    .access()
    .set()
    .readers(Readers::everyone())
    .await?;
kb.folder("/hr/")
    .access()
    .set()
    .readers(Readers::specific(["hr-team"], ["u-1"]))
    .await?;
kb.folder("/hr/handbook/")
    .access()
    .set()
    .readers(Readers::inherit())
    .await?;
```

The difference between `public` and `everyone` is guests: a public agent's guests and anonymous visitors can read
`public` content, never `everyone` content. The root folder holds the readers every other folder falls back to, so
`inherit` is refused there with 400 `VALIDATION_FAILED`. On a document, `inherit` removes the document's own readers,
which needs the permission to delete readers as well.

A knowledge base's role grants are set on the knowledge base itself, with no folder or document: send `roles`, and
the roles you send become the whole list. A folder or a document takes `readers`, never `roles`. So `roles` sent
with a folder or a document, `readers` sent without one, and a folder and a document together are each refused with
400 `VALIDATION_FAILED`.

`If-Match` is optional: without it the last write wins, which is safe because each write sends the whole list. Give
the ETag you read to have a change someone made since refused with 412
([conditional writes](/errors/#conditional-writes-etags-and-if-match)). The new readers apply to the passages a
folder or a document holds after the call returns; the knowledge base's watch shows that work.

## Under the hood

The calls above upload files for you, and most code never needs more. The pieces they are built from are there to
call yourself, under `core`.

### Uploads

A single file goes up as an upload, which is also there to call yourself:
`core.uploads.send` hashes a file, reserves an upload with [CreateUpload](/reference/create-upload/) and sends
the bytes to the address it returns. Pass the upload's ID wherever an operation takes one.

<!-- example: examples/typescript/documents.ts#send-upload -->
```ts tab="TypeScript"
// Works out the size and SHA-256, reserves the upload, then sends the bytes to the address it gives
const upload = await caitlyn.core.uploads.send(file);
console.log(upload.id, upload.status);
```
<!-- example: examples/python/documents.py#send-upload -->
```python tab="Python"
# The building block under the file calls: hashes the file, reserves an upload, and sends the bytes to its
# presigned URL. Most code never needs it; pass the upload's id where a call takes one (upload_id=…).
upload = caitlyn.core.uploads.send(path)
print(upload.id, upload.status)
```
<!-- example: examples/go/documents/documents.go#send-upload -->
```go tab="Go"
// Reserves an upload, then sends the bytes straight to storage: no Caitlyn credentials go with them.
// nil is the purpose: an upload for a document
upload, err := client.Core.Uploads.Send(ctx, caitlyn.Path(path), nil)
if err != nil {
	return nil, err
}
fmt.Println(upload.ID, upload.ExpiresAt) // use it in place of a file (caitlyn.UploadID) before it expires
```
<!-- example: examples/rust/src/documents.rs#send-upload -->
```rust tab="Rust"
// The content type comes from the extension (application/pdf); UploadFile::content_type sets another.
// The SDK hashes the file as it reads it, reserves the upload, then sends the bytes to its presigned URL.
let upload = client.core().uploads().send(path).await?;
println!(
    "{} {}, until {}",
    upload.id, upload.status, upload.expires_at
);
```

[GetUpload](/reference/get-upload/) reads an upload again: its status, and when its upload address expires. Only
the person or client that reserved the upload can read it.

<!-- example: examples/typescript/documents.ts#get-upload -->
```ts tab="TypeScript"
const upload = await caitlyn.core.uploads(uploadId).get();
console.log(`${upload.id} is ${upload.status}, until ${upload.expiresAt.toISOString()}`);
```
<!-- example: examples/python/documents.py#get-upload -->
```python tab="Python"
upload = caitlyn.core.uploads(upload_id).get()
print(upload.status, "until", upload.expires_at)
```
<!-- example: examples/go/documents/documents.go#get-upload -->
```go tab="Go"
upload, err := client.Core.Upload(uploadID).Get(ctx)
if err != nil {
	return nil, err
}
fmt.Println(upload.Status, upload.ExpiresAt)
```
<!-- example: examples/rust/src/documents.rs#get-upload -->
```rust tab="Rust"
let upload = client.core().upload(upload_id).get().await?;
// received once the bytes are in
println!("{} {}", upload.id, upload.status);
```

### How a sync uploads

`kb.ingestion.sync` sends a batch's files under one upload policy for the whole batch
([CreateIngestionBatchUploadPolicy](/reference/create-ingestion-batch-upload-policy/), `core.ingestion.uploadPolicy`),
which it renews when less than five minutes of it are left. It adds items past the first 10,000 with
`core.ingestion.addItems` ([BatchCreateIngestionBatchItems](/reference/batch-create-ingestion-batch-items/)), and
reports the files it has sent with `core.ingestion.completeUploads`
([CompleteIngestionBatchUploads](/reference/complete-ingestion-batch-uploads/)), at most 100 a call. A file whose
checksum does not match is sent once more. Call these yourself only to build a sync of your own.
