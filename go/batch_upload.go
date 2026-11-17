// This file is hand-written, not generated: batch.EstimateUpload and batch.Upload, a hand-built ingestion batch's
// pricing and upload (PROTOCOL.md 15). kb.Ingestion.Sync is built on the same two steps.

package caitlyn

import (
	"context"
	"path"
	"reflect"
	"sort"
	"strings"
	"sync"

	"github.com/caitlyn-ai/sdk/go/core"
)

// estimatePerCall is the most documents one EstimateIngestion call takes (PROTOCOL.md 15): more are priced in calls
// of at most this many, and the parts added together.
const estimatePerCall = 10000

// estimatePerCallKey carries a smaller limit on a call's context. Only the conformance suite sets it
// (sync_conformance.go, built with -tags caitlyn_conformance), to price many items without building 10,000 files.
type estimatePerCallKey struct{}

// BatchFiles gives the file for each item of a batch, for batch.Upload and batch.EstimateUpload: ok is false for an
// item it has no file for. FilesByPath makes one from a map keyed by the items' paths; any function will do for files
// made or fetched only when they are needed.
type BatchFiles func(item *IngestionBatchItem) (file File, ok bool)

// filesByPathKeys is the metadata key batch.Upload asks a FilesByPath function for its keys with, so it can list the
// paths that matched no item. It is only ever sent to a function FilesByPath made.
const filesByPathKeys = "\x00caitlyn:files-by-path-keys"

