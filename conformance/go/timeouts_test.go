package conformance

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/caitlyn-ai/sdk/go"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// 0.10.1: the request timeout and the storage stall timer, a policy with no readable expiresAt, sync's estimate only
// with Confirm, If-Match: * only when asked for, and each item's span.

// held is n hold faults for an operation: requests the mock never answers.
func held(op string, n int) map[string]any {
	list := make([]any, n)
	for i := range list {
		list[i] = map[string]any{"hold": true}
	}
	return map[string]any{"status": map[string]any{op: list}}
}

// mockEvents is the mock's own log entries of this kind (request-aborted, request-held) for this operation.
func mockEvents(t *testing.T, m mock, event, op string) int {
	return len(m.matching(t, func(r logged) bool { return r.Event == event && (op == "" || r.Op == op) }))
}

func policiesAsked(t *testing.T, m mock) int {
	return len(m.matching(t, func(r logged) bool { return r.Method == "POST" && pathHasSuffix("/upload-policies")(r) }))
}

func init() {
	protocol["client.request-timeout"] = func(t *testing.T, m mock) {
		c := client(t, m, caitlyn.WithRequestTimeout(300*time.Millisecond))
		m.faults(t, held("GetKnowledgeBase", 3))
		started := time.Now()
		_, err := c.KnowledgeBase(kb).Get(context.Background())
		var ce *caitlyn.ConnectionError
		if !errors.As(err, &ce) || ce.Code != "CONNECTION_ERROR" || ce.Status != 0 {
			t.Fatalf("got %T %v; want a *ConnectionError", err, err)
		}
		if msg := err.Error(); !strings.Contains(msg, "GetKnowledgeBase") || !strings.Contains(msg, "300 ms") {
			t.Fatalf("message %q names neither the operation nor the timeout", msg)
		}
		if n := len(m.matching(t, func(r logged) bool { return r.Path == kbPath })); n != 3 {
			t.Fatalf("%d attempts; want 3, retried as a read is", n)
		}
		if time.Since(started) > 10*time.Second {
			t.Fatal("took too long")
		}
		time.Sleep(200 * time.Millisecond)
		if n := mockEvents(t, m, "request-aborted", "GetKnowledgeBase"); n != 3 {
			t.Fatalf("%d attempts closed; want each of the 3", n)
		}
		// A watch whose stream has only keep-alives for longer than the timeout is not cut.
		m = fresh(t)
		m.faults(t, map[string]any{"watchKeepAliveMs": 100})
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		w, err := c.KnowledgeBase(kb).Watch(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		go func() {
			time.Sleep(1200 * time.Millisecond)
			current, err := c.KnowledgeBase(kb).Get(context.Background())
			if err == nil {
				_, _ = c.KnowledgeBase(kb).Update(context.Background(), &caitlyn.UpdateKnowledgeBaseInput{Description: caitlyn.Ptr("Still watching")}, caitlyn.WithIfMatch(current.ETag))
			}
		}()
		var seen []string
		for ev, err := range w.Events() {
			if err != nil {
				t.Fatalf("the watch failed after %v: %v", seen, err)
			}
			seen = append(seen, ev.EventType())
			if ev.EventType() == "knowledge_base.updated" {
				break
			}
		}
		if strings.Join(seen, ",") != "snapshot,knowledge_base.updated" {
			t.Fatalf("events %v", seen)
		}
		if n := len(m.matching(t, func(r logged) bool { return r.Path == kbPath+"/events" })); n != 1 {
			t.Fatalf("%d watch connections; want one, never cut", n)
		}
	}

	protocol["files.storage-stall"] = func(t *testing.T, m mock) {
		c := client(t, m, caitlyn.WithStorageStallTimeout(300*time.Millisecond))
		items, files := newFiles(1)
		b := startedBatch(t, c, items)
		m.faults(t, held("PostObject", 3))
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(up.Result.Items) != 1 || up.Result.Items[0].Status != caitlyn.IngestionItemStatusFailed || deref(up.Result.Items[0].FailureCode) != "UPLOAD_FAILED" {
			t.Fatalf("items %+v; want the one failed UPLOAD_FAILED", up.Result.Items)
		}
		if d := deref(up.Result.Items[0].FailureDetail); !strings.Contains(d, "storage sent nothing for 300 ms") {
			t.Fatalf("detail %q", d)
		}
		if n := len(m.matching(t, isForm)); n != 3 {
			t.Fatalf("%d form POSTs; want 3, retried as a send with no response is", n)
		}
		time.Sleep(200 * time.Millisecond)
		if n := mockEvents(t, m, "request-aborted", "PostObject"); n != 3 {
			t.Fatalf("%d stalled attempts closed; want 3", n)
		}
	}

	protocol["files.slow-not-stalled"] = func(t *testing.T, m mock) {
		c := client(t, m, caitlyn.WithStorageStallTimeout(2500*time.Millisecond))
		big := make([]byte, 32<<20)
		for i := range big {
			big[i] = byte(i % 251)
		}
		p := "/hand/large.pdf"
		b := startedBatch(t, c, []caitlyn.IngestionItemInput{described(p, big)})
		m.faults(t, map[string]any{"uploadReadBytesPerSecond": 8 << 20})
		started := time.Now()
		up, err := b.Upload(within(t), caitlyn.FilesByPath(map[string]caitlyn.File{p: caitlyn.FileFromBytes("large.pdf", big)}), nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(up.Result.Items) != 1 || up.Result.Items[0].Status != caitlyn.IngestionItemStatusIngesting {
			t.Fatalf("items %+v; want it accepted", up.Result.Items)
		}
		if took := time.Since(started); took < 2500*time.Millisecond {
			t.Fatalf("took %v: not longer than the stall timeout in all", took)
		}
		if n := len(m.matching(t, isForm)); n != 1 {
			t.Fatalf("%d form POSTs; want one attempt", n)
		}
	}

	protocol["batch-upload.unreadable-expiry"] = func(t *testing.T, m mock) {
		// Start's policy is short, so the first upload renews it; every renewal then has no expiresAt.
		m.faults(t, map[string]any{"policySeconds": 1, "policyExpiresAt": nil})
		c := client(t, m)
		items, files := newFiles(3)
		b := startedBatch(t, c, items)
		before := policiesAsked(t, m)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{Concurrency: 1})
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range up.Result.Items {
			if it.Status != caitlyn.IngestionItemStatusIngesting {
				t.Fatalf("items %+v", up.Result.Items)
			}
		}
		if n := policiesAsked(t, m) - before; n < 3 {
			t.Fatalf("%d policies asked for; want one before each of 3 uploads", n)
		}
		after := policiesAsked(t, m)
		time.Sleep(1500 * time.Millisecond)
		if n := policiesAsked(t, m); n != after {
			t.Fatalf("%d renewals after the call returned", n-after)
		}
		// An expiresAt that is not a time fails the call that returned it, clearly: never a silent loss of renewal.
		m = fresh(t)
		m.faults(t, map[string]any{"policySeconds": 1, "policyExpiresAt": "not a date"})
		b = startedBatch(t, client(t, m), items)
		_, err = b.Upload(within(t), caitlyn.FilesByPath(files), &caitlyn.BatchUploadOptions{Concurrency: 1})
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "DECODE_FAILED" {
			t.Fatalf("got %v; want DECODE_FAILED", err)
		}
	}

	protocol["sync.no-confirm-no-estimate"] = func(t *testing.T, m mock) {
		m.faults(t, status("EstimateIngestion", fault(503, 0), fault(503, 0), fault(503, 0)))
		dir, _ := policies(t, 2)
		rep, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		if rep.Batch.Status != caitlyn.IngestionBatchStatusSucceeded {
			t.Fatalf("batch %s", rep.Batch.Status)
		}
		if n := len(m.matching(t, pathHasSuffix("/ingestions:estimate"))); n != 0 {
			t.Fatalf("%d EstimateIngestion calls; want none", n)
		}
	}

	protocol["sync.confirm-estimate-unavailable"] = func(t *testing.T, m mock) {
		m.faults(t, status("EstimateIngestion", fault(400, 0)))
		dir, _ := policies(t, 2)
		var plan *caitlyn.SyncPlan
		rep, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/",
			Confirm: func(_ context.Context, p *caitlyn.SyncPlan) (bool, error) { plan = p; return true, nil }})
		if err != nil {
			t.Fatal(err)
		}
		if rep.Batch.Status != caitlyn.IngestionBatchStatusSucceeded {
			t.Fatalf("batch %s", rep.Batch.Status)
		}
		var e *caitlyn.Error
		if plan == nil || plan.Estimate != nil || !errors.As(plan.EstimateErr, &e) || e.Status != 400 || len(plan.Items) != 2 {
			t.Fatalf("plan %+v; want no estimate and the 400 as EstimateErr", plan)
		}
		m = fresh(t)
		m.faults(t, status("EstimateIngestion", fault(400, 0)))
		_, err = client(t, m).KnowledgeBase(kb).Ingestion.EstimateSync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		if !errors.As(err, &e) || e.Status != 400 {
			t.Fatalf("EstimateSync got %v; want the 400", err)
		}
	}

	protocol["if-match.never-wildcard"] = func(t *testing.T, m mock) {
		c := client(t, m)
		_, err := c.KnowledgeBase(kb).Update(context.Background(), &caitlyn.UpdateKnowledgeBaseInput{Description: caitlyn.Ptr("Any version")}, caitlyn.WithIfMatch("*"))
		var e *caitlyn.Error
		if !errors.As(err, &e) || e.Code != "IF_MATCH_WILDCARD_NOT_ASKED" {
			t.Fatalf("got %v; the mock refuses an unasked *", err)
		}
		m.faults(t, map[string]any{"allowIfMatchWildcard": true})
		got, err := c.KnowledgeBase(kb).Update(context.Background(), &caitlyn.UpdateKnowledgeBaseInput{Description: caitlyn.Ptr("Any version")}, caitlyn.WithIfMatch("*"))
		if err != nil || deref(got.Description) != "Any version" {
			t.Fatalf("got %+v, %v", got, err)
		}
		patches := m.matching(t, func(r logged) bool { return r.Method == "PATCH" && r.Path == kbPath })
		if patches[len(patches)-1].Headers["if-match"] != "*" {
			t.Fatalf("sent If-Match %q", patches[len(patches)-1].Headers["if-match"])
		}
		// A sync, which sends If-Match on Start, sends the plan's own ETag.
		m = fresh(t)
		dir, _ := policies(t, 1)
		rep, err := client(t, m).KnowledgeBase(kb).Ingestion.Sync(context.Background(), caitlyn.Dir(dir), &caitlyn.SyncOptions{Folder: "/hr/"})
		if err != nil || rep.Batch.Status != caitlyn.IngestionBatchStatusSucceeded {
			t.Fatalf("sync %v", err)
		}
		start := m.matching(t, pathHasSuffix("/start"))
		if len(start) != 1 || start[0].Headers["if-match"] == "" || start[0].Headers["if-match"] == "*" {
			t.Fatalf("Start sent If-Match %q", start[0].Headers["if-match"])
		}
	}

	protocol["batch-upload.policy-sets-key"] = func(t *testing.T, m mock) {
		// The mock's policy has its own `key`, as createPresignedPost makes it, and refuses a form that repeats a field.
		c := client(t, m)
		items, files := newFiles(2)
		b := startedBatch(t, c, items)
		up, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range up.Result.Items {
			if it.Status != caitlyn.IngestionItemStatusIngesting {
				t.Fatalf("items %+v", up.Result.Items)
			}
		}
		objectKeys := map[string]bool{}
		for it, err := range b.Items.List(within(t), nil) {
			if err != nil {
				t.Fatal(err)
			}
			objectKeys[deref(it.ObjectKey)] = true
		}
		sent := m.matching(t, isForm)
		if len(sent) != 2 {
			t.Fatalf("%d forms for 2 files", len(sent))
		}
		for _, f := range sent {
			var keys []string
			for _, p := range f.Form {
				if strings.EqualFold(p.Name, "key") {
					keys = append(keys, p.Value)
				}
			}
			if len(keys) != 1 || !objectKeys[keys[0]] {
				t.Fatalf("key fields %q; want one, the item's objectKey", keys)
			}
		}
		if refused := m.matching(t, func(r logged) bool { return r.Event == "storage-refused-repeated-field" }); len(refused) != 0 {
			t.Fatalf("storage refused %+v", refused)
		}
	}

	protocol["errors.409-retry-after"] = func(t *testing.T, m mock) {
		c := client(t, m)
		items, _ := newFiles(1) // /hr/policy-001.pdf, a new document: the started batch reserves its path
		startedBatch(t, c, items)
		ctx := within(t)
		check409 := func(what string, err error) {
			t.Helper()
			var conflict *caitlyn.ConflictError
			if !errors.As(err, &conflict) || conflict.Code != string(caitlyn.ErrorCodeTargetInUse) || conflict.RetryAfterSeconds == nil || *conflict.RetryAfterSeconds != 30 {
				t.Fatalf("%s: %v; want a ConflictError TARGET_IN_USE with RetryAfterSeconds 30", what, err)
			}
		}
		_, err := c.KnowledgeBase(kb).Documents.Create(ctx, caitlyn.FileFromBytes("policy-001.pdf", pdf("another")), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
		check409("CreateDocument", err)
		if n := len(m.matching(t, func(r logged) bool { return r.Method == "POST" && r.Path == "/v3/knowledge-bases/"+kb+"/documents" })); n != 1 {
			t.Fatalf("CreateDocument sent %d times; a 409 is not retried", n)
		}
		other, err := c.KnowledgeBase(kb).Documents.Create(ctx, caitlyn.FileFromBytes("other.pdf", pdf("other")), &caitlyn.CreateDocumentInput{Folder: "/hr/"})
		if err != nil {
			t.Fatal(err)
		}
		current, err := c.KnowledgeBase(kb).Document(other.Result.Document.ID).Get(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, err = c.KnowledgeBase(kb).Document(current.ID).Update(ctx, &caitlyn.UpdateDocumentInput{Name: caitlyn.Ptr("policy-001.pdf")}, caitlyn.WithIfMatch(current.ETag))
		check409("rename", err)
	}

	protocol["telemetry.batch-item"] = func(t *testing.T, m mock) {
		exporter := tracetest.NewInMemoryExporter()
		c := client(t, m, caitlyn.WithTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))))
		items, files := newFiles(2)
		broken := pdf("broken")
		items = append(items, described("/hr/broken.pdf", broken))
		files["/hr/broken.pdf"] = caitlyn.FileFromBytes("broken.pdf", broken)
		b := startedBatch(t, c, items)
		m.faults(t, map[string]any{"failUploads": map[string]any{"/hr/broken.pdf": true}})
		if _, err := b.Upload(within(t), caitlyn.FilesByPath(files), nil); err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, s := range exporter.GetSpans() {
			if s.Name != "caitlyn.batch.item" {
				continue
			}
			n++
			attrs := map[string]string{}
			for _, a := range s.Attributes {
				attrs[string(a.Key)] = a.Value.Emit()
			}
			if attrs["caitlyn.ingestion_batch.id"] != b.ID() || attrs["caitlyn.ingestion_batch.item.id"] == "" {
				t.Fatalf("attributes %v", attrs)
			}
			var events []string
			for _, e := range s.Events {
				events = append(events, e.Name)
			}
			got := strings.Join(events, ",")
			if attrs["caitlyn.ingestion_batch.item.path"] == "/hr/broken.pdf" {
				if !strings.HasPrefix(got, "opened,checked,sending") || events[len(events)-1] != "failed" || s.Status.Code != codes.Error {
					t.Fatalf("broken.pdf: events %s, status %v", got, s.Status)
				}
				last := s.Events[len(s.Events)-1]
				if len(last.Attributes) == 0 || last.Attributes[0].Value.Emit() != "UPLOAD_FAILED" {
					t.Fatalf("failed event %+v", last.Attributes)
				}
			} else if got != "opened,checked,sending,sent,completed" {
				t.Fatalf("%s: events %s", attrs["caitlyn.ingestion_batch.item.path"], got)
			}
		}
		if n != 3 {
			t.Fatalf("%d caitlyn.batch.item spans; want 3", n)
		}
	}
}
