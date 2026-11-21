// Package documents holds the developer docs' Go code for knowledge bases and their documents, one region each: the
// jobs on the landing page (add a document, keep a folder in step, replace, watch, restrict access, watch a knowledge
// base, delete things, and the jobs that have a cost, with their estimates), and the building blocks under them. The
// live examples (examples/go/live, run by scripts/examples-live/go.sh) call these functions against a real Caitlyn
// workspace, so the code on the pages is known to work. scripts/test-go.sh builds and vets it.
package documents

import (
	"context"
	"fmt"
	"net/http"
	"time"

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// AddDocument adds a file on disk to a knowledge base's /hr/ folder and waits until it can be searched (spec job 1).
func AddDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, path string) (*caitlyn.Document, error) {
	// #region add-document
	kb := client.KnowledgeBase(knowledgeBaseID)
	// PDF, Word (.docx), Markdown, images, audio or video; the content type comes from the extension. The SDK hashes
	// the file and uploads it straight to storage: no Caitlyn credentials go with the bytes.
	doc, err := kb.Documents.Create(ctx, caitlyn.Path(path), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
	if err != nil {
		return nil, err
	}
	// doc is the new document's scope; Wait follows its ingestion until it can be searched
	indexed, err := doc.Wait(ctx)
	if err != nil {
		return nil, err // a failed ingestion is its typed error, such as *caitlyn.UnprocessableContentError
	}
	fmt.Println(indexed.ID, indexed.Status)
	// #endregion
	return indexed, nil
}

// SyncFolder keeps a knowledge base's /policies/ folder in step with a folder on disk, in one ingestion batch (spec
// job 2).
func SyncFolder(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, dir string) (*caitlyn.SyncReport, error) {
	// #region sync-folder
	report, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
		Folder:        "/policies/", // where the files go; files are keyed by their path in dir
		RemoveMissing: true,         // documents under /policies/ with no file are removed
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(report.Batch.Status)
	for _, item := range report.Items {
		fmt.Println(*item.Path, item.Status, item.FailureCode)
	}
	// #endregion
	return report, nil
}

// SyncEstimate says what keeping the folder in step will do and cost, before anything is uploaded.
func SyncEstimate(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, dir string) (*caitlyn.SyncPlan, error) {
	// #region sync-estimate
	plan, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.EstimateSync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
		Folder:        "/policies/",
		RemoveMissing: true,
	})
	if err != nil {
		return nil, err
	}
	for _, item := range plan.Items {
		fmt.Println(*item.Path, *item.Outcome) // new, changed, unchanged, moved, to_remove…
	}
	if e := plan.Estimate; e != nil && e.Cost != nil { // cost only for callers who may see it
		switch e.Cost.Unit { // the form the organisation sees its costs in
		case caitlyn.CostUnitUsd:
			fmt.Printf("%d documents, US$%.2f–%.2f\n", e.Documents, e.Cost.Low, e.Cost.High)
		case caitlyn.CostUnitPercentOfPlan:
			fmt.Printf("%d documents, %.1f–%.1f%% of usage\n", e.Documents, e.Cost.Low, e.Cost.High)
		default:
			fmt.Printf("%d documents, %.2f–%.2f %s\n", e.Documents, e.Cost.Low, e.Cost.High, e.Cost.Unit)
		}
	}
	// #endregion
	return plan, nil
}

// ReplaceDocument adds a new version of a document from a file: the document keeps its id and history (spec job 3).
func ReplaceDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID, path string) (*caitlyn.Document, error) {
	// #region replace-document
	replaced, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Replace(ctx, caitlyn.Path(path), nil)
	if err != nil {
		return nil, err // a *caitlyn.ConflictError while an earlier version is still processing
	}
	// The current version keeps answering until the new one is indexed
	indexed, err := replaced.Wait(ctx)
	if err != nil {
		return nil, err
	}
	fmt.Println(replaced.Result.Result, indexed.Status) // created, unchanged or restored
	// #endregion
	return indexed, nil
}

// WatchDocument follows a document's processing until it can be searched, including after a page reload (spec job 4).
func WatchDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (*caitlyn.Document, error) {
	// #region watch-document
	// Called with the document's processing as it stands, then at each change; the percentage never goes backwards,
	// and Wait returns the document once it can be searched
	document, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Wait(ctx, caitlyn.WithProgress(func(p caitlyn.Processing) {
		fmt.Println(*p.Stage, *p.Percent, p.Eta)
	}))
	if err != nil {
		return nil, err
	}
	fmt.Println(document.Status)
	// #endregion
	return document, nil
}