// FilesByPath gives each item the file keyed by its path, as the batch stores it ("/hr/leave.pdf"). A key without its
// leading "/" is taken as if it had one.
func FilesByPath(files map[string]File) BatchFiles {
	byPath := make(map[string]File, len(files))
	keys := make([]string, 0, len(files))
	for k, f := range files {
		if !strings.HasPrefix(k, "/") {
			k = "/" + k
		}
		byPath[k] = f
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return func(item *IngestionBatchItem) (File, bool) {
		if _, ask := item.Metadata[filesByPathKeys]; ask {
			item.Metadata[filesByPathKeys] = keys
			return nil, false
		}
		if item.Path == nil {
			return nil, false
		}
		f, ok := byPath[*item.Path]
		return f, ok
	}
}

// filesByPathCode identifies the functions FilesByPath makes: they share its closure's code.
var filesByPathCode = reflect.ValueOf(FilesByPath(nil)).Pointer()

// givenPaths is a FilesByPath function's keys, or nil for any other function.
func givenPaths(files BatchFiles) []string {
	if files == nil || reflect.ValueOf(files).Pointer() != filesByPathCode {
		return nil
	}
	probe := &IngestionBatchItem{Metadata: map[string]any{filesByPathKeys: nil}}
	files(probe)
	keys, _ := probe.Metadata[filesByPathKeys].([]string)
	return keys
}

// BatchUploadOptions are batch.Upload's options. All are optional.
type BatchUploadOptions struct {
	// Concurrency is how many files are uploaded at once: DefaultSyncConcurrency (6) when 0.
	Concurrency int
	// OnProgress is called in phase upload (bytes sent of bytes to send, with the item) and phase queued (items
	// accepted by CompleteIngestionBatchUploads of items uploaded). Calls do not overlap.
	OnProgress func(IngestionProgress)
	// OnItem is called for each item that ends during the call: an upload that failed (UPLOAD_FAILED, FILE_CHANGED,
	// or a second CHECKSUM_MISMATCH), with its FailureCode and FailureDetail. Accepted items end later, during
	// ingestion: the batch's Watch and Wait report them. Calls do not overlap.
	OnItem func(IngestionBatchItem)
}

// BatchUpload is what batch.Upload did.
type BatchUpload struct {
	// Batch is the batch as it stood when the call ended.
	Batch *IngestionBatch
	// Items holds one item for each item the call dealt with: accepted by CompleteIngestionBatchUploads (status
	// ingesting), or failed here (status failed, with FailureCode and FailureDetail).
	Items []IngestionBatchItem
	// NotGiven are the paths of items awaiting upload that no file was given for: they stay awaiting_upload.
	NotGiven []string
	// Unmatched are the given paths (FilesByPath's keys) that matched no item awaiting upload: nothing was sent for them.
	Unmatched []string
}

// BatchUploadStarted is what batch.Upload returns: what the call did as Result, and Wait, which follows the batch
// until it has finished.
type BatchUploadStarted struct {
	// Result is what the call did.
	Result *BatchUpload

	scope *BatchScope
}

// Watch opens the batch's watch, as BatchScope.Watch does: a snapshot first, then each change.
func (r *BatchUploadStarted) Watch(ctx context.Context, opts ...CallOption) (*KnowledgeBaseEventStream, error) {
	return r.scope.Watch(ctx, opts...)
}

// Wait waits until the batch has finished, then returns it, as BatchScope.Wait does.
func (r *BatchUploadStarted) Wait(ctx context.Context, opts ...WaitOption) (*IngestionBatch, error) {
	return r.scope.Wait(ctx, opts...)
}

// EstimateUpload is what uploading the batch's file items would take and cost, before the batch is started: one
// EstimateIngestion (more over 10,000 items, added together) for the items that could need their bytes and are
// neither final nor uploaded: those resolved add, new_version or overwrite, and those still unresolved whose outcome
// takes bytes (new, changed or a conflict), as the most the batch could cost. files may be nil: each item is then described by
// its own name, content type and size; with files, by its file's name, content type and size, plus the hints the file
// was given (WithHints). Nothing is hashed or read beyond a file's size. A batch still planning is waited on (opts
// bound the wait, as for Planned); a draft batch fails with INGESTION_BATCH_NOT_PLANNED, nothing sent; a batch with
// nothing to price returns an empty estimate, with no call.
func (s *BatchScope) EstimateUpload(ctx context.Context, files BatchFiles, opts ...WaitOption) (*EstimateIngestionResult, error) {
	b, err := s.Get(ctx)
	if err != nil {
		return nil, err
	}
	switch b.Status {
	case IngestionBatchStatusDraft:
		return nil, core.NewError("INGESTION_BATCH_NOT_PLANNED", "Ingestion batch "+b.ID+" is a draft: add its last items (last: true) so it is planned, then estimate its upload", nil)
	case IngestionBatchStatusPlanning:
		if _, err := s.Planned(ctx, opts...); err != nil {
			return nil, err
		}
	case IngestionBatchStatusPlanned, IngestionBatchStatusRunning:
	default:
		return &EstimateIngestionResult{}, nil
	}
	items, err := listBatchItems(ctx, s, nil)
	if err != nil {
		return nil, err
	}
	est, err := s.c.priceItems(ctx, s.knowledgeBaseID, items, func(it IngestionBatchItem) (*UploadDescription, error) {
		if files != nil {
			if f, ok := files(&it); ok && f != nil {
				uf, err := core.FileOf(f)
				if err != nil {
					return nil, err
				}
				if uf != nil {
					fi, err := uf.Describe(ctx)
					if err != nil {
						return nil, err
					}
					return describeLocal(fi.Name, fi.ContentType, fi.Size, uf), nil
				}
			}
		}
		return &UploadDescription{Name: path.Base(deref(it.Path)), ContentType: deref(it.ContentType), ByteSize: derefInt(it.ByteSize)}, nil
	}, 0)
	if err != nil || est != nil {
		return est, err
	}
	return &EstimateIngestionResult{}, nil
}

// Upload sends the batch's items awaiting upload that files has a file for (sync's step 6): at most Concurrency at
// once, each a form POST under the batch's upload policy (renewed when less than 5 minutes are left, and once after a
// 403 that says it expired), then CompleteIngestionBatchUploads, 100 a call. Files are not hashed: a file whose size is
// not the item's byteSize fails that item with FILE_CHANGED before anything is sent, and storage refusing bytes that do
// not match the item's checksum fails it with FILE_CHANGED, with no retry. One item's failure is that item's alone.
//
// The batch must be running: a batch created with start when_planned is followed until it is, and one in draft, or
// planned to start by hand, fails with INGESTION_BATCH_NOT_STARTED before anything is sent (start it with Start). An
// item with no file is left awaiting upload, in Result.NotGiven; a given path that matches no awaiting item is in
// Result.Unmatched. Cancelling ctx stops new uploads, aborts those in flight and returns the context's error; the batch
// is not cancelled (Cancel does that).
func (s *BatchScope) Upload(ctx context.Context, files BatchFiles, in *BatchUploadOptions) (*BatchUploadStarted, error) {
	if in == nil {
		in = &BatchUploadOptions{}
	}
	if files == nil {
		return nil, core.MissingInput("Upload", "files")
	}
	b, err := s.Get(ctx)
	if err != nil {
		return nil, err
	}
	given := givenPaths(files)
	switch b.Status {
	case IngestionBatchStatusRunning:
	case IngestionBatchStatusDraft, IngestionBatchStatusPlanning, IngestionBatchStatusPlanned:
		if b.Start != StartModeWhenPlanned || b.Status == IngestionBatchStatusDraft {
			return nil, notStarted(b, "start it with batch.Start")
		}
		if b, err = s.running(ctx); err != nil {
			return nil, err
		}
		if b.Status != IngestionBatchStatusRunning {
			return &BatchUploadStarted{Result: &BatchUpload{Batch: b, Unmatched: given}, scope: s}, nil
		}
	default:
		// A final batch awaits nothing
		return &BatchUploadStarted{Result: &BatchUpload{Batch: b, Unmatched: given}, scope: s}, nil
	}

	status := IngestionItemStatusAwaitingUpload
	awaiting, err := listBatchItems(ctx, s, &status)
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	result := &BatchUpload{}
	byID := map[string]int{}
	record := func(it IngestionBatchItem) {
		if i, ok := byID[it.ID]; ok {
			result.Items[i] = it
			return
		}
		byID[it.ID] = len(result.Items)
		result.Items = append(result.Items, it)
	}
	failed := func(it IngestionBatchItem, _ bool) {
		mu.Lock()
		defer mu.Unlock()
		record(it)
		if in.OnItem != nil {
			in.OnItem(it)
		}
	}
	matched := map[string]bool{}
	var jobs []uploadJob
	var prepared []*core.PreparedFile
	defer func() {
		for _, p := range prepared {
			p.Close()
		}
	}()
	for _, it := range awaiting {
		f, ok := files(&it)
		if !ok || f == nil {
			result.NotGiven = append(result.NotGiven, deref(it.Path))
			continue
		}
		matched[deref(it.Path)] = true
		uf, err := core.FileOf(f)
		if err != nil {
			return nil, err
		}
		if uf == nil {
			return nil, core.NewError("VALIDATION_FAILED", "batch.Upload needs each file's bytes: "+deref(it.Path)+" is given an upload's id", nil)
		}
		p, err := uf.PrepareUnhashed(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			fail := it
			fail.Status, fail.FailureCode, fail.FailureDetail = IngestionItemStatusFailed, Ptr("UPLOAD_FAILED"), Ptr(err.Error())
			failed(fail, false)
			continue
		}
		prepared = append(prepared, p)
		if it.ByteSize != nil && p.Size != *it.ByteSize {
			// Not the file the item was planned from: nothing is sent
			fail := it
			fail.Status, fail.FailureCode = IngestionItemStatusFailed, Ptr("FILE_CHANGED")
			fail.FailureDetail = Ptr(deref(it.Path) + " is not the file the item was planned from: its size is different")
			failed(fail, false)
			continue
		}
		contentType := deref(it.ContentType)
		if contentType == "" {
			contentType = p.ContentType
		}
		jobs = append(jobs, uploadJob{item: it, file: &uploadFile{prepared: p, path: deref(it.Path), checksum: deref(it.SHA256), contentType: contentType}})
	}
	for _, k := range given {
		if !matched[k] {
			result.Unmatched = append(result.Unmatched, k)
		}
	}
	if len(jobs) > 0 {
		policy, err := s.c.Core.Ingestion.UploadPolicy(ctx, s.knowledgeBaseID, s.ingestionBatchID)
		if err != nil {
			return nil, err
		}
		var progressMu sync.Mutex
		u := &uploader{c: s.c, kb: s.knowledgeBaseID, batchID: s.ingestionBatchID, concurrency: in.Concurrency, queued: true,
			progress: func(p IngestionProgress) {
				if in.OnProgress == nil {
					return
				}
				progressMu.Lock()
				defer progressMu.Unlock()
				in.OnProgress(p)
			},
			failed: failed,
			accepted: func(it IngestionBatchItem) {
				mu.Lock()
				defer mu.Unlock()
				it.Status = IngestionItemStatusIngesting
				record(it)
			}}
		if err := u.run(ctx, &policy.UploadPolicy, jobs); err != nil {
			return nil, err
		}
	}
	if result.Batch, err = s.Get(ctx); err != nil {
		return nil, err
	}
	return &BatchUploadStarted{Result: result, scope: s}, nil
}

// running follows a batch created with start when_planned through its watch until it is running (or has ended). It
// stops at planned only when an item is left unresolved, with INGESTION_BATCH_NOT_STARTED.
func (s *BatchScope) running(ctx context.Context) (*IngestionBatch, error) {
	f := &follow{kind: "batch", id: s.ingestionBatchID}
	checked := false
	err := watchUntil(ctx, s.Watch, nil, f, func() (bool, error) {
		if f.snap == nil || f.snap.Batch == nil {
			return false, nil
		}
		switch b := f.snap.Batch; b.Status {
		case IngestionBatchStatusDraft, IngestionBatchStatusPlanning:
			return false, nil
		case IngestionBatchStatusPlanned:
			// Planned with nothing unresolved starts by itself; an unresolved item keeps it planned
			if checked {
				return false, nil
			}
			checked = true
			unresolved := false
			for it, err := range s.Items.List(ctx, nil) {
				if err != nil {
					return true, err
				}
				if it.Resolution != nil && *it.Resolution == IngestionItemResolutionUnresolved {
					unresolved = true
					break
				}
			}
			if unresolved {
				return true, notStarted(b, "resolve its unresolved items, then start it with batch.Start")
			}
			return false, nil
		}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return s.Get(ctx)
}

func notStarted(b *IngestionBatch, what string) error {
	return core.NewError("INGESTION_BATCH_NOT_STARTED", "Ingestion batch "+b.ID+" is "+string(b.Status)+", not running: "+what, nil)
}

// needsBytes reports whether a batch item is priced (PROTOCOL.md 15, sync.estimate-unresolved): it could need its
// bytes, and it is neither final nor uploaded. An item resolved add, new_version or overwrite needs them; one still
// unresolved could, when its outcome takes bytes (new, changed or a conflict), so it is priced as the most the batch
// could cost. Items resolved skip, remove, move or update are not.
func needsBytes(it IngestionBatchItem) bool {
	if it.Resolution == nil {
		return false
	}
	switch *it.Resolution {
	case IngestionItemResolutionAdd, IngestionItemResolutionNewVersion, IngestionItemResolutionOverwrite:
	case IngestionItemResolutionUnresolved:
		if it.Outcome == nil {
			return false
		}
		switch *it.Outcome {
		case IngestionItemOutcomeNew, IngestionItemOutcomeChanged, IngestionItemOutcomeConflict:
		default:
			return false
		}
	default:
		return false
	}
	return it.Status == IngestionItemStatusDraft || it.Status == IngestionItemStatusAwaitingUpload
}

// describeLocal is a file as an estimate sends it: its name, content type and size, plus the hints it was given
// (WithHints). Nothing is read from its bytes.
func describeLocal(name, contentType string, size int64, file File) *UploadDescription {
	d := &UploadDescription{Name: name, ContentType: contentType, ByteSize: size}
	if uf, ok := file.(*UploadFile); ok && uf != nil {
		if h, ok := uf.Hints().(*IngestionHints); ok {
			d.Hints = h
		}
	}
	return d
}

// priceItems prices the items that need their bytes (needsBytes), each described by describe (nil leaves the item
// out), in EstimateIngestion calls of at most per documents (estimatePerCall when 0), and adds the parts together:
// counts and ranges summed, the cost summed only when every part has one, details left out. It returns nil, with no
// call, when there is nothing to price.
func (c *Client) priceItems(ctx context.Context, kb string, items []IngestionBatchItem, describe func(IngestionBatchItem) (*UploadDescription, error), per int) (*EstimateIngestionResult, error) {
	var described []UploadDescription
	for _, it := range items {
		if !needsBytes(it) {
			continue
		}
		d, err := describe(it)
		if err != nil {
			return nil, err
		}
		if d != nil {
			described = append(described, *d)
		}
	}
	if len(described) == 0 {
		return nil, nil
	}
	if per <= 0 {
		per = estimatePerCall
		if n, ok := ctx.Value(estimatePerCallKey{}).(int); ok && n > 0 {
			per = n
		}
	}
	var total *EstimateIngestionResult
	allCost := true
	for start := 0; start < len(described); start += per {
		part, err := c.callEstimateIngestion(ctx, &estimateIngestionParams{KnowledgeBaseID: kb,
			Documents: described[start:min(len(described), start+per)]}, nil)
		if err != nil {
			return nil, err
		}
		if total == nil {
			total = part
			total.Details = nil
			allCost = part.Cost != nil
			continue
		}
		total.Documents += part.Documents
		total.Pages = addCount(total.Pages, part.Pages)
		total.MediaSeconds = addCount(total.MediaSeconds, part.MediaSeconds)
		total.DocumentsOfUnknownLength = addCount(total.DocumentsOfUnknownLength, part.DocumentsOfUnknownLength)
		total.DurationSeconds.Low += part.DurationSeconds.Low
		total.DurationSeconds.High += part.DurationSeconds.High
		if part.Cost == nil || total.Cost == nil {
			allCost = false
		} else {
			total.Cost.Low += part.Cost.Low
			total.Cost.High += part.Cost.High
		}
	}
	if !allCost {
		total.Cost = nil
	}
	return total, nil
}

func listBatchItems(ctx context.Context, s *BatchScope, status *IngestionItemStatus) ([]IngestionBatchItem, error) {
	var out []IngestionBatchItem
	for it, err := range s.Items.List(ctx, &ListIngestionBatchItemsInput{Status: status}) {
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

func derefInt(n *int64) int64 {
	if n == nil {
		return 0
	}
	return *n
}
