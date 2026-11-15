// The developer docs show these regions, for uploading a file and adding it to a knowledge base as a document.
// Each also runs against a real server (scripts/examples-live/typescript.sh), so the code the docs show is code
// that ran.
import type { Caitlyn } from '@caitlyn-ai/sdk';

/** Uploads a file's bytes, ready to become a document. */
export async function createUpload(caitlyn: Caitlyn, file: Blob, fileName: string) {
  // #region create-upload
  // Works out the size and SHA-256, reserves the upload, then sends the bytes to the address it gives
  const upload = await caitlyn.uploads.create({ file, fileName });
  console.log(upload.id, upload.status);
  // #endregion
  return upload;
}

/** An upload's status: whether its bytes have arrived. */
export async function getUpload(caitlyn: Caitlyn, uploadId: string) {
  // #region get-upload
  const upload = await caitlyn.uploads.get({ uploadId });
  console.log(`${upload.id} is ${upload.status}, until ${upload.expiresAt.toISOString()}`);
  // #endregion
  return upload;
}

/** Adds an upload to a knowledge base as a document; ingestion carries on after the call returns. */
export async function createDocument(caitlyn: Caitlyn, knowledgeBaseId: string, uploadId: string) {
  // #region create-document
  // A folder is a path from the root that starts and ends in /, such as '/policies/'; the root is '/'
  const { document, operation } = await caitlyn.documents.create({ knowledgeBaseId, uploadId, folder: '/policies/' });
  console.log(`${document.name} is ${document.status}; operation ${operation.id}`);
  // #endregion
  return document;
}

/** One document, with where it is in its lifecycle. */
export async function getDocument(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region get-document
  const document = await caitlyn.documents.get({ knowledgeBaseId, documentId });
  console.log(document.name, document.status, document.partialFailures?.length ?? 0);
  // A failed document says why: a code such as file_unreadable, and a message saying what to do
  if (document.failure) console.log(document.failure.code, document.failure.message);
  // #endregion
  return document;
}

/** Waits until a document is searchable. */
export async function waitUntilIndexed(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region wait-until-indexed
  // Polls until the document is indexed (or partially indexed), for up to 60 minutes by default; a failed
  // document, or one that is gone, throws WaiterError
  const document = await caitlyn.documents.waitUntilIndexed({ knowledgeBaseId, documentId });
  console.log(`${document.name} is ${document.status}`);
  // #endregion
  return document;
}

/** Every document in a knowledge base; the SDK follows the pages. */
export async function listDocuments(caitlyn: Caitlyn, knowledgeBaseId: string) {
  const ids: string[] = [];
  // #region list-documents
  for await (const document of caitlyn.documents.list({ knowledgeBaseId })) {
    console.log(document.folder, document.name, document.status);
    ids.push(document.id);
  }
  // #endregion
  return ids;
}

/** Deletes a document: it reads as `deleting` until it is gone. */
export async function deleteDocument(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region delete-document
  // Accepted at once (202): the document reads as deleting until it is gone, then 404s. One still pending or
  // processing throws ConflictError (409 CONFLICT): wait until it is indexed first
  const document = await caitlyn.documents.delete({ knowledgeBaseId, documentId });
  console.log(`${document.name} is ${document.status}`);
  // #endregion
  return document;
}

/** Deletes up to 100 documents in one call, with a result for each, in the order asked. */
export async function batchDeleteDocuments(caitlyn: Caitlyn, knowledgeBaseId: string, documentIds: string[]) {
  // #region batch-delete-documents
  // 1 to 100 distinct IDs; one that cannot be deleted (NOT_FOUND, or CONFLICT while it is still being processed)
  // fails on its own, and the rest still go
  const { results } = await caitlyn.documents.batchDelete({ knowledgeBaseId, documentIds });
  for (const result of results) {
    if (result.status === 'accepted') console.log(`${result.documentId} is being deleted`);
    else console.log(`${result.documentId} was not deleted: ${result.code}`);
  }
  // #endregion
  return results;
}

/** Waits until a deleted document is gone. */
export async function waitUntilDeleted(caitlyn: Caitlyn, knowledgeBaseId: string, documentId: string) {
  // #region wait-until-deleted
  // Polls until reading the document returns 404, for up to 15 minutes by default; it returns nothing
  await caitlyn.documents.waitUntilDeleted({ knowledgeBaseId, documentId });
  console.log(`${documentId} is gone`);
  // #endregion
}
