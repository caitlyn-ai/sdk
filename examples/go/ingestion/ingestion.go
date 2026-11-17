// Package ingestion holds the Go code of the guide "How ingestion works", one region each, with the region names every
// language's examples share: a sync with its confirm step and report, a batch built by hand, following and resuming a
// batch, and stopping one. scripts/test-go.sh builds and vets it.
package ingestion

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"time"

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// SyncWithConfirm syncs a folder, asking before anything is uploaded, and reads the report.
func SyncWithConfirm(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, dir string) (*caitlyn.SyncReport, error) {
	// #region sync-with-confirm
	report, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
		Folder:        "/policies/",
		RemoveMissing: true,
		// Called once with the plan, before anything is uploaded: false cancels the batch
		Confirm: func(_ context.Context, plan *caitlyn.SyncPlan) (bool, error) {
			e := plan.Estimate
			if e == nil { // nothing needs its bytes
				return true, nil
			}
			fmt.Println(len(plan.Items), "items,", e.Documents, "to process, up to", e.DurationSeconds.High, "s")
			if e.Cost != nil { // only for callers who may see cost
				fmt.Println(e.Cost.Low, "to", e.Cost.High, e.Cost.Unit)
			}
			return e.Documents < 500, nil
		},
		// Called once for each item, when its status is final
		OnItem: func(item caitlyn.IngestionBatchItem) { fmt.Println(*item.Path, item.Status) },
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(report.Batch.Status) // succeeded, or completed_with_failures
	for _, item := range report.Items {
		if item.Status == caitlyn.IngestionItemStatusFailed {
			fmt.Println(*item.Path, *item.FailureCode) // FailureDetail says what to do
		}
	}
	// #endregion
	return report, nil
}

// BatchFailures lists the failed items of a batch that ended completed_with_failures.
func BatchFailures(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, batchID string) error {
	// #region batch-failures
	batch := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID)
	failed := &caitlyn.ListIngestionBatchItemsInput{Status: caitlyn.Ptr(caitlyn.IngestionItemStatusFailed)}
	for item, err := range batch.Items.List(ctx, failed) {
		if err != nil {
			return err
		}
		fmt.Println(*item.Path, *item.FailureCode) // FailureDetail says what to do
	}
	// #endregion
	return nil
}

// BuildBatch builds a batch by hand from files on disk, each with its own metadata: it prices the upload, starts the
// batch, uploads the files and waits for the batch to finish. files maps each document's path to its file.
func BuildBatch(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string, files map[string]string) (*caitlyn.IngestionBatch, error) {
	// #region build-batch
	// One item a file: its document path, checksum, size and content type, as the batch plans from them
	var items []caitlyn.IngestionItemInput
	upload := map[string]caitlyn.File{}
	for docPath, local := range files {
		data, err := os.ReadFile(local)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		items = append(items, caitlyn.IngestionItemInput{
			Path:        caitlyn.Ptr(docPath),
			SHA256:      caitlyn.Ptr(base64.StdEncoding.EncodeToString(sum[:])),
			ByteSize:    caitlyn.Ptr(int64(len(data))),
			ContentType: caitlyn.Ptr("application/pdf"),
			Metadata:    map[string]any{"owner": "hr"},
		})
		upload[docPath] = caitlyn.Path(local)
	}
	batch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batches.Create(ctx, &caitlyn.CreateIngestionBatchInput{
		Start: caitlyn.Ptr(caitlyn.StartModeManual), // wait for Start rather than starting once planned
		Items: items,
	})
	if err != nil {
		return nil, err
	}
	// Waits until the batch is planned, then prices the items that need their bytes, from the files' sizes (and any
	// hints given with caitlyn.WithHints): nothing is uploaded or hashed
	estimate, err := batch.EstimateUpload(ctx, caitlyn.FilesByPath(upload))
	if err != nil {
		return nil, err
	}
	fmt.Println(estimate.Documents, estimate.DurationSeconds.High, "seconds at most")
	if _, err := batch.Start(ctx); err != nil { // starts the batch as it stands
		return nil, err
	}
	sent, err := batch.Upload(ctx, caitlyn.FilesByPath(upload), nil)
	if err != nil {
		return nil, err
	}
	fmt.Println(len(sent.Result.Items), "uploaded;", sent.Result.NotGiven, "left awaiting their files")
	done, err := sent.Wait(ctx) // the batch, once it has finished
	if err != nil {
		return nil, err
	}
	fmt.Println(done.Status)
	// #endregion
	return done, nil
}

