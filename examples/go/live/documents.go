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
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/examples/go/documents"
	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// leavePolicy is the one-page leave policy the checks load (examples/fixtures/leave-policy.pdf): a file type a
// knowledge base can ingest, and text an agent could answer from.
var leavePolicy = func() string {
	_, here, _, _ := runtime.Caller(0) // examples/go/live/documents.go
	return filepath.Join(filepath.Dir(here), "..", "..", "fixtures", "leave-policy.pdf")
}()

// documentChecks loads a document into CAITLYN_KNOWLEDGE_BASE_ID with the docs' code in examples/go/documents:
// SendUpload, GetUpload, AddDocument (create, then wait), GetDocument, WatchDocument, ListDocuments, ReplaceDocument
// and BatchDeleteDocuments, in that order.
func documentChecks(client *caitlyn.Client, check func(string, time.Duration, func(context.Context) error)) {
	knowledgeBaseID := strings.TrimSpace(os.Getenv("CAITLYN_KNOWLEDGE_BASE_ID")) // empty means unset
	missing := skip("no knowledge base configured: CAITLYN_KNOWLEDGE_BASE_ID is not set")
	name := "leave-policy-" + unique()

	// Every document the run creates and has not seen gone; deleted together at the end, whatever happened.
	var created []string
	defer func() {
		if knowledgeBaseID == "" || len(created) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 31*time.Minute)
		defer cancel()
		kb := client.KnowledgeBase(knowledgeBaseID)
		// A document still being processed is deleted too: its processing stops.
		for _, id := range created {
			deleted, err := kb.Document(id).Delete(ctx)
			if err == nil {
				err = deleted.Wait(ctx)
			}
			if err != nil && !isNotFound(err) {
				fmt.Fprintln(os.Stderr, "live: clean-up: document", id, "is not gone:", err)
			}
		}
	}()

	// The regions take the file's name from its path, so copy the PDF to a path with the run's name.
	copyPDF := func(suffix string) (string, error) {
		path := filepath.Join(os.TempDir(), name+suffix+".pdf")
		data, err := os.ReadFile(leavePolicy)
		if err != nil {
			return "", err
		}
		return path, os.WriteFile(path, data, 0o600)
	}

	var uploadID, documentID string
	check("CreateUpload", time.Minute, func(ctx context.Context) error {
		path, err := copyPDF("")
		if err != nil {
			return err
		}
		defer os.Remove(path)
		upload, err := documents.SendUpload(ctx, client, path)
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
	check("CreateDocument", 21*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		path, err := copyPDF("-added")
		if err != nil {
			return err
		}
		defer os.Remove(path)
		document, err := documents.AddDocument(ctx, client, knowledgeBaseID, path)
		if document != nil {
			documentID = document.ID
			created = append(created, documentID)
		}
		if err == nil && document.Status != caitlyn.DocumentStatusIndexed && document.Status != caitlyn.DocumentStatusPartiallyIndexed {
			err = fmt.Errorf("the wait ended at %s", document.Status)
		}
		return err
	})
	// A document still being processed can be deleted: the delete is accepted, its processing stops, the delete's wait
	// ends when it is gone, and it does not come back.
	check("DeleteDocument.processing", 16*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		path, err := copyPDF("-3")
		if err != nil {
			return err
		}
		defer os.Remove(path)
		kb := client.KnowledgeBase(knowledgeBaseID)
		created, err := kb.Documents.Create(ctx, caitlyn.Path(path), &caitlyn.CreateDocumentInput{Folder: "/policies/"})
		if err != nil {
			return fmt.Errorf("create the document: %w", err)
		}
		third := created.ID()
		deleted, err := kb.Document(third).Delete(ctx)
		if err != nil {
			return fmt.Errorf("the delete was refused: %w", err)
		}
		if err := deleted.Wait(ctx); err != nil {
			return fmt.Errorf("the delete's wait: %w", err)
		}
		if _, err := kb.Document(third).Get(ctx); !isNotFound(err) {
			return fmt.Errorf("after the delete, reading it gave %v, want a 404", err)
		}
		for d, err := range kb.Documents.List(ctx, &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/")}) {
			if err != nil {
				return err
			}
			if d.ID == third {
				return fmt.Errorf("%s came back in ListDocuments", third)
			}
		}
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
	check("Document.wait", 21*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if documentID == "" {
			return errors.New("no document: CreateDocument failed")
		}
		document, err := documents.WatchDocument(ctx, client, knowledgeBaseID, documentID)
		if err == nil && document.ID != documentID {
			err = fmt.Errorf("document %q, want %q", document.ID, documentID)
		}
		return err
	})
	check("ListDocuments", time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		listed, err := documents.ListDocuments(ctx, client, knowledgeBaseID)
		if err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "ListDocuments:", len(listed), "documents in /policies/")
		return nil
	})
	check("CreateDocumentVersion", 21*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if documentID == "" {
			return errors.New("no document: CreateDocument failed")
		}
		path, err := copyPDF("-2027")
		if err != nil {
			return err
		}
		defer os.Remove(path)
		document, err := documents.ReplaceDocument(ctx, client, knowledgeBaseID, documentID, path)
		if err == nil && document.ID != documentID {
			err = fmt.Errorf("document %q, want %q", document.ID, documentID)
		}
		return err
	})
	// The docs' delete-document and wait-until-deleted regions, on the document CreateDocument made.
	var deleted *caitlyn.DeleteDocumentStarted
	check("DeleteDocument", time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if documentID == "" {
			return errors.New("no document: CreateDocument failed")
		}
		started, err := documents.DeleteDocument(ctx, client, knowledgeBaseID, documentID)
		if err != nil {
			return fmt.Errorf("the delete was refused: %w", err)
		}
		if started.Result.ID != documentID {
			return fmt.Errorf("deleted %q, want %q", started.Result.ID, documentID)
		}
		deleted = started
		return nil
	})
	check("DeleteDocument.wait", 16*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		if deleted == nil {
			return errors.New("nothing deleted: DeleteDocument failed")
		}
		if err := documents.WaitUntilDeleted(ctx, deleted); err != nil {
			return err
		}
		if _, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Get(ctx); !isNotFound(err) {
			return fmt.Errorf("after the delete, reading it gave %v, want a 404", err)
		}
		return nil
	})
	check("BatchDeleteDocuments", 20*time.Minute, func(ctx context.Context) error {
		if knowledgeBaseID == "" {
			return missing
		}
		// A document of its own, as the first is deleted above.
		path, err := copyPDF("-2")
		if err != nil {
			return err
		}
		defer os.Remove(path)
		second, err := client.KnowledgeBase(knowledgeBaseID).Documents.Create(ctx, caitlyn.Path(path), &caitlyn.CreateDocumentInput{Folder: "/policies/"})
		if err != nil {
			return fmt.Errorf("create the second document: %w", err)
		}
		created = append(created, second.ID())
		absent := "doc-" + unique() // an identifier that does not exist
		results, err := documents.BatchDeleteDocuments(ctx, client, knowledgeBaseID, []string{second.ID(), absent})
		if err != nil {
			return err
		}
		if len(results) != 2 || results[0].DocumentID != second.ID() || results[0].Status != caitlyn.DocumentDeleteStatusAccepted ||
			results[1].DocumentID != absent || results[1].Status != caitlyn.DocumentDeleteStatusFailed || results[1].Code == nil || *results[1].Code != "NOT_FOUND" {
			return fmt.Errorf("results %+v, want %s accepted then %s failed with NOT_FOUND", results, second.ID(), absent)
		}
		return nil
	})
}

// isNotFound reports whether err is a 404: a thing already gone.
func isNotFound(err error) bool {
	var notFound *caitlyn.NotFoundError
	return errors.As(err, &notFound)
}

// unique is a name part no other run shares: the time to the second, and random hex.
func unique() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return strings.ToLower(time.Now().UTC().Format("20060102-150405")) + "-" + hex.EncodeToString(b)
}
