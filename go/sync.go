// This file is hand-written, not generated: kb.Ingestion.Sync and its estimate (PROTOCOL.md 15). The other SDKs keep
// the helper in their runtime core; in Go the core package cannot name the generated types, so the helper is part of
// this package and uses the core for files, form uploads and retries. scripts/generate.sh keeps every file in go/ that
// is not marked as generated.

package caitlyn

import (
	"bufio"
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/caitlyn-ai/sdk/go/core"
)

// Limits Sync works within (PROTOCOL.md 15).
const (
	// SyncItemsPerCall is the most items CreateIngestionBatch and Core.Ingestion.AddItems take in one call.
	SyncItemsPerCall = 10000
	// SyncCompletePerCall is the most items Core.Ingestion.CompleteUploads takes in one call.
	SyncCompletePerCall = 100
	// DefaultSyncConcurrency is how many files Sync uploads at once unless SyncOptions.Concurrency says otherwise.
	DefaultSyncConcurrency = 6
	// SyncPolicyRenewBefore is how close to its expiry an upload policy is renewed, before the next upload starts.
	SyncPolicyRenewBefore = 5 * time.Minute
)

// SyncSource is what Sync keeps a knowledge base in step with: a folder on disk (Dir) or a list of files (Files).
type SyncSource interface {
	isSyncSource()
}

// Dir is a folder on disk for Sync: caitlyn.Dir("./policies"). Symbolic links are not followed; SyncOptions.Include,
// SyncOptions.Exclude and a .caitlynignore file in the folder filter its files.
type Dir string

// Files are files for Sync, each with the path it has relative to SyncOptions.Folder.
type Files []LocalFile

func (Dir) isSyncSource()   {}
func (Files) isSyncSource() {}

// LocalFile is one file Sync sends: where it is (RelativePath, below the Dir or as given in Files), the document path
// it becomes (Path, SyncOptions.Folder followed by RelativePath) and the file (a Path or an *UploadFile).
type LocalFile struct {
	// RelativePath is the file's path relative to the folder, with forward slashes: "hr/leave-policy.pdf". It is also
	// the item's key, unless SyncOptions.ExternalID gives another. Empty means the file's own name.
	RelativePath string
	// Path is the document's path in the knowledge base: "/policies/hr/leave-policy.pdf". Sync fills it in.
	Path string
	// File is the file itself: a Path or an *UploadFile.
	File File
}

// SyncPhase names a step of Sync for IngestionProgress: checksum, planning, planned, upload, queued, processing, then the
// batch's final status (succeeded, completed_with_failures, failed, cancelled).
type SyncPhase string

// The phases Sync reports, in the order they happen; the last is the batch's final status (an IngestionBatchStatus).
const (
	SyncPhaseChecksum   SyncPhase = "checksum"
	SyncPhasePlanning   SyncPhase = "planning"
	SyncPhasePlanned    SyncPhase = "planned"
	SyncPhaseUpload     SyncPhase = "upload"
	SyncPhaseQueued     SyncPhase = "queued"
	SyncPhaseProcessing SyncPhase = "processing"
)

// IngestionProgress is one report to SyncOptions.OnProgress. Done and Total count files (checksum and upload) or items
// (the later phases). In the upload phase BytesSent and BytesTotal count bytes too.
type IngestionProgress struct {
	Phase      SyncPhase
	Done       int
	Total      int
	BytesSent  int64
	BytesTotal int64
	// Item is the item the report is about, when it is about one (an upload that finished).
	Item *IngestionBatchItem
}

// SyncPlan is the plan Sync makes before it uploads anything: the planned batch, every item in it with its outcome
// and resolution, and what the items that need their bytes will take and cost (nil when none do). SyncOptions.Confirm
// sees it, and EstimateSync returns it.
type SyncPlan struct {
	Batch    *IngestionBatch
	Items    []IngestionBatchItem
	Estimate *EstimateIngestionResult
}

