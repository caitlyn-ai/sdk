---
pageType: guide
sinceVersion: 5000115000000
resources:
  - upload
  - document
  - knowledge-base
integrations: []
operations:
  - CreateUpload
  - GetUpload
  - CreateDocument
  - GetDocument
  - ListDocuments
  - DeleteDocument
  - BatchDeleteDocuments
---

# Load documents

Add a file to a knowledge base: upload its bytes, create a document from the upload, wait until the document is
indexed, then list what the knowledge base holds. An agent that uses the knowledge base can cite the document
once it is indexed. When a document is no longer needed, delete it.

> **Not available yet.** The SDKs have the document operations, but Caitlyn workspaces do not serve them yet.
> This page describes how the SDKs call them.

## Upload the file

[CreateUpload](/reference/create-upload/) reserves an upload for one file and returns where to send its bytes.
The SDK works out the file's size and SHA-256, reserves the upload, and sends the bytes for you, so one call
leaves you with an upload ready to use.

<!-- example: examples/typescript/documents.ts#create-upload -->
```ts tab="TypeScript"
// Works out the size and SHA-256, reserves the upload, then sends the bytes to the address it gives
const upload = await caitlyn.uploads.create({ file, fileName });
console.log(upload.id, upload.status);
```
<!-- example: examples/python/documents.py#create-upload -->
```python tab="Python"
# Reserves an upload, then sends the file's bytes to the presigned URL the reservation names.
upload = caitlyn.uploads.create(file=path)
print(upload.id, upload.status)
```
<!-- example: examples/go/documents/documents.go#create-upload -->
```go tab="Go"
// PDF, Word (.docx), Markdown, images, audio or video; the content type comes from the extension
file, err := caitlyn.FileFromPath(path)
if err != nil {
	return nil, err
}
// Reserves an upload, then sends the bytes straight to storage: no Caitlyn credentials go with them
upload, err := client.Uploads.Create(ctx, file)
if err != nil {
	return nil, err
}
fmt.Println(upload.ID, upload.ExpiresAt) // create a document from it before it expires
```
<!-- example: examples/rust/src/documents.rs#create-upload -->
```rust tab="Rust"
// The content type comes from the extension (application/pdf). A knowledge base ingests PDF, Word (.docx),
// Markdown, images, audio and video.
let file = UploadFile::from_path(path)?;
// The SDK computes the SHA-256, reserves the upload, then sends the bytes to its presigned URL.
let upload = client.uploads().create(file).await?;
println!("{} {:?}, until {}", upload.id, upload.status, upload.expires_at);
```

[GetUpload](/reference/get-upload/) reads an upload again: its status, and when its upload address expires.
Use it to check that the bytes arrived before you create the document. Only the person or client that reserved
the upload can read it.

<!-- example: examples/typescript/documents.ts#get-upload -->
```ts tab="TypeScript"
const upload = await caitlyn.uploads.get({ uploadId });
console.log(`${upload.id} is ${upload.status}, until ${upload.expiresAt.toISOString()}`);
```
<!-- example: examples/python/documents.py#get-upload -->
```python tab="Python"
upload = caitlyn.uploads.get(upload_id=upload_id)
print(upload.status, "until", upload.expires_at)
```
<!-- example: examples/go/documents/documents.go#get-upload -->
```go tab="Go"
upload, err := client.Uploads.Get(ctx, &caitlyn.GetUploadInput{UploadID: uploadID})
if err != nil {
	return nil, err
}
fmt.Println(upload.Status, upload.ExpiresAt)
```
<!-- example: examples/rust/src/documents.rs#get-upload -->
```rust tab="Rust"
let upload = client
    .uploads()
    .get(GetUploadInput {
        upload_id: upload_id.into(),
    })
    .await?;
println!("{} {:?}", upload.id, upload.status); // received once the bytes are in
```

## Create a document

[CreateDocument](/reference/create-document/) adds the uploaded file to a knowledge base, in the folder you
name, and starts indexing it. It returns the new document and the operation that indexes it. The SDK sends an
idempotency key, so a retried request does not add the file twice.

