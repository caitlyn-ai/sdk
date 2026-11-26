package conformance

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
)

// A batch past its deadline is read again by its watch and its wait (PROTOCOL.md 16, wait.deadline-reread).

// batchReads is the GetIngestionBatch requests the mock has logged.
func batchReads(t *testing.T, m mock) int {
	t.Helper()
	read := regexp.MustCompile(`/ingestion-batches/[^/]+$`)
	return len(m.matching(t, func(r logged) bool { return r.Method == "GET" && read.MatchString(r.Path) }))
}

func init() {
	protocol["wait.deadline-reread"] = func(t *testing.T, m mock) {
		// The mock's deadlinePassed: only GetIngestionBatch ends a batch past its deadline, and its watch never shows
		// the end. 'uploads': started, nothing uploaded, uploadsExpireAt a minute gone.
		m.faults(t, map[string]any{"deadlinePassed": "uploads"})
		c := client(t, m)
		data := pdf("/hr/annual-leave.pdf")
		b := startedBatch(t, c, []caitlyn.IngestionItemInput{described("/hr/annual-leave.pdf", data)})
		done, err := b.Wait(within(t))
		if err != nil || done.Status != caitlyn.IngestionBatchStatusCompletedWithFailures {
			t.Fatalf("wait: %v, %+v; want completed_with_failures", err, done)
		}
		it := itemsByPath(t, b)["/hr/annual-leave.pdf"]
		if it.Status != caitlyn.IngestionItemStatusFailed || it.FailureCode == nil || *it.FailureCode != "UPLOAD_EXPIRED" {
			t.Fatalf("item: %+v; want failed UPLOAD_EXPIRED", it)
		}

		// Watch yields the read as a snapshot: a fresh batch, so that only the SDK's read can show it ended.
		m = fresh(t)
		m.faults(t, map[string]any{"deadlinePassed": "uploads"})
		c = client(t, m)
		w := startedBatch(t, c, []caitlyn.IngestionItemInput{described("/hr/annual-leave.pdf", data)})
		before := batchReads(t, m)
		s, err := w.Watch(within(t))
		if err != nil {
			t.Fatal(err)
		}
		var ended *caitlyn.IngestionBatch
		for ev, err := range s.Events() {
			if err != nil {
				t.Fatal(err)
			}
			if snap, ok := ev.(*caitlyn.KnowledgeBaseSnapshot); ok && snap.Batch != nil && snap.Batch.Status == caitlyn.IngestionBatchStatusCompletedWithFailures {
				ended = snap.Batch
				break
			}
		}
		s.Close()
		if ended == nil || ended.ID != w.ID() {
			t.Fatalf("watch: no snapshot of the batch ended, got %+v", ended)
		}
		if batchReads(t, m) <= before {
			t.Fatal("watch: no GetIngestionBatch was sent")
		}

		readOncePerDeadline(t)
	}
}

// readOncePerDeadline: a batch due to be read in 100 ms, whose read returns the same deadline, is read once.
func readOncePerDeadline(t *testing.T) {
	deadline := time.Now().Add(-30*time.Second + 100*time.Millisecond).UTC().Format(time.RFC3339Nano)
	batch := fmt.Sprintf(`{"id":"b-1","knowledgeBaseId":%q,"status":"running","uploadsExpireAt":%q}`, kb, deadline)
	var reads atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/events"):
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "id: s1\nevent: snapshot\ndata: {\"batch\":%s,\"jobs\":[],\"progress\":[]}\n\n", batch)
			w.(http.Flusher).Flush()
			<-r.Context().Done() // held open, and silent
		case strings.HasSuffix(r.URL.Path, "/ingestion-batches/b-1"):
			reads.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(batch))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c, err := caitlyn.NewClient("your-company.caitlyn.ai", caitlyn.Token("pat_test"), caitlyn.WithEndpoint(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	s, err := c.KnowledgeBase(kb).Ingestion.Batch("b-1").Watch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	snapshots := 0
	for ev, err := range s.Events() {
		if err != nil {
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			break
		}
		if snap, ok := ev.(*caitlyn.KnowledgeBaseSnapshot); ok && snap.Batch != nil {
			snapshots++
		}
	}
	if reads.Load() != 1 || snapshots != 2 {
		t.Fatalf("one deadline: %d reads and %d snapshots; want 1 read, yielded as the second snapshot", reads.Load(), snapshots)
	}
}
