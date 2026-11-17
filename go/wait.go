// This file is hand-written, not generated: wait() on a scope, built on its watch (PROTOCOL.md 16). The generated
// scopes call it; in Go the core package cannot name the generated event types, so it lives in this package.
// scripts/generate.sh keeps every file in go/ that is not marked as generated.

package caitlyn

import (
	"context"
	"errors"
	"time"

	"github.com/caitlyn-ai/sdk/go/core"
)

// watchFunc opens a scope's watch: its Watch method.
type watchFunc func(ctx context.Context, opts ...CallOption) (*KnowledgeBaseEventStream, error)

// follow is what a wait has seen on a watch: the snapshot, kept up to date by the change events, and the jobs.
type follow struct {
	// kind is the watch's filter (document, folder, batch), or "" for the whole knowledge base; id is what it names.
	kind, id string
	// job is the work the wait follows, when the call that started it said which ("" otherwise).
	job string
	// gone: the wait is for the thing to go (after a delete), and that is its success.
	gone bool
	// cancelling: the wait is a cancel's own (batch.Cancel, doc.CancelProcessing): the work ending cancelled is what
	// the call intended, not an error (PROTOCOL.md 16, wait.cancel-returns).
	cancelling bool

	snap  *KnowledgeBaseSnapshot
	jobs  map[string]*Job
	order []string // job ids in the order they were first seen
	ended bool     // the thing went (a deleted event)
}

func (f *follow) setJob(j Job) {
	if f.jobs == nil {
		f.jobs = map[string]*Job{}
	}
	if _, ok := f.jobs[j.ID]; !ok {
		f.order = append(f.order, j.ID)
	}
	f.jobs[j.ID] = &j
}

// see takes one event in. It returns false for an event that changes nothing a wait looks at.
func (f *follow) see(ev KnowledgeBaseEvent) bool {
	switch e := ev.(type) {
	case *KnowledgeBaseSnapshot:
		f.snap = e
		f.jobs, f.order = nil, nil
		for _, j := range e.Jobs {
			f.setJob(j)
		}
	case *JobChanged:
		f.setJob(e.Job)
	case *DocumentChanged:
		if f.snap != nil && f.kind == "document" && e.Document.ID == f.id {
			d := e.Document
			f.snap.Document = &d
		}
	case *DocumentDeleted:
		if f.kind == "document" && e.DocumentID == f.id {
			f.ended = true
		}
	case *FolderChanged:
		if f.snap != nil && f.kind == "folder" && e.Folder.Path == f.id {
			fo := e.Folder
			f.snap.Folder = &fo
		}
	case *FolderDeleted:
		if f.kind == "folder" && e.Path == f.id {
			f.ended = true
		}
	case *KnowledgeBaseChanged:
		if f.snap != nil && f.kind == "" {
			kb := e.KnowledgeBase
			f.snap.KnowledgeBase = &kb
		}
	default:
		return false
	}
	return true
}

// progress is the processing a snapshot or a progress event gives the thing waited on (PROTOCOL.md 16, wait.progress):
// a document's from its watch, a batch's or folder's running job from theirs, and a job's own when the wait follows one.
func (f *follow) progress(ev KnowledgeBaseEvent) *Processing {
	switch e := ev.(type) {
	case *KnowledgeBaseSnapshot, *DocumentProgress:
	case *JobChanged:
		if e.EventType() != "job.progress" {
			return nil
		}
	default:
		return nil
	}
	switch {
	case f.kind == "document":
		return ev.ProcessingOf(f.id)
	case f.kind != "":
		return ev.GetProcessing()
	case f.job != "":
		return ev.ProcessingOf(f.job)
	}
	return nil
}

func running(s OperationStatus) bool {
	return s == OperationStatusQueued || s == OperationStatusRunning
}

// busy reports whether the thing itself says work is still under way, whether or not a job is listed on it: a
// knowledge base creating, moving or deleting, a document pending, processing or deleting, a batch planning or running
// (PROTOCOL.md 16, wait.busy-status).
func (f *follow) busy() bool {
	switch {
	case f.snap == nil:
		return true
	case f.kind == "" && f.snap.KnowledgeBase != nil:
		st := f.snap.KnowledgeBase.Status
		return st == KnowledgeBaseStatusCreating || st == KnowledgeBaseStatusMoving || (st == KnowledgeBaseStatusDeleting && !f.gone)
	case f.kind == "document" && f.snap.Document != nil:
		st := f.snap.Document.Status
		return st == DocumentStatusPending || st == DocumentStatusProcessing || st == DocumentStatusDeleting
	case f.kind == "batch" && f.snap.Batch != nil:
		st := f.snap.Batch.Status
		return st == IngestionBatchStatusPlanning || st == IngestionBatchStatusRunning
	}
	return false
}

