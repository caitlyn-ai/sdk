package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	caitlyn "github.com/caitlyn-ai/caitlyn-go"
	"github.com/caitlyn-ai/caitlyn-go/examples/documents"
)

// leavePolicy is the one-page leave policy the checks load (examples/fixtures/leave-policy.pdf): a file type a
// knowledge base can ingest, and text an agent could answer from.
var leavePolicy = func() string {
	_, here, _, _ := runtime.Caller(0) // examples/go/live/documents.go
	return filepath.Join(filepath.Dir(here), "..", "..", "fixtures", "leave-policy.pdf")
}()

// documentChecks loads a document into CAITLYN_KNOWLEDGE_BASE_ID with the docs' code in examples/go/documents:
// CreateUpload, GetUpload, CreateDocument, GetDocument, WaitUntilIndexed and ListDocuments, in that order.
func documentChecks(client *caitlyn.Client, check func(string, time.Duration, func(context.Context) error)) {
	knowledgeBaseID := strings.TrimSpace(os.Getenv("CAITLYN_KNOWLEDGE_BASE_ID")) // empty means unset
	missing := skip("no knowledge base configured: CAITLYN_KNOWLEDGE_BASE_ID is not set")
	// The docs' regions use the folder /policies/; each run's documents have names of their own instead.
	const folder = "/policies/"
	name := "leave-policy-" + unique()

	// Every document the run creates and has not seen gone; deleted together at the end, whatever happened.
	var created []string
	forget := func(id string) {
		created = slices.DeleteFunc(created, func(c string) bool { return c == id })
	}
	defer func() {
		if knowledgeBaseID == "" || len(created) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 31*time.Minute)
		defer cancel()
		ids := append([]string(nil), created...)
		// Only a document that has finished processing can be deleted: wait for each first. A failed document can be
		// deleted too, and one already deleting is accepted again, so the wait's own outcome does not matter.
		for _, id := range ids {
			_, _ = client.Documents.WaitUntilIndexed(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: id}, caitlyn.WithMaxWait(15*time.Minute))
		}
		if _, err := client.Documents.BatchDelete(ctx, &caitlyn.BatchDeleteDocumentsInput{KnowledgeBaseID: knowledgeBaseID, DocumentIDs: ids}); err != nil {
			fmt.Fprintln(os.Stderr, "live: could not clean up", ids, err)
			return
		}
		for _, id := range ids {
			if err := client.Documents.WaitUntilDeleted(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: id}); err != nil {
				fmt.Fprintln(os.Stderr, "live: clean-up: document", id, "is not gone:", err)
			}
		}
	}()

	var uploadID, documentID string
	check("CreateUpload", time.Minute, func(ctx context.Context) error {
		// The region takes the file's name from its path, so copy the PDF to a path with the run's name.
		path := filepath.Join(os.TempDir(), name+".pdf")
		data, err := os.ReadFile(leavePolicy)
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return err
		}
		defer os.Remove(path)
		upload, err := documents.CreateUpload(ctx, client, path)
		if err != nil {
			return err
		}
		uploadID = upload.ID
		return nil
	})
	check("GetUpload", 30*time.Second, func(ctx context.Context) error {
		if uploadID == "" {
			return errors.New("no upload: CreateUpload failed")
		}
		upload, err := documents.GetUpload(ctx, client, uploadID)
		if err == nil && upload.ID != uploadID {
			err = fmt.Errorf("upload %q, want %q", upload.ID, uploadID)
		}
		return err
	})
	check("CreateDocument", time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if uploadID == "" {
			return errors.New("no upload: CreateUpload failed")
		}
		result, err := documents.CreateDocument(ctx, client, knowledgeBaseID, uploadID)
		if err != nil {
			return err
		}
		if result.Document.ID == "" || result.Document.Folder != folder {
			return fmt.Errorf("document %q in folder %q, want folder %q", result.Document.ID, result.Document.Folder, folder)
		}
		documentID = result.Document.ID
		created = append(created, documentID)
		return nil
	})
	// A document still being processed cannot be deleted yet: 409 CONFLICT. A third document is deleted the moment it
	// is created, while it is pending. A one-page PDF can index quickly, so if it has already finished processing, the
	// delete is accepted instead; that passes too, and says so on stderr. The clean-up deletes it once it is indexed.
	check("DeleteDocument.processing", time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		third, err := createDocument(ctx, client, knowledgeBaseID, folder, name+"-3.pdf")
		if err != nil {
			return fmt.Errorf("create the third document: %w", err)
		}
		created = append(created, third)
		deleted, err := client.Documents.Delete(ctx, &caitlyn.DeleteDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: third})
		var conflict *caitlyn.ConflictError
		switch {
		case errors.As(err, &conflict):
			if conflict.Code != "CONFLICT" {
				return fmt.Errorf("409 with code %q", conflict.Code)
			}
			return nil
		case err != nil:
			return err
		case deleted.Status != caitlyn.DocumentStatusDeleting:
			return fmt.Errorf("the delete was neither refused nor accepted: %s", deleted.Status)
		}
		fmt.Fprintln(os.Stderr, "DeleteDocument.processing:", third, "had already finished processing; the delete was accepted")
		return nil
	})
	check("GetDocument", 30*time.Second, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if documentID == "" {
			return errors.New("no document: CreateDocument failed")
		}
		document, err := documents.GetDocument(ctx, client, knowledgeBaseID, documentID)
		if err == nil && document.ID != documentID {
			err = fmt.Errorf("document %q, want %q", document.ID, documentID)
		}
		return err
	})
	check("WaitUntilIndexed", 21*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if documentID == "" {
			return errors.New("no document: CreateDocument failed")
		}
		document, err := documents.WaitUntilIndexed(ctx, client, knowledgeBaseID, documentID)
		if err == nil && document.Status != caitlyn.DocumentStatusIndexed && document.Status != caitlyn.DocumentStatusPartiallyIndexed {
			err = fmt.Errorf("the wait ended at %s", document.Status)
		}
		return err
	})
	check("ListDocuments", time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		// Whatever its status (it may still be queued): it is listed among the folder's documents, which may include
		// other runs' leftovers.
		listed, err := documents.ListDocuments(ctx, client, knowledgeBaseID)
		if err != nil {
			return err
		}
		if documentID != "" && !slices.ContainsFunc(listed, func(d caitlyn.Document) bool { return d.ID == documentID }) {
			return fmt.Errorf("%d documents in %s, none of them %s", len(listed), folder, documentID)
		}
		return nil
	})

	deleted := false
	check("DeleteDocument", time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if documentID == "" {
			return errors.New("no document: CreateDocument failed")
		}
		result, err := documents.DeleteDocument(ctx, client, knowledgeBaseID, documentID)
		if err != nil {
			return err
		}
		if result.ID != documentID || result.Status != caitlyn.DocumentStatusDeleting {
			return fmt.Errorf("document %q is %s, want %s deleting", result.ID, result.Status, documentID)
		}
		deleted = true
		return nil
	})
	check("BatchDeleteDocuments", 20*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		// A second document of its own, from a new upload.
		second, err := createDocument(ctx, client, knowledgeBaseID, folder, name+"-2.pdf")
		if err != nil {
			return fmt.Errorf("create the second document: %w", err)
		}
		created = append(created, second)
		// Only a document that has finished processing can be deleted
		if _, err := client.Documents.WaitUntilIndexed(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: second}); err != nil {
			return fmt.Errorf("the second document was not indexed: %w", err)
		}
		absent := "doc-" + unique() // an identifier that does not exist
		stopLogging := logStatusChanges(ctx, client, knowledgeBaseID, second)
		defer stopLogging()
		results, err := documents.BatchDeleteDocuments(ctx, client, knowledgeBaseID, []string{second, absent})
		if err != nil {
			return err
		}
		if len(results) != 2 || results[0].DocumentID != second || results[0].Status != caitlyn.DocumentDeleteStatusAccepted ||
			results[1].DocumentID != absent || results[1].Status != caitlyn.DocumentDeleteStatusFailed || results[1].Code == nil || *results[1].Code != "NOT_FOUND" {
			return fmt.Errorf("results %+v, want %s accepted then %s failed with NOT_FOUND", results, second, absent)
		}
		if err := documents.WaitUntilDeleted(ctx, client, knowledgeBaseID, second); err != nil {
			return fmt.Errorf("the batch-deleted document is not gone: %w", err)
		}
		forget(second)
		return nil
	})
	check("WaitUntilDeleted", 16*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if !deleted {
			return errors.New("nothing deleted: DeleteDocument failed")
		}
		if err := documents.WaitUntilDeleted(ctx, client, knowledgeBaseID, documentID); err != nil {
			return err
		}
		forget(documentID)
		return nil
	})
}