<!-- example: examples/typescript/documents.ts#create-document -->
```ts tab="TypeScript"
// A folder is a path from the root that starts and ends in /, such as '/policies/'; the root is '/'
const { document, operation } = await caitlyn.documents.create({ knowledgeBaseId, uploadId, folder: '/policies/' });
console.log(`${document.name} is ${document.status}; operation ${operation.id}`);
```
<!-- example: examples/python/documents.py#create-document -->
```python tab="Python"
# A folder path starts and ends in /: "/policies/", or "/" for the knowledge base's top level.
created = caitlyn.documents.create(knowledge_base_id=knowledge_base_id, upload_id=upload_id, folder="/policies/")
print(created.document.id, created.document.status)  # ingestion carries on after the response
```
<!-- example: examples/go/documents/documents.go#create-document -->
```go tab="Go"
created, err := client.Documents.Create(ctx, &caitlyn.CreateDocumentInput{
	KnowledgeBaseID: knowledgeBaseID,
	UploadID:        uploadID,
	Folder:          "/policies/", // from the root, starting and ending in /
	// Name defaults to the uploaded file's name
})
if err != nil {
	return nil, err
}
// Indexing carries on after the call returns: the document starts out pending
fmt.Println(created.Document.ID, created.Document.Status, created.Operation.ID)
```
<!-- example: examples/rust/src/documents.rs#create-document -->
```rust tab="Rust"
let input = CreateDocumentInput {
    knowledge_base_id: knowledge_base_id.into(),
    upload_id: upload_id.into(),
    folder: "/policies/".into(), // a path from the knowledge base's root, starting and ending in /
    name: None,                  // the upload's file name
};
let created = client.documents().create(input).await?;
// Indexing starts in the background: wait_until_indexed waits for it.
println!("{} {:?}", created.document.id, created.document.status);
```

## Wait until it is indexed

[GetDocument](/reference/get-document/) reads the document's status. A document that is partially indexed can
be cited, and its `partialFailures` say what was left out, such as a picture description or a table. They
never fail the document. A document that could not be indexed is `failed`, and its `failure` says why: a code
(`file_unreadable`, `processing_interrupted` or `processing_failed`, and more may be added) and a message that
says what to do.

<!-- example: examples/typescript/documents.ts#get-document -->
```ts tab="TypeScript"
const document = await caitlyn.documents.get({ knowledgeBaseId, documentId });
console.log(document.name, document.status, document.partialFailures?.length ?? 0);
// A failed document says why: a code such as file_unreadable, and a message saying what to do
if (document.failure) console.log(document.failure.code, document.failure.message);
```
<!-- example: examples/python/documents.py#get-document -->
```python tab="Python"
doc = caitlyn.documents.get(knowledge_base_id=knowledge_base_id, document_id=document_id)
print(doc.name, doc.status, doc.stage)
if doc.failure:  # only on a failed document: a code such as file_unreadable, and what to do about it
    print(doc.failure.code, doc.failure.message)
```
<!-- example: examples/go/documents/documents.go#get-document -->
```go tab="Go"
document, err := client.Documents.Get(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: documentID})
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
let input = GetDocumentInput {
    knowledge_base_id: knowledge_base_id.into(),
    document_id: document_id.into(),
};
let document = client.documents().get(input).await?;
println!("{} {:?}", document.name, document.status);
if let Some(failure) = &document.failure {
    // Only on a failed document: a code such as file_unreadable, and what to do about it.
    println!("{}: {}", failure.code.as_str(), failure.message);
}
```

Rather than reading the document in a loop, wait for it. The waiter reads the document until it is indexed or
partially indexed, backing off between reads, for up to 60 minutes unless you set a shorter limit. A document
that fails to index, or that is removed while you wait, ends the wait with an error.

<!-- example: examples/typescript/documents.ts#wait-until-indexed -->
```ts tab="TypeScript"
// Polls until the document is indexed (or partially indexed), for up to 60 minutes by default; a failed
// document, or one that is gone, throws WaiterError
const document = await caitlyn.documents.waitUntilIndexed({ knowledgeBaseId, documentId });
console.log(`${document.name} is ${document.status}`);
```
<!-- example: examples/python/documents.py#wait-until-indexed -->
```python tab="Python"
# Reads the document until it can be searched, then returns it. Raises WaiterError if ingestion fails, the
# document goes, or the wait passes its limit (an hour by default; pass max_wait=… in seconds to change it).
doc = caitlyn.documents.wait_until_indexed(knowledge_base_id=knowledge_base_id, document_id=document_id)
for failure in doc.partial_failures or []:  # partially_indexed: some enrichments did not complete
    print("skipped:", failure)
```
<!-- example: examples/go/documents/documents.go#wait-until-indexed -->
```go tab="Go"
// Polls GetDocument until the document is indexed or partially_indexed. A failed or deleted document
// returns a *caitlyn.WaiterError; so does the time limit, an hour unless you pass WithMaxWait.
document, err := client.Documents.WaitUntilIndexed(ctx, &caitlyn.GetDocumentInput{
	KnowledgeBaseID: knowledgeBaseID,
	DocumentID:      documentID,
}, caitlyn.WithMaxWait(20*time.Minute))
if err != nil {
	return nil, err
}
fmt.Println(document.Name, document.Status)
```
<!-- example: examples/rust/src/documents.rs#wait-until-indexed -->
```rust tab="Rust"
let input = GetDocumentInput {
    knowledge_base_id: knowledge_base_id.into(),
    document_id: document_id.into(),
};
match client
    .documents()
    .wait_until_indexed(input)
    .max_wait(Duration::from_secs(15 * 60))
    .await
{
    Ok(document) => {
        println!("{} is {:?}", document.name, document.status); // indexed, or partially_indexed
        Ok(document)
    }
    Err(Error::Waiter(w)) => {
        // w.reason is Failure (failed, being deleted or gone) or Timeout; w.last_error or w.last_output says more
        println!("{}: {} after {} reads", w.waiter, w.reason.as_str(), w.attempts);
        Err(Error::Waiter(w))
    }
    Err(e) => Err(e),
}
```