// SyncOptions are Sync's options. All are optional.
type SyncOptions struct {
	// Folder is the knowledge base folder the files go to: "/policies/". Defaults to the root, "/".
	Folder string
	// Include, when set, keeps only a Dir's files whose relative path matches one of these globs ("*.pdf", "hr/**").
	Include []string
	// Exclude drops a Dir's files whose relative path matches one of these globs.
	Exclude []string
	// Policy holds the rules that resolve each item's outcome (CreateIngestionBatch's policy).
	Policy *IngestionPolicy
	// ExternalID, SourceURL and Metadata give each item's externalId, sourceUrl and metadata. Each may be nil, and a
	// zero result leaves the member out.
	ExternalID func(LocalFile) string
	SourceURL  func(LocalFile) string
	Metadata   func(LocalFile) map[string]any
	// RemoveMissing adds a remove item for each document under Folder that has no file.
	RemoveMissing bool
	// Confirm, when set, is called with the plan and its estimate before anything is uploaded; false cancels the batch,
	// and Sync returns a *SyncDeclinedError: CANCELLED, with the report.
	Confirm func(ctx context.Context, plan *SyncPlan) (bool, error)
	// Resolve is called for each item the policy left unresolved, and its answer (add, new_version, overwrite, skip…)
	// is sent. Without it, an unresolved item fails Sync with INGESTION_BATCH_UNRESOLVED and the batch stays planned.
	Resolve func(ctx context.Context, item IngestionBatchItem) (IngestionItemResolution, error)
	// Concurrency is how many files are uploaded at once: DefaultSyncConcurrency (6) when 0.
	Concurrency int
	// OnProgress is called as Sync moves through its phases. Calls do not overlap.
	OnProgress func(IngestionProgress)
	// OnItem is called once for each item, only when its status is final (indexed, skipped, moved, updated, removed,
	// cancelled or failed), never when its upload is accepted: an upload that still fails after its retries at once,
	// as failed with UPLOAD_FAILED, and every other item when the batch has finished. When ctx is cancelled, OnItem
	// has had every item that was final before, and no other, and it is never called after Sync returns. Calls do not
	// overlap.
	OnItem func(IngestionBatchItem)
	// CancelIngestion, when Sync is cancelled (its context), also cancels the batch with stopRunning, so ingestion
	// already running stops too.
	CancelIngestion bool
	// WaitOptions bound the waits for the plan and for the end of the batch (WithTimeLimit).
	WaitOptions []WaitOption

	// estimatePerCall replaces the 10,000 documents an EstimateIngestion call takes, when above 0. Only the
	// conformance suite sets it (sync_conformance.go, built with -tags caitlyn_conformance), to price many items
	// without building 10,000 files.
	estimatePerCall int
}

// SyncReport is what Sync returns: the batch as it ended, with its counts, and every item with its outcome,
// resolution, status, document, version and failure.
type SyncReport struct {
	Batch *IngestionBatch
	Items []IngestionBatchItem
}

