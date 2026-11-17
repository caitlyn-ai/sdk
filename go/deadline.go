// This file is hand-written, not generated: a batch's watch reads the batch again once its deadline has passed
// (PROTOCOL.md 16). The generated BatchScope.Watch calls rereadAtDeadline. scripts/generate.sh keeps every file in go/
// that is not marked as generated.

package caitlyn

import (
	"context"
	"time"

	"github.com/caitlyn-ai/sdk/go/core"
)

// deadlineGrace is how long after a batch's deadline its watch reads it, if it is still open. Fixed: not an option.
const deadlineGrace = 30 * time.Second

// batchDeadline is a batch's deadline: its UploadsExpireAt, while it is open. None once the batch has ended.
func batchDeadline(b *IngestionBatch) (time.Time, bool) {
	if b == nil || b.UploadsExpireAt == nil {
		return time.Time{}, false
	}
	switch b.Status {
	case IngestionBatchStatusSucceeded, IngestionBatchStatusCompletedWithFailures, IngestionBatchStatusFailed,
		IngestionBatchStatusCancelled:
		return time.Time{}, false
	}
	return *b.UploadsExpireAt, true
}

// deadlineReread is a batch watch's core.Interjector. The server ends a batch whose deadline has passed only when the
// batch is next read, so its watch can stay silent. Each time the batch is seen (a snapshot, or a read), the read is due
// at its deadline plus deadlineGrace; if nothing has shown the batch again by then, it reads the batch with
// GetIngestionBatch and yields the read as a snapshot holding the batch, with no jobs and no progress. A snapshot that
// arrives already past its due time has its batch read at once, and is yielded with the read's batch in its place. A
// deadline is read once: a read that returns the same deadline schedules nothing more.
type deadlineReread struct {
	get      func(ctx context.Context, opts ...CallOption) (*IngestionBatch, error)
	read     map[int64]bool // deadlines already read, as Unix nanoseconds
	deadline time.Time
	has      bool
	due      time.Time
	pending  bool
}

// rereadAtDeadline gives a batch's watch its deadline re-read. cancel ends the context the watch was opened with.
func rereadAtDeadline(s *KnowledgeBaseEventStream, cancel context.CancelFunc, get func(ctx context.Context, opts ...CallOption) (*IngestionBatch, error)) *KnowledgeBaseEventStream {
	return s.Interject(&deadlineReread{get: get, read: map[int64]bool{}}, cancel)
}

func (d *deadlineReread) see(b *IngestionBatch) {
	d.deadline, d.has = batchDeadline(b)
	d.pending = d.has && !d.read[d.deadline.UnixNano()]
	if d.pending {
		d.due = d.deadline.Add(deadlineGrace)
	}
}

// reread reads the batch, as the deadline's one read.
func (d *deadlineReread) reread(ctx context.Context) (*IngestionBatch, error) {
	if d.has {
		d.read[d.deadline.UnixNano()] = true
	}
	d.pending = false
	b, err := d.get(ctx)
	if err != nil {
		return nil, err
	}
	d.see(b)
	return b, nil
}

func (d *deadlineReread) See(ctx context.Context, ev KnowledgeBaseEvent) (KnowledgeBaseEvent, error) {
	snap, ok := ev.(*KnowledgeBaseSnapshot)
	if !ok || snap.Batch == nil {
		return ev, nil
	}
	d.see(snap.Batch)
	if !d.pending || time.Now().Before(d.due) {
		return ev, nil
	}
	b, err := d.reread(ctx)
	if err != nil {
		return nil, err
	}
	read := *snap
	read.Batch = b
	read.raw = core.Raw{} // its JSON was the server's, which showed the batch as it no longer stands
	return &read, nil
}

func (d *deadlineReread) Due() (time.Time, bool) { return d.due, d.pending }

func (d *deadlineReread) Fire(ctx context.Context) (KnowledgeBaseEvent, error) {
	b, err := d.reread(ctx)
	if err != nil {
		return nil, err
	}
	return &KnowledgeBaseSnapshot{Batch: b, Jobs: []Job{}, Progress: []DocumentProgress{}}, nil
}
