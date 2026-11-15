package conformance

// Waiters (PROTOCOL.md 10.1): GetDocument's Indexed waiter against the mock's documentStatus fault, which gives
// each read of a document the next status in a list, the last one repeating. Short polling delays keep the
// cases quick. The cases join the protocol map, so TestProtocol runs them as TestProtocol/waiter.<case>.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

func documentStatuses(t *testing.T, m mock, id string, statuses ...string) {
	m.faults(t, map[string]any{"documentStatus": map[string]any{id: statuses}})
}

func waitIndexed(t *testing.T, m mock, ctx context.Context, id string, opts ...caitlyn.WaiterOption) (*caitlyn.GetDocumentResult, error) {
	t.Helper()
	opts = append([]caitlyn.WaiterOption{caitlyn.WithWaitDelays(10*time.Millisecond, 20*time.Millisecond)}, opts...)
	return client(t, m).Documents.WaitUntilIndexed(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: kb, DocumentID: id}, opts...)
}

func reads(t *testing.T, m mock, id string) int {
	return len(m.matching(t, pathHasSuffix("/documents/"+id)))
}

func waiterError(t *testing.T, err error) *caitlyn.WaiterError {
	t.Helper()
	var we *caitlyn.WaiterError
	if !errors.As(err, &we) {
		t.Fatalf("want *caitlyn.WaiterError, got %T: %v", err, err)
	}
	return we
}

// lastStatus is the status of the last document a waiter error carries.
func lastStatus(t *testing.T, we *caitlyn.WaiterError) caitlyn.DocumentStatus {
	t.Helper()
	doc, ok := we.Output.(*caitlyn.GetDocumentResult)
	if !ok || doc == nil {
		t.Fatalf("the waiter error carries %T, want the last *GetDocumentResult", we.Output)
	}
	return doc.Status
}

func init() {
	for id, run := range waiterCases {
		protocol[id] = run
	}
}