// Sync keeps the knowledge base in step with a folder of files, or a list of files, through one ingestion batch
// (PROTOCOL.md 15). Files are keyed by their path relative to the folder and go to SyncOptions.Folder ("/" when it is
// empty). It hashes each file; creates the batch to start manually, 10,000 items a call (the last call with last:
// true); waits until it is planned and prices the items that need their bytes; asks Confirm and Resolve; starts the
// batch; uploads each file that needs its bytes under the batch's upload policy, at most Concurrency at once, renewing
// the policy when less than 5 minutes are left; reports the uploads as they finish, 100 a call; waits for the batch to
// finish; and returns the report. Its pricing is batch.EstimateUpload's and its upload batch.Upload's: Sync is hash,
// create, Planned, EstimateUpload, Confirm and Resolve, Start, Upload, Wait.
//
// A file whose upload still fails after its retries fails only its own item, with the code UPLOAD_FAILED (in OnItem and
// the report); the other files carry on. Sync returns an error only when the whole batch stops: planning that ends the
// batch failed returns the batch's failure (its code and message); cancelling ctx stops new uploads, aborts those in
// flight and returns a *SyncCancelledError, which is the context's error and carries the report so far, after
// OnItem has had every item finished before (with CancelIngestion, after
// cancelling the batch too); Confirm returning false cancels the batch and returns a *SyncDeclinedError (CANCELLED, with the report); an item the policy
// left unresolved, with no Resolve, is an *Error with the code INGESTION_BATCH_UNRESOLVED and the batch is left
// planned; and a failed call that creates, plans or starts the batch, or renews its policy, returns its error.
func (s *KnowledgeBaseIngestion) Sync(ctx context.Context, from SyncSource, in *SyncOptions) (*SyncReport, error) {
	r := s.newRun(from, in)
	defer r.close()
	plan, err := r.plan(ctx)
	if err != nil {
		return nil, err
	}
	return r.finish(ctx, plan)
}

// EstimateSync takes Sync's arguments and runs its first steps: it hashes the files, creates the batch and waits until
// it is planned, then prices the items that need their bytes. It uploads nothing and starts nothing; the batch is left
// planned, and expires unless it is started (Batch(plan.Batch.ID).Start).
func (s *KnowledgeBaseIngestion) EstimateSync(ctx context.Context, from SyncSource, in *SyncOptions) (*SyncPlan, error) {
	r := s.newRun(from, in)
	defer r.close()
	return r.plan(ctx)
}

func (s *KnowledgeBaseIngestion) newRun(from SyncSource, in *SyncOptions) *syncRun {
	if in == nil {
		in = &SyncOptions{}
	}
	return &syncRun{c: s.c, kb: s.knowledgeBaseID, from: from, in: in, byPath: map[string]*syncFile{}}
}

type syncFile struct {
	local    LocalFile
	prepared *core.PreparedFile
}

type syncRun struct {
	c      *Client
	kb     string
	from   SyncSource
	in     *SyncOptions
	files  []*syncFile
	byPath map[string]*syncFile

	batch *BatchScope
	etag  string

	progressMu sync.Mutex
	reported   map[string]bool
	// failedHere are the items this call failed itself (an upload that failed): the server still lists them awaiting
	// upload, so the report shows this call's view of them.
	failedHere map[string]IngestionBatchItem
	// accepted are the uploads Complete accepted, and planItems the plan's items, for a cancelled call's report.
	accepted  map[string]IngestionBatchItem
	planItems []IngestionBatchItem
}

// failed records an item this call failed and delivers it to OnItem.
func (r *syncRun) failed(it IngestionBatchItem) {
	r.progressMu.Lock()
	if r.failedHere == nil {
		r.failedHere = map[string]IngestionBatchItem{}
	}
	r.failedHere[it.ID] = it
	r.progressMu.Unlock()
	r.item(it)
}

func (r *syncRun) close() {
	for _, f := range r.files {
		if f.prepared != nil {
			f.prepared.Close()
		}
	}
}

func (r *syncRun) progress(p IngestionProgress) {
	if r.in.OnProgress == nil {
		return
	}
	r.progressMu.Lock()
	defer r.progressMu.Unlock()
	r.in.OnProgress(p)
}

// finalItem reports whether an item's status is one it ends in.
func finalItem(s IngestionItemStatus) bool {
	switch s {
	case IngestionItemStatusIndexed, IngestionItemStatusSkipped, IngestionItemStatusMoved, IngestionItemStatusUpdated,
		IngestionItemStatusRemoved, IngestionItemStatusCancelled, IngestionItemStatusFailed:
		return true
	}
	return false
}