## List the documents

[ListDocuments](/reference/list-documents/) lists a knowledge base's documents, a page at a time. The SDK
fetches the next page as you iterate; see [Pagination](/pagination/).

<!-- example: examples/typescript/documents.ts#list-documents -->
```ts tab="TypeScript"
for await (const document of caitlyn.documents.list({ knowledgeBaseId })) {
  console.log(document.folder, document.name, document.status);
  ids.push(document.id);
}
```
<!-- example: examples/python/documents.py#list-documents -->
```python tab="Python"
# Iterating fetches each page as it is needed.
for doc in caitlyn.documents.list(knowledge_base_id=knowledge_base_id, folder="/policies/", status="indexed"):
    names.append(doc.name)
```
<!-- example: examples/go/documents/documents.go#list-documents -->
```go tab="Go"
// Every document in the folder, newest first: the next page is fetched as the loop reaches it
var documents []caitlyn.Document
input := &caitlyn.ListDocumentsInput{KnowledgeBaseID: knowledgeBaseID, Folder: caitlyn.Ptr("/policies/"), Sort: caitlyn.Ptr("-updatedAt")}
for document, err := range client.Documents.List(ctx, input) {
	if err != nil {
		return nil, err
	}
	fmt.Println(document.Name, document.Status)
	documents = append(documents, document)
}
```
<!-- example: examples/rust/src/documents.rs#list-documents -->
```rust tab="Rust"
let input = ListDocumentsInput {
    knowledge_base_id: knowledge_base_id.into(),
    folder: Some("/policies/".into()),
    ..Default::default()
};
let mut documents = client.documents().list(input); // the next page is fetched as the loop reaches it
let mut found = Vec::new();
while let Some(document) = documents.next().await {
    let document = document?;
    println!("{} {:?}", document.name, document.status);
    found.push(document);
}
```

## Delete documents

[DeleteDocument](/reference/delete-document/) deletes one document. The delete is accepted at once: the
document reads as `deleting` while it is removed from search, and once it is gone, reading it returns 404.
Deleting it again while it is still `deleting` is accepted again. A document that is still being processed
(`pending` or `processing`) cannot be deleted yet: the call is refused with 409 `CONFLICT`. Wait until it is
indexed, partially indexed or failed, then delete it.

<!-- example: examples/typescript/documents.ts#delete-document -->
```ts tab="TypeScript"
// Accepted at once (202): the document reads as deleting until it is gone, then 404s. One still pending or
// processing throws ConflictError (409 CONFLICT): wait until it is indexed first
const document = await caitlyn.documents.delete({ knowledgeBaseId, documentId });
console.log(`${document.name} is ${document.status}`);
```
<!-- example: examples/python/documents.py#delete-document -->
```python tab="Python"
# The delete is accepted at once (`deleting`); the document and its search entries go shortly after. A document
# still pending or processing raises ConflictError (409 CONFLICT): wait until it is indexed first.
doc = caitlyn.documents.delete(knowledge_base_id=knowledge_base_id, document_id=document_id)
print(doc.id, doc.status)
```
<!-- example: examples/go/documents/documents.go#delete-document -->
```go tab="Go"
// A document still pending or processing returns a *caitlyn.ConflictError (409 CONFLICT): wait until it is indexed
deleted, err := client.Documents.Delete(ctx, &caitlyn.DeleteDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: documentID})
if err != nil {
	return nil, err
}
fmt.Println(deleted.Name, deleted.Status) // deleting, until it is gone
```
<!-- example: examples/rust/src/documents.rs#delete-document -->
```rust tab="Rust"
// A document still pending or processing is refused with Error::Conflict (409 CONFLICT): wait until it is indexed.
let input = DeleteDocumentInput {
    knowledge_base_id: knowledge_base_id.into(),
    document_id: document_id.into(),
};
let document = client.documents().delete(input).await?;
println!("{} is {:?}", document.id, document.status); // deleting; wait_until_deleted waits for it to be gone
```

