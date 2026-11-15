# The code on the developer docs' pages about uploads and documents, one region each. scripts/test-python.sh
# type-checks this file against the SDK (pyright --strict), and scripts/examples-live/python.sh runs each
# function against a real Caitlyn server.
from pathlib import Path

from caitlyn import (
    BatchDeleteDocumentsResult,
    Caitlyn,
    CreateDocumentResult,
    DeleteDocumentResult,
    GetDocumentResult,
    GetUploadResult,
    Upload,
)


def create_upload(caitlyn: Caitlyn, path: Path) -> Upload:
    # #region create-upload
    # Reserves an upload, then sends the file's bytes to the presigned URL the reservation names.
    upload = caitlyn.uploads.create(file=path)
    print(upload.id, upload.status)
    # #endregion
    return upload


def create_document(caitlyn: Caitlyn, knowledge_base_id: str, upload_id: str) -> CreateDocumentResult:
    # #region create-document
    # A folder path starts and ends in /: "/policies/", or "/" for the knowledge base's top level.
    created = caitlyn.documents.create(knowledge_base_id=knowledge_base_id, upload_id=upload_id, folder="/policies/")
    print(created.document.id, created.document.status)  # ingestion carries on after the response
    # #endregion
    return created


def get_document(caitlyn: Caitlyn, knowledge_base_id: str, document_id: str) -> GetDocumentResult:
    # #region get-document
    doc = caitlyn.documents.get(knowledge_base_id=knowledge_base_id, document_id=document_id)
    print(doc.name, doc.status, doc.stage)
    if doc.failure:  # only on a failed document: a code such as file_unreadable, and what to do about it
        print(doc.failure.code, doc.failure.message)
    # #endregion
    return doc


def wait_until_indexed(caitlyn: Caitlyn, knowledge_base_id: str, document_id: str) -> GetDocumentResult:
    # #region wait-until-indexed
    # Reads the document until it can be searched, then returns it. Raises WaiterError if ingestion fails, the
    # document goes, or the wait passes its limit (an hour by default; pass max_wait=… in seconds to change it).
    doc = caitlyn.documents.wait_until_indexed(knowledge_base_id=knowledge_base_id, document_id=document_id)
    for failure in doc.partial_failures or []:  # partially_indexed: some enrichments did not complete
        print("skipped:", failure)
    # #endregion
    return doc


def list_documents(caitlyn: Caitlyn, knowledge_base_id: str) -> list[str]:
    names: list[str] = []
    # #region list-documents
    # Iterating fetches each page as it is needed.
    for doc in caitlyn.documents.list(knowledge_base_id=knowledge_base_id, folder="/policies/", status="indexed"):
        names.append(doc.name)
    # #endregion
    return names


def get_upload(caitlyn: Caitlyn, upload_id: str) -> GetUploadResult:
    # #region get-upload
    upload = caitlyn.uploads.get(upload_id=upload_id)
    print(upload.status, "until", upload.expires_at)
    # #endregion
    return upload


def delete_document(caitlyn: Caitlyn, knowledge_base_id: str, document_id: str) -> DeleteDocumentResult:
    # #region delete-document
    # The delete is accepted at once (`deleting`); the document and its search entries go shortly after. A document
    # still pending or processing raises ConflictError (409 CONFLICT): wait until it is indexed first.
    doc = caitlyn.documents.delete(knowledge_base_id=knowledge_base_id, document_id=document_id)
    print(doc.id, doc.status)
    # #endregion
    return doc


def batch_delete_documents(caitlyn: Caitlyn, knowledge_base_id: str, document_ids: list[str]) -> BatchDeleteDocumentsResult:
    # #region batch-delete-documents
    # Up to 100 documents in one call. One that cannot be deleted (NOT_FOUND, or CONFLICT while it is still being
    # processed) does not stop the others: each identifier gets its own result, in the order you sent them.
    batch = caitlyn.documents.batch_delete(knowledge_base_id=knowledge_base_id, document_ids=document_ids)
    for result in batch.results:
        if result.status == "accepted":
            print(result.document_id, "is being deleted")
        else:
            print(result.document_id, "was not deleted:", result.code, result.detail)
    # #endregion
    return batch


def wait_until_deleted(caitlyn: Caitlyn, knowledge_base_id: str, document_id: str) -> None:
    # #region wait-until-deleted
    # Returns once the document is gone (reading it is a 404). Raises WaiterError if that takes longer than the
    # limit, 15 minutes by default.
    caitlyn.documents.wait_until_deleted(knowledge_base_id=knowledge_base_id, document_id=document_id)
    # #endregion
