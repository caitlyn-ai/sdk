// The developer docs show these regions: adding files to a knowledge base as documents, replacing one with a new
// version, keeping a folder in step with ingestion.sync, and the building blocks underneath. Each also runs against a real
// server (scripts/examples-live/typescript.sh), so the code the docs show is code that ran.
import { UploadFile, type Caitlyn, type FileInput } from '@caitlyn-ai/sdk';

/** Adds a file to a knowledge base as a document; ingestion carries on after the call returns. */
export async function createDocument(caitlyn: Caitlyn, knowledgeBaseId: string, file: FileInput) {
  // #region add-document-from-file
  // `file` is a path, a File or Blob, or an UploadFile (fromPath, fromBytes, fromStream). The SDK hashes it,
  // uploads it and then creates the document. A folder is a path from the root that starts and ends in /.
  const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents.create(file, { folder: '/policies/' });
  console.log(`${document.name} is ${document.status}; operation ${document.operation.id}`);
  // #endregion
  return document;
}

/** Adds a file from a stream, such as a download, without saving it first. */
export async function createDocumentFromStream(caitlyn: Caitlyn, knowledgeBaseId: string, url: string) {
  // #region add-document-from-stream
  const res = await fetch(url);
  // A stream is read once: the SDK copies it as it hashes it (to memory up to 8 MiB, then to a temporary file
  // only you can read, removed when the call ends)
  const file = UploadFile.fromStream(res.body!, { name: 'q3-report.pdf' });
  const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents.create(file, { folder: '/finance/' });
  // #endregion
  return document;
}

/** Replaces a document's bytes with a new version, and waits until that version is searchable. */
export async function replaceDocument(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string, file: FileInput) {
  // #region replace-document
  // The new bytes become the document's next version; the current one keeps serving search until it is indexed.
  // The same bytes as the current version make no new version (result: 'unchanged'); another file type is refused,
  // because that is a new document. wait() returns the document once the new version is searchable.
  const doc = caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId);
  const replaced = doc.replace(file, { note: 'The 2027 edition' });
  const { result, version } = await replaced;
  const indexed = await replaced.wait();
  console.log(`${result}: version ${version.number}; the document is ${indexed.status} at version ${indexed.version}`);
  // #endregion
  return version;
}

/** Keeps a knowledge base folder in step with a folder on disk, through one ingestion batch. */
export async function ingestFolder(caitlyn: Caitlyn, knowledgeBaseId: string, dir: string) {
  // #region sync-folder-with-policy
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
  // #endregion
  return report;
}

/** The low-level building block behind every file helper: uploads a file and returns the upload. */
export async function sendUpload(caitlyn: Caitlyn, file: FileInput) {
  // #region send-upload
  // Works out the size and SHA-256, reserves the upload, then sends the bytes to the address it gives
  const upload = await caitlyn.core.uploads.send(file);
  console.log(upload.id, upload.status);
  // #endregion
  return upload;
}

/** An upload's status: whether its bytes have arrived. */
export async function getUpload(caitlyn: Caitlyn, uploadId: string) {
  // #region get-upload
  const upload = await caitlyn.core.uploads(uploadId).get();
  console.log(`${upload.id} is ${upload.status}, until ${upload.expiresAt.toISOString()}`);
  // #endregion
  return upload;
}

/** One document, with where it is in its lifecycle. */
export async function getDocument(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region get-document
  const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).get();
  console.log(document.name, document.status, document.version, document.partialFailures?.length ?? 0);
  // A failed document says why: a code such as file_unreadable, and a message saying what to do
  if (document.failure) console.log(document.failure.code, document.failure.message);
  // #endregion
  return document;
}

/** Waits until a document is searchable. */
export async function waitUntilIndexed(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region wait-for-processing
  // Follows the document through the knowledge base's watch until no job on it is running: a failed job throws its
  // error, and one with partial failures returns them on the document. `timeoutMs` sets a limit; there is none by default
  const document = await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).wait();
  console.log(`${document.name} is ${document.status}`);
  // #endregion
  return document;
}

/** Every document in a knowledge base; the SDK follows the pages. */
export async function listDocuments(caitlyn: Caitlyn, knowledgeBaseId: string) {
  const ids: string[] = [];
  // #region list-documents
  for await (const document of caitlyn.knowledgeBases(knowledgeBaseId).documents.list()) {
    console.log(document.folder, document.name, document.status);
    ids.push(document.id);
  }
  // #endregion
  return ids;
}

/** Deletes a document: it reads as `deleting` until it is gone. */
export async function deleteDocument(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region delete-document
  // Accepted at once (202), even while the document is still being processed, whose processing stops: it reads as
  // deleting until it is gone, then 404s. delete().wait() waits until it is gone
  const deleted = await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).delete();
  console.log(`deleting; its ETag is ${deleted.etag}`);
  // #endregion
  return deleted;
}

/** Deletes up to 100 documents in one call, with a result for each, in the order asked. */
export async function batchDeleteDocuments(caitlyn: Caitlyn, knowledgeBaseId: string, documentIds: string[]) {
  // #region batch-delete-documents
  // 1 to 100 distinct IDs; one that cannot be deleted (NOT_FOUND)
  // fails on its own, and the rest still go
  const { results } = await caitlyn.knowledgeBases(knowledgeBaseId).documents.deleteMany(documentIds);
  for (const result of results) {
    if (result.status === 'accepted') console.log(`${result.documentId} is being deleted`);
    else console.log(`${result.documentId} was not deleted: ${result.code}`);
  }
  // #endregion
  return results;
}

/** Waits until a deleted document is gone. */
export async function waitUntilDeleted(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region wait-for-delete
  // delete() returns something to wait on: it ends when the document is gone, and returns nothing
  await caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).delete().wait();
  console.log(`${documentId} is gone`);
  // #endregion
}