// createDocument uploads the leave policy PDF as fileName and makes a document of it in folder, returning its ID.
func createDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, folder, fileName string) (string, error) {
	file, err := caitlyn.FileFromPath(leavePolicy)
	if err != nil {
		return "", err
	}
	file.Name = fileName
	upload, err := client.Uploads.Create(ctx, file)
	if err != nil {
		return "", err
	}
	result, err := client.Documents.Create(ctx, &caitlyn.CreateDocumentInput{KnowledgeBaseID: knowledgeBaseID, UploadID: upload.ID, Folder: folder})
	if err != nil {
		return "", err
	}
	return result.Document.ID, nil
}

// unique is a name part no other run shares: the time to the second, and random hex.
func unique() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return strings.ToLower(time.Now().UTC().Format("20060102-150405")) + "-" + hex.EncodeToString(b)
}

// logStatusChanges is diagnostics, not a check: it prints each change in a document's status to standard error,
// read every 15 s until stopped or ctx ends, so a delete that does not finish shows what the document did instead.
func logStatusChanges(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		started, last := time.Now(), ""
		for {
			now := ""
			d, err := client.Documents.Get(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: knowledgeBaseID, DocumentID: documentID})
			var notFound *caitlyn.NotFoundError
			switch {
			case ctx.Err() != nil:
				return
			case errors.As(err, &notFound):
				now = "404"
			case err != nil:
				now = fmt.Sprintf("error %T", err)
			default:
				parts := []string{string(d.Status)}
				if d.Stage != nil {
					parts = append(parts, *d.Stage)
				}
				if d.Failure != nil {
					parts = append(parts, string(d.Failure.Code))
				}
				now = strings.Join(parts, " ")
			}
			if now != last {
				fmt.Fprintf(os.Stderr, "status: %s at %d s: %s\n", documentID, int(time.Since(started).Seconds()), now)
				last = now
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(15 * time.Second):
			}
		}
	}()
	return cancel
}