// SetAccess restricts who reads a folder, and gives a document its folder's readers again (spec job 5).
func SetAccess(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID, etag string) error {
	// #region set-access
	kb := client.KnowledgeBase(knowledgeBaseID)
	// ReadersOf(roles, people), ReadersEveryone, ReadersPublic or ReadersInherit
	if _, err := kb.Folder("/hr/investigations/").Access.Set(ctx, &caitlyn.PutAccessInput{
		Readers: caitlyn.ReadersOf([]string{"hr-team"}, nil),
	}); err != nil {
		return err
	}
	// A guarded write: with the ETag you read, a change someone made since is refused (*caitlyn.PreconditionFailedError)
	if _, err := kb.Document(documentID).Access.Set(ctx, &caitlyn.PutAccessInput{Readers: caitlyn.ReadersInherit()},
		caitlyn.WithIfMatch(etag)); err != nil {
		return err
	}
	// #endregion
	// #region readers-values
	// The four kinds of readers, widest first
	for folder, readers := range map[string]*caitlyn.Readers{
		"/handbook/":    caitlyn.ReadersPublic(),
		"/staff/":       caitlyn.ReadersEveryone(),
		"/hr/":          caitlyn.ReadersOf([]string{"hr-team"}, []string{"u-1"}),
		"/hr/handbook/": caitlyn.ReadersInherit(),
	} {
		if _, err := kb.Folder(folder).Access.Set(ctx, &caitlyn.PutAccessInput{Readers: readers}); err != nil {
			return err
		}
	}
	// #endregion
	return nil
}

// WatchKnowledgeBase follows everything that changes in a knowledge base (spec job 9).
func WatchKnowledgeBase(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string) error {
	// #region watch-knowledge-base
	watch, err := client.KnowledgeBase(knowledgeBaseID).Watch(ctx)
	if err != nil {
		return err
	}
	defer watch.Close()
	for event, err := range watch.Events() {
		if err != nil {
			return err
		}
		switch e := event.(type) {
		case *caitlyn.KnowledgeBaseSnapshot:
			fmt.Println(e.KnowledgeBase.Name, len(e.Jobs), "jobs") // the knowledge base as it stands, its jobs included
		default:
			fmt.Println(event.EventType()) // document.updated, document.progress, job.progress, …
		}
	}
	// #endregion
	return nil
}

// DeleteThings deletes a document, a folder, a knowledge base and an agent (spec job 10).
func DeleteThings(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID, agentID string) error {
	// #region delete-things
	kb := client.KnowledgeBase(knowledgeBaseID)
	if _, err := kb.Document(documentID).Delete(ctx); err != nil {
		return err
	}
	folder, err := kb.Folder("/archive/").Delete(ctx)
	if err != nil {
		return err
	}
	if err := folder.Wait(ctx); err != nil { // nil once the folder and its documents are gone
		return err
	}
	deleted, err := kb.Delete(ctx)
	if err != nil {
		return err
	}
	if err := deleted.Wait(ctx); err != nil {
		return err
	}
	if _, err := client.Agent(agentID).Delete(ctx); err != nil {
		return err
	}
	// #endregion
	return nil
}

// FillInFields estimates, then runs, a fill-in of a metadata field across a knowledge base.
func FillInFields(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string) (*caitlyn.Job, error) {
	// #region fill-in-fields
	fields := client.KnowledgeBase(knowledgeBaseID).Fields
	keys := &caitlyn.FillInFieldsInput{Keys: []string{"policyOwner"}}
	estimate, err := fields.EstimateFillIn(ctx, keys) // the same arguments; nothing starts
	if err != nil {
		return nil, err
	}
	if estimate.Cost != nil {
		switch estimate.Cost.Unit { // the form the organisation sees its costs in
		case caitlyn.CostUnitUsd:
			fmt.Printf("%d documents, US$%.2f–%.2f\n", estimate.Documents, estimate.Cost.Low, estimate.Cost.High)
		case caitlyn.CostUnitPercentOfPlan:
			fmt.Printf("%d documents, %.1f–%.1f%% of usage\n", estimate.Documents, estimate.Cost.Low, estimate.Cost.High)
		default:
			fmt.Printf("%d documents, %.2f–%.2f %s\n", estimate.Documents, estimate.Cost.Low, estimate.Cost.High, estimate.Cost.Unit)
		}
	}
	started, err := fields.FillIn(ctx, keys)
	if err != nil {
		return nil, err
	}
	job, err := started.Wait(ctx) // the job once it ends
	if err != nil {
		return nil, err
	}
	fmt.Println(job.Status, job.PartialFailures)
	// #endregion
	return job, nil
}