// item reports an item to OnItem once, and only at a final status (PROTOCOL.md 15, sync.on-item-once).
func (r *syncRun) item(it IngestionBatchItem) {
	if !finalItem(it.Status) {
		return
	}
	r.progressMu.Lock()
	defer r.progressMu.Unlock()
	if r.reported == nil {
		r.reported = map[string]bool{}
	}
	if r.reported[it.ID] {
		return
	}
	r.reported[it.ID] = true
	if r.in.OnItem != nil {
		r.in.OnItem(it)
	}
}

// plan runs steps 1 to 3: hash, create, plan (with the estimate).
func (r *syncRun) plan(ctx context.Context) (*SyncPlan, error) {
	folder := r.in.Folder
	if folder == "" {
		folder = "/"
	}
	if !strings.HasSuffix(folder, "/") {
		folder += "/"
	}
	if !strings.HasPrefix(folder, "/") {
		folder = "/" + folder
	}

	// 1. Hash.
	locals, err := r.collect(folder)
	if err != nil {
		return nil, err
	}
	r.progress(IngestionProgress{Phase: SyncPhaseChecksum, Done: 0, Total: len(locals)})
	items := make([]IngestionItemInput, 0, len(locals))
	for i, l := range locals {
		uf, err := core.FileOf(l.File)
		if err != nil {
			return nil, err
		}
		if uf == nil {
			return nil, core.NewError("VALIDATION_FAILED", "Sync needs each file's bytes: "+l.RelativePath+" is an upload's id", nil)
		}
		p, err := uf.Prepare(ctx)
		if err != nil {
			return nil, err
		}
		f := &syncFile{local: l, prepared: p}
		r.files = append(r.files, f)
		r.byPath[l.Path] = f
		items = append(items, r.itemInput(f))
		r.progress(IngestionProgress{Phase: SyncPhaseChecksum, Done: i + 1, Total: len(locals)})
	}
	if r.in.RemoveMissing {
		removes, err := r.missing(ctx, folder)
		if err != nil {
			return nil, err
		}
		items = append(items, removes...)
	}

	// 2. Create, to start by hand once it is planned.
	kb := newKnowledgeBaseIngestion(r.c, r.kb)
	first := items[:min(len(items), SyncItemsPerCall)]
	more := len(items) > SyncItemsPerCall
	created, err := kb.Batches.Create(ctx, &CreateIngestionBatchInput{Start: Ptr(StartModeManual), AwaitMoreItems: boolPtr(more),
		Policy: r.in.Policy, Items: first})
	if err != nil {
		return nil, err
	}
	r.batch, r.etag = created.BatchScope, created.Result.ETag
	r.progress(IngestionProgress{Phase: SyncPhasePlanning, Total: len(items)})
	for start := SyncItemsPerCall; start < len(items); start += SyncItemsPerCall {
		end := min(len(items), start+SyncItemsPerCall)
		res, err := r.c.Core.Ingestion.AddItems(ctx, r.kb, created.ID(), &BatchCreateIngestionBatchItemsInput{Items: items[start:end],
			Last: boolPtr(end == len(items))})
		if err != nil {
			return nil, err
		}
		for _, cr := range res.Results {
			if cr.Status == ItemCreateStatusFailed {
				why := deref(cr.Detail)
				if c := deref(cr.Code); c != "" {
					why = c + ": " + why
				}
				return nil, core.NewError("INGESTION_ITEM_REFUSED", "An item could not be added to the batch: "+why, nil)
			}
		}
	}

	// 3. Plan, and price the items that need their bytes.
	planned, err := r.batch.Planned(ctx, r.in.WaitOptions...)
	if err != nil {
		return nil, err
	}
	r.etag = planned.ETag
	planItems, err := r.listItems(ctx, nil)
	if err != nil {
		return nil, err
	}
	r.progress(IngestionProgress{Phase: SyncPhasePlanned, Done: len(planItems), Total: len(planItems)})
	r.planItems = planItems
	plan := &SyncPlan{Batch: planned, Items: planItems}
	// The items that need their bytes, each described by its file (its hints included), never hashed for the estimate:
	// batch.EstimateUpload's pricing
	est, err := r.c.priceItems(ctx, r.kb, planItems, func(it IngestionBatchItem) (*UploadDescription, error) {
		f, ok := r.byPath[deref(it.Path)]
		if !ok {
			return nil, nil
		}
		return describeLocal(path.Base(f.local.Path), f.prepared.ContentType, f.prepared.Size, f.local.File), nil
	}, r.in.estimatePerCall)
	if err != nil {
		return nil, err
	}
	plan.Estimate = est
	return plan, nil
}