[BatchDeleteDocuments](/reference/batch-delete-documents/) deletes up to 100 documents in one call. It returns
one result per identifier, in the order you sent them: `accepted`, or `failed` with a code, such as
`NOT_FOUND` for a document that is already gone, or `CONFLICT` for one still being processed. One document that cannot be deleted does not stop the others,
so check each result. Sending no identifiers, more than 100, or the same one twice is refused as a whole.

<!-- example: examples/typescript/documents.ts#batch-delete-documents -->
```ts tab="TypeScript"
// 1 to 100 distinct IDs; one that cannot be deleted (NOT_FOUND, or CONFLICT while it is still being processed)
// fails on its own, and the rest still go
const { results } = await caitlyn.documents.batchDelete({ knowledgeBaseId, documentIds });
for (const result of results) {
  if (result.status === 'accepted') console.log(`${result.documentId} is being deleted`);
  else console.log(`${result.documentId} was not deleted: ${result.code}`);
}
```
<!-- example: examples/python/documents.py#batch-delete-documents -->
```python tab="Python"
# Up to 100 documents in one call. One that cannot be deleted (NOT_FOUND, or CONFLICT while it is still being
# processed) does not stop the others: each identifier gets its own result, in the order you sent them.
batch = caitlyn.documents.batch_delete(knowledge_base_id=knowledge_base_id, document_ids=document_ids)
for result in batch.results:
    if result.status == "accepted":
        print(result.document_id, "is being deleted")
    else:
        print(result.document_id, "was not deleted:", result.code, result.detail)
```
<!-- example: examples/go/documents/documents.go#batch-delete-documents -->
```go tab="Go"
// From 1 to 100 identifiers, each at most once. One that cannot be deleted (NOT_FOUND, or CONFLICT while it is
// still being processed) does not stop the others.
batch, err := client.Documents.BatchDelete(ctx, &caitlyn.BatchDeleteDocumentsInput{
	KnowledgeBaseID: knowledgeBaseID,
	DocumentIDs:     documentIDs,
})
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
let input = BatchDeleteDocumentsInput {
    knowledge_base_id: knowledge_base_id.into(),
    document_ids: document_ids.to_vec(),
};
let deleted = client.documents().batch_delete(input).await?;
for r in &deleted.results {
    match r.status {
        DocumentDeleteStatus::Accepted => println!("{}: deleting", r.document_id),
        _ => println!("{}: not deleted, {:?} {:?}", r.document_id, r.code, r.detail), // NOT_FOUND, for example
    }
}
```

To know when a document is gone, wait for it. The waiter reads the document until reading it returns 404, for
up to 15 minutes unless you set a shorter limit, and returns nothing.

<!-- example: examples/typescript/documents.ts#wait-until-deleted -->
```ts tab="TypeScript"
// Polls until reading the document returns 404, for up to 15 minutes by default; it returns nothing
await caitlyn.documents.waitUntilDeleted({ knowledgeBaseId, documentId });
console.log(`${documentId} is gone`);
```
<!-- example: examples/python/documents.py#wait-until-deleted -->
```python tab="Python"
# Returns once the document is gone (reading it is a 404). Raises WaiterError if that takes longer than the
# limit, 15 minutes by default.
caitlyn.documents.wait_until_deleted(knowledge_base_id=knowledge_base_id, document_id=document_id)
```
<!-- example: examples/go/documents/documents.go#wait-until-deleted -->
```go tab="Go"
// Polls GetDocument until it answers 404. There is no output, so nil means the document is gone; a
// *caitlyn.WaiterError means it was not gone within the limit, 15 minutes unless you pass WithMaxWait.
err := client.Documents.WaitUntilDeleted(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: documentID})
if err != nil {
	return err
}
fmt.Println(documentID, "is gone")
```
<!-- example: examples/rust/src/documents.rs#wait-until-deleted -->
```rust tab="Rust"
let input = GetDocumentInput {
    knowledge_base_id: knowledge_base_id.into(),
    document_id: document_id.into(),
};
client.documents().wait_until_deleted(input).await?; // Ok(()) once reading it returns 404; up to 15 minutes by default
println!("{document_id} is gone");
```