// absent reports whether the snapshot no longer holds the thing.
func (f *follow) absent() bool {
	if f.ended {
		return true
	}
	if f.snap == nil {
		return false
	}
	switch f.kind {
	case "document":
		return f.snap.Document == nil
	case "folder":
		return f.snap.Folder == nil
	case "batch":
		return f.snap.Batch == nil
	}
	return f.snap.KnowledgeBase == nil
}

// settled says whether the wait is over: done, and the error that ends it (nil for success).
func (f *follow) settled() (bool, error) {
	if f.gone && f.absent() {
		return true, nil
	}
	if !f.gone && f.ended {
		return true, notFound("It was deleted while it was waited on")
	}
	if f.snap == nil {
		return false, nil
	}
	if f.job != "" {
		if j, ok := f.jobs[f.job]; ok {
			if running(j.Status) {
				return false, nil
			}
			if err := f.jobError(j); err != nil {
				return true, err
			}
			if f.gone {
				// The deletion finished: the thing is gone, whether or not this connection has seen it go.
				return true, nil
			}
		}
	}
	for _, id := range f.order {
		if running(f.jobs[id].Status) {
			return false, nil
		}
	}
	if f.gone || f.busy() {
		return false, nil
	}
	if f.kind == "batch" {
		if f.cancelling && f.snap.Batch != nil && f.snap.Batch.Status == IngestionBatchStatusCancelled {
			return true, nil
		}
		return true, batchError(f.snap.Batch)
	}
	if f.job == "" {
		// The last job to end on the thing decides how it stands: one that failed or was cancelled is the error that
		// stopped it.
		if last := f.lastEnded(); last != nil {
			return true, f.jobError(last)
		}
	}
	return true, nil
}

func (f *follow) lastEnded() *Job {
	var last *Job
	for _, id := range f.order {
		j := f.jobs[id]
		if running(j.Status) {
			continue
		}
		if last == nil || endedAt(j).After(endedAt(last)) || endedAt(j).Equal(endedAt(last)) {
			last = j
		}
	}
	return last
}

func endedAt(j *Job) time.Time {
	switch {
	case j.EndedAt != nil:
		return *j.EndedAt
	case j.UpdatedAt != nil:
		return *j.UpdatedAt
	}
	return j.CreatedAt
}

// jobError is jobError, less CANCELLED on a cancel's own wait.
func (f *follow) jobError(j *Job) error {
	if f.cancelling && j.Status == OperationStatusCancelled {
		return nil
	}
	return jobError(j)
}

// cancellingKey marks a cancel's own wait on its context.
type cancellingKey struct{}

// cancelling is ctx for a cancel's own wait: the generated …Started.Wait of a call the model marks
// @longRunning(cancels: true) (ScopeTree's LongRunning.cancels).
func cancelling(ctx context.Context) context.Context {
	return context.WithValue(ctx, cancellingKey{}, true)
}

func isCancelling(ctx context.Context) bool { v, _ := ctx.Value(cancellingKey{}).(bool); return v }

// jobError is a job's outcome as an error: nil when it succeeded (with or without failures), the typed error for its
// code when it failed, and CANCELLED when it was cancelled.
func jobError(j *Job) error {
	switch j.Status {
	case OperationStatusFailed:
		// A job that failed with no code of its own is JOB_FAILED, the generic error (PROTOCOL.md 6.3).
		code, detail := "JOB_FAILED", "The job failed."
		if j.Error != nil {
			if j.Error.Code != "" {
				code = j.Error.Code
			}
			if j.Error.Detail != nil {
				detail = *j.Error.Detail
			}
		}
		st := statusForCode(code)
		return errorForStatus(st, core.NewJobError(st, code, detail))
	case OperationStatusCancelled:
		return core.NewError("CANCELLED", "The job was cancelled before it finished", nil)
	}
	return nil
}

// batchError is a batch's own outcome as an error: its failure when it failed, and CANCELLED when it was cancelled.
func batchError(b *IngestionBatch) error {
	if b == nil {
		return nil
	}
	switch b.Status {
	case IngestionBatchStatusFailed:
		code, msg := "INGESTION_BATCH_FAILED", "Ingestion batch "+b.ID+" failed"
		if b.Failure != nil {
			code, msg = string(b.Failure.Code), b.Failure.Message
		}
		return core.NewError(code, msg, nil)
	case IngestionBatchStatusCancelled:
		return core.NewError("CANCELLED", "The ingestion batch was cancelled", nil)
	}
	return nil
}

func notFound(detail string) error {
	return errorForStatus(404, core.NewJobError(404, "NOT_FOUND", detail))
}

func isNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == 404
}