// addCount sums two optional counts: absent only when both are.
func addCount(a, b *int64) *int64 {
	if a == nil && b == nil {
		return nil
	}
	var n int64
	if a != nil {
		n += *a
	}
	if b != nil {
		n += *b
	}
	return &n
}

// finish runs steps 4 to 7: resolve, start, upload, wait, report.
func (r *syncRun) finish(ctx context.Context, plan *SyncPlan) (*SyncReport, error) {
	// 4. Resolve.
	if r.in.Confirm != nil {
		ok, err := r.in.Confirm(ctx, plan)
		if err != nil {
			return nil, err
		}
		if !ok {
			// Declined: the batch is cancelled, and the call ends with CANCELLED, an error the SDK raises itself (not
			// the context's: nothing cancelled ctx), carrying the report.
			if _, err := r.batch.Cancel(ctx, nil); err != nil {
				return nil, err
			}
			return nil, &SyncDeclinedError{APIError: core.NewError("CANCELLED", "Confirm declined the plan: the batch is cancelled", nil),
				Report: r.reportSoFar(ctx)}
		}
	}
	resolved := false
	for _, it := range plan.Items {
		if it.Resolution == nil || *it.Resolution != IngestionItemResolutionUnresolved {
			continue
		}
		if r.in.Resolve == nil {
			return nil, core.NewError("INGESTION_BATCH_UNRESOLVED", "Item "+deref(it.Path)+" of ingestion batch "+plan.Batch.ID+
				" is unresolved and there is no resolver: the batch is left planned; resolve its items and start it", nil)
		}
		res, err := r.in.Resolve(ctx, it)
		if err != nil {
			return nil, err
		}
		if _, err := r.batch.Item(it.ID).Resolve(ctx, &UpdateIngestionBatchItemInput{Resolution: res}, WithIfMatch(it.ETag)); err != nil {
			return nil, err
		}
		resolved = true
	}
	if resolved {
		b, err := r.batch.Get(ctx)
		if err != nil {
			return nil, err
		}
		r.etag = b.ETag
	}

	// 5. Start.
	started, err := r.batch.Start(ctx, WithIfMatch(r.etag))
	if err != nil {
		return nil, err
	}

	// 6. Upload.
	if started.Result.UploadPolicy == nil {
		// Items awaiting upload with no policy to send them under (PROTOCOL.md 6.3).
		if err := r.policyMissing(ctx); err != nil {
			return nil, err
		}
	} else {
		if err := r.upload(ctx, started.Result.UploadPolicy); err != nil {
			if ctx.Err() != nil {
				return nil, r.cancelled(ctx)
			}
			return nil, err
		}
	}
	r.progress(r.stage(SyncPhaseQueued, started.Result.Batch.Counts, len(plan.Items)))
	r.progress(IngestionProgress{Phase: SyncPhaseProcessing, Total: len(plan.Items)})

	// 7. Wait. A batch that ended failed is reported like any other: its items say what happened.
	if _, err := r.batch.Wait(ctx, r.in.WaitOptions...); err != nil {
		if ctx.Err() != nil {
			return nil, r.cancelled(ctx)
		}
		var e *Error
		if !errors.As(err, &e) || e.Status != 0 || e.Code == "STREAM_LOST" || e.Code == "WAIT_TIMEOUT" {
			return nil, err
		}
	}
	return r.report(ctx)
}

