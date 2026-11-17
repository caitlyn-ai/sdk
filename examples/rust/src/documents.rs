//! The code the developer docs show for knowledge bases, documents and files, one region per job (the DX review's
//! section 1). src/bin/examples_live.rs runs them against a real Caitlyn workspace (scripts/examples-live/rust.sh),
//! and scripts/test-rust.sh runs clippy over them.
use std::path::Path;

use caitlyn_sdk::scope;
use caitlyn_sdk::{
    Client, CreateUploadResult, Document, Error, KnowledgeBase, KnowledgeBaseEvent, Readers,
    SyncInput, SyncPlan, SyncReport, Upload, UploadFile,
};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Adds a file from disk to a knowledge base, and waits until it can be searched.
pub async fn add_document(
    client: &Client,
    knowledge_base_id: &str,
    path: &Path,
) -> Result<Document, Error> {
    // #region add-document
    let kb = client.knowledge_base(knowledge_base_id);
    // The SDK hashes the file, uploads it, adds the document, then follows its processing until it is searchable.
    // (`.send().await?` instead gives the response at once, with `wait()` and `watch()` for later.)
    let doc = kb.documents().create(path).folder("/hr/").wait().await?;
    // indexed, or partially_indexed with doc.partial_failures
    println!("{} {}", doc.id, doc.status);
    // #endregion
    Ok(doc)
}

/// Adds a document from a stream that can be read only once, such as a download.
pub async fn add_document_from_stream(
    client: &Client,
    knowledge_base_id: &str,
    url: &str,
) -> Result<scope::DocumentScope, BoxError> {
    // #region add-document-from-stream
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
    // #endregion
    Ok(created.into_scope())
}

/// Keeps a folder of the knowledge base in step with a folder on disk.
pub async fn sync_folder(
    client: &Client,
    knowledge_base_id: &str,
    dir: &Path,
) -> Result<SyncReport, Error> {
    // #region sync-folder
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
    // #endregion
    Ok(report)
}

/// What a sync would do and cost, before anything is uploaded.
pub async fn sync_estimate(
    client: &Client,
    knowledge_base_id: &str,
    dir: &Path,
) -> Result<SyncPlan, Error> {
    // #region sync-estimate
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
            println!("{}-{} {}", cost.low, cost.high, cost.unit); // only for callers who may see cost
        }
    }
    // #endregion
    Ok(plan)
}

/// Replaces a document's file with a new version, and waits until that version is indexed.
pub async fn replace_document(
    client: &Client,
    knowledge_base_id: &str,
    document_id: &str,
    path: &Path,
) -> Result<Document, Error> {
    // #region replace-document
    let doc = client
        .knowledge_base(knowledge_base_id)
        .document(document_id);
    // The current version keeps answering until the new one is indexed.
    let replaced = doc.replace(path).note("The 2027 policy").send().await?;
    println!("{:?} version {}", replaced.result, replaced.version.number);
    let doc = replaced.wait().await?;
    println!("{} version {:?}", doc.status, doc.version);
    // #endregion
    Ok(doc)
}

/// Follows a document's processing, also after a page reload: only its identifier is needed.
pub async fn watch_document(
    client: &Client,
    knowledge_base_id: &str,
    document_id: &str,
) -> Result<Document, Error> {
    // #region watch-document
    let doc = client
        .knowledge_base(knowledge_base_id)
        .document(document_id)
        .wait()
        .on_progress(|p| {
            println!(
                "{:?} {:?}% {:?}",
                p.stage(),
                p.percent(),
                p.eta().map(|e| e.seconds.high)
            )
        })
        .await?;
    // The percentage never goes backwards, and the wait returns once the document can be searched.
    println!("{} {}", doc.name, doc.status);
    // #endregion
    Ok(doc)
}

/// Restricts who may read a folder, and makes a document read as its folder does again.
pub async fn set_access(
    client: &Client,
    knowledge_base_id: &str,
    document_id: &str,
) -> Result<(), Error> {
    // #region set-access
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
    // #endregion
    Ok(())
}

/// Watches a whole knowledge base: its documents, folders and jobs.
pub async fn watch_knowledge_base(client: &Client, knowledge_base_id: &str) -> Result<(), Error> {
    // #region watch-knowledge-base
    let kb = client.knowledge_base(knowledge_base_id);
    let mut events = kb.watch().await?;
    while let Some(event) = events.next().await {
        match event? {
            KnowledgeBaseEvent::Snapshot(snap) => println!("{} jobs running", snap.jobs.len()),
            KnowledgeBaseEvent::DocumentProgress(p) => {
                println!("{} {}%", p.document_id, p.processing.percent)
            }
            KnowledgeBaseEvent::JobFinished(done) => {
                println!("{:?} {}", done.job.kind, done.job.status)
            }
            other => println!("{}", other.event_type()), // document.updated, folder.created, …
        }
    }
    // #endregion
    Ok(())
}

/// Deletes a document, a folder and a knowledge base, waiting until each is gone.
pub async fn delete_things(kb: &scope::KnowledgeBaseScope, document_id: &str) -> Result<(), Error> {
    // #region delete-things
    kb.document(document_id).delete().wait().await?;
    kb.folder("/archive/").delete().wait().await?;
    kb.delete().wait().await?;
    // #endregion
    Ok(())
}