// watchUntil opens the watch and feeds f each event until done says the wait is over, reconnecting as the stream
// does (PROTOCOL.md 16). A 404, on opening or on a reconnect, ends a wait for the thing to go with success, and any
// other wait with the 404.
func watchUntil(parent context.Context, open watchFunc, opts []WaitOption, f *follow, done func() (bool, error)) (err error) {
	ctx, cancel := core.WaitContext(parent, opts)
	defer cancel()
	// The wait's own time limit passing is WAIT_TIMEOUT, which is also context.DeadlineExceeded; the caller's own
	// context ending is that context's error.
	defer func() {
		if err != nil && parent.Err() == nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = core.NewError("WAIT_TIMEOUT", "The wait's time limit passed before the work was done", context.DeadlineExceeded)
		}
	}()
	s, err := open(ctx)
	if err != nil {
		if f.gone && isNotFound(err) {
			return nil
		}
		return err
	}
	defer s.Close()
	progress := core.WaitSettingsOf(opts).Progress
	for ev, err := range s.Events() {
		if err != nil {
			if f.gone && isNotFound(err) {
				return nil
			}
			return err
		}
		if progress != nil {
			if p := f.progress(ev); p != nil {
				progress(*p)
			}
		}
		if !f.see(ev) {
			continue
		}
		if ok, err := done(); ok {
			return err
		}
	}
	// A watch ends only with an error or when closed; the context ending closes it.
	if err := ctx.Err(); err != nil {
		return err
	}
	return core.NewError("STREAM_LOST", "The watch ended before the wait was over", nil)
}

// waitWatchKnowledgeBase is wait() for a scope watched through WatchKnowledgeBase: it returns the latest snapshot once
// nothing runs on the thing, or nil once the thing is gone when gone is set (PROTOCOL.md 16).
func waitWatchKnowledgeBase(ctx context.Context, open watchFunc, kind, id, job string, gone bool, opts []WaitOption) (*KnowledgeBaseSnapshot, error) {
	f := &follow{kind: kind, id: id, job: job, gone: gone, cancelling: isCancelling(ctx)}
	if err := watchUntil(ctx, open, opts, f, f.settled); err != nil {
		return nil, err
	}
	if gone {
		return nil, nil
	}
	return f.snap, nil
}

// waited returns what a scope's get read once the wait was over. A batch that ended failed or cancelled is that
// batch's error, except a cancelled one on a cancel's own wait.
func waited[T any](ctx context.Context, v *T, err error) (*T, error) {
	if err != nil {
		return nil, err
	}
	if b, ok := any(v).(*IngestionBatch); ok {
		if isCancelling(ctx) && b.Status == IngestionBatchStatusCancelled {
			return v, nil
		}
		if err := batchError(&IngestionBatch{ID: b.ID, Status: b.Status, Failure: b.Failure}); err != nil {
			return nil, err
		}
	}
	return v, nil
}

// waitJob waits for one job on the knowledge base, through the knowledge base's watch, and returns it once it ends:
// a fill-in, a reprocess or layout-aware search, which have no thing of their own to wait on. A job that ended before
// the watch connected, and which the snapshot no longer lists, is read with Core.Operation(…).Get.
func (s *KnowledgeBaseScope) waitJob(ctx context.Context, job string, opts []WaitOption) (*Job, error) {
	f := &follow{job: job}
	var out *Job
	err := watchUntil(ctx, s.Watch, opts, f, func() (bool, error) {
		if f.snap == nil {
			return false, nil
		}
		j, ok := f.jobs[job]
		if !ok {
			op, err := s.c.Core.Operation(s.knowledgeBaseID, job).Get(ctx)
			if err != nil {
				return true, err
			}
			var jj Job
			if err := jj.UnmarshalJSON(op.RawJSON()); err != nil {
				return true, err
			}
			j = &jj
		}
		if running(j.Status) {
			return false, nil
		}
		out = j
		return true, jobError(j)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Planned waits until the batch is planned or past it (PROTOCOL.md 16), through its watch, and returns it as Get
// does. A batch that ended failed while it was planned is its own failure (its code, such as conflict_policy_fail or
// planning_failed); one that was cancelled is CANCELLED. WithTimeLimit bounds the wait; there is no default.
func (s *BatchScope) Planned(ctx context.Context, opts ...WaitOption) (*IngestionBatch, error) {
	f := &follow{kind: "batch", id: s.ingestionBatchID}
	err := watchUntil(ctx, s.Watch, opts, f, func() (bool, error) {
		if f.snap == nil || f.snap.Batch == nil {
			return false, nil
		}
		switch f.snap.Batch.Status {
		case IngestionBatchStatusDraft, IngestionBatchStatusPlanning:
			return false, nil
		case IngestionBatchStatusFailed, IngestionBatchStatusCancelled:
			return true, batchError(f.snap.Batch)
		}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return s.Get(ctx)
}