// cancelled ends a cancelled call: with CancelIngestion it cancels the batch first, with a context of its own.
func (r *syncRun) cancelled(ctx context.Context) error {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if r.in.CancelIngestion && r.batch != nil {
		r.batch.Cancel(cctx, &CancelIngestionBatchInput{StopRunning: Ptr(true)})
	}
	return &SyncCancelledError{Report: r.reportSoFar(cctx), Err: ctx.Err()}
}

// SyncDeclinedError is what Sync returns when Confirm declines the plan: an *Error with Code CANCELLED and Status 0
// (errors.As finds either type), with the report: the plan's items and the cancelled batch. It is not
// context.Canceled.
type SyncDeclinedError struct {
	*core.APIError
	// Report is every item of the plan, and the batch, cancelled.
	Report *SyncReport
}

// Unwrap returns the embedded *Error.
func (e *SyncDeclinedError) Unwrap() error { return e.APIError }

// SyncCancelledError is what Sync returns when ctx is cancelled once the batch exists: the context's error (errors.Is
// with context.Canceled or context.DeadlineExceeded holds) and the report so far (PROTOCOL.md 15, sync.cancel-report).
//
//	var cancelled *caitlyn.SyncCancelledError
//	if errors.As(err, &cancelled) { fmt.Println(cancelled.Report.Batch.Counts) }
type SyncCancelledError struct {
	// Report is every item with its last status (an accepted upload not yet final is ingesting), and the batch with
	// its counts; the batch is nil when it could not be read after the cancellation.
	Report *SyncReport
	// Err is the context's error.
	Err error
}

func (e *SyncCancelledError) Error() string { return "caitlyn: sync cancelled: " + e.Err.Error() }

// Unwrap returns the context's error.
func (e *SyncCancelledError) Unwrap() error { return e.Err }

// reportSoFar reads the batch and its items again after a cancellation, and lays this call's own view over them: an
// upload it failed, and an upload accepted that the server may not show yet.
func (r *syncRun) reportSoFar(ctx context.Context) *SyncReport {
	rep := &SyncReport{}
	if b, err := r.batch.Get(ctx); err == nil {
		rep.Batch = b
	}
	items, err := r.listItems(ctx, nil)
	if err != nil {
		items = append([]IngestionBatchItem(nil), r.planItems...)
	}
	r.progressMu.Lock()
	defer r.progressMu.Unlock()
	for i, it := range items {
		if f, ok := r.failedHere[it.ID]; ok {
			items[i] = f
		} else if a, ok := r.accepted[it.ID]; ok && (it.Status == IngestionItemStatusAwaitingUpload || it.Status == IngestionItemStatusDraft) {
			items[i] = a
		}
	}
	rep.Items = items
	return rep
}

// acceptedUpload records an upload Complete accepted: ingesting, until the server says more.
func (r *syncRun) acceptedUpload(it IngestionBatchItem) {
	r.progressMu.Lock()
	defer r.progressMu.Unlock()
	if r.accepted == nil {
		r.accepted = map[string]IngestionBatchItem{}
	}
	it.Status = IngestionItemStatusIngesting
	r.accepted[it.ID] = it
}

// stage is a report from the batch's counts: Done is the items that have reached a final status (cancelled included:
// the item's document was deleted while it was ingested).
func (r *syncRun) stage(phase SyncPhase, counts *IngestionBatchCounts, total int) IngestionProgress {
	done := 0
	if counts != nil {
		for status, n := range counts.ByStatus {
			switch status {
			case IngestionItemStatusIndexed, IngestionItemStatusSkipped, IngestionItemStatusMoved, IngestionItemStatusUpdated,
				IngestionItemStatusRemoved, IngestionItemStatusFailed, IngestionItemStatusCancelled:
				done += int(n)
			}
		}
	}
	return IngestionProgress{Phase: phase, Done: done, Total: total}
}