// Reprocess brings out-of-date documents up to the newest processing.
func Reprocess(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string) (*caitlyn.Job, error) {
	// #region reprocess
	documents := client.KnowledgeBase(knowledgeBaseID).Documents
	outOfDate := &caitlyn.ReprocessDocumentsInput{OutOfDate: caitlyn.Ptr(true)}
	estimate, err := documents.EstimateReprocess(ctx, outOfDate)
	if err != nil {
		return nil, err
	}
	fmt.Println(estimate.Documents, estimate.DurationSeconds.Low, estimate.DurationSeconds.High)
	started, err := documents.Reprocess(ctx, outOfDate)
	if err != nil {
		return nil, err
	}
	// #endregion
	return started.Wait(ctx)
}

// LayoutAwareSearch turns on layout-aware search for a knowledge base.
func LayoutAwareSearch(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string) (*caitlyn.Job, error) {
	// #region layout-aware-search
	search := client.KnowledgeBase(knowledgeBaseID).LayoutAwareSearch
	estimate, err := search.EstimateEnable(ctx)
	if err != nil {
		return nil, err
	}
	fmt.Println(estimate.Documents, estimate.DurationSeconds.High)
	enabled, err := search.Enable(ctx)
	if err != nil {
		return nil, err
	}
	// #endregion
	return enabled.Wait(ctx, caitlyn.WithTimeLimit(2*time.Hour))
}

// SendUpload sends a file's bytes to Caitlyn as an upload, the building block the calls above are made from.
func SendUpload(ctx context.Context, client *caitlyn.Client, path string) (*caitlyn.CreateUploadResult, error) {
	// #region send-upload
	// Reserves an upload, then sends the bytes straight to storage: no Caitlyn credentials go with them.
	// nil is the purpose: an upload for a document
	upload, err := client.Core.Uploads.Send(ctx, caitlyn.Path(path), nil)
	if err != nil {
		return nil, err
	}
	fmt.Println(upload.ID, upload.ExpiresAt) // use it in place of a file (caitlyn.UploadID) before it expires
	// #endregion
	return upload, nil
}

// CreateDocumentFromFile adds a file on disk to a knowledge base's /policies/ folder in one call.
func CreateDocumentFromFile(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, path string) (*caitlyn.CreatedDocument, error) {
	// #region add-document-from-file
	// PDF, Word (.docx), Markdown, images, audio or video; the content type comes from the extension. The SDK hashes
	// the file and uploads it straight to storage (no Caitlyn credentials go with the bytes), then creates the
	// document from the upload.
	created, err := client.KnowledgeBase(knowledgeBaseID).Documents.Create(ctx, caitlyn.Path(path), &caitlyn.CreateDocumentInput{
		Folder: "/policies/", // from the root, starting and ending in /
		// Name defaults to the file's name
	})
	if err != nil {
		return nil, err
	}
	// Indexing carries on after the call returns: created.Wait(ctx) waits for it
	fmt.Println(created.ID(), created.Result.Document.Status, created.Result.Operation.ID)
	// #endregion
	return created, nil
}