var waiterCases = map[string]func(t *testing.T, m mock){
	"waiter.success": func(t *testing.T, m mock) {
		documentStatuses(t, m, "doc-0002", "queued", "indexing", "indexed")
		doc, err := waitIndexed(t, m, context.Background(), "doc-0002")
		if err != nil || doc.Status != caitlyn.DocumentStatusIndexed || reads(t, m, "doc-0002") != 3 {
			t.Fatalf("doc %+v err %v after %d reads, want indexed after 3", doc, err, reads(t, m, "doc-0002"))
		}
		// partially_indexed is searchable too.
		documentStatuses(t, m, "doc-0003", "indexing", "partially_indexed")
		if doc, err := waitIndexed(t, m, context.Background(), "doc-0003"); err != nil || doc.Status != caitlyn.DocumentStatusPartiallyIndexed {
			t.Fatalf("doc %+v err %v, want partially_indexed", doc, err)
		}
	},
	"waiter.failure": func(t *testing.T, m mock) {
		// A failure acceptor: the document failed. The error carries the failed document.
		documentStatuses(t, m, "doc-0002", "indexing", "failed")
		_, err := waitIndexed(t, m, context.Background(), "doc-0002")
		we := waiterError(t, err)
		if we.Waiter != "Indexed" || we.State != "failure" || we.Attempts != 2 || we.Err != nil || lastStatus(t, we) != caitlyn.DocumentStatusFailed {
			t.Fatalf("got %+v, want a failure after 2 reads carrying the failed document", we)
		}
		// An error: a document that does not exist. The error carries the 404.
		_, err = waitIndexed(t, m, context.Background(), "doc-9999")
		we = waiterError(t, err)
		var nf *caitlyn.NotFoundError
		if we.State != "failure" || we.Attempts != 1 || we.Output != nil || !errors.As(err, &nf) {
			t.Fatalf("got %+v, want a failure after 1 read caused by NotFoundError", we)
		}
	},
	"waiter.timeout": func(t *testing.T, m mock) {
		documentStatuses(t, m, "doc-0002", "queued")
		t0 := time.Now()
		_, err := waitIndexed(t, m, context.Background(), "doc-0002", caitlyn.WithMaxWait(150*time.Millisecond))
		we := waiterError(t, err)
		if we.State != "timeout" || we.Attempts < 2 || we.Limit != 150*time.Millisecond || time.Since(t0) > 2*time.Second || lastStatus(t, we) != "queued" {
			t.Fatalf("got %+v after %v, want a timeout near 150 ms carrying the queued document", we, time.Since(t0))
		}
	},
	"waiter.success-on-error": func(t *testing.T, m mock) {
		// Deleted succeeds on a 404, so WaitUntilDeleted has no output: it returns only an error, nil once the
		// document is gone. The mock reads a deleted document as deleting once (deletingReads), then 404s.
		c := client(t, m)
		ctx := context.Background()
		in := &caitlyn.GetDocumentInput{KnowledgeBaseID: kb, DocumentID: "doc-0002"}
		deleted, err := c.Documents.Delete(ctx, &caitlyn.DeleteDocumentInput{KnowledgeBaseID: kb, DocumentID: "doc-0002"})
		if err != nil || deleted.Status != caitlyn.DocumentStatusDeleting {
			t.Fatalf("delete: %+v %v, want deleting", deleted, err)
		}
		before := reads(t, m, "doc-0002")
		if err := c.Documents.WaitUntilDeleted(ctx, in, caitlyn.WithWaitDelays(10*time.Millisecond, 20*time.Millisecond)); err != nil {
			t.Fatalf("WaitUntilDeleted: %v, want nil once the document is gone", err)
		}
		if n := reads(t, m, "doc-0002") - before; n != 2 {
			t.Fatalf("%d reads, want 2: deleting, then 404", n)
		}
		// Its default limit is its waitLimits entry, 15 minutes: an error no acceptor matches (a 403) fails the
		// wait at once, and the error reports the limit it ran under.
		m.faults(t, status("GetDocument", fault(403, 0)))
		err = c.Documents.WaitUntilDeleted(ctx, &caitlyn.GetDocumentInput{KnowledgeBaseID: kb, DocumentID: "doc-0003"},
			caitlyn.WithWaitDelays(10*time.Millisecond, 20*time.Millisecond))
		if we := waiterError(t, err); we.State != "failure" || we.Limit != 15*time.Minute {
			t.Fatalf("got %+v, want a failure under Deleted's 15 minutes", we)
		}
	},
	"waiter.default-limit": func(t *testing.T, m mock) {
		// Indexed's waitLimits entry is 3600 seconds, so a wait with no WithMaxWait runs under 60 minutes; a
		// failed document ends it at once, and the error reports the limit it ran under.
		documentStatuses(t, m, "doc-0002", "failed")
		_, err := waitIndexed(t, m, context.Background(), "doc-0002")
		if we := waiterError(t, err); we.Limit != time.Hour {
			t.Fatalf("limit %v, want Indexed's 60 minutes", we.Limit)
		}
		// Without an entry a waiter gets 5 minutes. No operation in the model has such a waiter, so the runtime's
		// fallback is checked directly (go/core/waiter_test.go covers it in use).
		if caitlyn.DefaultMaxWait != 5*time.Minute {
			t.Fatalf("DefaultMaxWait %v, want 5 minutes", caitlyn.DefaultMaxWait)
		}
	},
}

// TestGoWaitContextDeadline: a context's deadline ends a wait with the context's error, not a *WaiterError
// (PROTOCOL.md 10.1: cancellation is the language's own).
func TestGoWaitContextDeadline(t *testing.T) {
	m := fresh(t)
	documentStatuses(t, m, "doc-0002", "queued")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := waitIndexed(t, m, ctx, "doc-0002")
	var we *caitlyn.WaiterError
	if !errors.Is(err, context.DeadlineExceeded) || errors.As(err, &we) {
		t.Fatalf("got %T %v, want context.DeadlineExceeded", err, err)
	}
}
