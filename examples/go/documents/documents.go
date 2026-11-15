// Package documents holds the developer docs' Go code for loading documents into a knowledge base, one region
// each. The live examples (examples/go/live, run by scripts/examples-live/go.sh) call these functions against a
// real Caitlyn workspace, so the code on the pages is known to work. scripts/test-go.sh builds and vets it.
package documents

import (
	"context"
	"fmt"
	"time"

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// CreateUpload sends a file's bytes to Caitlyn, ready to become a document.
func CreateUpload(ctx context.Context, client *caitlyn.Client, path string) (*caitlyn.Upload, error) {
	// #region create-upload
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
	// #endregion
	return upload, nil
}

// GetUpload checks an upload's status.
func GetUpload(ctx context.Context, client *caitlyn.Client, uploadID string) (*caitlyn.GetUploadResult, error) {
	// #region get-upload
	upload, err := client.Uploads.Get(ctx, &caitlyn.GetUploadInput{UploadID: uploadID})
	if err != nil {
		return nil, err
	}
	fmt.Println(upload.Status, upload.ExpiresAt)
	// #endregion
	return upload, nil
}

// CreateDocument turns an upload into a document in a knowledge base's /policies/ folder.
func CreateDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, uploadID string) (*caitlyn.CreateDocumentResult, error) {
	// #region create-document
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
	// #endregion
	return created, nil
}

// GetDocument reads a document's status.
func GetDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (*caitlyn.GetDocumentResult, error) {
	// #region get-document
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
	// #endregion
	return document, nil
}

// WaitUntilIndexed waits for a new document to become searchable.
func WaitUntilIndexed(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (*caitlyn.GetDocumentResult, error) {
	// #region wait-until-indexed
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
	// #endregion
	return document, nil
}

// ListDocuments lists the documents in the /policies/ folder.
func ListDocuments(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string) ([]caitlyn.Document, error) {
	// #region list-documents
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
	// #endregion
	return documents, nil
}

// DeleteDocument deletes a document: its delete is accepted at once and carries on in the background.
func DeleteDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (*caitlyn.DeleteDocumentResult, error) {
	// #region delete-document
	// A document still pending or processing returns a *caitlyn.ConflictError (409 CONFLICT): wait until it is indexed
	deleted, err := client.Documents.Delete(ctx, &caitlyn.DeleteDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: documentID})
	if err != nil {
		return nil, err
	}
	fmt.Println(deleted.Name, deleted.Status) // deleting, until it is gone
	// #endregion
	return deleted, nil
}

// BatchDeleteDocuments deletes up to 100 documents in one call, with a result for each.
func BatchDeleteDocuments(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string, documentIDs []string) ([]caitlyn.DocumentDeleteResult, error) {
	// #region batch-delete-documents
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
	// #endregion
	return batch.Results, nil
}

// WaitUntilDeleted waits until a deleted document is gone.
func WaitUntilDeleted(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) error {
	// #region wait-until-deleted
	// Polls GetDocument until it answers 404. There is no output, so nil means the document is gone; a
	// *caitlyn.WaiterError means it was not gone within the limit, 15 minutes unless you pass WithMaxWait.
	err := client.Documents.WaitUntilDeleted(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: documentID})
	if err != nil {
		return err
	}
	fmt.Println(documentID, "is gone")
	// #endregion
	return nil
}