// WaitUntilIndexed waits for a document to become searchable, after a page reload as much as after creating it.
func WaitUntilIndexed(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (*caitlyn.Document, error) {
	// #region wait-for-processing
	// Follows the document's watch until nothing is running on it, then reads it. A failed ingestion is its typed
	// error; WithTimeLimit bounds the wait (an *Error with the code WAIT_TIMEOUT), and there is no default.
	document, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Wait(ctx, caitlyn.WithTimeLimit(20*time.Minute))
	if err != nil {
		return nil, err
	}
	fmt.Println(document.Name, document.Status)
	// #endregion
	return document, nil
}

// IngestFolder keeps a knowledge base's /policies/ folder in step with a folder on disk, in one ingestion batch.
func IngestFolder(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, dir string) (*caitlyn.SyncReport, error) {
	// #region sync-folder-with-policy
	report, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
		Folder:        "/policies/", // where the files go; symbolic links are not followed, a .caitlynignore leaves files out
		Exclude:       []string{"drafts/"},
		RemoveMissing: true, // documents under /policies/ with no file are removed
		Policy: &caitlyn.IngestionPolicy{
			OnConflict: &caitlyn.ConflictRules{Default: caitlyn.Ptr(caitlyn.ConflictRuleNewVersion)},
		},
		// Anything the policy leaves unresolved is asked about here; without Resolve, Sync stops with
		// INGESTION_BATCH_UNRESOLVED and leaves the batch planned
		Resolve: func(_ context.Context, item caitlyn.IngestionBatchItem) (caitlyn.IngestionItemResolution, error) {
			return caitlyn.IngestionItemResolutionSkip, nil
		},
		OnProgress: func(p caitlyn.IngestionProgress) { fmt.Println(p.Phase, p.Done, "of", p.Total) },
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(report.Batch.Status)
	for _, item := range report.Items {
		fmt.Println(*item.Path, item.Status, item.FailureCode)
	}
	// #endregion
	return report, nil
}

// DeleteDocument deletes a document, even one still being processed: its processing stops.
func DeleteDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (*caitlyn.DeleteDocumentStarted, error) {
	// #region delete-document
	deleted, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Delete(ctx)
	if err != nil {
		return nil, err
	}
	fmt.Println(deleted.Result.Name, deleted.Result.Status) // deleting, until it is gone
	// #endregion
	return deleted, nil
}

// WaitUntilDeleted waits until a deleted document is gone.
func WaitUntilDeleted(ctx context.Context, deleted *caitlyn.DeleteDocumentStarted) error {
	// #region wait-for-delete
	// nil once the document is gone; a document still being processed when it was deleted has its processing
	// stopped, which is part of the delete
	if err := deleted.Wait(ctx); err != nil {
		return err
	}
	// #endregion
	return nil
}

// CreateDocumentFromStream adds a file read from a stream, such as an HTTP response, without saving it first.
func CreateDocumentFromStream(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, url string) (*caitlyn.CreatedDocument, error) {
	// #region add-document-from-stream
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	// The stream is read once: kept in memory up to 8 MiB and past that in a temporary file only you can read,
	// removed when the call returns
	file := caitlyn.FileFromReader("q3-report.pdf", res.Body, caitlyn.WithSize(res.ContentLength))
	created, err := client.KnowledgeBase(knowledgeBaseID).Documents.Create(ctx, file, &caitlyn.CreateDocumentInput{Folder: "/finance/"})
	if err != nil {
		return nil, err
	}
	fmt.Println(created.ID(), created.Result.Document.Status)
	// #endregion
	return created, nil
}

// GetUpload checks an upload's status.
func GetUpload(ctx context.Context, client *caitlyn.Client, uploadID string) (*caitlyn.Upload, error) {
	// #region get-upload
	upload, err := client.Core.Upload(uploadID).Get(ctx)
	if err != nil {
		return nil, err
	}
	fmt.Println(upload.Status, upload.ExpiresAt)
	// #endregion
	return upload, nil
}

// GetDocument reads a document's status.
func GetDocument(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, documentID string) (*caitlyn.Document, error) {
	// #region get-document
	document, err := client.KnowledgeBase(knowledgeBaseID).Document(documentID).Get(ctx)
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

// ListDocuments lists the documents in the /policies/ folder.
func ListDocuments(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string) ([]caitlyn.Document, error) {
	// #region list-documents
	// Every document in the folder, newest first: the next page is fetched as the loop reaches it
	var documents []caitlyn.Document
	input := &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Sort: caitlyn.Ptr("-updatedAt")}
	for document, err := range client.KnowledgeBase(knowledgeBaseID).Documents.List(ctx, input) {
		if err != nil {
			return nil, err
		}
		fmt.Println(document.Name, document.Status)
		documents = append(documents, document)
	}
	// #endregion
	return documents, nil
}

// BatchDeleteDocuments deletes up to 100 documents in one call, with a result for each.
func BatchDeleteDocuments(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string, documentIDs []string) ([]caitlyn.DocumentDeleteResult, error) {
	// #region batch-delete-documents
	// From 1 to 100 identifiers, each at most once. One that cannot be deleted (NOT_FOUND, say) does not stop the
	// others; one still being processed is deleted too, its processing stopped.
	batch, err := client.KnowledgeBase(knowledgeBaseID).Documents.DeleteMany(ctx, &caitlyn.BatchDeleteDocumentsInput{DocumentIDs: documentIDs})
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
