# The code on the developer docs' pages about documents, folders, fields and ingesting a folder, one region each.
# scripts/test-python.sh type-checks this file against the SDK (pyright --strict), and scripts/examples-live/python.sh
# runs each function against a real Caitlyn server. The landing page's jobs are in jobs.py.
from pathlib import Path

import httpx

from caitlyn import (
    BatchDeleteDocumentsResult,
    Caitlyn,
    CreateUploadResult,
    CreatedDocumentScope,
    Document,
    DocumentDownload,
    IngestionBatch,
    IngestionBatchItem,
    IngestionPolicy,
    IngestionProgress,
    KnowledgeBaseScope,
    SyncReport,
    Upload,
    UploadFile,
)


def create_document_from_file(kb: KnowledgeBaseScope, path: Path) -> CreatedDocumentScope:
    # #region add-document-from-file
    # The SDK hashes the file, uploads it, then creates the document. A folder path starts and ends in /:
    # "/policies/", or "/" for the knowledge base's top level. Ingestion carries on after the response: the result is
    # the new document's scope, with the response's fields, and .wait() waits for it.
    created = kb.documents.create(path, folder="/policies/")
    print(created.id, created.document.status, created.operation.id)
    # #endregion
    return created


def create_document_from_stream(kb: KnowledgeBaseScope, url: str) -> Document:
    # #region add-document-from-stream
    # A stream is read once: the SDK copies it while hashing (in memory up to 8 MiB, then a temporary file only you
    # can read, deleted when the call ends). Give it a name, which sets the content type (.pdf: application/pdf).
    with httpx.stream("GET", url) as response:
        file = UploadFile.from_stream(response.iter_bytes(), name="q3-report.pdf")
        created = kb.documents.create(file, folder="/finance/")
    # #endregion
    return created.wait()


def ingest_folder(kb: KnowledgeBaseScope, folder: Path) -> SyncReport[IngestionBatch, IngestionBatchItem]:
    # #region sync-folder-with-policy
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
    # #endregion
    return report


def create_document(kb: KnowledgeBaseScope, upload_id: str) -> CreatedDocumentScope:
    # #region create-document
    # From an upload already sent (core.uploads.send): its id in place of the file.
    created = kb.documents.create(upload_id=upload_id, folder="/policies/")
    print(created.id, created.document.status)  # ingestion carries on after the response
    # #endregion
    return created


def get_document(kb: KnowledgeBaseScope, document_id: str) -> Document:
    # #region get-document
    doc = kb.documents(document_id).get()
    print(doc.name, doc.status, doc.processing.percent if doc.processing else 100)
    if doc.failure:  # only on a failed document: a code such as file_unreadable, and what to do about it
        print(doc.failure.code, doc.failure.message)
    # #endregion
    return doc


def wait_until_indexed(kb: KnowledgeBaseScope, document_id: str) -> Document:
    # #region wait-for-processing
    # Returns the document once nothing runs on it, from its identifier alone (after a page reload, say). A
    # failed ingestion raises its error; some enrichments not completing does not.
    doc = kb.documents(document_id).wait(timeout=3600)
    for failure in doc.partial_failures or []:  # partially_indexed: some enrichments did not complete
        print("skipped:", failure.code, failure.detail)
    # #endregion
    return doc


def update_document(kb: KnowledgeBaseScope, document_id: str) -> Document:
    # #region update-document
    # Its details, not its file: the name, folder and metadata. Moving it applies to search too, so wait for that.
    doc = kb.documents(document_id)
    updated = doc.update(folder="/policies/archive/", if_match=doc.get().etag)
    # #endregion
    return updated.wait()


def download_document(kb: KnowledgeBaseScope, document_id: str) -> DocumentDownload:
    # #region download-document
    # A short-lived address for the bytes (15 minutes), which needs no credential: treat it as a secret.
    content = kb.documents(document_id).download()
    print(content.url, "until", content.expires_at)
    # #endregion
    return content


def list_documents(kb: KnowledgeBaseScope) -> list[str]:
    names: list[str] = []
    # #region list-documents
    # Iterating fetches each page as it is needed.
    for doc in kb.documents.list(folder="/policies/", status="indexed"):
        names.append(doc.name)
    # #endregion
    return names


def replace_document(kb: KnowledgeBaseScope, document_id: str, path: Path) -> Document:
    # #region replace-document
    # A new version of the same document: it keeps its id and history, and the current version keeps answering until
    # the new one is indexed. .wait() returns the document once it is.
    replaced = kb.documents(document_id).replace(path, note="The 2027 edition")
    print(replaced.result.result)  # created, unchanged (the same bytes as now) or restored (an earlier version's bytes)
    doc = replaced.wait()
    print(doc.version, doc.status)
    # #endregion
    return doc


def delete_document(kb: KnowledgeBaseScope, document_id: str) -> None:
    # #region delete-document
    # The delete is accepted at once, even while the document is still being processed (its processing stops); the
    # document and its search entries go shortly after.
    kb.documents(document_id).delete()
    # #endregion


def wait_until_deleted(kb: KnowledgeBaseScope, document_id: str) -> None:
    # #region wait-for-delete
    # Returns once the document is gone (reading it is a 404). timeout= (seconds) raises TimeoutError if it takes longer.
    kb.documents(document_id).delete().wait(timeout=900)
    # #endregion


def send_upload(caitlyn: Caitlyn, path: Path) -> CreateUploadResult:
    # #region send-upload
    # The building block under the file calls: hashes the file, reserves an upload, and sends the bytes to its
    # presigned URL. Most code never needs it; pass the upload's id where a call takes one (upload_id=…).
    upload = caitlyn.core.uploads.send(path)
    print(upload.id, upload.status)
    # #endregion
    return upload


def get_upload(caitlyn: Caitlyn, upload_id: str) -> Upload:
    # #region get-upload
    upload = caitlyn.core.uploads(upload_id).get()
    print(upload.status, "until", upload.expires_at)
    # #endregion
    return upload


def delete_many(kb: KnowledgeBaseScope, document_ids: list[str]) -> BatchDeleteDocumentsResult:
    # #region batch-delete-documents
    # Up to 100 documents in one call, whether or not they are still being processed. One that cannot be deleted
    # (NOT_FOUND) does not stop the others: each identifier gets its own result, in the order you sent them.
    batch = kb.documents.delete_many(document_ids)
    for result in batch.results:
        if result.status == "accepted":
            print(result.document_id, "is being deleted")
        else:
            print(result.document_id, "was not deleted:", result.code, result.detail)
    # #endregion
    return batch


def create_field(kb: KnowledgeBaseScope) -> None:
    # #region create-field
    # One field at a time, so two people adding fields at once never undo each other. Saving a field fills nothing
    # in: fill_in does that.
    field = kb.fields.create(key="policyOwner", name="Policy owner", type="text", filterable=True)
    print(field.id, field.key)
    # #endregion