// AddBatchItems makes a batch with more items than one call takes: it stays a draft until the last call.
func AddBatchItems(ctx context.Context, client *caitlyn.Client, knowledgeBaseID string, first, rest []caitlyn.IngestionItemInput) error {
	// #region add-batch-items
	batch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batches.Create(ctx, &caitlyn.CreateIngestionBatchInput{
		Start:          caitlyn.Ptr(caitlyn.StartModeManual),
		AwaitMoreItems: caitlyn.Ptr(true),
		Items:          first,
	})
	if err != nil {
		return err
	}
	// Last ends the draft, and planning starts
	added, err := client.Core.Ingestion.AddItems(ctx, knowledgeBaseID, batch.ID(), &caitlyn.BatchCreateIngestionBatchItemsInput{
		Items: rest,
		Last:  caitlyn.Ptr(true),
	})
	if err != nil {
		return err
	}
	for _, r := range added.Results {
		if r.Status == caitlyn.ItemCreateStatusFailed {
			fmt.Println("item", r.Index, *r.Code)
		}
	}
	// #endregion
	return nil
}

// FollowBatch follows a batch from its identifier alone, after a page reload or a restart.
func FollowBatch(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, batchID string) (*caitlyn.IngestionBatch, error) {
	// #region follow-batch
	// The batch's running job as it stands, then at each change; the percentage never goes backwards. Past the time
	// limit, the error is an *Error with the code WAIT_TIMEOUT, and errors.Is(err, context.DeadlineExceeded) holds.
	batch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID).Wait(ctx,
		caitlyn.WithProgress(func(p caitlyn.Processing) {
			if p.Percent != nil {
				fmt.Println(*p.Percent, "%")
			}
		}),
		caitlyn.WithTimeLimit(time.Hour),
	)
	if err != nil {
		return nil, err
	}
	fmt.Println(batch.Status) // succeeded, or completed_with_failures
	// #endregion
	return batch, nil
}

// WatchBatch reads the raw watch under Wait: a snapshot first, then each change.
func WatchBatch(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, batchID string) error {
	// #region watch-batch
	watch, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID).Watch(ctx)
	if err != nil {
		return err
	}
	defer watch.Close()
	for event, err := range watch.Events() {
		if err != nil {
			return err
		}
		// The same in the snapshot and in each job.progress event
		if p := event.GetProcessing(); p != nil && p.Percent != nil {
			fmt.Println(*p.Percent, "%")
		}
		if event.EventType() == "job.finished" {
			break
		}
	}
	// #endregion
	return nil
}

// CancelSync stops a sync part way: the error carries the report so far.
func CancelSync(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, dir string) error {
	// #region cancel-sync
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	_, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
		Folder:          "/policies/",
		CancelIngestion: true, // also stop ingestion already running
	})
	var cancelled *caitlyn.SyncCancelledError // errors.Is(err, context.DeadlineExceeded) holds too
	if errors.As(err, &cancelled) {
		for _, item := range cancelled.Report.Items { // every item with its last status
			fmt.Println(*item.Path, item.Status)
		}
		return nil
	}
	// #endregion
	return err
}

// SyncDeclined handles a plan the confirm step declines: CANCELLED, with the plan's items in the report.
func SyncDeclined(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, dir string) error {
	// #region sync-declined
	_, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Sync(ctx, caitlyn.Dir(dir), &caitlyn.SyncOptions{
		Folder: "/policies/",
		Confirm: func(_ context.Context, plan *caitlyn.SyncPlan) (bool, error) {
			return plan.Estimate == nil || plan.Estimate.Cost == nil, nil
		},
	})
	var declined *caitlyn.SyncDeclinedError // an *Error with the code CANCELLED; not context.Canceled
	if errors.As(err, &declined) {
		fmt.Println("Not started; the batch is", declined.Report.Batch.Status)
		return nil
	}
	// #endregion
	return err
}

// CancelBatch cancels a batch, also stopping ingestion already running.
func CancelBatch(ctx context.Context, client *caitlyn.Client, knowledgeBaseID, batchID string) error {
	// #region cancel-batch
	// Without StopRunning, items already being ingested finish; with it, they stop too
	_, err := client.KnowledgeBase(knowledgeBaseID).Ingestion.Batch(batchID).Cancel(ctx, &caitlyn.CancelIngestionBatchInput{StopRunning: caitlyn.Ptr(true)})
	// #endregion
	return err
}
