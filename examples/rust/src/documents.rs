//! The code the developer docs show for uploads and documents, one region each. src/bin/examples_live.rs runs them
//! against a real Caitlyn workspace (scripts/examples-live/rust.sh), and scripts/test-rust.sh runs clippy over them.
use std::path::Path;
use std::time::Duration;

use caitlyn_sdk::{
    BatchDeleteDocumentsInput, BatchDeleteDocumentsResult, Client, CreateDocumentInput, CreateDocumentResult, DeleteDocumentInput,
    DeleteDocumentResult, Document, DocumentDeleteStatus, Error, GetDocumentInput, GetDocumentResult, GetUploadInput, GetUploadResult,
    ListDocumentsInput, Upload, UploadFile,
};

/// Uploads a file's bytes, ready to become a document.
pub async fn create_upload(client: &Client, path: &Path) -> Result<Upload, Box<dyn std::error::Error + Send + Sync>> {
    // #region create-upload
    // The content type comes from the extension (application/pdf). A knowledge base ingests PDF, Word (.docx),
    // Markdown, images, audio and video.
    let file = UploadFile::from_path(path)?;
    // The SDK computes the SHA-256, reserves the upload, then sends the bytes to its presigned URL.
    let upload = client.uploads().create(file).await?;
    println!("{} {:?}, until {}", upload.id, upload.status, upload.expires_at);
    // #endregion
    Ok(upload)
}

/// Whether an upload's bytes have arrived.
pub async fn get_upload(client: &Client, upload_id: &str) -> Result<GetUploadResult, Error> {
    // #region get-upload
    let upload = client
        .uploads()
        .get(GetUploadInput {
            upload_id: upload_id.into(),
        })
        .await?;
    println!("{} {:?}", upload.id, upload.status); // received once the bytes are in
                                                   // #endregion
    Ok(upload)
}

/// Turns an upload into a document in a knowledge base.
pub async fn create_document(client: &Client, knowledge_base_id: &str, upload_id: &str) -> Result<CreateDocumentResult, Error> {
    // #region create-document
    let input = CreateDocumentInput {
        knowledge_base_id: knowledge_base_id.into(),
        upload_id: upload_id.into(),
        folder: "/policies/".into(), // a path from the knowledge base's root, starting and ending in /
        name: None,                  // the upload's file name
    };
    let created = client.documents().create(input).await?;
    // Indexing starts in the background: wait_until_indexed waits for it.
    println!("{} {:?}", created.document.id, created.document.status);
    // #endregion
    Ok(created)
}

/// One document.
pub async fn get_document(client: &Client, knowledge_base_id: &str, document_id: &str) -> Result<GetDocumentResult, Error> {
    // #region get-document
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
    // #endregion
    Ok(document)
}

/// Waits until a document is searchable.
pub async fn wait_until_indexed(client: &Client, knowledge_base_id: &str, document_id: &str) -> Result<GetDocumentResult, Error> {
    // #region wait-until-indexed
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
    // #endregion
}

/// The documents in a folder.
pub async fn list_documents(client: &Client, knowledge_base_id: &str) -> Result<Vec<Document>, Error> {
    // #region list-documents
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
    // #endregion
    Ok(found)
}

/// Deletes a document. The deletion runs in the background: the document reads as `deleting` until it is gone.
pub async fn delete_document(client: &Client, knowledge_base_id: &str, document_id: &str) -> Result<DeleteDocumentResult, Error> {
    // #region delete-document
    // A document still pending or processing is refused with Error::Conflict (409 CONFLICT): wait until it is indexed.
    let input = DeleteDocumentInput {
        knowledge_base_id: knowledge_base_id.into(),
        document_id: document_id.into(),
    };
    let document = client.documents().delete(input).await?;
    println!("{} is {:?}", document.id, document.status); // deleting; wait_until_deleted waits for it to be gone
                                                          // #endregion
    Ok(document)
}

/// Deletes up to 100 documents at once, with a result for each in the order asked.
pub async fn batch_delete_documents(
    client: &Client,
    knowledge_base_id: &str,
    document_ids: &[String],
) -> Result<BatchDeleteDocumentsResult, Error> {
    // #region batch-delete-documents
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
    // #endregion
    Ok(deleted)
}

/// Waits until a deleted document is gone.
pub async fn wait_until_deleted(client: &Client, knowledge_base_id: &str, document_id: &str) -> Result<(), Error> {
    // #region wait-until-deleted
    let input = GetDocumentInput {
        knowledge_base_id: knowledge_base_id.into(),
        document_id: document_id.into(),
    };
    client.documents().wait_until_deleted(input).await?; // Ok(()) once reading it returns 404; up to 15 minutes by default
    println!("{document_id} is gone");
    // #endregion
    Ok(())
}