func (r *syncRun) report(ctx context.Context) (*SyncReport, error) {
	b, err := r.batch.Get(ctx)
	if err != nil {
		return nil, err
	}
	items, err := r.listItems(ctx, nil)
	if err != nil {
		return nil, err
	}
	for i, it := range items {
		if f, ok := r.failedHere[it.ID]; ok {
			items[i] = f
			continue
		}
		r.item(it)
	}
	if final := SyncPhase(b.Status); b.Status != IngestionBatchStatusRunning {
		r.progress(IngestionProgress{Phase: final, Done: len(items), Total: len(items)})
	}
	return &SyncReport{Batch: b, Items: items}, nil
}

// upload is sync's step 6: batch.Upload's uploader, sending every item awaiting its bytes. Unlike batch.Upload, an
// item with no file is an error here, since every item came from the caller's own files.
// policyMissing is UPLOAD_POLICY_MISSING when Start gave no upload policy but items await their bytes (PROTOCOL.md 6.3).
func (r *syncRun) policyMissing(ctx context.Context) error {
	status := IngestionItemStatusAwaitingUpload
	awaiting, err := r.listItems(ctx, &status)
	if err != nil {
		return err
	}
	if len(awaiting) > 0 {
		return core.NewError("UPLOAD_POLICY_MISSING", "StartIngestionBatch returned no upload policy, but items are awaiting upload", nil)
	}
	return nil
}

func (r *syncRun) upload(ctx context.Context, policy *UploadPolicy) error {
	status := IngestionItemStatusAwaitingUpload
	awaiting, err := r.listItems(ctx, &status)
	if err != nil {
		return err
	}
	var jobs []uploadJob
	for _, it := range awaiting {
		f, ok := r.byPath[deref(it.Path)]
		if !ok {
			return core.NewError("INGESTION_ITEM_HAS_NO_FILE", "The batch awaits bytes for "+deref(it.Path)+", which is not one of the files given", nil)
		}
		jobs = append(jobs, uploadJob{item: it, file: &uploadFile{prepared: f.prepared, path: f.local.Path, checksum: f.prepared.SHA256,
			contentType: f.prepared.ContentType}})
	}
	u := &uploader{c: r.c, kb: r.kb, batchID: r.batch.ingestionBatchID, concurrency: r.in.Concurrency, progress: r.progress,
		failed: func(it IngestionBatchItem, byComplete bool) {
			if byComplete {
				r.item(it)
			} else {
				r.failed(it)
			}
		},
		accepted: r.acceptedUpload}
	return u.run(ctx, policy, jobs)
}