/// Fills in a metadata field on every document, after checking what it will take.
pub async fn fill_in_fields(
    client: &Client,
    knowledge_base_id: &str,
) -> Result<KnowledgeBase, Error> {
    // #region fill-in-fields
    let kb = client.knowledge_base(knowledge_base_id);
    let estimate = kb.fields().estimate_fill_in(["policyOwner"]).await?;
    if let Some(cost) = &estimate.cost {
        println!(
            "{} documents, {}-{} {}",
            estimate.documents, cost.low, cost.high, cost.unit
        );
    }
    let kb_after = kb.fields().fill_in(["policyOwner"]).wait().await?;
    // #endregion
    Ok(kb_after)
}

/// Reprocesses the documents processed before the newest processing.
pub async fn reprocess(client: &Client, knowledge_base_id: &str) -> Result<KnowledgeBase, Error> {
    // #region reprocess
    let kb = client.knowledge_base(knowledge_base_id);
    let estimate = kb
        .documents()
        .estimate_reprocess()
        .out_of_date(true)
        .await?;
    println!(
        "{} documents, what it brings: {:?}",
        estimate.documents, estimate.details
    );
    let kb_after = kb.documents().reprocess().out_of_date(true).wait().await?;
    // #endregion
    Ok(kb_after)
}

/// Turns on layout-aware search, after checking what it will take.
pub async fn layout_aware_search(
    client: &Client,
    knowledge_base_id: &str,
) -> Result<KnowledgeBase, Error> {
    // #region layout-aware-search
    let kb = client.knowledge_base(knowledge_base_id);
    let estimate = kb.layout_aware_search().estimate_enable().await?;
    println!(
        "{} documents, {:.0}-{:.0} s",
        estimate.documents, estimate.duration_seconds.low, estimate.duration_seconds.high
    );
    let kb_after = kb.layout_aware_search().enable().wait().await?;
    // #endregion
    Ok(kb_after)
}

/// Uploads a file's bytes with the building block every file helper is made from.
pub async fn send_upload(client: &Client, path: &Path) -> Result<CreateUploadResult, Error> {
    // #region send-upload
    // The content type comes from the extension (application/pdf); UploadFile::content_type sets another.
    // The SDK hashes the file as it reads it, reserves the upload, then sends the bytes to its presigned URL.
    let upload = client.core().uploads().send(path).await?;
    println!(
        "{} {}, until {}",
        upload.id, upload.status, upload.expires_at
    );
    // #endregion
    Ok(upload)
}

/// Lists every document in a folder.
pub async fn list_documents(client: &Client, knowledge_base_id: &str) -> Result<usize, Error> {
    // #region list-documents
    let kb = client.knowledge_base(knowledge_base_id);
    let mut documents = kb.documents().list().folder("/hr/").deep(true).items();
    let mut n = 0;
    while let Some(document) = documents.next().await {
        let document = document?;
        println!("{} {}", document.name, document.status);
        n += 1;
    }
    // #endregion
    Ok(n)
}

/// The calls the Load documents guide shows one at a time: add, read, wait, delete.
pub async fn one_document(
    client: &Client,
    knowledge_base_id: &str,
    path: &Path,
) -> Result<(), Error> {
    let kb = client.knowledge_base(knowledge_base_id);
    // #region add-document-from-file
    // The file is uploaded first: a path, UploadFile or a name with bytes. A file over 2 GB fails with FILE_TOO_LARGE.
    let created = kb
        .documents()
        .create(path)
        .folder("/policies/")
        .send()
        .await?;
    // The new document's scope, with the response as `output`; its processing runs in the background.
    println!("{} {}", created.id(), created.result().document.status);
    // #endregion
    let document_id = created.id().to_owned();
    // #region get-document
    let document = kb.document(&document_id).get().await?;
    println!(
        "{} {} in {}",
        document.name, document.status, document.folder
    );
    // #endregion
    // #region wait-for-processing
    // Follows the document through the knowledge base's watch until nothing runs on it, then reads it as get does.
    let indexed = kb.document(&document_id).wait().await?;
    println!("{} {:?}", indexed.status, indexed.partial_failures);
    // #endregion
    // #region delete-document
    // Accepted at once, also while the document is still being processed: its processing stops. It reads as
    // deleting until it is gone, then 404s.
    let deleting = kb.document(&document_id).delete().send().await?;
    println!("{} is {}", deleting.id, deleting.status);
    // #endregion
    // #region wait-for-delete
    // Waits until the document is gone; `kb.document(id).delete().wait()` does both in one call.
    deleting.wait().await?;
    // #endregion
    Ok(())
}

/// Deletes several documents in one call.
pub async fn batch_delete_documents(
    client: &Client,
    knowledge_base_id: &str,
    document_ids: &[String],
) -> Result<(), Error> {
    // #region batch-delete-documents
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
    // #endregion
    Ok(())
}

/// Keeps a folder in step: the guide's own region name for sync-folder.
pub async fn ingest_folder(
    client: &Client,
    knowledge_base_id: &str,
    dir: &Path,
) -> Result<SyncReport, Error> {
    // #region sync-folder-with-policy
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
    // #endregion
    Ok(report)
}

/// Whether an upload's bytes have arrived.
pub async fn get_upload(client: &Client, upload_id: &str) -> Result<Upload, Error> {
    // #region get-upload
    let upload = client.core().upload(upload_id).get().await?;
    // received once the bytes are in
    println!("{} {}", upload.id, upload.status);
    // #endregion
    Ok(upload)
}