func (r *syncRun) listItems(ctx context.Context, status *IngestionItemStatus) ([]IngestionBatchItem, error) {
	var out []IngestionBatchItem
	for it, err := range r.batch.Items.List(ctx, &ListIngestionBatchItemsInput{Status: status}) {
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

func (r *syncRun) itemInput(f *syncFile) IngestionItemInput {
	p := f.prepared
	it := IngestionItemInput{Path: Ptr(f.local.Path), SHA256: Ptr(p.SHA256), ByteSize: Ptr(p.Size), ContentType: Ptr(p.ContentType),
		ExternalID: Ptr(f.local.RelativePath)}
	if r.in.ExternalID != nil {
		if v := r.in.ExternalID(f.local); v != "" {
			it.ExternalID = &v
		}
	}
	if r.in.SourceURL != nil {
		if v := r.in.SourceURL(f.local); v != "" {
			it.SourceURL = &v
		}
	}
	if r.in.Metadata != nil {
		it.Metadata = r.in.Metadata(f.local)
	}
	return it
}

// missing lists the documents under folder and returns a remove item for each one with no file.
func (r *syncRun) missing(ctx context.Context, folder string) ([]IngestionItemInput, error) {
	var out []IngestionItemInput
	for d, err := range newKnowledgeBaseScope(r.c, r.kb).Documents.List(ctx, &ListDocumentsInput{Folder: &folder, Deep: Ptr(true)}) {
		if err != nil {
			return nil, err
		}
		p := d.Folder + d.Name
		if _, ok := r.byPath[p]; ok {
			continue
		}
		out = append(out, IngestionItemInput{Action: Ptr(IngestionItemActionRemove), Path: &p})
	}
	return out, nil
}

// collect gathers the files: the caller's, or Dir's, filtered and sorted by path.
func (r *syncRun) collect(folder string) ([]LocalFile, error) {
	var out []LocalFile
	files, isFiles := r.from.(Files)
	dir, _ := r.from.(Dir)
	if isFiles || r.from == nil {
		for _, l := range files {
			if l.File == nil {
				return nil, core.MissingInput("Sync", "files[].file")
			}
			rel := strings.TrimPrefix(filepath.ToSlash(l.RelativePath), "/")
			if rel == "" {
				f, err := core.FileOf(l.File)
				if err != nil {
					return nil, err
				}
				if f == nil {
					return nil, core.MissingInput("Sync", "files[].relativePath")
				}
				rel = f.Name()
			}
			out = append(out, LocalFile{RelativePath: rel, Path: folder + rel, File: l.File})
		}
		return out, nil
	}
	ignore, err := readIgnore(filepath.Join(string(dir), ".caitlynignore"))
	if err != nil {
		return nil, err
	}
	include := compileGlobs(r.in.Include)
	exclude := append(compileGlobs(r.in.Exclude), ignore...)
	err = filepath.WalkDir(string(dir), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(string(dir), p)
		if err != nil || rel == "." {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if matchAny(exclude, rel+"/") {
				return filepath.SkipDir
			}
			return nil
		}
		// Symbolic links (to files or folders) and other special files are not followed.
		if !d.Type().IsRegular() || rel == ".caitlynignore" {
			return nil
		}
		if len(include) > 0 && !matchAny(include, rel) || matchAny(exclude, rel) {
			return nil
		}
		out = append(out, LocalFile{RelativePath: rel, Path: folder + rel, File: Path(p)})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RelativePath < out[j].RelativePath })
	return out, nil
}

// compileGlobs turns globs into patterns over slash-separated relative paths: * and ? stay within a path segment, **
// crosses segments, a glob with no slash matches a file or folder name at any depth (as .gitignore does), and a
// trailing slash matches folders only.
func compileGlobs(globs []string) []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, g := range globs {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		dirOnly := strings.HasSuffix(g, "/")
		g = strings.TrimSuffix(g, "/")
		anchored := strings.Contains(g, "/")
		g = strings.TrimPrefix(g, "/")
		var b strings.Builder
		b.WriteString("^")
		if !anchored {
			b.WriteString("(?:.*/)?")
		}
		for i := 0; i < len(g); i++ {
			switch ch := g[i]; {
			case ch == '*' && i+1 < len(g) && g[i+1] == '*':
				i++
				if i+1 < len(g) && g[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			case ch == '*':
				b.WriteString("[^/]*")
			case ch == '?':
				b.WriteString("[^/]")
			default:
				b.WriteString(regexp.QuoteMeta(string(ch)))
			}
		}
		if dirOnly {
			b.WriteString("/$")
		} else {
			b.WriteString("/?$")
		}
		if re, err := regexp.Compile(b.String()); err == nil {
			out = append(out, re)
		}
	}
	return out
}

func matchAny(res []*regexp.Regexp, rel string) bool {
	for _, re := range res {
		if re.MatchString(rel) {
			return true
		}
	}
	return false
}

// readIgnore reads a .caitlynignore: one glob a line, # for comments; a missing file is no globs.
func readIgnore(p string) ([]*regexp.Regexp, error) {
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var globs []string
	s := bufio.NewScanner(f)
	for s.Scan() {
		if line := strings.TrimSpace(s.Text()); line != "" && !strings.HasPrefix(line, "#") {
			globs = append(globs, line)
		}
	}
	return compileGlobs(globs), s.Err()
}

func boolPtr(v bool) *bool { return &v }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
